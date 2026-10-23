<script setup lang="ts">
/**
 * 外部 Markdown 文件的源码编辑器（CodeMirror 6）。
 *
 * 为什么外部文件不能用富文本编辑器：Milkdown/Crepe 把正文解析成 AST 再重新序列化，
 * `<br>` 这类无法建模的写法会被整篇抹掉、行内 `*` 会被转义、空单元格会被写成 `<br />`，
 * 结果就是「只改了一个字，整篇表格却被重排」。这里直接编辑 Markdown 原文，
 * 保存时逐字符写回磁盘，格式 100% 保真。
 *
 * 组件自身不写盘，只回传正文：`emit('change', value, documentId)`。
 */
import { Icon } from '@iconify/vue'
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands'
import { HighlightStyle, indentOnInput, syntaxHighlighting } from '@codemirror/language'
import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
import { EditorState, StateEffect, StateField, Transaction } from '@codemirror/state'
import { extractMarkdownOutline, type MarkdownOutlineItem } from '../utils/markdown-outline'
import { renderPreviewMarkdown, resolvePreviewImageSource } from '../utils/markdown-preview'
import type { PreviewEmbedMeta } from '../utils/markdown-preview'
import type { NoteFolder, OfflineNote } from '../types'
import {
  NOTE_EMBED_EXCERPT_LENGTH,
  formatNoteDate,
  stripNoteMarkdown
} from '../utils/note-embed-meta'
import { sanitizePreviewHtml } from '../utils/preview-sanitize'
import {
  Decoration,
  drawSelection,
  dropCursor,
  EditorView,
  highlightActiveLine,
  highlightActiveLineGutter,
  highlightSpecialChars,
  keymap,
  type Command,
  lineNumbers
} from '@codemirror/view'
import { tags } from '@lezer/highlight'
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import PreviewImageBar from './PreviewImageBar.vue'
import PreviewImageViewer from './PreviewImageViewer.vue'
import { usePreviewImageTools } from '../composables/usePreviewImageTools'

interface Props {
  /** 文档标识（外部文件用绝对路径），随 change 事件一并回传。 */
  documentId?: string
  /** 磁盘上的 Markdown 原文。 */
  value?: string
  /**
   * 工作区笔记列表（用到 `id` / `title` / `folderId` / `content` / `updatedAt` / `isDeleted`）。
   *
   * 外部文件本身不属于笔记库，但正文里可能带着从笔记复制来的嵌入卡片占位，
   * 预览时靠它把占位还原成一张看得见的卡片。
   */
  allNotes?: OfflineNote[]
  /** 工作区文件夹列表：把嵌入卡的 `folderId` 还原成文件夹名。 */
  folders?: NoteFolder[]
}

interface FindMatches {
  /** 全部匹配区间，按位置升序。 */
  matches: Array<{ from: number, to: number }>
  /** 当前聚焦的匹配项下标。 */
  active: number
}

const props = withDefaults(defineProps<Props>(), { documentId: '', value: '', allNotes: () => [], folders: () => [] })

const emit = defineEmits<{
  (event: 'change', value: string, documentId: string): void
}>()

const container = ref<HTMLElement | null>(null)
const previewScroller = ref<HTMLElement | null>(null)
/**
 * 预览图片交互（悬停工具条 + 点击全屏）。
 *
 * 与笔记预览共用同一份实现：预览正文是 `v-html` 出来的死 HTML，图片挂不上 Vue 事件，
 * 只能在容器上做事件委托。
 */
const {
  barVisible: imageBarVisible,
  barAnchor: imageBarAnchor,
  canOpenExternal: imageBarCanOpenExternal,
  notice: imageNotice,
  viewerVisible: imageViewerVisible,
  viewerImages: imageViewerImages,
  viewerIndex: imageViewerIndex,
  keepBar: keepImageBar,
  dismissBar: dismissImageBar,
  openViewer: openImageViewer,
  closeViewer: closeImageViewer,
  setViewerIndex: setImageViewerIndex,
  copyImage: copyPreviewImage,
  saveImageAs: savePreviewImageAs,
  openInBrowser: openPreviewImageInBrowser
} = usePreviewImageTools(previewScroller)
let view: EditorView | null = null

type EditorMode = 'source' | 'preview'

/**
 * 当前模式，默认源码。
 *
 * 外部文件的改动会原样写回磁盘，用户第一眼要看到的就是真正落盘的内容；预览只解决「看得懂」，
 * 不承担编辑职责。偏好不持久化：每个文件标签各自独立，打开即回到源码。
 */
const mode = ref<EditorMode>('source')

/** 源码模式下的滚动位置，切去预览再切回来时用它复位（隐藏期间量不到真实位置）。 */
let sourceScrollTop = 0

const setFindMatches = StateEffect.define<FindMatches | null>()

/** 查找高亮：全部匹配项用淡色，当前项用强调色。 */
const findField = StateField.define<FindMatches | null>({
  create: () => null,
  update(value, transaction) {
    for (const effect of transaction.effects) {
      if (effect.is(setFindMatches)) return effect.value
    }
    // 正文一变旧的位置就失效了，直接清空而不是留下错位的高亮。
    return transaction.docChanged ? null : value
  },
  provide: (field) => EditorView.decorations.from(field, (value) => {
    if (!value?.matches.length) return Decoration.none
    return Decoration.set(value.matches.map((match, index) => Decoration.mark({
      class: index === value.active ? 'cm-source-find-active' : 'cm-source-find'
    }).range(match.from, match.to)), true)
  })
})

