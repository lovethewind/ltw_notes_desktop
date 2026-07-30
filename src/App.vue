<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import { Icon } from '@iconify/vue'
import {
  formatNoteExcerpt as getNoteExcerpt,
  formatNoteUpdatedTime as formatTime,
  matchesNoteSearch,
  NOTE_AUTOSAVE_DELAY_MS,
  type NoteNavigationKind
} from './utils/note-workspace'
import NoteNavigation from './components/NoteNavigation.vue'
import FolderTreeItem from './components/FolderTreeItem.vue'
import MarkdownVisualEditor from './components/MarkdownVisualEditor.vue'
import SearchExcerpt from './components/SearchExcerpt.vue'
import type {
  DatabaseBackup,
  DatabaseBackupStatus,
  DatabaseBackupSettings,
  DataTransferResult,
  NoteFolder,
  NoteHistory,
  NotePatch,
  NoteTag,
  OfflineNote,
  SyncConnectionResult,
  SyncSettingsView,
  SyncStatus,
  ThemeMode,
  UpdateCheckResult,
  WorkspaceData
} from './types'

type FilterKind = 'all' | 'pinned' | 'trash' | 'folder' | 'tag'
type SaveState = 'idle' | 'saving' | 'saved' | 'error'

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

const workspace = reactive<WorkspaceData>({ folders: [], tags: [], notes: [], pendingCount: 0 })
const activeFilter = reactive<ActiveFilter>({ kind: 'all', id: null })
const activeNoteId = ref<string | null>(null)
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
const actionError = ref('')
const updateDialogVisible = ref(false)
const updateChecking = ref(false)
const updateError = ref('')
const updateResult = ref<UpdateCheckResult | null>(null)
const syncDialogVisible = ref(false)
const syncTesting = ref(false)
const syncBrowserLoginPending = ref(false)
const syncSaving = ref(false)
const dataTransferVisible = ref(false)
const dataTransferBusy = ref(false)
const dataTransferMessage = ref('')
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
  lastSuccessAt: ''
})
const folderDialogVisible = ref(false)
const folderDialogMode = ref<'create' | 'rename'>('create')
const editingFolderId = ref<string | null>(null)
const folderDialogParentId = ref<string | null>(null)
const folderName = ref('')
const createMenuVisible = ref(false)
const folderPickerVisible = ref(false)
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
let disposeDatabaseBackupStatus: (() => void) | null = null
let disposeSyncAuthResult: (() => void) | null = null
let disposeSyncStatus: (() => void) | null = null
let disposeWorkspaceChanged: (() => void) | null = null
let syncBrowserLoginTimer: ReturnType<typeof setTimeout> | null = null

