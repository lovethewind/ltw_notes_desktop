export interface NoteTag {
  id: string
  serverId: string | null
  name: string
  createdAt: string
  dirty: boolean
}

export interface NoteFolder {
  id: string
  serverId: string | null
  parentId: string | null
  name: string
  sortOrder: number
  isDeleted: boolean
  deletedAt: string | null
  deletedRootId: string | null
  dirty: boolean
}

export interface OfflineNote {
  id: string
  serverId: string | null
  folderId: string | null
  title: string
  content: string
  /** false 表示 content 仅为列表或搜索摘要，进入编辑器前必须读取详情。 */
  contentLoaded?: boolean
  isPinned: boolean
  isDeleted: boolean
  deletedAt: string | null
  deletedByFolderId: string | null
  conflictSourceId: string | null
  createdAt: string
  updatedAt: string
  revision: number
  dirty: boolean
  tags: NoteTag[]
}

/**
 * 关系列表中的一行笔记概要。
 *
 * 入边（谁引用了本篇）与出边（本篇引用了谁）共用此结构，两者数据同源于 note_links 表，
 * 仅方向不同，因此不区分类型。
 */
export interface BacklinkNote {
  id: string
  title: string
  folderId: string | null
  isDeleted: boolean
  updatedAt: string
}

export interface GraphNode {
  id: string
  title: string
  folderId: string | null
  depth: number
}

export interface GraphLink {
  source: string
  target: string
}

export interface NoteGraph {
  nodes: GraphNode[]
  links: GraphLink[]
  rootId: string
}

/** 全库双链关系图谱，节点仅包含至少参与一条关系的未删除笔记。 */
export interface GlobalGraph {
  nodes: GraphNode[]
  links: GraphLink[]
}

/** 笔记列表可选的排序方式。 */
export type NoteSortOrder = 'updated' | 'created' | 'title'

export interface WorkspaceData {
  folders: NoteFolder[]
  tags: NoteTag[]
  notes: OfflineNote[]
  pendingCount: number
}

export interface NotePatch {
  title?: string
  content?: string
  folderId?: string | null
  isPinned?: boolean
  tagNames?: string[]
}

export interface BulkNotePatch {
  folderId?: string | null
  isPinned?: boolean
  isDeleted?: boolean
  permanentlyDelete?: boolean
  addTagNames?: string[]
  removeTagNames?: string[]
}

export interface NoteConflictPair {
  original: OfflineNote
  conflict: OfflineNote
}

export interface NoteConflictResolution {
  strategy: 'local' | 'remote' | 'both'
  note: OfflineNote
}

export interface NoteHistory {
  id: string
  noteId: string
  title: string
  content: string
  contentPreview: string
  folderId: string | null
  tagNames: string[]
  createdAt: string
}

export type ThemeMode = 'system' | 'light' | 'dark'

export interface SyncSettingsView {
  backendUrl: string
  webUrl: string
  configured: boolean
  accountLabel: string
}

export interface SyncConnectionInput {
  backendUrl: string
  username?: string
  password?: string
}

export interface SyncConnectionResult {
  ok: boolean
  message: string
  backendUrl?: string
  accountLabel?: string
}

export interface SyncStatus {
  state: 'idle' | 'syncing' | 'success' | 'error'
  message: string
  lastSuccessAt: string
  lastResult?: SyncResultSummary | null
  history?: SyncResultSummary[]
}

export interface SyncResultChange {
  id: string
  title: string
  entityType: 'note' | 'folder' | 'tag' | 'history'
  kind: 'upload' | 'download' | 'delete'
  occurredAt: string
}

export interface SyncResultSummary {
  startedAt: string
  completedAt: string
  durationMs: number
  uploadedCount: number
  downloadedCount: number
  deletedCount: number
  attachmentCount: number
  conflictCount: number
  changes: SyncResultChange[]
}

export interface UpdateCheckResult {
  status: 'available' | 'latest' | 'unpublished'
  currentVersion: string
  latestVersion: string
  title: string
  releaseNotes: string
  downloadUrl: string
}