/**
 * 编辑器外观。颜色全部走 CSS 变量，明暗主题由 `html[data-theme]` 上的变量覆盖决定，
 * 组件因此不需要在主题切换时重建编辑器。
 */
const sourceTheme = EditorView.theme({
  '&': {
    height: '100%',
    backgroundColor: 'var(--source-editor-bg)',
    color: 'var(--source-editor-text)',
    fontSize: '13px'
  },
  '&.cm-focused': { outline: 'none' },
  '.cm-scroller': {
    fontFamily: 'ui-monospace, "SFMono-Regular", Menlo, monospace',
    lineHeight: '1.8'
  },
  '.cm-content': { padding: '18px 0 80px', caretColor: 'var(--source-editor-caret)' },
  '.cm-line': { padding: '0 22px' },
  '.cm-gutters': {
    border: '0',
    borderRight: '1px solid var(--source-editor-gutter-border)',
    backgroundColor: 'var(--source-editor-gutter-bg)',
    color: 'var(--source-editor-gutter-text)'
  },
  '.cm-lineNumbers .cm-gutterElement': { padding: '0 10px 0 14px' },
  '.cm-activeLine': { backgroundColor: 'var(--source-editor-active-line)' },
  '.cm-activeLineGutter': {
    backgroundColor: 'var(--source-editor-active-line)',
    color: 'var(--source-editor-gutter-active-text)'
  },
  '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--source-editor-caret)' },
  '&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection': {
    backgroundColor: 'var(--source-editor-selection)'
  },
  '.cm-source-find': { backgroundColor: 'var(--source-editor-find)' },
  '.cm-source-find-active': { backgroundColor: 'var(--source-editor-find-active)' }
})

/** Markdown 语法着色。`###`、`|` 这类标记用弱色，正文用主色。 */
const sourceHighlight = HighlightStyle.define([
  { tag: tags.heading1, color: 'var(--source-editor-heading)', fontWeight: '700', fontSize: '1.3em' },
  { tag: tags.heading2, color: 'var(--source-editor-heading)', fontWeight: '700', fontSize: '1.18em' },
  { tag: tags.heading3, color: 'var(--source-editor-heading)', fontWeight: '700', fontSize: '1.08em' },
  { tag: [tags.heading4, tags.heading5, tags.heading6], color: 'var(--source-editor-heading)', fontWeight: '700' },
  { tag: tags.strong, fontWeight: '700', color: 'var(--source-editor-strong)' },
  { tag: tags.emphasis, fontStyle: 'italic' },
  { tag: tags.strikethrough, textDecoration: 'line-through' },
  { tag: [tags.link, tags.url], color: 'var(--source-editor-link)' },
  { tag: tags.monospace, color: 'var(--source-editor-code)' },
  { tag: tags.quote, color: 'var(--source-editor-quote)' },
  { tag: tags.list, color: 'var(--source-editor-marker)' },
  // 标记符号（#、>、-、表格竖线、分隔线）统一弱化，避免与正文抢注意力。
  { tag: [tags.processingInstruction, tags.contentSeparator, tags.labelName], color: 'var(--source-editor-marker)' }
])

/**
 * 解析预览里嵌入卡片的展示信息（标题 / 文件夹 / 摘要 / 时间）。
 *
 * 外部文件不属于笔记库，但正文里可能带着从笔记复制来的嵌入卡片占位；
 * 从 props.allNotes 回查，查不到就交给渲染模块退回默认文案。
 *
 * ⚠️ 与笔记预览同口径：摘要是列表里的纯文本预览（库侧只存 `content_prefix`），不是全文。
 *
 * :param noteId: 卡片上的目标键 —— 本机 ID，或（网页端插入的卡片）跨端标识。
 * :return: 卡片展示信息；查不到返回 null。
 */
function resolveEmbedMeta(noteId: string): PreviewEmbedMeta | null {
  // 两个键都要匹配：桌面端插入的卡片带本机 ID，网页端插入的卡片只带服务端主键。
  const note = props.allNotes.find((item) => item.id === noteId || item.serverId === noteId)
  if (!note) return null
  return {
    title: note.title,
    folderName: props.folders.find((folder) => folder.id === note.folderId)?.name ?? '',
    excerpt: stripNoteMarkdown(note.content || '').slice(0, NOTE_EMBED_EXCERPT_LENGTH),
    date: formatNoteDate(note.updatedAt || ''),
    deleted: note.isDeleted
  }
}

/**
 * 预览正文。只读：唯一的数据来源是 props.value，渲染结果不回流到保存链路。
 *
 * 渲染规则（含表格单元格的块级处理）在 `src/utils/markdown-preview.ts`，那里有独立的行为测试。
 *
 * :return: 已清洗的 HTML 字符串。
 */
