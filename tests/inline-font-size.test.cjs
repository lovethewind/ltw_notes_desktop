/**
 * 行内字号纯逻辑（`src/utils/inline-font-size.ts`）的行为约束。
 *
 * ## 为什么是「真实行为断言」
 *
 * 这些是纯函数（span 配对、字号解析、空白判定），边界用源码正则根本测不出来。
 * 按项目既有约定（见 `tests/markdown-preview-render.test.cjs`），纯逻辑一律加载真实模块断言。
 *
 * ⚠️ 被测模块**刻意不 import 任何本地模块** —— Node 的类型剥离不解析省略扩展名的相对导入
 * （实测 `ERR_MODULE_NOT_FOUND`），一旦引入本地依赖，本文件会在 import 阶段就崩。
 *
 * ## 核心约束（别改坏）
 *
 * 1. **识别正则只认「纯 font-size」span**。放宽会把用户手写的 `color:red` 在保存时抹掉。
 * 2. **栈空时遇到 `</span>` 必须原样保留**。吞掉它 = 数据损坏。
 * 3. 转换必须是**纯函数**（不改入参）。
 */

const test = require('node:test')
const assert = require('node:assert/strict')
const { resolve } = require('node:path')
const { pathToFileURL } = require('node:url')

const projectRoot = resolve(__dirname, '..')

let fontModule

test.before(async () => {
  fontModule = await import(
    pathToFileURL(resolve(projectRoot, 'src/utils/inline-font-size.ts')).href
  )
})

test('档位：默认 15px、取值对齐钉钉、单调递增', () => {
  const { FONT_SCALE_STEPS, DEFAULT_FONT_SCALE_INDEX, DEFAULT_BODY_FONT_SIZE } = fontModule

  assert.equal(DEFAULT_BODY_FONT_SIZE, 15, '默认正文应为 15px')
  assert.equal(FONT_SCALE_STEPS[DEFAULT_FONT_SCALE_INDEX], 15, '默认档位下标应指向 15px')
  assert.deepEqual(
    [...FONT_SCALE_STEPS],
    [9, 10, 11, 12, 14, 15, 16, 18, 20, 22, 24, 26, 28, 36, 42, 48, 72],
    '档位应取钉钉列表并保留 15px 默认档，尾部放大字号阶梯'
  )
  assert.deepEqual(
    [...FONT_SCALE_STEPS].sort((a, b) => a - b),
    [...FONT_SCALE_STEPS],
    '档位必须单调递增，否则下拉顺序会乱'
  )
})

test('解析：识别纯字号 span，兼容空白与引号写法', () => {
  const { parseFontSizeOpenTag } = fontModule

  assert.equal(parseFontSizeOpenTag('<span style="font-size:18px">'), 18)
  assert.equal(parseFontSizeOpenTag('<span style="font-size: 18px;">'), 18)
  assert.equal(parseFontSizeOpenTag("<span style='font-size:9px'>"), 9)
  assert.equal(parseFontSizeOpenTag('<span style = " font-size: 22px ; ">'), 22)
  // 前后空白不影响（mdast 的 value 可能带缩进）。
  assert.equal(parseFontSizeOpenTag('  <span style="font-size:14px">  '), 14)
})

test('解析：⚠️ 只认「纯 font-size」，不得吞掉用户手写的其它样式', () => {
  const { parseFontSizeOpenTag } = fontModule

  // 本功能序列化时只会写回 font-size 一条声明。若把这些也转成字号 mark，
  // 用户手写的 color / class 会在保存时被静默抹掉 —— 那是数据损失，必须放过。
  assert.equal(parseFontSizeOpenTag('<span style="font-size:18px;color:red">'), null)
  assert.equal(parseFontSizeOpenTag('<span style="color:red;font-size:18px">'), null)
  assert.equal(parseFontSizeOpenTag('<span class="hl" style="font-size:18px">'), null)
  assert.equal(parseFontSizeOpenTag('<span data-x="1" style="font-size:18px">'), null)

  // 非 px 单位、非 span、纯粹不是标签的，一律不认。
  assert.equal(parseFontSizeOpenTag('<span style="font-size:1.2em">'), null)
  assert.equal(parseFontSizeOpenTag('<span style="font-size:120%">'), null)
  assert.equal(parseFontSizeOpenTag('<div style="font-size:18px">'), null)
  assert.equal(parseFontSizeOpenTag('<span style="font-weight:bold">'), null)
  assert.equal(parseFontSizeOpenTag('<br>'), null)
  assert.equal(parseFontSizeOpenTag(''), null)

  // 非正整数不认（0px 没有意义，会渲染成不可见）。
  assert.equal(parseFontSizeOpenTag('<span style="font-size:0px">'), null)
})

