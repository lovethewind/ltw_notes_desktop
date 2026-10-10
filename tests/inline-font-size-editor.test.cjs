/**
 * 行内字号（选中文字字号 / 后续输入字号）——接线与扩展的约束。
 *
 * ## 与 `tests/inline-font-size.test.cjs` 的分工
 *
 * | 文件 | 测什么 | 怎么测 |
 * |---|---|---|
 * | `inline-font-size.test.cjs` | 纯逻辑（span 配对、正则、空白判定） | 真行为断言 |
 * | 本文件 | 接线（`.vue` 下拉、`xynote-font-size.ts` 扩展、`style.css`） | 源码正则 |
 *
 * 这类接线断言每一条都对应一个**静默失效**的坑 —— 没有报错、没有堆栈，
 * 只是「点了没用」。踩过的都在下面注明了。
 *
 * ## 覆盖的语义（2026-09-24 用户定义）
 *
 *  - **有选区** → 给选中的文字单独设字号，写进正文源码（`<span style="font-size:Npx">`）；
 *  - **无选区** → 只改 `storedMarks`，**只影响后续新打的字**，已有正文一个字不动；
 *  - **设回默认值（15px）** → 移除标记，不写 `<span style="font-size:15px">`；
 *  - **没有「整篇缩放」这一档**（af755fc 那套已整体移除）。
 */

const test = require('node:test')
const assert = require('node:assert/strict')
const { existsSync, readFileSync } = require('node:fs')
const { resolve } = require('node:path')

const projectRoot = resolve(__dirname, '..')
const readSource = (filePath) => readFileSync(resolve(projectRoot, filePath), 'utf8')

const EDITOR = 'src/components/MarkdownVisualEditor.vue'
const EXTENSION = 'src/editor/xynote-font-size.ts'
const STYLE = 'src/style.css'

/* ------------------------------------------------------------------ *
 * 1. 下拉的交互：必须 pointerdown，不能 click
 * ------------------------------------------------------------------ */

