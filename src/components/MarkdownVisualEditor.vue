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
    <div ref="editorScrollRef" class="milkdown-editor-scroll" @scroll.passive="updateActiveOutline">
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
    </aside>
  </div>
</template>

<script setup lang="ts">
import '@milkdown/crepe/theme/common/style.css'
import '@milkdown/crepe/theme/classic.css'
import { EditorView } from '@codemirror/view'
import { Crepe } from '@milkdown/crepe'
import { commandsCtx, editorViewCtx } from '@milkdown/kit/core'
import { redoCommand, undoCommand } from '@milkdown/kit/plugin/history'
import { paragraphSchema } from '@milkdown/kit/preset/commonmark'
import { TextSelection } from '@milkdown/kit/prose/state'
import { replaceAll } from '@milkdown/kit/utils'
import { Icon } from '@iconify/vue'
import { h, nextTick, onBeforeUnmount, onMounted, ref, render, watch } from 'vue'
import { extractMarkdownOutline, type MarkdownOutlineItem } from '../utils/markdown-outline'

interface Props {
  value: string
  documentId?: string
  readonly?: boolean
  showToolbar?: boolean
  showOutline?: boolean
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
  showOutline: true
})
const emit = defineEmits<{
  (event: 'change', value: string, documentId: string): void
}>()

const editorRootRef = ref<HTMLDivElement | null>(null)
const editorScrollRef = ref<HTMLDivElement | null>(null)
const contentValue = ref(props.value)
const outlineItems = ref<MarkdownOutlineItem[]>([])
const outlineOpen = ref(true)
const previewMode = ref(false)
const focusMode = ref(false)
const activeOutlineIndex = ref(0)
const feedbackText = ref('')
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

/**
 * 将编辑区和大纲状态重置到文档顶部。
 *
 * :return: 无返回值。
 */
function resetEditorScroll(): void {
  const scrollContainer = editorScrollRef.value
  if (scrollContainer) scrollContainer.scrollTop = 0
  activeOutlineIndex.value = 0
  void nextTick(() => {
    if (editorScrollRef.value) editorScrollRef.value.scrollTop = 0
  })
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

  document.addEventListener('click', closeToolbarMenus)
  document.addEventListener('keydown', handleEditorDocumentKeydown)
  toolbarEventsBound = true
  syncOutlineToggle()
  syncPreviewToggle()
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
        onCopy: () => showFeedback('复制成功'),
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
  crepe.setReadonly(props.readonly)
  syncPreviewReadonly()
  editorReady = true
  editorMarkdown = contentValue.value
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
  contentValue.value = value
  editorDocumentId = documentId
  scheduleOutlineUpdate(value, documentId)
  if (editor && editorReady && editorMarkdown !== value) replaceContentSilently(value, editor)
  if (documentChanged) resetEditorScroll()
}

watch(
  () => [props.value, props.documentId] as const,
  ([value, documentId]) => setContent(value, documentId)
)
watch(() => props.readonly, syncPreviewReadonly)
onMounted(() => {
  outlineOpen.value = props.showOutline && localStorage.getItem(OUTLINE_STORAGE_KEY) !== 'false'
  scheduleOutlineUpdate(contentValue.value, editorDocumentId)
  void createEditor()
})
onBeforeUnmount(() => {
  const latestMarkdown = editor?.getMarkdown()
  if (!props.readonly && latestMarkdown !== undefined && latestMarkdown !== props.value) {
    emit('change', latestMarkdown, editorDocumentId)
  }
  destroyed = true
  readonlyObserver?.disconnect()
  readonlyObserver = null
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
