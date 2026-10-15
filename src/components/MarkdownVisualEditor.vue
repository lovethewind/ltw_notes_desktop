<template>
  <div
    class="milkdown-editor-shell"
    :class="{
      'has-outline': props.showOutline && outlineOpen,
      'is-preview': previewMode,
      'is-readonly': props.readonly,
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
    <EditorContextMenu
      :visible="editorContextMenu.visible"
      :x="editorContextMenu.x"
      :y="editorContextMenu.y"
      :groups="editorContextMenu.groups"
      @close="closeEditorContextMenu"
      @command="runEditorContextCommand"
    />
    <input
      ref="attachmentInputRef"
      class="attachment-file-input"
      type="file"
      @change="handleAttachmentSelection"
    >
    <div ref="editorScrollRef" class="milkdown-editor-scroll" @scroll.passive="handleEditorScroll">
      <div ref="editorRootRef" class="milkdown-editor-root" />
    </div>
    <!--
      模式条：常驻在编辑区上方（与本地文件预览那条完全同构），编辑 / 预览随时可切。
      它占网格第 1 行并横跨整幅宽度，编辑区与预览层都在第 2 行 —— 两层永远不会跟顶栏抢
      同一条位置；侧栏也整列从第 2 行开始，顶部因此只有一条横线。
      只读上下文（历史预览、冲突对比）里编辑器没有可切的状态，这条不出现。
    -->
    <header v-if="showModeBar" class="markdown-note-mode-bar">
      <Icon
        :icon="previewMode ? 'material-symbols:visibility-outline-rounded' : 'material-symbols:edit-note-rounded'"
      />
      <span class="markdown-note-mode-bar__mode">{{ previewMode ? '预览模式' : '编辑模式' }}</span>
      <span class="markdown-note-mode-bar__hint">
        {{ previewMode ? '只读渲染，正文不会被改动' : '所见即所得，改动直接写进正文' }}
      </span>
      <!--
        大纲开关放在模式条上，不再放 Crepe 顶栏：
        预览层是「盖」在编辑区上的，顶栏（连它那个大纲按钮）整条都被盖住 —— 放到那里的话，
        大纲一旦是关着的，进预览就再也调不出来（`elementFromPoint` 在按钮中心只会拿到预览层）。
        开关与面板同生共死，所以只在 `showOutline` 的上文里出现。
      -->
      <button
        v-if="props.showOutline"
        type="button"
        class="markdown-note-mode-bar__outline"
        :class="{ 'is-active': outlineOpen }"
        :aria-pressed="outlineOpen"
        aria-controls="markdown-outline-panel"
        :aria-label="outlineOpen ? '收起大纲' : '展开大纲'"
        :title="outlineOpen ? '收起大纲' : '展开大纲'"
        @click="toggleOutline"
      >
        <Icon icon="material-symbols:toc-rounded" />
      </button>
      <!--
        「复制 Markdown」也放模式条：它原来在顶栏「更多」里，预览态同样被整层盖住点不到。
        它只读正文、不写文档，所以编辑态与预览态都该能点。
      -->
      <button
        type="button"
        class="markdown-note-mode-bar__copy"
        aria-label="复制 Markdown"
        title="复制 Markdown"
        @click="copyMarkdown"
      >
        <Icon icon="material-symbols:content-copy-outline-rounded" />
      </button>
      <div class="markdown-note-mode-bar__modes" role="group" aria-label="显示模式">
        <button
          type="button"
          class="markdown-note-mode-bar__mode-button"
          :class="{ 'is-active': !previewMode }"
          :aria-pressed="!previewMode"
          @click="setPreviewMode(false)"
        >
          编辑
        </button>
        <button
          type="button"
          class="markdown-note-mode-bar__mode-button"
          :class="{ 'is-active': previewMode }"
          :aria-pressed="previewMode"
          @click="setPreviewMode(true)"
        >
          预览
        </button>
      </div>
    </header>
    <!--
      预览层：把正文按 Markdown 渲染成只读文档（与外部文件预览同一套渲染与排版）。
      它只是「盖」在编辑区上 —— 编辑器不卸载、不隐藏布局，退出预览时阅读位置与撤销栈都在。
      ⚠️ 底色必须不透明：编辑器整层还压在下面，半透明就会把顶栏与正文透出来（两层字叠在一起）。
    -->
    <section v-if="previewMode" class="markdown-note-preview" aria-label="笔记预览">
      <div
        ref="previewScrollerRef"
        class="markdown-note-preview__body"
        @scroll.passive="updateActiveOutline"
      >
        <div
          class="markdown-note-preview__doc markdown-rendered-doc"
          v-html="previewHtml"
          @click="handlePreviewEmbedClick"
          @keydown="handlePreviewEmbedKeydown"
        ></div>
      </div>
    </section>
    <!--
      图片交互的两个浮层自己会传送到 body，挂在这里只是为了随预览层一起装卸。
      工具条跟着鼠标悬停的图片走；查看器是整窗覆盖层。
    -->
    <PreviewImageBar
      v-if="imageBarVisible"
      :anchor="imageBarAnchor"
      :align="imageBarAlign"
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
    <!--
      链接编辑浮层：替换 Crepe 自带那条「一行光秃秃输入框」的编辑气泡。
      它自己会传送到 body（fixed 定位，跟着窗口走），挂在这里只是为了随编辑器一起装卸。
    -->
    <LinkEditPopover
      v-if="linkEditState"
      :anchor="linkEditState.anchor"
      :title="linkEditState.title"
      :href="linkEditState.href"
      :can-remove="Boolean(linkEditState.mark)"
      @save="saveLinkEdit"
      @remove="removeLinkEdit"
      @close="closeLinkEditor"
    />
    <aside
      v-if="props.showOutline && outlineOpen"
      id="markdown-outline-panel"
      class="markdown-outline"
      aria-label="笔记侧栏"
    >
      <!--
        两个视图页签切换，当前页签独占侧栏剩余高度。
        旧结构是三块竖排堆在同一个滚动流里，图谱画布只能拿到写死的 280px 并被挤在末尾。
      -->
      <header class="markdown-outline__header">
        <div class="markdown-outline__tabs" role="tablist" aria-label="侧栏视图">
          <button
            v-for="tab in OUTLINE_TABS"
            :key="tab.id"
            type="button"
            role="tab"
            :aria-selected="outlineTab === tab.id"
            :class="['markdown-outline__tab', { 'is-active': outlineTab === tab.id }]"
            @click="outlineTab = tab.id"
          >
            <Icon :icon="tab.icon" />
            <span>{{ tab.label }}</span>
          </button>
        </div>
        <button type="button" class="markdown-outline__close" aria-label="关闭侧栏" @click="toggleOutline">
          <Icon icon="material-symbols:close-rounded" />
        </button>
      </header>
      <div class="markdown-outline__body">
        <template v-if="outlineTab === 'outline'">
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
        </template>
        <!--
          「关系」页签：顶部二级切换（列表 / 图谱），下方视图区独占剩余高度。
          列表自带滚动、图谱自带尺寸自适应，所以这里用 flex 撑满，而不是让 body 去滚。
        -->
        <div v-else class="relationship-panel">
          <div class="relationship-panel__switch" role="tablist" aria-label="关系视图">
            <button
              v-for="view in RELATIONSHIP_VIEWS"
              :key="view.id"
              type="button"
              role="tab"
              :aria-selected="relationshipView === view.id"
              :class="['relationship-panel__switch-btn', { 'is-active': relationshipView === view.id }]"
              @click="relationshipView = view.id"
            >
              <Icon :icon="view.icon" />
              <span>{{ view.label }}</span>
            </button>
          </div>
          <div class="relationship-panel__view">
            <BacklinksPanel v-if="relationshipView === 'list'" :note-id="props.documentId" />
            <NoteGraphPanel v-else :note-id="props.documentId" />
          </div>
        </div>
      </div>
    </aside>
    <NoteLinkPicker
      :visible="noteLinkPickerVisible"
      :all-notes="props.allNotes"
      :folders="props.folders"
      @close="noteLinkPickerVisible = false"
      @select="insertNoteLink"
    />
    <NoteLinkPicker
      :visible="noteEmbedPickerVisible"
      title="插入笔记嵌入"
      :all-notes="props.allNotes"
      :folders="props.folders"
      @close="noteEmbedPickerVisible = false"
      @select="insertNoteEmbed"
    />
    <LinkSuggestPopover
      :visible="linkSuggestVisible"
      :coords="linkSuggestCoords"
      :items="linkSuggestItems"
      :active-index="linkSuggestIndex"
      :keyword="linkSuggestQuery"
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
import type { Mark as ProseMirrorMark, Node as ProseMirrorNode } from '@milkdown/kit/prose/model'
// 「粘贴（富文本）」需把剪贴板 HTML 解析成 Slice；「粘贴为 Markdown」用 markdownToSlice
import { DOMParser as ProseMirrorDOMParser } from '@milkdown/kit/prose/model'
import {
  paragraphSchema,
  headingSchema,
  blockquoteSchema,
  bulletListSchema,
  orderedListSchema,
  codeBlockSchema,
  clearTextInCurrentBlockCommand,
  addBlockTypeCommand,
  setBlockTypeCommand,
  wrapInBlockTypeCommand
} from '@milkdown/kit/preset/commonmark'
import { AllSelection, TextSelection } from '@milkdown/kit/prose/state'
import { Decoration, DecorationSet, type EditorView as ProseMirrorView } from '@milkdown/kit/prose/view'
import { markdownToSlice, replaceAll } from '@milkdown/kit/utils'
import { installXynoteEmbedFeature } from '../editor/xynote-embed'
import { FONT_SIZE_MARK_NAME, installFontSizeFeature } from '../editor/xynote-font-size'
import { HARDBREAK_NODE_NAME, TABLE_CELL_NODE_NAMES, installHardbreakFeature } from '../editor/xynote-hardbreak'
import { DEFAULT_BODY_FONT_SIZE, FONT_SCALE_STEPS, isBlankText, isDefaultFontSize } from '../utils/inline-font-size'
import { Icon } from '@iconify/vue'
import { computed, defineAsyncComponent, h, nextTick, onBeforeUnmount, onMounted, ref, render, watch } from 'vue'
import { extractMarkdownOutline, type MarkdownOutlineItem } from '../utils/markdown-outline'
import {
  renderPreviewMarkdown,
  resolvePreviewImageSource,
  type PreviewEmbedMeta
} from '../utils/markdown-preview'
import {
  NOTE_EMBED_EXCERPT_LENGTH,
  formatNoteDate,
  stripNoteMarkdown
} from '../utils/note-embed-meta'
import { sanitizePreviewHtml } from '../utils/preview-sanitize'
import { resolvePreviewImageElement } from '../utils/preview-image-tools'
import { formatJsonCode } from '../utils/json-code-formatter.js'
import type { NoteFolder, OfflineNote } from '../types'
import NoteLinkPicker from './NoteLinkPicker.vue'
import EditorContextMenu from './EditorContextMenu.vue'
import type { EditorContextMenuGroup, EditorContextMenuItem } from './EditorContextMenu.vue'
import BacklinksPanel from './BacklinksPanel.vue'
import LinkSuggestPopover from './LinkSuggestPopover.vue'
import PreviewImageBar from './PreviewImageBar.vue'
import PreviewImageViewer from './PreviewImageViewer.vue'
import LinkEditPopover from './LinkEditPopover.vue'
import { linkTooltipAPI, linkTooltipState } from '@milkdown/kit/component/link-tooltip'
import type { LinkEditAnchor } from '../utils/link-edit-popover'
import { usePreviewImageTools } from '../composables/usePreviewImageTools'
import { dispatchOpenNote, EMBED_CARD_MENU_EVENT, type EmbedCardMenuEventDetail } from '../utils/note-open-events'

// 关系图谱仅在展开时用到 d3-force，改为异步组件避免把布局库打进主 chunk。
const NoteGraphPanel = defineAsyncComponent(() => import('./NoteGraphPanel.vue'))

// slash「/」菜单里「嵌入笔记」项的图标（Material Symbols note_add，与工具栏「嵌入笔记」同语义）。
const EMBED_SLASH_ICON = `
  <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="currentColor">
    <path d="M14 3H6C4.9 3 4 3.9 4 5V19C4 20.1 4.9 21 6 21H18C19.1 21 20 20.1 20 19V9L14 3ZM16 17H13V20H11V17H8V15H11V12H13V15H16V17ZM13 10V4.5L18.5 10H13Z" />
  </svg>
`

/**
 * 选中气泡里「字号」触发器的图标：大 A + 小 a（Material Symbols format_size）+ 下拉小箭头。
 *
 * 为什么要把两个 svg 包进一个 `span.xynote-fs-trigger`：Crepe 的 Toolbar 组件给每个项渲染的是
 * 属性写死的 `button.toolbar-item`（只有 `class` / `type`，挂不了自定义 class 或 data-*），
 * 而 `item.icon` 会被当作 HTML 塞进 `span.milkdown-icon`。所以这个 span 既是「在 DOM 里找回
 * 按钮」的锚点（`.closest('.toolbar-item')`），也是 CSS 里 `:has()` 放宽按钮宽度的钩子。
 */
const FONT_SIZE_TRIGGER_ICON = `
  <span class="xynote-fs-trigger">
    <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="currentColor">
      <path d="M9 4v3h5v12h3V7h5V4H9zm-5 5v3h3v7h3v-7h3V9H4z" />
    </svg>
    <svg class="xynote-fs-caret" xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="currentColor">
      <path d="M7 9.5 12 14.5 17 9.5l-1.3-1.3L12 11.9 8.3 8.2z" />
    </svg>
  </span>
`

/**
 * 链接气泡左侧那两个按钮（打开 / 复制）的图标。
 *
 * 背景：Crepe 的 LinkTooltip 只开放一个 `linkIcon` 槽位，而**这个槽位的点击写死是复制**
 * （`@milkdown/components` 的 `Icon` 组件用 `onPointerdown` 触发
 * `navigator.clipboard.writeText`），所以「打开」只能自己抢 —— 图标里塞两个带标记的 span，
 * 再由 `handleLinkTooltipPointerDown` 在**捕获阶段**接管（见该函数注释）。
 *
 * 「打开」带文字标签是有意的：气泡里的 URL 文本已经拿掉（它在编辑浮层里有专门的「地址」一行），
 * 只剩一排光秃秃的图标就看不出哪个是主操作了。
 *
 * ⚠️ 两个标记类名是「打开 / 复制」分流的唯一锚点，删掉任一 span 两处一起坏。
 * 图标本体走 Crepe 同款 viewBox，尺寸由 `src/style.css` 的链接气泡覆写段统一到 19px。
 */
