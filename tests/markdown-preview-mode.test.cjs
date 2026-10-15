const test = require('node:test')
const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const { resolve } = require('node:path')

const projectRoot = resolve(__dirname, '..')
const readSource = (filePath) => readFileSync(resolve(projectRoot, filePath), 'utf8')

const source = () => readSource('src/components/MarkdownSourceEditor.vue')

/**
 * 外部文件「源码 / 预览」双模式。
 *
 * 不变的底线：预览只读渲染，原文一个字都不经过解析器 —— 保存链路仍必须是
 * 「CodeMirror 文档 → emit('change') → 写回磁盘」这一条，逐字节保真。
 * 预览引入 marked/DOMPurify 只允许出现在渲染方向，绝不能回流到保存方向。
 */
test('外部文件默认落在源码模式，顶部栏提供两个模式按钮', () => {
  const text = source()

  assert.match(text, /const mode = ref<EditorMode>\('source'\)/)
  assert.match(text, /type EditorMode = 'source' \| 'preview'/)
  // 切换按钮成组出现，用 aria-pressed 暴露当前态（与其它工具栏按钮的语义一致）。
  assert.match(text, /markdown-source-editor__modes/)
  assert.match(text, /aria-pressed="mode === 'source'"/)
  assert.match(text, /aria-pressed="mode === 'preview'"/)
})

test('预览只读渲染，且不与保存链路共享任何代码', () => {
  const text = source()

  // 渲染规则（含表格单元格的块级处理）抽到了 utils/markdown-preview，那里有行为测试；
  // 组件这边只负责清洗与图片地址归一。
  assert.match(text, /renderPreviewMarkdown/)
  // 清洗走共用入口（`utils/preview-sanitize`）：协议白名单只留一份，
  // 三处渲染入口各写一遍 `DOMPurify.sanitize` 正是本地图片在预览里断链的成因。
  assert.match(text, /sanitizePreviewHtml\(/)
  assert.match(text, /resolvePreviewImageSource/)

  // 回传正文的地方全项目只该有两处：输入时与卸载兜底。预览不得新增第三处。
  // 注释里也会提到 emit('change')，所以按行过滤掉注释行再计数。
  const emitCalls = text
    .split('\n')
    .filter((line) => line.includes("emit('change'"))
    .filter((line) => !line.trim().startsWith('*') && !line.trim().startsWith('//'))
  assert.equal(emitCalls.length, 2)
  assert.match(text, /emit\('change', update\.state\.doc\.toString\(\), props\.documentId\)/)

  // 预览渲染函数必须与编辑器状态完全隔离，否则「渲染」就有机会改写文档。
  const render = text.match(/function resolvePreviewHtml[\s\S]*?\n\}/)
  assert.ok(render, '预览渲染应集中在 resolvePreviewHtml 里')
  assert.doesNotMatch(render[0], /emit\(|EditorState|Transaction|view\./)
})

test('切到预览不销毁编辑器，滚动位置来回都不丢', () => {
  const text = source()
  const codeBlock = text.match(/class="markdown-source-editor__code"[\s\S]*?<\/div>/)

  assert.ok(codeBlock, 'CodeMirror 容器应保留 .markdown-source-editor__code')
  // 必须用 class 收起而不是 v-if 卸载：销毁会连光标与撤销栈一起丢掉。
  assert.match(codeBlock[0], /:class="\{ 'is-collapsed'/)
  assert.doesNotMatch(codeBlock[0], /v-if/)
  // 预览区反过来是按需挂载的，切回源码时它的 DOM 要能干净退场。
  assert.match(text, /v-if="mode === 'preview'"[\s\S]{0,120}?markdown-source-editor__preview/)

  // 容器从 display:none 恢复后尺寸才量得出来，还原滚动必须等下一帧。
  assert.match(text, /requestAnimationFrame/)
  assert.match(text, /function switchMode/)
})

test('预览里的图片地址重写成渲染层能真正加载的形式', () => {
  const text = source()
  const module = readSource('src/utils/markdown-preview.ts')
  const resolver = module.match(/export function resolvePreviewImageSource[\s\S]*?\n\}/)

  assert.ok(resolver, '图片地址重写应集中在 resolvePreviewImageSource 里')
  // file:///… 不在 DOMPurify 的协议白名单里，会被整条剥掉；相对路径则会指到 dist 目录。
  assert.match(resolver[0], /file:/i)
  assert.match(resolver[0], /documentPath/)
  // 组件必须把当前文件路径传进去，否则相对路径没有基准。
  assert.match(text, /resolvePreviewImageSource\(image\.getAttribute\('src'\) \?\? '', props\.documentId\)/)
  // 具体行为（去协议 / 拼绝对 / 放行网络地址）由 markdown-preview-render.test.cjs 跑真数据验证。
})

test('预览模式下查找先切回源码，再定位匹配项', () => {
  const text = source()
  const find = text.match(/function findText[\s\S]*?\n\}/)

  assert.ok(find)
  // 预览里 CodeMirror 是隐藏的，高亮看不见 —— 先把用户带回源码模式再定位。
  assert.match(find[0], /mode\.value === 'preview'/)
  assert.match(find[0], /switchMode\('source'\)/)
})

