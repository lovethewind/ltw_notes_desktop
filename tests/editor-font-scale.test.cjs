/**
 * 编辑器正文显示字号（档位逻辑 + 接线）的约束。
 *
 * ## 为什么这里要分两层测
 *
 * 1. **档位逻辑**（`src/utils/editor-font-scale.ts`）是纯函数，用**真实行为断言** ——
 *    边界、越界回落、脏数据这些用源码正则根本测不出来。
 * 2. **接线**（`MarkdownVisualEditor.vue` / `style.css`）是字符串层面的约定，
 *    只能做正则匹配。这些断言每一条都对应一个「静默失效」的坑：
 *    字号改了但 CSS 变量没接上、或接到了全局 `<html>` 上污染其它编辑器实例。
 *
 * ## 核心约束（别改坏）
 *
 * markdown **没有行内字号语法**。字号只能做「显示缩放」，
 * **绝不能**把 font-size 写进正文源码 —— 那会污染 markdown、影响 Web 端
 * `ltw_front_v3` 渲染与 Markdown 导出。下面有一条断言专门守这个。
 */

const test = require('node:test')
const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const { resolve } = require('node:path')
const { pathToFileURL } = require('node:url')

const projectRoot = resolve(__dirname, '..')
const readSource = (filePath) => readFileSync(resolve(projectRoot, filePath), 'utf8')

let scaleModule

test.before(async () => {
  scaleModule = await import(
    pathToFileURL(resolve(projectRoot, 'src/utils/editor-font-scale.ts')).href
  )
})

test('字号档位：默认档是 15px，取值对齐钉钉，且档位单调递增', () => {
  const { FONT_SCALE_STEPS, DEFAULT_FONT_SCALE_INDEX } = scaleModule
  assert.equal(FONT_SCALE_STEPS[DEFAULT_FONT_SCALE_INDEX], 15, '默认正文应为 15px')
  // 钉钉字号下拉的取值：9/10/11/12/14/16/18/20/22，本项目额外补 15 作为默认档。
  assert.deepEqual(
    [...FONT_SCALE_STEPS],
    [9, 10, 11, 12, 14, 15, 16, 18, 20, 22],
    '档位应取钉钉的列表并保留 15px 默认档'
  )
  const sorted = [...FONT_SCALE_STEPS].sort((a, b) => a - b)
  assert.deepEqual([...FONT_SCALE_STEPS], sorted, '档位必须单调递增，否则下拉顺序会乱')
})

test('字号档位：fontSizeAt 正常取档，越界一律回落默认档', () => {
  const { FONT_SCALE_STEPS, DEFAULT_FONT_SCALE_INDEX, fontSizeAt } = scaleModule
  const fallback = FONT_SCALE_STEPS[DEFAULT_FONT_SCALE_INDEX]

  assert.equal(fontSizeAt(0), FONT_SCALE_STEPS[0])
  assert.equal(fontSizeAt(DEFAULT_FONT_SCALE_INDEX), 15)
  assert.equal(fontSizeAt(FONT_SCALE_STEPS.length - 1), FONT_SCALE_STEPS[FONT_SCALE_STEPS.length - 1])

  // 越界与非法输入都回落，不能抛错、也不能返回 undefined 把界面顶坏。
  assert.equal(fontSizeAt(-1), fallback)
  assert.equal(fontSizeAt(FONT_SCALE_STEPS.length), fallback)
  assert.equal(fontSizeAt(1.5), fallback)
  assert.equal(fontSizeAt(Number.NaN), fallback)
  assert.equal(fontSizeAt(undefined), fallback)
})

test('字号档位：indexOfFontSize 能反查档位，旧档位回落默认', () => {
  const { DEFAULT_FONT_SCALE_INDEX, FONT_SCALE_STEPS, indexOfFontSize } = scaleModule

  assert.equal(indexOfFontSize(9), 0)
  assert.equal(indexOfFontSize(15), DEFAULT_FONT_SCALE_INDEX)
  assert.equal(indexOfFontSize(22), FONT_SCALE_STEPS.length - 1)

  // 历史存过 13px/17px 这类已移除的档位时，下拉不能「一个都没选中」。
  assert.equal(indexOfFontSize(13), DEFAULT_FONT_SCALE_INDEX, '旧档位应回落默认档')
  assert.equal(indexOfFontSize(17), DEFAULT_FONT_SCALE_INDEX, '旧档位应回落默认档')
  assert.equal(indexOfFontSize(Number.NaN), DEFAULT_FONT_SCALE_INDEX)
})

