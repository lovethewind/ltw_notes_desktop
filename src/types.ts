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

export interface NotesDesktopApi {
  listWorkspace(): Promise<WorkspaceData>
  saveImageAsset(input: SaveImageAssetInput): Promise<ImageAsset>
  createNote(folderId: string | null): Promise<OfflineNote>
  updateNote(noteId: string, patch: NotePatch): Promise<OfflineNote | null>
  listNoteHistory(noteId: string): Promise<NoteHistory[]>
  restoreNoteHistory(noteId: string, historyId: string): Promise<OfflineNote | null>
  deleteNoteHistory(noteId: string, historyId: string): Promise<boolean>
  setNoteDeleted(noteId: string, deleted: boolean): Promise<OfflineNote | null>
  deleteNotePermanently(noteId: string): Promise<boolean>
  emptyTrash(): Promise<number>
  createFolder(name: string, parentId?: string | null): Promise<NoteFolder>
  renameFolder(folderId: string, name: string): Promise<NoteFolder | null>
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
  setTheme(theme: ThemeMode): Promise<boolean>
  getSyncSettings(): Promise<SyncSettingsView>
  getSyncStatus(): Promise<SyncStatus>
  runSync(): Promise<SyncStatus>
  testSyncConnection(input: SyncConnectionInput): Promise<SyncConnectionResult>
  startBrowserSyncLogin(input: { backendUrl: string }): Promise<SyncConnectionResult>
  cancelBrowserSyncLogin(): Promise<SyncConnectionResult>
  saveSyncSettings(input: { backendUrl: string }): Promise<SyncSettingsView>
  clearSyncSettings(): Promise<SyncSettingsView>
  onOpenSyncSettings(callback: () => void): () => void
  onSyncAuthResult(callback: (result: SyncConnectionResult) => void): () => void
  onSyncStatus(callback: (status: SyncStatus) => void): () => void
  onWorkspaceChanged(callback: () => void): () => void
}