test('源码模式解析 GFM：表格、任务列表、删除线都要认', () => {
  const text = source()

  // markdown() 不给 base 时用的是 CommonMark，表格会退化成纯文本，没有语法着色。
  assert.match(text, /markdown\(\{ base: markdownLanguage \}\)/)
  assert.match(text, /markdownLanguage/)
})

test('源码模式：表格行内 Shift+Enter 插入 <br>，表格外仍是普通换行', () => {
  const text = source()

  assert.match(text, /function isInsideTableRow/)
  assert.match(text, /const insertHardBreak: Command/)
  assert.match(text, /insert: '<br>'/)
  // 必须排在 defaultKeymap 之前，否则 Shift+Enter 先被默认换行吃掉。
  assert.match(text, /\{ key: 'Shift-Enter', run: insertHardBreak \},\s*\n\s*\.\.\.defaultKeymap/)
  // 表格外要交回默认行为，不能把全文的 Shift+Enter 都改掉。
  assert.match(text, /if \(!isInsideTableRow\(target\.state\)\) return false/)
})

test('顶部栏文案改为中性模式说明，预览样式仍以组件前缀收口', () => {
  const text = source()

  // 有了预览模式以后，「不做格式重排」这种只描述源码模式的措辞会变成误导。
  assert.doesNotMatch(text, /不做格式重排/)
  assert.match(text, /\.markdown-source-editor__preview\s*\{/)
  // 该组件样式必须保持全局（CodeMirror 的 style-mod 注入在 head 末尾）。
  assert.match(text, /<style>/)
  assert.doesNotMatch(text, /<style scoped>/)
})

test('嵌入卡片预览接线：两处预览都注入了元信息解析器', () => {
  // 外部文件预览：正文里可能带着从笔记复制来的嵌入占位，要靠工作区数据还原卡片信息。
  const sourceEditor = source()
  assert.match(sourceEditor, /function resolveEmbedMeta\(noteId: string\): PreviewEmbedMeta \| null/)
  assert.match(sourceEditor, /renderPreviewMarkdown\(props\.value, \{ resolveEmbedMeta \}\)/)
  assert.match(sourceEditor, /allNotes\?: OfflineNote\[\]/)
  assert.match(sourceEditor, /folders\?: NoteFolder\[\]/)

  // 笔记预览：直接查编辑器已经拿到的 allNotes / folders。
  const visualEditor = readSource('src/components/MarkdownVisualEditor.vue')
  assert.match(visualEditor, /function resolveEmbedMeta\(noteId: string\): PreviewEmbedMeta \| null/)
  assert.match(visualEditor, /renderPreviewMarkdown\(contentValue\.value, \{ resolveEmbedMeta \}\)/)

  // App 得把笔记列表与文件夹一起交给两处预览，否则卡片还原不出文件夹名。
  const app = readSource('src/App.vue')
  assert.match(app, /:all-notes="workspace\.notes"/)
  assert.match(app, /:folders="workspace\.folders"/)
})

test('笔记预览里的嵌入占位卡可点开：事件委托 + 键盘入口', () => {
  const visualEditor = readSource('src/components/MarkdownVisualEditor.vue')

  // 预览正文是 v-html 的死 HTML，卡片挂不上 Vue 事件 —— 只能委托到正文容器上。
  assert.match(visualEditor, /@click="handlePreviewEmbedClick"/)
  assert.match(visualEditor, /@keydown="handlePreviewEmbedKeydown"/)
  assert.match(visualEditor, /closest\('\.markdown-embed-placeholder'\)/)
  assert.match(visualEditor, /getAttribute\('data-note-id'\)/)
  // 与正文里的内部笔记链接同一语义：新标签页打开，不打断当前阅读位置。
  assert.match(visualEditor, /dispatchOpenNote\(noteId, true\)/)
  // `role="button"` 只负责可聚焦，div 不会因回车自己派发 click —— 键盘入口不能少。
  assert.match(visualEditor, /event\.key !== 'Enter' && event\.key !== ' '/)
  // 可点暗示只长在笔记预览上（占位卡样式是两处预览共用的）。
  assert.match(visualEditor, /\.markdown-note-preview__doc \.markdown-embed-placeholder \{/)
  // 静止态可点暗示（箭头）同样只长在笔记预览上 —— 外部文件预览的卡片点了没反应，不给假暗示。
  assert.match(visualEditor, /\.markdown-note-preview__doc \.markdown-embed-placeholder__action \{/)
})

test('外部文件预览保持只读：卡片不开可点口子', () => {
  const sourceEditor = source()

  assert.doesNotMatch(sourceEditor, /markdown-embed-placeholder/)
  assert.doesNotMatch(sourceEditor, /handlePreviewEmbedClick/)
})