export interface UpdateDownloadProgress {
  received: number
  total: number
}

export interface UpdateDownloadResult {
  filePath: string
  total: number
}

export interface DataTransferResult {
  canceled: boolean
  message?: string
  filePath?: string
  importedFolders?: number
  importedNotes?: number
  importedHistories?: number
  rootFolderId?: string
  noteIds?: string[]
}

/**
 * 「本机笔记地址转网页地址」的只读预览。
 *
 * 存在的理由：地址只在插入那一刻由 `buildNoteHref` 决定，存量与「先插链接、目标后同步」
 * 的链接都不会自动回填。批量改写用户正文有风险，所以先给一份账再让用户确认。
 */
export interface LocalNoteLinkRewritePreview {
  /** 参与扫描的未删除笔记数。 */
  scannedNotes: number
  /** 正文里含本机笔记地址的笔记数。 */
  linkedNotes: number
  /** 会被改动的笔记数。 */
  convertibleNotes: number
  /** 扫到的本机笔记地址总条数（不含围栏代码块内的）。 */
  totalLinks: number
  /** 能转成网页地址的条数。 */
  convertibleLinks: number
  /** 目标笔记已不存在（已删除）的条数。 */
  missingLinks: number
  /** 目标笔记尚未同步到云端（无 serverId）的条数。 */
  unsyncedLinks: number
  /** 因未配置网页地址而无法转换的条数。 */
  noWebBaseLinks: number
  /** 前几篇将被改动的笔记，用于展示样例。 */
  samples: Array<{ noteId: string; title: string; changed: number }>
}

/** 「本机笔记地址转网页地址」的执行结果。 */
export interface LocalNoteLinkRewriteResult extends DataTransferResult {
  /** 实际被改动的笔记数。 */
  noteCount: number
  /** 实际被改写的链接条数。 */
  linkCount: number
}

/**
 * 「给嵌入卡片补线上标识」的预览统计。
 *
 * 嵌入卡的两个标识属性互为补充：桌面端插入写本机 uuid（`data-xynote-embed="note:{localId}"`），
 * 目标已同步时再补上跨端标识 `data-xynote-embed-server`；网页端插入则只能写后者。
 * 本统计针对**存量桌面端卡片**（有本机 uuid、缺跨端标识），需要用户先看这份账再决定是否补。
 * 设计见 docs/specs/2026-10-12-note-embed-web-render.md。
 */
export interface EmbedServerIdFillPreview {
  /** 参与扫描的未删除笔记数。 */
  scannedNotes: number
  /** 正文里含嵌入卡片的笔记数。 */
  embeddedNotes: number
  /** 会被改动的笔记数。 */
  convertibleNotes: number
  /** 扫到的嵌入卡片总张数（不含围栏代码块内的）。 */
  totalEmbeds: number
  /** 能补上跨端标识的张数。 */
  fillableEmbeds: number
  /** 目标笔记已不存在（已删除）的张数。 */
  missingEmbeds: number
  /** 目标笔记尚未同步到云端（无 serverId）的张数。 */
  unsyncedEmbeds: number
  /** 已经带跨端标识、无需改动的张数。 */
  alreadyFilledEmbeds: number
  /** 前几篇将被改动的笔记，用于展示样例。 */
  samples: Array<{ noteId: string; title: string; changed: number }>
}

/** 「给嵌入卡片补线上标识」的执行结果。 */
export interface EmbedServerIdFillResult extends DataTransferResult {
  /** 实际被改动的笔记数。 */
  noteCount: number
  /** 实际补上标识的卡片张数。 */
  embedCount: number
}

export interface DatabaseBackup {
  id: string
  createdAt: string
  reason: 'daily' | 'manual' | 'before-import' | 'pre-restore'
  size: number
  kind: 'complete' | 'database'
  assetCount: number
}

export interface DatabaseBackupRestoreResult {
  restored: boolean
  message: string
  safetyBackup: DatabaseBackup
}

