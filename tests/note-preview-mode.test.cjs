/**
 * 笔记预览（渲染视图）——接线约束。
 *
 * ## 分工
 *
 * | 文件 | 测什么 | 怎么测 |
 * |---|---|---|
 * | `tests/markdown-preview-render.test.cjs` | 渲染本身（单元格块级、公式） | 真行为断言 |
 * | `tests/e2e/note-preview.e2e.test.cjs` | 真窗口：盖住、透明度、几何、进出改动 | Playwright |
 * | 本文件 | 接线（`.vue` 结构、网格分工、`style.css`） | 源码正则 |
 *
 * 每一条都对应一个**静默失效**的坑：没有报错、没有堆栈，只是「点了没用」或者
 * 「字叠在一起」。踩过的在下面逐条注明。
 */

const test = require('node:test')
const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const { resolve } = require('node:path')

const projectRoot = resolve(__dirname, '..')
const readSource = (filePath) => readFileSync(resolve(projectRoot, filePath), 'utf8')

const EDITOR = 'src/components/MarkdownVisualEditor.vue'
const STYLE = 'src/style.css'

/**
 * 抓出一个 CSS 声明块（按「选择器 { ... }」取，不跨块）。
 *
 * ⚠️ 必须锚定行首：`.history-editor-preview > .milkdown-editor-shell { min-height: 0; … }`
 * 这种组合选择器里也含 `.milkdown-editor-shell {`，不锚行首会抓到它而不是真正那条。
 */
function cssBlock(source, selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = source.match(new RegExp(`^${escaped} \\{[^}]*\\}`, 'm'))
  return match ? match[0] : null
}

/* ------------------------------------------------------------------ *
 * 1. 入口唯一：顶栏那个眼睛按钮必须已经拿掉
 * ------------------------------------------------------------------ */

test('笔记预览：顶栏不再有预览按钮（入口只剩常驻模式条）', () => {
  const source = readSource(EDITOR)

  // 坑：按钮没了但 `syncPreviewToggle()` 还留着 → 每次顶栏重绘都去 querySelector 一个
  // 不存在的节点，静默 return。看起来没事，实际上那段代码已经永远跑不到。
  assert.doesNotMatch(source, /markdown-preview-toggle/, '顶栏的预览按钮及其同步函数都应移除')
  assert.doesNotMatch(source, /syncPreviewToggle/, '按钮没了，同步函数也要一起删干净')
})

/* ------------------------------------------------------------------ *
 * 2. 常驻模式条：只读上下文里不出现
 * ------------------------------------------------------------------ */

test('笔记预览：模式条常驻，且只在可写上下文出现', () => {
  const source = readSource(EDITOR)

  assert.match(source, /<header v-if="showModeBar" class="markdown-note-mode-bar">/, '模式条应常驻在编辑器上方')
  // 坑：`v-if="previewMode"` 的老写法会让模式条跟预览层一起生灭 —— 编辑态就没有入口了；
  // 而常驻之后若忘了排除只读上下文，历史预览 / 冲突对比里会多出一条点了没反应的栏。
  assert.match(
    source,
    /const showModeBar = computed\(\(\) => !props\.readonly && props\.showToolbar\)/,
    '模式条只在「可写且有工具栏」的笔记编辑器里出现'
  )
  assert.doesNotMatch(source, /<header[^>]*class="markdown-note-preview__bar"/, '模式条不得再挂在预览层里')
})

test('笔记预览：两个模式按钮各自绑定明确目标，并暴露 aria-pressed', () => {
  const source = readSource(EDITOR)

  // 坑：两个按钮都绑 `togglePreview` 时，点「当前已激活」的那个会反向切走 ——
  // 用户点「预览」只是想确认自己在预览里，结果被切回编辑。
  assert.match(source, /@click="setPreviewMode\(false\)"/, '「编辑」按钮应显式切到编辑')
  assert.match(source, /@click="setPreviewMode\(true\)"/, '「预览」按钮应显式切到预览')
  assert.match(source, /:aria-pressed="!previewMode"/, '「编辑」按钮要暴露 aria-pressed（e2e 依赖它判定状态）')
  assert.match(source, /:aria-pressed="previewMode"/, '「预览」按钮要暴露 aria-pressed')
  assert.match(source, /:class="\{ 'is-active': previewMode \}"/, '激活态样式要跟着模式走')
})

