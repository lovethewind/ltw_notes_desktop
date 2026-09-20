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
import { markdown } from '@codemirror/lang-markdown'
import { EditorState, StateEffect, StateField, Transaction } from '@codemirror/state'
import {
  Decoration,
  drawSelection,
  dropCursor,
  EditorView,
  highlightActiveLine,
  highlightActiveLineGutter,
  highlightSpecialChars,
  keymap,
  lineNumbers
} from '@codemirror/view'
import { tags } from '@lezer/highlight'
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'

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
let view: EditorView | null = null

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
      markdown(),
      EditorView.lineWrapping,
      EditorState.tabSize.of(2),
      // 这个编辑器同时服务 .md 与 .txt（打开对话框两者都收），所以标签用中性说法。
      EditorView.contentAttributes.of({ 'aria-label': '文件源码', spellcheck: 'false' }),
      keymap.of([...defaultKeymap, ...historyKeymap, indentWithTab]),
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
    scrollIntoView: true
  })
  return { count: matches.length, index }
}

/** 清除查找高亮。 */
function clearFindHighlight(): void {
  view?.dispatch({ effects: setFindMatches.of(null) })
}

/** 当前滚动位置，供「切换标签时记住阅读位置」类逻辑复用。 */
function getScrollTop(): number {
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
    <!-- 明确告诉用户当前不是所见即所得：这里的改动会原样落盘，软件不会重排任何格式。 -->
    <header class="markdown-source-editor__bar">
      <Icon icon="material-symbols:code" />
      <span class="markdown-source-editor__mode">源码模式</span>
      <span class="markdown-source-editor__hint">直接编辑原文，保存时原样写回，不做格式重排</span>
    </header>
    <div ref="container" class="markdown-source-editor__code"></div>
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
.markdown-source-editor__code { min-height: 0; flex: 1; display: flex; }

html[data-theme="dark"] .markdown-source-editor__bar { border-color: #223349; color: #6d8098; }
html[data-theme="dark"] .markdown-source-editor__mode { color: #8fa5bd; }
html[data-theme="dark"] .markdown-source-editor__hint { color: #67788d; }
</style>