function resolvePreviewHtml(): string {
  const parsed = new DOMParser().parseFromString(
    renderPreviewMarkdown(props.value, { resolveEmbedMeta }),
    'text/html'
  )
  for (const image of parsed.querySelectorAll('img')) {
    const resolved = resolvePreviewImageSource(image.getAttribute('src') ?? '', props.documentId)
    if (resolved) image.setAttribute('src', resolved)
  }
  // 与笔记预览共用同一份清洗配置：外部文件里若写着 `xinyue-asset://` 地址（从笔记复制来的），
  // src 同样不能被剥掉。
  return sanitizePreviewHtml(parsed.body.innerHTML)
}

const previewHtml = computed(() => (mode.value === 'preview' ? resolvePreviewHtml() : ''))

/**
 * 大纲面板的开关偏好。
 *
 * ⚠️ 与笔记编辑器**共用**同一个键：外部文件与笔记是同一块编辑区里的两种标签，
 * 用户不需要为它们各学一套开关 —— 在笔记里收起大纲，切到文件标签也是收起的。
 */
const OUTLINE_STORAGE_KEY = 'markdown-outline-open'

/** 滚动高亮的提前量（与笔记编辑器同值）：标题顶进入「落点再往下一点」就算当前章节。 */
const OUTLINE_ACTIVE_LEAD = 24

/** 点击大纲项后的落点呼吸位（与笔记编辑器同值）。 */
const OUTLINE_SCROLL_GAP = 14

const outlineOpen = ref(true)
const outlineItems = ref<MarkdownOutlineItem[]>([])
const activeOutlineIndex = ref(0)

/** 复制结果提示，短暂顶替顶栏的模式说明。 */
const copyNotice = ref('')
let copyNoticeTimer: ReturnType<typeof setTimeout> | undefined
let outlineTimer: ReturnType<typeof setTimeout> | undefined

/**
 * 预览层里的标题节点。
 *
 * 口径必须与 `extractMarkdownOutline` 一致：表格单元格（块级渲染）与引用块里的 `h*`
 * 是**渲染产物**，大纲里根本没有它们 —— 不过滤会让下标整体错位。
 *
 * :return: 按文档顺序排列的标题节点。
 */
function previewHeadings(): HTMLElement[] {
  const container = previewScroller.value
  if (!container) return []
  return Array.from(container.querySelectorAll<HTMLElement>('h1, h2, h3, h4, h5, h6'))
    .filter((heading) => !heading.closest('td, th, blockquote, li'))
}

/**
 * 根据当前滚动位置更新高亮的大纲项。
 *
 * 两态各有一条取当前位置的路：预览态量标题 DOM 的矩形；源码态用「视口顶部对应的文档偏移」
 * 反查 —— CodeMirror 里没有标题 DOM，量不到矩形。
 *
 * :return: 无返回值。
 */
function updateActiveOutline(): void {
  if (mode.value === 'preview') {
    const container = previewScroller.value
    const headings = previewHeadings()
    if (!container || !headings.length) return
    const threshold = container.getBoundingClientRect().top + OUTLINE_ACTIVE_LEAD
    let nextIndex = 0
    headings.forEach((heading, index) => {
      if (heading.getBoundingClientRect().top <= threshold) nextIndex = index
    })
    activeOutlineIndex.value = nextIndex
    return
  }
  if (!view || !outlineItems.value.length) return
  const position = view.lineBlockAtHeight(view.scrollDOM.scrollTop + OUTLINE_ACTIVE_LEAD).from
  let nextIndex = 0
  outlineItems.value.forEach((item, index) => {
    if (item.offset <= position) nextIndex = index
  })
  activeOutlineIndex.value = nextIndex
}

/**
 * 滚动到指定大纲项。
 *
 * 源码模式的落点是该标题行的行首，并把光标一并移过去 —— 跳过去就能接着改，
 * 光标位置与看到的滚动位置一致。预览模式是只读的，只滚容器。
 *
 * :param index: 大纲项下标。
 * :param behavior: 滚动行为；点击用 `smooth`。
 * :return: 无返回值。
 */
function scrollToOutline(index: number, behavior: ScrollBehavior = 'smooth'): void {
  const item = outlineItems.value[index]
  if (!item) return
  activeOutlineIndex.value = index
  if (mode.value === 'preview') {
    const container = previewScroller.value
    const heading = previewHeadings()[index]
    if (!container || !heading) return
    const top = heading.getBoundingClientRect().top - container.getBoundingClientRect().top
      + container.scrollTop - OUTLINE_SCROLL_GAP
    container.scrollTo({ top: Math.max(0, top), behavior })
    return
  }
  if (!view) return
  const line = view.state.doc.lineAt(Math.min(item.offset, view.state.doc.length))
  view.dispatch({
    selection: { anchor: line.from },
    effects: EditorView.scrollIntoView(line.from, { y: 'start', yMargin: OUTLINE_SCROLL_GAP })
  })
  view.focus()
}

/** 立即按当前正文重算大纲。 */
function refreshOutline(): void {
  outlineItems.value = extractMarkdownOutline(props.value)
  if (activeOutlineIndex.value >= outlineItems.value.length) activeOutlineIndex.value = 0
  void nextTick(updateActiveOutline)
}

/**
 * 延迟重算大纲。
 *
 * 外部文件可以很大，逐键全量 lex 会挡住输入；防抖口径与笔记编辑器一致。
 */
