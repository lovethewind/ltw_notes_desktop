const { contextBridge, ipcRenderer } = require("electron")

contextBridge.exposeInMainWorld("notesDesktop", {
  listWorkspace: () => ipcRenderer.invoke("workspace:list"),
  saveImageAsset: (input) => ipcRenderer.invoke("asset:save-image", input),
  createNote: (folderId) => ipcRenderer.invoke("note:create", folderId),
  updateNote: (noteId, patch) => ipcRenderer.invoke("note:update", noteId, patch),
  listNoteHistory: (noteId) => ipcRenderer.invoke("note-history:list", noteId),
  restoreNoteHistory: (noteId, historyId) => ipcRenderer.invoke("note-history:restore", noteId, historyId),
  deleteNoteHistory: (noteId, historyId) => ipcRenderer.invoke("note-history:delete", noteId, historyId),
  setNoteDeleted: (noteId, deleted) => ipcRenderer.invoke("note:set-deleted", noteId, deleted),
  deleteNotePermanently: (noteId) => ipcRenderer.invoke("note:delete-permanently", noteId),
  emptyTrash: () => ipcRenderer.invoke("note:empty-trash"),
  createFolder: (name, parentId) => ipcRenderer.invoke("folder:create", name, parentId),
  renameFolder: (folderId, name) => ipcRenderer.invoke("folder:rename", folderId, name),
  setFolderDeleted: (folderId) => ipcRenderer.invoke("folder:set-deleted", folderId),
  restoreFolder: (folderId) => ipcRenderer.invoke("folder:restore", folderId),
  deleteFolderPermanently: (folderId) => ipcRenderer.invoke("folder:delete-permanently", folderId),
  createTag: (name) => ipcRenderer.invoke("tag:create", name),
  deleteTag: (tagId) => ipcRenderer.invoke("tag:delete", tagId),
  exportNoteMarkdown: (noteId) => ipcRenderer.invoke("data:export-note-markdown", noteId),
  exportAllMarkdown: () => ipcRenderer.invoke("data:export-all-markdown"),
  exportFullBackup: () => ipcRenderer.invoke("data:export-backup"),
  importMarkdown: (folderId) => ipcRenderer.invoke("data:import-markdown", folderId),
  importFullBackup: () => ipcRenderer.invoke("data:import-backup"),
  setTheme: (theme) => ipcRenderer.invoke("theme:set", theme),
  getSyncSettings: () => ipcRenderer.invoke("sync-settings:get"),
  getSyncStatus: () => ipcRenderer.invoke("sync:status"),
  runSync: () => ipcRenderer.invoke("sync:run"),
  testSyncConnection: (input) => ipcRenderer.invoke("sync-settings:test", input),
  startBrowserSyncLogin: (input) => ipcRenderer.invoke("sync-auth:start", input),
  cancelBrowserSyncLogin: () => ipcRenderer.invoke("sync-auth:cancel"),
  saveSyncSettings: (input) => ipcRenderer.invoke("sync-settings:save", input),
  clearSyncSettings: () => ipcRenderer.invoke("sync-settings:clear"),
  onOpenSyncSettings: (callback) => {
    const listener = () => callback()
    ipcRenderer.on("sync-settings:open", listener)
    return () => ipcRenderer.removeListener("sync-settings:open", listener)
  },
  onSyncAuthResult: (callback) => {
    const listener = (_event, result) => callback(result)
    ipcRenderer.on("sync-auth:result", listener)
    return () => ipcRenderer.removeListener("sync-auth:result", listener)
  },
  onSyncStatus: (callback) => {
    const listener = (_event, status) => callback(status)
    ipcRenderer.on("sync:status", listener)
    return () => ipcRenderer.removeListener("sync:status", listener)
  },
  onWorkspaceChanged: (callback) => {
    const listener = () => callback()
    ipcRenderer.on("workspace:changed", listener)
    return () => ipcRenderer.removeListener("workspace:changed", listener)
  }
})
