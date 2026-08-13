<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import { Icon } from '@iconify/vue'
import DOMPurify from 'dompurify'
import { marked } from 'marked'
import {
  formatNoteExcerpt as getNoteExcerpt,
  formatNoteUpdatedTime as formatTime,
  matchesNoteSearch,
  NOTE_AUTOSAVE_DELAY_MS,
  type NoteNavigationKind
} from './utils/note-workspace'
import { collectBlockedFolderDropIds, getDragAutoScrollDelta } from './utils/resource-drag'
import {
  activateNoteInCurrentTab,
  activateNoteInNewTab,
  closeOtherNoteTabs,
  closeNoteTab as getClosedNoteTabs,
  closeNoteTabsToRight,
  partitionNoteTabs,
  reconcileNoteTabs,
  type NoteTabsState
} from './utils/note-tabs'
import NoteNavigation from './components/NoteNavigation.vue'
import FolderTreeItem from './components/FolderTreeItem.vue'
import MarkdownVisualEditor from './components/MarkdownVisualEditor.vue'
import SearchExcerpt from './components/SearchExcerpt.vue'
import type {
  AttachmentInventory,
  AttachmentInventoryItem,
  AttachmentNoteReference,
  DatabaseBackup,
  DatabaseBackupStatus,
  DatabaseBackupSettings,
  DataTransferResult,
  NoteFolder,
  NoteConflictPair,
  NoteHistory,
  NotePatch,
  NoteTag,
  OfflineNote,
  SyncConnectionResult,
  SyncResultChange,
  SyncSettingsView,
  SyncStatus,
  ThemeMode,
  UpdateCheckResult,
  WorkspaceData
} from './types'

type FilterKind = 'all' | 'pinned' | 'trash' | 'folder' | 'tag'
type SaveState = 'idle' | 'saving' | 'saved' | 'error'
type SearchMenuTarget = 'workspace' | 'quick-open' | 'current-note'

interface ActiveFilter {
  kind: FilterKind
  id: string | null
}

interface ResourceContextMenu {
  visible: boolean
  x: number
  y: number
  unclassified: boolean
  folder: NoteFolder | null
  note: OfflineNote | null
  tag: NoteTag | null
}

interface ConfirmationDialogState {
  visible: boolean
  title: string
  message: string
  confirmLabel: string
}

interface ButtonTooltipState {
  visible: boolean
  text: string
  x: number
  y: number
  placement: 'top' | 'bottom'
}

interface ResourceDragData {
  kind: 'note' | 'folder'
  id: string
}

interface FolderDropPayload {
  event: DragEvent
  folder: NoteFolder
  position: 'before' | 'inside' | 'after'
}

interface QuickOpenResult {
  note: OfflineNote
  folderPath: string
  excerpt: string
  contentMatched: boolean
}

const workspace = reactive<WorkspaceData>({ folders: [], tags: [], notes: [], pendingCount: 0 })
const activeFilter = reactive<ActiveFilter>({ kind: 'all', id: null })
const activeNoteId = ref<string | null>(null)
const openNoteIds = ref<string[]>([])
const activeTabNoteId = ref<string | null>(null)
const noteTabBarElement = ref<HTMLElement | null>(null)
const noteTabBarWidth = ref(0)
const noteTabOverflowVisible = ref(false)
const noteTabContextMenuElement = ref<HTMLElement | null>(null)
const tabContextMenu = reactive({ visible: false, x: 0, y: 0, noteId: null as string | null })
const searchKeyword = ref('')
const searchInput = ref<HTMLInputElement | null>(null)
const noteFindVisible = ref(false)
const noteFindKeyword = ref('')
const noteFindInput = ref<HTMLInputElement | null>(null)
const noteFindResult = reactive({ count: 0, index: -1 })
const markdownEditorRef = ref<{
  clearFindHighlight: () => void
  findText: (keyword: string, requestedIndex: number) => { count: number, index: number }
} | null>(null)
const loading = ref(true)
const saveState = ref<SaveState>('idle')
const lastSavedAt = ref('')
const linkCopyFeedback = ref('')
const historyVisible = ref(false)
const noteHistories = ref<NoteHistory[]>([])
const selectedHistoryId = ref<string | null>(null)
const historyLoading = ref(false)
const historyDetailLoading = ref(false)
const actionError = ref('')
const updateDialogVisible = ref(false)
const updateChecking = ref(false)
const updateError = ref('')
const updateResult = ref<UpdateCheckResult | null>(null)

/**
 * 将新版本发布说明渲染为经过净化的 HTML。
 *
 * :return: 可安全展示的发布说明 HTML。
 */
const renderedUpdateReleaseNotes = computed<string>(() => {
  const releaseNotes = updateResult.value?.releaseNotes
  if (updateResult.value?.status !== 'available' || !releaseNotes) return ''
  return DOMPurify.sanitize(marked.parse(releaseNotes, { async: false }))
})
const syncDialogVisible = ref(false)
const conflictCenterVisible = ref(false)
const selectedConflictNoteId = ref('')
const conflictResolving = ref(false)
const conflictError = ref('')
const generalSettingsVisible = ref(false)
const generalSettingsSaving = ref(false)
const generalSettingsMessage = ref('')
const generalShortcutRecording = ref(false)
const generalShortcut = ref('CommandOrControl+Shift+Space')
const generalQuickCaptureFolderId = ref<string | null>(null)
const quickOpenVisible = ref(false)
const quickOpenKeyword = ref('')
const quickOpenInput = ref<HTMLInputElement | null>(null)
const quickOpenResultsElement = ref<HTMLElement | null>(null)
const quickOpenActiveIndex = ref(0)
const quickOpenShortcutRecording = ref(false)
const quickOpenShortcut = ref(window.localStorage.getItem('notes-quick-open-shortcut') || 'CommandOrControl+O')
const draftQuickOpenShortcut = ref(quickOpenShortcut.value)
const quickOpenHistory = ref(loadQuickOpenHistory())
const storedShowTreeLines = window.localStorage.getItem('notes-show-tree-lines')
const showTreeLines = ref(storedShowTreeLines !== 'false')
const draftShowTreeLines = ref(showTreeLines.value)
const syncTesting = ref(false)
const syncBrowserLoginPending = ref(false)
const syncSaving = ref(false)
const dataTransferVisible = ref(false)
const dataTransferBusy = ref(false)
const dataTransferMessage = ref('')
const attachmentManagerVisible = ref(false)
const attachmentManagerLoading = ref(false)
const attachmentOperationId = ref('')
const attachmentManagerMessage = ref('')
const attachmentSearchKeyword = ref('')
const attachmentKindFilter = ref<'all' | 'image' | 'document' | 'other'>('all')
const attachmentStateFilter = ref<'all' | 'uploaded' | 'pending' | 'missing' | 'corrupt' | 'orphan'>('all')
const attachmentSourceFilter = ref<'all' | 'managed' | 'external-cache'>('all')
const attachmentKindOptions: Array<{ value: 'all' | 'image' | 'document' | 'other', label: string }> = [
  { value: 'all', label: '全部' },
  { value: 'image', label: '图片' },
  { value: 'document', label: '文档' },
  { value: 'other', label: '其他' }
]
const attachmentInventory = ref<AttachmentInventory>({
  items: [],
  totalCount: 0,
  localBytes: 0,
  uploadedCount: 0,
  pendingCount: 0,
  missingCount: 0,
  corruptCount: 0,
  orphanCount: 0,
  managedCount: 0,
  externalCacheCount: 0
})
const databaseBackupVisible = ref(false)
const databaseBackupBusy = ref(false)
const databaseBackupMessage = ref('')
const databaseBackups = ref<DatabaseBackup[]>([])
const databaseBackupStatus = reactive<DatabaseBackupStatus>({
  state: 'idle',
  message: '尚未创建备份',
  lastSuccessAt: '',
  reason: ''
})
const databaseBackupSettings = reactive<DatabaseBackupSettings>({ schedule: 'daily', retention: 10 })
const markdownImportTargetVisible = ref(false)
const markdownImportTargetFolderId = ref<string | null>(null)
const duplicateNoteVisible = ref(false)
const duplicateNoteBusy = ref(false)
const duplicateNoteSource = ref<OfflineNote | null>(null)
const duplicateNoteTargetFolderId = ref<string | null>(null)
const duplicateNoteTitle = ref('')
const verifiedBackendUrl = ref('')
const syncSettings = reactive<SyncSettingsView>({
  backendUrl: 'https://lovethewind.cn',
  webUrl: 'https://lovethewind.cn',
  configured: false,
  accountLabel: ''
})
const syncForm = reactive({
  backendUrl: 'https://lovethewind.cn',
  webUrl: 'https://lovethewind.cn',
  username: '',
  password: ''
})
const syncConnectionResult = reactive<SyncConnectionResult>({
  ok: false,
  message: ''
})
const syncStatus = reactive<SyncStatus>({
  state: 'idle',
  message: '仅保存在本机',
  lastSuccessAt: '',
  history: []
})
const folderDialogVisible = ref(false)
const folderDialogMode = ref<'create' | 'rename'>('create')
const editingFolderId = ref<string | null>(null)
const folderDialogParentId = ref<string | null>(null)
const folderName = ref('')
const createMenuVisible = ref(false)
const folderPickerVisible = ref(false)
const folderPickerSearchKeyword = ref('')
const folderPickerSearchInput = ref<HTMLInputElement | null>(null)
const tagPickerVisible = ref(false)
const tagSearchKeyword = ref('')
const tagDialogVisible = ref(false)
const tagDialogAttachToDraft = ref(false)
const tagName = ref('')
const systemThemeMedia = window.matchMedia('(prefers-color-scheme: dark)')
const storedTheme = window.localStorage.getItem('notes-theme')
const themeMode = ref<ThemeMode>(storedTheme === 'system' || storedTheme === 'light' || storedTheme === 'dark' ? storedTheme : 'system')
const themeOptions: Array<{ mode: ThemeMode, label: string, icon: string }> = [
  { mode: 'system', label: '跟随系统', icon: 'tabler:device-desktop' },
  { mode: 'light', label: '日间模式', icon: 'tabler:sun' },
  { mode: 'dark', label: '夜间模式', icon: 'tabler:moon' }
]
document.documentElement.dataset.theme = themeMode.value === 'system'
  ? systemThemeMedia.matches ? 'dark' : 'light'
  : themeMode.value
const contextMenu = reactive<ResourceContextMenu>({
  visible: false,
  x: 0,
  y: 0,
  unclassified: false,
  folder: null,
  note: null,
  tag: null
})
const resourceContextMenuElement = ref<HTMLElement | null>(null)
const confirmationDialog = reactive<ConfirmationDialogState>({
  visible: false,
  title: '',
  message: '',
  confirmLabel: '删除'
})
const buttonTooltip = reactive<ButtonTooltipState>({
  visible: false,
  text: '',
  x: 0,
  y: 0,
  placement: 'bottom'
})
const expandedFolderIds = ref<Set<string>>(new Set())
const unclassifiedExpanded = ref(true)
const draggedResource = ref<ResourceDragData | null>(null)
const sidebarResourceScroll = ref<HTMLElement | null>(null)
const draft = reactive({
  title: '',
  content: '',
  folderId: null as string | null,
  tagNames: [] as string[],
  isPinned: false
})
let saveTimer: ReturnType<typeof setTimeout> | undefined
let draftReady = false
let draftVersion = 0
let pendingRemoteRefresh = false
let initialWorkspaceLoad: Promise<void> | null = null
let confirmationResolver: ((confirmed: boolean) => void) | null = null
let linkCopyFeedbackTimer: ReturnType<typeof setTimeout> | null = null
let disposeOpenSyncSettings: (() => void) | null = null
let disposeOpenNoteLink: (() => void) | null = null
let disposeCheckForUpdates: (() => void) | null = null
let disposeOpenDataTransfer: (() => void) | null = null
let disposeOpenGeneralSettings: (() => void) | null = null
let disposeOpenSearch: (() => void) | null = null
let disposeDatabaseBackupStatus: (() => void) | null = null
let disposeSyncAuthResult: (() => void) | null = null
let disposeSyncStatus: (() => void) | null = null
let disposeWorkspaceChanged: (() => void) | null = null
let syncBrowserLoginTimer: ReturnType<typeof setTimeout> | null = null
let resourceAutoScrollFrame: number | null = null
let resourceAutoScrollDelta = 0
let noteTabResizeObserver: ResizeObserver | null = null

const activeNote = computed(() => workspace.notes.find((note) => note.id === activeNoteId.value) ?? null)
const openNoteTabs = computed<OfflineNote[]>(() => openNoteIds.value
  .map((noteId) => workspace.notes.find((note) => note.id === noteId && !note.isDeleted))
  .filter((note): note is OfflineNote => Boolean(note)))
const partitionedNoteTabs = computed(() => {
  if (!noteTabBarWidth.value) {
    return partitionNoteTabs(openNoteIds.value, activeTabNoteId.value, openNoteIds.value.length)
  }
  const withoutOverflow = Math.max(1, Math.floor(noteTabBarWidth.value / 160))
  const maxVisible = openNoteIds.value.length > withoutOverflow
    ? Math.max(1, Math.floor((noteTabBarWidth.value - 42) / 160))
    : withoutOverflow
  return partitionNoteTabs(openNoteIds.value, activeTabNoteId.value, maxVisible)
})
const visibleNoteTabs = computed<OfflineNote[]>(() => partitionedNoteTabs.value.visibleNoteIds
  .map((noteId) => openNoteTabs.value.find((note) => note.id === noteId))
  .filter((note): note is OfflineNote => Boolean(note)))
const overflowNoteTabs = computed<OfflineNote[]>(() => partitionedNoteTabs.value.overflowNoteIds
  .map((noteId) => openNoteTabs.value.find((note) => note.id === noteId))
  .filter((note): note is OfflineNote => Boolean(note)))
const allCount = computed(() => workspace.notes.filter((note) => !note.isDeleted).length)
const pinnedCount = computed(() => workspace.notes.filter((note) => !note.isDeleted && note.isPinned).length)
const trashCount = computed(() => workspace.notes.filter((note) => note.isDeleted).length)
const deletedFolders = computed(() => workspace.folders.filter((folder) => folder.isDeleted))
const deletedNotes = computed(() => workspace.notes.filter((note) => note.isDeleted))
const recycleItemCount = computed(() => deletedFolders.value.length + deletedNotes.value.length)
const recycleRootFolders = computed(() => {
  const deletedFolderIds = new Set(deletedFolders.value.map((folder) => folder.id))
  return deletedFolders.value.filter((folder) => (
    !folder.parentId
    || !deletedFolderIds.has(folder.parentId)
    || folder.deletedRootId !== workspace.folders.find((item) => item.id === folder.parentId)?.deletedRootId
  ))
})

/**
 * 一次性统计每个文件夹及其父级路径中的笔记数量。
 *
 * :param folders: 待统计的文件夹。
 * :param notes: 待统计的笔记。
 * :return: 文件夹 ID 到后代笔记总数的映射。
 */
function buildFolderNoteCounts(folders: NoteFolder[], notes: OfflineNote[]): Map<string, number> {
  const counts = new Map<string, number>()
  const foldersById = new Map(folders.map((folder) => [folder.id, folder]))
  for (const note of notes) {
    let folderId = note.folderId
    const visited = new Set<string>()
    while (folderId && !visited.has(folderId)) {
      visited.add(folderId)
      counts.set(folderId, (counts.get(folderId) ?? 0) + 1)
      folderId = foldersById.get(folderId)?.parentId ?? null
    }
  }
  return counts
}

const recycleFolderNoteCounts = computed(() => buildFolderNoteCounts(deletedFolders.value, deletedNotes.value))
const standaloneDeletedNotes = computed(() => deletedNotes.value.filter((note) => {
  if (note.deletedByFolderId) return false
  return !deletedFolders.value.some((folder) => folder.id === note.folderId)
}))
const navigationActive = computed<NoteNavigationKind | null>(() =>
  activeFilter.kind === 'all' || activeFilter.kind === 'pinned' || activeFilter.kind === 'trash'
    ? activeFilter.kind
    : null
)
const visibleNotes = computed(() => {
  const keyword = searchKeyword.value.trim().toLocaleLowerCase()
  return workspace.notes.filter((note) => {
    if (activeFilter.kind === 'trash' ? !note.isDeleted : note.isDeleted) return false
    if (activeFilter.kind === 'pinned' && !note.isPinned) return false
    if (activeFilter.kind === 'folder' && note.folderId !== activeFilter.id) return false
    if (activeFilter.kind === 'tag' && !note.tags.some((tag) => tag.id === activeFilter.id)) return false
    if (!matchesNoteSearch(note, keyword)) return false
    return true
  }).sort((left, right) => {
    if (!keyword) return 0
    return Number(right.title.toLocaleLowerCase().includes(keyword))
      - Number(left.title.toLocaleLowerCase().includes(keyword))
  })
})
const explorerNotes = computed(() => {
  const keyword = searchKeyword.value.trim().toLocaleLowerCase()
  return workspace.notes.filter((note) => {
    if (note.isDeleted) return false
    if (activeFilter.kind === 'tag' && !note.tags.some((tag) => tag.id === activeFilter.id)) return false
    return matchesNoteSearch(note, keyword)
  }).sort((left, right) => {
    if (!keyword) return 0
    return Number(right.title.toLocaleLowerCase().includes(keyword))
      - Number(left.title.toLocaleLowerCase().includes(keyword))
  })
})
const searchFolderIds = computed(() => {
  if (!searchKeyword.value.trim() && activeFilter.kind !== 'tag') return null
  const folderById = new Map(workspace.folders.map((folder) => [folder.id, folder]))
  const visibleIds = new Set<string>()
  for (const note of explorerNotes.value) {
    let folderId = note.folderId
    const visited = new Set<string>()
    while (folderId && !visited.has(folderId)) {
      visited.add(folderId)
      const folder = folderById.get(folderId)
      if (!folder || folder.isDeleted) break
      visibleIds.add(folder.id)
      folderId = folder.parentId
    }
  }
  return visibleIds
})
const explorerFolders = computed(() => (
  searchFolderIds.value
    ? workspace.folders.filter((folder) => searchFolderIds.value?.has(folder.id))
    : workspace.folders
))
const explorerExpandedFolderIds = computed(() => (
  searchFolderIds.value
    ? new Set([...expandedFolderIds.value, ...searchFolderIds.value])
    : expandedFolderIds.value
))
const explorerUnclassifiedExpanded = computed(() => (
  searchFolderIds.value ? true : unclassifiedExpanded.value
))
const rootFolders = computed(() => explorerFolders.value.filter((folder) => (
  !folder.isDeleted && folder.parentId === null
)))
const folderNoteCounts = computed(() => buildFolderNoteCounts(explorerFolders.value, explorerNotes.value))
const resourceDragEnabled = computed(() => activeFilter.kind === 'all' && !searchKeyword.value.trim())
const blockedFolderDropIds = computed(() => collectBlockedFolderDropIds(
  draggedResource.value?.kind === 'folder' ? draggedResource.value.id : null,
  workspace.folders
))
const folderOptions = computed(() => {
  const options: Array<{ id: string, name: string, label: string, depth: number }> = []
  const visited = new Set<string>()

  /**
   * 递归生成带层级前缀的文件夹选项。
   *
   * :param parentId: 父文件夹 ID。
   * :param depth: 当前层级。
   * :return: 无返回值。
   */
  function appendFolderOptions(parentId: string | null, depth: number): void {
    for (const folder of workspace.folders.filter((item) => !item.isDeleted && item.parentId === parentId)) {
      if (visited.has(folder.id)) continue
      visited.add(folder.id)
      options.push({
        id: folder.id,
        name: folder.name,
        label: `${'　'.repeat(depth)}${depth ? '└ ' : ''}${folder.name}`,
        depth
      })
      appendFolderOptions(folder.id, depth + 1)
    }
  }

  appendFolderOptions(null, 0)
  return options
})
const filteredFolderOptions = computed(() => {
  const keyword = folderPickerSearchKeyword.value.trim().toLocaleLowerCase()
  if (!keyword) return folderOptions.value
  return folderOptions.value.filter((folder) => folder.name.toLocaleLowerCase().includes(keyword))
})
const quickOpenResults = computed<QuickOpenResult[]>(() => {
  const keyword = quickOpenKeyword.value.trim().toLocaleLowerCase()
  const folderById = new Map(workspace.folders.map((folder) => [folder.id, folder]))
  return workspace.notes
    .filter((note) => !note.isDeleted)
    .map((note) => {
      const folderPath = getQuickOpenFolderPath(note.folderId, folderById)
      const searchText = [
        note.title,
        note.content,
        note.tags.map((tag) => tag.name).join(' '),
        folderPath
      ].join(' ').toLocaleLowerCase()
      const score = keyword
        ? Number(note.title.toLocaleLowerCase().includes(keyword)) * 4
          + Number(note.tags.some((tag) => tag.name.toLocaleLowerCase().includes(keyword))) * 3
          + Number(folderPath.toLocaleLowerCase().includes(keyword)) * 2
          + Number(note.content.toLocaleLowerCase().includes(keyword))
        : 0
      return {
        note,
        folderPath,
        excerpt: getNoteExcerpt(note.content),
        contentMatched: Boolean(keyword && note.content.toLocaleLowerCase().includes(keyword)),
        searchText,
        score
      }
    })
    .filter((result) => !keyword || result.searchText.includes(keyword))
    .sort((left, right) => right.score - left.score || Date.parse(right.note.updatedAt) - Date.parse(left.note.updatedAt))
    .slice(0, 12)
    .map(({ note, folderPath, excerpt, contentMatched }) => ({ note, folderPath, excerpt, contentMatched }))
})
const currentFolderName = computed(() => {
  if (!draft.folderId) return '未分类'
  return workspace.folders.find((folder) => folder.id === draft.folderId)?.name ?? '未分类'
})
const selectedTags = computed(() => draft.tagNames
  .map((name) => workspace.tags.find((tag) => tag.name === name))
  .filter((tag): tag is NoteTag => Boolean(tag)))
const visibleDraftTags = computed(() => selectedTags.value.slice(0, 3))
const hiddenDraftTagCount = computed(() => Math.max(0, selectedTags.value.length - 3))
const filteredTags = computed(() => {
  const keyword = tagSearchKeyword.value.trim().toLocaleLowerCase()
  return workspace.tags.filter((tag) => !keyword || tag.name.toLocaleLowerCase().includes(keyword))
})
const showFilteredResults = computed(() => activeFilter.kind === 'pinned')
const filterTitle = computed(() => {
  if (activeFilter.kind === 'pinned') return '置顶笔记'
  if (activeFilter.kind === 'trash') return '回收站'
  if (activeFilter.kind === 'folder') {
    return workspace.folders.find((folder) => folder.id === activeFilter.id)?.name ?? '文件夹'
  }
  if (activeFilter.kind === 'tag') {
    return `# ${workspace.tags.find((tag) => tag.id === activeFilter.id)?.name ?? '标签'}`
  }
  return '全部笔记'
})
const syncStatusLabel = computed(() => syncSettings.configured
  ? syncStatus.message || syncSettings.accountLabel || '同步已连接'
  : '未配置同步')
const syncActionLabel = computed(() => {
  if (!syncSettings.configured) return '配置同步'
  return workspace.pendingCount
    ? `同步全部笔记（${workspace.pendingCount} 项待同步）`
    : '同步全部笔记'
})
const syncStatusIcon = computed(() => {
  if (!syncSettings.configured) return 'tabler:cloud-off'
  if (syncStatus.state === 'syncing') return 'tabler:loader-2'
  if (syncStatus.state === 'error') return 'tabler:cloud-exclamation'
  return 'tabler:cloud-check'
})
const syncCenterStateTitle = computed(() => {
  if (!syncSettings.configured) return '连接云端，开启自动同步'
  if (syncStatus.state === 'syncing') return '正在同步全部数据'
  if (syncStatus.state === 'error') return '上次同步未完成'
  if (workspace.pendingCount) return `${workspace.pendingCount} 项本地变更等待同步`
  return syncStatus.lastSuccessAt ? '所有数据已同步' : '云端同步已就绪'
})
const syncCenterActionLabel = computed(() => syncStatus.state === 'syncing'
  ? '正在同步…'
  : syncStatus.state === 'error' ? '重试同步'
    : workspace.pendingCount ? `同步 ${workspace.pendingCount} 项变更` : '立即检查云端')