export interface DatabaseBackupStatus {
  state: 'idle' | 'success' | 'error'
  message: string
  lastSuccessAt: string
  reason: DatabaseBackup['reason'] | ''
}

export interface DatabaseBackupSettings {
  schedule: 'daily' | 'weekly' | 'off'
  retention: number
}

export interface SaveImageAssetInput {
  fileName: string
  mimeType: string
  data: ArrayBuffer
}

export interface ImageAsset {
  id: string
  fileName: string
  mimeType: string
  byteSize: number
  sha256: string
  localPath: string
  localUrl: string
  remoteUrl: string | null
  serverSourceId: string | null
  createdAt: string
  updatedAt: string
}

export type SaveAttachmentInput = SaveImageAssetInput
export type AttachmentAsset = ImageAsset

export interface AttachmentNoteReference {
  id: string
  title: string
  isDeleted: boolean
}

export interface AttachmentInventoryItem extends AttachmentAsset {
  kind: 'image' | 'document' | 'other'
  state: 'uploaded' | 'pending' | 'missing' | 'corrupt'
  integrityIssue: '' | 'missing' | 'corrupt'
  sourceKind: 'managed' | 'external-cache'
  sourceHost: string
  localExists: boolean
  localBytes: number
  noteReferences: AttachmentNoteReference[]
  historyReferenceCount: number
  referenceCount: number
  isOrphan: boolean
}

export interface AttachmentInventory {
  items: AttachmentInventoryItem[]
  totalCount: number
  localBytes: number
  uploadedCount: number
  pendingCount: number
  missingCount: number
  corruptCount: number
  orphanCount: number
  managedCount: number
  externalCacheCount: number
}

export interface AttachmentCleanupResult {
  assetId: string
  removedLocalFile: boolean
}

export interface AttachmentCleanupFailure {
  assetId: string
  fileName: string
  message: string
}

export interface AttachmentBulkCleanupResult {
  candidateCount: number
  removedCount: number
  removedLocalFileCount: number
  failedCount: number
  failures: AttachmentCleanupFailure[]
}

export interface AttachmentRepairFailure {
  assetId: string
  fileName: string
  issue: 'missing' | 'corrupt' | 'upload'
  message: string
}

export interface AttachmentIntegrityRepairResult {
  candidateCount: number
  healthyCount: number
  repairedCount: number
  downloadedCount: number
  uploadedCount: number
  failedCount: number
  failures: AttachmentRepairFailure[]
}

export interface WorkspaceSessionTab {
  noteId: string
  isPinned: boolean
  scrollTop: number
}

export interface WorkspaceSession {
  tabs: WorkspaceSessionTab[]
  activeNoteId: string | null
}

export interface WorkspaceSessionInput {
  tabs: Array<Pick<WorkspaceSessionTab, 'noteId' | 'isPinned'>>
  activeNoteId: string | null
}

export type AiAssistantScope = 'current' | 'folder' | 'all'

export interface AiAssistantSettings {
  baseUrl: string
  model: string
  hasApiKey: boolean
}

export interface AiAssistantSource {
  id: string
  noteId: string
  title: string
  excerpt: string
}

export interface AiAssistantAnswer {
  answer: string
  sources: AiAssistantSource[]
}

/**
 * 外部 Markdown 文件的内容快照。
 *
 * 与 OfflineNote 的区别：外部文件不落本地数据库、不参与云端同步，
 * 文件本身即唯一真相来源，应用只负责「打开—编辑—写回」。
 */
export interface LocalMarkdownFile {
  filePath: string
  fileName: string
  content: string
  modifiedAt?: string
}

/** 打开/另存外部 Markdown 文件的结果。取消或失败时以 canceled 或抛错表达。 */
export type LocalMarkdownFileResult =
  | { canceled: true }
  | (LocalMarkdownFile & { canceled: false })

