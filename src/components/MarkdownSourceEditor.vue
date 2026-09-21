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
import DOMPurify from 'dompurify'
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands'
import { HighlightStyle, indentOnInput, syntaxHighlighting } from '@codemirror/language'
import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
import { EditorState, StateEffect, StateField, Transaction } from '@codemirror/state'
import { renderPreviewMarkdown, resolvePreviewImageSource } from '../utils/markdown-preview'
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

interface Props {
  /** 文档标识（外部文件用绝对路径），随 change 事件一并回传。 */
  documentId?: string
  /** 磁盘上的 Markdown 原文。 */
  value?: string
}

interface FindMatches {
  /** 全部匹配区间，按位置升序。 */
  matches: Array<{ from: number, to: number }>
  /** 当前聚焦的匹配项下标。 */
  active: number
}

const props = withDefaults(defineProps<Props>(), { documentId: '', value: '' })

const emit = defineEmits<{
  (event: 'change', value: string, documentId: string): void
}>()

const container = ref<HTMLElement | null>(null)
const previewScroller = ref<HTMLElement | null>(null)
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
 * 预览正文。只读：唯一的数据来源是 props.value，渲染结果不回流到保存链路。
 *
 * 渲染规则（含表格单元格的块级处理）在 `src/utils/markdown-preview.ts`，那里有独立的行为测试。
 *
 * :return: 已清洗的 HTML 字符串。
 */
function resolvePreviewHtml(): string {
  const parsed = new DOMParser().parseFromString(renderPreviewMarkdown(props.value), 'text/html')
  for (const image of parsed.querySelectorAll('img')) {
    const resolved = resolvePreviewImageSource(image.getAttribute('src') ?? '', props.documentId)
    if (resolved) image.setAttribute('src', resolved)
  }
  return DOMPurify.sanitize(parsed.body.innerHTML)
}

const previewHtml = computed(() => (mode.value === 'preview' ? resolvePreviewHtml() : ''))

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

/** 清除查找高亮。 */
function clearFindHighlight(): void {
  view?.dispatch({ effects: setFindMatches.of(null) })
}

/** 当前可见区域的滚动位置，供「切换标签时记住阅读位置」类逻辑复用。 */
function getScrollTop(): number {
  if (mode.value === 'preview') return previewScroller.value?.scrollTop ?? 0
  return view?.scrollDOM.scrollTop ?? 0
}

defineExpose({ clearFindHighlight, findText, getScrollTop })

onMounted(() => {
  if (!container.value) return
  view = new EditorView({ state: createState(props.value), parent: container.value })
})

onBeforeUnmount(() => {
  if (view) {
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
      <span class="markdown-source-editor__hint">{{ modeHint }}</span>
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
      class="markdown-source-editor__preview"
      v-html="previewHtml"
    ></div>
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
  /* 预览用的两块色：面板底（代码块 / 表头 / 行内码）与分隔线（表格 / 引用 / 分割线）。 */
  --source-editor-panel: rgba(240, 245, 252, .72);
  --source-editor-rule: #e2eaf4;
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
  --source-editor-panel: rgba(12, 24, 42, .72);
  --source-editor-rule: #223349;
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

/* 预览区：只读渲染，自己滚动。v-html 的内容也命中这里（本组件样式刻意非 scoped）。 */
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
.markdown-source-editor__preview > *:first-child { margin-top: 0; }
.markdown-source-editor__preview > *:last-child { margin-bottom: 0; }
.markdown-source-editor__preview h1,
.markdown-source-editor__preview h2,
.markdown-source-editor__preview h3,
.markdown-source-editor__preview h4,
.markdown-source-editor__preview h5,
.markdown-source-editor__preview h6 {
  margin: 20px 0 8px;
  color: var(--source-editor-heading);
  font-weight: 700;
  line-height: 1.35;
}
.markdown-source-editor__preview h1 { font-size: 20px; }
.markdown-source-editor__preview h2 { font-size: 17px; }
.markdown-source-editor__preview h3 { font-size: 15px; }
.markdown-source-editor__preview h4,
.markdown-source-editor__preview h5,
.markdown-source-editor__preview h6 { font-size: 13.5px; }
.markdown-source-editor__preview p { margin: 0 0 10px; }
.markdown-source-editor__preview ul,
.markdown-source-editor__preview ol { margin: 0 0 10px; padding-left: 22px; }
.markdown-source-editor__preview li { margin: 3px 0; }
.markdown-source-editor__preview a { color: var(--source-editor-link); text-decoration: none; }
.markdown-source-editor__preview a:hover { text-decoration: underline; }
.markdown-source-editor__preview strong { color: var(--source-editor-strong); }
.markdown-source-editor__preview code {
  padding: 1px 5px;
  border-radius: 4px;
  background: var(--source-editor-panel);
  color: var(--source-editor-code);
  font-family: ui-monospace, "SFMono-Regular", Menlo, monospace;
  font-size: 12px;
}
.markdown-source-editor__preview pre {
  margin: 0 0 12px;
  padding: 12px 14px;
  border: 1px solid var(--source-editor-rule);
  border-radius: 8px;
  background: var(--source-editor-panel);
  overflow-x: auto;
}
.markdown-source-editor__preview pre code { padding: 0; background: none; color: var(--source-editor-text); }
.markdown-source-editor__preview blockquote {
  margin: 0 0 12px;
  padding: 2px 0 2px 12px;
  border-left: 3px solid var(--source-editor-rule);
  color: var(--source-editor-quote);
}
.markdown-source-editor__preview img { max-width: 100%; border-radius: 8px; }
.markdown-source-editor__preview hr { margin: 18px 0; border: 0; border-top: 1px solid var(--source-editor-rule); }
.markdown-source-editor__preview table {
  width: 100%;
  margin: 0 0 12px;
  border-collapse: collapse;
  font-size: 12.5px;
}
.markdown-source-editor__preview th,
.markdown-source-editor__preview td {
  padding: 6px 9px;
  border: 1px solid var(--source-editor-rule);
  text-align: left;
  vertical-align: top;
}
.markdown-source-editor__preview th {
  background: var(--source-editor-panel);
  color: var(--source-editor-heading);
  font-weight: 700;
}

html[data-theme="dark"] .markdown-source-editor__bar { border-color: #223349; color: #6d8098; }
html[data-theme="dark"] .markdown-source-editor__mode { color: #8fa5bd; }
html[data-theme="dark"] .markdown-source-editor__hint { color: #67788d; }
</style>