const activeNote = computed(() => workspace.notes.find((note) => note.id === activeNoteId.value) ?? null)
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
  if (!searchKeyword.value.trim()) return null
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
const syncStatusIcon = computed(() => {
  if (!syncSettings.configured) return 'tabler:cloud-off'
  if (syncStatus.state === 'syncing') return 'tabler:loader-2'
  if (syncStatus.state === 'error') return 'tabler:cloud-exclamation'
  return 'tabler:cloud-check'
})
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
  await flushSave()
  historyVisible.value = true
  historyLoading.value = true
  try {
    noteHistories.value = await window.notesDesktop.listNoteHistory(activeNoteId.value)
    selectedHistoryId.value = noteHistories.value[0]?.id ?? null
  } finally {
    historyLoading.value = false
  }
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
  folderPickerVisible.value = nextVisible
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
  contextMenu.x = Math.max(12, Math.min(event.clientX, window.innerWidth - 216))
  contextMenu.y = Math.max(64, Math.min(event.clientY, window.innerHeight - 216))
  contextMenu.visible = true
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
  contextMenu.x = Math.max(12, Math.min(event.clientX, window.innerWidth - 216))
  contextMenu.y = Math.max(64, Math.min(event.clientY, window.innerHeight - 190))
  contextMenu.visible = true
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
  contextMenu.x = Math.max(12, Math.min(event.clientX, window.innerWidth - 216))
  contextMenu.y = Math.max(64, Math.min(event.clientY, window.innerHeight - 86))
  contextMenu.visible = true
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
  contextMenu.x = Math.max(12, Math.min(event.clientX, window.innerWidth - 216))
  contextMenu.y = Math.max(64, Math.min(event.clientY, window.innerHeight - 86))
  contextMenu.visible = true
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
  command: 'copy-link' | 'pin' | 'trash' | 'restore' | 'delete'
): Promise<void> {
  const note = contextMenu.note
  closeContextMenu()
  if (!note) return
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
    if (noteFindVisible.value) {
      closeCurrentNoteFind()
      return
    }
    if (confirmationDialog.visible) resolveConfirmation(false)
    syncDialogVisible.value = false
    createMenuVisible.value = false
    closeContextMenu()
    closePropertyPickers()
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
    noteFindVisible.value = true
    void nextTick(() => {
      noteFindInput.value?.focus()
      noteFindInput.value?.select()
    })
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
onMounted(() => {
  window.addEventListener('keydown', handleShortcut)
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
  window.removeEventListener('keydown', handleShortcut)
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
  <div class="desktop-shell" @click="createMenuVisible = false; closeContextMenu(); closePropertyPickers()">
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
        <button
          :class="['sync-state', { configured: syncSettings.configured, syncing: syncStatus.state === 'syncing', error: syncStatus.state === 'error' }]"
          type="button"
          aria-label="同步设置"
          @click.stop="openSyncSettings"
        >
          <Icon :class="{ spinning: syncStatus.state === 'syncing' }" :icon="syncStatusIcon" />
          <span>{{ syncStatusLabel }}</span>
        </button>
        <button
          class="pull-latest-button"
          type="button"
          :disabled="syncStatus.state === 'syncing'"
          aria-label="从服务器拉取最新数据"
          @click.stop="pullLatestData"
        >
          <Icon icon="tabler:cloud-download" />
          <span>拉取最新</span>
        </button>
        <button
          class="data-transfer-button"
          type="button"
          aria-label="导入导出"
          @click.stop="openDataTransfer"
        >
          <Icon icon="tabler:package-import" />
          <span>导入导出</span>
        </button>
        <div class="local-state"><Icon icon="tabler:database" />SQLite 本地库</div>
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

        <div class="sidebar-resource-scroll" @scroll.passive="closeContextMenu">
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
            <div v-if="!searchKeyword.trim() || getUnclassifiedNotes().length" class="nav-resource-group unclassified-group">
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
              @toggle="toggleFolder"
              @select-note="selectNote"
              @folder-context="openFolderContextMenu"
              @note-context="openNoteContextMenu"
            />
            <p v-if="searchKeyword.trim() && !rootFolders.length && !getUnclassifiedNotes().length" class="nav-empty">没有找到匹配笔记</p>
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
        <template v-if="activeNote">
          <div class="editor-meta">
            <div class="editor-title-row">
              <input v-model="draft.title" class="title-input" maxlength="100" aria-label="笔记标题" />
              <span :class="['editor-save-status', `is-${saveState}`]" role="status">
                {{ saveStatusLabel }}
              </span>
              <button
                class="editor-header-button is-save"
                type="button"
                :disabled="saveState === 'saving'"
                @click="saveDraft"
              >
                <Icon icon="tabler:device-floppy" />
                <span>保存</span>
              </button>
              <button
                class="editor-header-button is-history"
                type="button"
                aria-label="历史记录"
                title="历史记录"
                @click="openNoteHistory"
              >
                <Icon icon="material-symbols:history-rounded" />
              </button>
            </div>
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
                    <button :class="['folder-picker-option', { selected: draft.folderId === null }]" type="button" role="option" :aria-selected="draft.folderId === null" @click="selectDraftFolder(null)">
                      <Icon icon="tabler:folder-question" /><span>未分类</span><Icon v-if="draft.folderId === null" icon="material-symbols:check-rounded" />
                    </button>
                    <div class="property-popover-divider"></div>
                    <div class="folder-picker-scroll">
                      <button
                        v-for="folder in folderOptions"
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

    <div v-if="folderDialogVisible" class="dialog-backdrop" @click.self="folderDialogVisible = false">
      <form class="folder-dialog" @submit.prevent="submitFolder">
        <div class="dialog-icon"><Icon :icon="folderDialogMode === 'rename' ? 'tabler:pencil' : 'tabler:folder-plus'" /></div>
        <h2>{{ folderDialogMode === 'rename' ? '重命名文件夹' : folderDialogParentId ? '新建子文件夹' : '新建文件夹' }}</h2>
        <p>{{ folderDialogMode === 'rename' ? '输入一个更清晰的文件夹名称。' : folderDialogParentId ? `新文件夹将放在“${workspace.folders.find((folder) => folder.id === folderDialogParentId)?.name ?? '上级文件夹'}”中。` : '用文件夹把相关笔记放在一起。' }}</p>
        <input v-model="folderName" autofocus maxlength="60" placeholder="例如：工作记录" />
        <div><button type="button" @click="folderDialogVisible = false">取消</button><button class="primary" type="submit">{{ folderDialogMode === 'rename' ? '保存' : '创建' }}</button></div>
      </form>
    </div>

    <div v-if="tagDialogVisible" class="dialog-backdrop" @click.self="tagDialogVisible = false">
      <form class="folder-dialog tag-dialog" @submit.prevent="submitTag">
        <div class="dialog-icon"><Icon icon="tabler:tag-plus" /></div>
        <h2>新建标签</h2>
        <p>{{ tagDialogAttachToDraft ? '创建后会自动添加到当前笔记。' : '创建后可以在任意笔记中选择使用。' }}</p>
        <input v-model="tagName" autofocus maxlength="30" placeholder="例如：学习" />
        <div><button type="button" @click="tagDialogVisible = false">取消</button><button class="primary" type="submit">创建</button></div>
      </form>
    </div>

    <div v-if="syncDialogVisible" class="dialog-backdrop" @click.self="syncDialogVisible = false">
      <form class="folder-dialog sync-dialog" @submit.prevent="saveSyncSettings">
        <div class="dialog-icon"><Icon icon="tabler:cloud-cog" /></div>
        <h2>同步设置</h2>
        <p>推荐在浏览器中完成登录或微信扫码授权，应用不会接触你的密码。连接后会自动同步，并在正文冲突时保留本地副本。</p>
        <div class="sync-form-fields">
          <label>
            <span>后端地址</span>
            <input v-model="syncForm.backendUrl" type="url" autocomplete="url" placeholder="https://lovethewind.cn" />
          </label>
          <label>
            <span>网页地址</span>
            <input v-model="syncForm.webUrl" type="url" autocomplete="url" placeholder="https://lovethewind.cn" />
          </label>
          <div class="browser-login-actions">
            <button
              class="browser-login-button"
              type="button"
              :disabled="syncBrowserLoginPending"
              @click="startBrowserSyncLogin"
            >
              <Icon :icon="syncBrowserLoginPending ? 'tabler:loader-2' : 'tabler:external-link'" />
              {{ syncBrowserLoginPending ? '等待浏览器授权…' : '使用浏览器安全登录' }}
            </button>
            <button
              v-if="syncBrowserLoginPending"
              class="browser-login-cancel"
              type="button"
              @click="cancelBrowserSyncLogin"
            >
              取消
            </button>
          </div>
          <div class="sync-login-divider"><span>或使用账号密码测试连接</span></div>
          <div class="sync-account-grid">
            <label>
              <span>账号</span>
              <input v-model="syncForm.username" autocomplete="username" placeholder="首次连接时填写" />
            </label>
            <label>
              <span>密码</span>
              <input v-model="syncForm.password" type="password" autocomplete="current-password" placeholder="不会保存密码" />
            </label>
          </div>
        </div>
        <div v-if="syncConnectionResult.message" :class="['sync-connection-result', { success: syncConnectionResult.ok }]">
          <Icon
            :class="{ spinning: syncTesting }"
            :icon="syncConnectionResult.ok ? 'tabler:circle-check' : syncTesting ? 'tabler:loader-2' : 'tabler:alert-circle'"
          />
          <span>{{ syncConnectionResult.message }}</span>
        </div>
        <div class="sync-dialog-actions">
          <button v-if="syncSettings.configured" class="disconnect" type="button" @click="disconnectSyncAccount">断开账号</button>
          <span></span>
          <button type="button" :disabled="syncTesting" @click="testSyncConnection">
            {{ syncTesting ? '测试中…' : '测试连接' }}
          </button>
          <button class="primary" type="submit" :disabled="!canSaveSyncSettings">
            {{ syncSaving ? '保存中…' : '保存设置' }}
          </button>
        </div>
      </form>
    </div>

    <div v-if="dataTransferVisible" class="dialog-backdrop" @click.self="!dataTransferBusy && (dataTransferVisible = false)">
      <section class="folder-dialog data-transfer-dialog" role="dialog" aria-modal="true" aria-label="导入导出">
        <div class="dialog-icon"><Icon icon="tabler:archive" /></div>
        <h2>导入导出</h2>
        <p>备份、迁移或批量导入笔记，导入内容不会覆盖现有数据。</p>
        <div class="data-transfer-grid">
          <button class="markdown-folder-import-action" type="button" :disabled="dataTransferBusy" @click="openMarkdownImportTarget">
            <Icon icon="tabler:folder-down" />
            <span><strong>导入 Markdown 文件夹</strong><small>选择导入位置并保留目录层级</small></span>
          </button>
          <button type="button" :disabled="dataTransferBusy || !activeNote" @click="exportCurrentNoteMarkdown">
            <Icon icon="tabler:file-export" />
            <span><strong>导出当前笔记</strong><small>保存为 Markdown 文件</small></span>
          </button>
          <button type="button" :disabled="dataTransferBusy" @click="exportAllNotesMarkdown">
            <Icon icon="tabler:folder-share" />
            <span><strong>导出全部 Markdown</strong><small>保留文件夹层级的 ZIP</small></span>
          </button>
          <button type="button" :disabled="dataTransferBusy" @click="importCompleteBackup">
            <Icon icon="tabler:database-import" />
            <span><strong>导入完整备份</strong><small>生成独立目录副本</small></span>
          </button>
          <button type="button" :disabled="dataTransferBusy" @click="exportCompleteBackup">
            <Icon icon="tabler:database-export" />
            <span><strong>创建完整备份</strong><small>包含标签、回收站和历史版本</small></span>
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
          <button class="primary" type="button" @click="importMarkdownNotes">选择本地文件夹</button>
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
              @click="selectedHistoryId = history.id"
            >
              <strong>{{ history.title || '无标题笔记' }}</strong>
              <small>{{ history.contentPreview }}</small>
              <time>{{ formatTime(history.createdAt) }}</time>
            </button>
          </aside>
          <article v-if="selectedHistory" class="history-preview">
            <h3>{{ selectedHistory.title || '无标题笔记' }}</h3>
            <div class="history-editor-preview">
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

    <div v-if="confirmationDialog.visible" class="dialog-backdrop" @click.self="resolveConfirmation(false)">
      <section class="folder-dialog confirmation-dialog" role="alertdialog" aria-modal="true" :aria-labelledby="'confirmation-dialog-title'">
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
          <div v-if="updateResult.status === 'available' && updateResult.releaseNotes" class="update-release-notes">{{ updateResult.releaseNotes }}</div>
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