test('笔记预览：setPreviewMode 有幂等与只读守卫，togglePreview 只是它的包装', () => {
  const source = readSource(EDITOR)
  const body = source.match(/function setPreviewMode\(next: boolean\): void \{[\s\S]*?\n\}/)

  assert.ok(body, '应有 setPreviewMode(next)')
  assert.match(body[0], /if \(props\.readonly \|\| !editor \|\| !editorReady\) return/, '只读 / 未就绪时不得切换')
  // 坑：没有幂等守卫时，重复点同一个按钮会重跑 blur + 清选区 + 复位滚动，
  // 用户只是点了一下「预览」，阅读位置却被拉回大纲锚点。
  assert.match(body[0], /if \(previewMode\.value === next\) return/, '重复设定同一模式应直接返回')
  assert.match(
    source,
    /function togglePreview\(\): void \{\s*setPreviewMode\(!previewMode\.value\)\s*\}/,
    'togglePreview 只应是 setPreviewMode 的包装'
  )
})

/* ------------------------------------------------------------------ *
 * 3. 网格分工：模式条一行，编辑区与预览层共用下一行
 * ------------------------------------------------------------------ */

test('笔记预览：模式条与编辑区不在同一格（否则就是用户看到的「压字」）', () => {
  const style = readSource(STYLE)

  const shell = cssBlock(style, '.milkdown-editor-shell')
  assert.ok(shell, '应有 .milkdown-editor-shell 声明块')
  // 第 1 行给模式条，第 2 行给编辑区/预览层。只读上下文没有模式条，第 1 行自动塌成 0。
  assert.match(shell, /grid-template-rows:\s*auto minmax\(0, 1fr\)/, '外壳应显式分两行')

  const outline = style.match(/\.milkdown-editor-shell > \.markdown-outline \{[^}]*\}/)
  assert.ok(outline, '侧栏应有显式网格定位')
  assert.match(outline[0], /grid-column:\s*2/, '侧栏在第 2 列')
  // 坑（2026-10-09 用户反馈「大纲也要单独出来」）：侧栏一跨满两行，就与模式条同处一条水平带 ——
  // 「编辑|预览」紧挨「大纲|关系」，两组按钮读起来像一条顶栏上的四个页签（`✕` 还会被当成关预览），
  // 而且两条底边差 19px（模式条 35 / 栏头 54），顶部出现台阶。侧栏必须只占第 2 行。
  assert.match(outline[0], /grid-row:\s*2(?!\s*\/)/, '侧栏应只占第 2 行（从模式条下方开始）')
  assert.doesNotMatch(outline[0], /grid-row:\s*1\s*\/\s*-1/, '侧栏不得再跨回第 1 行')

  const editor = readSource(EDITOR)
  const scroller = cssBlock(editor, '.milkdown-editor-shell .milkdown-editor-scroll')
  const preview = cssBlock(editor, '.markdown-note-preview')
  assert.ok(scroller && preview, '编辑区与预览层的定位都应显式写出')
  // 坑：两个 grid-area 少写一个，没定位的那个会被挤到第二列去。
  assert.match(scroller, /grid-area:\s*2 \/ 1/, '编辑区在第 2 行')
  assert.match(preview, /grid-area:\s*2 \/ 1/, '预览层与编辑区同格（这才叫「盖住」）')

  const bar = cssBlock(editor, '.markdown-note-mode-bar')
  assert.ok(bar, '应有 .markdown-note-mode-bar 声明块')
  assert.match(bar, /grid-row:\s*1/, '模式条独占第 1 行')
  // 坑：只写 `grid-column: 1` 时模式条只盖住编辑列，右端那组「编辑|预览」就正好贴到侧栏栏头边上，
  // 顶部又出现两条高度不同的横线。必须跨满（`1 / -1`，无侧栏时等价于第 1 列）。
  assert.match(bar, /grid-column:\s*1 \/ -1/, '模式条应跨满整幅宽度')
})