export interface NotesDesktopApi {
  listWorkspace(): Promise<WorkspaceData>
  getWorkspaceSession(): Promise<WorkspaceSession>
  saveWorkspaceSession(input: WorkspaceSessionInput): Promise<WorkspaceSession>
  saveNoteViewState(noteId: string, scrollTop: number): Promise<boolean>
  /** 按需读取单篇笔记的完整正文。 */
  getNote(noteId: string): Promise<OfflineNote | null>
  /** 在 SQLite 中搜索完整正文，并可组合结构化筛选条件。 */
  searchNotes(keyword: string, options?: {
    includeMetadata?: boolean
    limit?: number
    folderIds?: string[]
    tagIds?: string[]
    updatedAfter?: string
    pinnedOnly?: boolean
  }): Promise<OfflineNote[]>
  /** 读取不包含 API Key 明文的 AI 助手设置。 */
  getAiAssistantSettings(): Promise<AiAssistantSettings>
  /** 保存 OpenAI 兼容接口设置；空密钥表示保留已有密钥。 */
  saveAiAssistantSettings(input: {
    baseUrl: string
    model: string
    apiKey?: string
  }): Promise<AiAssistantSettings>
  /** 基于有限的本地笔记上下文请求 AI 回答。 */
  askAiAssistant(input: {
    question: string
    scope: AiAssistantScope
    noteId?: string | null
    folderId?: string | null
  }): Promise<AiAssistantAnswer>
  /** 打开指定笔记。 */
  openNoteLink(noteId: string): Promise<boolean>
  /** 查询引用了指定笔记的本地笔记列表（入边）。 */
  getNoteBacklinks(noteId: string): Promise<BacklinkNote[]>
  /** 查询指定笔记显式引用了的本地笔记列表（出边）。 */
  getNoteOutlinks(noteId: string): Promise<BacklinkNote[]>
  /** 以指定笔记为中心查询局部引用图谱。 */
  getNoteGraph(noteId: string, maxDepth?: number): Promise<NoteGraph>
  /** 查询全库双链关系图谱。 */
  getGlobalGraph(maxNodes?: number): Promise<GlobalGraph>
  /** 获取冷启动期间待打开的笔记 ID。 */
  consumePendingNoteLink(): Promise<string>
  /** 监听外部应用触发的笔记深链接。 */
  onOpenNoteLink(callback: (noteId: string) => void): () => void
  /** 监听应用退出前的强制保存请求。 */
  onBeforeQuitSave(callback: (requestId: number) => void): () => void
  /** 将退出前保存结果回报给主进程。 */
  completeBeforeQuitSave(requestId: number, result: { ok: boolean, message?: string }): void
  /** 弹出系统文件选择器并读取选中的外部 Markdown 文件。 */
  pickMarkdownFile(): Promise<LocalMarkdownFileResult>
  /** 按绝对路径读取外部 Markdown 文件（供拖拽入窗使用）。 */
  readMarkdownFile(filePath: string): Promise<LocalMarkdownFile>
  /** 将正文写回外部 Markdown 文件。 */
  saveMarkdownFile(filePath: string, content: string): Promise<LocalMarkdownFile>
  /** 将正文另存为新的 Markdown 文件。 */
  saveMarkdownFileAs(defaultName: string, content: string): Promise<LocalMarkdownFileResult>
  /**
   * 读取系统剪贴板内容（富文本粘贴用）。
   *
   * `navigator.clipboard.readText()` 只能拿纯文本、拿不到 `text/html`，
   * 故「粘贴（富文本）」经主进程 clipboard 模块取 HTML 表示。
   */
  readClipboard(): Promise<{ text: string, html: string }>
  /** 读取拖入窗口的文件在磁盘上的绝对路径，取不到时为空串。 */
  getDroppedFilePath(file: File): string
  /** 监听菜单栏「打开 Markdown 文件…」。 */
  onOpenLocalFile(callback: () => void): () => void
  /** 监听菜单栏「保存」。 */
  onSaveLocalFile(callback: () => void): () => void
  /** 监听菜单栏「另存为…」。 */
  onSaveLocalFileAs(callback: () => void): () => void
  saveAttachment(input: SaveAttachmentInput): Promise<AttachmentAsset>
  openAttachment(assetId: string): Promise<boolean>
  listAttachmentInventory(): Promise<AttachmentInventory>
  revealAttachment(assetId: string): Promise<boolean>
  deleteOrphanAttachment(assetId: string): Promise<AttachmentCleanupResult>
  deleteAllOrphanAttachments(assetIds: string[]): Promise<AttachmentBulkCleanupResult>
  repairAttachmentIntegrity(): Promise<AttachmentIntegrityRepairResult>
  openExternalLink(url: string): Promise<boolean>
  saveImageAsset(input: SaveImageAssetInput): Promise<ImageAsset>
  /** 复制预览里的图片到系统剪贴板。 */
  copyPreviewImage(src: string): Promise<{ ok: boolean, message: string }>
  /** 把预览里的图片另存为本地文件。 */
  savePreviewImageAs(src: string): Promise<
    | { ok: true, canceled: true }
    | { ok: true, canceled: false, fileName: string }
    | { ok: false, message: string }
  >
  createNote(folderId: string | null): Promise<OfflineNote>
  /** 复制笔记到指定文件夹。 */
  duplicateNote(noteId: string, targetFolderId: string | null, title: string): Promise<OfflineNote>
  openQuickCapture(): Promise<boolean>
  hideQuickCapture(): Promise<boolean>
  getQuickCaptureSettings(): Promise<{ shortcut: string, folderId: string | null }>
  saveQuickCaptureSettings(input: { shortcut: string, folderId: string | null }): Promise<{ shortcut: string, folderId: string | null }>
  createQuickNote(input: { title: string, content: string, folderId: string | null }): Promise<OfflineNote>
  onQuickCaptureFocus(callback: () => void): () => void
  onOpenQuickCaptureSettings(callback: () => void): () => void
  /** 监听菜单栏打开通用设置的请求。 */
  onOpenGeneralSettings(callback: () => void): () => void
  /** 监听菜单栏发起的搜索操作。 */
  onOpenSearch(callback: (target: 'workspace' | 'quick-open' | 'current-note') => void): () => void
  /** 监听主进程捕获的快速记录 Escape 按键。 */
  onQuickCaptureEscape(callback: () => void): () => void
  updateNote(noteId: string, patch: NotePatch): Promise<OfflineNote | null>
  bulkUpdateNotes(noteIds: string[], patch: BulkNotePatch): Promise<OfflineNote[]>
  resolveNoteConflict(conflictNoteId: string, strategy: 'local' | 'remote' | 'both'): Promise<NoteConflictResolution>
  listNoteHistory(noteId: string): Promise<NoteHistory[]>
  getNoteHistory(noteId: string, historyId: string): Promise<NoteHistory | null>
  restoreNoteHistory(noteId: string, historyId: string): Promise<OfflineNote | null>
  deleteNoteHistory(noteId: string, historyId: string): Promise<boolean>
  setNoteDeleted(noteId: string, deleted: boolean): Promise<OfflineNote | null>
  deleteNotePermanently(noteId: string): Promise<boolean>
  emptyTrash(): Promise<number>
  createFolder(name: string, parentId?: string | null): Promise<NoteFolder>
  renameFolder(folderId: string, name: string): Promise<NoteFolder | null>
  moveFolder(folderId: string, parentId: string | null, beforeFolderId: string | null): Promise<NoteFolder>
  setFolderDeleted(folderId: string): Promise<boolean>
  restoreFolder(folderId: string): Promise<boolean>
  deleteFolderPermanently(folderId: string): Promise<boolean>
  createTag(name: string): Promise<NoteTag>
  deleteTag(tagId: string): Promise<boolean>
  exportNoteMarkdown(noteId: string): Promise<DataTransferResult>
  /** 导出为「纯净」Markdown：不含元数据与应用私有标签，给其他软件看的那一份。 */
  exportNoteMarkdownClean(noteId: string): Promise<DataTransferResult>
  exportAllMarkdown(): Promise<DataTransferResult>
  exportSelectedMarkdown(noteIds: string[]): Promise<DataTransferResult>
  exportFullBackup(): Promise<DataTransferResult>
  /** 预览「本机笔记地址转网页地址」将改动的范围（只读，不改库）。 */
  previewLocalNoteLinkRewrite(): Promise<LocalNoteLinkRewritePreview>
  /** 手动把正文里仍使用本机地址的笔记链接改写成网页地址。 */
  rewriteLocalNoteLinks(): Promise<LocalNoteLinkRewriteResult>
  /** 预览「给嵌入卡片补线上标识」将改动的范围（只读，不改库）。 */
  previewEmbedServerIdFill(): Promise<EmbedServerIdFillPreview>
  /** 手动给正文里的嵌入卡片补上跨端标识，供网页端渲染成卡片。 */
  fillEmbedServerIds(): Promise<EmbedServerIdFillResult>
  importMarkdown(folderId: string | null): Promise<DataTransferResult>
  /** 导入单个 Markdown 文件（含其引用的本地图片），不建来源文件夹。 */
  importSingleMarkdown(folderId: string | null): Promise<DataTransferResult>
  /**
   * 把当前已打开的外部文件导入笔记库（不弹文件选择框）。
   *
   * `content` 是编辑器里的当前正文 —— 可能还没落盘，以用户看到的为准。
   */
  importMarkdownPath(filePath: string, content: string, folderId: string | null): Promise<DataTransferResult>
  importFullBackup(): Promise<DataTransferResult>
  /** 监听菜单栏打开数据管理窗口的请求。 */
  onOpenDataTransfer(callback: () => void): () => void
  listDatabaseBackups(): Promise<DatabaseBackup[]>
  /** 获取当前档案的备份状态。 */
  getDatabaseBackupStatus(): Promise<DatabaseBackupStatus>
  getDatabaseBackupSettings(): Promise<DatabaseBackupSettings>
  saveDatabaseBackupSettings(input: DatabaseBackupSettings): Promise<DatabaseBackupSettings>
  createDatabaseBackup(): Promise<DatabaseBackup>
  restoreDatabaseBackup(backupId: string): Promise<DatabaseBackupRestoreResult>
  openDatabaseBackupDirectory(): Promise<boolean>
  /** 监听当前档案的备份状态变化。 */
  onDatabaseBackupStatus(callback: (status: DatabaseBackupStatus) => void): () => void
  setTheme(theme: ThemeMode): Promise<boolean>
  getSyncSettings(): Promise<SyncSettingsView>
  getSyncStatus(): Promise<SyncStatus>
  runSync(): Promise<SyncStatus>
  testSyncConnection(input: SyncConnectionInput): Promise<SyncConnectionResult>
  startBrowserSyncLogin(input: { backendUrl: string, webUrl: string }): Promise<SyncConnectionResult>
  cancelBrowserSyncLogin(): Promise<SyncConnectionResult>
  saveSyncSettings(input: { backendUrl: string, webUrl: string }): Promise<SyncSettingsView>
  clearSyncSettings(): Promise<SyncSettingsView>
  checkForUpdates(): Promise<UpdateCheckResult>
  openUpdateDownload(downloadUrl: string): Promise<void>
  downloadUpdate(downloadUrl: string): Promise<UpdateDownloadResult>
  openUpdateInstaller(filePath: string): Promise<string>
  revealUpdateInstaller(filePath: string): Promise<boolean>
  onUpdateDownloadProgress(callback: (progress: UpdateDownloadProgress) => void): () => void
  onCheckForUpdates(callback: (silent: boolean) => void): () => void
  onOpenSyncSettings(callback: () => void): () => void
  onSyncAuthResult(callback: (result: SyncConnectionResult) => void): () => void
  onSyncStatus(callback: (status: SyncStatus) => void): () => void
  onWorkspaceChanged(callback: () => void): () => void
}