test('字号档位：localStorage 存的是字号而非下标，认不出的一律回落默认档', () => {
  const { DEFAULT_FONT_SCALE_INDEX, FONT_SCALE_STEPS, parseStoredFontScale } = scaleModule

  // 存字号 → 反查回档位。
  assert.equal(parseStoredFontScale('9'), 0)
  assert.equal(parseStoredFontScale('15'), DEFAULT_FONT_SCALE_INDEX)
  assert.equal(parseStoredFontScale('22'), FONT_SCALE_STEPS.length - 1)

  // ⚠️ 关键：旧版本存的是「档位下标」，其中 2 曾代表 15px。
  // 现在 2 不在档位表里（档位里没有 2px 这一档），必须回落默认档 15px，
  // 而不是被当成下标 2 解析成 11px —— 那会让用户没动设置字号却自己变了。
  assert.equal(parseStoredFontScale('2'), DEFAULT_FONT_SCALE_INDEX, '旧下标不得被当成字号')
  assert.equal(parseStoredFontScale('6'), DEFAULT_FONT_SCALE_INDEX, '旧下标不得被当成字号')

  // 已移除的旧档位（13/17）也要回落，不能出现「一个都没选中」。
  assert.equal(parseStoredFontScale('13'), DEFAULT_FONT_SCALE_INDEX)
  assert.equal(parseStoredFontScale('17'), DEFAULT_FONT_SCALE_INDEX)

  // 脏数据不该让字号失控。
  assert.equal(parseStoredFontScale(null), DEFAULT_FONT_SCALE_INDEX)
  assert.equal(parseStoredFontScale(''), DEFAULT_FONT_SCALE_INDEX)
  assert.equal(parseStoredFontScale('abc'), DEFAULT_FONT_SCALE_INDEX)
  assert.equal(parseStoredFontScale('-1'), DEFAULT_FONT_SCALE_INDEX)
  assert.equal(parseStoredFontScale('999'), DEFAULT_FONT_SCALE_INDEX)
})

