const test = require('node:test')
const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const { resolve } = require('node:path')

const projectRoot = resolve(__dirname, '..')
const readSource = (filePath) => readFileSync(resolve(projectRoot, filePath), 'utf8')
const source = () => readSource('src/components/MarkdownSourceEditor.vue')

/**
 * 外部文件编辑器的大纲侧栏与「复制 Markdown」。
 *
 * 两条底线：
 * 1. **不许另起一套** —— 大纲数据用共享的 `extractMarkdownOutline`，侧栏外观用
 *    `src/style.css` 里的 `.markdown-outline*`（笔记侧栏同一份），组件里再写一份必然漂移；
 * 2. **不许碰保存链路** —— 复制只是读 `props.value` 写剪贴板，大纲只是只读解析，
 *    正文回传仍然只有「输入时 + 卸载兜底」那两处。
 */
test('模式条上有大纲开关与复制按钮，两者都指向同一块侧栏', () => {
  const text = source()

  assert.match(text, /class="markdown-source-editor__outline"/)
  assert.match(text, /aria-controls="source-editor-outline-panel"/)
  assert.match(text, /:aria-pressed="outlineOpen"/)
  assert.match(text, /@click="toggleOutline"/)
  assert.match(text, /class="markdown-source-editor__copy"/)
  assert.match(text, /@click="copyMarkdown"/)
  // 面板 id 与开关的 aria-controls 必须一致，否则「开关指向哪里」就没法验证。
  assert.match(text, /id="source-editor-outline-panel"/)
})

test('大纲侧栏复用笔记那套全局样式，不在组件里另写一份', () => {
  const text = source()

  assert.match(text, /class="markdown-outline markdown-source-editor__outline"/)
  assert.match(text, /class="markdown-outline__header"/)
  assert.match(text, /class="markdown-outline__list"/)
  assert.match(text, /class="markdown-outline-item"/)
  assert.match(text, /:style="\{ '--outline-level': item\.level \}"/)
  // 侧栏基础样式（含暗色）只在 style.css 里，组件只补宽度与窄窗口落点。
  // 行首直接写 `.markdown-outline {` 就是又抄了一份 —— 禁止。
  assert.doesNotMatch(text, /(^|\n)\.markdown-outline\s*\{/)
  assert.match(readSource('src/style.css'), /\.markdown-outline__title\s*\{/)
})

test('大纲数据来自共享真源，且只在防抖里重算', () => {
  const text = source()

  assert.match(text, /import \{ extractMarkdownOutline, type MarkdownOutlineItem \} from '\.\.\/utils\/markdown-outline'/)
  assert.match(text, /outlineItems\.value = extractMarkdownOutline\(props\.value\)/)
  // 外部文件可能很大，逐键全量 lex 会挡输入 —— 必须先走防抖。
  assert.match(text, /function scheduleOutline/)
  assert.match(text, /scheduleOutline\(\)/)
})

test('源码模式靠位置跳转（CodeMirror 里没有标题 DOM），预览模式才量 DOM', () => {
  const text = source()

  const scroll = text.match(/function scrollToOutline[\s\S]*?\n\}/)
  assert.ok(scroll, '跳转应集中在 scrollToOutline 里')
  // 源码态：定位到标题行首并滚动过去。
  assert.match(scroll[0], /EditorView\.scrollIntoView/)
  assert.match(scroll[0], /view\.state\.doc\.lineAt/)
  assert.match(scroll[0], /selection: \{ anchor: line\.from \}/)
  // 预览态：量渲染出来的标题节点（口径与 extractMarkdownOutline 一致，要过滤渲染产物）。
  assert.match(scroll[0], /previewHeadings\(\)\[index\]/)
  // 预览态的标题口径：渲染产物（表格单元格块级渲染 / 引用块里的标题）必须过滤掉，
  // 否则下标相对大纲整体错位 —— 这条与笔记编辑器是同一个坑。
  assert.match(text, /function previewHeadings/)
  assert.match(text, /closest\('td, th, blockquote, li'\)/)
  // 滚动联动高亮：源码态用「视口顶部对应的文档偏移」反查，量不到矩形。
  assert.match(text, /function updateActiveOutline/)
  assert.match(text, /view\.lineBlockAtHeight\(view\.scrollDOM\.scrollTop \+ OUTLINE_ACTIVE_LEAD\)/)
  // CodeMirror 的 scroll 不冒泡，得手动挂在它的滚动容器上（并在卸载时摘掉）。
  assert.match(text, /view\.scrollDOM\.addEventListener\('scroll', updateActiveOutline/)
  assert.match(text, /view\.scrollDOM\.removeEventListener\('scroll', updateActiveOutline\)/)
})

test('大纲开关与笔记共用同一个偏好键', () => {
  const text = source()
  const visualEditor = readSource('src/components/MarkdownVisualEditor.vue')

  assert.match(text, /const OUTLINE_STORAGE_KEY = 'markdown-outline-open'/)
  assert.match(text, /localStorage\.setItem\(OUTLINE_STORAGE_KEY/)
  assert.match(text, /localStorage\.getItem\(OUTLINE_STORAGE_KEY\)/)
  // 两处必须是同一个键，否则「与笔记共用」这个承诺就落空了。
  assert.match(visualEditor, /const OUTLINE_STORAGE_KEY = 'markdown-outline-open'/)
})

test('复制的是文件原文，不经过任何解析', () => {
  const text = source()

  const copy = text.match(/async function copyMarkdown[\s\S]*?\n\}/)
  assert.ok(copy, '复制应集中在 copyMarkdown 里')
  assert.match(copy[0], /navigator\.clipboard\.writeText\(props\.value\)/)
  // 复制是只读操作，不许顺手把正文回传（那会新增第三处 emit）。
  assert.doesNotMatch(copy[0], /emit\(/)
})