function scheduleOutline(): void {
  if (outlineTimer) clearTimeout(outlineTimer)
  outlineTimer = setTimeout(() => {
    outlineTimer = undefined
    refreshOutline()
  }, 120)
}

/** 切换大纲面板并保存偏好（与笔记共用同一个键）。 */
function toggleOutline(): void {
  outlineOpen.value = !outlineOpen.value
  localStorage.setItem(OUTLINE_STORAGE_KEY, String(outlineOpen.value))
  if (outlineOpen.value) void nextTick(updateActiveOutline)
}

/** 短暂显示一条顶栏提示。 */
function showCopyNotice(message: string): void {
  copyNotice.value = message
  if (copyNoticeTimer) clearTimeout(copyNoticeTimer)
  copyNoticeTimer = setTimeout(() => {
    copyNoticeTimer = undefined
    copyNotice.value = ''
  }, 1800)
}

/**
 * 把当前文件原文复制到剪贴板。
 *
 * 复制的是磁盘上的那份原文（`props.value`），不经任何解析 —— 与源码编辑器
 * 「逐字符写回」的保真口径一致。
 *
 * :return: 异步操作完成后无返回值。
 */
async function copyMarkdown(): Promise<void> {
  try {
    await navigator.clipboard.writeText(props.value)
    showCopyNotice('Markdown 已复制')
  } catch {
    showCopyNotice('复制失败，请检查剪贴板权限')
  }
}

/**
 * 切换源码 / 预览。
 *
 * :param next: 目标模式。
 * :return: 无返回值。
 */
function switchMode(next: EditorMode): void {
  if (next === mode.value) return
  if (next === 'preview') {
    // 编辑器只是被收起，不销毁：光标、选区与撤销栈都留在原处。
    sourceScrollTop = view?.scrollDOM.scrollTop ?? 0
    mode.value = 'preview'
    return
  }
  mode.value = 'source'
  // 容器刚从 display:none 恢复，尺寸要等下一帧才量得出来，那时设滚动位置才生效。
  void nextTick(() => {
    requestAnimationFrame(() => {
      if (view) view.scrollDOM.scrollTop = sourceScrollTop
    })
  })
}

/** 顶部栏说明：只描述当前模式在做什么，不暗示「文件只能这样打开」。 */
const modeHint = computed(() => (mode.value === 'preview'
  ? '只读渲染，仅用于查看，不会改动文件'
  : '直接编辑原文，保存时原样写回'))

/**
 * 光标是否落在表格行里。
 *
 * 表格行按物理行切分，单元格内不存在「行尾」概念 —— 想在一格里换行，只有写 `<br>` 一条路
 * （行尾两空格、直接回车都会把表格拆成两行）。所以这一行里给 `Shift+Enter` 一个专用语义。
 */
function isInsideTableRow(state: EditorState): boolean {
  const line = state.doc.lineAt(state.selection.main.head)
  return line.text.trimStart().startsWith('|')
}

/**
 * 在光标处插入 `<br>`。
 *
 * 只在表格行内接管，其余位置返回 false 交回默认行为 —— 普通段落里 `Shift+Enter`
 * 仍是换行（CommonMark 里那也是硬换行，用户不会觉得别扭）。
 */
const insertHardBreak: Command = (target) => {
  if (!isInsideTableRow(target.state)) return false
  const position = target.state.selection.main.head
  target.dispatch(target.state.update({
    changes: { from: position, insert: '<br>' },
    selection: { anchor: position + 4 },
    scrollIntoView: true,
    userEvent: 'input'
  }))
  return true
}

/** 按正文内容创建一个全新的编辑器状态（含独立的撤销栈）。 */
function createState(doc: string): EditorState {
  return EditorState.create({
    doc,
    extensions: [
      lineNumbers(),
      highlightActiveLine(),
      highlightActiveLineGutter(),
      highlightSpecialChars(),
      history(),
      drawSelection(),
      dropCursor(),
      indentOnInput(),
      syntaxHighlighting(sourceHighlight),
      // 用 GFM 而非默认的 CommonMark：外部文件里表格、任务列表、删除线很常见，
      // CommonMark 下它们不进语法树，表格会整段退化成纯文本、连竖线都不着色。
      markdown({ base: markdownLanguage }),
      EditorView.lineWrapping,
      EditorState.tabSize.of(2),
      // 这个编辑器同时服务 .md 与 .txt（打开对话框两者都收），所以标签用中性说法。
      EditorView.contentAttributes.of({ 'aria-label': '文件源码', spellcheck: 'false' }),
      // 放在 defaultKeymap 之前：Shift+Enter 默认是换行，这里在表格行内抢先接管。
      keymap.of([
        { key: 'Shift-Enter', run: insertHardBreak },
        ...defaultKeymap,
        ...historyKeymap,
        indentWithTab
      ]),
      EditorView.updateListener.of((update) => {
        if (!update.docChanged) return
        emit('change', update.state.doc.toString(), props.documentId)
      }),
      findField,
      sourceTheme
    ]
  })
}

/** 收集关键词在正文中的全部匹配位置（大小写不敏感，与笔记内查找保持一致）。 */
function collectMatches(keyword: string): Array<{ from: number, to: number }> {
  if (!view || !keyword) return []
  const haystack = view.state.doc.toString().toLocaleLowerCase()
  const needle = keyword.toLocaleLowerCase()
  const matches: Array<{ from: number, to: number }> = []
  let offset = haystack.indexOf(needle)
  while (offset >= 0) {
    matches.push({ from: offset, to: offset + needle.length })
    offset = haystack.indexOf(needle, offset + needle.length)
  }
  return matches
}