test('字号接线：档位以行内 CSS 变量渲染在组件根节点，而非全局 html', () => {
  const source = readSource('src/components/MarkdownVisualEditor.vue')

  // 必须把变量绑在组件根节点上：绑到 <html> 会波及冲突对比等其它编辑器实例。
  assert.match(
    source,
    /'--markdown-body-font-size':\s*`\$\{bodyFontSize\}px`/,
    '应把正文字号以行内变量绑定到组件根节点'
  )
  assert.doesNotMatch(
    source,
    /documentElement\.style\.setProperty\(\s*['"]--markdown-body-font-size/,
    '不应把字号写到 documentElement 上（会污染其它编辑器实例）'
  )

  // 档位逻辑应来自独立模块，别在组件里再抄一份常量。
  assert.match(source, /from '\.\.\/utils\/editor-font-scale'/, '应复用 editor-font-scale 模块')
  assert.doesNotMatch(
    source,
    /const FONT_SCALE_STEPS\s*=/,
    '档位常量应只存在于 editor-font-scale.ts，组件内不得重复定义'
  )
})

test('字号接线：下拉挂在「一级标题」之后，选中即设置并持久化', () => {
  const source = readSource('src/components/MarkdownVisualEditor.vue')

  // 位置：紧跟块类型选择器之后（heading.after(...)），而不是埋进「更多」菜单。
  assert.match(
    source,
    /heading\.after\(createFontSizeMenu\(\)\)/,
    '字号下拉应插在「一级标题」选择器之后'
  )
  // 旧的放大/缩小入口应已移除。
  assert.doesNotMatch(source, /label: '放大字号'/, '应移除「更多」菜单里的放大字号入口')
  assert.doesNotMatch(source, /label: '缩小字号'/, '应移除「更多」菜单里的缩小字号入口')

  // 取值来自模块常量，避免组件内手写一份数字列表后与档位逻辑脱节。
  assert.match(source, /FONT_SCALE_STEPS\.forEach/, '下拉选项应由 FONT_SCALE_STEPS 生成')
  // 选中即写 localStorage，且写的是字号（不是档位下标）—— 存下标会在档位列表
  // 变动时静默串档（旧下标 2 曾是 15px，新列表里会变成 11px）。
  assert.match(
    source,
    /function setFontSize[\s\S]*?localStorage\.setItem\(\s*FONT_SCALE_STORAGE_KEY,\s*String\(bodyFontSize\.value\)/,
    '应把字号本身（而非档位下标）持久化到 localStorage'
  )
  // 下拉本身要能被开关/定位机制接管。
  assert.match(
    source,
    /TOOLBAR_MENU_TOGGLE_SELECTOR\s*=\s*'[^']*\.markdown-font-size-menu__toggle/,
    '字号下拉触发器应纳入统一的菜单开关/定位选择器'
  )
})

test('字号接线：字号下拉在只读与预览下仍可用（它只是显示参数）', () => {
  const source = readSource('src/components/MarkdownVisualEditor.vue')

  // 只读/预览态会批量禁用工具栏按钮，字号下拉必须被显式排除，
  // 否则「预览时想调大字号」就点不动了。
  const guard = source.match(/querySelectorAll<HTMLButtonElement>\(\s*'\.top-bar-heading-selector button[\s\S]*?'/)
  assert.ok(guard, '应能找到只读态禁用工具栏按钮的守卫')
  assert.match(guard[0], /markdown-font-size-menu__toggle/, '字号下拉应被排除在禁用列表外')
})

test('字号接线：样式表按变量缩放正文与标题，且标题不再用 Crepe 默认的 42px', () => {
  const css = readSource('src/style.css')

  assert.match(
    css,
    /--markdown-body-font-size:\s*15px/,
    '样式表应定义 --markdown-body-font-size 兜底值'
  )
  assert.match(
    css,
    /\.ProseMirror\s*\{[^}]*font-size:\s*var\(--markdown-body-font-size\)/,
    '正文应消费 --markdown-body-font-size'
  )

  // 标题必须被收紧：Crepe 默认 42/36/32px 在窄窗口里能占掉半屏。
  // 断言标题规则以变量为基准做 calc 换算，而非硬编码 Crepe 的固定值。
  assert.match(css, /ProseMirror h1\s*\{[^}]*font-size:\s*calc\(var\(--markdown-body-font-size\)/, 'h1 字号应随变量缩放')
  assert.doesNotMatch(
    css,
    /ProseMirror h1\s*\{[^}]*font-size:\s*42px/,
    'h1 不应保留 Crepe 默认的 42px'
  )
  assert.doesNotMatch(
    css,
    /ProseMirror h2\s*\{[^}]*font-size:\s*36px/,
    'h2 不应保留 Crepe 默认的 36px'
  )

  // 表头底色是钉钉观感的关键差异之一。
  assert.match(css, /ProseMirror table thead th\s*\{[^}]*background:/, '表头应有底色')
})

test('字号接线：下拉面板与选项有独立样式，且选中项有打勾标记', () => {
  const css = readSource('src/style.css')
  const source = readSource('src/components/MarkdownVisualEditor.vue')

  assert.match(css, /\.markdown-font-size-menu__panel\s*\{/, '应有下拉面板样式')
  assert.match(css, /\.markdown-font-size-menu__item\.active::before\s*\{\s*content:\s*'✓'/, '选中项应打勾')
  // 触发器只显示数值，不能被 top-bar-item 的 ::after 文案顶出来。
  assert.match(
    css,
    /\.markdown-font-size-menu__toggle::after\s*\{\s*content:\s*none/,
    '触发器不应显示 data-label 文案'
  )

  // ⚠️ 触发器布局规则必须比通用 `.top-bar-item` 多一级特异性（用 `>`）。
  // 两者同为 4 类时，声明更靠后的 `.top-bar-item`（flex-direction: column）会胜出，
  // 触发器被压成竖排 + 内边距被 2px 覆盖 —— 09-23 用户截图反馈「菜单有点窄」的根因。
  assert.match(
    css,
    /\.markdown-font-size-menu\s*>\s*\.markdown-font-size-menu__toggle\s*\{[^}]*flex-direction:\s*row/,
    '触发器规则应带 `>` 提升特异性，否则会被 .top-bar-item 的 column 覆盖'
  )
  assert.match(
    css,
    /\.markdown-font-size-menu\s*>\s*\.markdown-font-size-menu__toggle\s*\{[^}]*height:\s*34px/,
    '触发器高度应显式声明（通用 .top-bar-item 的 40px 会干扰）'
  )

  // ⚠️ 选项文字必须是真实文本节点，不能靠 ::after { content: attr(data-label) }。
  // 伪元素内容不进 textContent —— 读屏与 e2e 都会读到空字符串（本轮真踩过）。
  assert.match(source, /option\.textContent\s*=\s*String\(size\)/, '选项应用真实文本节点渲染数值')
  assert.doesNotMatch(
    css,
    /\.markdown-font-size-menu__item::after\s*\{\s*content:\s*attr\(data-label\)/,
    '选项文字不应靠伪元素渲染（textContent 取不到）'
  )

  // ⚠️ 初始选中态必须在创建选项时设置：菜单创建时尚未插入 DOM，
  // 此时走 syncFontSizeMenu() 查询会落空，用户打开下拉会看到「一项都没打勾」。
  assert.match(
    source,
    /FONT_SCALE_STEPS\.forEach[\s\S]*?option\.classList\.toggle\('active',\s*isActive\)/,
    '初始选中态应在创建选项时直接设好，不能依赖插入 DOM 后再查询'
  )
})

test('字号约束：字号只做显示缩放，绝不写进正文源码', () => {
  const source = readSource('src/components/MarkdownVisualEditor.vue')

  // markdown 没有行内字号语法。若哪天有人为了"给选中文字改字号"而往正文写
  // font-size，会污染源码并影响 Web 端 ltw_front_v3 与 Markdown 导出 —— 这条守住它。
  assert.doesNotMatch(
    source,
    /font-size\s*[:=]\s*[^,;)\n]*['"`]\s*(?:px|em|rem)/,
    '不得把 font-size 写进正文（会污染 markdown 源码）'
  )
})
