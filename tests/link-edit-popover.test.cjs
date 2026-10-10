/**
 * 链接编辑浮层（自研 `LinkEditPopover`）的两层守卫。
 *
 * 1. **真实行为**：定位数学用真数据跑。这块最典型的静默失效是「浮层跑到屏幕外」
 *    —— 链接贴着编辑区右缘、或窗口很矮时就发生，字符串级断言完全看不出来。
 * 2. **接线守卫**：`LinkEditPopover.vue` 的字段 / 出口 / 键盘与失焦口径。
 */

const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const { resolve } = require('node:path')
const { pathToFileURL } = require('node:url')
const test = require('node:test')

const projectRoot = resolve(__dirname, '..')

let box
test.before(async () => {
  box = await import(pathToFileURL(resolve(projectRoot, 'src/utils/link-edit-popover.ts')).href)
})

/** 读源码做接线断言；`tests/` 下的单测读 `src/` 是既有惯例。 */
function readSource(relativePath) {
  return readFileSync(resolve(projectRoot, relativePath), 'utf8')
}

const POPOVER = 'src/components/LinkEditPopover.vue'
const anchor = (left, top, width, height = 20) => ({
  left,
  top,
  right: left + width,
  bottom: top + height
})

test('默认摆在链接上方，左缘与链接对齐', () => {
  const result = box.computeLinkEditPopoverPosition(
    anchor(300, 500, 80),
    { width: 1200, height: 900 },
    186
  )
  assert.equal(result.placement, 'above')
  assert.equal(result.left, 300)
  assert.equal(result.top, 500 - 186 - box.LINK_EDIT_POPOVER_GAP)
  assert.equal(result.width, box.LINK_EDIT_POPOVER_WIDTH)
})

test('上方空间不足时翻到下方', () => {
  const result = box.computeLinkEditPopoverPosition(
    anchor(300, 100, 80),
    { width: 1200, height: 900 },
    186
  )
  assert.equal(result.placement, 'below', '浮层不许盖住刚点的那条链接，也绝不能跑到视口上方去')
  assert.equal(result.top, 120 + box.LINK_EDIT_POPOVER_GAP)
})

test('链接贴着视口右缘时，浮层被推回视口内', () => {
  const result = box.computeLinkEditPopoverPosition(
    anchor(1100, 500, 80),
    { width: 1200, height: 900 },
    186
  )
  assert.equal(
    result.left,
    1200 - box.LINK_EDIT_POPOVER_WIDTH - box.LINK_EDIT_POPOVER_MARGIN,
    '左对齐会把浮层推出屏幕，必须夹住'
  )
  assert.ok(result.left + result.width <= 1200, '右缘不许溢出')
})

test('窄窗口下宽度压缩，但不小于下限、也不横向溢出', () => {
  const narrow = box.computeLinkEditPopoverPosition(
    anchor(20, 500, 60),
    { width: 300, height: 900 },
    186
  )
  assert.equal(narrow.width, 300 - box.LINK_EDIT_POPOVER_MARGIN * 2, '宽度应压到「视口 - 两侧留白」')
  assert.equal(narrow.left, box.LINK_EDIT_POPOVER_MARGIN)

  // 比下限还窄：宁可溢出也要能读（两行「标题 / 地址」摆不下就没法用了）。
  const tiny = box.computeLinkEditPopoverPosition(
    anchor(10, 500, 40),
    { width: 200, height: 900 },
    186
  )
  assert.equal(tiny.width, box.LINK_EDIT_POPOVER_MIN_WIDTH)
})

test('上下都放不下（窗口极矮）时仍夹在视口内', () => {
  const result = box.computeLinkEditPopoverPosition(
    anchor(60, 30, 40),
    { width: 800, height: 150 },
    186
  )
  assert.ok(result.top >= box.LINK_EDIT_POPOVER_MARGIN, `浮层顶部不许越过上边缘，实际 ${result.top}`)
  assert.ok(
    result.top + Math.min(186, 150 - box.LINK_EDIT_POPOVER_MARGIN * 2) <= 150,
    '浮层底部不许越过下边缘'
  )
})

test('浮层摆在 body 上并带自己的层级（要盖过模式条与编辑器顶栏）', () => {
  const source = readSource(POPOVER)
  assert.match(source, /<Teleport to="body">/, '浮层必须传送到 body，否则会被编辑区裁剪')
  assert.match(source, /position: fixed;/)
  assert.match(source, /z-index: 240;/)
})

test('字段与底部两个出口', () => {
  const source = readSource(POPOVER)
  assert.match(source, /<span class="link-edit-popover__label">标题<\/span>/, '要有一行「标题」')
  assert.match(source, /<span class="link-edit-popover__label">地址<\/span>/, '要有一行「地址」')
  assert.match(
    source,
    /v-if="props\.canRemove"[\s\S]*?link-edit-popover__remove[\s\S]*?取消链接/,
    '「取消链接」应只在已有链接时出现'
  )
  assert.match(source, /link-edit-popover__save[\s\S]*?保存/, '底部右侧要有「保存」')
  // 两个输入框都双向绑定到本地 ref（初始值来自 props，父级用 v-if 装卸所以不需要 watch）。
  assert.match(source, /const title = ref\(props\.title\)/)
  assert.match(source, /const href = ref\(props\.href\)/)
})

test('键盘口径：Esc 关闭、Enter 保存，且不能被输入法组词误触', () => {
  const source = readSource(POPOVER)
  assert.match(source, /if \(event\.key === 'Escape'\)[\s\S]*?emit\('close'\)/)
  assert.match(
    source,
    /if \(event\.key === 'Enter' && !event\.isComposing\)/,
    '⚠️ 中文输入时按 Enter 是「上屏候选词」，不判 isComposing 会在选字瞬间把弹窗关掉'
  )
})

test('点浮层外部即关闭，且监听在卸载时收走', () => {
  const source = readSource(POPOVER)
  assert.match(source, /addEventListener\('pointerdown', handleOutsidePointerDown, true\)/)
  assert.match(source, /removeEventListener\('pointerdown', handleOutsidePointerDown, true\)/)
  assert.match(source, /popoverRef\.value\?\.contains\(target\)/)
})

test('焦点落在需要填的那个输入框上', () => {
  const source = readSource(POPOVER)
  assert.match(
    source,
    /const focusTarget = href\.value\.trim\(\) \? titleInputRef\.value : hrefInputRef\.value/,
    '新建链接时文字来自选中正文，此时该聚焦「地址」；编辑已有链接才聚焦「标题」'
  )
})

test('暗色主题只需重写投影，且只能取全局变量', () => {
  const source = readSource(POPOVER)
  assert.match(source, /html\[data-theme="dark"\] \.link-edit-popover \{[\s\S]*?box-shadow:/)
  // ⚠️ 浮层传送到 body，早已在 `.milkdown-editor-root .milkdown` 之外 ——
  // `--crepe-color-*` 是定义在那个作用域里的，这里取不到值（会整块变透明/继承成黑）。
  assert.doesNotMatch(
    source,
    /crepe-color-/,
    '浮层在 body 上，必须用 :root 的全局变量（--surface-solid / --ink / --line / --panel），' +
      '不能用只在 .milkdown 里定义过的 --crepe-color-*'
  )
  for (const variable of ['var(--surface-solid', 'var(--ink', 'var(--line', 'var(--panel']) {
    assert.ok(source.includes(variable), `配色应取全局变量 ${variable}…）`)
  }
})