/**
 * 在正文中查找并选中指定匹配项。
 *
 * :param keyword: 查找关键词。
 * :param requestedIndex: 希望定位的匹配索引，可超出范围以支持循环。
 * :return: 实际匹配数量和当前索引。
 */
function findText(keyword: string, requestedIndex: number): { count: number, index: number } {
  if (!view) return { count: 0, index: -1 }
  // 预览模式下 CodeMirror 是收起的，匹配高亮看不见 —— 先把用户带回源码模式再定位。
  const returnedFromPreview = mode.value === 'preview'
  if (returnedFromPreview) switchMode('source')
  const matches = collectMatches(keyword.trim())
  if (!matches.length) {
    view.dispatch({ effects: setFindMatches.of(null) })
    return { count: 0, index: -1 }
  }
  const index = ((requestedIndex % matches.length) + matches.length) % matches.length
  const match = matches[index]
  view.dispatch({
    effects: setFindMatches.of({ matches, active: index }),
    selection: { anchor: match.from, head: match.to },
    // 刚切回来时容器还没量出尺寸，这一帧的滚动定位会落空，留给下面补一次。
    scrollIntoView: !returnedFromPreview
  })
  if (returnedFromPreview) {
    void nextTick(() => {
      requestAnimationFrame(() => {
        view?.dispatch({ selection: { anchor: match.from, head: match.to }, scrollIntoView: true })
      })
    })
  }
  return { count: matches.length, index }
}

/**
 * 把当前匹配或全部匹配替换成新文本（笔记内查找替换用）。
 *
 * 与 findText 同一套匹配口径（大小写不敏感、不解析正则）。替换文本原样写入，
 * 不做转义也不做 Markdown 解析 —— 外部文件是「用户写什么就该是什么」。
 *
 * :param keyword: 查找关键词。
 * :param replacement: 替换文本；空串等于删除匹配内容。
 * :param options: `all` 为真时替换全部匹配。
 * :return: 实际替换数量、替换后剩余匹配数与当前高亮索引。
 */
function replaceText(
  keyword: string,
  replacement: string,
  options: { all?: boolean } = {}
): { replaced: number, count: number, index: number } {
  if (!view) return { replaced: 0, count: 0, index: -1 }
  // 预览态下 CodeMirror 是收起的，替换后既看不见结果也保持不住高亮。
  const returnedFromPreview = mode.value === 'preview'
  if (returnedFromPreview) switchMode('source')
  const matches = collectMatches(keyword.trim())
  if (!matches.length) {
    view.dispatch({ effects: setFindMatches.of(null) })
    return { replaced: 0, count: 0, index: -1 }
  }
  if (options.all) {
    // 多个 changes 交给 CodeMirror 自己按位置应用，整体只算一次撤销。
    // 正文一变 findField 就会清空高亮（它的 update 里判 docChanged），不用再补 effect。
    view.dispatch({
      changes: matches.map((match) => ({ from: match.from, to: match.to, insert: replacement }))
    })
    return { replaced: matches.length, count: 0, index: -1 }
  }
  // 单次：改当前高亮那一条；高亮失效（比如刚编辑过）就退回第一条。
  const activeIndex = view.state.field(findField)?.active ?? -1
  const target = matches[activeIndex] ?? matches[0]
  view.dispatch({ changes: { from: target.from, to: target.to, insert: replacement } })
  // 替换挪动了其后所有匹配的位置，重新收集才能定位下一个。
  const remaining = collectMatches(keyword.trim())
  if (!remaining.length) {
    view.dispatch({ effects: setFindMatches.of(null) })
    return { replaced: 1, count: 0, index: -1 }
  }
  const index = Math.max(
    0,
    remaining.findIndex((match) => match.from >= target.from + replacement.length)
  )
  const next = remaining[index]
  view.dispatch({
    effects: setFindMatches.of({ matches: remaining, active: index }),
    selection: { anchor: next.from, head: next.to },
    scrollIntoView: !returnedFromPreview
  })
  if (returnedFromPreview) {
    void nextTick(() => {
      requestAnimationFrame(() => {
        view?.dispatch({ selection: { anchor: next.from, head: next.to }, scrollIntoView: true })
      })
    })
  }
  return { replaced: 1, count: remaining.length, index }
}

/** 清除查找高亮。 */
function clearFindHighlight(): void {
  view?.dispatch({ effects: setFindMatches.of(null) })
}

/** 当前可见区域的滚动位置，供「切换标签时记住阅读位置」类逻辑复用。 */
function getScrollTop(): number {
  if (mode.value === 'preview') return previewScroller.value?.scrollTop ?? 0
  return view?.scrollDOM.scrollTop ?? 0
}

/**
 * 在光标处原样插入一段 Markdown（AI 回答落地用）。
 *
 * ⚠️ 外部文件是「保真优先」：这里**不做任何自动排版** —— 不补换行、不重新折行、
 * 不动其余行，插进去的就是传入的字符串。想让内容独立成段由用户自己先按回车决定。
 *
 * :param markdown: 待插入的 Markdown 源码。
 * :return: 是否插入成功，以及给用户看的结果文案。
 */