const LINK_TOOLTIP_ACTIONS_ICON = `
  <span class="xynote-link-tooltip-actions">
    <span class="xynote-link-tooltip-open" aria-label="打开链接">
      <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="currentColor">
        <path d="M6.4 19 5 17.6 15.6 7H8V5h13v13h-2V8.4L6.4 19Z" />
      </svg>
      <span class="xynote-link-tooltip-open-label">打开</span>
    </span>
    <span class="xynote-link-tooltip-copy" aria-label="复制链接">
      <svg xmlns="http://www.w3.org/2000/svg" height="24px" viewBox="0 -960 960 960" width="24px" fill="currentColor">
        <path d="M360-240q-33 0-56.5-23.5T280-320v-480q0-33 23.5-56.5T360-880h360q33 0 56.5 23.5T800-800v480q0 33-23.5 56.5T720-240H360Zm0-80h360v-480H360v480ZM200-80q-33 0-56.5-23.5T120-160v-560h80v560h440v80H200Zm160-240v-480 480Z" />
      </svg>
    </span>
  </span>
`

interface Props {
  value: string
  documentId?: string
  readonly?: boolean
  showToolbar?: boolean
  showOutline?: boolean
  scrollTop?: number
  /** 当前工作区全部笔记，供插入链接/嵌入的候选框在未搜索时展示「最近更新」列表。 */
  allNotes?: OfflineNote[]
  /** 当前工作区文件夹树，供候选框把笔记位置解析为完整路径。 */
  folders?: NoteFolder[]
  /**
   * 同步站点域名（网页版地址，如 https://lovethewind.cn）。为空时插入的笔记链接退回本地
   * xinyue-note.local 假域名（目标笔记未同步到云端时同样如此）。
   */
  webBaseUrl?: string
  /**
   * 是否启用笔记库专属能力（附件、插入笔记链接、嵌入笔记、图片上传到本地资产库）。
   *
   * 这些能力会把 xinyue-asset / xinyue-note.local 之类的应用私有地址写进正文，
   * 只适合正文落库的笔记。外部 Markdown 文件曾靠它关掉这些入口，现在改由
   * `MarkdownSourceEditor.vue` 承担（源码编辑，正文直接落回用户磁盘、零污染），
   * 因此当前所有调用点都取默认值 true —— 保留该开关是给「纯文本笔记」这类未来场景。
   */
  noteLibraryEnabled?: boolean
}

interface OutlineCacheEntry {
  markdown: string
  items: MarkdownOutlineItem[]
}

interface ToolbarActionItem {
  action: () => void | Promise<void>
  icon: string
  label: string
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
  scrollTop: 0,
  allNotes: () => [],
  folders: () => [],
  webBaseUrl: '',
  noteLibraryEnabled: true
})
const emit = defineEmits<{
  (event: 'change', value: string, documentId: string): void
  (event: 'scroll-position-change', scrollTop: number, documentId: string): void
}>()

const editorRootRef = ref<HTMLDivElement | null>(null)
const editorScrollRef = ref<HTMLDivElement | null>(null)
const attachmentInputRef = ref<HTMLInputElement | null>(null)
const noteLinkPickerVisible = ref(false)
const noteEmbedPickerVisible = ref(false)
/**
 * 右侧栏的视图页签。同一时刻只显示一个、当前页签独占侧栏剩余高度，
 * 取代旧版「三块竖排 + 单一滚动流」的堆叠方式（那会让关系图谱只能拿到写死的高度并被挤在末尾）。
 *
 * 「关系」页签内部再分「列表 / 图谱」两种画法：两者同源于 note_links，只是呈现粒度不同，
 * 侧栏仅 270px 宽放不下同屏并列，故做成页签内的二级切换。
 */
const OUTLINE_TABS = [
  { id: 'outline', label: '大纲', icon: 'material-symbols:toc-rounded' },
  { id: 'relationship', label: '关系', icon: 'material-symbols:hub-rounded' }
] as const

type OutlineTabId = (typeof OUTLINE_TABS)[number]['id']

/** 「关系」页签内的二级视图：列表看明细，图谱看结构。 */
type RelationshipViewId = 'list' | 'graph'

/** 关系页签内的二级切换项，窄侧栏里直接平铺两个按钮（下拉会多一次交互）。 */
const RELATIONSHIP_VIEWS = [
  { id: 'list', label: '列表', icon: 'material-symbols:format-list-bulleted-rounded' },
  { id: 'graph', label: '图谱', icon: 'material-symbols:hub-rounded' }
] as const

const outlineTab = ref<OutlineTabId>('outline')
const relationshipView = ref<RelationshipViewId>('list')
const linkSuggestVisible = ref(false)
const linkSuggestItems = ref<OfflineNote[]>([])
const linkSuggestIndex = ref(0)
const linkSuggestQuery = ref('')
const linkSuggestCoords = ref<{ left: number, top: number, bottom: number }>({ left: 0, top: 0, bottom: 0 })
const linkSuggestStart = ref<number | null>(null)
let linkSuggestTimer: ReturnType<typeof setTimeout> | undefined

/**
 * `[[` 补全的候选条数上限。
 *
 * 空关键词时取「最近更新」多少条、有关键词时最多取多少条命中。
 * 这两个数字决定用户在浮层里能翻到多少笔记 —— 早先两处都写死 `8`，
 * 而 `LinkSuggestPopover` 的浮层本来就有滚动条与 `max-height`，
 * 有搜索词那支更是先 `searchNotes(limit: 50)` 拿到 50 条再砍成 8 条，
 * 等于白取 42 条。
 */
const LINK_SUGGEST_RECENT_LIMIT = 20
const LINK_SUGGEST_SEARCH_LIMIT = 50

const imageContextMenuElement = ref<HTMLDivElement | null>(null)
const contentValue = ref(props.value)
const outlineItems = ref<MarkdownOutlineItem[]>([])
const outlineOpen = ref(true)
/**
 * 预览模式：把正文换成「Markdown 渲染」的只读视图（与外部文件预览同一套渲染）。
 *
 * 富文本编辑器本身**不卸载也不隐藏布局**，只是被预览层盖住 —— 光标、选区、撤销栈与
 * 滚动位置全都原样留在原处，退出预览与进去之前完全一致。
 */
const previewMode = ref(false)
/** 预览层的滚动容器（供大纲定位 / 位置复位用）。 */
const previewScrollerRef = ref<HTMLElement | null>(null)
/**
 * 图片交互（悬停工具条 + 点击全屏）的作用域容器。
 *
 * 三处入口共用同一份实现（`usePreviewImageTools`）：预览正文是 `v-html` 出来的死 HTML，
 * 编辑器里是 Crepe 的 nodeView，两边都挂不上 Vue 事件，所以整套交互都在容器上做事件委托。
 * 预览层是「盖」在编辑区上的 —— 哪个态在前就用哪个容器。
 */
const imageToolsContainer = computed<HTMLElement | null>(() =>
  previewMode.value ? previewScrollerRef.value : editorScrollRef.value
)
const {
  barVisible: imageBarVisible,
  barAnchor: imageBarAnchor,
  barAlign: imageBarAlign,
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
} = usePreviewImageTools(imageToolsContainer, {
  // 编辑态用左对齐：Crepe 自己的图注按钮占着图片右上角，两边都贴右会叠在一起。
  align: () => (previewMode.value ? 'right' : 'left')
})
/**
 * 是否显示常驻模式条。
 *
 * 只有「可写的笔记编辑器」才有两个模式可切：只读上下文（历史预览、冲突对比）里
 * 预览按钮按下去也会被 `setPreviewMode` 拒掉，所以那条整个不出现。
 */
const showModeBar = computed(() => !props.readonly && props.showToolbar)
/**
 * 字号下拉触发器上显示的数值（px）。
 *
 * 语义跟随选区，**没有「整篇缩放」这一档**（2026-09-24 用户定义）：
 *  - 有选区 → 选区起点处的字号；
 *  - 无选区 → 待用字号（`storedMarks`），其次是光标处的字号；
 *  - 都取不到 → 正文默认值。
 * 具体见 `syncFontSizeMenu()`，在选区/文档变化时刷新。
 */
const fontSizeMenuValue = ref(DEFAULT_BODY_FONT_SIZE)
const activeOutlineIndex = ref(0)
const feedbackText = ref('')
const imageContextMenu = ref({ visible: false, x: 0, y: 0, address: '' })
/** 正文右键菜单状态。visible 控制显示，x/y 为弹出坐标，groups 为当前可用命令分组。 */
const editorContextMenu = ref({
  visible: false,
  x: 0,
  y: 0,
  groups: [] as EditorContextMenuGroup[]
})
/** 卡片右键菜单的当前目标（noteId/title/pos/available），菜单命令执行时读取；关闭菜单后清空。 */
const embedContextTarget = ref<{
  noteId: string
  title: string | null
  serverId: string | null
  pos: number
  available: boolean
} | null>(null)
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
/**
 * 工具栏二级菜单触发器（含「更多」「列表」「插入」与字号下拉）。
 *
 * 字号下拉复用了同一套开关/定位机制，但类名不同，故统一用一个选择器取触发器。
 */