const syncCenterLastSuccessLabel = computed(() => syncStatus.lastSuccessAt
  ? formatDatabaseBackupTime(syncStatus.lastSuccessAt)
  : '尚未完成首次同步')
const syncResultChangeCount = computed(() => syncStatus.lastResult
  ? syncStatus.lastResult.uploadedCount + syncStatus.lastResult.downloadedCount + syncStatus.lastResult.deletedCount
  : 0)
const noteConflicts = computed<NoteConflictPair[]>(() => workspace.notes
  .filter((note) => Boolean(note.conflictSourceId))
  .map((conflict) => ({
    conflict,
    original: workspace.notes.find((note) => note.id === conflict.conflictSourceId),
  }))
  .filter((pair): pair is NoteConflictPair => Boolean(pair.original)))
const selectedNoteConflict = computed(() => noteConflicts.value.find(
  (pair) => pair.conflict.id === selectedConflictNoteId.value,
) || noteConflicts.value[0] || null)
const filteredAttachments = computed(() => {
  const keyword = attachmentSearchKeyword.value.trim().toLocaleLowerCase()
  return attachmentInventory.value.items.filter((asset) => {
    if (attachmentKindFilter.value !== 'all' && asset.kind !== attachmentKindFilter.value) return false
    if (attachmentSourceFilter.value !== 'all' && asset.sourceKind !== attachmentSourceFilter.value) return false
    if (attachmentStateFilter.value === 'orphan' && !asset.isOrphan) return false
    if (
      attachmentStateFilter.value !== 'all'
      && attachmentStateFilter.value !== 'orphan'
      && asset.state !== attachmentStateFilter.value
    ) return false
    if (!keyword) return true
    return [
      asset.fileName,
      asset.mimeType,
      asset.sourceHost,
      ...asset.noteReferences.map((note) => note.title)
    ].some((value) => value.toLocaleLowerCase().includes(keyword))
  })
})

function formatSyncDuration(durationMs: number): string {
  if (durationMs < 1000) return `${Math.max(0, Math.round(durationMs))} 毫秒`
  return `${(durationMs / 1000).toFixed(durationMs < 10_000 ? 1 : 0)} 秒`
}

function getSyncResultChangeLabel(change: SyncResultChange): string {
  if (change.kind === 'upload') return '本地上传'
  if (change.kind === 'download') return '云端更新'
  return '已删除'
}

function getSyncResultChangeIcon(change: SyncResultChange): string {
  if (change.kind === 'upload') return 'tabler:cloud-upload'
  if (change.kind === 'download') return 'tabler:cloud-download'
  return 'tabler:trash'
}
const saveStatusLabel = computed(() => {
  if (saveState.value === 'saving') return '正在保存'
  if (saveState.value === 'error') return '保存失败'
  if (saveState.value === 'saved') return lastSavedAt.value ? `已保存 ${lastSavedAt.value}` : '已保存'
  return '自动保存'
})
const selectedHistory = computed(() =>
  noteHistories.value.find((history) => history.id === selectedHistoryId.value) ?? null
)
const canSaveSyncSettings = computed(() => {
  const backendUrl = syncForm.backendUrl.trim().replace(/\/+$/, '')
  const usingSavedConnection = syncSettings.configured
    && backendUrl === syncSettings.backendUrl
    && !syncForm.username.trim()
    && !syncForm.password
  return !syncSaving.value && (usingSavedConnection || backendUrl === verifiedBackendUrl.value)
})

/**
 * 检查 GitHub Releases 中是否存在新版本。
 *
 * :param silent: 已是最新版或检查失败时是否静默。
 * :return: 检查完成后的 Promise。
 */
async function runUpdateCheck(silent = false): Promise<void> {
  if (updateChecking.value) return
  updateChecking.value = true
  updateError.value = ''
  if (!silent) updateDialogVisible.value = true
  try {
    updateResult.value = await window.notesDesktop.checkForUpdates()
    if (updateResult.value.status === 'available') updateDialogVisible.value = true
  } catch (error) {
    updateError.value = error instanceof Error ? error.message : '检查更新失败'
    if (!silent) updateDialogVisible.value = true
  } finally {
    updateChecking.value = false
  }
}

/**
 * 使用系统浏览器打开新版本下载地址。
 *
 * :return: 打开完成后的 Promise。
 */
async function openUpdateDownload(): Promise<void> {
  if (!updateResult.value?.downloadUrl) return
  try {
    await window.notesDesktop.openUpdateDownload(updateResult.value.downloadUrl)
    updateDialogVisible.value = false
  } catch (error) {
    updateError.value = error instanceof Error ? error.message : '无法打开下载地址'
  }
}

/**
 * 将工作区响应覆盖到响应式状态。
 *
 * :param data: 工作区数据。
 * :return: 无返回值。
 */
function applyWorkspace(data: WorkspaceData): void {
  workspace.folders = data.folders
  workspace.tags = data.tags
  workspace.notes = data.notes
  workspace.pendingCount = data.pendingCount
  if (!expandedFolderIds.value.size) {
    expandedFolderIds.value = new Set(data.folders.map((folder) => folder.id))
  }
}

/**
 * 加载本地数据库中的全部笔记数据。
 *
 * :return: 加载完成后的 Promise。
 */
async function loadWorkspace(): Promise<void> {
  loading.value = true
  actionError.value = ''
  try {
    applyWorkspace(await window.notesDesktop.listWorkspace())
    const target = workspace.notes.find((note) => !note.isDeleted) ?? workspace.notes[0]
    if (target) await selectNote(target)
  } catch (error) {
    actionError.value = error instanceof Error ? error.message : '本地数据库加载失败'
  } finally {
    loading.value = false
  }
}

/**
 * 保留当前选择并刷新同步后的本地工作区。
 *
 * :return: 刷新完成后的 Promise。
 */
async function refreshWorkspace(): Promise<void> {
  const selectedId = activeNoteId.value
  applyWorkspace(await window.notesDesktop.listWorkspace())
  const refreshedNote = selectedId
    ? workspace.notes.find((note) => note.id === selectedId)
    : undefined
  if (refreshedNote) {
    if (hasPendingDraftSave()) {
      pendingRemoteRefresh = true
      return
    }
    pendingRemoteRefresh = false
    if (!doesDraftMatchNote(refreshedNote)) {
      await loadNoteIntoDraft(refreshedNote)
    }
    return
  }
  pendingRemoteRefresh = false
  const target = workspace.notes.find((note) => !note.isDeleted) ?? workspace.notes[0]
  if (target) await selectNote(target)
}

/**
 * 手动执行一次云端同步，未配置时打开设置。
 *
 * :return: 同步完成后的 Promise。
 */
async function runSync(): Promise<void> {
  if (!syncSettings.configured) {
    await openSyncSettings()
    return
  }
  Object.assign(syncStatus, await window.notesDesktop.runSync())
}

/**
 * 从服务器主动拉取最新数据并刷新本地工作区。
 *
 * :return: 同步完成后的 Promise。
 */
async function pullLatestData(): Promise<void> {
  await runSync()
  if (syncSettings.configured) await refreshWorkspace()
}

/**
 * 将 Electron 快捷键格式转换为界面展示文本。
 *
 * :param value: Electron 快捷键字符串。
 * :return: 当前系统对应的快捷键文本。
 */
function formatGeneralShortcut(value: string): string {
  return value
    .replace('CommandOrControl', navigator.platform.includes('Mac') ? '⌘' : 'Ctrl')
    .replaceAll('Shift', '⇧')
    .replaceAll('Alt', navigator.platform.includes('Mac') ? '⌥' : 'Alt')
    .replaceAll('+', ' ')
}

/**
 * 将键盘事件转换为 Electron 全局快捷键字符串。
 *
 * :param event: 键盘事件。
 * :return: 有效快捷键字符串，无修饰键或仅按修饰键时返回 null。
 */
function getGeneralShortcutFromEvent(event: KeyboardEvent): string | null {
  const ignoredKeys = new Set(['Meta', 'Control', 'Shift', 'Alt'])
  if (ignoredKeys.has(event.key)) return null
  const modifiers: string[] = []
  if (event.metaKey || event.ctrlKey) modifiers.push('CommandOrControl')
  if (event.altKey) modifiers.push('Alt')
  if (event.shiftKey) modifiers.push('Shift')
  if (!modifiers.length) return null
  const aliases: Record<string, string> = {
    ' ': 'Space', ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right'
  }
  const key = aliases[event.key] || (event.key.length === 1 ? event.key.toUpperCase() : event.key)
  return [...modifiers, key].join('+')
}

/**
 * 录入通用设置中的快速记录快捷键。
 *
 * :param event: 键盘事件。
 * :return: 无返回值。
 */
function recordGeneralShortcut(event: KeyboardEvent): void {
  event.preventDefault()
  event.stopPropagation()
  const shortcut = getGeneralShortcutFromEvent(event)
  if (!shortcut) return
  generalShortcut.value = shortcut
  generalShortcutRecording.value = false
  generalSettingsMessage.value = ''
}

/**
 * 生成笔记所在文件夹的完整路径。
 *
 * :param folderId: 笔记所属文件夹 ID。
 * :param folderById: 按 ID 索引的文件夹集合。
 * :return: 文件夹路径，未分类笔记返回“未分类”。
 */
function getQuickOpenFolderPath(folderId: string | null, folderById: Map<string, NoteFolder>): string {
  if (!folderId) return '未分类'
  const names: string[] = []
  const visited = new Set<string>()
  let currentId: string | null = folderId
  while (currentId && !visited.has(currentId)) {
    visited.add(currentId)
    const folder = folderById.get(currentId)
    if (!folder || folder.isDeleted) break
    names.unshift(folder.name)
    currentId = folder.parentId
  }
  return names.join(' / ') || '未分类'
}

/**
 * 录入通用设置中的快速打开快捷键。
 *
 * :param event: 键盘事件。
 * :return: 无返回值。
 */
function recordQuickOpenShortcut(event: KeyboardEvent): void {
  event.preventDefault()
  event.stopPropagation()
  const shortcut = getGeneralShortcutFromEvent(event)
  if (!shortcut) return
  draftQuickOpenShortcut.value = shortcut
  quickOpenShortcutRecording.value = false
  generalSettingsMessage.value = ''
}

/**
 * 判断键盘事件是否匹配应用内快捷键。
 *
 * :param event: 键盘事件。
 * :param shortcut: Electron 格式的快捷键字符串。
 * :return: 匹配时返回 true。
 */
function matchesAppShortcut(event: KeyboardEvent, shortcut: string): boolean {
  const parts = shortcut.split('+').map((part) => part.toLocaleLowerCase())
  const expectedCommand = parts.includes('commandorcontrol')
  const expectedShift = parts.includes('shift')
  const expectedAlt = parts.includes('alt')
  const key = parts.find((part) => !['commandorcontrol', 'shift', 'alt'].includes(part))
  if (!key) return false
  return (event.metaKey || event.ctrlKey) === expectedCommand
    && event.shiftKey === expectedShift
    && event.altKey === expectedAlt
    && event.key.toLocaleLowerCase() === key.toLocaleLowerCase()
}

/**
 * 从本地设置读取最近使用的快速搜索词。
 *
 * :return: 最多八条有效搜索词。
 */
function loadQuickOpenHistory(): string[] {
  try {
    const value = JSON.parse(window.localStorage.getItem('notes-quick-open-history') || '[]')
    return Array.isArray(value)
      ? value.filter((item): item is string => typeof item === 'string' && Boolean(item.trim())).slice(0, 8)
      : []
  } catch {
    return []
  }
}

/**
 * 保存最近使用的快速搜索词并去重。
 *
 * :param keyword: 已完成跳转的搜索词。
 * :return: 无返回值。
 */
function rememberQuickOpenKeyword(keyword: string): void {
  const normalizedKeyword = keyword.trim()
  if (!normalizedKeyword) return
  quickOpenHistory.value = [
    normalizedKeyword,
    ...quickOpenHistory.value.filter((item) => item.toLocaleLowerCase() !== normalizedKeyword.toLocaleLowerCase())
  ].slice(0, 8)
  window.localStorage.setItem('notes-quick-open-history', JSON.stringify(quickOpenHistory.value))
}

/**
 * 将历史搜索词填入快速打开输入框。
 *
 * :param keyword: 待复用搜索词。
 * :return: 无返回值。
 */
function applyQuickOpenHistory(keyword: string): void {
  quickOpenKeyword.value = keyword
  quickOpenActiveIndex.value = 0
  void nextTick(() => quickOpenInput.value?.focus())
}

/**
 * 打开全库快速搜索面板并聚焦输入框。
 *
 * :return: 无返回值。
 */
function openQuickOpen(): void {
  quickOpenVisible.value = true
  quickOpenKeyword.value = ''
  quickOpenActiveIndex.value = 0
  void nextTick(() => quickOpenInput.value?.focus())
}

/**
 * 打开当前笔记查找栏并聚焦关键词输入框。
 *
 * :return: 无返回值。
 */
function openCurrentNoteFind(): void {
  if (!activeNote.value) return
  noteFindVisible.value = true
  void nextTick(() => {
    noteFindInput.value?.focus()
    noteFindInput.value?.select()
  })
}

/**
 * 响应桌面菜单中的搜索操作。
 *
 * :param target: 搜索入口类型。
 * :return: 无返回值。
 */
function handleSearchMenuCommand(target: SearchMenuTarget): void {
  if (target === 'quick-open') {
    openQuickOpen()
    return
  }
  if (target === 'current-note') {
    openCurrentNoteFind()
    return
  }
  setFilter('all')
  void nextTick(() => {
    searchInput.value?.focus()
    searchInput.value?.select()
  })
}

/**
 * 选择快速搜索结果并跳转到对应笔记。
 *
 * :param result: 待打开的快速搜索结果。
 * :return: 跳转完成后的 Promise。
 */
async function chooseQuickOpenResult(result: QuickOpenResult): Promise<void> {
  const keyword = quickOpenKeyword.value.trim()
  quickOpenVisible.value = false
  activeFilter.kind = 'all'
  activeFilter.id = null
  rememberQuickOpenKeyword(keyword)
  await selectNote(result.note)
  if (result.contentMatched && keyword) {
    noteFindVisible.value = true
    noteFindKeyword.value = keyword
    await nextTick()
    findInCurrentNote(1)
  }
}

/**
 * 将快速搜索中的当前选中项滚动到结果列表可视区域。
 *
 * :return: 无返回值。
 */
function scrollQuickOpenActiveResultIntoView(): void {
  void nextTick(() => {
    quickOpenResultsElement.value
      ?.querySelector<HTMLElement>('[aria-selected="true"]')
      ?.scrollIntoView({ block: 'nearest' })
  })
}

/**
 * 处理快速搜索面板的方向键、回车和退出操作。
 *
 * :param event: 键盘事件。
 * :return: 无返回值。
 */
function handleQuickOpenKeydown(event: KeyboardEvent): void {
  if (event.key === 'ArrowDown') {
    event.preventDefault()
    quickOpenActiveIndex.value = Math.min(quickOpenActiveIndex.value + 1, Math.max(quickOpenResults.value.length - 1, 0))
    scrollQuickOpenActiveResultIntoView()
  } else if (event.key === 'ArrowUp') {
    event.preventDefault()
    quickOpenActiveIndex.value = Math.max(quickOpenActiveIndex.value - 1, 0)
    scrollQuickOpenActiveResultIntoView()
  } else if (event.key === 'Enter') {
    event.preventDefault()
    const result = quickOpenResults.value[quickOpenActiveIndex.value]
    if (result) void chooseQuickOpenResult(result)
  } else if (event.key === 'Escape') {
    event.preventDefault()
    quickOpenVisible.value = false
  }
}

/**
 * 打开通用设置并读取当前快速记录配置。
 *
 * :return: 配置加载完成后的 Promise。
 */
async function openGeneralSettings(): Promise<void> {
  generalSettingsMessage.value = ''
  generalShortcutRecording.value = false
  quickOpenShortcutRecording.value = false
  draftQuickOpenShortcut.value = quickOpenShortcut.value
  draftShowTreeLines.value = showTreeLines.value
  try {
    const settings = await window.notesDesktop.getQuickCaptureSettings()
    generalShortcut.value = settings.shortcut
    generalQuickCaptureFolderId.value = settings.folderId
    generalSettingsVisible.value = true
  } catch (error) {
    actionError.value = error instanceof Error ? error.message : '通用设置加载失败'
  }
}

/**
 * 保存通用设置并立即应用侧边栏连接线状态。
 *
 * :return: 保存完成后的 Promise。
 */
async function saveGeneralSettings(): Promise<void> {
  if (generalSettingsSaving.value) return
  generalSettingsSaving.value = true
  generalSettingsMessage.value = ''
  try {
    await window.notesDesktop.saveQuickCaptureSettings({
      shortcut: generalShortcut.value,
      folderId: generalQuickCaptureFolderId.value
    })
    showTreeLines.value = draftShowTreeLines.value
    window.localStorage.setItem('notes-show-tree-lines', String(showTreeLines.value))
    quickOpenShortcut.value = draftQuickOpenShortcut.value
    window.localStorage.setItem('notes-quick-open-shortcut', quickOpenShortcut.value)
    generalSettingsVisible.value = false
  } catch (error) {
    generalSettingsMessage.value = error instanceof Error ? error.message : '通用设置保存失败'
  } finally {
    generalSettingsSaving.value = false
  }
}

/**
 * 将附件字节数格式化为易读文本。
 *
 * :param bytes: 字节数。
 * :return: 易读容量文本。
 */
function formatAttachmentSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`
}

/** 返回附件分类对应的图标。 */
function getAttachmentKindIcon(asset: AttachmentInventoryItem): string {
  if (asset.kind === 'image') return 'tabler:photo'
  if (asset.kind === 'document') return 'tabler:file-text'
  return 'tabler:file'
}

/** 返回附件本地与云端状态文案。 */
function getAttachmentStateLabel(asset: AttachmentInventoryItem): string {
  if (asset.state === 'missing') return '文件缺失'
  if (asset.state === 'corrupt') return '校验异常'
  if (asset.state === 'pending') return '待上传'
  return '已上传'
}

/** 返回附件来源及远程主机文案。 */
function getAttachmentSourceLabel(asset: AttachmentInventoryItem): string {
  if (asset.sourceKind === 'external-cache') {
    return asset.sourceHost ? `外链缓存 · ${asset.sourceHost}` : '外链缓存'
  }
  if (!asset.remoteUrl) return '本地附件'
  return asset.sourceHost ? `笔记附件 · ${asset.sourceHost}` : '笔记附件'
}

/** 从主进程刷新附件管理清单。 */
async function loadAttachmentInventory(showLoading = true): Promise<void> {
  if (showLoading) attachmentManagerLoading.value = true
  try {
    attachmentInventory.value = await window.notesDesktop.listAttachmentInventory()
  } finally {
    if (showLoading) attachmentManagerLoading.value = false
  }
}

/** 保存当前草稿后打开附件管理中心。 */
async function openAttachmentManager(): Promise<void> {
  attachmentManagerVisible.value = true
  attachmentManagerMessage.value = ''
  attachmentSearchKeyword.value = ''
  attachmentKindFilter.value = 'all'
  attachmentStateFilter.value = 'all'
  attachmentSourceFilter.value = 'all'
  try {
    await flushSave()
    await loadAttachmentInventory()
  } catch (error) {
    attachmentManagerMessage.value = error instanceof Error ? error.message : '附件清单加载失败'
    attachmentManagerLoading.value = false
  }
}

/** 关闭附件管理中心。 */
function closeAttachmentManager(): void {
  if (attachmentOperationId.value) return
  attachmentManagerVisible.value = false
  attachmentManagerMessage.value = ''
}

/** 使用系统默认应用打开附件。 */
async function openManagedAttachment(asset: AttachmentInventoryItem): Promise<void> {
  attachmentOperationId.value = asset.id
  attachmentManagerMessage.value = ''
  try {
    await window.notesDesktop.openAttachment(asset.id)
  } catch (error) {
    attachmentManagerMessage.value = error instanceof Error ? error.message : '附件打开失败'
  } finally {
    attachmentOperationId.value = ''
  }
}

/** 在 Finder 中显示附件文件。 */
async function revealManagedAttachment(asset: AttachmentInventoryItem): Promise<void> {
  attachmentOperationId.value = asset.id
  attachmentManagerMessage.value = ''
  try {
    await window.notesDesktop.revealAttachment(asset.id)
  } catch (error) {
    attachmentManagerMessage.value = error instanceof Error ? error.message : '无法打开附件所在目录'
  } finally {
    attachmentOperationId.value = ''
  }
}

/** 关闭附件中心并定位引用附件的指定笔记。 */
async function locateAttachmentReference(reference: AttachmentNoteReference): Promise<void> {
  let note = workspace.notes.find((item) => item.id === reference.id)
  if (!note) {
    await refreshWorkspace()
    note = workspace.notes.find((item) => item.id === reference.id)
  }
  if (!note) {
    attachmentManagerMessage.value = '引用笔记已不存在'
    return
  }
  attachmentManagerVisible.value = false
  searchKeyword.value = ''
  setFilter(note.isDeleted ? 'trash' : 'all')
  await selectNote(note)
}

/** 触发全库同步并刷新当前附件的上传状态。 */
async function retryManagedAttachmentUpload(asset: AttachmentInventoryItem): Promise<void> {
  if (!syncSettings.configured) {
    attachmentManagerMessage.value = '请先在同步中心连接云端账号'
    return
  }
  if (!asset.localExists) {
    attachmentManagerMessage.value = '本地文件缺失，无法重新上传'
    return
  }
  attachmentOperationId.value = asset.id
  attachmentManagerMessage.value = '正在重新上传并同步…'
  try {
    const status = await window.notesDesktop.runSync()
    Object.assign(syncStatus, status)
    if (status.state === 'error') throw new Error(status.message || '附件上传失败')
    await loadAttachmentInventory(false)
    const updated = attachmentInventory.value.items.find((item) => item.id === asset.id)
    attachmentManagerMessage.value = updated?.state === 'uploaded'
      ? `“${asset.fileName}”已上传`
      : status.message || '同步已完成'
  } catch (error) {
    attachmentManagerMessage.value = error instanceof Error ? error.message : '附件上传失败'
  } finally {
    attachmentOperationId.value = ''
  }
}

/** 校验全部附件，并尽量重下缺失文件或重传待上传文件。 */
async function repairAttachmentIntegrity(): Promise<void> {
  attachmentOperationId.value = '__repair_attachment_integrity__'
  attachmentManagerMessage.value = '正在校验附件并修复可恢复项目…'
  try {
    const result = await window.notesDesktop.repairAttachmentIntegrity()
    await loadAttachmentInventory(false)
    if (!result.candidateCount) {
      attachmentManagerMessage.value = '当前没有需要检查的附件'
      return
    }
    if (result.failedCount) {
      const examples = result.failures.slice(0, 3).map((failure) => `“${failure.fileName}”`).join('、')
      attachmentManagerMessage.value = `已检查 ${result.candidateCount} 个附件，修复 ${result.repairedCount} 个，${result.failedCount} 个未能修复：${examples}`
      return
    }
    attachmentManagerMessage.value = result.repairedCount
      ? `检查完成：${result.healthyCount} 个正常，修复 ${result.repairedCount} 个（重下 ${result.downloadedCount}、上传 ${result.uploadedCount}）`
      : `检查完成，${result.healthyCount} 个附件全部正常`
  } catch (error) {
    attachmentManagerMessage.value = error instanceof Error ? error.message : '附件完整性检查失败'
  } finally {
    attachmentOperationId.value = ''
  }
}

/** 确认后清理孤立附件记录并将本地文件移入废纸篓。 */
async function cleanOrphanAttachment(asset: AttachmentInventoryItem): Promise<void> {
  await flushSave()
  await loadAttachmentInventory(false)
  const current = attachmentInventory.value.items.find((item) => item.id === asset.id)
  if (!current?.isOrphan) {
    attachmentManagerMessage.value = '附件已有笔记引用，已取消清理'
    return
  }
  const confirmed = await requestConfirmation(
    '清理这个附件？',
    `“${current.fileName}”未被当前笔记或历史版本引用。本地文件将移入废纸篓，已上传的云端文件不会被删除。`,
    '清理附件'
  )
  if (!confirmed) return
  attachmentOperationId.value = current.id
  attachmentManagerMessage.value = ''
  try {
    const result = await window.notesDesktop.deleteOrphanAttachment(current.id)
    await loadAttachmentInventory(false)
    attachmentManagerMessage.value = result.removedLocalFile
      ? `“${current.fileName}”已移入废纸篓`
      : `“${current.fileName}”的无效记录已清理`
  } catch (error) {
    attachmentManagerMessage.value = error instanceof Error ? error.message : '附件清理失败'
  } finally {
    attachmentOperationId.value = ''
  }
}

/** 重新扫描并确认后，一次清理当前全部孤立附件。 */
async function cleanAllOrphanAttachments(): Promise<void> {
  await flushSave()
  await loadAttachmentInventory(false)
  const candidates = attachmentInventory.value.items.filter((asset) => asset.isOrphan)
  if (!candidates.length) {
    attachmentManagerMessage.value = '当前没有可清理的孤立附件'
    return
  }
  const localBytes = candidates.reduce((total, asset) => total + asset.localBytes, 0)
  const confirmed = await requestConfirmation(
    `一键清理 ${candidates.length} 个孤立附件？`,
    `这些附件未被当前笔记或历史版本引用，共占用 ${formatAttachmentSize(localBytes)}。本地文件将移入废纸篓，已上传的云端文件不会被删除。`,
    '一键清理'
  )
  if (!confirmed) return
  attachmentOperationId.value = '__all_orphan_attachments__'
  attachmentManagerMessage.value = '正在清理孤立附件…'
  try {
    const result = await window.notesDesktop.deleteAllOrphanAttachments(
      candidates.map((asset) => asset.id)
    )
    await loadAttachmentInventory(false)
    attachmentManagerMessage.value = result.failedCount
      ? `已清理 ${result.removedCount} 个附件，${result.failedCount} 个未能清理，可再次尝试`
      : `已清理 ${result.removedCount} 个孤立附件，其中 ${result.removedLocalFileCount} 个本地文件已移入废纸篓`
  } catch (error) {
    attachmentManagerMessage.value = error instanceof Error ? error.message : '孤立附件批量清理失败'
  } finally {
    attachmentOperationId.value = ''
  }
}

/**
 * 打开导入导出数据管理窗口。
 *
 * :return: 无返回值。
 */
function openDataTransfer(): void {
  dataTransferMessage.value = ''
  markdownImportTargetVisible.value = false
  dataTransferVisible.value = true
}

/**
 * 格式化数据库备份的本地时间。
 *
 * :param value: ISO 备份时间。
 * :return: 本地日期时间文本。
 */
function formatDatabaseBackupTime(value: string): string {
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  }).format(new Date(value))
}

/**
 * 格式化数据库备份文件大小。
 *
 * :param size: 文件字节数。
 * :return: 易读的文件大小文本。
 */
function formatDatabaseBackupSize(size: number): string {
  if (size < 1024 * 1024) return `${Math.max(1, Math.round(size / 1024))} KB`
  return `${(size / 1024 / 1024).toFixed(1)} MB`
}

/**
 * 返回数据库备份原因对应的界面标签。
 *
 * :param reason: 备份原因。
 * :return: 中文原因标签。
 */
function getDatabaseBackupReasonLabel(reason: DatabaseBackup['reason']): string {
  return {
    daily: '每日自动',
    manual: '手动创建',
    'before-import': '导入前保护',
    'pre-restore': '恢复前保护'
  }[reason]
}

/**
 * 刷新当前档案的完整备份列表。
 *
 * :return: 加载完成后的 Promise。
 */
async function loadDatabaseBackups(): Promise<void> {
  const [backups, settings] = await Promise.all([
    window.notesDesktop.listDatabaseBackups(),
    window.notesDesktop.getDatabaseBackupSettings()
  ])
  databaseBackups.value = backups
  Object.assign(databaseBackupSettings, settings)
}

/**
 * 保存当前档案的自动备份策略。
 *
 * :return: 保存完成后的 Promise。
 */
async function saveDatabaseBackupPolicy(): Promise<void> {
  databaseBackupBusy.value = true
  try {
    const settings = await window.notesDesktop.saveDatabaseBackupSettings({
      schedule: databaseBackupSettings.schedule,
      retention: databaseBackupSettings.retention
    })
    Object.assign(databaseBackupSettings, settings)
    await loadDatabaseBackups()
    databaseBackupMessage.value = '自动备份策略已保存'
  } catch (error) {
    databaseBackupMessage.value = error instanceof Error ? error.message : '备份策略保存失败'
  } finally {
    databaseBackupBusy.value = false
  }
}

/**
 * 打开完整自动备份管理窗口。
 *
 * :return: 打开完成后的 Promise。
 */
async function openDatabaseBackupManager(): Promise<void> {
  dataTransferVisible.value = false
  databaseBackupVisible.value = true
  databaseBackupBusy.value = true
  databaseBackupMessage.value = ''
  try {
    await loadDatabaseBackups()
  } catch (error) {
    databaseBackupMessage.value = error instanceof Error ? error.message : '备份列表加载失败'
  } finally {
    databaseBackupBusy.value = false
  }
}

/**
 * 立即创建当前档案的完整备份。
 *
 * :return: 创建完成后的 Promise。
 */
async function createDatabaseBackup(): Promise<void> {
  if (databaseBackupBusy.value) return
  databaseBackupBusy.value = true
  databaseBackupMessage.value = ''
  try {
    await flushSave()
    await window.notesDesktop.createDatabaseBackup()
    await loadDatabaseBackups()
    databaseBackupMessage.value = '当前数据库和附件已安全备份'
  } catch (error) {
    databaseBackupMessage.value = error instanceof Error ? error.message : '完整备份失败'
  } finally {
    databaseBackupBusy.value = false
  }
}

/**
 * 恢复指定完整备份。
 *
 * :param backup: 待恢复的备份摘要。
 * :return: 恢复完成后的 Promise。
 */
async function restoreDatabaseBackup(backup: DatabaseBackup): Promise<void> {
  const confirmed = await requestConfirmation(
    '恢复完整备份？',
    `将恢复到 ${formatDatabaseBackupTime(backup.createdAt)} 的状态。当前数据库和附件会先自动创建一份“恢复前保护”快照。`,
    '确认恢复'
  )
  if (!confirmed) return
  databaseBackupBusy.value = true
  databaseBackupMessage.value = ''
  try {
    await flushSave()
    const result = await window.notesDesktop.restoreDatabaseBackup(backup.id)
    await refreshWorkspace()
    await loadDatabaseBackups()
    databaseBackupMessage.value = `${result.message}，恢复前状态也已保留`
  } catch (error) {
    databaseBackupMessage.value = error instanceof Error ? error.message : '完整备份恢复失败'
  } finally {
    databaseBackupBusy.value = false
  }
}

/**
 * 在 Finder 中打开当前档案的备份目录。
 *
 * :return: 打开完成后的 Promise。
 */
async function openDatabaseBackupDirectory(): Promise<void> {
  try {
    await window.notesDesktop.openDatabaseBackupDirectory()
  } catch (error) {
    databaseBackupMessage.value = error instanceof Error ? error.message : '无法打开备份目录'
  }
}

/**
 * 执行导入导出操作并刷新受影响的工作区。
 *
 * :param operation: 待执行的数据操作。
 * :param refreshAfter: 完成后是否刷新工作区。
 * :return: 操作完成后的 Promise。
 */
async function runDataTransfer(
  operation: () => Promise<DataTransferResult>,
  refreshAfter = false
): Promise<void> {
  if (dataTransferBusy.value) return
  dataTransferBusy.value = true
  dataTransferMessage.value = ''
  actionError.value = ''
  try {
    await flushSave()
    const result = await operation()
    if (result.canceled) return
    dataTransferMessage.value = result.message || '操作已完成'
    if (refreshAfter) {
      await refreshWorkspace()
      const importedNote = result.noteIds?.[0]
        ? workspace.notes.find((note) => note.id === result.noteIds?.[0])
        : null
      if (importedNote) await selectNote(importedNote)
      if (result.rootFolderId) {
        expandedFolderIds.value = new Set([...expandedFolderIds.value, result.rootFolderId])
        activeFilter.kind = 'folder'
        activeFilter.id = result.rootFolderId
      }
    }
  } catch (error) {
    dataTransferMessage.value = error instanceof Error ? error.message : '导入导出失败'
  } finally {
    dataTransferBusy.value = false
  }
}

/**
 * 将当前笔记导出为 Markdown。
 *
 * :return: 操作完成后的 Promise。
 */
async function exportCurrentNoteMarkdown(): Promise<void> {
  if (!activeNoteId.value) return
  await runDataTransfer(() => window.notesDesktop.exportNoteMarkdown(activeNoteId.value as string))
}

/**
 * 将全部未删除笔记导出为 Markdown ZIP。
 *
 * :return: 操作完成后的 Promise。
 */
async function exportAllNotesMarkdown(): Promise<void> {
  await runDataTransfer(() => window.notesDesktop.exportAllMarkdown())
}

/**
 * 创建包含历史版本的完整备份。
 *
 * :return: 操作完成后的 Promise。
 */
async function exportCompleteBackup(): Promise<void> {
  await runDataTransfer(() => window.notesDesktop.exportFullBackup())
}

/**
 * 打开 Markdown 导入位置选择窗口。
 *
 * :return: 无返回值。
 */
function openMarkdownImportTarget(): void {
  markdownImportTargetFolderId.value = null
  markdownImportTargetVisible.value = true
}

/**
 * 选择目录并将其中的 Markdown 递归导入指定位置。
 *
 * :return: 操作完成后的 Promise。
 */
async function importMarkdownNotes(): Promise<void> {
  const targetFolderId = markdownImportTargetFolderId.value
  markdownImportTargetVisible.value = false
  await runDataTransfer(() => window.notesDesktop.importMarkdown(targetFolderId), true)
}

/**
 * 导入完整备份并生成独立副本。
 *
 * :return: 操作完成后的 Promise。
 */
async function importCompleteBackup(): Promise<void> {
  await runDataTransfer(() => window.notesDesktop.importFullBackup(), true)
}

/**
 * 将同步设置摘要覆盖到响应式状态。
 *
 * :param settings: Electron 返回的同步设置。
 * :return: 无返回值。
 */
function applySyncSettings(settings: SyncSettingsView): void {
  syncSettings.backendUrl = settings.backendUrl
  syncSettings.webUrl = settings.webUrl
  syncSettings.configured = settings.configured
  syncSettings.accountLabel = settings.accountLabel
}

/**
 * 从 Electron 主进程刷新同步设置。
 *
 * :return: 加载完成后的 Promise。
 */
async function loadSyncSettings(): Promise<void> {
  try {
    applySyncSettings(await window.notesDesktop.getSyncSettings())
  } catch (error) {
    actionError.value = error instanceof Error ? error.message : '同步设置加载失败'
  }
}

/**
 * 打开同步设置弹窗并填入当前配置。
 *
 * :return: 异步准备完成后的 Promise。
 */
async function openSyncSettings(): Promise<void> {
  await loadSyncSettings()
  syncForm.backendUrl = syncSettings.backendUrl
  syncForm.webUrl = syncSettings.webUrl
  syncForm.username = ''
  syncForm.password = ''
  verifiedBackendUrl.value = ''
  syncConnectionResult.ok = false
  syncConnectionResult.message = ''
  syncDialogVisible.value = true
}

/** 打开冲突处理中心并默认选中第一项。 */
function openConflictCenter(): void {
  const firstConflict = noteConflicts.value[0]
  if (!firstConflict) return
  selectedConflictNoteId.value = firstConflict.conflict.id
  conflictError.value = ''
  syncDialogVisible.value = false
  conflictCenterVisible.value = true
}

/** 关闭冲突处理中心，可返回同步中心。 */
function closeConflictCenter(reopenSyncCenter = true): void {
  if (conflictResolving.value) return
  conflictCenterVisible.value = false
  selectedConflictNoteId.value = ''
  conflictError.value = ''
  if (reopenSyncCenter) syncDialogVisible.value = true
}

/** 应用选定的冲突处理策略并刷新本地工作区。 */
async function resolveSelectedNoteConflict(strategy: 'local' | 'remote' | 'both'): Promise<void> {
  const pair = selectedNoteConflict.value
  if (!pair || conflictResolving.value) return
  conflictResolving.value = true
  conflictError.value = ''
  try {
    await flushSave()
    await window.notesDesktop.resolveNoteConflict(pair.conflict.id, strategy)
    await refreshWorkspace()
    const nextConflict = noteConflicts.value[0]
    if (nextConflict) selectedConflictNoteId.value = nextConflict.conflict.id
    else {
      conflictCenterVisible.value = false
      selectedConflictNoteId.value = ''
      syncDialogVisible.value = true
    }
  } catch (error) {
    conflictError.value = error instanceof Error ? error.message : '冲突处理失败'
  } finally {
    conflictResolving.value = false
  }
}

/**
 * 测试同步服务连通性与账号身份。
 *
 * :return: 测试完成后的 Promise。
 */
async function testSyncConnection(): Promise<void> {
  if (syncTesting.value) return
  syncTesting.value = true
  syncConnectionResult.ok = false
  syncConnectionResult.message = '正在连接并验证身份…'
  try {
    const result = await window.notesDesktop.testSyncConnection({
      backendUrl: syncForm.backendUrl,
      username: syncForm.username.trim() || undefined,
      password: syncForm.password || undefined
    })
    syncConnectionResult.ok = result.ok
    syncConnectionResult.message = result.message
    if (result.ok && result.backendUrl) {
      syncForm.backendUrl = result.backendUrl
      verifiedBackendUrl.value = result.backendUrl
    } else {
      verifiedBackendUrl.value = ''
    }
  } catch (error) {
    verifiedBackendUrl.value = ''
    syncConnectionResult.message = error instanceof Error ? error.message : '连接测试失败'
  } finally {
    syncTesting.value = false
  }
}

/**
 * 在系统浏览器中发起免密码登录授权。
 *
 * :return: 浏览器启动完成后的 Promise。
 */
async function startBrowserSyncLogin(): Promise<void> {
  if (syncBrowserLoginPending.value) return
  syncBrowserLoginPending.value = true
  syncConnectionResult.ok = false
  syncConnectionResult.message = '正在打开浏览器登录页…'
  try {
    const result = await window.notesDesktop.startBrowserSyncLogin({
      backendUrl: syncForm.backendUrl,
      webUrl: syncForm.webUrl
    })
    syncConnectionResult.ok = result.ok
    syncConnectionResult.message = result.message
    if (result.ok && result.backendUrl) {
      syncForm.backendUrl = result.backendUrl
      if (syncBrowserLoginTimer) clearTimeout(syncBrowserLoginTimer)
      syncBrowserLoginTimer = setTimeout(() => {
        syncBrowserLoginPending.value = false
        syncConnectionResult.ok = false
        syncConnectionResult.message = '浏览器授权等待已超时，请重新发起'
        syncBrowserLoginTimer = null
        void window.notesDesktop.cancelBrowserSyncLogin()
      }, 5 * 60 * 1000)
    } else {
      syncBrowserLoginPending.value = false
    }
  } catch (error) {
    syncBrowserLoginPending.value = false
    syncConnectionResult.message = error instanceof Error ? error.message : '无法发起浏览器登录'
  }
}

/**
 * 取消当前等待中的浏览器授权并恢复操作入口。
 *
 * :return: 取消完成后的 Promise。
 */
async function cancelBrowserSyncLogin(): Promise<void> {
  if (syncBrowserLoginTimer) {
    clearTimeout(syncBrowserLoginTimer)
    syncBrowserLoginTimer = null
  }
  const result = await window.notesDesktop.cancelBrowserSyncLogin()
  syncBrowserLoginPending.value = false
  syncConnectionResult.ok = false
  syncConnectionResult.message = result.message
}

/**
 * 接收主进程完成的一次性授权兑换结果。
 *
 * :param result: 浏览器授权结果。
 * :return: 结果处理完成后的 Promise。
 */
async function handleSyncAuthResult(result: SyncConnectionResult): Promise<void> {
  if (syncBrowserLoginTimer) {
    clearTimeout(syncBrowserLoginTimer)
    syncBrowserLoginTimer = null
  }
  syncBrowserLoginPending.value = false
  syncConnectionResult.ok = result.ok
  syncConnectionResult.message = result.message
  if (!result.ok) return
  syncForm.username = ''
  syncForm.password = ''
  verifiedBackendUrl.value = ''
  await loadSyncSettings()
}

/**
 * 保存已经通过连接测试的同步设置。
 *
 * :return: 保存完成后的 Promise。
 */
async function saveSyncSettings(): Promise<void> {
  if (!canSaveSyncSettings.value || syncSaving.value) return
  syncSaving.value = true
  try {
    applySyncSettings(await window.notesDesktop.saveSyncSettings({
      backendUrl: syncForm.backendUrl,
      webUrl: syncForm.webUrl
    }))
    syncDialogVisible.value = false
    syncForm.password = ''
    verifiedBackendUrl.value = ''
  } catch (error) {
    syncConnectionResult.ok = false
    syncConnectionResult.message = error instanceof Error ? error.message : '同步设置保存失败'
  } finally {
    syncSaving.value = false
  }
}

/**
 * 断开当前同步账号并清除本地 Token。
 *
 * :return: 操作完成后的 Promise。
 */
async function disconnectSyncAccount(): Promise<void> {
  const confirmed = await requestConfirmation(
    '断开同步账号？',
    '本地笔记不会删除，但在重新连接账号前不会进行云端同步。',
    '断开账号'
  )
  if (!confirmed) return
  applySyncSettings(await window.notesDesktop.clearSyncSettings())
  syncDialogVisible.value = false
  syncForm.password = ''
  verifiedBackendUrl.value = ''
}

/**
 * 判断当前编辑草稿是否仍有尚未落库的修改。
 *
 * :return: 存在防抖保存或正在保存时返回 true。
 */
function hasPendingDraftSave(): boolean {
  return Boolean(saveTimer) || saveState.value === 'saving'
}

/**
 * 判断当前编辑草稿与工作区中的笔记快照是否一致。
 *
 * :param note: 待比较的笔记快照。
 * :return: 标题、正文、文件夹、标签和置顶状态均一致时返回 true。
 */
function doesDraftMatchNote(note: OfflineNote): boolean {
  const draftTags = [...draft.tagNames].sort()
  const noteTags = note.tags.map((tag) => tag.name).sort()
  return draft.title === note.title
    && draft.content === note.content
    && draft.folderId === note.folderId
    && draft.isPinned === note.isPinned
    && draftTags.length === noteTags.length
    && draftTags.every((tag, index) => tag === noteTags[index])
}

/**
 * 把笔记内容载入编辑草稿，不触发保存。
 *
 * :param note: 待编辑笔记。
 * :return: 草稿加载完成后的 Promise。
 */
async function loadNoteIntoDraft(note: OfflineNote): Promise<void> {
  closePropertyPickers()
  draftReady = false
  activeNoteId.value = note.id
  draft.title = note.title
  draft.content = note.content
  draft.folderId = note.folderId
  draft.tagNames = note.tags.map((tag) => tag.name)
  draft.isPinned = note.isPinned
  if (note.folderId) {
    expandedFolderIds.value = new Set([...expandedFolderIds.value, note.folderId])
  } else {
    unclassifiedExpanded.value = true
  }
  saveState.value = 'idle'
  await nextTick()
  draftReady = true
}

/**
 * 保存当前草稿后切换到指定笔记。
 *
 * :param note: 待编辑笔记。
 * :return: 笔记切换完成后的 Promise。
 */
async function selectNote(note: OfflineNote): Promise<void> {
  await flushSave()
  await loadNoteIntoDraft(note)
}

/**
 * 应用新的笔记标签状态。
 *
 * :param state: 新的标签状态。
 * :return: 无返回值。
 */
function applyNoteTabsState(state: NoteTabsState): void {
  openNoteIds.value = state.noteIds
  activeTabNoteId.value = state.activeNoteId
}

/**
 * 将普通笔记打开操作同步到当前标签。
 *
 * :param noteId: 当前打开的笔记 ID。
 * :return: 无返回值。
 */
function syncCurrentNoteTab(noteId: string | null): void {
  if (!noteId) {
    activeTabNoteId.value = null
    return
  }
  applyNoteTabsState(activateNoteInCurrentTab({
    noteIds: openNoteIds.value,
    activeNoteId: activeTabNoteId.value
  }, noteId))
}

/**
 * 在新标签页中打开指定笔记。
 *
 * :param note: 待打开的笔记。
 * :return: 笔记切换完成后的 Promise。
 */
async function openNoteInNewTab(note: OfflineNote): Promise<void> {
  applyNoteTabsState(activateNoteInNewTab({
    noteIds: openNoteIds.value,
    activeNoteId: activeTabNoteId.value
  }, note.id))
  await selectNote(note)
}

/**
 * 从右键菜单在新标签页中打开笔记。
 *
 * :return: 笔记切换完成后的 Promise。
 */
async function openContextNoteInNewTab(): Promise<void> {
  const note = contextMenu.note
  closeContextMenu()
  if (note) await openNoteInNewTab(note)
}

/**
 * 切换到已打开的笔记标签。
 *
 * :param note: 待切换的笔记。
 * :return: 笔记切换完成后的 Promise。
 */
async function switchNoteTab(note: OfflineNote): Promise<void> {
  activeTabNoteId.value = note.id
  await selectNote(note)
}

/**
 * 关闭笔记标签，并在需要时切换到相邻笔记。
 *
 * :param noteId: 待关闭标签对应的笔记 ID。
 * :return: 标签关闭完成后的 Promise。
 */
async function closeNoteTab(noteId: string): Promise<void> {
  const nextState = getClosedNoteTabs({
    noteIds: openNoteIds.value,
    activeNoteId: activeTabNoteId.value
  }, noteId)
  await applyClosedNoteTabs(nextState)
}

/**
 * 应用关闭操作后的标签状态，并在当前标签变化时切换笔记。
 *
 * :param nextState: 关闭操作后的标签状态。
 * :return: 标签状态应用完成后的 Promise。
 */
async function applyClosedNoteTabs(nextState: NoteTabsState): Promise<void> {
  applyNoteTabsState(nextState)
  if (activeNoteId.value === nextState.activeNoteId) return
  const nextNote = workspace.notes.find((note) => note.id === nextState.activeNoteId && !note.isDeleted)
  if (nextNote) {
    await selectNote(nextNote)
    return
  }
  await flushSave()
  activeNoteId.value = null
}

/**
 * 打开标签右键菜单。
 *
 * :param event: 鼠标右键事件。
 * :param noteId: 标签对应的笔记 ID。
 * :return: 无返回值。
 */
function openNoteTabContextMenu(event: MouseEvent, noteId: string): void {
  noteTabOverflowVisible.value = false
  Object.assign(tabContextMenu, {
    noteId
  })
  void positionContextMenuInViewport(
    () => noteTabContextMenuElement.value,
    tabContextMenu,
    event.clientX,
    event.clientY
  )
}

/**
 * 执行标签关闭菜单命令。
 *
 * :param command: 标签关闭命令。
 * :return: 标签关闭完成后的 Promise。
 */
async function handleNoteTabCloseCommand(command: 'close' | 'others' | 'right'): Promise<void> {
  const noteId = tabContextMenu.noteId
  tabContextMenu.visible = false
  if (!noteId) return
  const state = { noteIds: openNoteIds.value, activeNoteId: activeTabNoteId.value }
  if (command === 'close') await applyClosedNoteTabs(getClosedNoteTabs(state, noteId))
  if (command === 'others') await applyClosedNoteTabs(closeOtherNoteTabs(state, noteId))
  if (command === 'right') await applyClosedNoteTabs(closeNoteTabsToRight(state, noteId))
}

/**
 * 从溢出列表切换到指定笔记。
 *
 * :param note: 待切换的笔记。
 * :return: 笔记切换完成后的 Promise。
 */
async function chooseOverflowNoteTab(note: OfflineNote): Promise<void> {
  noteTabOverflowVisible.value = false
  await switchNoteTab(note)
}

/**
 * 更新标签栏可用宽度。
 *
 * :param entries: 尺寸监听结果。
 * :return: 无返回值。
 */
function updateNoteTabBarWidth(entries: ResizeObserverEntry[]): void {
  noteTabBarWidth.value = entries[0]?.contentRect.width ?? noteTabBarElement.value?.clientWidth ?? 0
}

/**
 * 接收编辑器内容变化，仅写入变化所属的当前笔记。
 *
 * :param value: 最新 Markdown 内容。
 * :param documentId: 产生变化的文档 ID。
 * :return: 无返回值。
 */
function updateDraftContent(value: string, documentId: string): void {
  if (documentId !== activeNoteId.value) return
  draft.content = value
}

/**
 * 把更新后的笔记写回列表。
 *
 * :param note: 更新后的笔记。
 * :return: 无返回值。
 */
function replaceNote(note: OfflineNote): void {
  const index = workspace.notes.findIndex((item) => item.id === note.id)
  if (index >= 0) workspace.notes[index] = note
  else workspace.notes.unshift(note)
  workspace.notes.sort((left, right) => {
    if (left.isPinned !== right.isPinned) return left.isPinned ? -1 : 1
    return Date.parse(right.updatedAt) - Date.parse(left.updatedAt)
  })
}

/**
 * 将标签输入转换成去重后的名称数组。
 *
 * :return: 标签名称数组。
 */
function parseTagNames(): string[] {
  return [...new Set(draft.tagNames.map((name) => name.trim()).filter(Boolean))].slice(0, 12)
}

/**
 * 立即把编辑草稿保存到 SQLite。
 *
 * :return: 保存完成后的 Promise。
 */
async function saveDraft(): Promise<void> {
  if (!draftReady || !activeNoteId.value) return
  if (saveTimer) clearTimeout(saveTimer)
  saveTimer = undefined
  const currentNote = workspace.notes.find((note) => note.id === activeNoteId.value)
  if (currentNote && doesDraftMatchNote(currentNote)) {
    saveState.value = 'saved'
    return
  }
  const savingVersion = draftVersion
  saveState.value = 'saving'
  const patch: NotePatch = {
    title: draft.title.trim() || '无标题笔记',
    content: draft.content,
    folderId: draft.folderId,
    tagNames: parseTagNames(),
    isPinned: draft.isPinned
  }
  try {
    const note = await window.notesDesktop.updateNote(activeNoteId.value, patch)
    if (note) replaceNote(note)
    workspace.pendingCount = Math.max(workspace.pendingCount, 1)
    if (savingVersion === draftVersion) {
      saveState.value = 'saved'
      lastSavedAt.value = new Intl.DateTimeFormat('zh-CN', {
        hour: '2-digit',
        minute: '2-digit',
        hour12: false
      }).format(new Date())
      if (pendingRemoteRefresh) {
        pendingRemoteRefresh = false
        await refreshWorkspace()
      }
    } else {
      scheduleSave()
    }
  } catch (error) {
    saveState.value = 'error'
    actionError.value = error instanceof Error ? error.message : '保存失败'
  }
}

/**
 * 安排一次防抖自动保存。
 *
 * :return: 无返回值。
 */
function scheduleSave(): void {
  if (!draftReady) return
  draftVersion += 1
  saveState.value = 'idle'
  if (saveTimer) clearTimeout(saveTimer)
  saveTimer = setTimeout(() => void saveDraft(), NOTE_AUTOSAVE_DELAY_MS)
}

/**
 * 提交仍在等待的自动保存。
 *
 * :return: 保存完成后的 Promise。
 */
async function flushSave(): Promise<void> {
  if (!saveTimer) return
  clearTimeout(saveTimer)
  saveTimer = undefined
  await saveDraft()
}

/**
 * 打开当前笔记的同步历史版本。
 *
 * :return: 历史版本加载完成后的 Promise。
 */
async function openNoteHistory(): Promise<void> {
  if (!activeNoteId.value) return
  historyVisible.value = true
  historyLoading.value = true
  try {
    await flushSave()
    noteHistories.value = await window.notesDesktop.listNoteHistory(activeNoteId.value)
    selectedHistoryId.value = noteHistories.value[0]?.id ?? null
  } finally {
    historyLoading.value = false
  }
  await loadSelectedHistory(selectedHistoryId.value)
}

/**
 * 按需加载选中历史版本的完整正文。
 *
 * :param historyId: 历史版本 ID。
 * :return: 详情加载完成后的 Promise。
 */
async function loadSelectedHistory(historyId: string | null): Promise<void> {
  if (!activeNoteId.value || !historyId) return
  const existing = noteHistories.value.find((history) => history.id === historyId)
  if (existing?.content) return
  historyDetailLoading.value = true
  try {
    const detail = await window.notesDesktop.getNoteHistory(activeNoteId.value, historyId)
    if (!detail || selectedHistoryId.value !== historyId) return
    const index = noteHistories.value.findIndex((history) => history.id === historyId)
    if (index >= 0) noteHistories.value[index] = detail
  } finally {
    if (selectedHistoryId.value === historyId) historyDetailLoading.value = false
  }
}

/**
 * 选择历史版本并加载完整正文。
 *
 * :param historyId: 历史版本 ID。
 * :return: 详情加载完成后的 Promise。
 */
async function selectHistory(historyId: string): Promise<void> {
  selectedHistoryId.value = historyId
  await loadSelectedHistory(historyId)
}

/**
 * 恢复当前选中的历史版本。
 *
 * :return: 恢复完成后的 Promise。
 */
async function restoreSelectedHistory(): Promise<void> {
  if (!activeNoteId.value || !selectedHistoryId.value) return
  const confirmed = await requestConfirmation(
    '恢复历史版本？',
    '当前内容会先保存为一条历史记录，然后替换为所选版本。',
    '恢复版本'
  )
  if (!confirmed) return
  const restored = await window.notesDesktop.restoreNoteHistory(
    activeNoteId.value,
    selectedHistoryId.value
  )
  if (!restored) return
  replaceNote(restored)
  await loadNoteIntoDraft(restored)
  historyVisible.value = false
}

/**
 * 删除当前选中的同步历史版本。
 *
 * :return: 删除完成后的 Promise。
 */
async function deleteSelectedHistory(): Promise<void> {
  if (!activeNoteId.value || !selectedHistoryId.value) return
  const confirmed = await requestConfirmation(
    '删除历史版本？',
    '这条历史记录会从已同步设备中删除，删除后无法恢复。',
    '删除版本'
  )
  if (!confirmed) return
  await window.notesDesktop.deleteNoteHistory(activeNoteId.value, selectedHistoryId.value)
  noteHistories.value = noteHistories.value.filter((history) => history.id !== selectedHistoryId.value)
  selectedHistoryId.value = noteHistories.value[0]?.id ?? null
}

/**
 * 新建笔记并切换到编辑器。
 *
 * :return: 新建完成后的 Promise。
 */
async function createNote(): Promise<void> {
  createMenuVisible.value = false
  const folderId = activeFilter.kind === 'folder' ? activeFilter.id : null
  await createNoteInFolder(folderId)
}

/**
 * 在指定文件夹中新建笔记并展开对应目录。
 *
 * :param folderId: 目标文件夹标识，空值表示未分类。
 * :return: 新建完成后的 Promise。
 */
async function createNoteInFolder(folderId: string | null): Promise<void> {
  createMenuVisible.value = false
  await flushSave()
  const note = await window.notesDesktop.createNote(folderId)
  workspace.notes.unshift(note)
  workspace.pendingCount += 1
  if (folderId) {
    expandedFolderIds.value = new Set([...expandedFolderIds.value, folderId])
  } else {
    unclassifiedExpanded.value = true
  }
  await selectNote(note)
}

/**
 * 打开笔记复制位置选择窗口。
 *
 * :param note: 待复制的原笔记。
 * :return: 无返回值。
 */
function openDuplicateNoteDialog(note: OfflineNote): void {
  duplicateNoteSource.value = note
  duplicateNoteTargetFolderId.value = note.folderId
  duplicateNoteTitle.value = `${note.title.slice(0, 97)} 副本`
  duplicateNoteVisible.value = true
}

/**
 * 将选中的笔记复制到目标文件夹并打开副本。
 *
 * :return: 复制完成后的 Promise。
 */
async function submitDuplicateNote(): Promise<void> {
  const source = duplicateNoteSource.value
  if (!source || duplicateNoteBusy.value) return
  duplicateNoteBusy.value = true
  try {
    await flushSave()
    const note = await window.notesDesktop.duplicateNote(
      source.id,
      duplicateNoteTargetFolderId.value,
      duplicateNoteTitle.value
    )
    workspace.notes.unshift(note)
    workspace.pendingCount += 1
    if (note.folderId) {
      expandedFolderIds.value = new Set([...expandedFolderIds.value, note.folderId])
    } else {
      unclassifiedExpanded.value = true
    }
    duplicateNoteVisible.value = false
    duplicateNoteSource.value = null
    await selectNote(note)
  } catch (error) {
    actionError.value = error instanceof Error ? error.message : '复制笔记失败'
  } finally {
    duplicateNoteBusy.value = false
  }
}

/**
 * 打开新建文件夹弹窗。
 *
 * :return: 无返回值。
 */
function openCreateFolderDialog(parentId: string | null = null): void {
  createMenuVisible.value = false
  folderDialogMode.value = 'create'
  editingFolderId.value = null
  folderDialogParentId.value = parentId
  folderName.value = ''
  folderDialogVisible.value = true
}

/**
 * 打开文件夹重命名弹窗。
 *
 * :param folder: 待重命名文件夹。
 * :return: 无返回值。
 */
function openRenameFolderDialog(folder: NoteFolder): void {
  folderDialogMode.value = 'rename'
  editingFolderId.value = folder.id
  folderDialogParentId.value = folder.parentId
  folderName.value = folder.name
  folderDialogVisible.value = true
}

/**
 * 关闭编辑器属性选择浮层。
 *
 * :return: 无返回值。
 */
function closePropertyPickers(): void {
  folderPickerVisible.value = false
  tagPickerVisible.value = false
  tagSearchKeyword.value = ''
}

/**
 * 切换文件夹选择浮层。
 *
 * :return: 无返回值。
 */
function toggleFolderPicker(): void {
  const nextVisible = !folderPickerVisible.value
  closePropertyPickers()
  folderPickerSearchKeyword.value = ''
  folderPickerVisible.value = nextVisible
  if (nextVisible) void nextTick(() => folderPickerSearchInput.value?.focus())
}

/**
 * 切换标签多选浮层。
 *
 * :return: 无返回值。
 */
function toggleTagPicker(): void {
  const nextVisible = !tagPickerVisible.value
  closePropertyPickers()
  tagPickerVisible.value = nextVisible
}

/**
 * 更新草稿所属文件夹并关闭选择浮层。
 *
 * :param folderId: 文件夹 ID，空值代表未分类。
 * :return: 无返回值。
 */
function selectDraftFolder(folderId: string | null): void {
  draft.folderId = folderId
  folderPickerVisible.value = false
}

/**
 * 切换草稿中的指定标签。
 *
 * :param tag: 待切换标签。
 * :return: 无返回值。
 */
function toggleDraftTag(tag: NoteTag): void {
  if (draft.tagNames.includes(tag.name)) {
    draft.tagNames = draft.tagNames.filter((name) => name !== tag.name)
    return
  }
  if (draft.tagNames.length < 12) draft.tagNames = [...draft.tagNames, tag.name]
}

/**
 * 打开新建标签弹窗。
 *
 * :param attachToDraft: 创建后是否自动加入当前笔记。
 * :return: 无返回值。
 */
function openCreateTagDialog(attachToDraft: boolean = false): void {
  createMenuVisible.value = false
  tagDialogAttachToDraft.value = attachToDraft
  tagName.value = ''
  tagDialogVisible.value = true
}

/**
 * 创建标签并按需加入当前草稿。
 *
 * :return: 创建完成后的 Promise。
 */
async function submitTag(): Promise<void> {
  const name = tagName.value.trim()
  if (!name) return
  try {
    const tag = await window.notesDesktop.createTag(name)
    if (!workspace.tags.some((item) => item.id === tag.id)) {
      workspace.tags.push(tag)
      workspace.tags.sort((left, right) => left.name.localeCompare(right.name, 'zh-CN'))
      workspace.pendingCount += 1
    }
    if (tagDialogAttachToDraft.value && !draft.tagNames.includes(tag.name)) {
      draft.tagNames = [...draft.tagNames, tag.name].slice(0, 12)
    }
    tagName.value = ''
    tagDialogVisible.value = false
    tagPickerVisible.value = false
  } catch (error) {
    actionError.value = error instanceof Error ? error.message : '标签创建失败'
  }
}

/**
 * 切换文件夹目录的展开状态。
 *
 * :param folderId: 文件夹标识。
 * :return: 无返回值。
 */
function toggleFolder(folderId: string): void {
  const nextIds = new Set(expandedFolderIds.value)
  if (nextIds.has(folderId)) nextIds.delete(folderId)
  else nextIds.add(folderId)
  expandedFolderIds.value = nextIds
}

/**
 * 从拖拽事件中读取心悦笔记资源。
 *
 * :param event: 拖拽事件。
 * :return: 合法资源信息，无法解析时返回空值。
 */
function readDraggedResource(event: DragEvent): ResourceDragData | null {
  try {
    const value = JSON.parse(event.dataTransfer?.getData('application/x-xinyue-resource') || '')
    if ((value?.kind === 'note' || value?.kind === 'folder') && typeof value.id === 'string') return value
  } catch {
    return null
  }
  return null
}

/**
 * 记录正在拖动的资源，供非法目标判断和边缘滚动使用。
 */
function startResourceDrag(event: DragEvent, resource: ResourceDragData): void {
  if (!resourceDragEnabled.value || !event.dataTransfer) return
  event.dataTransfer.effectAllowed = 'move'
  event.dataTransfer.setData('application/x-xinyue-resource', JSON.stringify(resource))
  draggedResource.value = resource
}

/** 停止侧边栏拖拽边缘滚动。 */
function stopResourceAutoScroll(): void {
  resourceAutoScrollDelta = 0
  if (resourceAutoScrollFrame !== null) cancelAnimationFrame(resourceAutoScrollFrame)
  resourceAutoScrollFrame = null
}

/** 按当前速度持续滚动侧边栏资源列表。 */
function runResourceAutoScroll(): void {
  if (!sidebarResourceScroll.value || !resourceAutoScrollDelta) {
    stopResourceAutoScroll()
    return
  }
  sidebarResourceScroll.value.scrollTop += resourceAutoScrollDelta
  resourceAutoScrollFrame = requestAnimationFrame(runResourceAutoScroll)
}

/** 根据拖拽指针位置启动、调整或停止边缘滚动。 */
function handleResourceAutoScroll(event: DragEvent): void {
  if (!draggedResource.value || !resourceDragEnabled.value) return
  const element = event.currentTarget as HTMLElement
  const bounds = element.getBoundingClientRect()
  resourceAutoScrollDelta = getDragAutoScrollDelta(event.clientY, bounds.top, bounds.bottom)
  if (!resourceAutoScrollDelta) {
    stopResourceAutoScroll()
  } else if (resourceAutoScrollFrame === null) {
    resourceAutoScrollFrame = requestAnimationFrame(runResourceAutoScroll)
  }
}

/** 指针真正离开侧边栏滚动区时停止边缘滚动。 */
function handleResourceAutoScrollLeave(event: DragEvent): void {
  const element = event.currentTarget as HTMLElement
  if (event.relatedTarget instanceof Node && element.contains(event.relatedTarget)) return
  stopResourceAutoScroll()
}

/** 清理一次资源拖拽产生的全局状态。 */
function finishResourceDrag(): void {
  draggedResource.value = null
  stopResourceAutoScroll()
}

/**
 * 将资源移动到未分类或根目录末尾。
 *
 * :param event: 拖拽事件。
 * :return: 移动完成后的 Promise。
 */
async function dropResourceAtRoot(event: DragEvent): Promise<void> {
  if (!resourceDragEnabled.value) return
  event.preventDefault()
  const resource = readDraggedResource(event)
  if (!resource) return
  try {
    if (resource.kind === 'note') await window.notesDesktop.updateNote(resource.id, { folderId: null })
    else await window.notesDesktop.moveFolder(resource.id, null, null)
    applyWorkspace(await window.notesDesktop.listWorkspace())
  } catch (error) {
    actionError.value = error instanceof Error ? error.message : '移动失败'
  }
}

/**
 * 将资源移动到目标文件夹或目标文件夹相邻位置。
 *
 * :param payload: 文件夹放置位置与原始事件。
 * :return: 移动完成后的 Promise。
 */
async function dropResourceOnFolder(payload: FolderDropPayload): Promise<void> {
  if (!resourceDragEnabled.value) return
  const resource = readDraggedResource(payload.event)
  if (!resource) return
  // 文件夹落在自身的任意区域都视为取消拖拽，避免无意义的移动和错误提示。
  if (resource.kind === 'folder' && blockedFolderDropIds.value.has(payload.folder.id)) return
  try {
    if (resource.kind === 'note') {
      await window.notesDesktop.updateNote(resource.id, { folderId: payload.folder.id })
      expandedFolderIds.value = new Set([...expandedFolderIds.value, payload.folder.id])
    } else {
      const parentId = payload.position === 'inside' ? payload.folder.id : payload.folder.parentId
      let beforeFolderId: string | null = payload.position === 'before' ? payload.folder.id : null
      if (payload.position === 'after') {
        const siblings = workspace.folders.filter((folder) => (
          !folder.isDeleted && folder.parentId === payload.folder.parentId && folder.id !== resource.id
        ))
        const targetIndex = siblings.findIndex((folder) => folder.id === payload.folder.id)
        beforeFolderId = siblings[targetIndex + 1]?.id ?? null
      }
      await window.notesDesktop.moveFolder(resource.id, parentId, beforeFolderId)
      if (parentId) expandedFolderIds.value = new Set([...expandedFolderIds.value, parentId])
    }
    applyWorkspace(await window.notesDesktop.listWorkspace())
  } catch (error) {
    actionError.value = error instanceof Error ? error.message : '移动失败'
  }
}

/**
 * 返回符合搜索条件的未分类笔记。
 *
 * :return: 未分类笔记列表。
 */
function getUnclassifiedNotes(): OfflineNote[] {
  return explorerNotes.value.filter((note) => note.folderId === null)
}

/**
 * 更新指定笔记的置顶状态。
 *
 * :param note: 待更新笔记。
 * :param pinned: 是否置顶。
 * :return: 更新完成后的 Promise。
 */
async function setNotePinned(note: OfflineNote, pinned: boolean): Promise<void> {
  await flushSave()
  const updatedNote = await window.notesDesktop.updateNote(note.id, { isPinned: pinned })
  if (!updatedNote) return
  replaceNote(updatedNote)
  workspace.pendingCount = Math.max(workspace.pendingCount, 1)
  if (activeNoteId.value === note.id) draft.isPinned = pinned
}

/**
 * 更新指定笔记的回收站状态。
 *
 * :param note: 待更新笔记。
 * :param deleted: 是否移入回收站。
 * :return: 更新完成后的 Promise。
 */
async function setNoteDeleted(note: OfflineNote, deleted: boolean): Promise<void> {
  if (deleted) {
    const confirmed = await requestConfirmation(
      `将“${note.title || '无标题笔记'}”移入回收站？`,
      '笔记会保留在回收站中，之后仍可恢复。',
      '移入回收站'
    )
    if (!confirmed) return
  }
  await flushSave()
  const updatedNote = await window.notesDesktop.setNoteDeleted(note.id, deleted)
  if (updatedNote) replaceNote(updatedNote)
  workspace.pendingCount = Math.max(workspace.pendingCount, 1)
  if (activeNoteId.value !== note.id) return
  const target = visibleNotes.value.find((item) => item.id !== note.id)
  if (target) await selectNote(target)
  else activeNoteId.value = null
}

/**
 * 打开应用内确认弹窗并等待用户选择。
 *
 * :param title: 弹窗标题。
 * :param message: 操作说明。
 * :param confirmLabel: 确认按钮文字。
 * :return: 用户是否确认操作。
 */
function requestConfirmation(title: string, message: string, confirmLabel: string = '删除'): Promise<boolean> {
  if (confirmationResolver) confirmationResolver(false)
  confirmationDialog.title = title
  confirmationDialog.message = message
  confirmationDialog.confirmLabel = confirmLabel
  confirmationDialog.visible = true
  return new Promise((resolve) => {
    confirmationResolver = resolve
  })
}

/**
 * 关闭应用内确认弹窗并返回用户选择。
 *
 * :param confirmed: 是否确认操作。
 * :return: 无返回值。
 */
function resolveConfirmation(confirmed: boolean): void {
  confirmationDialog.visible = false
  const resolver = confirmationResolver
  confirmationResolver = null
  resolver?.(confirmed)
}

/**
 * 永久删除指定回收站笔记。
 *
 * :param note: 待永久删除笔记。
 * :return: 删除完成后的 Promise。
 */
async function deleteNotePermanently(note: OfflineNote): Promise<void> {
  const confirmed = await requestConfirmation(
    '永久删除笔记？',
    `“${note.title}”删除后无法恢复，请确认是否继续。`,
    '永久删除'
  )
  if (!confirmed) return
  await window.notesDesktop.deleteNotePermanently(note.id)
  workspace.notes = workspace.notes.filter((item) => item.id !== note.id)
  workspace.pendingCount += 1
  if (activeNoteId.value !== note.id) return
  const target = visibleNotes.value[0]
  if (target) await selectNote(target)
  else activeNoteId.value = null
}

/**
 * 永久清空回收站中的全部文件夹和笔记。
 *
 * :return: 操作完成后的 Promise。
 */
async function emptyTrash(): Promise<void> {
  if (!recycleItemCount.value) return
  const confirmed = await requestConfirmation(
    '清空回收站？',
    `回收站中的 ${deletedFolders.value.length} 个文件夹和 ${deletedNotes.value.length} 篇笔记将被永久删除，此操作无法撤销。`,
    '清空回收站'
  )
  if (!confirmed) return
  await flushSave()
  await window.notesDesktop.emptyTrash()
  applyWorkspace(await window.notesDesktop.listWorkspace())
  activeNoteId.value = null
}

/**
 * 切换当前导航筛选。
 *
 * :param kind: 筛选类型。
 * :param id: 文件夹或标签 ID。
 * :return: 无返回值。
 */
function setFilter(kind: FilterKind, id: string | null = null): void {
  activeFilter.kind = kind
  activeFilter.id = id
  void nextTick(() => {
    const currentVisible = visibleNotes.value.some((note) => note.id === activeNoteId.value)
    if (!currentVisible && visibleNotes.value[0]) void selectNote(visibleNotes.value[0])
    else if (!currentVisible) activeNoteId.value = null
  })
}

/**
 * 根据共享导航项切换桌面端筛选。
 *
 * :param kind: 共享导航类型。
 * :return: 无返回值。
 */
function selectNavigation(kind: NoteNavigationKind): void {
  setFilter(kind)
}

/**
 * 切换标签筛选，再次点击当前标签时恢复全部笔记。
 *
 * :param tagId: 标签 ID。
 * :return: 无返回值。
 */
function toggleTagFilter(tagId: string): void {
  if (activeFilter.kind === 'tag' && activeFilter.id === tagId) {
    setFilter('all')
    return
  }
  setFilter('tag', tagId)
}

/**
 * 保存新文件夹。
 *
 * :return: 保存完成后的 Promise。
 */
async function submitFolder(): Promise<void> {
  const name = folderName.value.trim()
  if (!name) return
  try {
    if (folderDialogMode.value === 'rename' && editingFolderId.value) {
      const folder = await window.notesDesktop.renameFolder(editingFolderId.value, name)
      if (folder) {
        const index = workspace.folders.findIndex((item) => item.id === folder.id)
        if (index >= 0) workspace.folders[index] = folder
      }
    } else {
      const folder = await window.notesDesktop.createFolder(name, folderDialogParentId.value)
      workspace.folders.push(folder)
      expandedFolderIds.value = new Set([
        ...expandedFolderIds.value,
        folder.id,
        ...(folder.parentId ? [folder.parentId] : [])
      ])
      setFilter('all')
    }
    workspace.pendingCount += 1
    folderName.value = ''
    editingFolderId.value = null
    folderDialogParentId.value = null
    folderDialogVisible.value = false
  } catch (error) {
    actionError.value = error instanceof Error ? error.message : '文件夹保存失败'
  }
}

/**
 * 关闭资源右键菜单。
 *
 * :return: 无返回值。
 */
function closeContextMenu(): void {
  contextMenu.visible = false
  contextMenu.unclassified = false
  contextMenu.folder = null
  contextMenu.note = null
  contextMenu.tag = null
}

const CONTEXT_MENU_MARGIN = 12
const CONTEXT_MENU_MIN_TOP = 64

/**
 * 菜单渲染后按真实宽高修正位置，避免靠近视口边缘时被裁切。
 *
 * :param getMenuElement: 获取已渲染菜单元素的方法。
 * :param position: 菜单的响应式位置和可见状态。
 * :param preferredX: 指针期望横坐标。
 * :param preferredY: 指针期望纵坐标。
 * :return: 定位完成后的 Promise。
 */
async function positionContextMenuInViewport(
  getMenuElement: () => HTMLElement | null,
  position: { visible: boolean, x: number, y: number },
  preferredX: number,
  preferredY: number
): Promise<void> {
  position.x = Math.max(CONTEXT_MENU_MARGIN, preferredX)
  position.y = Math.max(CONTEXT_MENU_MIN_TOP, preferredY)
  position.visible = true
  await nextTick()
  if (!position.visible) return

  const menuRect = getMenuElement()?.getBoundingClientRect()
  if (!menuRect) return
  position.x = Math.max(
    CONTEXT_MENU_MARGIN,
    Math.min(preferredX, window.innerWidth - menuRect.width - CONTEXT_MENU_MARGIN)
  )
  position.y = Math.max(
    CONTEXT_MENU_MIN_TOP,
    Math.min(preferredY, window.innerHeight - menuRect.height - CONTEXT_MENU_MARGIN)
  )
}

/**
 * 根据指针位置打开文件夹右键菜单。
 *
 * :param event: 鼠标事件。
 * :param folder: 目标文件夹。
 * :return: 无返回值。
 */
function openFolderContextMenu(event: MouseEvent, folder: NoteFolder): void {
  createMenuVisible.value = false
  contextMenu.unclassified = false
  contextMenu.folder = folder
  contextMenu.note = null
  contextMenu.tag = null
  void positionContextMenuInViewport(
    () => resourceContextMenuElement.value,
    contextMenu,
    event.clientX,
    event.clientY
  )
}

/**
 * 根据指针位置打开笔记右键菜单。
 *
 * :param event: 鼠标事件。
 * :param note: 目标笔记。
 * :return: 无返回值。
 */
function openNoteContextMenu(event: MouseEvent, note: OfflineNote): void {
  createMenuVisible.value = false
  contextMenu.unclassified = false
  contextMenu.folder = null
  contextMenu.note = note
  contextMenu.tag = null
  void positionContextMenuInViewport(
    () => resourceContextMenuElement.value,
    contextMenu,
    event.clientX,
    event.clientY
  )
}

/**
 * 根据指针位置打开标签右键菜单。
 *
 * :param event: 鼠标事件。
 * :param tag: 目标标签。
 * :return: 无返回值。
 */
function openTagContextMenu(event: MouseEvent, tag: NoteTag): void {
  createMenuVisible.value = false
  contextMenu.unclassified = false
  contextMenu.folder = null
  contextMenu.note = null
  contextMenu.tag = tag
  void positionContextMenuInViewport(
    () => resourceContextMenuElement.value,
    contextMenu,
    event.clientX,
    event.clientY
  )
}

/**
 * 根据指针位置打开未分类文件夹右键菜单。
 *
 * :param event: 鼠标事件。
 * :return: 无返回值。
 */
function openUnclassifiedContextMenu(event: MouseEvent): void {
  createMenuVisible.value = false
  contextMenu.unclassified = true
  contextMenu.folder = null
  contextMenu.note = null
  contextMenu.tag = null
  void positionContextMenuInViewport(
    () => resourceContextMenuElement.value,
    contextMenu,
    event.clientX,
    event.clientY
  )
}

/**
 * 在未分类文件夹中新建笔记并关闭右键菜单。
 *
 * :return: 新建完成后的 Promise。
 */
async function createUnclassifiedNoteFromContext(): Promise<void> {
  closeContextMenu()
  await createNoteInFolder(null)
}

/**
 * 执行文件夹右键菜单命令。
 *
 * :param command: 文件夹命令。
 * :return: 命令完成后的 Promise。
 */
async function handleFolderContextCommand(
  command: 'create' | 'create-folder' | 'rename' | 'delete' | 'restore' | 'permanent'
): Promise<void> {
  const folder = contextMenu.folder
  closeContextMenu()
  if (!folder) return
  if (command === 'create') await createNoteInFolder(folder.id)
  if (command === 'create-folder') openCreateFolderDialog(folder.id)
  if (command === 'rename') openRenameFolderDialog(folder)
  if (command === 'delete') await removeFolder(folder)
  if (command === 'restore') await restoreFolder(folder)
  if (command === 'permanent') await deleteFolderPermanently(folder)
}

/**
 * 执行笔记右键菜单命令。
 *
 * :param command: 笔记命令。
 * :return: 命令完成后的 Promise。
 */
async function handleNoteContextCommand(
  command: 'duplicate' | 'copy-link' | 'pin' | 'trash' | 'restore' | 'delete'
): Promise<void> {
  const note = contextMenu.note
  closeContextMenu()
  if (!note) return
  if (command === 'duplicate') openDuplicateNoteDialog(note)
  if (command === 'copy-link') await copyNoteLink(note)
  if (command === 'pin') await setNotePinned(note, !note.isPinned)
  if (command === 'trash') await setNoteDeleted(note, true)
  if (command === 'restore') await setNoteDeleted(note, false)
  if (command === 'delete') await deleteNotePermanently(note)
}

/**
 * 在页面顶部显示短暂的复制结果提示。
 *
 * :param message: 待显示的提示内容。
 * :return: 无返回值。
 */
function showLinkCopyFeedback(message: string): void {
  linkCopyFeedback.value = message
  if (linkCopyFeedbackTimer) clearTimeout(linkCopyFeedbackTimer)
  linkCopyFeedbackTimer = setTimeout(() => {
    linkCopyFeedback.value = ''
    linkCopyFeedbackTimer = null
  }, 1800)
}

/**
 * 将可唤起应用的当前笔记深链接复制到剪贴板。
 *
 * :param note: 待复制链接的笔记。
 * :return: 复制完成后的 Promise。
 */
async function copyNoteLink(note: OfflineNote): Promise<void> {
  let serverId = note.serverId
  if (!serverId && syncSettings.configured) {
    const status = await window.notesDesktop.runSync()
    if (status.state !== 'error') {
      const refreshedWorkspace = await window.notesDesktop.listWorkspace()
      serverId = refreshedWorkspace.notes.find((item) => item.id === note.id)?.serverId ?? null
    }
  }
  if (!serverId) {
    actionError.value = syncSettings.configured
      ? '笔记尚未同步到服务器，请稍后重试'
      : '请先连接同步账号，再复制网页版笔记链接'
    return
  }
  const noteLink = new URL(
    `/notes/${encodeURIComponent(serverId)}`,
    syncSettings.webUrl
  ).toString()
  const noteTitle = note.title.trim() || '无标题笔记'
  const markdownLink = `[${noteTitle}](${noteLink})`
  const anchor = document.createElement('a')
  anchor.href = noteLink
  anchor.textContent = noteTitle
  try {
    if (typeof ClipboardItem === 'undefined' || !navigator.clipboard.write) {
      await navigator.clipboard.writeText(markdownLink)
    } else {
      await navigator.clipboard.write([
        new ClipboardItem({
          'text/html': new Blob([anchor.outerHTML], { type: 'text/html' }),
          'text/plain': new Blob([markdownLink], { type: 'text/plain' })
        })
      ])
    }
    showLinkCopyFeedback('笔记链接已复制')
  } catch {
    showLinkCopyFeedback('复制失败，请检查剪贴板权限')
  }
}

/**
 * 根据外部深链接定位并打开本地笔记。
 *
 * :param noteId: 待打开的笔记 ID。
 * :return: 定位完成后的 Promise。
 */
async function openNoteFromLink(noteId: string): Promise<void> {
  if (!noteId) return
  if (initialWorkspaceLoad) await initialWorkspaceLoad
  const note = workspace.notes.find(
    (item) => (item.id === noteId || item.serverId === noteId) && !item.isDeleted
  )
  if (!note) {
    actionError.value = '链接对应的笔记不存在，或已被删除'
    return
  }
  searchKeyword.value = ''
  setFilter('all')
  await selectNote(note)
}

/**
 * 执行标签右键菜单中的删除命令。
 *
 * :return: 删除完成后的 Promise。
 */
async function handleTagContextDelete(): Promise<void> {
  const tag = contextMenu.tag
  closeContextMenu()
  if (tag) await removeTag(tag)
}

/**
 * 应用并持久化用户选择的主题模式。
 *
 * :param mode: 用户选择的主题模式。
 * :return: 应用完成后的 Promise。
 */
async function selectTheme(mode: ThemeMode): Promise<void> {
  themeMode.value = mode
  document.documentElement.dataset.theme = mode === 'system'
    ? systemThemeMedia.matches ? 'dark' : 'light'
    : mode
  window.localStorage.setItem('notes-theme', mode)
  await window.notesDesktop.setTheme(mode)
}

/**
 * 在跟随系统模式下同步系统外观变化。
 *
 * :return: 无返回值。
 */
function handleSystemThemeChange(): void {
  if (themeMode.value !== 'system') return
  document.documentElement.dataset.theme = systemThemeMedia.matches ? 'dark' : 'light'
}

/**
 * 将文件夹子树及其中笔记移入回收站。
 *
 * :param folder: 待删除文件夹。
 * :return: 删除完成后的 Promise。
 */
async function removeFolder(folder: NoteFolder): Promise<void> {
  const confirmed = await requestConfirmation(
    `删除文件夹“${folder.name}”？`,
    '删除后可从回收站找回该文件夹、所有子文件夹及其中笔记。',
    '删除'
  )
  if (!confirmed) return
  await flushSave()
  await window.notesDesktop.setFolderDeleted(folder.id)
  applyWorkspace(await window.notesDesktop.listWorkspace())
  setFilter('all')
}

/**
 * 恢复回收站中的文件夹子树及随其删除的笔记。
 *
 * :param folder: 待恢复的删除根文件夹。
 * :return: 恢复完成后的 Promise。
 */
async function restoreFolder(folder: NoteFolder): Promise<void> {
  await flushSave()
  await window.notesDesktop.restoreFolder(folder.id)
  applyWorkspace(await window.notesDesktop.listWorkspace())
  setFilter('all')
}

/**
 * 永久删除回收站中的文件夹子树及随其删除的笔记。
 *
 * :param folder: 待永久删除的删除根文件夹。
 * :return: 删除完成后的 Promise。
 */
async function deleteFolderPermanently(folder: NoteFolder): Promise<void> {
  const confirmed = await requestConfirmation(
    '彻底删除文件夹？',
    `“${folder.name}”及随其删除的子文件夹和笔记将永久删除，无法恢复。`,
    '彻底删除'
  )
  if (!confirmed) return
  await flushSave()
  await window.notesDesktop.deleteFolderPermanently(folder.id)
  applyWorkspace(await window.notesDesktop.listWorkspace())
  activeNoteId.value = visibleNotes.value[0]?.id ?? null
}

/**
 * 删除标签并解除关联。
 *
 * :param tag: 待删除标签。
 * :return: 删除完成后的 Promise。
 */
async function removeTag(tag: NoteTag): Promise<void> {
  const confirmed = await requestConfirmation(
    `删除标签“${tag.name}”？`,
    '标签会从相关笔记中解除，但笔记内容不会被删除。',
    '删除标签'
  )
  if (!confirmed) return
  await flushSave()
  await window.notesDesktop.deleteTag(tag.id)
  draft.tagNames = draft.tagNames.filter((name) => name !== tag.name)
  applyWorkspace(await window.notesDesktop.listWorkspace())
  setFilter('all')
}

/**
 * 处理桌面快捷键。
 *
 * :param event: 键盘事件。
 * :return: 无返回值。
 */
function handleShortcut(event: KeyboardEvent): void {
  if (event.key === 'Escape') {
    if (confirmationDialog.visible) {
      resolveConfirmation(false)
      return
    }
    if (attachmentManagerVisible.value) {
      closeAttachmentManager()
      return
    }
    if (conflictCenterVisible.value) {
      closeConflictCenter(true)
      return
    }
    if (quickOpenVisible.value) {
      quickOpenVisible.value = false
      return
    }
    if (noteFindVisible.value) {
      closeCurrentNoteFind()
      return
    }
    generalSettingsVisible.value = false
    generalShortcutRecording.value = false
    quickOpenShortcutRecording.value = false
    syncDialogVisible.value = false
    createMenuVisible.value = false
    closeContextMenu()
    closePropertyPickers()
    return
  }
  if (matchesAppShortcut(event, quickOpenShortcut.value)) {
    event.preventDefault()
    openQuickOpen()
    return
  }
  if (!(event.metaKey || event.ctrlKey)) return
  if (event.key.toLocaleLowerCase() === 'n') {
    event.preventDefault()
    void createNote()
  }
  if (event.key.toLocaleLowerCase() === 's') {
    event.preventDefault()
    void saveDraft()
  }
  if (event.key.toLocaleLowerCase() === 'k') {
    event.preventDefault()
    searchInput.value?.focus()
  }
  if (event.key.toLocaleLowerCase() === 'f' && activeNote.value) {
    event.preventDefault()
    openCurrentNoteFind()
  }
}

/**
 * 在当前笔记中定位相邻匹配项。
 *
 * :param direction: 1 表示下一个，-1 表示上一个。
 * :return: 无返回值。
 */
function findInCurrentNote(direction: 1 | -1 = 1): void {
  const requestedIndex = noteFindResult.index < 0
    ? direction > 0 ? 0 : -1
    : noteFindResult.index + direction
  Object.assign(
    noteFindResult,
    markdownEditorRef.value?.findText(noteFindKeyword.value, requestedIndex)
      ?? { count: 0, index: -1 }
  )
}

/**
 * 处理笔记内查找输入变化。
 *
 * :return: 无返回值。
 */
function refreshCurrentNoteFind(): void {
  noteFindResult.index = -1
  findInCurrentNote(1)
}

/**
 * 关闭当前笔记查找并清除匹配高亮。
 *
 * :return: 无返回值。
 */
function closeCurrentNoteFind(): void {
  noteFindVisible.value = false
  markdownEditorRef.value?.clearFindHighlight()
}

/**
 * 查找需要显示即时说明的图标按钮。
 *
 * :param target: 事件目标。
 * :return: 可显示说明的按钮，未命中时返回 null。
 */
function resolveTooltipButton(target: EventTarget | null): HTMLButtonElement | null {
  if (!(target instanceof Element)) return null
  const button = target.closest<HTMLButtonElement>('button[aria-label]')
  if (!button) return null
  if (button.closest('.theme-switcher, .milkdown-top-bar, .markdown-toolbar-menu__panel')) return null
  return button
}

/**
 * 在按钮旁即时显示悬停说明。
 *
 * :param event: 指针或焦点进入事件。
 * :return: 无返回值。
 */
function showButtonTooltip(event: PointerEvent | FocusEvent): void {
  const button = resolveTooltipButton(event.target)
  const text = button?.getAttribute('aria-label')?.trim()
  if (!button || !text) return
  const bounds = button.getBoundingClientRect()
  const placeAbove = bounds.bottom + 44 > window.innerHeight
  buttonTooltip.text = text
  buttonTooltip.x = Math.min(window.innerWidth - 72, Math.max(72, bounds.left + bounds.width / 2))
  buttonTooltip.y = placeAbove ? bounds.top - 8 : bounds.bottom + 8
  buttonTooltip.placement = placeAbove ? 'top' : 'bottom'
  buttonTooltip.visible = true
}

/**
 * 离开当前图标按钮时关闭悬停说明。
 *
 * :param event: 指针或焦点离开事件。
 * :return: 无返回值。
 */
function hideButtonTooltip(event?: PointerEvent | FocusEvent | Event): void {
  const button = event ? resolveTooltipButton(event.target) : null
  if (
    button
    && event
    && 'relatedTarget' in event
    && event.relatedTarget instanceof Node
    && button.contains(event.relatedTarget)
  ) return
  buttonTooltip.visible = false
}

watch(draft, scheduleSave, { deep: true })
watch(activeNoteId, () => {
  closeCurrentNoteFind()
  noteFindKeyword.value = ''
  Object.assign(noteFindResult, { count: 0, index: -1 })
})
watch(activeNoteId, syncCurrentNoteTab)
watch(() => workspace.notes.map((note) => `${note.id}:${note.isDeleted}`).join('|'), () => {
  applyNoteTabsState(reconcileNoteTabs({
    noteIds: openNoteIds.value,
    activeNoteId: activeTabNoteId.value
  }, workspace.notes.filter((note) => !note.isDeleted).map((note) => note.id)))
})
watch(quickOpenKeyword, () => {
  quickOpenActiveIndex.value = 0
})
watch(noteTabBarElement, (element, previousElement) => {
  if (previousElement) noteTabResizeObserver?.unobserve(previousElement)
  if (element) {
    noteTabBarWidth.value = element.clientWidth
    noteTabResizeObserver?.observe(element)
  }
})
onMounted(() => {
  noteTabResizeObserver = new ResizeObserver(updateNoteTabBarWidth)
  if (noteTabBarElement.value) noteTabResizeObserver.observe(noteTabBarElement.value)
  window.addEventListener('keydown', handleShortcut)
  window.addEventListener('drop', finishResourceDrag)
  window.addEventListener('dragend', finishResourceDrag)
  systemThemeMedia.addEventListener('change', handleSystemThemeChange)
  document.addEventListener('pointerover', showButtonTooltip)
  document.addEventListener('pointerout', hideButtonTooltip)
  document.addEventListener('focusin', showButtonTooltip)
  document.addEventListener('focusout', hideButtonTooltip)
  window.addEventListener('resize', hideButtonTooltip)
  window.addEventListener('scroll', hideButtonTooltip, true)
  disposeOpenSyncSettings = window.notesDesktop.onOpenSyncSettings(() => void openSyncSettings())
  disposeOpenNoteLink = window.notesDesktop.onOpenNoteLink((noteId) => void openNoteFromLink(noteId))
  disposeCheckForUpdates = window.notesDesktop.onCheckForUpdates((silent) => void runUpdateCheck(silent))
  disposeOpenDataTransfer = window.notesDesktop.onOpenDataTransfer(openDataTransfer)
  disposeOpenGeneralSettings = window.notesDesktop.onOpenGeneralSettings(() => void openGeneralSettings())
  disposeOpenSearch = window.notesDesktop.onOpenSearch(handleSearchMenuCommand)
  disposeDatabaseBackupStatus = window.notesDesktop.onDatabaseBackupStatus((status) => {
    Object.assign(databaseBackupStatus, status)
  })
  disposeSyncAuthResult = window.notesDesktop.onSyncAuthResult((result) => void handleSyncAuthResult(result))
  disposeSyncStatus = window.notesDesktop.onSyncStatus((status) => Object.assign(syncStatus, status))
  disposeWorkspaceChanged = window.notesDesktop.onWorkspaceChanged(() => void refreshWorkspace())
  void window.notesDesktop.setTheme(themeMode.value)
  void loadSyncSettings()
  void window.notesDesktop.getSyncStatus().then((status) => Object.assign(syncStatus, status))
  void window.notesDesktop.getDatabaseBackupStatus().then((status) => {
    Object.assign(databaseBackupStatus, status)
  })
  initialWorkspaceLoad = loadWorkspace()
  void initialWorkspaceLoad
    .then(() => window.notesDesktop.consumePendingNoteLink())
    .then((noteId) => openNoteFromLink(noteId))
    .finally(() => {
      initialWorkspaceLoad = null
    })
})
onBeforeUnmount(() => {
  noteTabResizeObserver?.disconnect()
  noteTabResizeObserver = null
  window.removeEventListener('keydown', handleShortcut)
  window.removeEventListener('drop', finishResourceDrag)
  window.removeEventListener('dragend', finishResourceDrag)
  finishResourceDrag()
  systemThemeMedia.removeEventListener('change', handleSystemThemeChange)
  document.removeEventListener('pointerover', showButtonTooltip)
  document.removeEventListener('pointerout', hideButtonTooltip)
  document.removeEventListener('focusin', showButtonTooltip)
  document.removeEventListener('focusout', hideButtonTooltip)
  window.removeEventListener('resize', hideButtonTooltip)
  window.removeEventListener('scroll', hideButtonTooltip, true)
  disposeOpenSyncSettings?.()
  disposeOpenSyncSettings = null
  disposeOpenNoteLink?.()
  disposeOpenNoteLink = null
  disposeCheckForUpdates?.()
  disposeCheckForUpdates = null
  disposeOpenDataTransfer?.()
  disposeOpenDataTransfer = null
  disposeOpenGeneralSettings?.()
  disposeOpenGeneralSettings = null
  disposeOpenSearch?.()
  disposeOpenSearch = null
  disposeDatabaseBackupStatus?.()
  disposeDatabaseBackupStatus = null
  disposeSyncAuthResult?.()
  disposeSyncAuthResult = null
  disposeSyncStatus?.()
  disposeSyncStatus = null
  disposeWorkspaceChanged?.()
  disposeWorkspaceChanged = null
  if (syncBrowserLoginTimer) {
    clearTimeout(syncBrowserLoginTimer)
    syncBrowserLoginTimer = null
  }
  if (linkCopyFeedbackTimer) clearTimeout(linkCopyFeedbackTimer)
  if (confirmationResolver) resolveConfirmation(false)
  if (saveTimer) clearTimeout(saveTimer)
  void saveDraft()
})
</script>

<template>
  <div :class="['desktop-shell', { 'tree-lines-hidden': !showTreeLines }]" @click="createMenuVisible = false; closeContextMenu(); closePropertyPickers(); noteTabOverflowVisible = false; tabContextMenu.visible = false">
    <Transition name="editor-feedback">
      <div v-if="linkCopyFeedback" class="editor-feedback">{{ linkCopyFeedback }}</div>
    </Transition>
    <header class="titlebar">
      <div class="titlebar-brand"><span class="brand-dot"></span>心悦笔记</div>
      <div class="titlebar-actions">
        <div class="theme-switcher" role="group" aria-label="外观模式">
          <button
            v-for="option in themeOptions"
            :key="option.mode"
            :class="{ active: themeMode === option.mode }"
            type="button"
            :aria-label="option.label"
            :aria-pressed="themeMode === option.mode"
            :data-tooltip="option.label"
            @click.stop="selectTheme(option.mode)"
          >
            <Icon :icon="option.icon" />
          </button>
        </div>
        <div class="sync-control">
          <button
            class="sync-state"
            :class="{ configured: syncSettings.configured, syncing: syncStatus.state === 'syncing', error: syncStatus.state === 'error' }"
            type="button"
            :disabled="syncStatus.state === 'syncing'"
            :aria-label="syncActionLabel"
            :data-tooltip="syncActionLabel"
            @click.stop="pullLatestData"
          >
            <Icon :class="{ spinning: syncStatus.state === 'syncing' }" :icon="syncStatusIcon" />
            <span>{{ syncStatusLabel }}</span>
          </button>
          <button
            class="sync-settings-button"
            type="button"
            aria-label="同步设置"
            data-tooltip="同步设置"
            @click.stop="openSyncSettings"
          >
            <Icon icon="tabler:settings" />
          </button>
        </div>
        <button
          class="data-transfer-button"
          type="button"
          aria-label="导入导出"
          data-tooltip="导入导出"
          @click.stop="openDataTransfer"
        >
          <Icon icon="tabler:package-import" />
        </button>
        <button
          class="attachment-manager-button"
          type="button"
          aria-label="附件管理"
          data-tooltip="附件管理"
          @click.stop="openAttachmentManager"
        >
          <Icon icon="tabler:paperclip" />
        </button>
      </div>
    </header>

    <div v-if="actionError" class="error-banner" role="alert">
      <Icon icon="tabler:alert-circle" />{{ actionError }}
      <button type="button" @click="actionError = ''">关闭</button>
    </div>
    <div v-if="databaseBackupStatus.state === 'error'" class="error-banner backup-error-banner" role="alert">
      <Icon icon="tabler:database-exclamation" />{{ databaseBackupStatus.message }}
      <button type="button" @click="openDatabaseBackupManager">查看备份</button>
    </div>

    <main class="workspace">
      <aside class="navigation-panel">
        <div :class="['sidebar-topbar', { 'is-recycle': activeFilter.kind === 'trash' }]">
          <div v-if="activeFilter.kind !== 'trash'" class="sidebar-create">
            <button
              class="new-note-button"
              type="button"
              :aria-expanded="createMenuVisible"
              aria-haspopup="menu"
              @click.stop="createMenuVisible = !createMenuVisible"
            >
              <Icon icon="material-symbols:add-rounded" />
              新建
              <kbd class="create-shortcut">⌘N</kbd>
              <Icon class="create-menu-chevron" icon="material-symbols:keyboard-arrow-down-rounded" />
            </button>
            <div v-if="createMenuVisible" class="create-menu" role="menu" @click.stop>
              <button type="button" role="menuitem" @click="createNote">
                <Icon icon="material-symbols:description-outline-rounded" />新建笔记
              </button>
              <button type="button" role="menuitem" @click="openCreateFolderDialog()">
                <Icon icon="material-symbols:create-new-folder-outline-rounded" />新建文件夹
              </button>
              <button type="button" role="menuitem" @click="openCreateTagDialog()">
                <Icon icon="material-symbols:new-label-outline-rounded" />新建标签
              </button>
            </div>
          </div>

          <label class="search-box sidebar-search">
            <Icon icon="tabler:search" />
            <input ref="searchInput" v-model="searchKeyword" type="search" placeholder="搜索标题和正文" />
            <kbd>⌘ K</kbd>
          </label>
        </div>

        <NoteNavigation
          class="desktop-note-navigation"
          :active="navigationActive"
          :counts="{ all: allCount, pinned: pinnedCount, trash: trashCount }"
          @select="selectNavigation"
        />

        <div
          ref="sidebarResourceScroll"
          class="sidebar-resource-scroll"
          @scroll.passive="closeContextMenu"
          @dragover="handleResourceAutoScroll"
          @dragleave="handleResourceAutoScrollLeave"
        >
        <section
          v-if="!showFilteredResults && activeFilter.kind !== 'trash'"
          class="nav-section explorer-section"
        >
          <div class="nav-heading">
            <span>文件夹</span>
            <button type="button" aria-label="快捷新建文件夹" @click="openCreateFolderDialog()">
              <Icon icon="material-symbols:create-new-folder-outline-rounded" />
            </button>
          </div>
          <div class="nav-scroll-list">
            <div v-if="loading" class="sidebar-placeholder">正在读取本地数据库…</div>
            <div
              v-if="!searchFolderIds || getUnclassifiedNotes().length"
              class="nav-resource-group unclassified-group"
              @dragover="resourceDragEnabled && $event.preventDefault()"
              @drop="dropResourceAtRoot"
            >
              <div
                :class="['nav-resource', { 'is-empty': !getUnclassifiedNotes().length }]"
                @contextmenu.prevent="openUnclassifiedContextMenu"
              >
                <button :class="{ active: activeNote?.folderId === null }" type="button" :aria-expanded="getUnclassifiedNotes().length ? explorerUnclassifiedExpanded : undefined" @click="getUnclassifiedNotes().length && (unclassifiedExpanded = !unclassifiedExpanded)">
                  <Icon v-if="getUnclassifiedNotes().length" class="resource-chevron" :icon="explorerUnclassifiedExpanded ? 'tabler:chevron-down' : 'tabler:chevron-right'" />
                  <Icon icon="tabler:folder-question" /><span>未分类</span><small>{{ getUnclassifiedNotes().length }}</small>
                </button>
              </div>
              <div v-if="getUnclassifiedNotes().length && explorerUnclassifiedExpanded" class="folder-children">
                <article
                  v-for="note in getUnclassifiedNotes()"
                  :key="note.id"
                  :class="['sidebar-note-row', 'is-nested', { active: note.id === activeNoteId }]"
                  :draggable="resourceDragEnabled"
                  @dragstart="startResourceDrag($event, { kind: 'note', id: note.id })"
                  @contextmenu.prevent="openNoteContextMenu($event, note)"
                >
                  <button class="sidebar-note-main" type="button" @click="selectNote(note)">
                    <Icon :icon="note.isPinned
                      ? 'material-symbols:keep-rounded'
                      : 'material-symbols:description-outline-rounded'" />
                    <span><strong>{{ note.title || '无标题笔记' }}</strong><small><SearchExcerpt :content="note.content" :keyword="searchKeyword" /></small></span>
                    <time>{{ formatTime(note.updatedAt) }}</time>
                  </button>
                </article>
              </div>
            </div>

            <FolderTreeItem
              v-for="folder in rootFolders"
              :key="folder.id"
              :folder="folder"
              :folders="explorerFolders"
              :notes="explorerNotes"
              :expanded-folder-ids="explorerExpandedFolderIds"
              :active-note-id="activeNoteId"
              :active-folder-id="activeNote?.folderId ?? null"
              :search-keyword="searchKeyword"
              :drag-enabled="resourceDragEnabled"
              :blocked-folder-ids="blockedFolderDropIds"
              :folder-note-counts="folderNoteCounts"
              @toggle="toggleFolder"
              @select-note="selectNote"
              @folder-context="openFolderContextMenu"
              @note-context="openNoteContextMenu"
              @resource-drag-start="startResourceDrag"
              @resource-drop="dropResourceOnFolder"
            />
            <p v-if="searchFolderIds && !rootFolders.length && !getUnclassifiedNotes().length" class="nav-empty">没有找到匹配笔记</p>
            <p v-else-if="!workspace.folders.length" class="nav-empty">还没有文件夹</p>
          </div>
        </section>

        <section v-if="activeFilter.kind !== 'pinned' && activeFilter.kind !== 'trash'" class="nav-section tag-section">
          <div class="nav-heading">
            <span>标签</span>
            <button type="button" aria-label="快捷新建标签" @click="openCreateTagDialog()">
              <Icon icon="material-symbols:new-label-outline-rounded" />
            </button>
          </div>
          <div class="sidebar-tag-list">
            <div
              v-for="tag in workspace.tags"
              :key="tag.id"
              :class="['sidebar-tag-row', { active: activeFilter.kind === 'tag' && activeFilter.id === tag.id }]"
              @contextmenu.prevent="openTagContextMenu($event, tag)"
            >
              <button type="button" @click="toggleTagFilter(tag.id)"><Icon icon="material-symbols:label-outline-rounded" /><span>{{ tag.name }}</span><small>{{ workspace.notes.filter((note) => !note.isDeleted && note.tags.some((item) => item.id === tag.id)).length }}</small></button>
            </div>
            <p v-if="!workspace.tags.length" class="nav-empty">还没有标签</p>
          </div>
        </section>

        <section v-if="activeFilter.kind === 'trash'" class="nav-section explorer-section recycle-section">
          <div class="nav-heading">
            <span>已删除项目</span>
            <div class="note-tree-heading-actions">
              <small>{{ trashCount }}</small>
              <button
                v-if="recycleItemCount"
                class="empty-trash-button"
                type="button"
                aria-label="清空回收站"
                @click="emptyTrash"
              >
                <Icon icon="material-symbols:delete-forever-rounded" />
              </button>
            </div>
          </div>
          <div v-if="loading" class="sidebar-placeholder">正在读取本地数据库…</div>
          <div v-else-if="!recycleRootFolders.length && !standaloneDeletedNotes.length" class="sidebar-placeholder">
            <Icon icon="tabler:notes-off" />这里还没有已删除项目
          </div>
          <div v-else class="nav-scroll-list">
            <FolderTreeItem
              v-for="folder in recycleRootFolders"
              :key="folder.id"
              :folder="folder"
              :folders="deletedFolders"
              :notes="deletedNotes"
              :expanded-folder-ids="expandedFolderIds"
              :active-note-id="activeNoteId"
              :active-folder-id="null"
              :folder-note-counts="recycleFolderNoteCounts"
              recycle
              @toggle="toggleFolder"
              @select-note="selectNote"
              @folder-context="openFolderContextMenu"
              @note-context="openNoteContextMenu"
            />
            <div v-if="standaloneDeletedNotes.length" class="nav-resource-group unclassified-group">
              <div class="nav-resource">
                <button type="button" :aria-expanded="unclassifiedExpanded" @click="unclassifiedExpanded = !unclassifiedExpanded">
                  <Icon class="resource-chevron" :icon="unclassifiedExpanded ? 'tabler:chevron-down' : 'tabler:chevron-right'" />
                  <Icon icon="tabler:folder-question" /><span>其他已删除笔记</span><small>{{ standaloneDeletedNotes.length }}</small>
                </button>
              </div>
              <div v-if="unclassifiedExpanded" class="folder-children">
                <article
                  v-for="note in standaloneDeletedNotes"
                  :key="note.id"
                  :class="['sidebar-note-row', 'is-nested', { active: note.id === activeNoteId }]"
                  @contextmenu.prevent="openNoteContextMenu($event, note)"
                >
                  <button class="sidebar-note-main" type="button" @click="selectNote(note)">
                    <Icon icon="material-symbols:description-outline-rounded" />
                    <span><strong>{{ note.title || '无标题笔记' }}</strong><small>{{ getNoteExcerpt(note.content) }}</small></span>
                    <time>{{ formatTime(note.updatedAt) }}</time>
                  </button>
                </article>
              </div>
            </div>
          </div>
        </section>

        <section v-if="showFilteredResults" class="nav-section note-tree-section">
          <div class="nav-heading">
            <span>{{ filterTitle }}</span>
            <div class="note-tree-heading-actions">
              <small>{{ visibleNotes.length }}</small>
            </div>
          </div>
          <div v-if="loading" class="sidebar-placeholder">正在读取本地数据库…</div>
          <div v-else-if="!visibleNotes.length" class="sidebar-placeholder">
            <Icon icon="tabler:notes-off" />这里还没有笔记
          </div>
          <div v-else class="sidebar-note-list">
            <article
              v-for="note in visibleNotes"
              :key="note.id"
              :class="['sidebar-note-row', { active: note.id === activeNoteId }]"
              @contextmenu.prevent="openNoteContextMenu($event, note)"
            >
              <button class="sidebar-note-main" type="button" @click="selectNote(note)">
                <Icon :icon="note.isPinned ? 'tabler:pinned-filled' : 'tabler:file-text'" />
                <span>
                  <strong>{{ note.title || '无标题笔记' }}</strong>
                  <small><SearchExcerpt :content="note.content" :keyword="searchKeyword" /></small>
                </span>
                <time>{{ formatTime(note.updatedAt) }}</time>
              </button>
            </article>
          </div>
        </section>
        </div>

        <footer class="sidebar-footer">
          <div><span class="status-light"></span>离线可用</div>
          <span>{{ workspace.pendingCount }} 项待同步</span>
        </footer>
      </aside>

      <section class="editor-panel">
        <nav v-if="openNoteTabs.length" ref="noteTabBarElement" class="note-tab-bar" aria-label="已打开笔记" @click.stop>
          <div class="note-tab-scroll">
            <div
              v-for="note in visibleNoteTabs"
              :key="note.id"
              :class="['note-tab', { active: note.id === activeTabNoteId }]"
              @contextmenu.prevent="openNoteTabContextMenu($event, note.id)"
            >
              <button class="note-tab-main" type="button" @click="switchNoteTab(note)">
                <Icon icon="material-symbols:description-outline-rounded" />
                <span>{{ note.title || '无标题笔记' }}</span>
              </button>
              <button
                class="note-tab-close"
                type="button"
                :aria-label="`关闭 ${note.title || '无标题笔记'}`"
                @click.stop="closeNoteTab(note.id)"
              >
                <Icon icon="material-symbols:close-rounded" />
              </button>
            </div>
          </div>
          <div v-if="overflowNoteTabs.length" class="note-tab-overflow">
            <button
              class="note-tab-overflow-trigger"
              type="button"
              :aria-expanded="noteTabOverflowVisible"
              aria-label="显示更多标签"
              @click="noteTabOverflowVisible = !noteTabOverflowVisible"
            >
              <Icon icon="material-symbols:keyboard-arrow-down-rounded" />
              <small>{{ overflowNoteTabs.length }}</small>
            </button>
            <div v-if="noteTabOverflowVisible" class="note-tab-overflow-menu">
              <div
                v-for="note in overflowNoteTabs"
                :key="note.id"
                class="note-tab-overflow-item"
                @contextmenu.prevent="openNoteTabContextMenu($event, note.id)"
              >
                <button type="button" @click="chooseOverflowNoteTab(note)">
                  <Icon icon="material-symbols:description-outline-rounded" />
                  <span>{{ note.title || '无标题笔记' }}</span>
                </button>
                <button type="button" :aria-label="`关闭 ${note.title || '无标题笔记'}`" @click="closeNoteTab(note.id)">
                  <Icon icon="material-symbols:close-rounded" />
                </button>
              </div>
            </div>
          </div>
        </nav>
        <template v-if="activeNote">
          <div class="editor-meta">
            <div class="editor-title-row">
              <input v-model="draft.title" class="title-input" maxlength="100" aria-label="笔记标题" />
              <button
                v-if="saveState === 'error'"
                class="editor-save-status is-error is-retry"
                type="button"
                aria-label="保存失败，点击重试"
                @click="saveDraft"
              >
                保存失败 · 重试
              </button>
              <span v-else :class="['editor-save-status', `is-${saveState}`]" role="status">
                {{ saveStatusLabel }}
              </span>
              <button
                class="editor-header-button is-history"
                type="button"
                aria-label="历史记录"
                title="历史记录"
                @click="openNoteHistory"
              >
                <Icon icon="material-symbols:history-rounded" />
              </button>
            <div class="properties-row">
              <div class="note-property-control">
                <span class="note-property-label"><Icon icon="material-symbols:folder-outline-rounded" />文件夹</span>
                <div class="property-picker" @click.stop>
                  <button
                    class="property-trigger folder-trigger"
                    type="button"
                    :aria-expanded="folderPickerVisible"
                    aria-haspopup="listbox"
                    @click="toggleFolderPicker"
                  >
                    <Icon icon="material-symbols:folder-outline-rounded" /><span>{{ currentFolderName }}</span><Icon icon="material-symbols:keyboard-arrow-down-rounded" />
                  </button>
                  <div v-if="folderPickerVisible" class="property-popover folder-picker-menu" role="listbox" aria-label="选择文件夹">
                    <div class="property-popover-title"><span>移动到文件夹</span><small>{{ folderOptions.length }} 个</small></div>
                    <label class="folder-picker-search">
                      <Icon icon="material-symbols:search-rounded" />
                      <input
                        ref="folderPickerSearchInput"
                        v-model="folderPickerSearchKeyword"
                        type="search"
                        placeholder="搜索文件夹"
                        aria-label="搜索文件夹"
                      />
                    </label>
                    <button :class="['folder-picker-option', { selected: draft.folderId === null }]" type="button" role="option" :aria-selected="draft.folderId === null" @click="selectDraftFolder(null)">
                      <Icon icon="tabler:folder-question" /><span>未分类</span><Icon v-if="draft.folderId === null" icon="material-symbols:check-rounded" />
                    </button>
                    <div class="property-popover-divider"></div>
                    <div class="folder-picker-scroll">
                      <button
                        v-for="folder in filteredFolderOptions"
                        :key="folder.id"
                        :class="['folder-picker-option', { selected: draft.folderId === folder.id }]"
                        :style="{ '--folder-depth': folder.depth }"
                        type="button"
                        role="option"
                        :aria-selected="draft.folderId === folder.id"
                        @click="selectDraftFolder(folder.id)"
                      >
                        <Icon icon="material-symbols:folder-outline-rounded" /><span>{{ folder.name }}</span><Icon v-if="draft.folderId === folder.id" icon="material-symbols:check-rounded" />
                      </button>
                      <p v-if="!filteredFolderOptions.length" class="folder-picker-empty">没有匹配的文件夹</p>
                    </div>
                  </div>
                </div>
              </div>

              <div class="note-property-control note-property-control--tags">
                <span class="note-property-label"><Icon icon="material-symbols:label-outline-rounded" />标签</span>
                <div class="property-picker tag-property-picker" @click.stop>
                  <button
                    class="property-trigger tag-picker-trigger"
                    type="button"
                    :aria-expanded="tagPickerVisible"
                    aria-haspopup="dialog"
                    @click="toggleTagPicker"
                  >
                    <template v-if="visibleDraftTags.length">
                      <span v-for="tag in visibleDraftTags" :key="tag.id" class="editor-tag-chip">{{ tag.name }}</span>
                      <span v-if="hiddenDraftTagCount" class="editor-tag-more">+{{ hiddenDraftTagCount }}</span>
                      <span class="editor-tag-add">+</span>
                    </template>
                    <span v-else class="editor-tag-placeholder">添加标签</span>
                  </button>
                  <div v-if="tagPickerVisible" class="property-popover tag-picker-menu" role="dialog" aria-label="选择标签">
                    <div class="property-popover-title"><span>选择标签</span><small>{{ draft.tagNames.length }}/12</small></div>
                    <label class="tag-picker-search"><Icon icon="tabler:search" /><input v-model="tagSearchKeyword" autofocus placeholder="搜索标签" /></label>
                    <div v-if="filteredTags.length" class="tag-picker-options">
                      <button
                        v-for="tag in filteredTags"
                        :key="tag.id"
                        type="button"
                        role="checkbox"
                        :aria-checked="draft.tagNames.includes(tag.name)"
                        :disabled="!draft.tagNames.includes(tag.name) && draft.tagNames.length >= 12"
                        @click="toggleDraftTag(tag)"
                      >
                        <span :class="['tag-check', { checked: draft.tagNames.includes(tag.name) }]"><Icon v-if="draft.tagNames.includes(tag.name)" icon="tabler:check" /></span>
                        <span>{{ tag.name }}</span>
                      </button>
                    </div>
                    <p v-else class="tag-picker-empty">没有匹配的标签</p>
                    <button class="create-tag-inline" type="button" @click="openCreateTagDialog(true)"><Icon icon="tabler:tag-plus" />新建标签</button>
                  </div>
                </div>
              </div>
            </div>
            </div>
          </div>

          <div class="editor-body">
            <div v-if="noteFindVisible" class="note-find-bar">
              <Icon icon="tabler:search" />
              <input
                ref="noteFindInput"
                v-model="noteFindKeyword"
                type="search"
                placeholder="在当前笔记中查找"
                @input="refreshCurrentNoteFind"
                @keydown.enter.prevent="findInCurrentNote($event.shiftKey ? -1 : 1)"
              />
              <span>{{ noteFindResult.count ? `${noteFindResult.index + 1}/${noteFindResult.count}` : '0/0' }}</span>
              <button type="button" aria-label="上一个匹配" @click="findInCurrentNote(-1)"><Icon icon="tabler:chevron-up" /></button>
              <button type="button" aria-label="下一个匹配" @click="findInCurrentNote(1)"><Icon icon="tabler:chevron-down" /></button>
              <button type="button" aria-label="关闭查找" @click="closeCurrentNoteFind"><Icon icon="tabler:x" /></button>
            </div>
            <MarkdownVisualEditor
              ref="markdownEditorRef"
              :document-id="activeNote.id"
              :value="draft.content"
              @change="updateDraftContent"
            />
          </div>
        </template>
        <div v-else class="editor-empty">
          <div><Icon icon="tabler:feather" /></div>
          <h2>写下此刻</h2>
          <p>所有内容优先保存在本机，没有网络也不会中断。</p>
          <button type="button" @click="createNote"><Icon icon="tabler:plus" />新建第一篇笔记</button>
        </div>
      </section>
    </main>

    <div
      v-if="contextMenu.visible"
      ref="resourceContextMenuElement"
      class="resource-context-menu"
      role="menu"
      :style="{ left: `${contextMenu.x}px`, top: `${contextMenu.y}px` }"
      @click.stop
      @contextmenu.prevent
    >
      <template v-if="contextMenu.unclassified">
        <button type="button" role="menuitem" @click="createUnclassifiedNoteFromContext">
          <Icon icon="material-symbols:note-add-outline-rounded" /><span>新建笔记</span>
        </button>
      </template>
      <template v-else-if="contextMenu.folder?.isDeleted">
        <button type="button" role="menuitem" @click="handleFolderContextCommand('restore')">
          <Icon icon="material-symbols:restore-from-trash-outline-rounded" /><span>恢复整个文件夹</span>
        </button>
        <div class="context-menu-divider"></div>
        <button class="danger" type="button" role="menuitem" @click="handleFolderContextCommand('permanent')">
          <Icon icon="material-symbols:delete-forever-rounded" /><span>彻底删除整个文件夹</span>
        </button>
      </template>
      <template v-else-if="contextMenu.folder">
        <button type="button" role="menuitem" @click="handleFolderContextCommand('create')">
          <Icon icon="material-symbols:note-add-outline-rounded" /><span>新建笔记</span>
        </button>
        <button type="button" role="menuitem" @click="handleFolderContextCommand('create-folder')">
          <Icon icon="material-symbols:create-new-folder-outline-rounded" /><span>新建子文件夹</span>
        </button>
        <div class="context-menu-divider"></div>
        <button type="button" role="menuitem" @click="handleFolderContextCommand('rename')">
          <Icon icon="material-symbols:drive-file-rename-outline-rounded" /><span>重命名</span>
        </button>
        <button class="danger" type="button" role="menuitem" @click="handleFolderContextCommand('delete')">
          <Icon icon="material-symbols:delete-outline-rounded" /><span>删除文件夹</span>
        </button>
      </template>
      <template v-else-if="contextMenu.tag">
        <button class="danger" type="button" role="menuitem" @click="handleTagContextDelete">
          <Icon icon="material-symbols:delete-outline-rounded" /><span>删除标签</span>
        </button>
      </template>
      <template v-else-if="contextMenu.note && !contextMenu.note.isDeleted">
        <button type="button" role="menuitem" @click="openContextNoteInNewTab">
          <Icon icon="material-symbols:tab-new-right-outline-rounded" /><span>在新标签页打开</span>
        </button>
        <div class="context-menu-divider"></div>
        <button type="button" role="menuitem" @click="handleNoteContextCommand('duplicate')">
          <Icon icon="material-symbols:content-copy-outline-rounded" /><span>复制到…</span>
        </button>
        <button type="button" role="menuitem" @click="handleNoteContextCommand('copy-link')">
          <Icon icon="material-symbols:link-rounded" /><span>复制链接</span>
        </button>
        <button type="button" role="menuitem" @click="handleNoteContextCommand('pin')">
          <Icon :icon="contextMenu.note.isPinned ? 'material-symbols:keep-off-outline-rounded' : 'material-symbols:keep-outline-rounded'" />
          <span>{{ contextMenu.note.isPinned ? '取消置顶' : '置顶' }}</span>
        </button>
        <div class="context-menu-divider"></div>
        <button class="danger" type="button" role="menuitem" @click="handleNoteContextCommand('trash')">
          <Icon icon="material-symbols:delete-outline-rounded" /><span>删除</span>
        </button>
      </template>
      <template v-else-if="contextMenu.note">
        <button type="button" role="menuitem" @click="handleNoteContextCommand('restore')">
          <Icon icon="material-symbols:restore-from-trash-outline-rounded" /><span>恢复</span>
        </button>
        <div class="context-menu-divider"></div>
        <button class="danger" type="button" role="menuitem" @click="handleNoteContextCommand('delete')">
          <Icon icon="material-symbols:delete-forever-rounded" /><span>彻底删除</span>
        </button>
      </template>
    </div>

    <div
      v-if="tabContextMenu.visible"
      ref="noteTabContextMenuElement"
      class="resource-context-menu note-tab-context-menu"
      role="menu"
      :style="{ left: `${tabContextMenu.x}px`, top: `${tabContextMenu.y}px` }"
      @click.stop
    >
      <button type="button" role="menuitem" @click="handleNoteTabCloseCommand('close')">
        <Icon icon="material-symbols:close-rounded" /><span>关闭标签</span>
      </button>
      <button type="button" role="menuitem" @click="handleNoteTabCloseCommand('others')">
        <Icon icon="material-symbols:tab-close-right-outline-rounded" /><span>关闭其他标签</span>
      </button>
      <button type="button" role="menuitem" @click="handleNoteTabCloseCommand('right')">
        <Icon icon="material-symbols:keyboard-tab-rounded" /><span>关闭右侧标签</span>
      </button>
    </div>

    <div v-if="duplicateNoteVisible" class="dialog-backdrop" @click.self="!duplicateNoteBusy && (duplicateNoteVisible = false)">
      <section class="folder-dialog import-target-dialog" role="dialog" aria-modal="true" aria-label="选择笔记副本位置">
        <button class="dialog-close-button" type="button" aria-label="关闭复制笔记窗口" :disabled="duplicateNoteBusy" @click="duplicateNoteVisible = false"><Icon icon="tabler:x" /></button>
        <div class="dialog-icon"><Icon icon="material-symbols:content-copy-outline-rounded" /></div>
        <h2>复制笔记</h2>
        <p>修改副本名称并选择保存位置，默认与原笔记相同。</p>
        <input v-model="duplicateNoteTitle" class="duplicate-note-title" autofocus maxlength="100" aria-label="副本名称" placeholder="输入副本名称" />
        <div class="import-target-list" role="listbox" aria-label="笔记副本位置">
          <button
            :class="['folder-picker-option', { selected: duplicateNoteTargetFolderId === null }]"
            type="button"
            role="option"
            :aria-selected="duplicateNoteTargetFolderId === null"
            @click="duplicateNoteTargetFolderId = null"
          >
            <Icon icon="tabler:folders" /><span>未分类</span><Icon v-if="duplicateNoteTargetFolderId === null" icon="material-symbols:check-rounded" />
          </button>
          <button
            v-for="folder in folderOptions"
            :key="folder.id"
            :class="['folder-picker-option', { selected: duplicateNoteTargetFolderId === folder.id }]"
            :style="{ '--folder-depth': folder.depth }"
            type="button"
            role="option"
            :aria-selected="duplicateNoteTargetFolderId === folder.id"
            @click="duplicateNoteTargetFolderId = folder.id"
          >
            <Icon icon="material-symbols:folder-outline-rounded" /><span>{{ folder.name }}</span><Icon v-if="duplicateNoteTargetFolderId === folder.id" icon="material-symbols:check-rounded" />
          </button>
        </div>
        <div>
          <button type="button" :disabled="duplicateNoteBusy" @click="duplicateNoteVisible = false">取消</button>
          <button class="primary" type="button" :disabled="duplicateNoteBusy" @click="submitDuplicateNote">
            {{ duplicateNoteBusy ? '正在复制' : '复制到此处' }}
          </button>
        </div>
      </section>
    </div>

    <div v-if="folderDialogVisible" class="dialog-backdrop" @click.self="folderDialogVisible = false">
      <form class="folder-dialog" @submit.prevent="submitFolder">
        <button class="dialog-close-button" type="button" aria-label="关闭文件夹窗口" @click="folderDialogVisible = false"><Icon icon="tabler:x" /></button>
        <div class="dialog-icon"><Icon :icon="folderDialogMode === 'rename' ? 'tabler:pencil' : 'tabler:folder-plus'" /></div>
        <h2>{{ folderDialogMode === 'rename' ? '重命名文件夹' : folderDialogParentId ? '新建子文件夹' : '新建文件夹' }}</h2>
        <p>{{ folderDialogMode === 'rename' ? '输入一个更清晰的文件夹名称。' : folderDialogParentId ? `新文件夹将放在“${workspace.folders.find((folder) => folder.id === folderDialogParentId)?.name ?? '上级文件夹'}”中。` : '用文件夹把相关笔记放在一起。' }}</p>
        <input v-model="folderName" autofocus maxlength="60" placeholder="例如：工作记录" />
        <div><button type="button" @click="folderDialogVisible = false">取消</button><button class="primary" type="submit">{{ folderDialogMode === 'rename' ? '保存' : '创建' }}</button></div>
      </form>
    </div>

    <div v-if="tagDialogVisible" class="dialog-backdrop" @click.self="tagDialogVisible = false">
      <form class="folder-dialog tag-dialog" @submit.prevent="submitTag">
        <button class="dialog-close-button" type="button" aria-label="关闭标签窗口" @click="tagDialogVisible = false"><Icon icon="tabler:x" /></button>
        <div class="dialog-icon"><Icon icon="tabler:tag-plus" /></div>
        <h2>新建标签</h2>
        <p>{{ tagDialogAttachToDraft ? '创建后会自动添加到当前笔记。' : '创建后可以在任意笔记中选择使用。' }}</p>
        <input v-model="tagName" autofocus maxlength="30" placeholder="例如：学习" />
        <div><button type="button" @click="tagDialogVisible = false">取消</button><button class="primary" type="submit">创建</button></div>
      </form>
    </div>

    <div v-if="quickOpenVisible" class="dialog-backdrop quick-open-backdrop" @click.self="quickOpenVisible = false">
      <section class="quick-open-dialog" role="dialog" aria-modal="true" aria-label="快速打开笔记">
        <button class="dialog-close-button" type="button" aria-label="关闭快速打开窗口" @click="quickOpenVisible = false"><Icon icon="tabler:x" /></button>
        <div class="quick-open-search">
          <Icon icon="tabler:search" />
          <input
            ref="quickOpenInput"
            v-model="quickOpenKeyword"
            placeholder="搜索标题、正文、标签或文件夹"
            autocomplete="off"
            @keydown="handleQuickOpenKeydown"
          />
          <kbd>Esc</kbd>
        </div>
        <div v-if="!quickOpenKeyword && quickOpenHistory.length" class="quick-open-history">
          <span>最近搜索</span>
          <button
            v-for="keyword in quickOpenHistory"
            :key="keyword"
            type="button"
            @click="applyQuickOpenHistory(keyword)"
          >
            {{ keyword }}
          </button>
        </div>
        <div ref="quickOpenResultsElement" class="quick-open-results" role="listbox" aria-label="笔记搜索结果">
          <button
            v-for="(result, index) in quickOpenResults"
            :key="result.note.id"
            :class="{ active: index === quickOpenActiveIndex }"
            type="button"
            role="option"
            :aria-selected="index === quickOpenActiveIndex"
            @mouseenter="quickOpenActiveIndex = index"
            @click="chooseQuickOpenResult(result)"
          >
            <Icon icon="tabler:file-text" />
            <span>
              <strong>{{ result.note.title || '无标题笔记' }}</strong>
              <small>{{ result.excerpt || '暂无正文内容' }}</small>
            </span>
            <em>{{ result.folderPath }}</em>
          </button>
          <div v-if="!quickOpenResults.length" class="quick-open-empty">
            <Icon icon="tabler:file-search" />
            没有找到匹配的笔记
          </div>
        </div>
        <footer>
          <span><kbd>↑</kbd><kbd>↓</kbd> 选择</span>
          <span><kbd>Enter</kbd> 打开</span>
          <small v-if="!quickOpenKeyword">最近更新的笔记</small>
        </footer>
      </section>
    </div>

    <div v-if="generalSettingsVisible" class="dialog-backdrop" @click.self="generalSettingsVisible = false">
      <form class="folder-dialog general-settings-dialog" aria-label="通用设置" @submit.prevent="saveGeneralSettings">
        <button class="dialog-close-button" type="button" aria-label="关闭通用设置" :disabled="generalSettingsSaving" @click="generalSettingsVisible = false"><Icon icon="tabler:x" /></button>
        <div class="dialog-icon"><Icon icon="tabler:settings" /></div>
        <h2>通用设置</h2>
        <p>配置快速记录和笔记列表的显示方式。</p>
        <div class="general-settings-list">
          <section class="general-setting-item">
            <div>
              <strong>快速记录快捷键</strong>
              <small>在其他应用中也可以呼出快速记录窗口</small>
            </div>
            <button
              :class="['general-shortcut-recorder', { recording: generalShortcutRecording }]"
              type="button"
              @click="generalShortcutRecording = true"
              @keydown="recordGeneralShortcut"
            >
              {{ generalShortcutRecording ? '请按快捷键…' : formatGeneralShortcut(generalShortcut) }}
            </button>
          </section>
          <section class="general-setting-item">
            <div>
              <strong>快速打开快捷键</strong>
              <small>仅在心悦笔记处于前台时搜索整个笔记库</small>
            </div>
            <button
              :class="['general-shortcut-recorder', { recording: quickOpenShortcutRecording }]"
              type="button"
              @click="quickOpenShortcutRecording = true"
              @keydown="recordQuickOpenShortcut"
            >
              {{ quickOpenShortcutRecording ? '请按快捷键…' : formatGeneralShortcut(draftQuickOpenShortcut) }}
            </button>
          </section>
          <section class="general-setting-item">
            <div>
              <strong>文件夹树连接线</strong>
              <small>显示侧边栏文件夹层级之间的辅助线</small>
            </div>
            <button
              :class="['general-setting-switch', { active: draftShowTreeLines }]"
              type="button"
              role="switch"
              :aria-checked="draftShowTreeLines"
              @click="draftShowTreeLines = !draftShowTreeLines"
            >
              <span></span>
            </button>
          </section>
        </div>
        <p v-if="generalSettingsMessage" class="general-settings-message">{{ generalSettingsMessage }}</p>
        <div class="general-settings-actions">
          <button type="button" :disabled="generalSettingsSaving" @click="generalSettingsVisible = false">取消</button>
          <button class="primary" type="submit" :disabled="generalSettingsSaving">
            {{ generalSettingsSaving ? '保存中…' : '保存设置' }}
          </button>
        </div>
      </form>
    </div>

    <div v-if="syncDialogVisible" class="dialog-backdrop sync-dialog-backdrop" @click.self="syncDialogVisible = false">
      <form class="folder-dialog sync-dialog sync-center-dialog" @submit.prevent="saveSyncSettings">
        <button class="dialog-close-button" type="button" aria-label="关闭同步设置" :disabled="syncSaving || syncTesting" @click="syncDialogVisible = false"><Icon icon="tabler:x" /></button>
        <header class="sync-center-heading">
          <div :class="['dialog-icon', { success: syncStatus.state === 'success' && syncStatus.lastResult }]"><Icon :icon="syncStatus.state === 'success' && syncStatus.lastResult ? 'tabler:circle-check' : 'tabler:cloud-cog'" /></div>
          <div>
            <span class="sync-center-eyebrow">云端同步</span>
            <h2 v-if="syncStatus.state === 'success' && syncStatus.lastResult">同步完成</h2>
            <template v-else><h2>同步中心</h2></template>
            <p v-if="syncStatus.state === 'success' && syncStatus.lastResult">本次同步已完成，所有设备数据保持一致。</p>
            <p v-else>笔记库会作为一个整体同步，确保不同设备上的目录、标签和附件保持一致。</p>
          </div>
          <span v-if="syncSettings.configured" class="sync-account-badge"><Icon icon="tabler:user-check" />{{ syncSettings.accountLabel || '账号已连接' }}</span>
        </header>

        <template v-if="syncSettings.configured">
          <section class="sync-center-overview" :class="{ syncing: syncStatus.state === 'syncing', error: syncStatus.state === 'error' }" aria-live="polite">
            <span class="sync-center-state-icon"><Icon :class="{ spinning: syncStatus.state === 'syncing' }" :icon="syncStatusIcon" /></span>
            <div>
              <strong>{{ syncCenterStateTitle }}</strong>
              <small>{{ syncStatus.message || '自动同步已开启，本地变化会进入待同步队列' }}</small>
            </div>
            <button class="sync-center-primary-action" type="button" :disabled="syncStatus.state === 'syncing'" @click="pullLatestData">
              {{ syncCenterActionLabel }}
            </button>
          </section>

          <template v-if="syncStatus.lastResult">
            <section class="sync-result-summary">
              <div class="sync-result-summary-heading">
                <div><strong>本次变更</strong><small>{{ syncResultChangeCount }} 项数据变化</small></div>
                <span>完成于 {{ formatDatabaseBackupTime(syncStatus.lastResult.completedAt) }} · 用时 {{ formatSyncDuration(syncStatus.lastResult.durationMs) }}</span>
              </div>
              <div class="sync-result-metrics">
                <article class="upload"><Icon icon="tabler:cloud-upload" /><div><small>上传</small><strong>{{ syncStatus.lastResult.uploadedCount }}</strong></div></article>
                <article class="download"><Icon icon="tabler:cloud-download" /><div><small>下载</small><strong>{{ syncStatus.lastResult.downloadedCount }}</strong></div></article>
                <article class="delete"><Icon icon="tabler:trash" /><div><small>删除</small><strong>{{ syncStatus.lastResult.deletedCount }}</strong></div></article>
                <article class="attachment"><Icon icon="tabler:paperclip" /><div><small>附件</small><strong>{{ syncStatus.lastResult.attachmentCount }}</strong></div></article>
              </div>
            </section>

            <section class="sync-result-detail-section">
              <div class="sync-result-section-heading"><strong>变更详情</strong><small>最多展示最近 6 项</small></div>
              <div v-if="syncStatus.lastResult.changes.length" class="sync-result-change-list">
                <article v-for="change in syncStatus.lastResult.changes" :key="`${change.kind}-${change.entityType}-${change.id}`">
                  <span :class="['sync-result-change-icon', change.kind]"><Icon :icon="getSyncResultChangeIcon(change)" /></span>
                  <div><strong>{{ change.title }}</strong><small>{{ change.entityType === 'history' ? '历史版本' : change.entityType === 'folder' ? '文件夹' : change.entityType === 'tag' ? '标签' : '笔记' }}</small></div>
                  <span :class="['sync-result-change-badge', change.kind]">{{ getSyncResultChangeLabel(change) }}</span>
                </article>
              </div>
              <div v-else class="sync-result-empty"><Icon icon="tabler:checks" />本次已完成云端校验，没有内容变化</div>
            </section>

            <div :class="['sync-result-conflicts', { warning: noteConflicts.length }]">
              <Icon :icon="noteConflicts.length ? 'tabler:alert-triangle' : 'tabler:shield-check'" />
              <div>
                <strong>待处理冲突</strong>
                <small v-if="noteConflicts.length">{{ noteConflicts.length }} 个冲突副本已安全保留，可对比后选择版本</small>
                <small v-else>0 个冲突，无需处理</small>
              </div>
              <button v-if="noteConflicts.length" type="button" @click="openConflictCenter">立即处理</button>
            </div>

            <details class="sync-result-scope">
              <summary><span><Icon icon="tabler:database" /><strong>查看同步范围</strong></span><Icon icon="tabler:chevron-down" /></summary>
              <div class="sync-scope-grid">
                <article><Icon icon="tabler:notes" /><div><strong>笔记与回收站</strong><small>{{ workspace.notes.length }} 篇笔记</small></div></article>
                <article><Icon icon="tabler:folders" /><div><strong>文件夹与标签</strong><small>{{ workspace.folders.length }} 个文件夹 · {{ workspace.tags.length }} 个标签</small></div></article>
                <article><Icon icon="tabler:photo" /><div><strong>图片与附件</strong><small>随正文上传并离线缓存</small></div></article>
                <article><Icon icon="tabler:history" /><div><strong>历史与冲突副本</strong><small>同步历史版本，冲突时保留副本</small></div></article>
              </div>
            </details>

            <details class="sync-history">
              <summary>
                <span><Icon icon="tabler:history" /><span><strong>最近同步记录</strong><small>本地保留最近 20 次成功同步</small></span></span>
                <span class="sync-history-count">{{ syncStatus.history?.length || 0 }} 次 <Icon icon="tabler:chevron-down" /></span>
              </summary>
              <div v-if="syncStatus.history?.length" class="sync-history-list">
                <article v-for="result in syncStatus.history.slice(0, 5)" :key="result.completedAt">
                  <span class="sync-history-state"><Icon icon="tabler:circle-check" /></span>
                  <div>
                    <strong>{{ formatDatabaseBackupTime(result.completedAt) }}</strong>
                    <small>上传 {{ result.uploadedCount }} · 下载 {{ result.downloadedCount }} · 删除 {{ result.deletedCount }} · 附件 {{ result.attachmentCount }}</small>
                  </div>
                  <span :class="['sync-history-meta', { warning: result.conflictCount }]">
                    {{ result.conflictCount ? `${result.conflictCount} 个冲突` : formatSyncDuration(result.durationMs) }}
                  </span>
                </article>
              </div>
              <p v-else class="sync-history-empty">完成首次同步后，这里会显示同步记录。</p>
            </details>
          </template>

          <template v-else>
            <div class="sync-center-metrics">
              <article><Icon icon="tabler:cloud-upload" /><div><strong>{{ workspace.pendingCount }}</strong><small>本地待上传</small></div></article>
              <article><Icon icon="tabler:cloud-download" /><div><small>云端变更</small><strong>同步时检查</strong></div></article>
              <article><Icon icon="tabler:refresh" /><div><strong>已开启</strong><small>自动同步</small></div></article>
            </div>

            <section class="sync-scope-section">
              <div class="sync-scope-heading">
                <div><strong>同步范围</strong><small>不是只同步当前笔记</small></div>
                <span><Icon icon="tabler:database" />全部本地数据</span>
              </div>
              <div class="sync-scope-grid">
                <article><Icon icon="tabler:notes" /><div><strong>笔记与回收站</strong><small>{{ workspace.notes.length }} 篇笔记</small></div></article>
                <article><Icon icon="tabler:folders" /><div><strong>文件夹与标签</strong><small>{{ workspace.folders.length }} 个文件夹 · {{ workspace.tags.length }} 个标签</small></div></article>
                <article><Icon icon="tabler:photo" /><div><strong>图片与附件</strong><small>随正文上传并离线缓存</small></div></article>
                <article><Icon icon="tabler:history" /><div><strong>历史与冲突副本</strong><small>同步历史版本，冲突时保留副本</small></div></article>
              </div>
            </section>

            <div class="sync-center-last-result">
              <Icon :icon="syncStatus.state === 'error' ? 'tabler:alert-triangle' : 'tabler:clock-check'" />
              <div><strong>最近成功同步</strong><small>{{ syncCenterLastSuccessLabel }}</small></div>
              <span>{{ syncStatus.state === 'error' ? syncStatus.message : '本机数据可离线使用' }}</span>
            </div>
          </template>

          <details class="sync-advanced-settings">
            <summary>
              <span><Icon icon="tabler:settings" /><span><strong>连接设置</strong><small>地址、连接测试与账号管理</small></span></span>
              <Icon icon="tabler:chevron-down" />
            </summary>
            <div class="sync-advanced-settings-body">
              <p class="sync-default-address">线上默认地址：https://lovethewind.cn（后端与网页通用）</p>
              <div class="sync-form-fields is-compact">
                <label><span>后端地址</span><input v-model="syncForm.backendUrl" type="url" autocomplete="url" placeholder="https://lovethewind.cn" /></label>
                <label><span>网页地址</span><input v-model="syncForm.webUrl" type="url" autocomplete="url" placeholder="https://lovethewind.cn" /></label>
              </div>
              <div v-if="syncConnectionResult.message" :class="['sync-connection-result', { success: syncConnectionResult.ok }]">
                <Icon :class="{ spinning: syncTesting }" :icon="syncConnectionResult.ok ? 'tabler:circle-check' : syncTesting ? 'tabler:loader-2' : 'tabler:alert-circle'" />
                <span>{{ syncConnectionResult.message }}</span>
              </div>
              <div class="sync-dialog-actions is-inline">
                <button class="disconnect" type="button" @click="disconnectSyncAccount">断开账号</button>
                <span></span>
                <button type="button" :disabled="syncTesting" @click="testSyncConnection">{{ syncTesting ? '测试中…' : '测试连接' }}</button>
                <button class="primary" type="submit" :disabled="!canSaveSyncSettings">{{ syncSaving ? '保存中…' : '保存设置' }}</button>
              </div>
            </div>
          </details>
        </template>

        <template v-else>
          <div class="sync-setup-intro"><Icon icon="tabler:shield-lock" /><div><strong>先连接你的云端账号</strong><small>推荐使用浏览器登录或微信扫码，应用不会接触你的密码。</small></div></div>
          <p class="sync-default-address">线上默认地址：https://lovethewind.cn（后端与网页通用）</p>
          <div class="sync-form-fields">
            <label><span>后端地址</span><input v-model="syncForm.backendUrl" type="url" autocomplete="url" placeholder="https://lovethewind.cn" /></label>
            <label><span>网页地址</span><input v-model="syncForm.webUrl" type="url" autocomplete="url" placeholder="https://lovethewind.cn" /></label>
            <div class="browser-login-actions">
              <button class="browser-login-button" type="button" :disabled="syncBrowserLoginPending" @click="startBrowserSyncLogin">
                <Icon :icon="syncBrowserLoginPending ? 'tabler:loader-2' : 'tabler:external-link'" />
                {{ syncBrowserLoginPending ? '等待浏览器授权…' : '使用浏览器安全登录' }}
              </button>
              <button v-if="syncBrowserLoginPending" class="browser-login-cancel" type="button" @click="cancelBrowserSyncLogin">取消</button>
            </div>
            <div class="sync-login-divider"><span>或使用账号密码测试连接</span></div>
            <div class="sync-account-grid">
              <label><span>账号</span><input v-model="syncForm.username" autocomplete="username" placeholder="首次连接时填写" /></label>
              <label><span>密码</span><input v-model="syncForm.password" type="password" autocomplete="current-password" placeholder="不会保存密码" /></label>
            </div>
          </div>
          <div v-if="syncConnectionResult.message" :class="['sync-connection-result', { success: syncConnectionResult.ok }]">
            <Icon :class="{ spinning: syncTesting }" :icon="syncConnectionResult.ok ? 'tabler:circle-check' : syncTesting ? 'tabler:loader-2' : 'tabler:alert-circle'" />
            <span>{{ syncConnectionResult.message }}</span>
          </div>
          <div class="sync-dialog-actions">
            <span></span>
            <button type="button" :disabled="syncTesting" @click="testSyncConnection">{{ syncTesting ? '测试中…' : '测试连接' }}</button>
            <button class="primary" type="submit" :disabled="!canSaveSyncSettings">{{ syncSaving ? '保存中…' : '保存设置' }}</button>
          </div>
        </template>
      </form>
    </div>

    <div v-if="conflictCenterVisible" class="dialog-backdrop conflict-center-backdrop" @click.self="closeConflictCenter(true)">
      <section class="conflict-center-dialog" role="dialog" aria-modal="true" aria-labelledby="conflict-center-title">
        <header>
          <div class="dialog-icon danger"><Icon icon="tabler:git-compare" /></div>
          <div>
            <span>同步冲突</span>
            <h2 id="conflict-center-title">选择要保留的版本</h2>
            <p>处理前请对比两侧内容。被替换的版本仍会保存在笔记历史中。</p>
          </div>
          <span class="conflict-center-progress">{{ noteConflicts.length }} 项待处理</span>
          <button type="button" aria-label="关闭冲突处理中心" :disabled="conflictResolving" @click="closeConflictCenter(true)"><Icon icon="tabler:x" /></button>
        </header>

        <div v-if="selectedNoteConflict" class="conflict-center-body">
          <aside v-if="noteConflicts.length > 1" class="conflict-note-list">
            <button
              v-for="pair in noteConflicts"
              :key="pair.conflict.id"
              :class="{ active: pair.conflict.id === selectedNoteConflict.conflict.id }"
              type="button"
              @click="selectedConflictNoteId = pair.conflict.id"
            >
              <Icon icon="tabler:file-alert" />
              <span><strong>{{ pair.original.title }}</strong><small>{{ formatTime(pair.conflict.updatedAt) }}</small></span>
            </button>
          </aside>

          <div class="conflict-compare-grid">
            <article class="conflict-version local">
              <div class="conflict-version-heading">
                <span><Icon icon="tabler:device-laptop" /></span>
                <div><strong>本地冲突版本</strong><small>{{ selectedNoteConflict.conflict.title }}</small></div>
              </div>
              <div class="conflict-version-content">
                <MarkdownVisualEditor :value="selectedNoteConflict.conflict.content" readonly :show-toolbar="false" :show-outline="false" />
              </div>
            </article>
            <article class="conflict-version remote">
              <div class="conflict-version-heading">
                <span><Icon icon="tabler:cloud" /></span>
                <div><strong>当前云端版本</strong><small>{{ selectedNoteConflict.original.title }}</small></div>
              </div>
              <div class="conflict-version-content">
                <MarkdownVisualEditor :value="selectedNoteConflict.original.content" readonly :show-toolbar="false" :show-outline="false" />
              </div>
            </article>
          </div>
        </div>

        <p v-if="conflictError" class="conflict-center-error"><Icon icon="tabler:alert-circle" />{{ conflictError }}</p>
        <footer>
          <span>处理后将自动进入同步队列</span>
          <button type="button" :disabled="conflictResolving || !selectedNoteConflict" @click="resolveSelectedNoteConflict('local')">保留本地</button>
          <button type="button" :disabled="conflictResolving || !selectedNoteConflict" @click="resolveSelectedNoteConflict('remote')">采用云端</button>
          <button class="primary" type="button" :disabled="conflictResolving || !selectedNoteConflict" @click="resolveSelectedNoteConflict('both')">
            {{ conflictResolving ? '处理中…' : '两份都保留' }}
          </button>
        </footer>
      </section>
    </div>

    <div v-if="attachmentManagerVisible" class="dialog-backdrop attachment-manager-backdrop" @click.self="closeAttachmentManager">
      <section class="attachment-manager-dialog" role="dialog" aria-modal="true" aria-labelledby="attachment-manager-title">
        <header class="attachment-manager-heading">
          <div class="dialog-icon"><Icon icon="tabler:paperclip" /></div>
          <div>
            <span>本地资源</span>
            <h2 id="attachment-manager-title">附件管理</h2>
            <p>笔记附件与外链资源都会离线缓存，并按来源区分管理。</p>
          </div>
          <button type="button" aria-label="关闭附件管理" :disabled="Boolean(attachmentOperationId)" @click="closeAttachmentManager"><Icon icon="tabler:x" /></button>
        </header>

        <section class="attachment-manager-stats" aria-label="附件统计">
          <article><Icon icon="tabler:database" /><div><small>本地占用</small><strong>{{ formatAttachmentSize(attachmentInventory.localBytes) }}</strong></div></article>
          <article><Icon icon="tabler:cloud-upload" /><div><small>待上传</small><strong>{{ attachmentInventory.pendingCount }}</strong></div></article>
          <article :class="{ warning: attachmentInventory.missingCount }"><Icon icon="tabler:file-off" /><div><small>文件缺失</small><strong>{{ attachmentInventory.missingCount }}</strong></div></article>
          <article :class="{ warning: attachmentInventory.corruptCount }"><Icon icon="tabler:shield-exclamation" /><div><small>校验异常</small><strong>{{ attachmentInventory.corruptCount }}</strong></div></article>
          <article :class="{ warning: attachmentInventory.orphanCount }"><Icon icon="tabler:unlink" /><div><small>孤立附件</small><strong>{{ attachmentInventory.orphanCount }}</strong></div></article>
        </section>

        <div class="attachment-manager-toolbar">
          <div class="attachment-kind-filter" role="group" aria-label="附件类型">
            <button v-for="option in attachmentKindOptions" :key="option.value" :class="{ active: attachmentKindFilter === option.value }" type="button" @click="attachmentKindFilter = option.value">
              {{ option.label }}
            </button>
          </div>
          <label class="attachment-manager-search"><Icon icon="tabler:search" /><input v-model="attachmentSearchKeyword" placeholder="搜索附件、域名或引用笔记" /></label>
          <select v-model="attachmentSourceFilter" aria-label="筛选附件来源">
            <option value="all">全部来源</option>
            <option value="managed">笔记附件</option>
            <option value="external-cache">外链缓存</option>
          </select>
          <select v-model="attachmentStateFilter" aria-label="筛选附件状态">
            <option value="all">全部状态</option>
            <option value="uploaded">已上传</option>
            <option value="pending">待上传</option>
            <option value="missing">文件缺失</option>
            <option value="corrupt">校验异常</option>
            <option value="orphan">孤立附件</option>
          </select>
        </div>

        <p v-if="attachmentManagerMessage" class="attachment-manager-message" aria-live="polite"><Icon :class="{ spinning: attachmentOperationId === '__repair_attachment_integrity__' }" :icon="attachmentOperationId === '__repair_attachment_integrity__' ? 'tabler:loader-2' : 'tabler:info-circle'" />{{ attachmentManagerMessage }}</p>

        <div v-if="attachmentManagerLoading" class="attachment-manager-empty"><Icon class="spinning" icon="tabler:loader-2" />正在扫描附件引用…</div>
        <div v-else-if="filteredAttachments.length" class="attachment-manager-list">
          <article v-for="asset in filteredAttachments" :key="asset.id" :class="{ orphan: asset.isOrphan, missing: asset.state === 'missing', corrupt: asset.state === 'corrupt' }">
            <span :class="['attachment-kind-icon', asset.kind]"><Icon :icon="getAttachmentKindIcon(asset)" /></span>
            <div class="attachment-item-main">
              <strong :title="asset.fileName">{{ asset.fileName }}</strong>
              <div class="attachment-item-badges">
                <span class="attachment-detail-badge">{{ formatAttachmentSize(asset.localExists ? asset.localBytes : asset.byteSize) }} · {{ asset.mimeType || '未知类型' }}</span>
                <span :class="['attachment-source-badge', asset.sourceKind]" :title="asset.sourceHost || undefined">{{ getAttachmentSourceLabel(asset) }}</span>
                <span :class="['attachment-state-badge', asset.state]">{{ getAttachmentStateLabel(asset) }}</span>
                <span v-if="asset.isOrphan" class="attachment-orphan-badge">无引用</span>
                <span v-else class="attachment-reference-badge">{{ asset.noteReferences.length }} 篇笔记 · {{ asset.historyReferenceCount }} 个历史版本</span>
              </div>
            </div>
            <details v-if="asset.noteReferences.length" class="attachment-reference-picker">
              <summary><Icon icon="tabler:location" />定位笔记<Icon icon="tabler:chevron-down" /></summary>
              <div>
                <button v-for="reference in asset.noteReferences" :key="reference.id" type="button" @click="locateAttachmentReference(reference)">
                  <Icon :icon="reference.isDeleted ? 'tabler:trash' : 'tabler:note'" />
                  <span>{{ reference.title }}</span>
                </button>
              </div>
            </details>
            <div class="attachment-item-actions">
              <button v-if="asset.localExists" type="button" :disabled="Boolean(attachmentOperationId)" @click="openManagedAttachment(asset)"><Icon icon="tabler:external-link" />打开文件</button>
              <button v-if="asset.localExists" type="button" :disabled="Boolean(attachmentOperationId)" @click="revealManagedAttachment(asset)"><Icon icon="tabler:folder-open" />所在目录</button>
              <button v-if="asset.state === 'pending'" type="button" :disabled="Boolean(attachmentOperationId)" @click="retryManagedAttachmentUpload(asset)"><Icon icon="tabler:refresh" />重试上传</button>
              <button v-if="asset.isOrphan" class="danger" type="button" :disabled="Boolean(attachmentOperationId)" @click="cleanOrphanAttachment(asset)"><Icon icon="tabler:trash" />清理附件</button>
            </div>
          </article>
        </div>
        <div v-else class="attachment-manager-empty"><Icon icon="tabler:paperclip-off" />{{ attachmentInventory.totalCount ? '没有符合筛选条件的附件' : '还没有保存任何附件' }}</div>

        <footer>
          <span>共 {{ attachmentInventory.totalCount }} 个本地资源：{{ attachmentInventory.managedCount }} 个笔记附件，{{ attachmentInventory.externalCacheCount }} 个外链缓存</span>
          <button class="integrity-repair-button" type="button" :disabled="Boolean(attachmentOperationId) || !attachmentInventory.totalCount" @click="repairAttachmentIntegrity"><Icon :class="{ spinning: attachmentOperationId === '__repair_attachment_integrity__' }" :icon="attachmentOperationId === '__repair_attachment_integrity__' ? 'tabler:loader-2' : 'tabler:shield-check'" />{{ attachmentOperationId === '__repair_attachment_integrity__' ? '检查修复中…' : '检查并修复' }}</button>
          <button class="danger bulk-cleanup-button" type="button" :disabled="Boolean(attachmentOperationId) || !attachmentInventory.orphanCount" @click="cleanAllOrphanAttachments"><Icon icon="tabler:trash" />一键清理</button>
          <button type="button" :disabled="Boolean(attachmentOperationId)" @click="closeAttachmentManager">关闭</button>
        </footer>
      </section>
    </div>

    <div v-if="dataTransferVisible" class="dialog-backdrop" @click.self="!dataTransferBusy && (dataTransferVisible = false)">
      <section class="folder-dialog data-transfer-dialog" role="dialog" aria-modal="true" aria-label="导入导出">
        <button class="dialog-close-button" type="button" aria-label="关闭导入导出窗口" :disabled="dataTransferBusy" @click="dataTransferVisible = false"><Icon icon="tabler:x" /></button>
        <div class="dialog-icon"><Icon icon="tabler:archive" /></div>
        <h2>导入导出</h2>
        <p>完整备份用于本应用恢复；通用 Markdown 用于其他软件，资源文件随 ZIP 保存。</p>
        <div class="data-transfer-grid">
          <button class="markdown-folder-import-action" type="button" :disabled="dataTransferBusy" @click="openMarkdownImportTarget">
            <Icon icon="tabler:folder-down" />
            <span><strong>导入 Markdown 文件夹或 ZIP</strong><small>恢复 ZIP 内相对资源并保留目录层级</small></span>
          </button>
          <button type="button" :disabled="dataTransferBusy || !activeNote" @click="exportCurrentNoteMarkdown">
            <Icon icon="tabler:file-export" />
            <span><strong>导出当前笔记</strong><small>单个 .md，资源保留原始地址</small></span>
          </button>
          <button type="button" :disabled="dataTransferBusy" @click="exportAllNotesMarkdown">
            <Icon icon="tabler:folder-share" />
            <span><strong>导出通用 Markdown</strong><small>ZIP 内含 Markdown 与原始资源文件</small></span>
          </button>
          <button type="button" :disabled="dataTransferBusy" @click="importCompleteBackup">
            <Icon icon="tabler:database-import" />
            <span><strong>导入完整备份</strong><small>读取新版 .xynotes 并生成独立副本</small></span>
          </button>
          <button type="button" :disabled="dataTransferBusy" @click="exportCompleteBackup">
            <Icon icon="tabler:database-export" />
            <span><strong>创建完整备份</strong><small>原始附件随 .xynotes 完整保存</small></span>
          </button>
          <button type="button" :disabled="dataTransferBusy" @click="openDatabaseBackupManager">
            <Icon icon="tabler:database-cog" />
            <span><strong>自动备份管理</strong><small>查看、创建和恢复数据库与附件快照</small></span>
          </button>
        </div>
        <p v-if="dataTransferMessage" class="data-transfer-message">{{ dataTransferMessage }}</p>
        <div class="data-transfer-actions">
          <button type="button" :disabled="dataTransferBusy" @click="dataTransferVisible = false">
            {{ dataTransferBusy ? '处理中…' : '关闭' }}
          </button>
        </div>
      </section>
    </div>

    <div v-if="databaseBackupVisible" class="dialog-backdrop" @click.self="!databaseBackupBusy && (databaseBackupVisible = false)">
      <section class="folder-dialog database-backup-dialog" role="dialog" aria-modal="true" aria-label="自动备份管理">
        <button class="dialog-close-button" type="button" aria-label="关闭自动备份窗口" :disabled="databaseBackupBusy" @click="databaseBackupVisible = false"><Icon icon="tabler:x" /></button>
        <div class="dialog-icon"><Icon icon="tabler:database-heart" /></div>
        <h2>自动备份管理</h2>
        <p>每个域名和用户档案独立备份，每天自动保存一次 SQLite 与附件，最多保留最近 10 份。</p>
        <div :class="['database-backup-status', databaseBackupStatus.state]">
          <Icon :icon="databaseBackupStatus.state === 'error' ? 'tabler:alert-circle' : databaseBackupStatus.lastSuccessAt ? 'tabler:circle-check' : 'tabler:clock'" />
          <span>
            <strong>{{ databaseBackupStatus.message }}</strong>
            <small v-if="databaseBackupStatus.lastSuccessAt">
              最近成功：{{ formatDatabaseBackupTime(databaseBackupStatus.lastSuccessAt) }}
            </small>
          </span>
        </div>
        <div class="database-backup-policy">
          <label>自动备份
            <select v-model="databaseBackupSettings.schedule" :disabled="databaseBackupBusy">
              <option value="daily">每天</option>
              <option value="weekly">每周</option>
              <option value="off">关闭</option>
            </select>
          </label>
          <label>保留数量
            <input v-model.number="databaseBackupSettings.retention" type="number" min="1" max="50" :disabled="databaseBackupBusy" />
          </label>
          <button type="button" :disabled="databaseBackupBusy" @click="saveDatabaseBackupPolicy">保存策略</button>
        </div>
        <div class="database-backup-toolbar">
          <button type="button" :disabled="databaseBackupBusy" @click="createDatabaseBackup">
            <Icon icon="tabler:database-plus" />立即备份
          </button>
          <button type="button" :disabled="databaseBackupBusy" @click="openDatabaseBackupDirectory">
            <Icon icon="tabler:folder-open" />打开目录
          </button>
        </div>
        <div v-if="databaseBackupBusy && !databaseBackups.length" class="database-backup-empty">
          <Icon class="spinning" icon="tabler:loader-2" />正在读取备份…
        </div>
        <div v-else-if="!databaseBackups.length" class="database-backup-empty">
          <Icon icon="tabler:database-off" />当前档案还没有备份
        </div>
        <div v-else class="database-backup-list">
          <article v-for="backup in databaseBackups" :key="backup.id">
            <div class="database-backup-kind"><Icon :icon="backup.kind === 'complete' ? 'tabler:archive' : 'tabler:database'" /></div>
            <div>
              <strong>{{ formatDatabaseBackupTime(backup.createdAt) }}</strong>
              <small>
                {{ getDatabaseBackupReasonLabel(backup.reason) }} · {{ formatDatabaseBackupSize(backup.size) }}
                · {{ backup.kind === 'complete' ? `${backup.assetCount} 个附件` : '旧版数据库快照' }}
              </small>
            </div>
            <button type="button" :disabled="databaseBackupBusy" @click="restoreDatabaseBackup(backup)">恢复</button>
          </article>
        </div>
        <p v-if="databaseBackupMessage" class="database-backup-message">{{ databaseBackupMessage }}</p>
        <div class="database-backup-actions">
          <button type="button" :disabled="databaseBackupBusy" @click="databaseBackupVisible = false">关闭</button>
        </div>
      </section>
    </div>

    <div v-if="markdownImportTargetVisible" class="dialog-backdrop import-target-backdrop" @click.self="markdownImportTargetVisible = false">
      <section class="folder-dialog import-target-dialog" role="dialog" aria-modal="true" aria-label="选择导入位置">
        <button class="dialog-close-button" type="button" aria-label="关闭导入位置窗口" @click="markdownImportTargetVisible = false"><Icon icon="tabler:x" /></button>
        <div class="dialog-icon"><Icon icon="tabler:folder-down" /></div>
        <h2>选择导入位置</h2>
        <p>来源同名文件夹已存在时会合并目录并新增笔记，不会覆盖原有笔记。</p>
        <div class="import-target-list" role="listbox" aria-label="Markdown 导入位置">
          <button
            :class="['folder-picker-option', { selected: markdownImportTargetFolderId === null }]"
            type="button"
            role="option"
            :aria-selected="markdownImportTargetFolderId === null"
            @click="markdownImportTargetFolderId = null"
          >
            <Icon icon="tabler:folders" /><span>根目录</span><Icon v-if="markdownImportTargetFolderId === null" icon="material-symbols:check-rounded" />
          </button>
          <button
            v-for="folder in folderOptions"
            :key="folder.id"
            :class="['folder-picker-option', { selected: markdownImportTargetFolderId === folder.id }]"
            :style="{ '--folder-depth': folder.depth }"
            type="button"
            role="option"
            :aria-selected="markdownImportTargetFolderId === folder.id"
            @click="markdownImportTargetFolderId = folder.id"
          >
            <Icon icon="material-symbols:folder-outline-rounded" /><span>{{ folder.name }}</span><Icon v-if="markdownImportTargetFolderId === folder.id" icon="material-symbols:check-rounded" />
          </button>
        </div>
        <div>
          <button type="button" @click="markdownImportTargetVisible = false">取消</button>
          <button class="primary" type="button" @click="importMarkdownNotes">选择文件夹或 ZIP 压缩包</button>
        </div>
      </section>
    </div>

    <div v-if="historyVisible" class="dialog-backdrop" @click.self="historyVisible = false">
      <section class="history-dialog" role="dialog" aria-modal="true" aria-label="笔记历史记录">
        <header>
          <div>
            <Icon icon="tabler:history" />
            <div><h2>历史记录</h2><p>最多保留 50 个同步版本</p></div>
          </div>
          <button type="button" aria-label="关闭历史记录" @click="historyVisible = false">
            <Icon icon="tabler:x" />
          </button>
        </header>
        <div v-if="historyLoading" class="history-empty">正在读取历史记录…</div>
        <div v-else-if="!noteHistories.length" class="history-empty">
          修改正文后会自动生成历史版本
        </div>
        <div v-else class="history-layout">
          <aside class="history-list">
            <button
              v-for="history in noteHistories"
              :key="history.id"
              :class="{ active: history.id === selectedHistoryId }"
              type="button"
              @click="selectHistory(history.id)"
            >
              <strong>{{ history.title || '无标题笔记' }}</strong>
              <small>{{ history.contentPreview }}</small>
              <time>{{ formatTime(history.createdAt) }}</time>
            </button>
          </aside>
          <article v-if="selectedHistory" class="history-preview">
            <h3>{{ selectedHistory.title || '无标题笔记' }}</h3>
            <div v-if="historyDetailLoading || !selectedHistory.content" class="history-empty">正在读取版本内容…</div>
            <div v-else class="history-editor-preview">
              <MarkdownVisualEditor
                :key="selectedHistory.id"
                :value="selectedHistory.content"
                readonly
                :show-toolbar="false"
                :show-outline="false"
              />
            </div>
          </article>
        </div>
        <footer>
          <button class="danger" type="button" :disabled="!selectedHistory" @click="deleteSelectedHistory">
            删除版本
          </button>
          <button class="primary" type="button" :disabled="!selectedHistory" @click="restoreSelectedHistory">
            恢复此版本
          </button>
        </footer>
      </section>
    </div>

    <div v-if="confirmationDialog.visible" class="dialog-backdrop confirmation-backdrop" @click.self="resolveConfirmation(false)">
      <section class="folder-dialog confirmation-dialog" role="alertdialog" aria-modal="true" :aria-labelledby="'confirmation-dialog-title'">
        <button class="dialog-close-button" type="button" aria-label="关闭确认窗口" @click="resolveConfirmation(false)"><Icon icon="tabler:x" /></button>
        <div class="dialog-icon danger"><Icon icon="tabler:alert-triangle" /></div>
        <h2 id="confirmation-dialog-title">{{ confirmationDialog.title }}</h2>
        <p>{{ confirmationDialog.message }}</p>
        <div>
          <button type="button" @click="resolveConfirmation(false)">取消</button>
          <button class="danger-confirm" type="button" autofocus @click="resolveConfirmation(true)">{{ confirmationDialog.confirmLabel }}</button>
        </div>
      </section>
    </div>

    <div v-if="updateDialogVisible" class="dialog-backdrop" @click.self="!updateChecking && (updateDialogVisible = false)">
      <section class="folder-dialog update-dialog" role="dialog" aria-modal="true" aria-labelledby="update-dialog-title">
        <button class="dialog-close-button" type="button" aria-label="关闭更新窗口" :disabled="updateChecking" @click="updateDialogVisible = false"><Icon icon="tabler:x" /></button>
        <div class="dialog-icon"><Icon :icon="updateChecking ? 'tabler:loader-2' : updateResult?.status === 'available' ? 'tabler:sparkles' : updateError ? 'tabler:alert-circle' : 'tabler:circle-check'" /></div>
        <h2 id="update-dialog-title">
          {{ updateChecking ? '正在检查更新' : updateError ? '检查更新失败' : updateResult?.status === 'available' ? '发现新版本' : updateResult?.status === 'unpublished' ? '暂无发布版本' : '已是最新版本' }}
        </h2>
        <p v-if="updateChecking">正在连接 GitHub Releases 获取最新版本信息…</p>
        <template v-else-if="updateError">
          <p>{{ updateError }}</p>
        </template>
        <template v-else-if="updateResult">
          <p v-if="updateResult.status === 'unpublished'">当前版本 {{ updateResult.currentVersion }}。GitHub 仓库还没有正式 Release，发布首个版本后即可正常检查更新。</p>
          <p v-else>当前版本 {{ updateResult.currentVersion }}，最新版本 {{ updateResult.latestVersion }}。</p>
          <div
            v-if="renderedUpdateReleaseNotes"
            class="update-release-notes"
            v-html="renderedUpdateReleaseNotes"
          ></div>
        </template>
        <div>
          <button v-if="updateError" type="button" @click="runUpdateCheck(false)">重新检查</button>
          <button type="button" :disabled="updateChecking" @click="updateDialogVisible = false">稍后</button>
          <button v-if="updateResult?.status === 'available'" class="primary" type="button" @click="openUpdateDownload">前往下载</button>
        </div>
      </section>
    </div>

    <Teleport to="body">
      <div
        v-if="buttonTooltip.visible"
        :class="['global-button-tooltip', `is-${buttonTooltip.placement}`]"
        :style="{ left: `${buttonTooltip.x}px`, top: `${buttonTooltip.y}px` }"
        role="tooltip"
      >
        {{ buttonTooltip.text }}
      </div>
    </Teleport>
  </div>
</template>