function insertMarkdown(markdown: string): { ok: boolean, message: string } {
  const text = String(markdown || '').trim()
  if (!text) return { ok: false, message: '没有可插入的内容' }
  if (!view) return { ok: false, message: '编辑器还没准备好' }
  // 预览模式下 CodeMirror 是收起的，先回源码模式才看得到插入结果（与 findText 一致）。
  if (mode.value === 'preview') switchMode('source')
  const position = view.state.selection.main.head
  view.dispatch({
    changes: { from: position, insert: text },
    selection: { anchor: position + text.length },
    scrollIntoView: true
  })
  view.focus()
  return { ok: true, message: '已插入到当前文件' }
}

defineExpose({ clearFindHighlight, findText, getScrollTop, insertMarkdown, replaceText })

onMounted(() => {
  if (!container.value) return
  view = new EditorView({ state: createState(props.value), parent: container.value })
  // CodeMirror 自己滚（scroll 事件不冒泡，挂不到模板上），滚动时同步大纲高亮。
  view.scrollDOM.addEventListener('scroll', updateActiveOutline, { passive: true })
  outlineOpen.value = localStorage.getItem(OUTLINE_STORAGE_KEY) !== 'false'
  refreshOutline()
})

onBeforeUnmount(() => {
  if (outlineTimer) clearTimeout(outlineTimer)
  if (copyNoticeTimer) clearTimeout(copyNoticeTimer)
  if (view) {
    view.scrollDOM.removeEventListener('scroll', updateActiveOutline)
    // 每次输入都已经回传，这里只是兜底：万一有尚未上抛的字，切标签时不能丢。
    const latest = view.state.doc.toString()
    if (latest !== props.value) emit('change', latest, props.documentId)
    view.destroy()
    view = null
  }
})

watch(
  () => props.value,
  (value) => {
    // 正文一变，大纲就过期了；大文件全量 lex 会挡输入，所以放在防抖里。
    scheduleOutline()
    if (!view) return
    const current = view.state.doc.toString()
    if (value === current) return
    // 外部替换正文（罕见）不进撤销栈，否则用户按撤销会跳回另一份内容。
    view.dispatch({
      changes: { from: 0, to: current.length, insert: value },
      annotations: Transaction.addToHistory.of(false)
    })
  }
)
</script>

<template>
  <section class="markdown-source-editor">
    <header class="markdown-source-editor__bar">
      <Icon :icon="mode === 'preview' ? 'material-symbols:visibility-outline' : 'material-symbols:code'" />
      <span class="markdown-source-editor__mode">{{ mode === 'preview' ? '预览模式' : '源码模式' }}</span>
      <span class="markdown-source-editor__hint">{{ copyNotice || modeHint }}</span>
      <!--
        大纲开关与「复制 Markdown」放在这条模式条上 —— 与笔记编辑器完全同构。
        两者都是「只读正文」的操作，源码态与预览态都该按得到，所以不放 App 的文件标题栏。
      -->
      <!--
        开关与侧栏必须是两个类名：曾经共用一个 `markdown-source-editor__outline`，
        结果按钮吃到了侧栏的 `flex: 0 0 270px`（被撑成宽条），
        侧栏反过来吃到按钮的 `width/height: 26px`（塌成一个小方块）。见下方样式注释。
      -->
      <button
        type="button"
        class="markdown-source-editor__outline-toggle"
        :class="{ 'is-active': outlineOpen }"
        :aria-pressed="outlineOpen"
        aria-controls="source-editor-outline-panel"
        :aria-label="outlineOpen ? '收起大纲' : '展开大纲'"
        :title="outlineOpen ? '收起大纲' : '展开大纲'"
        @click="toggleOutline"
      >
        <Icon icon="material-symbols:toc-rounded" />
      </button>
      <button
        type="button"
        class="markdown-source-editor__copy"
        aria-label="复制 Markdown"
        title="复制 Markdown"
        @click="copyMarkdown"
      >
        <Icon icon="material-symbols:content-copy-outline-rounded" />
      </button>
      <!--
        两种模式看的是同一份正文：源码模式负责写盘，预览只读渲染。
        来回切换不会改动文件，所以这里不需要「放弃/应用」之类的确认。
      -->
      <div class="markdown-source-editor__modes" role="group" aria-label="显示模式">
        <button
          type="button"
          class="markdown-source-editor__mode-button"
          :class="{ 'is-active': mode === 'source' }"
          :aria-pressed="mode === 'source'"
          @click="switchMode('source')"
        >
          源码
        </button>
        <button
          type="button"
          class="markdown-source-editor__mode-button"
          :class="{ 'is-active': mode === 'preview' }"
          :aria-pressed="mode === 'preview'"
          @click="switchMode('preview')"
        >
          预览
        </button>
      </div>
    </header>
    <!--
      正文区：源码 / 预览 + 大纲侧栏并排。模式条在上方横跨整宽，
      与笔记编辑器的网格同构 —— 顶部只有一条横线，侧栏从模式条下沿才开始。
    -->
    <div class="markdown-source-editor__body">
      <!-- 切去预览时只是收起，不卸载：销毁会连光标、选区与撤销栈一起丢掉。 -->
      <div
        ref="container"
        class="markdown-source-editor__code"
        :class="{ 'is-collapsed': mode === 'preview' }"
      ></div>
      <!-- 预览只读渲染，数据只从 props.value 来，不回流保存链路。 -->
      <div
        v-if="mode === 'preview'"
        ref="previewScroller"
        class="markdown-source-editor__preview markdown-rendered-doc"
        @scroll.passive="updateActiveOutline"
        v-html="previewHtml"
      ></div>
      <!--
        大纲侧栏直接复用笔记侧栏那套全局样式（`.markdown-outline*`，见 src/style.css），
        外观与笔记一致，不在组件里再写一份 —— 宽度由 `.markdown-source-editor` 给。
      -->
      <aside
        v-if="outlineOpen"
        id="source-editor-outline-panel"
        class="markdown-outline markdown-source-editor__outline-panel"
        aria-label="文件大纲"
      >
        <header class="markdown-outline__header">
          <span class="markdown-outline__title">大纲</span>
          <button type="button" class="markdown-outline__close" aria-label="关闭大纲" @click="toggleOutline">
            <Icon icon="material-symbols:close-rounded" />
          </button>
        </header>
        <div class="markdown-outline__body">
          <nav v-if="outlineItems.length" class="markdown-outline__list" aria-label="文档标题">
            <button
              v-for="item in outlineItems"
              :key="`${item.index}-${item.text}`"
              type="button"
              class="markdown-outline-item"
              :class="{ 'is-active': item.index === activeOutlineIndex }"
              :style="{ '--outline-level': item.level }"
              @click="scrollToOutline(item.index)"
            >
              {{ item.text }}
            </button>
          </nav>
          <p v-else class="markdown-outline__empty">暂无大纲</p>
        </div>
      </aside>
    </div>
    <!-- 图片交互的两个浮层自己会传送到 body，挂在这里只是为了随预览态一起装卸。 -->
    <PreviewImageBar
      v-if="imageBarVisible"
      :anchor="imageBarAnchor"
      :can-open-external="imageBarCanOpenExternal"
      :notice="imageNotice"
      @keep="keepImageBar"
      @dismiss="dismissImageBar"
      @open="openImageViewer"
      @copy="copyPreviewImage"
      @save="savePreviewImageAs"
      @external="openPreviewImageInBrowser"
    />
    <PreviewImageViewer
      v-if="imageViewerVisible"
      :images="imageViewerImages"
      :index="imageViewerIndex"
      @close="closeImageViewer"
      @update:index="setImageViewerIndex"
    />
  </section>