const TOOLBAR_MENU_TOGGLE_SELECTOR = '.markdown-toolbar-menu__toggle, .markdown-font-size-menu__toggle'
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
  // 链接气泡里的链接：点它**就是**「打开」（气泡本来就是为操作这条链接而弹出的），
  // 不再要求 ⌘/Ctrl。⚠️ 这里必须只放行 `.link-display` 那一个 `<a>` —— 气泡里的
  // 编辑 / 删除按钮不是 `<a>`、`closest('a[href]')` 本就返回 null，不受影响。
  const insideLinkTooltip = Boolean(anchor?.closest('.milkdown-link-preview'))
  const shouldOpenLink = insideLinkTooltip
    || previewMode.value
    || props.readonly
    || event.metaKey
    || event.ctrlKey
  // 网页版真实笔记链接 {webUrl}/notes/{serverId}：同样当作内部笔记链接，按 serverId 回落本地打开。
  const webBaseHost = (() => {
    try {
      return props.webBaseUrl ? new URL(props.webBaseUrl).hostname : ''
    } catch {
      return ''
    }
  })()
  if (href && webBaseHost && new URL(href).hostname === webBaseHost) {
    const path = new URL(href).pathname
    const notePathMatch = /^\/notes\/(\d+)\/?$/.exec(path)
    if (notePathMatch) {
      event.preventDefault()
      event.stopPropagation()
      if (event.button !== 0 || !shouldOpenLink) return
      const serverId = notePathMatch[1]
      // 云端 serverId → 由 App.vue 按 serverId 回落本地打开。
      if (serverId) dispatchOpenNote(serverId, true)
      return
    }
  }
  if (href && new URL(href).hostname === 'xinyue-note.local') {
    event.preventDefault()
    event.stopPropagation()
    if (event.button !== 0 || !shouldOpenLink) return
    const noteId = decodeURIComponent(new URL(href).pathname.slice(1))
    // 内部链接 → 新标签页打开（原 IPC openNoteLink 是原地切换当前文档）
    if (noteId) dispatchOpenNote(noteId, true)
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

/**
 * 接管链接气泡左侧「打开」按钮的按下动作。
 *
 * ⚠️ 必须挂在**捕获阶段**：Crepe 给整个 `.link-icon` 挂的是它自己的 `onPointerdown`（复制），
 * 与这里要拦的是**同一节点上下沉层次不同**的两颗监听 —— 冒泡阶段才动手已经晚了，
 * 复制早就跑完了（现象：点「打开」链接进了剪贴板却没跳转）。
 * 捕获阶段先于目标自身触发，`stopPropagation()` 一掐，Crepe 那颗处理器就不会执行。
 *
 * 接管后**直接触发气泡里那个 `<a>` 的点击**，内部笔记 / 附件 / 外链的分流全部照旧
 * （`handleEditorLinkClick` 一并认它），不重复一份路由逻辑。
 *
 * :param event: 指针按下事件。
 * :return: 无返回值。
 */
function handleLinkTooltipPointerDown(event: PointerEvent): void {
  const target = event.target
  if (!(target instanceof Element)) return
  if (!target.closest('.xynote-link-tooltip-open')) return
  event.preventDefault()
  event.stopPropagation()
  if (event.button !== 0) return
  target
    .closest('.milkdown-link-preview')
    ?.querySelector<HTMLAnchorElement>('a.link-display')
    ?.click()
}

/** 链接编辑浮层的当前目标；关闭时置空。 */
interface LinkEditState {
  from: number
  to: number
  /** 编辑已有链接时的原 mark：既用来摘掉旧链接，也用来沿用它的 `title` 属性。 */
  mark: ProseMirrorMark | null
  title: string
  href: string
  anchor: LinkEditAnchor
}

const linkEditState = ref<LinkEditState | null>(null)
/** 当前编辑器 view，供链接编辑浮层读写正文。 */
let linkEditEditorView: ProseMirrorView | null = null
/**
 * 切换 Crepe 链接气泡的模式。
 *
 * 置 `'edit'` 后 Crepe 自己会做两件事：预览气泡立刻隐藏、且悬停时不再把它弹回来
 * （`preview-configure` 里 `mode === 'edit'` 直接 return）。我们复用这条现成机制来表达
 * 「正在编辑这条链接」，不需要自己去抠那个浮层。
 */
let setLinkTooltipMode: ((mode: 'preview' | 'edit') => void) | null = null

/**
 * 量出链接在视口中的包围盒。
 *
 * ⚠️ 不用 `posToDOMRect`：它给的是整块包围盒（多行时会把浮层顶到段落中间去）。
 * `coordsAtPos` 取首尾两个端点的光标矩形，合并后才是链接自身那一段的包围盒。
 *
 * :param view: ProseMirror 视图。
 * :param from: 链接起点。
 * :param to: 链接终点（可与 from 相等，表示新建链接时的光标位）。
 * :return: 视口坐标包围盒；位置失效时返回 null。
 */
function measureLinkAnchor(view: ProseMirrorView, from: number, to: number): LinkEditAnchor | null {
  try {
    const start = view.coordsAtPos(from)
    const end = view.coordsAtPos(to)
    return {
      left: Math.min(start.left, end.left),
      right: Math.max(start.right, end.right),
      top: Math.min(start.top, end.top),
      bottom: Math.max(start.bottom, end.bottom)
    }
  } catch {
    return null
  }
}

/**
 * 打开链接编辑浮层。
 *
 * 由覆写后的 `linkTooltipAPI` 调用 —— 「编辑」按钮与选中气泡里的「链接」按钮走的都是它，
 * 所以两条入口在这里汇成一套界面。
 *
 * :param mark: 已有链接的 mark；新建链接时为 null。
 * :param from: 目标区间起点。
 * :param to: 目标区间终点。
 * :return: 无返回值。
 */
function openLinkEditor(mark: ProseMirrorMark | null, from: number, to: number): void {
  const view = linkEditEditorView
  if (!view) return
  const doc = view.state.doc
  if (from < 0 || to < from || to > doc.content.size) return
  const anchor = measureLinkAnchor(view, from, to)
  linkEditState.value = {
    from,
    to,
    mark,
    title: doc.textBetween(from, to, ''),
    href: typeof mark?.attrs.href === 'string' ? mark.attrs.href : '',
    anchor: anchor ?? { left: 0, right: 0, top: 0, bottom: 0 }
  }
  setLinkTooltipMode?.('edit')
  bindLinkEditTracking()
}

/** 关闭链接编辑浮层，并把焦点还给编辑器。 */
function closeLinkEditor(): void {
  if (!linkEditState.value) return
  linkEditState.value = null
  unbindLinkEditTracking()
  setLinkTooltipMode?.('preview')
  linkEditEditorView?.dom.focus({ preventScroll: true })
}

/** 浮层开着时正文可能滚动、窗口可能缩放，锚点跟着重算，浮层不脱离链接。 */
function refreshLinkEditAnchor(): void {
  const state = linkEditState.value
  const view = linkEditEditorView
  if (!state || !view) return
  const anchor = measureLinkAnchor(view, state.from, state.to)
  if (anchor) linkEditState.value = { ...state, anchor }
}

let linkEditTrackingBound = false

function bindLinkEditTracking(): void {
  if (linkEditTrackingBound) return
  linkEditTrackingBound = true
  // 捕获阶段收 scroll：容器的 scroll 事件不冒泡，只有捕获能拿到。
  window.addEventListener('scroll', refreshLinkEditAnchor, true)
  window.addEventListener('resize', refreshLinkEditAnchor)
}

function unbindLinkEditTracking(): void {
  if (!linkEditTrackingBound) return
  linkEditTrackingBound = false
  window.removeEventListener('scroll', refreshLinkEditAnchor, true)
  window.removeEventListener('resize', refreshLinkEditAnchor)
}

/**
 * 保存链接编辑结果。
 *
 * 「标题」写回链接文字、「地址」写回 href；地址被清空等同于「取消链接」（文字保留）。
 *
 * ⚠️ 附件链接把 mime / 大小存在 mark 的 `title` 属性里（`attachment|mime|size`），
 * 重建 mark 时必须原样带上 —— 丢了它附件就会退化成一条普通外链。
 *
 * :param payload: 浮层提交的标题与地址。
 * :return: 无返回值。
 */
function saveLinkEdit(payload: { title: string, href: string }): void {
  const state = linkEditState.value
  const view = linkEditEditorView
  if (!state || !view) {
    closeLinkEditor()
    return
  }
  const doc = view.state.doc
  const linkMarkType = view.state.schema.marks.link
  const href = payload.href.trim()
  if (!linkMarkType || state.to > doc.content.size) {
    closeLinkEditor()
    return
  }
  if (!href) {
    removeLinkEdit()
    return
  }
  const keptTitle = typeof state.mark?.attrs.title === 'string' ? state.mark.attrs.title : null
  const currentText = doc.textBetween(state.from, state.to, '')
  // 标题留空时：编辑态保留原文，新建态（区间为空）退回用地址当文字 —— 否则会插入一个空文本节点。
  const nextText = payload.title.trim() || (state.from === state.to ? href : currentText)
  const tr = view.state.tr
  if (state.mark) tr.removeMark(state.from, state.to, state.mark)
  if (nextText === currentText) {
    tr.addMark(state.from, state.to, linkMarkType.create({ href, title: keptTitle }))
  } else {
    tr.replaceWith(state.from, state.to, view.state.schema.text(nextText))
    tr.addMark(state.from, state.from + nextText.length, linkMarkType.create({ href, title: keptTitle }))
  }
  view.dispatch(tr)
  closeLinkEditor()
  showFeedback('链接已更新')
}

/** 取消链接：摘掉链接标记、保留文字（与「地址清空后保存」同效）。 */
function removeLinkEdit(): void {
  const state = linkEditState.value
  const view = linkEditEditorView
  const linkMarkType = view?.state.schema.marks.link
  const hadLink = Boolean(state?.mark)
  if (state && view && linkMarkType && state.to <= view.state.doc.content.size) {
    view.dispatch(view.state.tr.removeMark(state.from, state.to, linkMarkType))
  }
  closeLinkEditor()
  if (hadLink) showFeedback('已取消链接')
}

/** 关闭正文图片右键菜单。 */
function closeImageContextMenu(): void {
  imageContextMenu.value.visible = false
}

/**
 * 从右键事件目标解析出对应的正文图片。
 *
 * ⚠️ 图片菜单与正文菜单**必须共用同一判定**（`resolvePreviewImageElement`）：
 * 两个 `contextmenu` 监听器挂在**同一个元素**上（`stopPropagation()` 挡不住兄弟监听器），
 * 两边判「是否图片」的口径一旦不一致，就会「图片菜单弹了、正文菜单也认为自己没点到图片
 * 而跟着弹」—— 一次右键两个菜单叠在一起。编辑态图片块的 `.image-wrapper` 盖在 `img` 之上，
 * 只写 `closest('img')` 必然漏判，正是这个 bug 的现场。
 *
 * :param target: 右键事件的目标元素。
 * :return: 命中的图片元素；目标不是图片时返回 null。
 */
function resolveContextMenuImage(target: Element | null): HTMLImageElement | null {
  return resolvePreviewImageElement(target)
}

/**
 * 在正文图片旁显示复制地址菜单，并确保菜单不超出视口。
 *
 * :param event: 图片右键事件。
 * :return: 无返回值。
 */
function handleImageContextMenu(event: MouseEvent): void {
  const target = event.target instanceof Element ? event.target : null
  const image = resolveContextMenuImage(target)
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

/** 关闭正文右键菜单。 */
function closeEditorContextMenu(): void {
  editorContextMenu.value.visible = false
}

/** 便捷构造单个菜单项（默认可用）。 */
function menuItem(action: string, label: string, opts: { icon?: string, disabled?: boolean, danger?: boolean; children?: EditorContextMenuItem[] } = {}): EditorContextMenuItem {
  return { action, label, icon: opts.icon, disabled: opts.disabled, danger: opts.danger, children: opts.children }
}

/**
 * 构造正文右键菜单分组：按当前选区/历史/只读状态标记可用与置灰。
 *
 * @param view: 编辑器视图（读取选区与 history 状态）。
 * @return 供 EditorContextMenu 渲染的分组数组。
 */
function buildEditorContextGroups(view: ProseMirrorView): EditorContextMenuGroup[] {
  const selection = view.state.selection
  const readonly = props.readonly || previewMode.value
  const hasSelection = !selection.empty
  const canEdit = !readonly
  const canUndo = canEdit && undoDepth(view.state) > 0
  const canRedo = canEdit && redoDepth(view.state) > 0

  return [
    {
      items: [
        menuItem('undo', '撤销', { icon: 'material-symbols:undo-rounded', disabled: !canUndo }),
        menuItem('redo', '重做', { icon: 'material-symbols:redo-rounded', disabled: !canRedo })
      ]
    },
    {
      items: [
        menuItem('cut', '剪切', { icon: 'material-symbols:content-cut-rounded', disabled: !canEdit || !hasSelection }),
        menuItem('copy', '复制', { icon: 'material-symbols:content-copy-rounded', disabled: !hasSelection }),
        menuItem('paste', '粘贴', { icon: 'material-symbols:content-paste-rounded', disabled: !canEdit }),
        menuItem('pastePlain', '粘贴为纯文本', { icon: 'material-symbols:content-paste-off-rounded', disabled: !canEdit }),
        menuItem('pasteMarkdown', '粘贴为 Markdown', { icon: 'material-symbols:markdown-rounded', disabled: !canEdit }),
        menuItem('selectAll', '全选', { icon: 'material-symbols:select-all-rounded' }),
        menuItem('delete', '删除', { icon: 'material-symbols:delete-outline-rounded', disabled: !canEdit || !hasSelection })
      ]
    },
    {
      // 块类型 8 项收进二级菜单：平铺时它们独占整个菜单 586px 里的一半以上，
      // 而顶栏工具栏本来就有全套按钮 —— 右键菜单没必要把工具栏再抄一遍。
      // 禁用判断挂在父项上：父项禁用即整组不出现，子项不再各自判断。
      items: [
        menuItem('blockType', '段落样式', {
          icon: 'material-symbols:format-align-left',
          disabled: !canEdit,
          children: [
            menuItem('paragraph', '正文', { icon: 'material-symbols:notes-rounded' }),
            menuItem('h1', '一级标题', { icon: 'material-symbols:title' }),
            menuItem('h2', '二级标题', { icon: 'material-symbols:title' }),
            menuItem('h3', '三级标题', { icon: 'material-symbols:title' }),
            menuItem('quote', '引用', { icon: 'material-symbols:format-quote-rounded' }),
            menuItem('bulletList', '无序列表', { icon: 'material-symbols:format-list-bulleted-rounded' }),
            menuItem('orderedList', '有序列表', { icon: 'material-symbols:format-list-numbered-rounded' }),
            menuItem('codeBlock', '代码块', { icon: 'material-symbols:code-rounded' })
          ]
        })
      ]
    },
    ...(props.noteLibraryEnabled
      ? [{
        items: [
          menuItem('insertLink', '插入笔记链接', { icon: 'tabler:link', disabled: !canEdit }),
          menuItem('insertEmbed', '插入笔记嵌入', { icon: 'material-symbols:note-add-rounded', disabled: !canEdit })
        ]
      }]
      : [])
  ]
}

/**
 * 构造嵌入卡片右键菜单分组：打开 / 复制嵌入引用 + 转换为链接 / 删除卡片。
 * 后两项需要写文档，故只读或预览态置灰；节点位置不可用（pos<0）时同样置灰。
 *
 * @return 供 EditorContextMenu 渲染的分组数组。
 */
function buildEmbedCardMenuGroups(): EditorContextMenuGroup[] {
  const canEdit = !(props.readonly || previewMode.value)
  const target = embedContextTarget.value
  const hasNode = !!target && target.pos >= 0
  // 目标笔记不存在/已删除时禁用打开类操作，仅保留结构操作（转换/删除）
  const canOpen = !!target?.available
  return [
    {
      items: [
        menuItem('embedOpen', '打开笔记', { icon: 'material-symbols:open-in-new-rounded', disabled: !canOpen }),
        menuItem('embedCopyRef', '复制嵌入引用', { icon: 'material-symbols:content-copy-rounded', disabled: !target })
      ]
    },
    {
      items: [
        menuItem('embedUnwrap', '转换为链接', { icon: 'tabler:link', disabled: !canEdit || !hasNode }),
        menuItem('embedDelete', '删除卡片', { icon: 'material-symbols:delete-outline-rounded', danger: true, disabled: !canEdit || !hasNode })
      ]
    }
  ]
}

/**
 * 右键拦截：目标为正文（非图片）时，弹出正文编辑菜单。
 *
 * @param event: 原生 contextmenu 事件。
 * @return 无返回值。
 */
function handleEditorContextMenu(event: MouseEvent): void {
  if (!editor || !editorReady) return
  // 只读/预览态放行浏览器原生右键（文本仍可复制），仅编辑态弹自定义菜单
  if (props.readonly || previewMode.value) return
  // 图片有独立右键菜单（复制地址）、嵌入卡片有卡片专属菜单，均跳过避免冲突。
  // 卡片内部已 stopPropagation，此处按节点容器再兜底一次，防止宿主结构变化时菜单串台。
  // ⚠️ 图片判定必须与 handleImageContextMenu 共用 resolveContextMenuImage：两个 handler 挂在
  //    同一元素的同一事件上，stopPropagation 挡不住兄弟监听器，只有判据一致才不会双弹。
  const target = event.target instanceof Element ? event.target : null
  if (resolveContextMenuImage(target)) return
  if (target?.closest('.xynote-embed-nodeview')) return
  event.preventDefault()
  event.stopPropagation()
  // 在 editor context 内读取 view 状态后弹出菜单
  editor.editor.action((ctx) => {
    const view = ctx.get(editorViewCtx)
    editorContextMenu.value = {
      visible: true,
      x: Math.min(event.clientX, window.innerWidth - 16),
      y: Math.min(event.clientY, window.innerHeight - 16),
      groups: buildEditorContextGroups(view)
    }
  })
}

/**
 * 嵌入卡片右键（nodeView 经 CustomEvent 冒泡）→ 复用正文右键菜单组件弹出卡片专属操作项。
 *
 * :param event: 卡片派发的 CustomEvent（detail 见 EmbedCardMenuEventDetail）。
 * :return: 无返回值。
 */
function handleEmbedCardMenu(event: Event): void {
  const detail = (event as CustomEvent<EmbedCardMenuEventDetail>).detail
  if (!detail || !editor || !editorReady) return
  if (props.readonly || previewMode.value) return
  embedContextTarget.value = {
    noteId: detail.noteId,
    title: detail.title,
    serverId: detail.serverId ?? null,
    pos: detail.pos,
    available: detail.available
  }
  editorContextMenu.value = {
    visible: true,
    x: Math.min(detail.x, window.innerWidth - 16),
    y: Math.min(detail.y, window.innerHeight - 16),
    groups: buildEmbedCardMenuGroups()
  }
}

/**
 * 执行正文右键菜单命令（按 action 分发）。
 *
 * @param action: 菜单项 action 标识。
 * @return 无返回值。
 */
function runEditorContextCommand(action: string): void {
  closeEditorContextMenu()
  if (!editor || !editorReady) return
  // 嵌入卡片菜单动作（目标来自 embedContextTarget，已在弹出菜单时记录）
  if (action === 'embedOpen' || action === 'embedCopyRef' || action === 'embedUnwrap' || action === 'embedDelete') {
    void runEmbedCardCommand(action)
    return
  }
  // 全选：只读/预览态也允许
  if (action === 'selectAll') {
    editor.editor.action((ctx) => {
      const view = ctx.get(editorViewCtx)
      view.dispatch(view.state.tr.setSelection(new AllSelection(view.state.doc)))
      view.focus()
    })
    return
  }
  // 打开选择器类：依赖渲染层弹窗（外部文件模式下不提供笔记库入口）
  if (action === 'insertLink' || action === 'insertEmbed') {
    if (!props.noteLibraryEnabled) {
      showFeedback('外部文件不支持插入笔记链接或嵌入')
      return
    }
    if (action === 'insertLink') openNoteLinkPicker()
    else openNoteEmbedPicker()
    return
  }
  // 撤销/重做/删除：简单命令
  if (action === 'undo' || action === 'redo' || action === 'delete') {
    editor.editor.action((ctx) => {
      const view = ctx.get(editorViewCtx)
      const commands = ctx.get(commandsCtx)
      if (props.readonly || previewMode.value) return
      if (action === 'undo') commands.call(undoCommand.key)
      else if (action === 'redo') commands.call(redoCommand.key)
      else if (!view.state.selection.empty) view.dispatch(view.state.tr.deleteSelection())
    })
    return
  }
  // 块类型转换
  if (action === 'paragraph' || action === 'quote' || action === 'bulletList'
    || action === 'orderedList' || action === 'codeBlock' || /^h[1-6]$/.test(action)) {
    editor.editor.action((ctx) => {
      const view = ctx.get(editorViewCtx)
      const commands = ctx.get(commandsCtx)
      if (props.readonly || previewMode.value) return
      const { $from } = view.state.selection
      const parent = $from.parent
      // 只读保护：若光标落在嵌入等自定义节点上则不转换
      if (parent.type.name === 'xynoteEmbed') return
      switch (action) {
        case 'paragraph': commands.call(setBlockTypeCommand.key, { nodeType: paragraphSchema.type(ctx) }); break
        case 'quote': commands.call(wrapInBlockTypeCommand.key, { nodeType: blockquoteSchema.type(ctx) }); break
        case 'bulletList':
          commands.call(clearTextInCurrentBlockCommand.key)
          commands.call(wrapInBlockTypeCommand.key, { nodeType: bulletListSchema.type(ctx) }); break
        case 'orderedList':
          commands.call(clearTextInCurrentBlockCommand.key)
          commands.call(wrapInBlockTypeCommand.key, { nodeType: orderedListSchema.type(ctx) }); break
        case 'codeBlock': commands.call(setBlockTypeCommand.key, { nodeType: codeBlockSchema.type(ctx) }); break
        default: {
          const level = Number(action.slice(1))
          commands.call(setBlockTypeCommand.key, { nodeType: headingSchema.type(ctx), attrs: { level } }); break
        }
      }
      view.focus()
    })
    return
  }
  // 剪贴板类动作（复制/剪切/三种粘贴）
  if (action === 'copy' || action === 'cut' || action === 'paste' || action === 'pastePlain' || action === 'pasteMarkdown') {
    void runClipboardAction(action)
  }
}

/**
 * 执行嵌入卡片右键菜单命令。
 *
 * :param action: embedOpen / embedCopyRef / embedUnwrap / embedDelete。
 * :return: 异步完成后无返回值。
 */
async function runEmbedCardCommand(action: string): Promise<void> {
  const target = embedContextTarget.value
  embedContextTarget.value = null
  if (!target || !editor || !editorReady) return
  // 打开笔记：新标签页打开目标（与点击卡片一致）
  // 键优先本机 ID；网页端插入的卡片只有跨端标识，App.vue 的 handleOpenNoteEvent 会按 serverId 回落命中。
  if (action === 'embedOpen') {
    dispatchOpenNote(target.noteId || target.serverId || '', true)
    return
  }
  // 复制嵌入引用：复制 markdown 源码，粘回任意笔记仍是嵌入卡片
  if (action === 'embedCopyRef') {
    const titleAttr = target.title ? ` title="${target.title.replace(/"/g, '&quot;')}"` : ''
    // 与序列化同源：属性顺序固定「本机标识 → 跨端标识 → 标题」，缺值的属性一律不输出 ——
    // 本机 ID 为空（网页端插入的卡片）时写出 `note:` 空值只会污染正文。
    const idAttr = target.noteId ? ` data-xynote-embed="note:${target.noteId}"` : ''
    const serverAttr = target.serverId ? ` data-xynote-embed-server="${target.serverId}"` : ''
    const ref = `<div${idAttr}${serverAttr}${titleAttr}></div>`
    try {
      await navigator.clipboard.writeText(ref)
      showFeedback('已复制嵌入引用')
    } catch {
      showFeedback('复制失败，请检查剪贴板权限')
    }
    return
  }
  if (props.readonly || previewMode.value) return
  if (target.pos < 0) return
  // 删除卡片：删掉整个块节点
  if (action === 'embedDelete') {
    editor.editor.action((ctx) => {
      const view = ctx.get(editorViewCtx)
      const node = view.state.doc.nodeAt(target.pos)
      if (!node || node.type.name !== 'xynoteEmbed') return
      view.dispatch(view.state.tr.delete(target.pos, target.pos + node.nodeSize))
    })
    return
  }
  // 转换为链接：块节点换成含笔记链接的段落（查 serverId 生成线上地址，查不到回落本地）
  if (action === 'embedUnwrap') {
    // 目标键优先本机 ID；网页端插入的卡片只有跨端标识（repository.getNote 内部会按 server_id 回落）。
    const note = await window.notesDesktop
      .getNote(target.noteId || target.serverId || '')
      .catch(() => null)
    // 回落到的笔记 id 才是本机 uuid —— 缺 serverId 时 buildNoteHref 要靠它写内部链接。
    const href = buildNoteHref(note?.id ?? target.noteId, note?.serverId ?? null)
    const label = target.title || note?.title || '笔记链接'
    editor.editor.action((ctx) => {
      const view = ctx.get(editorViewCtx)
      const node = view.state.doc.nodeAt(target.pos)
      if (!node || node.type.name !== 'xynoteEmbed') return
      const { schema } = view.state
      const linkMark = schema.marks.link
      const textNode = schema.text(label, linkMark ? [linkMark.create({ href })] : [])
      const paragraph = schema.nodes.paragraph.create(null, textNode)
      view.dispatch(view.state.tr.replaceWith(target.pos, target.pos + node.nodeSize, paragraph))
    })
  }
}

/**
 * 剪贴板类动作（复制/剪切/粘贴）。
 * 复制读取选区序列化为纯文本；粘贴读剪贴板后插入光标；剪切=复制并删除选区。
 *
 * @param action: copy | cut | paste。
 * @return 异步完成后无返回值。
 */
/**
 * 剪贴板类动作（复制/剪切/三种粘贴方式）。
 *
 * 三种粘贴的区别：
 * - `paste`：**富文本**。走编辑器原生 handlePaste，保留剪贴板里的
 *   标题/列表/表格/图片等结构（不在此处拦截）。
 * - `pastePlain`：**纯文本**。读剪贴板纯文本原样插入，不做任何 Markdown 解析。
 * - `pasteMarkdown`：**Markdown**。读剪贴板文本按 Markdown 解析成富文本节点后插入，
 *   与 `paste` 的差别是「以 Markdown 语法为准」而忽略剪贴板的 HTML 表示
 *   （例如从代码编辑器复制的 `**粗体**` 会渲染成真正加粗，而非字面量）。
 *
 * 复制一律以纯文本写入；剪切=复制并删除选区。
 *
 * @param action: copy | cut | paste | pastePlain | pasteMarkdown。
 * @return 异步完成后无返回值。
 */
async function runClipboardAction(action: string): Promise<void> {
  if (!editor) return
  await editor.editor.action(async (ctx) => {
    const view = ctx.get(editorViewCtx)
    const selection = view.state.selection
    try {
      if (action === 'copy' || action === 'cut') {
        if (selection.empty) { showFeedback('请先选中内容再复制'); return }
        const text = view.state.doc.textBetween(selection.from, selection.to, '\n')
        await navigator.clipboard.writeText(text)
        if (action === 'cut') view.dispatch(view.state.tr.deleteSelection())
        showFeedback('已复制')
      } else if (action === 'paste') {
        // 富文本粘贴：读系统剪贴板的 HTML 表示（渲染层 navigator.clipboard 拿不到 text/html），
        // 用 DOMParser 解析成 Slice 后插入，保留标题/列表/表格/加粗等结构。
        const payload = await window.notesDesktop.readClipboard()
        const html = payload?.html ?? ''
        const text = payload?.text ?? ''
        if (!html && !text) { showFeedback('剪贴板为空'); return }
        if (html) {
          const template = document.createElement('template')
          template.innerHTML = html
          const dom = template.content.cloneNode(true)
          const slice = ProseMirrorDOMParser.fromSchema(view.state.schema).parseSlice(dom)
          view.dispatch(view.state.tr.replaceSelection(slice))
        } else {
          // 剪贴板没有 HTML 表示（如从代码编辑器复制）→ 退化为纯文本插入
          view.dispatch(view.state.tr.insertText(text))
        }
      } else if (action === 'pastePlain') {
        // 纯文本粘贴：原样插入，不解析任何 Markdown 语法
        const text = await navigator.clipboard.readText()
        if (!text) { showFeedback('剪贴板为空'); return }
        view.dispatch(view.state.tr.insertText(text))
      } else if (action === 'pasteMarkdown') {
        // Markdown 粘贴：按 Markdown 语法解析成富文本节点
        const text = await navigator.clipboard.readText()
        if (!text) { showFeedback('剪贴板为空'); return }
        const slice = markdownToSlice(text)(ctx)
        view.dispatch(view.state.tr.replaceSelection(slice))
      }
    } catch {
      showFeedback('剪贴板操作失败，请检查权限')
    }
  })
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
 * 当前阅读容器与它的标题节点。
 *
 * 预览态读的是渲染出来的 HTML，不能再用 `.ProseMirror` 选：那时编辑器虽在 DOM 里，
 * 但被预览层盖住，量出来的位置没有意义。
 *
 * 预览侧还要按 `extractMarkdownOutline` 的同一口径过滤 —— 表格单元格（钉钉式块级渲染）
 * 与引用块里的 `h*` 是**渲染产物**，大纲里根本没有它们，不过滤会让下标整体错位。
 *
 * :return: 滚动容器与按文档顺序排列的标题节点。
 */
function getOutlineScope(): { container: HTMLElement | null, headings: HTMLElement[] } {
  if (previewMode.value) {
    const container = previewScrollerRef.value
    return {
      container,
      headings: container
        ? Array.from(container.querySelectorAll<HTMLElement>('h1, h2, h3, h4, h5, h6'))
          .filter((heading) => !heading.closest('td, th, blockquote, li'))
        : []
    }
  }
  return {
    container: editorScrollRef.value,
    headings: Array.from(editorRootRef.value?.querySelectorAll<HTMLElement>(
      '.ProseMirror h1, .ProseMirror h2, .ProseMirror h3, .ProseMirror h4, .ProseMirror h5, .ProseMirror h6'
    ) ?? [])
  }
}

/**
 * 根据正文滚动位置更新当前大纲项。
 *
 * 阈值 = 跳转落点 + `OUTLINE_ACTIVE_LEAD`：标题顶进入「落点再往下一点」就算当前章节。
 * **必须跟着落点走，不能写死** —— 落点收到 14px 后，旧常量 86 会让紧邻的下一个标题
 * 也落在阈值内（`forEach` 取最后一个满足的），跳转过去高亮却停在下一节。
 *
 * :return: 无返回值。
 */
function updateActiveOutline(): void {
  const { container, headings } = getOutlineScope()
  if (!container || !headings.length) return
  const threshold = container.getBoundingClientRect().top
    + getOutlineScrollInset() + OUTLINE_SCROLL_GAP + OUTLINE_ACTIVE_LEAD
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
  // 预览层是另一个滚动容器，切文档时也要回到开头，否则会继承上一篇的阅读位置。
  if (previewScrollerRef.value) previewScrollerRef.value.scrollTop = nextScrollTop
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
  if (outlineOpen.value) void nextTick(updateActiveOutline)
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
  // 字号下拉**不再**被排除在禁用列表外：它现在会改动文档内容（给选中文字写入
  // `<span style="font-size:…">`），只读/预览态必须和别的格式按钮一样禁掉。
  // 大纲开关与「复制 Markdown」都已不在顶栏（搬到模式条 —— 预览态唯一可点的那条），
  // 「更多」菜单也随之下线，这里不再有需要豁免的项。
  editorRootRef.value
    ?.querySelectorAll<HTMLButtonElement>('.top-bar-heading-selector button, .top-bar-actions .top-bar-item')
    .forEach((button) => {
      button.disabled = isReadonly
    })
  editorRootRef.value?.querySelectorAll<HTMLButtonElement>('.markdown-font-size-menu__item')
    .forEach((button) => {
      button.disabled = isReadonly
    })
  closeToolbarMenus()
}

/**
 * 解析预览里嵌入卡片的展示信息（标题 / 文件夹 / 摘要 / 时间）。
 *
 * 占位 div 的 `title` 属性只有「带标题插入」时才有，实际多数卡片没写，
 * 因此这里按 ID 回查工作区笔记列表 —— 渲染模块本身不认识笔记库，信息只能由这边注入。
 *
 * ⚠️ 摘要是「列表里的纯文本预览」（库侧只存 `content_prefix`，不是全文），
 * 与编辑卡（异步取全文再截断）**同口径但不保证逐字相同**；标题 / 文件夹 / 时间是精确的。
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
 * 预览正文。只读：唯一数据来源是正文本身，渲染结果绝不回流保存链路。
 *
 * 渲染规则（表格单元格的块级处理、公式、嵌入卡片占位）都在 `src/utils/markdown-preview.ts`，
 * 与本地文件预览共用 —— 两处预览必须长得一样，规则只留一份。
 *
 * :return: 已清洗的 HTML 字符串。
 */
function resolvePreviewHtml(): string {
  // 笔记正文没有磁盘路径：传空串，相对路径原样返回（`file:` 与网络地址仍会归一）。
  const parsed = new DOMParser().parseFromString(
    renderPreviewMarkdown(contentValue.value, { resolveEmbedMeta }),
    'text/html'
  )
  for (const image of parsed.querySelectorAll('img')) {
    const resolved = resolvePreviewImageSource(image.getAttribute('src') ?? '', '')
    if (resolved) image.setAttribute('src', resolved)
  }
  // 清洗必须放行 `xinyue-asset:`（本地图片走这个协议），否则 src 会被整条剥掉。
  return sanitizePreviewHtml(parsed.body.innerHTML)
}

/** 只在预览态渲染：关着的时候这个 computed 不被任何渲染读取，也不会白跑一遍解析。 */
const previewHtml = computed(() => (previewMode.value ? resolvePreviewHtml() : ''))

/**
 * 从事件目标里认出嵌入占位卡，取出它指向的笔记 ID。
 *
 * 预览正文是 `v-html` 出来的死 HTML，卡片挂不上 Vue 事件（同预览图片，见
 * `usePreviewImageTools`），只能事件委托；目标 ID 由渲染模块写在 `data-note-id` 上
 * （见 `utils/markdown-preview.ts` 的 `renderEmbedPlaceholder`）。
 *
 * :param target: 事件目标节点。
 * :return: 目标笔记 ID；点到别处返回 null。
 */
function resolvePreviewEmbedNoteId(target: EventTarget | null): string | null {
  if (!(target instanceof Element)) return null
  return target.closest('.markdown-embed-placeholder')?.getAttribute('data-note-id') || null
}

/**
 * 预览里点嵌入占位卡 → 打开被嵌入的那篇笔记。
 *
 * 打开语义与正文里的内部笔记链接一致：**新标签页**，不打断当前阅读位置。
 *
 * :param event: 原生 click 事件。
 * :return: 无返回值。
 */
function handlePreviewEmbedClick(event: MouseEvent): void {
  if (event.button !== 0) return
  const noteId = resolvePreviewEmbedNoteId(event.target)
  if (!noteId) return
  event.preventDefault()
  window.getSelection()?.removeAllRanges()
  dispatchOpenNote(noteId, true)
}

/**
 * 卡片的键盘入口：`role="button"` + `tabindex="0"` 只是让它可聚焦，
 * div 不会因回车自动派发 click，这里补上 —— 否则就是一个「看起来能按、按不动」的假按钮。
 *
 * :param event: 原生 keydown 事件。
 * :return: 无返回值。
 */
function handlePreviewEmbedKeydown(event: KeyboardEvent): void {
  if (event.key !== 'Enter' && event.key !== ' ') return
  const noteId = resolvePreviewEmbedNoteId(event.target)
  if (!noteId) return
  event.preventDefault()
  dispatchOpenNote(noteId, true)
}

/**
 * 切到编辑 / 预览模式。
 *
 * 预览是「盖上去」而不是「换掉」：编辑器对象、DOM 与滚动位置都不动，
 * 所以退出预览后光标、选区、撤销栈、阅读位置全部原样还在。
 *
 * :param next: true = 进预览，false = 回编辑。
 * :return: 无返回值。
 */
function setPreviewMode(next: boolean): void {
  if (props.readonly || !editor || !editorReady) return
  if (previewMode.value === next) return
  previewMode.value = next
  syncPreviewReadonly()
  if (previewMode.value) {
    const activeElement = document.activeElement
    if (activeElement instanceof HTMLElement) activeElement.blur()
    window.getSelection()?.removeAllRanges()
    // 弹层挂在文档里，不收掉会浮在预览层上面（字号下拉、链接候选、右键菜单…）。
    closeToolbarMenus()
    closeLinkSuggest()
    closeEditorContextMenu()
    closeImageContextMenu()
  }
  // 预览层是这一帧才建出来的，滚动位置要等它上屏后才量得准。
  void nextTick(() => {
    // 接着用户刚才读到的位置继续，而不是把长文档拉回开头。
    scrollToOutline(activeOutlineIndex.value, 'auto')
    updateActiveOutline()
  })
}

/** 在两种模式之间来回切（查找这类「先退回编辑态」的内部调用用）。 */
function togglePreview(): void {
  setPreviewMode(!previewMode.value)
}

/**
 * 把字号应用到当前选区 / 待用格式（下拉选中）。
 *
 * ## 语义（2026-09-24 用户定义，与粗体/斜体完全一致）
 *
 *  - **有选区**：给选中的文字单独设字号 —— 写进正文源码，保存后依然在；
 *  - **无选区**（或选区全是空白）：只改 `storedMarks`，即**只有后续新打的字**带这个字号，
 *    已有正文一个字都不动；**没有「整篇缩放」这一档**。
 *  - 设回默认值（15px）时**移除标记**，而不是写一个 `<span style="font-size:15px">` ——
 *    后者与不写等价，却会污染源码。
 *
 * ## 落盘形式
 *
 * markdown 没有行内字号语法，只能落成标准 HTML：
 * `<span style="font-size:18px">…</span>`。Web 端 `marked` 原样保留行内 HTML（已实测），
 * 第三方渲染器（如 GitHub）可能抹掉 style，安全降级为纯文本。
 *
 * :param size: 目标字号（px），取自 FONT_SCALE_STEPS。
 * :return: 无返回值。
 */
function applyInlineFontSize(size: number): void {
  if (!editor || !editorReady) return
  const target = Number.isFinite(size) && size > 0 ? Math.round(size) : DEFAULT_BODY_FONT_SIZE
  const isDefault = isDefaultFontSize(target)
  editor.editor.action((ctx) => {
    const view = ctx.get(editorViewCtx)
    const markType = view.state.schema.marks[FONT_SIZE_MARK_NAME]
    if (!markType) return
    const { state } = view
    const tr = state.tr
    // 空选区、或选区里全是空白（空行/缩进）都按「待用格式」处理：给空白加字号 span
    // 毫无意义，还会在源码里留下 `<span style="font-size:18px"> </span>` 这种垃圾。
    const selectedText = state.doc.textBetween(state.selection.from, state.selection.to, '\n', ' ')
    if (state.selection.empty || isBlankText(selectedText)) {
      // `storedMarks` 是「下一个输入字符将采用的标记集合」，null 表示跟随光标位置。
      const base = state.storedMarks ?? state.selection.$from.marks()
      // 先移除再添加 —— **替换**而非叠加。mark 声明了 `excludes: ''`（为了不影响已有文档里
      // 嵌套的旧标记），`addToSet` 不会顶掉同类型标记，所以必须自己清一遍。
      const next = markType.removeFromSet(base)
      tr.setStoredMarks(isDefault ? next : markType.create({ size: target }).addToSet(next))
    } else {
      state.selection.ranges.forEach((range) => {
        tr.removeMark(range.$from.pos, range.$to.pos, markType)
        if (!isDefault) {
          tr.addMark(range.$from.pos, range.$to.pos, markType.create({ size: target }))
        }
      })
    }
    view.dispatch(tr)
    // 触发器与选项都走 pointerdown + preventDefault，焦点本就不该离开正文；
    // 这里再兜一次，保证「设完字号直接打字」时输入落在编辑器里
    // —— `storedMarks` 只在光标态有效，焦点跑了就白设。
    view.focus()
  })
  fontSizeMenuValue.value = target
  syncFontSizeMenu()
  showFeedback(`字号 ${target}px`)
}

/**
 * 读出当前选区 / 光标处的字号，用于刷新下拉显示与打勾。
 *
 *  - 有选区 → 取**选区起点**处的字号（与粗体按钮的 active 判定同一套口径）；
 *  - 无选区 → 先看待用字号（`storedMarks`），其次看光标处字号；
 *  - 都取不到 → 正文默认值。
 *
 * :return: 字号（px）。
 */
function readSelectionFontSize(): number {
  if (!editor || !editorReady) return DEFAULT_BODY_FONT_SIZE
  let size = DEFAULT_BODY_FONT_SIZE
  editor.editor.action((ctx) => {
    const view = ctx.get(editorViewCtx)
    const markType = view.state.schema.marks[FONT_SIZE_MARK_NAME]
    if (!markType) return
    const { state } = view
    const parsed = Number(markType.isInSet(state.storedMarks ?? state.selection.$from.marks())?.attrs.size)
    if (Number.isFinite(parsed) && parsed > 0) size = parsed
  })
  return size
}

/**
 * 大纲跳转后，标题上方保留的呼吸位。
 *
 * 编辑态还要**另外**让开 Crepe 那条 sticky 顶栏（`.milkdown-top-bar`，实测 48px）：
 * 它压在滚动容器顶部、又不在预览层的裁剪祖先里，不让开就会盖住标题。
 * 预览层的滚动容器上方没有任何遮挡，所以只剩这个呼吸位。
 */
const OUTLINE_SCROLL_GAP = 14

/**
 * 滚动高亮（大纲当前项）相对跳转落点的提前量。
 *
 * 取 24：编辑态下「顶栏 48 + 呼吸 14 + 24 = 86」正好是改动前的阈值，高亮灵敏度零变化；
 * 预览态则是「14 + 24 = 38」。滚动阅读时标题顶还没贴到落点就先亮起来，不会显得迟钝。
 */
const OUTLINE_ACTIVE_LEAD = 24

/**
 * 当前滚动容器顶部被遮住的高度。
 *
 * 顶栏高度按实时矩形取（`getBoundingClientRect`）而不是写死 48：窄窗口下工具项可能换行、
 * 主题与字号也会影响它，同一个常量在别的上下文里就会错位。
 *
 * :return: 被遮挡的像素高度；预览态与没有顶栏的上下文都返回 0。
 */
function getOutlineScrollInset(): number {
  if (previewMode.value) return 0
  const topBar = editorRootRef.value?.querySelector<HTMLElement>('.milkdown-top-bar')
  return topBar ? Math.round(topBar.getBoundingClientRect().height) : 0
}

/**
 * 滚动到指定标题。
 *
 * 落点是「容器顶 + 遮挡高度 + 呼吸位」：标题停在紧贴顶部（编辑态则紧贴顶栏下沿）的位置。
 * 早前两态共用一个写死的 78px —— 那是照编辑态（顶栏 48 + 呼吸 30）定的，
 * 预览层没有顶栏，白白空出 78px，用户看到的就是「跳过去还离顶部老远」。
 *
 * :param index: 标题在文档中的顺序。
 * :param behavior: 滚动行为；进入预览时定位用 `auto`，用户点击大纲用 `smooth`。
 * :return: 无返回值。
 */
function scrollToOutline(index: number, behavior: ScrollBehavior = 'smooth'): void {
  const { container, headings } = getOutlineScope()
  const heading = headings[index]
  if (!container || !heading) return
  const top = heading.getBoundingClientRect().top
    - container.getBoundingClientRect().top
    + container.scrollTop
    - (getOutlineScrollInset() + OUTLINE_SCROLL_GAP)
  activeOutlineIndex.value = index
  container.scrollTo({ top: Math.max(0, top), behavior })
}

/**
 * 将图片保存为桌面端可离线读取的本地资源。
 *
 * :param file: 待插入图片。
 * :return: 本地图片资源地址。
 */
async function uploadImage(file: File): Promise<string> {
  // 图片若走本地资产库，正文会被写入 xinyue-asset:// 私有地址；外部文件要原样落盘，不能带上。
  if (!props.noteLibraryEnabled) {
    showFeedback('外部文件不支持上传图片，请填写本地路径或网页地址')
    throw new Error('外部文件不支持上传图片')
  }
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
 * 根据目标笔记的云端 serverId 与同步域名，构造笔记链接的存储 href。
 *
 * 优先产出网页版真实地址 `{webUrl}/notes/{serverId}`（同步到网页端后天然可点击跳转）；
 * 目标笔记尚未同步（无 serverId）或未配置同步域名时，退回桌面端本地假域名
 * `https://xinyue-note.local/{noteId}`（仅供本机识别，网页端无法解析）。
 *
 * :param noteId: 目标笔记本地 ID。
 * :param serverId: 目标笔记云端 serverId，可为空。
 * :return: 存储到正文链接 mark 的 href。
 */
function buildNoteHref(noteId: string, serverId: string | null): string {
  const base = props.webBaseUrl?.trim()
  if (serverId && base) {
    return `${base.replace(/\/+$/, '')}/notes/${encodeURIComponent(serverId)}`
  }
  return `https://xinyue-note.local/${encodeURIComponent(noteId)}`
}

/**
 * 将选中的笔记以内部链接形式插入当前光标位置。
 *
 * :param noteId: 目标笔记 ID。
 * :param serverId: 目标笔记云端 serverId（可为空，用于生成网页版可点击地址）。
 * :param title: 链接展示用的笔记标题。
 * :return: 无返回值。
 */
async function insertNoteLink(
  noteId: string,
  serverId: string | null,
  title: string
): Promise<void> {
  noteLinkPickerVisible.value = false
  if (!editor || !editorReady || props.readonly) return
  const href = buildNoteHref(noteId, serverId)
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

/**
 * 打开「插入笔记嵌入」选择器（与插入链接共用 NoteLinkPicker，入口独立）。
 *
 * :return: 无返回值。
 */
function openNoteEmbedPicker(): void {
  if (props.readonly) {
    showFeedback('只读模式下无法插入笔记嵌入')
    return
  }
  noteEmbedPickerVisible.value = true
}

/**
 * 将选中的笔记以嵌入卡片形式插入当前光标所在块。
 *
 * 复用 noteEmbed 自定义块节点（src/editor/xynote-embed.ts）：markdown 以
 * `<div data-xynote-embed="note:<id>" data-xynote-embed-server="<serverId>" title="..."></div>`
 * 承载，往返无损；渲染阶段由 nodeView 呈现为真实卡片。
 *
 * :param noteId: 目标笔记 ID（桌面端解析键，始终写本机 ID）。
 * :param serverId: 目标笔记云端 serverId；**有则写进跨端属性供网页端解析**，
 *   未同步时传 null（此时网页端只能降级占位）。详见
 *   docs/specs/2026-10-12-note-embed-web-render.md。
 * :param title: 卡片兜底标题（markdown title 属性，可空）。
 * :return: 无返回值。
 */
async function insertNoteEmbed(noteId: string, serverId: string | null, title: string): Promise<void> {
  noteEmbedPickerVisible.value = false
  if (!editor || !editorReady || props.readonly) return
  if (!noteId) {
    showFeedback('无法插入空笔记嵌入')
    return
  }
  try {
    await editor.editor.action((context) => {
      const commands = context.get(commandsCtx)
      const view = context.get(editorViewCtx)
      const embedType = view.state.schema.nodes.xynoteEmbed
      if (!embedType) throw new Error('笔记嵌入能力不可用')
      // 与 Crepe 内置 image/table 的插入同套路：先清空当前块文本，再把块替换为卡片节点。
      // 由 ProseMirror 命令层处理光标位置，规避手写 transaction 的块内嵌块越界风险。
      commands.call(clearTextInCurrentBlockCommand.key)
      commands.call(addBlockTypeCommand.key, {
        nodeType: embedType,
        // serverId 归一化为 null：选择器在「目标未同步」时可能给空串。
        attrs: { noteId, title: title || null, serverId: serverId || null }
      })
      view.focus()
    })
  } catch (error) {
    showFeedback(error instanceof Error ? error.message : '插入笔记嵌入失败')
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
 * 光标是否落在表格单元格内。
 *
 * 与源码编辑器 `MarkdownSourceEditor.vue` 的 `isInsideTableRow` 对称：
 * 那里按「物理行是否以 `|` 开头」判断，这里按 ProseMirror 祖先节点判断。
 *
 * :param view: ProseMirror 视图。
 * :return: 是 / 否。
 */
function isSelectionInTableCell(view: ProseMirrorView): boolean {
  const { $from } = view.state.selection
  for (let depth = $from.depth; depth > 0; depth -= 1) {
    if (TABLE_CELL_NODE_NAMES.includes($from.node(depth).type.name)) return true
  }
  return false
}

/**
 * 在表格单元格内用 `Shift+Enter` 插入硬换行（`<br>`）。
 *
 * ## 为什么需要这个 handler
 *
 * Crepe 的 commonmark preset 注册了 `hardbreakFilterPlugin`
 * （`@milkdown/preset-commonmark/lib/index.js:1984`），它读取
 * `hardbreakFilterNodes` ctx（默认值 `["table", "code_block"]`）并**拒绝**在表格内插入 hardbreak
 * —— 所以内置 `Shift-Enter` 在单元格里静默失效（实测：按键后既不换行也不报错）。
 *
 * 这里改用本项目的 `xynoteHardbreak` 内联节点，它：
 *  - 不经 `hardbreakFilterPlugin`（该插件只拦带 `hardbreak` meta 的事务）；
 *  - 序列化时 `toMarkdown` 回写 html 节点 `<br>`（**实测表格单元格内逐字节往返**，
 *    而内置 hardbreak 在单元格里会被 remark-stringify 压成空格）。
 *
 * :param view: ProseMirror 视图。
 * :param event: 键盘事件。
 * :return: 是否已处理（非表格内一律返回 false，交回默认行为）。
 */
function insertTableCellHardBreak(view: ProseMirrorView, event: KeyboardEvent): boolean {
  if (props.readonly) return false
  if (event.key !== 'Enter' || !event.shiftKey) return false
  if (!isSelectionInTableCell(view)) return false
  const type = view.state.schema.nodes[HARDBREAK_NODE_NAME]
  if (!type) return false
  event.preventDefault()
  view.dispatch(
    view.state.tr
      .replaceSelectionWith(type.create())
      .scrollIntoView()
  )
  return true
}

/**
 * 在存在补全时拦截方向键、回车与 Esc，避免编辑器默认行为。
 *
 * :param view: ProseMirror 视图。
 * :param event: 键盘事件。
 * :return: 是否已处理。
 */
function handleSuggestKeydown(view: unknown, event: KeyboardEvent): boolean {
  // 表格单元格内的 Shift+Enter：抢在内置 keymap（被 hardbreakFilterPlugin 拦掉）之前接管
  if (insertTableCellHardBreak(view as ProseMirrorView, event)) return true
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
          .slice(0, LINK_SUGGEST_RECENT_LIMIT)
      } else {
        const notes = await window.notesDesktop.searchNotes(text, { limit: LINK_SUGGEST_SEARCH_LIMIT })
        const query = text.toLowerCase()
        linkSuggestItems.value = notes
          .filter((note) => !note.isDeleted)
          .sort((a, b) => {
            const A = a.title.toLowerCase().includes(query) ? 0 : 1
            const B = b.title.toLowerCase().includes(query) ? 0 : 1
            if (A !== B) return A - B
            return b.updatedAt.localeCompare(a.updatedAt)
          })
          .slice(0, LINK_SUGGEST_SEARCH_LIMIT)
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
  insertNoteLinkFromPos(note.id, note.serverId ?? null, note.title || '（无标题）')
}

/**
 * 用选中笔记替换 [ [ 补全片段，生成内部链接。
 *
 * :param noteId: 目标笔记 ID。
 * :param serverId: 目标笔记云端 serverId（可为空，用于生成网页版可点击地址）。
 * :param title: 链接展示标题。
 * :return: 无返回值。
 */
function insertNoteLinkFromPos(noteId: string, serverId: string | null, title: string): void {
  const start = linkSuggestStart.value
  const view = linkSuggestEditorView
  closeLinkSuggest()
  if (start === null || !editor || props.readonly) return
  const href = buildNoteHref(noteId, serverId)
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
    menu.querySelector<HTMLButtonElement>(TOOLBAR_MENU_TOGGLE_SELECTOR)?.setAttribute('aria-expanded', 'false')
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
  const toggle = menu.querySelector<HTMLButtonElement>(TOOLBAR_MENU_TOGGLE_SELECTOR)
  if (!toggle) return
  const toggleRect = toggle.getBoundingClientRect()
  document.body.append(panel)
  panel.classList.add('is-portal-open')
  const panelWidth = panel.offsetWidth
  const centeredLeft = toggleRect.left + toggleRect.width / 2 - panelWidth / 2
  // 字号下拉左对齐到触发器边缘，其余居中 —— 与各自面板的静态定位保持一致。
  const alignedLeft = menu.classList.contains('markdown-font-size-menu') ? toggleRect.left : centeredLeft
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
  menu.querySelector<HTMLButtonElement>(TOOLBAR_MENU_TOGGLE_SELECTOR)?.setAttribute('aria-expanded', String(shouldOpen))
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
  button.dataset.action = item.label
  button.dataset.label = item.label
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

/**
 * 同步字号下拉的选中态与触发器文案。
 *
 * 触发器只显示数值（如「15」），与钉钉字号下拉一致；面板里当前档位打勾。
 * 显示值来自 `fontSizeMenuValue`，由 `refreshFontSizeMenu()` 按选区刷新。
 *
 * :return: 无返回值。
 */
function syncFontSizeMenu(): void {
  const menu = editorRootRef.value?.querySelector<HTMLElement>('.markdown-font-size-menu')
  if (!menu) return
  // 面板展开时会被 portal 到 body，选项不在 menu 子树里 —— 用面板映射兜底查找。
  const panel = toolbarMenuPanels.get(menu) ?? menu
  const current = fontSizeMenuValue.value
  panel.querySelectorAll<HTMLButtonElement>('.markdown-font-size-menu__item').forEach((button) => {
    const isActive = Number(button.dataset.fontSize) === current
    button.classList.toggle('active', isActive)
    button.setAttribute('aria-checked', String(isActive))
  })
  const value = menu.querySelector<HTMLElement>('.markdown-font-size-menu__value')
  if (value) value.textContent = String(current)
}

/**
 * 按当前选区重读字号并刷新下拉（选区/文档变化时调用）。
 *
 * 单独抽一层是因为语义已从「整篇显示参数」变成「跟随选区的格式」：
 * 移动光标就要重算，`fontSizeMenuValue` 不能只在用户点下拉时更新。
 *
 * :return: 无返回值。
 */
function refreshFontSizeMenu(): void {
  fontSizeMenuValue.value = readSelectionFontSize()
  syncFontSizeMenu()
}

/**
 * 创建字号选项面板（顶栏下拉与选中气泡共用同一份 DOM 结构与交互）。
 *
 * ## ⚠️ 选项必须用 pointerdown + preventDefault
 *
 * 两个独立的坑都靠它解决：
 *  1. 无选区时「设字号」改的是 `storedMarks`（待用格式），而 `storedMarks` 一旦编辑器失焦
 *     就被清掉 —— 表现出来是「选了 20px，打出来还是 15px」，全程无报错；
 *  2. 选中气泡的显示条件里有一条「`document.activeElement` 必须在正文或气泡内」，
 *     焦点一旦跑到面板上，气泡会自己消失。
 *
 * :return: 面板节点。
 */
function createFontSizePanel(): HTMLDivElement {
  const panel = document.createElement('div')
  panel.className = 'markdown-font-size-menu__panel'
  panel.setAttribute('role', 'listbox')
  panel.setAttribute('aria-label', '字号')
  panel.addEventListener('pointerdown', (event) => event.stopPropagation())
  panel.addEventListener('click', (event) => event.stopPropagation())

  FONT_SCALE_STEPS.forEach((size) => {
    const option = document.createElement('button')
    option.type = 'button'
    option.className = 'markdown-font-size-menu__item'
    option.dataset.fontSize = String(size)
    option.setAttribute('role', 'option')
    option.setAttribute('aria-label', `${size}px`)
    // 用真实文本节点而非 ::after 伪元素 —— 伪元素内容不进 textContent，
    // 列表项对读屏与自动化都取不到文本。
    option.textContent = String(size)
    // 初始选中态在创建时就设好：顶栏下拉这一刻还没插进 DOM（调用方还要 heading.after(...)），
    // 走 syncFontSizeMenu() 查询会落空，导致打开下拉时「一项都没打勾」。
    // 气泡面板会在打开时整体重算，不依赖这个初值。
    const isActive = size === fontSizeMenuValue.value
    option.classList.toggle('active', isActive)
    option.setAttribute('aria-checked', String(isActive))
    option.addEventListener('pointerdown', (event) => {
      event.preventDefault()
      event.stopPropagation()
      applyInlineFontSize(size)
      closeToolbarMenus()
    })
    // 见上方说明：pointerdown 被 preventDefault 后浏览器仍可能补一个 click，
    // 它冒泡到 document 会被 closeToolbarMenus 捕获，把刚关掉/刚打开的面板状态打乱。
    option.addEventListener('click', (event) => event.stopPropagation())
    panel.append(option)
  })
  return panel
}

/**
 * 创建字号下拉（挂在「一级标题」块类型选择器之后）。
 *
 * 触发器结构与 Crepe 的块类型按钮对齐（数值 + 箭头），点开是一列字号，当前档位打勾。
 * 选项面板与选中气泡里的那份由 `createFontSizePanel()` 共用。
 *
 * ## ⚠️ 必须用 pointerdown 而不是 click
 *
 * 见 `createFontSizePanel()` 的两条说明（`storedMarks` 失焦即丢 / 气泡失焦即消失）。
 *
 * :return: 下拉容器。
 */
function createFontSizeMenu(): HTMLDivElement {
  const menu = document.createElement('div')
  menu.className = 'markdown-font-size-menu'

  const toggle = document.createElement('button')
  toggle.type = 'button'
  toggle.className = 'markdown-font-size-menu__toggle top-bar-item'
  toggle.dataset.label = '字号'
  toggle.setAttribute('aria-label', '字号')
  toggle.setAttribute('aria-haspopup', 'listbox')
  toggle.setAttribute('aria-expanded', 'false')

  const value = document.createElement('span')
  value.className = 'markdown-font-size-menu__value'
  value.textContent = String(fontSizeMenuValue.value)
  const chevron = document.createElement('span')
  chevron.className = 'markdown-font-size-menu__chevron'
  chevron.setAttribute('aria-hidden', 'true')
  render(h(Icon, { icon: 'material-symbols:keyboard-arrow-down-rounded', 'aria-hidden': 'true' }), chevron)
  toggle.append(value, chevron)

  const panel = createFontSizePanel()

  toggle.addEventListener('pointerdown', (event) => {
    event.preventDefault()
    event.stopPropagation()
    toggleToolbarMenu(menu)
  })
  // 同理：刚打开的菜单不能被随后补上的 click 立刻关掉。
  toggle.addEventListener('click', (event) => event.stopPropagation())

  menu.append(toggle, panel)
  toolbarMenuPanels.set(menu, panel)
  return menu
}

/**
 * 选中气泡里「字号」面板的宿主占位节点（不可见）。
 *
 * Crepe 的 Toolbar 组件在**每次选区变化时都会重渲染**，往气泡里插自己的 DOM 会被 Vue 清掉，
 * 所以面板实际挂到 `document.body`；但 `closeToolbarMenus()` 的统一关闭逻辑是按
 * 「宿主元素 → 面板」映射驱动的，故造一个隐藏宿主挂进编辑器根节点，把这套关闭机制复用过来。
 */
let bubbleFontSizeHost: HTMLDivElement | null = null

/**
 * 在选中气泡里找回「字号」触发器按钮。
 *
 * Crepe 的 Toolbar 只给每个项渲染属性写死的 `button.toolbar-item`（挂不了自定义属性），
 * 所以拿图标里的标记 span 作为锚点反查（见 `FONT_SIZE_TRIGGER_ICON`）。
 *
 * :return: 触发器按钮；气泡尚未渲染时返回 null。
 */
function findBubbleFontSizeTrigger(): HTMLElement | null {
  const marker = editorRootRef.value?.querySelector<HTMLElement>('.milkdown-toolbar .xynote-fs-trigger')
  return marker?.closest<HTMLElement>('.toolbar-item') ?? null
}

/**
 * 按当前选区刷新气泡字号面板的打勾状态。
 *
 * 气泡只在有选区时出现，所以这里读到的必然是选区起点处的字号（与 B/I/S 的 active 同一口径）。
 *
 * :param panel: 字号面板。
 * :return: 无返回值。
 */
function syncBubbleFontSizePanel(panel: HTMLDivElement): void {
  const current = readSelectionFontSize()
  panel.querySelectorAll<HTMLButtonElement>('.markdown-font-size-menu__item').forEach((button) => {
    const isActive = Number(button.dataset.fontSize) === current
    button.classList.toggle('active', isActive)
    button.setAttribute('aria-checked', String(isActive))
  })
}

/**
 * 开合选中气泡内的字号面板（贴在「字号」按钮正下方）。
 *
 * 复用顶栏那套「portals 到 body + `is-portal-open` 固定定位 + `toolbarMenuPanels` 统一关闭」，
 * 因此滚动、失焦、切换预览等既有路径都能把它一并收掉。
 *
 * :return: 无返回值。
 */
function toggleBubbleFontSizePanel(): void {
  const trigger = findBubbleFontSizeTrigger()
  if (!trigger) return

  const wasOpen = bubbleFontSizeHost?.classList.contains('is-open') ?? false
  closeToolbarMenus()
  if (wasOpen) return

  if (!bubbleFontSizeHost) {
    bubbleFontSizeHost = document.createElement('div')
    bubbleFontSizeHost.className = 'markdown-font-size-menu__bubble-host'
    bubbleFontSizeHost.hidden = true
    toolbarMenuPanels.set(bubbleFontSizeHost, createFontSizePanel())
  }
  editorRootRef.value?.append(bubbleFontSizeHost)
  const panel = toolbarMenuPanels.get(bubbleFontSizeHost)
  if (!panel) return

  syncBubbleFontSizePanel(panel)
  bubbleFontSizeHost.classList.add('is-open')
  document.body.append(panel)
  panel.classList.add('is-portal-open')

  const rect = trigger.getBoundingClientRect()
  const panelWidth = panel.offsetWidth
  const panelHeight = panel.offsetHeight
  const left = Math.max(12, Math.min(rect.left + rect.width / 2 - panelWidth / 2, window.innerWidth - panelWidth - 12))
  panel.style.left = `${left}px`
  // ⚠️ 默认贴在按钮**下方**，但面板已有 17 档、最高 320px：按钮一旦落在窗口下半部，
  // 原来的「贴下方 + clamp 进窗口」会把面板顶回去**盖在按钮上**。后果有两个：
  //   1. 用户没法再点同一个按钮把面板收起来（按钮被盖住了）；
  //   2. 更糟 —— 松开鼠标时落点注定在面板里，`click` 的 target 变成 BODY，
  //      关闭守卫落空、面板当场消失（见 trackBubbleFontSizePointerDown()）。
  // 所以下方放不下时**翻到按钮上方**，两边都放不下才退回 clamp。
  const gap = 8
  const fitsBelow = rect.bottom + gap + panelHeight <= window.innerHeight - 12
  const fitsAbove = rect.top - gap - panelHeight >= 12
  const top = fitsBelow || !fitsAbove ? rect.bottom + gap : rect.top - gap - panelHeight
  panel.style.top = `${Math.max(12, Math.min(top, window.innerHeight - panelHeight - 12))}px`
}

/**
 * 「这次按下是否落在气泡的字号按钮上」—— 留给随后那次 click 判定用。
 *
 * 为什么不能直接看 click 的落点，见 `trackBubbleFontSizePointerDown()` 的说明。
 */
let bubbleFontSizeArmed = false

/**
 * 记录「这次 pointerdown 是否落在气泡的字号按钮上」。
 *
 * 面板的**打开**动作在 `pointerdown`（Crepe 的 Toolbar 只监听 pointerdown），而 **收起**动作在
 * `document` 上常驻的 `closeToolbarMenus`（监听 click）；不拦住紧随其后的 click，面板刚开就会被关。
 *
 * ## ⚠️ 判定必须用「按下」的落点，不能用「松开」的落点
 *
 * `click` 的 target 是 mousedown 与 mouseup 两点的**最近公共祖先**，而面板就贴在按钮下方 8px 处
 * 展开 —— 真人松开时只要比按下时低 8px 以上，`mouseup` 就落进面板里，`click` 的 target 直接从
 * `BUTTON.toolbar-item` 变成 `BODY`，任何基于 `closest()` 的落点判定都会**静默落空**
 * （实测：原地松开 target 是 `BUTTON.toolbar-item`，下飘 20px 变成 `DIV.milkdown-toolbar`，
 * 落进面板变成 `BODY`）。现象就是「按住时面板在，一松手就没了」。
 *
 * 而 `pointerdown` 发生在**面板打开之前**，落点还没被面板遮住，也不受松开那一刻位移的影响
 * —— 与 Crepe 自己开合面板用的是同一个事件、同一个落点口径，天然不会跑偏。
 *
 * 标记 span（`.xynote-fs-trigger`）只是按钮内的锚点，所以先回到**整个按钮**再反查它：
 * 按钮被 `:has()` 从 30px 放宽到 43px（给下拉箭头留位），落在左右留白上时
 * `event.target` 是 `button` 本身，只认 span 会命中不到。
 *
 * :param event: 指针按下事件。
 * :return: 无返回值。
 */
function trackBubbleFontSizePointerDown(event: PointerEvent): void {
  const target = event.target as Element | null
  const item = target?.closest?.<HTMLElement>('.milkdown-toolbar .toolbar-item')
  bubbleFontSizeArmed = Boolean(item?.querySelector('.xynote-fs-trigger'))
}

/**
 * 放行「按下气泡字号按钮」之后补上的那次 click。
 *
 * 只看 `trackBubbleFontSizePointerDown()` 在**按下时**打的标记，不看这次 click 的落点
 * （原因见该函数）。必须注册在**捕获阶段**，早于 document 冒泡阶段注册的 `closeToolbarMenus`。
 *
 * :param event: 点击事件。
 * :return: 无返回值。
 */
function guardBubbleFontSizeClick(event: MouseEvent): void {
  if (!bubbleFontSizeArmed) return
  bubbleFontSizeArmed = false
  event.stopPropagation()
}

/** 盯气泡 `style` 属性的观察器（floating-ui 每次写完坐标都会触发）。 */
let bubbleAvoidObserver: MutationObserver | null = null

/** 等气泡容器出现的一次性观察器（Crepe 首帧不一定已经把它挂进 `.milkdown`）。 */
let bubbleAppearObserver: MutationObserver | null = null

/**
 * 气泡撞到顶栏时，把它翻到**选区下方**。
 *
 * ## 为什么需要这一步
 *
 * 顶栏是 `position: sticky` 且在**滚动容器内部**（`.milkdown-editor-scroll` 里），而
 * floating-ui 的 `flip()` 只按「裁剪祖先」算空间 —— 顶栏占的那 48px 照样算「上方有空间」，
 * 于是气泡不会翻转，直接落在 `选区 top − 10 − 46` 处。若选区就在文档首行（或滚动后紧贴顶栏
 * 的那一行），气泡的上半截会插进顶栏里：实测顶栏 bottom=242 而气泡 top=226.5，
 * **15.5px 被盖住**，连 12px 圆角一起被吃掉（看起来「上沿切平、贴在顶栏下沿」）。
 *
 * 层级那边另有兜底（`src/style.css` 把气泡抬到 z-index 30），但那只能保证「不被吃掉」，
 * 会变成气泡糊在顶栏上；这里负责给出真正合理的落点 —— 与钉钉 / Word 一致：
 * **上方放不下就翻到选区下方**。
 *
 * ## 为什么用 MutationObserver 盯 `style`
 *
 * 坐标是 floating-ui 在 `computePosition()` 的 promise 里写进内联样式的（还带 20ms 节流），
 * 项目侧接不到它的回调，也无法给它注入 middleware（Crepe 把 TooltipProvider 写死在
 * `feature/toolbar/index.js` 里）。**它写坐标的那一刻**就是唯一可靠的时机。
 *
 * 不会和它打架：只在「气泡确实压住了顶栏」时才动手，且位移小于 0.5px 直接返回 ——
 * 自己写进去的 top 会再触发一次回调，那次判定必然「没撞上」（气泡已被挪到顶栏下方），
 * 于是自激在第一轮就停住。
 *
 * :param toolbar: 气泡容器 `.milkdown-toolbar`。
 * :return: 无返回值。
 */
function avoidToolbarTopBarCover(toolbar: HTMLElement): void {
  const topBar = editorRootRef.value?.querySelector<HTMLElement>('.milkdown-top-bar')
  if (!topBar) return
  const rect = toolbar.getBoundingClientRect()
  // 隐藏态（`data-show="false"` → `display: none`）尺寸全为 0，直接跳过。
  if (rect.height <= 0 || rect.width <= 0) return

  const barRect = topBar.getBoundingClientRect()
  // 没压住顶栏就什么都不做 —— 保持 floating-ui 的原生落点。
  if (rect.top >= barRect.bottom - 0.5) return

  const gap = 8
  // 首选：贴着选区下方 10px（与 floating-ui 的 offset 同量级）。
  const selection = window.getSelection()
  const selectionRect = selection?.rangeCount ? selection.getRangeAt(0).getBoundingClientRect() : null
  let targetTop = selectionRect && selectionRect.height > 0 ? selectionRect.bottom + 10 : Number.NaN
  // 选区拿不到、或翻下去仍会压住顶栏时，退化成「贴着顶栏下沿」。
  if (!Number.isFinite(targetTop) || targetTop < barRect.bottom + gap) targetTop = barRect.bottom + gap
  // 别掉出视口下沿（长文档 + 选区贴近底部时的兜底）。
  targetTop = Math.min(targetTop, window.innerHeight - gap - rect.height)

  // ⚠️ 用「当前内联 top + 需要下移多少」增量算，不要自己拼绝对坐标 ——
  // 内联 top 是相对气泡 offsetParent（实测是 `.milkdown`）的，绝对值换算要处理它的
  // 边框 / 滚动偏移，增量法天然免疫。
  const currentTop = Number.parseFloat(toolbar.style.top) || 0
  const nextTop = currentTop + (targetTop - rect.top)
  if (Math.abs(nextTop - currentTop) < 0.5) return
  toolbar.style.top = `${nextTop}px`
}

/**
 * 给气泡挂上避让观察器（floating-ui 每写一次坐标就检查一次）。
 *
 * :param toolbar: 气泡容器。
 * :return: 无返回值。
 */
function observeBubbleTopBarCover(toolbar: HTMLElement): void {
  bubbleAvoidObserver?.disconnect()
  bubbleAvoidObserver = new MutationObserver(() => avoidToolbarTopBarCover(toolbar))
  bubbleAvoidObserver.observe(toolbar, { attributes: true, attributeFilter: ['style'] })
}

/**
 * 启动「气泡避让顶栏」。
 *
 * 气泡容器是 Crepe 在首次 update 时才挂进 `.milkdown` 的，创建编辑器那一刻不一定存在；
 * 不存在就先拿一个只盯 `.milkdown` 直接子节点的观察器等它出现，出现后再换成盯 `style` 的那个。
 *
 * :return: 无返回值。
 */
function startBubbleTopBarAvoidance(): void {
  const root = editorRootRef.value
  if (!root) return
  const toolbar = root.querySelector<HTMLElement>('.milkdown-toolbar')
  if (toolbar) {
    observeBubbleTopBarCover(toolbar)
    return
  }
  const milkdown = root.querySelector<HTMLElement>('.milkdown')
  if (!milkdown) return
  bubbleAppearObserver?.disconnect()
  bubbleAppearObserver = new MutationObserver(() => {
    const appeared = root.querySelector<HTMLElement>('.milkdown-toolbar')
    if (!appeared) return
    bubbleAppearObserver?.disconnect()
    bubbleAppearObserver = null
    observeBubbleTopBarCover(appeared)
  })
  bubbleAppearObserver.observe(milkdown, { childList: true })
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
  // 外部文件模式下不提供会写入应用私有地址的入口（附件/笔记链接/嵌入笔记）。
  const noteLibraryActions = props.noteLibraryEnabled
    ? [
      createToolbarActionButton({ label: '附件', icon: 'tabler:paperclip', action: openAttachmentPicker }),
      createToolbarActionButton({ label: '插入笔记链接', icon: 'tabler:link', action: openNoteLinkPicker }),
      createToolbarActionButton({ label: '嵌入笔记', icon: 'material-symbols:note-add', action: openNoteEmbedPicker })
    ]
    : []
  const insertMenu = createToolbarMenu({
    key: 'insert', label: '插入', icon: 'material-symbols:add-box-outline-rounded'
  }, [
    ...noteLibraryActions,
    ...pickButtons(['表格', '公式', '引用', '分隔线']),
    createToolbarActionButton({ label: '行内公式', icon: 'material-symbols:functions-rounded', action: toggleInlineFormula })
  ])
  // 「更多」菜单随「复制 Markdown」「专注模式」一起下线：前者搬到常驻模式条
  // （预览态顶栏被整层盖住，放这里点不到），后者整体去掉。
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
    insertMenu
  )
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
    refreshFontSizeMenu()
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
  // 字号下拉紧跟「一级标题」块类型选择器之后 —— 两者都作用于选中内容的排版格式，
  // 放一起比埋进「更多」菜单里少一次点击。
  heading.after(createFontSizeMenu())
  groupTopBarActions(actions)

  if (!toolbarEventsBound) {
    document.addEventListener('click', closeToolbarMenus)
    document.addEventListener('keydown', handleEditorDocumentKeydown)
    toolbarEventsBound = true
  }
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
        blockHandle: { getOffset: () => 5 },
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
        },
        // 在 slash「/」命令菜单里追加「嵌入笔记」项（Obsidian 式快捷插入；选择器复用既有 NoteLinkPicker）
        buildMenu: (builder) => {
          if (!props.noteLibraryEnabled) return
          const adv = builder.getGroup('advanced')
          adv?.addItem('xynote-embed', {
            label: '嵌入笔记',
            icon: EMBED_SLASH_ICON,
            onRun: () => {
              if (props.readonly) {
                showFeedback('只读模式下无法插入笔记嵌入')
                return
              }
              // 只弹出笔记选择器，不动编辑器文本（保留 `/xxx`）；选完由 insertNoteEmbed 清块后插入卡片，
              // 中途取消则 `/xxx` 原样保留（slash hide 不清选区，ProseMirror selection 仍锚定在原块）。
              openNoteEmbedPicker()
            }
          })
        }
      },
      [Crepe.Feature.LinkTooltip]: {
        inputPlaceholder: '粘贴链接地址…',
        // 左槽位改造成「打开 / 复制」两个按钮（Crepe 原本只给一个复制按钮、且点了没有任何提示）。
        linkIcon: LINK_TOOLTIP_ACTIONS_ICON,
        onCopyLink: () => showFeedback('链接已复制')
      },
      // 选中气泡（选区上方浮出的 B/I/S 工具条）里追加「字号」下拉。
      // Crepe 的 Toolbar 只给每项渲染一个写死属性的 icon 按钮，没有下拉/文字能力，
      // 所以这里只挂一个触发器，面板由 toggleBubbleFontSizePanel() 自己开。
      [Crepe.Feature.Toolbar]: {
        buildToolbar: (builder) => {
          builder.getGroup('formatting').addItem('xynote-font-size', {
            icon: FONT_SIZE_TRIGGER_ICON,
            // 与 B/I/S 同一口径：选区起点带行内字号标记时点亮。
            active: (activeCtx) => {
              const markType = activeCtx.get(editorViewCtx).state.schema.marks[FONT_SIZE_MARK_NAME]
              return Boolean(markType?.isInSet(activeCtx.get(editorViewCtx).state.selection.$from.marks()))
            },
            onRun: () => toggleBubbleFontSizePanel()
          })
        }
      },
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
  // T1 spike：注册笔记嵌入自定义节点（自包含、可回退，见 src/editor/xynote-embed.ts）
  crepe.addFeature(installXynoteEmbedFeature)
  // 内联 <br> 保真：抢在 commonmark 内置 remarkPreserveEmptyLinePlugin 之前改写节点，
  // 否则用户正文里的 <br> 会被当作「空行占位符」直接删除。见 src/editor/xynote-hardbreak.ts
  crepe.addFeature(installHardbreakFeature)
  // 行内字号：把 `<span style="font-size:…">` 往返成可编辑的 mark。
  // 见 src/editor/xynote-font-size.ts 与 src/utils/inline-font-size.ts
  crepe.addFeature(installFontSizeFeature)
  crepe.on((listener) => {
    listener.updated(() => {
      if (editorRootRef.value) syncHistoryActionButtons(editorRootRef.value)
    })
    // 字号下拉要跟随选区：移动光标 / 拖选后必须重算，否则触发器上的数值会停在旧位置
    // （`storedMarks` 只在光标态有效，所以这里只能靠选区事件，不能靠文档更新事件）。
    listener.selectionUpdated(() => {
      if (!editorReady) return
      // ⚠️ 这个回调是在 ProseMirror 的 `state.apply` **内部**同步触发的，
      // 此刻 `view.state` 仍是**上一个** state —— 直接读会永远慢一拍
      // （下拉数值停在移动光标之前）。推到微任务里读，此时 dispatch 已返回。
      queueMicrotask(() => {
        if (!editorReady) return
        refreshFontSizeMenu()
      })
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
  startBubbleTopBarAvoidance()
  editorRootRef.value.addEventListener('click', handleEditorLinkClick)
  editorRootRef.value.addEventListener('pointerdown', handleLinkTooltipPointerDown, true)
  editorRootRef.value.addEventListener('contextmenu', handleImageContextMenu)
  editorRootRef.value.addEventListener('contextmenu', handleEditorContextMenu)
  editorRootRef.value.addEventListener('click', handleJsonCodeFormatClick)
  editorRootRef.value.addEventListener('paste', handleAttachmentPaste, true)
  editorRootRef.value.addEventListener('dragover', handleAttachmentDragOver)
  editorRootRef.value.addEventListener('drop', handleAttachmentDrop)
  crepe.editor.action((context) => {
    const view = context.get(editorViewCtx)
    linkSuggestEditorView = view
    linkEditEditorView = view
    // 链接编辑：接管 Crepe 自带的编辑气泡（一行光秃秃的输入框），换成自研的表单浮层。
    // ⚠️「编辑」按钮与选中气泡里的「链接」按钮走的是**同一个 API**（editLink / addLink），
    // 覆写一次两条入口一起改。覆写在 create() 之后，所以能盖掉插件安装时写入的实现。
    context.update(linkTooltipAPI.key, (api) => ({
      ...api,
      addLink: (from, to) => openLinkEditor(null, from, to),
      editLink: (mark, from, to) => openLinkEditor(mark, from, to)
    }))
    setLinkTooltipMode = (mode) => {
      context.update(linkTooltipState.key, (state) => ({ ...state, mode }))
    }
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
  // 预览层盖在编辑器上，高亮在里面看不见 —— 先带用户回到编辑态再定位。
  // 与外部文件预览（MarkdownSourceEditor）同一处置：两边都是「预览不可编辑，查找要能看见」。
  if (previewMode.value) togglePreview()
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
  document.addEventListener('pointerdown', closeEditorContextMenu)
  // 捕获阶段：pointerdown 要先于 Crepe 的按钮处理打上标记，click 要先于 document 上冒泡阶段的
  // closeToolbarMenus 执行 —— 两条配套，见 trackBubbleFontSizePointerDown()。
  document.addEventListener('pointerdown', trackBubbleFontSizePointerDown, true)
  document.addEventListener('click', guardBubbleFontSizeClick, true)
  editorScrollRef.value?.addEventListener('scroll', closeImageContextMenu, { passive: true })
  editorScrollRef.value?.addEventListener('scroll', closeEditorContextMenu, { passive: true })
  // 卡片右键：由 nodeView 深处的 CustomEvent 冒泡至此，复用右键菜单组件弹出卡片操作项
  window.addEventListener(EMBED_CARD_MENU_EVENT, handleEmbedCardMenu)
  void createEditor()
})
onBeforeUnmount(() => {
  const latestMarkdown = editor?.getMarkdown()
  // getMarkdown() 返回的是规范化后的 Markdown（会补尾部换行），与 props.value 严格比较
  // 几乎永远不等 —— 仅「切换标签导致卸载」也会回吐一次假变更，触发一次多余的自动保存。
  // 因此按语义比较（忽略尾部空白），只在正文真有变化时才回吐。
  if (!props.readonly && latestMarkdown !== undefined
    && latestMarkdown.trimEnd() !== String(props.value ?? '').trimEnd()) {
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
  document.removeEventListener('pointerdown', closeEditorContextMenu)
  editorScrollRef.value?.removeEventListener('scroll', closeImageContextMenu)
  editorScrollRef.value?.removeEventListener('scroll', closeEditorContextMenu)
  window.removeEventListener(EMBED_CARD_MENU_EVENT, handleEmbedCardMenu)
  readonlyObserver?.disconnect()
  readonlyObserver = null
  jsonFormatObserver?.disconnect()
  jsonFormatObserver = null
  toolbarObserver?.disconnect()
  toolbarObserver = null
  bubbleAvoidObserver?.disconnect()
  bubbleAvoidObserver = null
  bubbleAppearObserver?.disconnect()
  bubbleAppearObserver = null
  editorRootRef.value?.removeEventListener('click', handleEditorLinkClick)
  editorRootRef.value?.removeEventListener('pointerdown', handleLinkTooltipPointerDown, true)
  editorRootRef.value?.removeEventListener('contextmenu', handleImageContextMenu)
  editorRootRef.value?.removeEventListener('contextmenu', handleEditorContextMenu)
  editorRootRef.value?.removeEventListener('click', handleJsonCodeFormatClick)
  editorRootRef.value?.removeEventListener('paste', handleAttachmentPaste, true)
  editorRootRef.value?.removeEventListener('dragover', handleAttachmentDragOver)
  editorRootRef.value?.removeEventListener('drop', handleAttachmentDrop)
  document.removeEventListener('pointerdown', trackBubbleFontSizePointerDown, true)
  document.removeEventListener('click', guardBubbleFontSizeClick, true)
  if (toolbarEventsBound) {
    document.removeEventListener('click', closeToolbarMenus)
    document.removeEventListener('keydown', handleEditorDocumentKeydown)
  }
  closeToolbarMenus()
  toolbarMenuPanels.clear()
  unbindLinkEditTracking()
  linkEditState.value = null
  linkEditEditorView = null
  setLinkTooltipMode = null
  bubbleFontSizeHost = null
  if (feedbackTimer) clearTimeout(feedbackTimer)
  if (outlineTimer) clearTimeout(outlineTimer)
  if (suppressionTimer) clearTimeout(suppressionTimer)
  const currentEditor = editor
  editor = null
  editorReady = false
  if (currentEditor) void currentEditor.destroy()
})
</script>

<!--
  Crepe BlockEdit 默认 menu 排版过松（h6 padding 14+20line、li 同样、max-height 420px），
  在「高级」组末尾追加「嵌入笔记」时被滚动条遮。这些规则必须放在 @milkdown/crepe 样式
  之后才能覆盖，所以写在组件 <style> 里（vite 会把 @import 与这里的规则合并到同一
  MarkdownVisualEditor.css chunk，@import 在前、我们的规则在后）。
-->
<style>
.milkdown .milkdown-slash-menu .menu-groups {
  max-height: min(50vh, 420px);
  padding: 0 12px 6px;
}
.milkdown .milkdown-slash-menu .menu-groups .menu-group h6 {
  padding: 4px 10px 2px;
  line-height: 14px;
  font-size: 11px;
}
.milkdown .milkdown-slash-menu .menu-groups .menu-group li {
  padding: 6px 10px;
  min-width: 180px;
  gap: 10px;
  line-height: 16px;
}

/*
  常驻模式条：占网格第 1 行，编辑区与预览层都在第 2 行 ——
  这样两层永远待在模式条下面，不会像之前那样跟 Crepe 顶栏抢同一条位置。
  第 1 行**跨满整幅宽度**（含侧栏那一列）：侧栏整列从第 2 行开始，顶部于是只剩一条横线，
  模式条的「编辑 | 预览」不会跟侧栏的「大纲 | 关系」挤在同一水平带里。
  视觉与本地文件预览那条完全同构（同一套字号 / 配色 / 按钮组）。
*/
.markdown-note-mode-bar {
  grid-row: 1;
  grid-column: 1 / -1;
  height: 35px;
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 0 16px;
  border-bottom: 1px solid var(--line);
  background: rgba(248, 251, 255, .82);
  color: #99a4b3;
  font-size: 9px;
  font-weight: 800;
  letter-spacing: .1em;
}
.markdown-note-mode-bar svg { font-size: 15px; }
.markdown-note-mode-bar__mode { color: #6f8299; letter-spacing: .12em; }
/*
  模式条上的图标按钮（大纲开关 / 复制 Markdown）。
  两个都必须放在这条上：顶栏在预览态被预览层整层盖住，放顶栏里是点不到的。
*/
.markdown-note-mode-bar__outline,
.markdown-note-mode-bar__copy {
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
.markdown-note-mode-bar__outline:hover,
.markdown-note-mode-bar__copy:hover { background: rgba(47, 128, 237, .09); color: #4a7fc1; }
.markdown-note-mode-bar__outline.is-active { background: rgba(47, 128, 237, .13); color: #2268c7; }
.markdown-note-mode-bar__hint {
  min-width: 0;
  flex: 1;
  overflow: hidden;
  color: #a9b5c5;
  font-weight: 500;
  letter-spacing: 0;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.markdown-note-mode-bar__modes {
  flex: 0 0 auto;
  display: flex;
  gap: 2px;
  padding: 2px;
  border-radius: 7px;
  background: rgba(47, 128, 237, .07);
}
.markdown-note-mode-bar__mode-button {
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
.markdown-note-mode-bar__mode-button:hover { color: #4a7fc1; }
.markdown-note-mode-bar__mode-button.is-active { background: #fff; color: #2268c7; }

/*
  笔记预览层。
  「盖」在编辑区上而不是替换它：Crepe 编辑器不卸载、不隐藏布局，于是光标、选区、
  撤销栈与滚动位置全都原样保留，退出预览立刻回到原状态。
  ⚠️ 两个 grid-area 都要显式写：显式定位的预览层会把没定位的滚动容器挤到第二列去。
  ⚠️ 底色必须**不透明**：编辑器整层还压在下面，半透明就会把 Crepe 顶栏与正文透出来，
     两层的字叠在一起（用户看到的就是这个「压字」）。
*/
.milkdown-editor-shell .milkdown-editor-scroll { grid-area: 2 / 1; }
.markdown-note-preview {
  grid-area: 2 / 1;
  z-index: 40;
  min-width: 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  background: #fbfdff;
}
.markdown-note-preview__body { min-height: 0; flex: 1; overflow: auto; padding: 26px clamp(28px, 5vw, 96px) 90px; }
/* 正文列宽与编辑器一致：进出预览时左右边界不跳。 */
.markdown-note-preview__doc {
  max-width: var(--markdown-content-width);
  margin: 0 auto;
  color: #283950;
  font-size: 13.5px;
  line-height: 1.75;
  word-break: break-word;
}
/* 图片可点击进全屏（交互挂在容器的事件委托上），光标要给出提示。 */
.markdown-note-preview__doc img { cursor: zoom-in; }
/*
  嵌入占位卡同理：点一下打开被嵌入的那篇笔记（`handlePreviewEmbedClick`）。
  只在这里补可点暗示 —— 占位卡是两处预览共用的渲染（外部文件预览也长这样），
  但只有笔记预览接了打开动作，不能把光标改到全局那份样式里。
*/
.markdown-note-preview__doc .markdown-embed-placeholder {
  cursor: pointer;
  transition: border-color 0.15s ease;
}
.markdown-note-preview__doc .markdown-embed-placeholder:hover,
.markdown-note-preview__doc .markdown-embed-placeholder:focus-visible {
  border-color: var(--rendered-doc-link);
}
.markdown-note-preview__doc .markdown-embed-placeholder:focus-visible {
  outline: 2px solid var(--rendered-doc-link);
  outline-offset: 2px;
}
/*
  箭头的静止态可点暗示。与上面的 cursor/hover 同作用域（只限笔记预览）——
  外部文件预览的占位卡不可点，不给它一个假暗示。
  图形是渲染层拼进来的内联 SVG（死 HTML 挂不上 Vue 组件），尺寸因此写在 svg 上、不再走 font-size。
*/
.markdown-note-preview__doc .markdown-embed-placeholder__action {
  flex: 0 0 auto;
  display: inline-flex;
  color: var(--rendered-doc-link);
  line-height: 1;
  transition: transform 0.15s ease;
}
.markdown-note-preview__doc .markdown-embed-placeholder__action svg {
  width: 18px;
  height: 18px;
}
.markdown-note-preview__doc .markdown-embed-placeholder:hover .markdown-embed-placeholder__action,
.markdown-note-preview__doc .markdown-embed-placeholder:focus-visible .markdown-embed-placeholder__action {
  transform: translateX(2px);
}
/*
  编辑态的图片块同样能点进全屏。只改 img：Crepe 的缩放手柄（row-resize）与图注按钮
  是 wrapper 的兄弟/子节点而非 img，各自的光标不受影响。
*/
.milkdown-editor-root .milkdown-image-block .image-wrapper img { cursor: zoom-in; }
html[data-theme="dark"] .markdown-note-mode-bar { border-color: #223349; background: rgba(14, 25, 42, .92); color: #6d8098; }
html[data-theme="dark"] .markdown-note-mode-bar__mode { color: #8fa5bd; }
html[data-theme="dark"] .markdown-note-mode-bar__hint { color: #67788d; }
html[data-theme="dark"] .markdown-note-mode-bar__outline,
html[data-theme="dark"] .markdown-note-mode-bar__copy { color: #8496ad; }
html[data-theme="dark"] .markdown-note-mode-bar__outline:hover,
html[data-theme="dark"] .markdown-note-mode-bar__copy:hover { background: rgba(120, 168, 235, .14); color: #9dc3f2; }
html[data-theme="dark"] .markdown-note-mode-bar__outline.is-active { background: rgba(120, 168, 235, .2); color: #a9cdf7; }
html[data-theme="dark"] .markdown-note-mode-bar__modes { background: rgba(120, 168, 235, .12); }
html[data-theme="dark"] .markdown-note-mode-bar__mode-button { color: #8496ad; }
html[data-theme="dark"] .markdown-note-mode-bar__mode-button:hover { color: #9dc3f2; }
html[data-theme="dark"] .markdown-note-mode-bar__mode-button.is-active { background: #1b2b42; color: #a9cdf7; }
html[data-theme="dark"] .markdown-note-preview { background: #0e1a2c; }
html[data-theme="dark"] .markdown-note-preview__doc { color: #d9e6f6; }
</style>
