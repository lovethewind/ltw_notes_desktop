<template>
  <div
    class="milkdown-editor-shell"
    :class="{
      'has-outline': props.showOutline && outlineOpen,
      'is-preview': previewMode,
      'is-readonly': props.readonly,
      'is-focus-mode': focusMode,
      'is-toolbar-hidden': !props.showToolbar
    }"
  >
    <Transition name="editor-feedback">
      <div v-if="feedbackText" class="editor-feedback" role="status">{{ feedbackText }}</div>
    </Transition>
    <Teleport to="body">
      <div
        v-if="imageContextMenu.visible"
        ref="imageContextMenuElement"
        class="resource-context-menu image-context-menu"
        role="menu"
        aria-label="图片操作"
        :style="{ left: `${imageContextMenu.x}px`, top: `${imageContextMenu.y}px` }"
        @pointerdown.stop
      >
        <button type="button" role="menuitem" @click="copyImageAddress">
          <Icon icon="tabler:link" />复制图片地址
        </button>
      </div>
    </Teleport>
    <input
      ref="attachmentInputRef"
      class="attachment-file-input"
      type="file"
      @change="handleAttachmentSelection"
    >
    <div ref="editorScrollRef" class="milkdown-editor-scroll" @scroll.passive="handleEditorScroll">
      <div ref="editorRootRef" class="milkdown-editor-root" />
    </div>
    <aside
      v-if="props.showOutline && outlineOpen"
      id="markdown-outline-panel"
      class="markdown-outline"
      aria-label="Markdown 大纲"
    >
      <header class="markdown-outline__header">
        <h2>大纲</h2>
        <button type="button" class="markdown-outline__close" aria-label="关闭大纲" @click="toggleOutline">
          <Icon icon="material-symbols:close-rounded" />
        </button>
      </header>
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
      <section class="markdown-backlinks-section">
        <button type="button" class="markdown-backlinks-section__toggle" @click="toggleBacklinks">
          <Icon icon="material-symbols:link-rounded" />
          <span>反向链接{{ backlinksOpen ? '' : ' · 点击展开' }}</span>
        </button>
        <BacklinksPanel v-if="backlinksOpen" :note-id="props.documentId" />
      </section>
      <section class="markdown-backlinks-section">
        <button type="button" class="markdown-backlinks-section__toggle" @click="toggleNoteGraph">
          <Icon icon="material-symbols:hub-rounded" />
          <span>关系图谱{{ noteGraphOpen ? '' : ' · 点击展开' }}</span>
        </button>
        <NoteGraphPanel v-if="noteGraphOpen" :note-id="props.documentId" />
      </section>
    </aside>
    <NoteLinkPicker
      :visible="noteLinkPickerVisible"
      @close="noteLinkPickerVisible = false"
      @select="insertNoteLink"
    />
    <LinkSuggestPopover
      :visible="linkSuggestVisible"
      :coords="linkSuggestCoords"
      :items="linkSuggestItems"
      :active-index="linkSuggestIndex"
      @hover="linkSuggestHover"
      @select="insertNoteLinkFromPos"
    />
  </div>
</template>

<script setup lang="ts">
import '@milkdown/crepe/theme/common/style.css'
import '@milkdown/crepe/theme/classic.css'
import { EditorView } from '@codemirror/view'
import { Crepe } from '@milkdown/crepe'
import { commandsCtx, editorViewCtx } from '@milkdown/kit/core'
import { historyProviderPlugin, redoCommand, undoCommand } from '@milkdown/kit/plugin/history'
import { redoDepth, undoDepth } from '@milkdown/kit/prose/history'
import type { Node as ProseMirrorNode } from '@milkdown/kit/prose/model'
import { paragraphSchema } from '@milkdown/kit/preset/commonmark'
import { TextSelection } from '@milkdown/kit/prose/state'
import { Decoration, DecorationSet } from '@milkdown/kit/prose/view'
import { replaceAll } from '@milkdown/kit/utils'
import { Icon } from '@iconify/vue'
import { defineAsyncComponent, h, nextTick, onBeforeUnmount, onMounted, ref, render, watch } from 'vue'
import { extractMarkdownOutline, type MarkdownOutlineItem } from '../utils/markdown-outline'
import { formatJsonCode } from '../utils/json-code-formatter.js'
import type { OfflineNote } from '../types'
import NoteLinkPicker from './NoteLinkPicker.vue'
import BacklinksPanel from './BacklinksPanel.vue'
import LinkSuggestPopover from './LinkSuggestPopover.vue'

// 关系图谱仅在展开时用到 d3-force，改为异步组件避免把布局库打进主 chunk。
const NoteGraphPanel = defineAsyncComponent(() => import('./NoteGraphPanel.vue'))

interface Props {
  value: string
  documentId?: string
  readonly?: boolean
  showToolbar?: boolean
  showOutline?: boolean
  scrollTop?: number
}

interface OutlineCacheEntry {
  markdown: string
  items: MarkdownOutlineItem[]
}

interface ToolbarActionItem {
  action: () => void | Promise<void>
  icon: string
  label: string
  previewAllowed?: boolean
}

interface ToolbarMenuOptions {
  className?: string
  icon: string
  key: string
  label: string
}

const props = withDefaults(defineProps<Props>(), {
  documentId: '',
  readonly: false,
  showToolbar: true,
  showOutline: true,
  scrollTop: 0
})
const emit = defineEmits<{
  (event: 'change', value: string, documentId: string): void
  (event: 'scroll-position-change', scrollTop: number, documentId: string): void
}>()

const editorRootRef = ref<HTMLDivElement | null>(null)
const editorScrollRef = ref<HTMLDivElement | null>(null)
const attachmentInputRef = ref<HTMLInputElement | null>(null)
const noteLinkPickerVisible = ref(false)
const backlinksOpen = ref(false)
const noteGraphOpen = ref(false)
const linkSuggestVisible = ref(false)
const linkSuggestItems = ref<OfflineNote[]>([])
const linkSuggestIndex = ref(0)
const linkSuggestQuery = ref('')
const linkSuggestCoords = ref<{ left: number, top: number, bottom: number }>({ left: 0, top: 0, bottom: 0 })
const linkSuggestStart = ref<number | null>(null)
let linkSuggestTimer: ReturnType<typeof setTimeout> | undefined
const imageContextMenuElement = ref<HTMLDivElement | null>(null)
const contentValue = ref(props.value)
const outlineItems = ref<MarkdownOutlineItem[]>([])
const outlineOpen = ref(true)
const previewMode = ref(false)
const focusMode = ref(false)
const activeOutlineIndex = ref(0)
const feedbackText = ref('')
const imageContextMenu = ref({ visible: false, x: 0, y: 0, address: '' })
let editor: Crepe | null = null
let editorReady = false
let destroyed = false
let editorDocumentId = props.documentId
let editorMarkdown = props.value
let suppressedMarkdown: string | null = null
let toolbarEventsBound = false
let feedbackTimer: ReturnType<typeof setTimeout> | undefined
let outlineTimer: ReturnType<typeof setTimeout> | undefined
let suppressionTimer: ReturnType<typeof setTimeout> | undefined
let readonlyObserver: MutationObserver | null = null
let jsonFormatObserver: MutationObserver | null = null
let toolbarObserver: MutationObserver | null = null
let activeFindMatch: { from: number, to: number } | null = null
const toolbarMenuPanels = new Map<HTMLElement, HTMLDivElement>()
const outlineCache = new Map<string, OutlineCacheEntry>()
const OUTLINE_STORAGE_KEY = 'markdown-outline-open'
const OUTLINE_CACHE_LIMIT = 12
const OUTLINE_UPDATE_DELAY_MS = 120
const topBarLabels = [
  '加粗', '斜体', '删除线', '行内代码', '无序列表', '有序列表', '任务列表',
  '链接', '图片', '表格', '代码块', '公式', '引用', '分隔线'
]

/**
 * 为当前查找结果生成编辑器装饰。
 *
 * :param documentNode: ProseMirror 文档节点。
 * :return: 当前文档对应的装饰集合。
 */
