const { contextBridge, ipcRenderer } = require("electron")

contextBridge.exposeInMainWorld("notesDesktop", {
  listWorkspace: () => ipcRenderer.invoke("workspace:list"),
  /** @param {string} noteId 笔记 ID；@returns {Promise<boolean>} 是否已发起打开。 */
  openNoteLink: (noteId) => ipcRenderer.invoke("note-link:open-local", noteId),
  /** @returns {Promise<string>} 返回冷启动期间待打开的笔记 ID。 */
  consumePendingNoteLink: () => ipcRenderer.invoke("note-link:consume-pending"),
  /**
   * 监听外部应用触发的笔记深链接。
   *
   * @param {(noteId: string) => void} callback 笔记 ID 回调。
   * @returns {() => void} 取消监听函数。
   */
  onOpenNoteLink: (callback) => {
    const listener = (_event, noteId) => callback(String(noteId || ""))
    ipcRenderer.on("note-link:open", listener)
    return () => ipcRenderer.removeListener("note-link:open", listener)
  },
  saveAttachment: (input) => ipcRenderer.invoke("asset:save-attachment", input),
  openAttachment: (assetId) => ipcRenderer.invoke("asset:open", assetId),
  openExternalLink: (url) => ipcRenderer.invoke("external-link:open", url),
  saveImageAsset: (input) => ipcRenderer.invoke("asset:save-image", input),
  createNote: (folderId) => ipcRenderer.invoke("note:create", folderId),
  /**
   * 复制笔记到指定文件夹。
   *
   * @param {string} noteId 原笔记 ID。
   * @param {string | null} targetFolderId 目标文件夹 ID，空值表示未分类。
   * @param {string} title 副本标题。
   * @returns {Promise<Record<string, any>>} 新建的笔记副本。
   */
  duplicateNote: (noteId, targetFolderId, title) => (
    ipcRenderer.invoke("note:duplicate", noteId, targetFolderId, title)
  ),
  openQuickCapture: () => ipcRenderer.invoke("quick-capture:open"),
  hideQuickCapture: () => ipcRenderer.invoke("quick-capture:hide"),
  getQuickCaptureSettings: () => ipcRenderer.invoke("quick-capture:settings:get"),
  saveQuickCaptureSettings: (input) => ipcRenderer.invoke("quick-capture:settings:save", input),
  createQuickNote: (input) => ipcRenderer.invoke("quick-capture:create", input),
  onQuickCaptureFocus: (callback) => {
    const listener = () => callback()
    ipcRenderer.on("quick-capture:focus", listener)
    return () => ipcRenderer.removeListener("quick-capture:focus", listener)
  },
  onOpenQuickCaptureSettings: (callback) => {
    const listener = () => callback()
    ipcRenderer.on("quick-capture:open-settings", listener)
    return () => ipcRenderer.removeListener("quick-capture:open-settings", listener)
  },
  /**
   * 监听菜单栏打开通用设置的请求。
   *
   * @param {() => void} callback 打开设置的回调。
   * @returns {() => void} 取消监听函数。
   */
  onOpenGeneralSettings: (callback) => {
    const listener = () => callback()
    ipcRenderer.on("general-settings:open", listener)
    return () => ipcRenderer.removeListener("general-settings:open", listener)
  },
  /**
   * 监听桌面菜单发起的搜索操作。
   *
   * @param {(target: "workspace" | "quick-open" | "current-note") => void} callback 搜索操作回调。
   * @returns {() => void} 取消监听函数。
   */
  onOpenSearch: (callback) => {
    const listener = (_event, target) => callback(target)
    ipcRenderer.on("search:open", listener)
    return () => ipcRenderer.removeListener("search:open", listener)
  },
  /**
   * 监听主进程捕获的快速记录 Escape 按键。
   *
   * @param {() => void} callback Escape 按键回调。
   * @returns {() => void} 取消监听函数。
   */
  onQuickCaptureEscape: (callback) => {
    const listener = () => callback()
    ipcRenderer.on("quick-capture:escape", listener)
    return () => ipcRenderer.removeListener("quick-capture:escape", listener)
  },
  updateNote: (noteId, patch) => ipcRenderer.invoke("note:update", noteId, patch),
  listNoteHistory: (noteId) => ipcRenderer.invoke("note-history:list", noteId),
  getNoteHistory: (noteId, historyId) => ipcRenderer.invoke("note-history:detail", noteId, historyId),
  restoreNoteHistory: (noteId, historyId) => ipcRenderer.invoke("note-history:restore", noteId, historyId),
  deleteNoteHistory: (noteId, historyId) => ipcRenderer.invoke("note-history:delete", noteId, historyId),
  setNoteDeleted: (noteId, deleted) => ipcRenderer.invoke("note:set-deleted", noteId, deleted),
  deleteNotePermanently: (noteId) => ipcRenderer.invoke("note:delete-permanently", noteId),
  emptyTrash: () => ipcRenderer.invoke("note:empty-trash"),
  createFolder: (name, parentId) => ipcRenderer.invoke("folder:create", name, parentId),
  renameFolder: (folderId, name) => ipcRenderer.invoke("folder:rename", folderId, name),
  /**
   * 移动文件夹到指定层级与排序位置。
   *
   * @param {string} folderId 文件夹 ID。
   * @param {string | null} parentId 新父文件夹 ID。
   * @param {string | null} beforeFolderId 排在其前面的文件夹 ID。
   * @returns {Promise<Record<string, any>>} 移动后的文件夹。
   */
  moveFolder: (folderId, parentId, beforeFolderId) => (
    ipcRenderer.invoke("folder:move", folderId, parentId, beforeFolderId)
  ),
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
  /**
   * 监听菜单栏打开导入导出窗口的请求。
   *
   * @param {() => void} callback 打开窗口的回调。
   * @returns {() => void} 取消监听函数。
   */
  onOpenDataTransfer: (callback) => {
    const listener = () => callback()
    ipcRenderer.on("data-transfer:open", listener)
    return () => ipcRenderer.removeListener("data-transfer:open", listener)
  },
  listDatabaseBackups: () => ipcRenderer.invoke("database-backup:list"),
  /** @returns {Promise<Record<string, string>>} 当前档案的备份状态。 */
  getDatabaseBackupStatus: () => ipcRenderer.invoke("database-backup:status"),
  getDatabaseBackupSettings: () => ipcRenderer.invoke("database-backup:settings:get"),
  saveDatabaseBackupSettings: (input) => ipcRenderer.invoke("database-backup:settings:save", input),
  createDatabaseBackup: () => ipcRenderer.invoke("database-backup:create"),
  restoreDatabaseBackup: (backupId) => ipcRenderer.invoke("database-backup:restore", backupId),
  openDatabaseBackupDirectory: () => ipcRenderer.invoke("database-backup:open-directory"),
  /**
   * 监听备份状态变化。
   *
   * @param {(status: Record<string, string>) => void} callback 状态回调。
   * @returns {() => void} 取消监听函数。
   */
  onDatabaseBackupStatus: (callback) => {
    const listener = (_event, status) => callback(status)
    ipcRenderer.on("database-backup:status", listener)
    return () => ipcRenderer.removeListener("database-backup:status", listener)
  },
  setTheme: (theme) => ipcRenderer.invoke("theme:set", theme),
  getSyncSettings: () => ipcRenderer.invoke("sync-settings:get"),
  getSyncStatus: () => ipcRenderer.invoke("sync:status"),
  runSync: () => ipcRenderer.invoke("sync:run"),
  testSyncConnection: (input) => ipcRenderer.invoke("sync-settings:test", input),
  startBrowserSyncLogin: (input) => ipcRenderer.invoke("sync-auth:start", input),
  cancelBrowserSyncLogin: () => ipcRenderer.invoke("sync-auth:cancel"),
  saveSyncSettings: (input) => ipcRenderer.invoke("sync-settings:save", input),
  clearSyncSettings: () => ipcRenderer.invoke("sync-settings:clear"),
  checkForUpdates: () => ipcRenderer.invoke("app-update:check"),
  openUpdateDownload: (downloadUrl) => ipcRenderer.invoke("app-update:open-download", downloadUrl),
  onCheckForUpdates: (callback) => {
    const listener = (_event, silent) => callback(Boolean(silent))
    ipcRenderer.on("app-update:check-request", listener)
    return () => ipcRenderer.removeListener("app-update:check-request", listener)
  },
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