</template>

<!--
  刻意不加 scoped：CodeMirror 的着色与外观类由 style-mod 注入到 head 末尾，
  需要在同一层全局作用域里声明这套 CSS 变量才能被 var() 解析到。
  所有选择器都以 .markdown-source-editor 开头，不会外溢到其它界面。
-->
<style>
.markdown-source-editor {
  --source-editor-bg: rgba(248, 251, 255, .34);
  --source-editor-text: #283950;
  --source-editor-caret: #2f80ed;
  --source-editor-selection: rgba(47, 128, 237, .22);
  --source-editor-active-line: rgba(47, 128, 237, .055);
  --source-editor-gutter-bg: rgba(240, 245, 252, .72);
  --source-editor-gutter-border: #e2eaf4;
  --source-editor-gutter-text: #a5b2c4;
  --source-editor-gutter-active-text: #4a7fc1;
  --source-editor-heading: #1d3f6e;
  --source-editor-strong: #17263c;
  --source-editor-link: #2268c7;
  --source-editor-code: #bd3d63;
  --source-editor-quote: #63738a;
  --source-editor-marker: #93a3b8;
  --source-editor-find: rgba(255, 205, 92, .42);
  --source-editor-find-active: rgba(255, 158, 44, .62);
  /* 大纲侧栏宽度：与笔记侧栏同档（1600px 以上一起放宽到 300px）。 */
  --source-editor-outline-width: 270px;
  min-width: 0;
  min-height: 0;
  display: flex;
  flex: 1;
  flex-direction: column;
  overflow: hidden;
}

html[data-theme="dark"] .markdown-source-editor {
  --source-editor-bg: rgba(9, 18, 33, .34);
  --source-editor-text: #d9e6f6;
  --source-editor-caret: #8dbdf8;
  --source-editor-selection: rgba(90, 154, 235, .34);
  --source-editor-active-line: rgba(120, 168, 235, .09);
  --source-editor-gutter-bg: rgba(12, 24, 42, .72);
  --source-editor-gutter-border: #223349;
  --source-editor-gutter-text: #55677e;
  --source-editor-gutter-active-text: #9dc3f2;
  --source-editor-heading: #a9cdf7;
  --source-editor-strong: #eef5ff;
  --source-editor-link: #7fb2f0;
  --source-editor-code: #f0a2bd;
  --source-editor-quote: #93a7bf;
  --source-editor-marker: #6b7f97;
  --source-editor-find: rgba(214, 168, 62, .38);
  --source-editor-find-active: rgba(244, 152, 42, .55);
}