function createEditorDecorations(documentNode: ProseMirrorNode): DecorationSet {
  const decorations: Decoration[] = []
  if (activeFindMatch && activeFindMatch.to <= documentNode.content.size) {
    decorations.push(Decoration.inline(activeFindMatch.from, activeFindMatch.to, {
      class: 'note-find-match'
    }))
  }
  return DecorationSet.create(documentNode, decorations)
}

/**
 * 处理编辑器中的附件和普通链接点击。
 *
 * :param event: 鼠标点击事件。
 * :return: 无返回值。
 */
function handleEditorLinkClick(event: MouseEvent): void {
  const anchor = event.target instanceof Element
    ? event.target.closest<HTMLAnchorElement>('a[href]')
    : null
  const href = anchor?.href ?? ''
  const shouldOpenLink = previewMode.value || props.readonly || event.metaKey || event.ctrlKey
  if (href && new URL(href).hostname === 'xinyue-note.local') {
    event.preventDefault()
    event.stopPropagation()
    if (event.button !== 0 || !shouldOpenLink) return
    const noteId = decodeURIComponent(new URL(href).pathname.slice(1))
    void window.notesDesktop.openNoteLink(noteId).catch((error: unknown) => {
      showFeedback(error instanceof Error ? error.message : '笔记打开失败')
    })
    return
  }
  if (href && new URL(href).hostname === 'xinyue-asset.local') {
    event.preventDefault()
    event.stopPropagation()
    if (event.button !== 0 || !shouldOpenLink) return
    const attachmentId = decodeURIComponent(new URL(href).pathname.slice(1))
    void window.notesDesktop.openAttachment(attachmentId).catch((error: unknown) => {
      showFeedback(error instanceof Error ? error.message : '附件打开失败')
    })
    return
  }
  if (!/^https?:\/\//i.test(href)) return
  event.preventDefault()
  event.stopPropagation()
  if (event.button !== 0 || !shouldOpenLink) return
  void window.notesDesktop.openExternalLink(href).catch((error: unknown) => {
    showFeedback(error instanceof Error ? error.message : '链接打开失败')
  })
}

/** 关闭正文图片右键菜单。 */
function closeImageContextMenu(): void {
  imageContextMenu.value.visible = false
}

/**
 * 在正文图片旁显示复制地址菜单，并确保菜单不超出视口。
 *
 * :param event: 图片右键事件。
 * :return: 无返回值。
 */
function handleImageContextMenu(event: MouseEvent): void {
  const target = event.target instanceof Element ? event.target : null
  const image = target?.closest<HTMLImageElement>('img')
    || target?.closest<HTMLElement>('.image-wrapper')?.querySelector<HTMLImageElement>('img')
  const address = image?.getAttribute('src') || image?.currentSrc || ''
  if (!image || !address) return
  event.preventDefault()
  event.stopPropagation()
  imageContextMenu.value = {
    visible: true,
    x: Math.min(event.clientX, window.innerWidth - 16),
    y: Math.min(event.clientY, window.innerHeight - 16),
    address
  }
  void nextTick(() => {
    const menu = imageContextMenuElement.value
    if (!menu) return
    const bounds = menu.getBoundingClientRect()
    imageContextMenu.value.x = Math.max(8, Math.min(imageContextMenu.value.x, window.innerWidth - bounds.width - 8))
    imageContextMenu.value.y = Math.max(8, Math.min(imageContextMenu.value.y, window.innerHeight - bounds.height - 8))
    menu.querySelector<HTMLButtonElement>('button')?.focus({ preventScroll: true })
  })
}

/** 将右键图片在当前笔记中使用的地址复制到剪贴板。 */
async function copyImageAddress(): Promise<void> {
  const address = imageContextMenu.value.address
  closeImageContextMenu()
  if (!address) return
  try {
    await navigator.clipboard.writeText(imageContextMenu.value.address)
    showFeedback(address.startsWith('xinyue-asset:') ? '本地图片地址已复制，仅本应用可用' : '图片地址已复制')
  } catch {
    showFeedback('复制失败，请检查剪贴板权限')
  }
}

/**
 * 根据 Command/Ctrl 状态切换链接手型光标。
 *
 * :param event: 键盘或鼠标事件。
 * :return: 无返回值。
 */
function syncLinkModifierState(event: KeyboardEvent | MouseEvent): void {
  document.body.classList.toggle('is-link-modifier-active', event.metaKey || event.ctrlKey)
}

/**
 * 清除链接快捷打开的修饰键状态。
 *
 * :return: 无返回值。
 */
function clearLinkModifierState(): void {
  document.body.classList.remove('is-link-modifier-active')
}

/**
 * 显示短暂的编辑器操作反馈。
 *
 * :param message: 提示内容。
 * :return: 无返回值。
 */
function showFeedback(message: string): void {
  feedbackText.value = message
  if (feedbackTimer) clearTimeout(feedbackTimer)
  feedbackTimer = setTimeout(() => {
    feedbackText.value = ''
  }, 1800)
}

/**
 * 为 JSON 代码块同步格式化按钮。
 *
 * :param root: 编辑器根节点。
 * :return: 无返回值。
 */
function syncJsonFormatButtons(root: HTMLElement): void {
  root.querySelectorAll<HTMLElement>('.milkdown-code-block').forEach((codeBlock) => {
    const languageName = codeBlock
      .querySelector<HTMLElement>('.language-button')
      ?.textContent
      ?.trim()
      .toLocaleLowerCase() ?? ''
    const isJsonLanguage = languageName === 'json'
    const buttonGroup = codeBlock.querySelector<HTMLElement>('.tools-button-group')
    const currentButton = codeBlock.querySelector<HTMLButtonElement>('.json-code-format-button')
    if (!isJsonLanguage || !buttonGroup) {
      currentButton?.remove()
      return
    }
    if (currentButton) return
    const button = document.createElement('button')
    button.type = 'button'
    button.className = 'json-code-format-button'
    button.textContent = '格式化'
    button.title = '格式化 JSON'
    button.setAttribute('aria-label', '格式化 JSON')
    buttonGroup.prepend(button)
  })
}

/**
 * 判断 DOM 变化是否会影响 JSON 格式化按钮。
 *
 * :param mutations: 编辑器 DOM 变化记录。
 * :return: 需要重新同步按钮时返回 true。
 */
function shouldSyncJsonFormatButtons(mutations: MutationRecord[]): boolean {
  return mutations.some((mutation) => {
    const targetElement = mutation.target instanceof Element
      ? mutation.target
      : mutation.target.parentElement
    if (targetElement?.closest('.language-button, .tools-button-group')) return true
    return [...mutation.addedNodes].some((node) => (
      node instanceof Element
      && (
        node.matches('.milkdown-code-block, .tools')
        || Boolean(node.querySelector('.milkdown-code-block, .tools'))
      )
    ))
  })
}

/**
 * 启动 JSON 格式化按钮的 DOM 同步。
 *
 * :param root: 编辑器根节点。
 * :return: 无返回值。
 */
function startJsonFormatButtons(root: HTMLElement): void {
  jsonFormatObserver?.disconnect()
  syncJsonFormatButtons(root)
  jsonFormatObserver = new MutationObserver((mutations) => {
    if (shouldSyncJsonFormatButtons(mutations)) syncJsonFormatButtons(root)
  })
  jsonFormatObserver.observe(root, {
    childList: true,
    characterData: true,
    subtree: true
  })
}

/**
 * 格式化用户点击按钮所在的 JSON 代码块。
 *
 * :param event: 编辑器点击事件。
 * :return: 无返回值。
 */
function handleJsonCodeFormatClick(event: MouseEvent): void {
  const button = event.target instanceof Element
    ? event.target.closest<HTMLButtonElement>('.json-code-format-button')
    : null
  if (!button || props.readonly || previewMode.value) return
  event.preventDefault()
  event.stopPropagation()
  const editorElement = button
    .closest<HTMLElement>('.milkdown-code-block')
    ?.querySelector<HTMLElement>('.cm-editor')
  if (!editorElement) return
  const codeMirrorView = EditorView.findFromDOM(editorElement)
  if (!codeMirrorView) return
  const result = formatJsonCode(codeMirrorView.state.doc.toString())
  if (!result.ok) {
    showFeedback(result.message)
    return
  }
  codeMirrorView.focus()
  codeMirrorView.dispatch({
    changes: {
      from: 0,
      to: codeMirrorView.state.doc.length,
      insert: result.code
    }
  })
  showFeedback('JSON 格式化完成')
}

/**
 * 应用已经解析完成的大纲项目。
 *
 * :param items: 待显示的大纲项目。
 * :return: 无返回值。
 */
function applyOutlineItems(items: MarkdownOutlineItem[]): void {
  outlineItems.value = items
  if (activeOutlineIndex.value >= outlineItems.value.length) activeOutlineIndex.value = 0
  void nextTick(updateActiveOutline)
}

/**
 * 缓存指定文档的大纲并限制缓存数量。
 *
 * :param documentId: 文档 ID。
 * :param markdown: Markdown 原文。
 * :param items: 已解析的大纲项目。
 * :return: 无返回值。
 */
function cacheOutline(documentId: string, markdown: string, items: MarkdownOutlineItem[]): void {
  if (!documentId) return
  outlineCache.delete(documentId)
  outlineCache.set(documentId, { markdown, items })
  const oldestDocumentId = outlineCache.keys().next().value
  if (outlineCache.size > OUTLINE_CACHE_LIMIT && oldestDocumentId) outlineCache.delete(oldestDocumentId)
}

/**
 * 延迟解析 Markdown 大纲，避免正文切换被全文分析阻塞。
 *
 * :param markdown: Markdown 原文。
 * :param documentId: 文档 ID。
 * :return: 无返回值。
 */
function scheduleOutlineUpdate(markdown: string, documentId: string): void {
  if (outlineTimer) clearTimeout(outlineTimer)
  const cached = documentId ? outlineCache.get(documentId) : undefined
  if (cached?.markdown === markdown) {
    outlineCache.delete(documentId)
    outlineCache.set(documentId, cached)
    applyOutlineItems(cached.items)
    return
  }
  outlineTimer = setTimeout(() => {
    outlineTimer = undefined
    if (destroyed || documentId !== editorDocumentId || markdown !== editorMarkdown) return
    const items = extractMarkdownOutline(markdown)
    cacheOutline(documentId, markdown, items)
    applyOutlineItems(items)
  }, OUTLINE_UPDATE_DELAY_MS)
}

/**
 * 根据正文滚动位置更新当前大纲项。
 *
 * :return: 无返回值。
 */
function updateActiveOutline(): void {
  const scrollContainer = editorScrollRef.value
  const headings = editorRootRef.value?.querySelectorAll<HTMLElement>(
    '.ProseMirror h1, .ProseMirror h2, .ProseMirror h3, .ProseMirror h4, .ProseMirror h5, .ProseMirror h6'
  )
  if (!scrollContainer || !headings?.length) return
  const threshold = scrollContainer.getBoundingClientRect().top + 86
  let nextIndex = 0
  headings.forEach((heading, index) => {
    if (heading.getBoundingClientRect().top <= threshold) nextIndex = index
  })
  activeOutlineIndex.value = nextIndex
}

/** 更新大纲并把当前文档阅读位置交给父级防抖保存。 */
function handleEditorScroll(): void {
  updateActiveOutline()
  const scrollTop = editorScrollRef.value?.scrollTop
  if (scrollTop !== undefined) emit('scroll-position-change', scrollTop, editorDocumentId)
}

/**
 * 将编辑区和大纲状态重置到文档顶部。
 *
 * :return: 无返回值。
 */
function resetEditorScroll(): void {
  const scrollContainer = editorScrollRef.value
  const nextScrollTop = Math.max(0, props.scrollTop)
  if (scrollContainer) scrollContainer.scrollTop = nextScrollTop
  activeOutlineIndex.value = 0
  void nextTick(() => {
    if (editorScrollRef.value) {
      editorScrollRef.value.scrollTop = nextScrollTop
      updateActiveOutline()
    }
  })
}

function getScrollTop(): number {
  return editorScrollRef.value?.scrollTop ?? 0
}

/**
 * 切换大纲面板并保存用户偏好。
 *
 * :return: 无返回值。
 */
function toggleOutline(): void {
  outlineOpen.value = !outlineOpen.value
  localStorage.setItem(OUTLINE_STORAGE_KEY, String(outlineOpen.value))
  syncOutlineToggle()
  if (outlineOpen.value) void nextTick(updateActiveOutline)
}

/**
 * 同步工具栏大纲按钮状态。
 *
 * :return: 无返回值。
 */
function syncOutlineToggle(): void {
  const button = editorRootRef.value?.querySelector<HTMLButtonElement>('.markdown-outline-toggle')
  if (!button) return
  button.setAttribute('aria-expanded', String(outlineOpen.value))
  button.setAttribute('aria-label', outlineOpen.value ? '收起大纲' : '展开大纲')
  button.dataset.label = '大纲'
  button.classList.toggle('active', outlineOpen.value)
}

/**
 * 切换反向链接面板的显示状态。
 *
 * :return: 无返回值。
 */
function toggleBacklinks(): void {
  backlinksOpen.value = !backlinksOpen.value
}

/**
 * 切换关系图谱面板的显示状态。
 *
 * :return: 无返回值。
 */
function toggleNoteGraph(): void {
  noteGraphOpen.value = !noteGraphOpen.value
}

/**
 * 同步工具栏预览按钮状态。
 *
 * :return: 无返回值。
 */
function syncPreviewToggle(): void {
  const button = editorRootRef.value?.querySelector<HTMLButtonElement>('.markdown-preview-toggle')
  if (!button) return
  button.setAttribute('aria-pressed', String(previewMode.value))
  button.setAttribute('aria-label', previewMode.value ? '退出预览并继续编辑' : '预览文档')
  button.dataset.label = '预览'
  button.classList.toggle('active', previewMode.value)
}

/**
 * 同步预览模式下的工具栏可用状态。
 *
 * :return: 无返回值。
 */
function syncPreviewReadonly(): void {
  const isReadonly = props.readonly || previewMode.value
  if (editor && editor.readonly !== props.readonly) editor.setReadonly(props.readonly)
  editorRootRef.value
    ?.querySelectorAll<HTMLElement>('.ProseMirror, .ProseMirror .cm-content')
    .forEach((element) => {
      element.setAttribute('contenteditable', String(!isReadonly))
      element.setAttribute('aria-readonly', String(isReadonly))
    })
  readonlyObserver?.disconnect()
  readonlyObserver = null
  if (isReadonly && editorRootRef.value) {
    readonlyObserver = new MutationObserver(syncPreviewReadonly)
    readonlyObserver.observe(editorRootRef.value, { childList: true, subtree: true })
  }
  editorRootRef.value
    ?.querySelectorAll<HTMLButtonElement>(
      '.top-bar-heading-selector button, .top-bar-actions .top-bar-item:not(.markdown-outline-toggle):not(.markdown-preview-toggle):not(.markdown-tools-menu-toggle)'
    )
    .forEach((button) => {
      button.disabled = isReadonly
    })
  editorRootRef.value?.querySelectorAll<HTMLButtonElement>('.markdown-tools-menu .markdown-toolbar-menu__item')
    .forEach((button) => {
      button.disabled = isReadonly && button.dataset.previewAllowed !== 'true'
    })
  closeToolbarMenus()
}

/**
 * 切换整篇文档的编辑和预览状态。
 *
 * :return: 无返回值。
 */
function togglePreview(): void {
  if (props.readonly || !editor || !editorReady) return
  previewMode.value = !previewMode.value
  syncPreviewReadonly()
  if (previewMode.value) {
    const activeElement = document.activeElement
    if (activeElement instanceof HTMLElement) activeElement.blur()
    window.getSelection()?.removeAllRanges()
  }
  syncPreviewToggle()
  void nextTick(updateActiveOutline)
}

/**
 * 滚动到指定标题。
 *
 * :param index: 标题在文档中的顺序。
 * :return: 无返回值。
 */
function scrollToOutline(index: number): void {
  const scrollContainer = editorScrollRef.value
  const heading = editorRootRef.value?.querySelectorAll<HTMLElement>(
    '.ProseMirror h1, .ProseMirror h2, .ProseMirror h3, .ProseMirror h4, .ProseMirror h5, .ProseMirror h6'
  )[index]
  if (!scrollContainer || !heading) return
  const top = heading.getBoundingClientRect().top
    - scrollContainer.getBoundingClientRect().top
    + scrollContainer.scrollTop
    - 78
  activeOutlineIndex.value = index
  scrollContainer.scrollTo({ top: Math.max(0, top), behavior: 'smooth' })
}

/**
 * 将图片保存为桌面端可离线读取的本地资源。
 *
 * :param file: 待插入图片。
 * :return: 本地图片资源地址。
 */
async function uploadImage(file: File): Promise<string> {
  const asset = await window.notesDesktop.saveImageAsset({
    fileName: file.name,
    mimeType: file.type,
    data: await file.arrayBuffer()
  })
  showFeedback(asset.remoteUrl ? '图片已保存' : '图片已离线保存，联网后自动同步')
  return asset.localUrl
}

/**
 * 保存剪贴板图片并直接插入编辑器图片节点。
 *
 * :param file: 剪贴板中的图片文件。
 * :return: 完成保存和插入后的 Promise。
 */
async function insertPastedImage(file: File): Promise<void> {
  if (!editor || !editorReady || props.readonly) return
  try {
    const src = await uploadImage(file)
    editor.editor.action((context) => {
      const view = context.get(editorViewCtx)
      const imageNodeType = view.state.schema.nodes['image-block'] || view.state.schema.nodes.image
      const imageNode = imageNodeType?.createAndFill({ src, alt: file.name })
      if (!imageNode) throw new Error('编辑器图片能力不可用')
      view.dispatch(view.state.tr.replaceSelectionWith(imageNode).scrollIntoView())
      view.focus()
    })
  } catch (error) {
    showFeedback(error instanceof Error ? error.message : '图片保存失败')
  }
}

/**
 * 打开系统附件选择器。
 *
 * :return: 无返回值。
 */
function openAttachmentPicker(): void {
  attachmentInputRef.value?.click()
}

/**
 * 保存用户选择的附件并插入当前光标位置。
 *
 * :param event: 文件选择输入事件。
 * :return: 完成保存和插入后的 Promise。
 */
async function handleAttachmentSelection(event: Event): Promise<void> {
  const input = event.currentTarget as HTMLInputElement
  const file = input.files?.[0]
  input.value = ''
  if (!file || !editor || !editorReady || props.readonly) return
  await insertAttachment(file)
}

/**
 * 保存附件并插入当前编辑位置。
 *
 * :param file: 待保存的附件。
 * :return: 完成保存和插入后的 Promise。
 */
async function insertAttachment(file: File): Promise<void> {
  if (!editor || !editorReady || props.readonly) return
  try {
    const asset = await window.notesDesktop.saveAttachment({
      fileName: file.name,
      mimeType: file.type || 'application/octet-stream',
      data: await file.arrayBuffer()
    })
    const internalUrl = `https://xinyue-asset.local/${encodeURIComponent(asset.id)}`
    const attachmentTitle = `attachment|${encodeURIComponent(asset.mimeType)}|${asset.byteSize}`
    editor.editor.action((context) => {
      const view = context.get(editorViewCtx)
      const { from, to } = view.state.selection
      const linkMark = view.state.schema.marks.link
      if (!linkMark) throw new Error('编辑器链接能力不可用')
      const attachmentNode = view.state.schema.text(
        asset.fileName,
        [linkMark.create({ href: internalUrl, title: attachmentTitle })]
      )
      view.dispatch(view.state.tr.replaceRangeWith(from, to, attachmentNode).scrollIntoView())
      view.focus()
    })
    showFeedback(asset.remoteUrl ? '附件已保存' : '附件已保存到本地，正在等待同步')
  } catch (error) {
    showFeedback(error instanceof Error ? error.message : '附件保存失败')
  }
}

/**
 * 打开笔记链接选择器，供用户挑选要引用的笔记。
 *
 * :return: 无返回值。
 */
function openNoteLinkPicker(): void {
  if (props.readonly) {
    showFeedback('只读模式下无法插入笔记链接')
    return
  }
  noteLinkPickerVisible.value = true
}

/**
 * 将选中的笔记以内部链接形式插入当前光标位置。
 *
 * :param noteId: 目标笔记 ID。
 * :param title: 链接展示用的笔记标题。
 * :return: 无返回值。
 */
async function insertNoteLink(noteId: string, title: string): Promise<void> {
  noteLinkPickerVisible.value = false
  if (!editor || !editorReady || props.readonly) return
  const href = `https://xinyue-note.local/${encodeURIComponent(noteId)}`
  try {
    editor.editor.action((context) => {
      const view = context.get(editorViewCtx)
      const { from, to } = view.state.selection
      const linkMark = view.state.schema.marks.link
      if (!linkMark) throw new Error('编辑器链接能力不可用')
      const linkNode = view.state.schema.text(title, [linkMark.create({ href })])
      view.dispatch(view.state.tr.replaceRangeWith(from, to, linkNode).scrollIntoView())
      view.focus()
    })
  } catch (error) {
    showFeedback(error instanceof Error ? error.message : '插入笔记链接失败')
  }
}

/** 当前编辑器的 ProseMirror 视图，供 [ [ 补全同步读取光标与文本。 */
let linkSuggestEditorView: any = null

/**
 * 打开 [ [ 补全浮层，定位在补全起点。
 *
 * :param start: 补全片段在文档中的起始位置。
 * :return: 无返回值。
 */
function openLinkSuggest(start: number): void {
  linkSuggestStart.value = start
  const view = linkSuggestEditorView
  if (view) {
    try {
      const coords = view.coordsAtPos(start)
      linkSuggestCoords.value = {
        left: coords.left,
        top: coords.top,
        bottom: coords.bottom,
      }
    } catch {
      linkSuggestCoords.value = { left: 0, top: 0, bottom: 0 }
    }
  }
  linkSuggestVisible.value = true
  linkSuggestIndex.value = 0
  void runLinkSuggestSearch('')
}

/**
 * 关闭 [ [ 补全浮层并清理状态。
 *
 * :return: 无返回值。
 */
function closeLinkSuggest(): void {
  linkSuggestVisible.value = false
  linkSuggestItems.value = []
  linkSuggestIndex.value = 0
  linkSuggestStart.value = null
  linkSuggestQuery.value = ''
}

/**
 * 在存在补全时拦截方向键、回车与 Esc，避免编辑器默认行为。
 *
 * :param view: ProseMirror 视图。
 * :param event: 键盘事件。
 * :return: 是否已处理。
 */
function handleSuggestKeydown(_view: unknown, event: KeyboardEvent): boolean {
  if (!linkSuggestVisible.value || !linkSuggestItems.value.length) {
    if (event.key === 'Escape' && linkSuggestVisible.value) {
      event.preventDefault()
      closeLinkSuggest()
      return true
    }
    return false
  }
  const count = linkSuggestItems.value.length
  if (event.key === 'ArrowDown') {
    event.preventDefault()
    linkSuggestIndex.value = (linkSuggestIndex.value + 1) % count
    return true
  }
  if (event.key === 'ArrowUp') {
    event.preventDefault()
    linkSuggestIndex.value = (linkSuggestIndex.value - 1 + count) % count
    return true
  }
  if (event.key === 'Enter') {
    event.preventDefault()
    commitLinkSuggest()
    return true
  }
  if (event.key === 'Escape') {
    event.preventDefault()
    closeLinkSuggest()
    return true
  }
  return false
}

/**
 * 编辑器内容输入时检测 [ [ 并驱动补全。
 *
 * :return: 是否已处理（始终不做拦截）。
 */
function handleSuggestInput(): boolean {
  if (props.readonly) {
    closeLinkSuggest()
    return false
  }
  const view = linkSuggestEditorView
  if (!view) return false
  const { from } = view.state.selection
  const before = view.state.doc.textBetween(Math.max(0, from - 8), from)
  if (before.endsWith('[[')) {
    openLinkSuggest(from - 2)
  } else if (linkSuggestStart.value !== null) {
    const query = view.state.doc.textBetween(linkSuggestStart.value + 2, from)
    void runLinkSuggestSearch(query)
  } else if (linkSuggestVisible.value) {
    closeLinkSuggest()
  }
  return false
}

/**
 * 读取 [ [ 后的关键词并检索笔记，空关键词展示最近笔记。
 *
 * :param query: 关键词。
 * :return: 无返回值。
 */
async function runLinkSuggestSearch(query: string): Promise<void> {
  const text = query.trim()
  linkSuggestQuery.value = text
  if (linkSuggestTimer) clearTimeout(linkSuggestTimer)
  linkSuggestTimer = setTimeout(async () => {
    try {
      if (!text) {
        const workspace = await window.notesDesktop.listWorkspace()
        linkSuggestItems.value = (workspace.notes || [])
          .filter((note) => !note.isDeleted)
          .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
          .slice(0, 8)
      } else {
        const notes = await window.notesDesktop.searchNotes(text, { limit: 50 })
        const query = text.toLowerCase()
        linkSuggestItems.value = notes
          .filter((note) => !note.isDeleted)
          .sort((a, b) => {
            const A = a.title.toLowerCase().includes(query) ? 0 : 1
            const B = b.title.toLowerCase().includes(query) ? 0 : 1
            if (A !== B) return A - B
            return b.updatedAt.localeCompare(a.updatedAt)
          })
          .slice(0, 8)
      }
      if (linkSuggestIndex.value >= linkSuggestItems.value.length) linkSuggestIndex.value = 0
    } catch {
      linkSuggestItems.value = []
    }
  }, 120)
}

/**
 * 用选中笔记替换 [ [ 补全片段，生成内部链接。
 *
 * :return: 无返回值。
 */
function commitLinkSuggest(): void {
  const note = linkSuggestItems.value[linkSuggestIndex.value]
  if (!note) {
    closeLinkSuggest()
    return
  }
  insertNoteLinkFromPos(note.id, note.title || '（无标题）')
}

/**
 * 用选中笔记替换 [ [ 补全片段，生成内部链接。
 *
 * :param noteId: 目标笔记 ID。
 * :param title: 链接展示标题。
 * :return: 无返回值。
 */
function insertNoteLinkFromPos(noteId: string, title: string): void {
  const start = linkSuggestStart.value
  const view = linkSuggestEditorView
  closeLinkSuggest()
  if (start === null || !editor || props.readonly) return
  const href = `https://xinyue-note.local/${encodeURIComponent(noteId)}`
  const currentFrom = typeof view?.state?.selection?.from === 'number' ? view.state.selection.from : start
  try {
    editor.editor.action((context) => {
      const v = context.get(editorViewCtx)
      const linkMark = v.state.schema.marks.link
      if (!linkMark) throw new Error('编辑器链接能力不可用')
      const node = v.state.schema.text(title, [linkMark.create({ href })])
      v.dispatch(v.state.tr.replaceWith(start, currentFrom, node).scrollIntoView())
      v.focus()
    })
  } catch (error) {
    showFeedback(error instanceof Error ? error.message : '插入笔记链接失败')
  }
}
function linkSuggestHover(index: number): void {
  linkSuggestIndex.value = index
}

/**
 * 允许非图片文件拖入编辑器。
 *
 * :param event: 拖拽经过事件。
 * :return: 无返回值。
 */
function handleAttachmentDragOver(event: DragEvent): void {
  const file = event.dataTransfer?.files?.[0]
  if (!file || file.type.startsWith('image/')) return
  event.preventDefault()
  if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy'
}

/**
 * 将拖入的非图片文件保存为附件。
 *
 * :param event: 文件拖放事件。
 * :return: 无返回值。
 */
function handleAttachmentDrop(event: DragEvent): void {
  const file = event.dataTransfer?.files?.[0]
  if (!file || file.type.startsWith('image/')) return
  event.preventDefault()
  event.stopPropagation()
  void insertAttachment(file)
}

/**
 * 将剪贴板中的非图片文件保存为附件。
 *
 * 图片继续交由编辑器原有的图片粘贴能力处理。
 *
 * :param event: 剪贴板粘贴事件。
 * :return: 无返回值。
 */
function handleAttachmentPaste(event: ClipboardEvent): void {
  const files = Array.from(event.clipboardData?.files || [])
  if (!files.length || props.readonly) return
  const images = files.filter((file) => file.type.startsWith('image/'))
  const attachments = files.filter((file) => !file.type.startsWith('image/'))
  event.preventDefault()
  event.stopPropagation()
  void (async () => {
    for (const file of images) await insertPastedImage(file)
    for (const file of attachments) await insertAttachment(file)
  })()
}

/**
 * 静默替换编辑器内容，避免外部回填触发自动保存。
 *
 * :param value: Markdown 内容。
 * :param crepe: Milkdown 编辑器实例。
 * :return: 无返回值。
 */
function replaceContentSilently(value: string, crepe: Crepe): void {
  crepe.editor.action(replaceAll(value))
  suppressedMarkdown = crepe.getMarkdown()
  editorMarkdown = suppressedMarkdown
  if (suppressionTimer) clearTimeout(suppressionTimer)
  suppressionTimer = setTimeout(() => {
    suppressedMarkdown = null
    suppressionTimer = undefined
  }, 500)
}

/**
 * 在切换文档后仅替换 history 插件状态，清空上一文档的撤销和重做记录。
 * 使用普通事务更新插件状态，避免 view.updateState 重建 Crepe 工具栏视图。
 *
 * :param crepe: Milkdown 编辑器实例。
 * :return: 无返回值。
 */
function resetDocumentHistory(crepe: Crepe): void {
  crepe.editor.action((context) => {
    const view = context.get(editorViewCtx)
    const plugins = view.state.plugins
    const historyKey = historyProviderPlugin.key()
    const historyPlugin = historyKey?.get(view.state)
    if (!historyKey || !historyPlugin) return
    const stateWithFreshHistory = view.state.reconfigure({
      plugins: plugins.filter((plugin) => plugin !== historyPlugin)
    }).reconfigure({ plugins })
    const freshHistoryState = historyKey.getState(stateWithFreshHistory)
    if (!freshHistoryState) return
    // history 插件支持由事务元数据替换自身状态；这样不会销毁其他插件视图。
    view.dispatch(view.state.tr.setMeta(historyKey, { historyState: freshHistoryState }))
  })
  if (editorRootRef.value) syncHistoryActionButtons(editorRootRef.value)
}

/**
 * 关闭所有已展开的工具栏二级菜单。
 *
 * :return: 无返回值。
 */
function closeToolbarMenus(): void {
  toolbarMenuPanels.forEach((panel, menu) => {
    menu.classList.remove('is-open')
    menu.querySelector<HTMLButtonElement>('.markdown-toolbar-menu__toggle')?.setAttribute('aria-expanded', 'false')
    panel.classList.remove('is-portal-open')
    panel.removeAttribute('style')
    if (panel.parentElement !== menu) menu.append(panel)
  })
}

/**
 * 把工具栏菜单定位到页面顶层，避免被横向滚动容器裁剪。
 *
 * :param menu: 菜单容器。
 * :param panel: 菜单面板。
 * :return: 无返回值。
 */
function positionToolbarMenu(menu: HTMLElement, panel: HTMLDivElement): void {
  const toggle = menu.querySelector<HTMLButtonElement>('.markdown-toolbar-menu__toggle')
  if (!toggle) return
  const toggleRect = toggle.getBoundingClientRect()
  document.body.append(panel)
  panel.classList.add('is-portal-open')
  const panelWidth = panel.offsetWidth
  const centeredLeft = toggleRect.left + toggleRect.width / 2 - panelWidth / 2
  const alignedLeft = menu.classList.contains('markdown-tools-menu') ? toggleRect.right - panelWidth : centeredLeft
  const left = Math.max(12, Math.min(alignedLeft, window.innerWidth - panelWidth - 12))
  panel.style.left = `${left}px`
  panel.style.top = `${Math.min(toggleRect.bottom + 7, window.innerHeight - panel.offsetHeight - 12)}px`
}

/**
 * 切换指定工具栏二级菜单。
 *
 * :param menu: 待切换菜单。
 * :return: 无返回值。
 */
function toggleToolbarMenu(menu: HTMLElement): void {
  const shouldOpen = !menu.classList.contains('is-open')
  closeToolbarMenus()
  menu.classList.toggle('is-open', shouldOpen)
  menu.querySelector<HTMLButtonElement>('.markdown-toolbar-menu__toggle')?.setAttribute('aria-expanded', String(shouldOpen))
  const panel = toolbarMenuPanels.get(menu)
  if (shouldOpen && panel) positionToolbarMenu(menu, panel)
}

/**
 * 创建工具栏分隔线。
 *
 * :return: 分隔线节点。
 */
function createToolbarDivider(): HTMLDivElement {
  const divider = document.createElement('div')
  divider.className = 'top-bar-divider markdown-toolbar-divider'
  divider.setAttribute('aria-hidden', 'true')
  return divider
}

/**
 * 创建二级菜单操作按钮。
 *
 * :param item: 操作按钮配置。
 * :return: 操作按钮节点。
 */
function createToolbarActionButton(item: ToolbarActionItem): HTMLButtonElement {
  const button = document.createElement('button')
  button.type = 'button'
  button.className = 'markdown-toolbar-menu__item'
  button.dataset.action = item.label === '专注模式' ? 'focus-mode' : item.label
  button.dataset.label = item.label
  button.dataset.previewAllowed = String(Boolean(item.previewAllowed))
  button.setAttribute('aria-label', item.label)
  render(h(Icon, { icon: item.icon, 'aria-hidden': 'true' }), button)
  button.addEventListener('click', () => {
    closeToolbarMenus()
    void item.action()
  })
  return button
}

/**
 * 创建一级工具栏操作按钮。
 *
 * :param item: 操作按钮配置。
 * :return: 操作按钮节点。
 */
function createTopBarActionButton(item: ToolbarActionItem): HTMLButtonElement {
  const button = document.createElement('button')
  button.type = 'button'
  button.className = 'top-bar-item markdown-toolbar-direct-action'
  button.dataset.action = item.label
  button.dataset.label = item.label
  button.setAttribute('aria-label', item.label)
  render(h(Icon, { icon: item.icon, 'aria-hidden': 'true' }), button)
  button.addEventListener('click', () => void item.action())
  return button
}

/**
 * 创建工具栏二级菜单。
 *
 * :param options: 菜单显示配置。
 * :param items: 菜单操作按钮。
 * :return: 菜单容器。
 */
function createToolbarMenu(options: ToolbarMenuOptions, items: HTMLButtonElement[]): HTMLDivElement {
  const menu = document.createElement('div')
  menu.className = ['markdown-toolbar-menu', options.className].filter(Boolean).join(' ')
  menu.dataset.menu = options.key
  const toggle = document.createElement('button')
  toggle.type = 'button'
  toggle.className = 'markdown-toolbar-menu__toggle top-bar-item'
  toggle.dataset.label = options.label
  toggle.setAttribute('aria-label', `${options.label}菜单`)
  toggle.setAttribute('aria-haspopup', 'menu')
  toggle.setAttribute('aria-expanded', 'false')
  render(h(Icon, { icon: options.icon, 'aria-hidden': 'true' }), toggle)
  toggle.addEventListener('click', (event) => {
    event.stopPropagation()
    toggleToolbarMenu(menu)
  })
  const panel = document.createElement('div')
  panel.className = 'markdown-toolbar-menu__panel'
  panel.setAttribute('role', 'menu')
  panel.addEventListener('click', (event) => event.stopPropagation())
  items.forEach((button) => {
    button.classList.remove('top-bar-item')
    button.classList.add('markdown-toolbar-menu__item')
    button.setAttribute('role', 'menuitem')
    button.addEventListener('click', closeToolbarMenus)
    panel.append(button)
  })
  menu.append(toggle, panel)
  toolbarMenuPanels.set(menu, panel)
  return menu
}

/** 执行编辑器撤销命令。 */
function undoEditor(): void {
  editor?.editor.action((context) => context.get(commandsCtx).call(undoCommand.key))
}

/** 执行编辑器重做命令。 */
function redoEditor(): void {
  editor?.editor.action((context) => context.get(commandsCtx).call(redoCommand.key))
}

/**
 * 根据当前文档的 history 深度同步撤销与重做按钮。
 *
 * :param root: 编辑器根节点。
 * :return: 无返回值。
 */
function syncHistoryActionButtons(root: HTMLElement): void {
  if (!editor) return
  const undoButton = root.querySelector<HTMLButtonElement>('[data-action="撤销"]')
  const redoButton = root.querySelector<HTMLButtonElement>('[data-action="重做"]')
  if (!undoButton || !redoButton) return
  editor.editor.action((context) => {
    const view = context.get(editorViewCtx)
    const isReadonly = props.readonly || previewMode.value
    undoButton.disabled = isReadonly || undoDepth(view.state) === 0
    redoButton.disabled = isReadonly || redoDepth(view.state) === 0
  })
}

/** 切换当前选区的行内公式格式。 */
function toggleInlineFormula(): void {
  editor?.editor.action((context) => context.get(commandsCtx).call('ToggleLatex'))
}

/**
 * 将当前 Markdown 原文复制到剪贴板。
 *
 * :return: 异步操作完成后无返回值。
 */
async function copyMarkdown(): Promise<void> {
  if (!editor) return
  try {
    await navigator.clipboard.writeText(editor.getMarkdown())
    showFeedback('Markdown 已复制')
  } catch {
    showFeedback('复制失败，请检查剪贴板权限')
  }
}

/** 同步专注模式按钮状态。 */
function syncFocusModeToggle(): void {
  const button = editorRootRef.value?.querySelector<HTMLButtonElement>('[data-action="focus-mode"]')
  if (!button) return
  const label = focusMode.value ? '退出专注' : '专注模式'
  button.dataset.label = label
  button.setAttribute('aria-label', label)
  button.classList.toggle('active', focusMode.value)
}

/** 切换编辑器专注模式。 */
function toggleFocusMode(): void {
  focusMode.value = !focusMode.value
  document.body.classList.toggle('markdown-editor-focus-mode', focusMode.value)
  syncFocusModeToggle()
  closeToolbarMenus()
}

/**
 * 在文档首个代码块前插入空段落。
 *
 * :param event: 代码编辑器键盘事件。
 * :return: 成功插入段落时返回 true。
 */
function insertParagraphBeforeLeadingCodeBlock(event: KeyboardEvent): boolean {
  if (
    (event.key !== 'ArrowUp' && event.key !== 'Backspace')
    || event.altKey
    || event.ctrlKey
    || event.metaKey
    || event.shiftKey
    || props.readonly
    || previewMode.value
  ) return false
  const target = event.target
  if (!(target instanceof HTMLElement)) return false
  const codeMirrorElement = target.closest<HTMLElement>('.cm-editor')
  if (!codeMirrorElement) return false
  const codeMirrorView = EditorView.findFromDOM(codeMirrorElement)
  const selection = codeMirrorView?.state.selection.main
  if (!selection || !selection.empty || selection.head !== 0) return false

  let inserted = false
  editor?.editor.action((context) => {
    const view = context.get(editorViewCtx)
    const { state } = view
    if (state.doc.firstChild?.type.name !== 'code_block') return
    const paragraph = paragraphSchema.type(context).create()
    let transaction = state.tr.insert(0, paragraph)
    transaction = transaction.setSelection(TextSelection.create(transaction.doc, 1))
    view.dispatch(transaction.scrollIntoView())
    view.focus()
    inserted = true
  })
  if (inserted) {
    event.preventDefault()
    event.stopPropagation()
  }
  return inserted
}

/**
 * 处理编辑器级键盘操作。
 *
 * :param event: 键盘事件。
 * :return: 无返回值。
 */
function handleEditorDocumentKeydown(event: KeyboardEvent): void {
  if (insertParagraphBeforeLeadingCodeBlock(event)) return
  if (event.key !== 'Escape') return
  closeImageContextMenu()
  closeToolbarMenus()
  if (focusMode.value) toggleFocusMode()
}

/**
 * 将原生工具栏按钮组织成与网页版相同的分组。
 *
 * :param actions: 原生工具栏操作区。
 * :return: 无返回值。
 */
function groupTopBarActions(actions: HTMLElement): void {
  if (actions.querySelector('.markdown-toolbar-menu')) return
  const buttons = Array.from(actions.querySelectorAll<HTMLButtonElement>('.top-bar-item'))
  const buttonMap = new Map(buttons.map((button) => [button.dataset.label, button]))
  const pickButtons = (labels: string[]): HTMLButtonElement[] => (
    labels.map((label) => buttonMap.get(label)).filter((button): button is HTMLButtonElement => Boolean(button))
  )
  const listMenu = createToolbarMenu({
    key: 'list', label: '列表', icon: 'material-symbols:format-list-bulleted-rounded'
  }, pickButtons(['无序列表', '有序列表', '任务列表']))
  const insertMenu = createToolbarMenu({
    key: 'insert', label: '插入', icon: 'material-symbols:add-box-outline-rounded'
  }, [
    createToolbarActionButton({ label: '附件', icon: 'tabler:paperclip', action: openAttachmentPicker }),
    createToolbarActionButton({ label: '插入笔记链接', icon: 'tabler:link', action: openNoteLinkPicker }),
    ...pickButtons(['表格', '公式', '引用', '分隔线']),
    createToolbarActionButton({ label: '行内公式', icon: 'material-symbols:functions-rounded', action: toggleInlineFormula })
  ])
  const toolsMenu = createToolbarMenu({
    key: 'tools', label: '更多', icon: 'material-symbols:more-horiz', className: 'markdown-tools-menu'
  }, [
    createToolbarActionButton({ label: '复制 Markdown', icon: 'material-symbols:content-copy-outline-rounded', action: copyMarkdown, previewAllowed: true }),
    createToolbarActionButton({ label: '专注模式', icon: 'material-symbols:fullscreen-rounded', action: toggleFocusMode, previewAllowed: true })
  ])
  toolsMenu.querySelector('.markdown-toolbar-menu__toggle')?.classList.add('markdown-tools-menu-toggle')
  actions.replaceChildren(
    createTopBarActionButton({ label: '撤销', icon: 'material-symbols:undo-rounded', action: undoEditor }),
    createTopBarActionButton({ label: '重做', icon: 'material-symbols:redo-rounded', action: redoEditor }),
    createToolbarDivider(),
    ...pickButtons(['加粗', '斜体', '删除线', '行内代码']),
    createToolbarDivider(),
    listMenu,
    createToolbarDivider(),
    ...pickButtons(['链接', '图片', '代码块']),
    createToolbarDivider(),
    insertMenu,
    createToolbarDivider(),
    toolsMenu
  )
  syncFocusModeToggle()
}

/**
 * 本地化并扩展 Milkdown 工具栏。
 *
 * :param root: 编辑器根节点。
 * :return: 无返回值。
 */
function localizeTopBar(root: HTMLElement): void {
  root.querySelectorAll<HTMLButtonElement>('.top-bar-item').forEach((button, index) => {
    const label = topBarLabels[index]
    if (!label) return
    button.dataset.label = label
    button.setAttribute('aria-label', label)
  })
  const inner = root.querySelector<HTMLElement>('.top-bar-inner')
  const heading = inner?.querySelector<HTMLElement>('.top-bar-heading-selector')
  if (!inner || !heading) return
  if (inner.querySelector('.top-bar-actions')) {
    syncOutlineToggle()
    syncPreviewToggle()
    syncFocusModeToggle()
    syncHistoryActionButtons(root)
    return
  }
  // 顶栏被 Crepe 重绘后，丢弃已经脱离 DOM 的旧菜单引用。
  toolbarMenuPanels.clear()
  const actions = document.createElement('div')
  actions.className = 'top-bar-actions'
  Array.from(inner.children).forEach((child) => {
    if (child !== heading) actions.append(child)
  })
  inner.append(actions)
  groupTopBarActions(actions)
  actions.append(createToolbarDivider())

  const outlineToggle = document.createElement('button')
  outlineToggle.type = 'button'
  outlineToggle.className = 'markdown-outline-toggle top-bar-item'
  outlineToggle.setAttribute('aria-controls', 'markdown-outline-panel')
  render(h(Icon, { icon: 'material-symbols:toc-rounded', 'aria-hidden': 'true' }), outlineToggle)
  outlineToggle.addEventListener('click', toggleOutline)
  actions.append(outlineToggle)

  const previewToggle = document.createElement('button')
  previewToggle.type = 'button'
  previewToggle.className = 'markdown-preview-toggle top-bar-item'
  render(h(Icon, { icon: 'material-symbols:visibility-outline-rounded', 'aria-hidden': 'true' }), previewToggle)
  previewToggle.addEventListener('click', togglePreview)
  actions.append(previewToggle)

  if (!toolbarEventsBound) {
    document.addEventListener('click', closeToolbarMenus)
    document.addEventListener('keydown', handleEditorDocumentKeydown)
    toolbarEventsBound = true
  }
  syncOutlineToggle()
  syncPreviewToggle()
  syncHistoryActionButtons(root)
}

/**
 * 监听 Crepe 顶栏重绘，并恢复桌面端定制工具栏。
 *
 * :param root: 编辑器根节点。
 * :return: 无返回值。
 */
function startToolbarSync(root: HTMLElement): void {
  toolbarObserver?.disconnect()
  toolbarObserver = new MutationObserver(() => {
    const inner = root.querySelector<HTMLElement>('.top-bar-inner')
    if (inner && !inner.querySelector('.top-bar-actions')) localizeTopBar(root)
  })
  toolbarObserver.observe(root, { childList: true, subtree: true })
}

/**
 * 创建与网页版配置一致的 Milkdown Crepe 编辑器。
 *
 * :return: 创建完成后的 Promise。
 */
async function createEditor(): Promise<void> {
  if (!editorRootRef.value) return
  const crepe = new Crepe({
    root: editorRootRef.value,
    defaultValue: contentValue.value,
    features: { [Crepe.Feature.TopBar]: true },
    featureConfigs: {
      [Crepe.Feature.BlockEdit]: {
        textGroup: {
          label: '文本', text: { label: '正文' }, h1: { label: '一级标题' }, h2: { label: '二级标题' },
          h3: { label: '三级标题' }, h4: { label: '四级标题' }, h5: { label: '五级标题' },
          h6: { label: '六级标题' }, quote: { label: '引用' }, divider: { label: '分隔线' }
        },
        listGroup: {
          label: '列表', bulletList: { label: '无序列表' }, orderedList: { label: '有序列表' }, taskList: { label: '任务列表' }
        },
        advancedGroup: {
          label: '高级', image: { label: '图片' }, codeBlock: { label: '代码块' }, table: { label: '表格' }, math: { label: '公式' }
        }
      },
      [Crepe.Feature.LinkTooltip]: { inputPlaceholder: '粘贴链接地址…' },
      [Crepe.Feature.CodeMirror]: {
        searchPlaceholder: '搜索代码语言', noResultText: '没有匹配结果', copyText: '复制',
        onCopy: () => showFeedback('代码已复制'),
        previewToggleText: (previewOnlyMode: boolean) => previewOnlyMode ? '编辑' : '隐藏'
      },
      [Crepe.Feature.TopBar]: {
        headingOptions: [
          { label: '正文', level: null }, { label: '一级标题', level: 1 }, { label: '二级标题', level: 2 },
          { label: '三级标题', level: 3 }, { label: '四级标题', level: 4 }, { label: '五级标题', level: 5 },
          { label: '六级标题', level: 6 }
        ]
      },
      [Crepe.Feature.Placeholder]: { text: '输入 / 可插入标题、列表、图片等内容', mode: 'block' },
      [Crepe.Feature.ImageBlock]: {
        onUpload: uploadImage,
        inlineOnUpload: uploadImage,
        blockOnUpload: uploadImage,
        inlineUploadButton: '上传图片',
        inlineUploadPlaceholderText: '或粘贴图片地址',
        blockUploadButton: '上传图片',
        blockConfirmButton: '确认',
        blockCaptionPlaceholderText: '填写图片说明',
        blockUploadPlaceholderText: '或粘贴图片地址'
      }
    }
  })
  editor = crepe
  crepe.on((listener) => {
    listener.updated(() => {
      if (editorRootRef.value) syncHistoryActionButtons(editorRootRef.value)
    })
    listener.markdownUpdated((_context, markdown) => {
      editorMarkdown = markdown
      scheduleOutlineUpdate(markdown, editorDocumentId)
      if (suppressedMarkdown !== null) {
        const shouldSuppress = suppressedMarkdown === markdown
        suppressedMarkdown = null
        if (suppressionTimer) clearTimeout(suppressionTimer)
        suppressionTimer = undefined
        if (shouldSuppress) return
      }
      if (!editorReady) return
      contentValue.value = markdown
      if (props.readonly) return
      emit('change', markdown, editorDocumentId)
    })
  })
  await crepe.create()
  if (destroyed) {
    await crepe.destroy()
    return
  }
  localizeTopBar(editorRootRef.value)
  startToolbarSync(editorRootRef.value)
  editorRootRef.value.addEventListener('click', handleEditorLinkClick)
  editorRootRef.value.addEventListener('contextmenu', handleImageContextMenu)
  editorRootRef.value.addEventListener('click', handleJsonCodeFormatClick)
  editorRootRef.value.addEventListener('paste', handleAttachmentPaste, true)
  editorRootRef.value.addEventListener('dragover', handleAttachmentDragOver)
  editorRootRef.value.addEventListener('drop', handleAttachmentDrop)
  crepe.editor.action((context) => {
    const view = context.get(editorViewCtx)
    linkSuggestEditorView = view
    view.setProps({
      decorations: (state) => createEditorDecorations(state.doc),
      handleKeyDown: handleSuggestKeydown,
      handleDOMEvents: { input: handleSuggestInput }
    })
  })
  crepe.setReadonly(props.readonly)
  syncPreviewReadonly()
  startJsonFormatButtons(editorRootRef.value)
  editorReady = true
  editorMarkdown = contentValue.value
  resetEditorScroll()
}

/**
 * 设置编辑器 Markdown 内容。
 *
 * :param value: Markdown 内容。
 * :param documentId: 文档 ID。
 * :return: 无返回值。
 */
function setContent(value: string, documentId: string): void {
  const documentChanged = editorDocumentId !== documentId
  const contentChanged = editorMarkdown !== value
  if (documentChanged) activeFindMatch = null
  contentValue.value = value
  editorDocumentId = documentId
  scheduleOutlineUpdate(value, documentId)
  if (editor && editorReady) {
    if (contentChanged) replaceContentSilently(value, editor)
    if (documentChanged) resetDocumentHistory(editor)
  }
  if (documentChanged) resetEditorScroll()
}

/**
 * 在编辑器正文中查找并选中指定匹配项。
 *
 * :param keyword: 查找关键词。
 * :param requestedIndex: 希望定位的匹配索引，可超出范围以支持循环。
 * :return: 实际匹配数量和当前索引。
 */
function findText(keyword: string, requestedIndex: number): { count: number, index: number } {
  const normalizedKeyword = keyword.trim().toLocaleLowerCase()
  if (!editor || !editorReady) return { count: 0, index: -1 }
  const matches: Array<{ from: number, to: number }> = []
  editor.editor.action((context) => {
    const view = context.get(editorViewCtx)
    if (!normalizedKeyword) {
      activeFindMatch = null
      view.dispatch(view.state.tr)
      return
    }
    view.state.doc.descendants((node, position) => {
      if (!node.isText || !node.text) return
      const normalizedText = node.text.toLocaleLowerCase()
      let offset = normalizedText.indexOf(normalizedKeyword)
      while (offset >= 0) {
        matches.push({
          from: position + offset,
          to: position + offset + normalizedKeyword.length
        })
        offset = normalizedText.indexOf(normalizedKeyword, offset + normalizedKeyword.length)
      }
    })
    if (!matches.length) {
      activeFindMatch = null
      view.dispatch(view.state.tr)
      return
    }
    const index = ((requestedIndex % matches.length) + matches.length) % matches.length
    const match = matches[index]
    activeFindMatch = match
    const transaction = view.state.tr
      .setSelection(TextSelection.create(view.state.doc, match.from, match.to))
    view.dispatch(transaction)
    const scrollContainer = view.dom.closest<HTMLElement>('.milkdown-editor-scroll')
    if (scrollContainer) {
      const matchCoordinates = view.coordsAtPos(match.from)
      const containerRect = scrollContainer.getBoundingClientRect()
      scrollContainer.scrollTo({
        top: scrollContainer.scrollTop
          + matchCoordinates.top
          - containerRect.top
          - containerRect.height / 2,
        behavior: 'auto'
      })
    }
  })
  if (!matches.length) return { count: 0, index: -1 }
  return {
    count: matches.length,
    index: ((requestedIndex % matches.length) + matches.length) % matches.length
  }
}

/**
 * 清除笔记内查找高亮。
 *
 * :return: 无返回值。
 */
function clearFindHighlight(): void {
  editor?.editor.action((context) => {
    const view = context.get(editorViewCtx)
    activeFindMatch = null
    view.dispatch(view.state.tr)
  })
}

defineExpose({ clearFindHighlight, findText, getScrollTop })

watch(
  () => [props.value, props.documentId] as const,
  ([value, documentId]) => setContent(value, documentId)
)
watch(() => props.readonly, syncPreviewReadonly)
onMounted(() => {
  outlineOpen.value = props.showOutline && localStorage.getItem(OUTLINE_STORAGE_KEY) !== 'false'
  scheduleOutlineUpdate(contentValue.value, editorDocumentId)
  document.addEventListener('keydown', syncLinkModifierState)
  document.addEventListener('keyup', syncLinkModifierState)
  document.addEventListener('mousemove', syncLinkModifierState)
  window.addEventListener('blur', clearLinkModifierState)
  document.addEventListener('pointerdown', closeImageContextMenu)
  editorScrollRef.value?.addEventListener('scroll', closeImageContextMenu, { passive: true })
  void createEditor()
})
onBeforeUnmount(() => {
  const latestMarkdown = editor?.getMarkdown()
  if (!props.readonly && latestMarkdown !== undefined && latestMarkdown !== props.value) {
    emit('change', latestMarkdown, editorDocumentId)
  }
  destroyed = true
  closeLinkSuggest()
  if (linkSuggestTimer) clearTimeout(linkSuggestTimer)
  linkSuggestTimer = undefined
  clearLinkModifierState()
  document.removeEventListener('keydown', syncLinkModifierState)
  document.removeEventListener('keyup', syncLinkModifierState)
  document.removeEventListener('mousemove', syncLinkModifierState)
  window.removeEventListener('blur', clearLinkModifierState)
  document.removeEventListener('pointerdown', closeImageContextMenu)
  editorScrollRef.value?.removeEventListener('scroll', closeImageContextMenu)
  readonlyObserver?.disconnect()
  readonlyObserver = null
  jsonFormatObserver?.disconnect()
  jsonFormatObserver = null
  toolbarObserver?.disconnect()
  toolbarObserver = null
  editorRootRef.value?.removeEventListener('click', handleEditorLinkClick)
  editorRootRef.value?.removeEventListener('contextmenu', handleImageContextMenu)
  editorRootRef.value?.removeEventListener('click', handleJsonCodeFormatClick)
  editorRootRef.value?.removeEventListener('paste', handleAttachmentPaste, true)
  editorRootRef.value?.removeEventListener('dragover', handleAttachmentDragOver)
  editorRootRef.value?.removeEventListener('drop', handleAttachmentDrop)
  document.body.classList.remove('markdown-editor-focus-mode')
  if (toolbarEventsBound) {
    document.removeEventListener('click', closeToolbarMenus)
    document.removeEventListener('keydown', handleEditorDocumentKeydown)
  }
  closeToolbarMenus()
  toolbarMenuPanels.clear()
  if (feedbackTimer) clearTimeout(feedbackTimer)
  if (outlineTimer) clearTimeout(outlineTimer)
  if (suppressionTimer) clearTimeout(suppressionTimer)
  const currentEditor = editor
  editor = null
  editorReady = false
  if (currentEditor) void currentEditor.destroy()
})
</script>