test('解析：识别 span 闭标签', () => {
  const { isSpanCloseTag } = fontModule

  assert.equal(isSpanCloseTag('</span>'), true)
  assert.equal(isSpanCloseTag('</span >'), true)
  assert.equal(isSpanCloseTag('  </span>  '), true)
  assert.equal(isSpanCloseTag('</SPAN>'), true)

  assert.equal(isSpanCloseTag('<span style="font-size:18px">'), false)
  assert.equal(isSpanCloseTag('</div>'), false)
  assert.equal(isSpanCloseTag('<br>'), false)
})

test('默认值判定：等于 15px 时应当移除标记而非写冗余 span', () => {
  const { isDefaultFontSize, DEFAULT_BODY_FONT_SIZE } = fontModule

  assert.equal(isDefaultFontSize(DEFAULT_BODY_FONT_SIZE), true)
  assert.equal(isDefaultFontSize(15), true)
  assert.equal(isDefaultFontSize(14), false)
  assert.equal(isDefaultFontSize(16), false)
})

test('空白判定：纯空白选区按「无选区」处理', () => {
  const { isBlankText } = fontModule

  // ProseMirror 里选中一个空格时 selection.empty===false，但给空白加字号毫无意义，
  // 会在源码里留下 <span style="font-size:18px"> </span> 这种垃圾。
  assert.equal(isBlankText(''), true)
  assert.equal(isBlankText(' '), true)
  assert.equal(isBlankText('  \n\t '), true)
  assert.equal(isBlankText('　'), true, '全角空格也算空白')

  assert.equal(isBlankText('a'), false)
  assert.equal(isBlankText(' a '), false)
})

test('转换：单个 span 被配对成嵌套容器，闭标签被吸收', () => {
  const { nestFontSizeSpans, FONT_SIZE_MDAST_TYPE } = fontModule

  const out = nestFontSizeSpans([
    { type: 'text', value: '普通 ' },
    { type: 'html', value: '<span style="font-size:18px">' },
    { type: 'text', value: '放大' },
    { type: 'html', value: '</span>' },
    { type: 'text', value: ' 普通' }
  ])

  assert.deepEqual(out, [
    { type: 'text', value: '普通 ' },
    { type: FONT_SIZE_MDAST_TYPE, size: 18, children: [{ type: 'text', value: '放大' }] },
    { type: 'text', value: ' 普通' }
  ])
})

test('转换：span 与 mark 是兄弟关系，两侧各走各的', () => {
  const { nestFontSizeSpans, FONT_SIZE_MDAST_TYPE } = fontModule

  // 实测 mdast：`<span18>前**粗**后</span>` → html · text · strong · text · html（同层兄弟）
  const out = nestFontSizeSpans([
    { type: 'html', value: '<span style="font-size:18px">' },
    { type: 'text', value: '前' },
    { type: 'strong', children: [{ type: 'text', value: '粗' }] },
    { type: 'text', value: '后' },
    { type: 'html', value: '</span>' }
  ])

  assert.equal(out.length, 1)
  assert.equal(out[0].type, FONT_SIZE_MDAST_TYPE)
  assert.equal(out[0].size, 18)
  assert.deepEqual(out[0].children, [
    { type: 'text', value: '前' },
    { type: 'strong', children: [{ type: 'text', value: '粗' }] },
    { type: 'text', value: '后' }
  ])
})

test('转换：mark 内部的 span 需递归处理', () => {
  const { nestFontSizeSpans, FONT_SIZE_MDAST_TYPE } = fontModule

  // 实测 mdast：`**前<span18>大</span>后**` → strong 内部含成对 html
  const out = nestFontSizeSpans([
    {
      type: 'strong',
      children: [
        { type: 'text', value: '前' },
        { type: 'html', value: '<span style="font-size:18px">' },
        { type: 'text', value: '大' },
        { type: 'html', value: '</span>' },
        { type: 'text', value: '后' }
      ]
    }
  ])

  assert.equal(out.length, 1)
  assert.equal(out[0].type, 'strong')
  assert.deepEqual(out[0].children, [
    { type: 'text', value: '前' },
    { type: FONT_SIZE_MDAST_TYPE, size: 18, children: [{ type: 'text', value: '大' }] },
    { type: 'text', value: '后' }
  ])
})