.markdown-source-editor__bar {
  height: 35px;
  flex: 0 0 35px;
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 0 16px;
  border-bottom: 1px solid var(--line);
  color: #99a4b3;
  font-size: 9px;
  font-weight: 800;
  letter-spacing: .1em;
}

.markdown-source-editor__bar svg { font-size: 15px; }
.markdown-source-editor__mode { color: #6f8299; letter-spacing: .12em; }
.markdown-source-editor__hint { min-width: 0; flex: 1; overflow: hidden; color: #a9b5c5; font-weight: 500; letter-spacing: 0; text-overflow: ellipsis; white-space: nowrap; }

/* 模式条上的两个图标按钮（大纲开关 / 复制 Markdown）—— 与笔记模式条同一套外观。
   合并成多行选择器后，靠正则锚「单行选择器」的断言会静默失效，所以这里改用类名断言守卫。
   ⚠️ 这里只写按钮：侧栏是 `.markdown-source-editor__outline-panel`，两者绝不能共用一个类名。 */
.markdown-source-editor__outline-toggle,
.markdown-source-editor__copy {
  flex: 0 0 auto;
  width: 26px;
  height: 26px;
  display: grid;
  place-items: center;
  margin-right: 2px;
  border: 0;
  border-radius: 7px;
  background: none;
  color: #7d8b9e;
  cursor: pointer;
}
.markdown-source-editor__outline-toggle:hover,
.markdown-source-editor__copy:hover { background: rgba(47, 128, 237, .09); color: #4a7fc1; }
.markdown-source-editor__outline-toggle.is-active { background: rgba(47, 128, 237, .13); color: #2268c7; }

/* 正文区：源码 / 预览与大纲侧栏并排；模式条在上方横跨整宽，与笔记的网格同构。 */
.markdown-source-editor__body { min-height: 0; flex: 1; display: flex; }
/* 只有侧栏吃宽度；写成 `__outline` 会把模式条上的按钮一起撑成 270px 宽。 */
.markdown-source-editor__outline-panel { flex: 0 0 var(--source-editor-outline-width); }

/* 窄窗口下全局样式会把 .markdown-outline 变成浮层（见 src/style.css），
   落点得改到模式条正下方，否则会盖住顶栏。 */
@media (max-width: 1180px) { .markdown-source-editor .markdown-outline { top: 35px; } }
@media (min-width: 1600px) { .markdown-source-editor { --source-editor-outline-width: 300px; } }

.markdown-source-editor__code { min-height: 0; flex: 1; display: flex; }
/* 切去预览时收起编辑器。用 display 而不是卸载：光标、选区、撤销栈都留在原处。 */
.markdown-source-editor__code.is-collapsed { display: none; }

/* 模式切换：按钮组固定在右侧，中间的说明文字先让位（窄窗口下按钮始终可点）。 */
.markdown-source-editor__modes {
  flex: 0 0 auto;
  display: flex;
  gap: 2px;
  padding: 2px;
  border-radius: 7px;
  background: rgba(47, 128, 237, .07);
}
.markdown-source-editor__mode-button {
  padding: 3px 9px;
  border: 0;
  border-radius: 5px;
  background: none;
  color: #7d8b9e;
  font-family: inherit;
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0;
  cursor: pointer;
}
.markdown-source-editor__mode-button:hover { color: #4a7fc1; }
.markdown-source-editor__mode-button.is-active { background: #fff; color: #2268c7; }
html[data-theme="dark"] .markdown-source-editor__modes { background: rgba(120, 168, 235, .12); }
html[data-theme="dark"] .markdown-source-editor__mode-button { color: #8496ad; }
html[data-theme="dark"] .markdown-source-editor__mode-button:hover { color: #9dc3f2; }
html[data-theme="dark"] .markdown-source-editor__mode-button.is-active { background: #1b2b42; color: #a9cdf7; }
html[data-theme="dark"] .markdown-source-editor__outline-toggle,
html[data-theme="dark"] .markdown-source-editor__copy { color: #8496ad; }
html[data-theme="dark"] .markdown-source-editor__outline-toggle:hover,
html[data-theme="dark"] .markdown-source-editor__copy:hover { background: rgba(120, 168, 235, .14); color: #9dc3f2; }
html[data-theme="dark"] .markdown-source-editor__outline-toggle.is-active { background: rgba(120, 168, 235, .2); color: #a9cdf7; }

/* 预览区：只读渲染，自己滚动。
   文档元素本身的排版在 style.css 的 `.markdown-rendered-doc`（与笔记预览共用一份），
   这里只负责容器：尺寸、内边距、底色与滚动。 */
.markdown-source-editor__preview {
  min-height: 0;
  flex: 1;
  overflow: auto;
  padding: 22px 26px 80px;
  background: var(--source-editor-bg);
  color: var(--source-editor-text);
  font-size: 13.5px;
  line-height: 1.75;
  word-break: break-word;
}
/* 图片可点击进全屏（交互挂在容器的事件委托上），光标要给出提示。 */
.markdown-source-editor__preview img { cursor: zoom-in; }

html[data-theme="dark"] .markdown-source-editor__bar { border-color: #223349; color: #6d8098; }
html[data-theme="dark"] .markdown-source-editor__mode { color: #8fa5bd; }
html[data-theme="dark"] .markdown-source-editor__hint { color: #67788d; }
</style>