/* ------------------------------------------------------------------ *
 * 4. 预览层底色必须不透明
 * ------------------------------------------------------------------ */
test('笔记预览：预览层底色必须不透明（半透明 = 编辑器整层透上来）', () => {
  const preview = cssBlock(readSource(EDITOR), '.markdown-note-preview')
  assert.ok(preview, '应有 .markdown-note-preview 声明块')

  const background = preview.match(/background:\s*([^;]+);/)
  assert.ok(background, '预览层应显式声明底色')
  // 坑（2026-10-09 用户截图）：底色抄了外壳的 `rgba(248,251,255,.34)`，
  // 编辑器没卸载、整层还压在下面 → Crepe 顶栏与正文透出来，两层字叠在一起。
  // 这是「盖住」而不是「换掉」方案的代价：只要有 1% 透明，就能看见下面。
  assert.doesNotMatch(background[1], /rgba\(/, `预览层底色不得带透明度：${background[1].trim()}`)
  assert.doesNotMatch(background[1], /transparent/i, '预览层不得透明')

  // 暗色主题那条也要不透明。
  const dark = readSource(EDITOR).match(/html\[data-theme="dark"\] \.markdown-note-preview \{\s*background:\s*([^;]+);/)
  assert.ok(dark, '暗色主题应有独立的预览层底色')
  assert.doesNotMatch(dark[1], /rgba\(/, '暗色主题下预览层底色同样不得带透明度')
})

/* ------------------------------------------------------------------ *
 * 5. 大纲开关必须在模式条上（预览态唯一够得着的那条）
 * ------------------------------------------------------------------ */

test('笔记预览：大纲开关长在模式条上，不在被盖住的 Crepe 顶栏里', () => {
  const source = readSource(EDITOR)

  // 坑（2026-10-09 用户反馈「在预览模式里也能显示大纲」）：开关原本长在 Crepe 顶栏里，
  // 而预览层是「盖」在编辑区上的 —— 顶栏整条被盖住，大纲一旦是关着的，进预览就再也调不出来。
  // 探针实测：编辑态 `elementFromPoint` 落在按钮上，预览态落在 `.markdown-note-preview__body`。
  assert.doesNotMatch(source, /markdown-outline-toggle/, '顶栏那个大纲按钮应已移除')
  assert.doesNotMatch(source, /syncOutlineToggle/, '按钮没了，同步函数也要一起删干净')

  // 两个图标按钮共用一块样式，所以这里只能按类名查，不能用锚定单行选择器的 `cssBlock`。
  assert.match(source, /\.markdown-note-mode-bar__outline\b/, '模式条应有大纲开关的样式')

  const button = source.match(/<button\s+v-if="props\.showOutline"[\s\S]*?<\/button>/)
  assert.ok(button, '模式条应有大纲开关按钮')
  assert.match(button[0], /class="markdown-note-mode-bar__outline"/, '开关应挂新类名')
  assert.match(button[0], /@click="toggleOutline"/, '开关应复用 toggleOutline（含 localStorage 持久化）')
  // 坑：少了 aria-pressed，e2e 判不出开 / 关；少了 aria-controls，无障碍就断链。
  assert.match(button[0], /:aria-pressed="outlineOpen"/, '开关要暴露开合状态')
  assert.match(button[0], /aria-controls="markdown-outline-panel"/, '开关要指向面板 id')

  // 只读上下文（历史预览、冲突对比）传 `show-outline=false`，面板不在，开关也不该出现。
  assert.match(button[0], /v-if="props\.showOutline"/, '开关必须跟随 showOutline')
})

/* ------------------------------------------------------------------ *
 * 6. 「复制 Markdown」同理要上模式条，顶栏「更多」菜单随之下线
 * ------------------------------------------------------------------ */

test('笔记预览：复制 Markdown 长在模式条上，顶栏「更多」菜单整体下线', () => {
  const source = readSource(EDITOR)

  // 坑（2026-10-09 用户拍板）：它原本和「专注模式」一起待在顶栏「更多」里 —— 顶栏在预览态
  // 被预览层整层盖住，点不到；「专注模式」则被判定无用直接删除。两项一走菜单就空了，
  // 所以整条「更多」跟 `previewAllowed` 豁免机制一并下线，别留一个点了没反应的空面板。
  assert.doesNotMatch(source, /markdown-tools-menu/, '顶栏「更多」菜单应整体下线')
  assert.doesNotMatch(source, /previewAllowed/, 'previewAllowed 豁免机制失去使用者，应一并删除')
  assert.doesNotMatch(
    source,
    /focusMode|markdown-editor-focus-mode|is-focus-mode/,
    '专注模式的状态、body 类与模板类名应整体移除'
  )

  const button = source.match(
    /<button\s+type="button"\s+class="markdown-note-mode-bar__copy"[\s\S]*?<\/button>/
  )
  assert.ok(button, '模式条应有「复制 Markdown」按钮')
  assert.match(button[0], /@click="copyMarkdown"/, '按钮应复用 copyMarkdown')
  assert.match(button[0], /aria-label="复制 Markdown"/, '按钮要有可读名称')
  assert.match(source, /async function copyMarkdown\(\): Promise<void>/, '功能本体不能被误删')

  // 两个图标按钮共用一份样式：它们都属于「预览态也必须能按」的那类。
  assert.match(
    source,
    /\.markdown-note-mode-bar__outline,\s*\n\.markdown-note-mode-bar__copy \{/,
    '模式条两个图标按钮应共用一份样式块'
  )
})

/* ------------------------------------------------------------------ *
 * 大纲跳转落点：「顶栏遮挡」与「呼吸位」分开算
 * ------------------------------------------------------------------ */

test('大纲跳转落点：遮挡高度实时量，预览态不再沿用编辑态那个常量', () => {
  const source = readSource(EDITOR)

  // 呼吸位与「高亮提前量」是两件事，各自具名，别退化成裸数字。
  assert.match(source, /const OUTLINE_SCROLL_GAP = \d+/, '跳转呼吸位应有具名常量')
  assert.match(source, /const OUTLINE_ACTIVE_LEAD = \d+/, '高亮提前量应有具名常量')

  const inset = source.match(/function getOutlineScrollInset[\s\S]*?\n\}/)
  assert.ok(inset, '遮挡高度应由 getOutlineScrollInset 统一算')
  // 预览层的滚动容器上方**没有任何遮挡** —— 那里必须回 0，否则又会白空出一整个顶栏
  //（用户报的「预览模式也有点距离」就是这么来的）。
  assert.match(inset[0], /if \(previewMode\.value\) return 0/, '预览态没有遮挡，遮挡高度应为 0')
  // 顶栏高度实时量、不写死 48：窄窗口下工具项换行、换主题或字号都会改变它。
  assert.match(inset[0], /\.milkdown-top-bar'\)/, '遮挡高度应取自 Crepe sticky 顶栏')
  assert.match(inset[0], /getBoundingClientRect\(\)\.height/, '顶栏高度要实时量，不能写死')

  const scroll = source.match(/function scrollToOutline[\s\S]*?\n\}/)
  assert.ok(scroll, '滚动落点应集中在 scrollToOutline 里')
  assert.match(scroll[0], /getOutlineScrollInset\(\) \+ OUTLINE_SCROLL_GAP/)
  assert.doesNotMatch(scroll[0], /- 78\b/, '写死的 78 正是预览态空出 78px 的成因，不许回来')

  const active = source.match(/function updateActiveOutline[\s\S]*?\n\}/)
  assert.ok(active, '高亮判定应集中在 updateActiveOutline 里')
  // 阈值必须跟着落点走：写死 86 时落点收到 14px，紧邻的下一个标题会顶替高亮。
  assert.match(active[0], /getOutlineScrollInset\(\) \+ OUTLINE_SCROLL_GAP \+ OUTLINE_ACTIVE_LEAD/)
  assert.doesNotMatch(active[0], /getBoundingClientRect\(\)\.top \+ 86\b/, '高亮阈值不能写死 86')
})