test('转换：嵌套字号（重叠区间）还原为嵌套容器', () => {
  const { nestFontSizeSpans, FONT_SIZE_MDAST_TYPE } = fontModule

  // 实测 mdast：`<span18>a<span22>b</span>c</span>` 是**扁平序列**，
  // 因此一个栈就能还原成正确的嵌套区间。
  const out = nestFontSizeSpans([
    { type: 'html', value: '<span style="font-size:18px">' },
    { type: 'text', value: 'a' },
    { type: 'html', value: '<span style="font-size:22px">' },
    { type: 'text', value: 'b' },
    { type: 'html', value: '</span>' },
    { type: 'text', value: 'c' },
    { type: 'html', value: '</span>' }
  ])

  assert.deepEqual(out, [
    {
      type: FONT_SIZE_MDAST_TYPE,
      size: 18,
      children: [
        { type: 'text', value: 'a' },
        { type: FONT_SIZE_MDAST_TYPE, size: 22, children: [{ type: 'text', value: 'b' }] },
        { type: 'text', value: 'c' }
      ]
    }
  ])
})

test('转换：表格单元格内结构与段落一致', () => {
  const { nestFontSizeSpans, FONT_SIZE_MDAST_TYPE } = fontModule

  // 实测 mdast：tableCell.children 与 paragraph.children 同形
  const out = nestFontSizeSpans([
    { type: 'html', value: '<span style="font-size:18px">' },
    { type: 'text', value: '大' },
    { type: 'html', value: '</span>' }
  ])
  assert.deepEqual(out, [
    { type: FONT_SIZE_MDAST_TYPE, size: 18, children: [{ type: 'text', value: '大' }] }
  ])
})

test('转换：⚠️ 栈空时遇到 </span> 必须原样保留（否则数据损坏）', () => {
  const { nestFontSizeSpans } = fontModule

  // 用户正文里可能有与字号无关的裸 </span>。吞掉它等于丢内容。
  assert.deepEqual(
    nestFontSizeSpans([{ type: 'text', value: '前' }, { type: 'html', value: '</span>' }]),
    [{ type: 'text', value: '前' }, { type: 'html', value: '</span>' }]
  )

  // 非字号的开标签 + 它的闭标签：都要原样保留（我们没开栈，就不能吞闭标签）。
  assert.deepEqual(
    nestFontSizeSpans([
      { type: 'html', value: '<span class="hl">' },
      { type: 'text', value: 'x' },
      { type: 'html', value: '</span>' }
    ]),
    [
      { type: 'html', value: '<span class="hl">' },
      { type: 'text', value: 'x' },
      { type: 'html', value: '</span>' }
    ]
  )
})

test('转换：未闭合的 span 不丢内容（尽力而为）', () => {
  const { nestFontSizeSpans, FONT_SIZE_MDAST_TYPE } = fontModule

  const out = nestFontSizeSpans([
    { type: 'html', value: '<span style="font-size:18px">' },
    { type: 'text', value: '没有闭合' },
    { type: 'text', value: '后面的文字' }
  ])

  assert.equal(out.length, 1)
  assert.equal(out[0].type, FONT_SIZE_MDAST_TYPE)
  assert.equal(out[0].size, 18)
  assert.deepEqual(out[0].children, [
    { type: 'text', value: '没有闭合' },
    { type: 'text', value: '后面的文字' }
  ])
})

test('转换：是纯函数，不修改入参', () => {
  const { nestFontSizeSpans } = fontModule

  const input = [
    { type: 'html', value: '<span style="font-size:18px">' },
    { type: 'strong', children: [{ type: 'text', value: '粗' }] },
    { type: 'html', value: '</span>' }
  ]
  const snapshot = JSON.parse(JSON.stringify(input))

  nestFontSizeSpans(input)

  assert.deepEqual(input, snapshot, '入参 mdast 树可能被其它插件复用，不得原地改动')
})

test('转换：空输入与纯文本输入原样返回', () => {
  const { nestFontSizeSpans } = fontModule

  assert.deepEqual(nestFontSizeSpans([]), [])
  assert.deepEqual(
    nestFontSizeSpans([{ type: 'text', value: '纯文本' }]),
    [{ type: 'text', value: '纯文本' }]
  )
})
