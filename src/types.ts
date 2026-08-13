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

export interface NotesDesktopApi {
  listWorkspace(): Promise<WorkspaceData>
  /** 打开指定笔记。 */
  openNoteLink(noteId: string): Promise<boolean>
  /** 获取冷启动期间待打开的笔记 ID。 */
  consumePendingNoteLink(): Promise<string>
  /** 监听外部应用触发的笔记深链接。 */
  onOpenNoteLink(callback: (noteId: string) => void): () => void
  saveAttachment(input: SaveAttachmentInput): Promise<AttachmentAsset>
  openAttachment(assetId: string): Promise<boolean>
  listAttachmentInventory(): Promise<AttachmentInventory>
  revealAttachment(assetId: string): Promise<boolean>
  deleteOrphanAttachment(assetId: string): Promise<AttachmentCleanupResult>
  deleteAllOrphanAttachments(assetIds: string[]): Promise<AttachmentBulkCleanupResult>
  repairAttachmentIntegrity(): Promise<AttachmentIntegrityRepairResult>
  openExternalLink(url: string): Promise<boolean>
  saveImageAsset(input: SaveImageAssetInput): Promise<ImageAsset>
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
  exportAllMarkdown(): Promise<DataTransferResult>
  exportFullBackup(): Promise<DataTransferResult>
  importMarkdown(folderId: string | null): Promise<DataTransferResult>
  importFullBackup(): Promise<DataTransferResult>
  /** 监听菜单栏打开导入导出窗口的请求。 */
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
  onCheckForUpdates(callback: (silent: boolean) => void): () => void
  onOpenSyncSettings(callback: () => void): () => void
  onSyncAuthResult(callback: (result: SyncConnectionResult) => void): () => void
  onSyncStatus(callback: (status: SyncStatus) => void): () => void
  onWorkspaceChanged(callback: () => void): () => void
}
