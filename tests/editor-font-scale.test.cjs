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

test('字号档位：默认档是 15px，且档位单调递增', () => {
  const { FONT_SCALE_STEPS, DEFAULT_FONT_SCALE_INDEX } = scaleModule
  assert.equal(FONT_SCALE_STEPS[DEFAULT_FONT_SCALE_INDEX], 15, '默认正文应为 15px')
  const sorted = [...FONT_SCALE_STEPS].sort((a, b) => a - b)
  assert.deepEqual([...FONT_SCALE_STEPS], sorted, '档位必须单调递增，否则 A+/A- 方向会乱')
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

test('字号档位：到边界时 canChangeFontSize 为假，nextFontScaleIndex 原地不动', () => {
  const { FONT_SCALE_STEPS, canChangeFontSize, nextFontScaleIndex } = scaleModule
  const last = FONT_SCALE_STEPS.length - 1

  // 中间档两边都能动
  assert.equal(canChangeFontSize(2, 1), true)
  assert.equal(canChangeFontSize(2, -1), true)

  // 两端各自只有一侧可动 —— 这决定了「已经是最小/最大字号」的提示时机
  assert.equal(canChangeFontSize(0, -1), false, '最小档不能再缩')
  assert.equal(canChangeFontSize(0, 1), true)
  assert.equal(canChangeFontSize(last, 1), false, '最大档不能再放大')
  assert.equal(canChangeFontSize(last, -1), true)

  // 到边界返回原值，调用方据此判断"没动"并给提示
  assert.equal(nextFontScaleIndex(0, -1), 0)
  assert.equal(nextFontScaleIndex(last, 1), last)
  assert.equal(nextFontScaleIndex(2, 1), 3)
  assert.equal(nextFontScaleIndex(2, -1), 1)
})

test('字号档位：localStorage 脏数据一律回落默认档', () => {
  const { DEFAULT_FONT_SCALE_INDEX, FONT_SCALE_STEPS, parseStoredFontScale } = scaleModule

  assert.equal(parseStoredFontScale('0'), 0)
  assert.equal(parseStoredFontScale('6'), 6)

  // 历史脏数据不该让字号失控
  assert.equal(parseStoredFontScale(null), DEFAULT_FONT_SCALE_INDEX)
  assert.equal(parseStoredFontScale(''), DEFAULT_FONT_SCALE_INDEX)
  assert.equal(parseStoredFontScale('abc'), DEFAULT_FONT_SCALE_INDEX)
  assert.equal(parseStoredFontScale('-1'), DEFAULT_FONT_SCALE_INDEX)
  assert.equal(parseStoredFontScale(String(FONT_SCALE_STEPS.length)), DEFAULT_FONT_SCALE_INDEX)
  assert.equal(parseStoredFontScale('2.5'), DEFAULT_FONT_SCALE_INDEX)
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

test('字号接线：工具栏有放大/缩小入口，且在只读与预览下仍可用', () => {
  const source = readSource('src/components/MarkdownVisualEditor.vue')

  // ⚠️ 别用 [^)]* —— `action: () => changeFontSize(1)` 里的 `()` 会把它截断。
  assert.match(source, /label: '放大字号'[\s\S]*?changeFontSize\(1\)/, '工具栏应有放大字号入口')
  assert.match(source, /label: '缩小字号'[\s\S]*?changeFontSize\(-1\)/, '工具栏应有缩小字号入口')

  // previewAllowed 让按钮在只读/预览模式下不被禁用 —— 看的时候同样需要调大小。
  const increase = source.match(/label: '放大字号'[^\n]*/)
  const decrease = source.match(/label: '缩小字号'[^\n]*/)
  assert.match(increase[0], /previewAllowed: true/, '放大字号应在预览下可用')
  assert.match(decrease[0], /previewAllowed: true/, '缩小字号应在预览下可用')

  // 到边界要给提示，而不是静默无反应。
  assert.match(source, /已经是最小字号|已经是最大字号/, '到边界应有用户提示')
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