test('行内字号：下拉选项必须用 pointerdown + preventDefault（否则「无选区设字号」静默失效）', () => {
  const source = readSource(EDITOR)

  // ⚠️ 本轮最大的坑：没有选区时改的是 storedMarks（待用格式），而 storedMarks
  // **一旦编辑器失焦就会被清掉**。click 是「按下 → 抬起」之后才触发的，那时焦点已经
  // 从正文转到按钮上，storedMarks 早已丢失 —— 现象是「选了 20px，打出来还是 15px」，
  // 没有任何报错。Crepe 自己的顶栏（top-bar 的 onPointerDown）就是这么绕开的。
  assert.match(
    source,
    /option\.addEventListener\(\s*'pointerdown',\s*\(event\)\s*=>\s*\{\s*event\.preventDefault\(\)/,
    '下拉选项应在 pointerdown 上 preventDefault，把焦点锁在正文里'
  )
  assert.match(
    source,
    /option\.addEventListener\(\s*'pointerdown'[\s\S]{0,220}?applyInlineFontSize\(size\)/,
    '字号应在 pointerdown 里应用（不能在 click 里）'
  )
  // 触发器同理：点开下拉也不该让正文失焦，否则用户「先设字号再输入」的待用状态就没了。
  assert.match(
    source,
    /toggle\.addEventListener\(\s*'pointerdown',\s*\(event\)\s*=>\s*\{\s*event\.preventDefault\(\)/,
    '触发器也应在 pointerdown 上 preventDefault'
  )
  // 反向断言：不允许把「应用字号」塞进 click。
  assert.doesNotMatch(
    source,
    /addEventListener\(\s*'click',[\s\S]{0,120}?applyInlineFontSize/,
    '应用字号不得挂在 click 上（焦点已丢，storedMarks 必然为空）'
  )
})

test('行内字号：pointerdown 被取消后补发的 click 必须被截住（否则刚打开的菜单立刻被关）', () => {
  const source = readSource(EDITOR)

  // 浏览器在 pointerdown 被 preventDefault 后仍可能补一个 click，它会冒泡到 document，
  // 被既有的 `document.addEventListener('click', closeToolbarMenus)` 捕获
  // —— 于是菜单刚打开就被关掉。所以 trigger/option 都要显式 stopPropagation。
  assert.match(
    source,
    /toggle\.addEventListener\(\s*'click',\s*\(event\)\s*=>\s*event\.stopPropagation\(\)\)/,
    '触发器应截住随后补发的 click，避免 document 的 closeToolbarMenus 立刻关菜单'
  )
  assert.match(
    source,
    /option\.addEventListener\(\s*'click',\s*\(event\)\s*=>\s*event\.stopPropagation\(\)\)/,
    '选项同样要截住 click'
  )
})

/* ------------------------------------------------------------------ *
 * 2. 应用语义：选区写正文、无选区写 storedMarks、默认值移除标记
 * ------------------------------------------------------------------ */

test('行内字号：有选区写正文、无选区只改 storedMarks，且都用「替换」而非「叠加」', () => {
  const source = readSource(EDITOR)
  const apply = source.match(/function applyInlineFontSize[\s\S]*?\n\}/)
  assert.ok(apply, '应能找到 applyInlineFontSize')
  const body = apply[0]

  // 两条分支都必须存在：少了任何一条，需求的一半就不成立。
  assert.match(body, /state\.selection\.empty/, '应有「无选区」判定')
  assert.match(body, /setStoredMarks\(/, '无选区分支应改 storedMarks（只影响后续输入）')
  assert.match(body, /tr\.addMark\(/, '有选区分支应把标记写进文档')
  assert.match(
    body,
    /isBlankText\(selectedText\)/,
    '选区全是空白时也要按「无选区」处理（否则源码里留 <span> </span> 垃圾）'
  )

  // ⚠️ 必须先移除再添加。mark 声明了 `excludes: ''`（为兼容既有嵌套文档），
  // 这让 addToSet 不会顶掉同类型标记 —— 直接 addMark 会越改越嵌套。
  assert.match(
    body,
    /removeFromSet\(base\)[\s\S]{0,200}?addToSet\(/,
    '无选区分支应先 removeFromSet 再 addToSet（替换语义）'
  )
  assert.match(
    body,
    /removeMark\([\s\S]{0,240}?addMark\(/,
    '有选区分支应先 removeMark 再 addMark（替换语义）'
  )

  // 设回默认值 → 移除标记，而不是写 <span style="font-size:15px">。
  assert.match(
    body,
    /isDefault\s*\?\s*next\s*:/,
    '无选区分支：默认值只移除、不添加'
  )
  assert.match(
    body,
    /if \(!isDefault\) \{\s*tr\.addMark\(/,
    '有选区分支：默认值只移除、不添加'
  )
})

test('行内字号：落盘用标准 HTML span，且严格匹配逻辑只有一份', () => {
  const extension = readSource(EXTENSION)

  // markdown 没有行内字号语法，只能落成标准 HTML。
  assert.match(extension, /<span style="font-size:\$\{/, 'stringify 应输出标准 HTML span')
  assert.match(
    extension,
    /match: \(node\) => node\.type === FONT_SIZE_MDAST_TYPE/,
    'parseMarkdown 应认自定义 mdast 类型'
  )
  assert.match(
    extension,
    /state\.withMark\(mark, FONT_SIZE_MDAST_TYPE, undefined, \{ size: mark\.attrs\.size \}\)/,
    'toMarkdown 应经 withMark 带出 size（handler 侧靠它拿回字号）'
  )
  // ⚠️ 识别正则只认「纯 font-size」的 span（宽松匹配会吃掉用户手写的 color:red）。
  // 这条严格规则只允许存在于纯逻辑模块里，扩展必须复用，不得自写一份宽松版。
  assert.match(
    extension,
    /import \{[\s\S]{0,300}?nestFontSizeSpans[\s\S]{0,200}?\} from '\.\.\/utils\/inline-font-size'/,
    '应复用 inline-font-size.ts 的严格实现'
  )
  assert.doesNotMatch(
    extension,
    /=\s*\/\^?<\s*span/i,
    '不得在扩展里自写 span 匹配正则（应复用 inline-font-size.ts 的严格版）'
  )
  // 兜底值也要来自模块常量，别在扩展里再写一个字面量 15。
  assert.doesNotMatch(
    extension,
    /font-size:\s*\$\{[^}]*:\s*15\}/,
    '不应用字面量 15 兜底（应使用 DEFAULT_BODY_FONT_SIZE）'
  )
})

/* ------------------------------------------------------------------ *
 * 3. schema 与插件注册
 * ------------------------------------------------------------------ */

test('行内字号：mark 必须显式 excludes: ""（既有嵌套文档靠它才解析得回来）', () => {
  const extension = readSource(EXTENSION)

  // 实测（prosemirror-model）：excludes 未设 → addToSet 替换同类型；excludes: '' → 共存。
  // 嵌套区间（<span18>a<span22>b</span>c</span> 里的 b）要求共存。
  assert.match(extension, /excludes:\s*''/, "mark 必须显式声明 excludes: ''")
})

test('行内字号：ctx 与 mark 两者都要 use，否则 crepe.create() 直接崩', () => {
  const extension = readSource(EXTENSION)
  const install = extension.match(/export function installFontSizeFeature[\s\S]*?\n\}/)
  assert.ok(install, '应能找到 installFontSizeFeature')

  // ⚠️ $markSchema 返回二元组 [schemaCtx, $Mark]：只 use .mark 会抛
  // `Context "xynoteFontSize" not found` 导致编辑器整体起不来。
  assert.match(install[0], /xynoteFontSizeSchema\.ctx/, '必须 use schema 的 ctx')
  assert.match(install[0], /xynoteFontSizeSchema\.mark/, '必须 use schema 的 mark')
})

test('行内字号：stringify handler 注册进 remarkStringifyOptionsCtx 且走四参签名', () => {
  const extension = readSource(EXTENSION)

  assert.match(
    extension,
    /ctx\.update\(remarkStringifyOptionsCtx/,
    '应把 handler 注册进 remarkStringifyOptionsCtx（官方的 stringify 扩展点）'
  )
  // ⚠️ 两套 API 别混：Milkdown 的 runner 用 state.withMark/state.addNode，
  // remark 的 handler 是 (node, parent, state, info) => string，靠 containerPhrasing 拼接。
  // 混用会报 `state.addNode is not a function`（本轮实测踩到）。
  assert.match(
    extension,
    /function fontSizeStringifyHandler\(node: any, _parent: unknown, state: any, info: any\): string/,
    'handler 必须是 remark 的四参签名并返回字符串'
  )
  assert.match(extension, /state\.containerPhrasing\(/, 'handler 应用 containerPhrasing 处理子节点')
})

/* ------------------------------------------------------------------ *
 * 4. 选区跟随与只读态
 * ------------------------------------------------------------------ */

test('行内字号：触发器跟随选区刷新，且在微任务里读 state（否则永远慢一拍）', () => {
  const source = readSource(EDITOR)

  assert.match(
    source,
    /listener\.selectionUpdated\(/,
    '应订阅 selectionUpdated（storedMarks 只在光标态有效，文档更新事件跟不上）'
  )
  // ⚠️ selectionUpdated 是在 ProseMirror 的 state.apply **内部**同步触发的，
  // 此刻 view.state 还是旧 state —— 直接读会显示上一个位置的字号。
  assert.match(
    source,
    /selectionUpdated\([\s\S]{0,400}?queueMicrotask\(/,
    'selectionUpdated 回调里应在 queueMicrotask 中读取，避开 state 还没换上的时刻'
  )
  assert.match(
    source,
    /function refreshFontSizeMenu\(\)[\s\S]{0,200}?readSelectionFontSize\(\)/,
    'refreshFontSizeMenu 应按当前选区重读字号'
  )
  assert.match(source, /fontSizeMenuValue\.value = readSelectionFontSize\(\)/, '应写回触发器数值')
})

test('行内字号：功能挂在 createEditor 上（漏挂 = 下拉完全没反应）', () => {
  const source = readSource(EDITOR)

  assert.match(
    source,
    /import \{ FONT_SIZE_MARK_NAME, installFontSizeFeature \} from '\.\.\/editor\/xynote-font-size'/,
    '应引入扩展'
  )
  assert.match(source, /crepe\.addFeature\(installFontSizeFeature\)/, '应在 createEditor 里挂上扩展')
  assert.match(source, /heading\.after\(createFontSizeMenu\(\)\)/, '字号下拉应插在「一级标题」选择器之后')
  assert.match(
    source,
    /TOOLBAR_MENU_TOGGLE_SELECTOR\s*=\s*'[^']*\.markdown-font-size-menu__toggle/,
    '字号下拉触发器应纳入统一的菜单开关/定位选择器'
  )
})

test('行内字号：只读/预览态一并禁用（它现在会改文档内容，不再是纯显示参数）', () => {
  const source = readSource(EDITOR)

  const guard = source.match(/querySelectorAll<HTMLButtonElement>\(\s*'\.top-bar-heading-selector button[\s\S]*?'/)
  assert.ok(guard, '应能找到只读态禁用工具栏按钮的守卫')
  // v2 反转：字号下拉会写入 <span style="font-size:…">，只读/预览态必须和别的格式按钮一样禁掉。
  assert.doesNotMatch(
    guard[0],
    /markdown-font-size-menu__toggle/,
    '字号下拉不应再被排除在禁用列表外'
  )
  assert.match(
    source,
    /querySelectorAll<HTMLButtonElement>\('\.markdown-font-size-menu__item'\)/,
    '下拉面板里的选项也要在只读态禁用'
  )
})

/* ------------------------------------------------------------------ *
 * 5. 整篇缩放必须彻底移除（否则两套语义打架）
 * ------------------------------------------------------------------ */

test('行内缩放残留：正文字号不再绑在组件根节点上，也不再写 localStorage', () => {
  const source = readSource(EDITOR)

  assert.doesNotMatch(
    source,
    /'--markdown-body-font-size':/,
    '不应再把字号以行内变量绑到组件根节点（整篇缩放已移除）'
  )
  assert.doesNotMatch(source, /FONT_SCALE_STORAGE_KEY|parseStoredFontScale/, '不应再持久化整篇字号')
  assert.doesNotMatch(source, /fontScaleIndex|bodyFontSize/, '不应再有整篇缩放的档位状态')
  assert.doesNotMatch(source, /editor-font-scale/, '不应再引已删除的 editor-font-scale 模块')
  assert.ok(
    !existsSync(resolve(projectRoot, 'src/utils/editor-font-scale.ts')),
    'src/utils/editor-font-scale.ts 应已删除'
  )
})

test('对位基线：正文与标题仍以 --markdown-body-font-size(15px) 为基准等比换算', () => {
  const css = readSource(STYLE)

  // 整篇缩放移除了，但 15px 这个**基准**还在：标题/表格都靠它 calc 换算，
  // 删掉它标题字号会失去统一基准。
  assert.match(css, /--markdown-body-font-size:\s*15px/, '样式表应保留 15px 兜底值')
  assert.match(
    css,
    /\.ProseMirror\s*\{[^}]*font-size:\s*var\(--markdown-body-font-size\)/,
    '正文应消费该变量（恒为 15px）'
  )
  assert.match(
    css,
    /ProseMirror h1\s*\{[^}]*font-size:\s*calc\(var\(--markdown-body-font-size\)/,
    'h1 字号应随基准等比换算'
  )
  assert.doesNotMatch(css, /ProseMirror h1\s*\{[^}]*font-size:\s*42px/, 'h1 不应保留 Crepe 默认的 42px')
  assert.doesNotMatch(css, /ProseMirror h2\s*\{[^}]*font-size:\s*36px/, 'h2 不应保留 Crepe 默认的 36px')
})

/* ------------------------------------------------------------------ *
 * 6. 下拉外观（09-23 用户截图反馈的坑）
 * ------------------------------------------------------------------ */

test('行内字号：下拉面板样式、打勾标记与触发器特异性都还在', () => {
  const css = readSource(STYLE)
  const source = readSource(EDITOR)

  assert.match(css, /\.markdown-font-size-menu__panel\s*\{/, '应有下拉面板样式')
  assert.match(css, /\.markdown-font-size-menu__item\.active::before\s*\{\s*content:\s*'✓'/, '选中项应打勾')
  assert.match(
    css,
    /\.markdown-font-size-menu__toggle::after\s*\{\s*content:\s*none/,
    '触发器不应显示 data-label 文案'
  )
  // ⚠️ 触发器规则必须比通用 `.top-bar-item` 多一级特异性（用 `>`）。
  // 两者同为 4 类时，声明更靠后的 `.top-bar-item`（flex-direction: column）会胜出，
  // 触发器被压成竖排 —— 09-23 用户截图反馈「菜单有点窄」的根因。
  assert.match(
    css,
    /\.markdown-font-size-menu\s*>\s*\.markdown-font-size-menu__toggle\s*\{[^}]*flex-direction:\s*row/,
    '触发器规则应带 `>` 提升特异性'
  )
  assert.match(
    css,
    /\.markdown-font-size-menu\s*>\s*\.markdown-font-size-menu__toggle\s*\{[^}]*height:\s*34px/,
    '触发器高度应显式声明'
  )

  // ⚠️ 选项文字必须是真实文本节点，不能靠 ::after { content: attr(data-label) }。
  // 伪元素内容不进 textContent —— 读屏与自动化都会读到空字符串（08 月踩过）。
  assert.match(source, /option\.textContent\s*=\s*String\(size\)/, '选项应用真实文本节点渲染数值')
  assert.doesNotMatch(
    css,
    /\.markdown-font-size-menu__item::after\s*\{\s*content:\s*attr\(data-label\)/,
    '选项文字不应靠伪元素渲染'
  )
  // 初始选中态必须在创建选项时设置：菜单创建时尚未插入 DOM，
  // 此时走 syncFontSizeMenu() 查询会落空，用户打开下拉会看到「一项都没打勾」。
  assert.match(
    source,
    /FONT_SCALE_STEPS\.forEach[\s\S]*?option\.classList\.toggle\('active',\s*isActive\)/,
    '初始选中态应在创建选项时直接设好'
  )
})
