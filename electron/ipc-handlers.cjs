/**
 * 按功能域注册 Electron IPC，避免主进程入口同时承担全部路由细节。
 * 每个域仅接收已经绑定好的服务函数，不直接持有应用全局状态。
 */

function registerWorkspaceHandlers(ipcMain, domain) {
  ipcMain.handle("workspace:list", domain.listWorkspace)
  ipcMain.handle("workspace-session:get", domain.getSession)
  ipcMain.handle("workspace-session:save", (_event, input) => domain.saveSession(input || {}))
  ipcMain.handle("workspace-session:save-view-state", (_event, noteId, scrollTop) => (
    domain.saveViewState(noteId, scrollTop)
  ))
  ipcMain.handle("note:detail", (_event, noteId) => domain.getNote(noteId))
  ipcMain.handle("note:search", (_event, keyword, options) => domain.searchNotes(keyword, options || {}))
  ipcMain.handle("note-link:open-local", (_event, noteId) => domain.openNoteLink(noteId))
  ipcMain.handle("note:backlinks", (_event, noteId) => domain.getBacklinks(noteId))
  ipcMain.handle("note:outlinks", (_event, noteId) => domain.getOutlinks(noteId))
  ipcMain.handle("note:graph", (_event, noteId, maxDepth) => domain.getNoteGraph(noteId, maxDepth))
  ipcMain.handle("note:graph:global", (_event, maxNodes) => domain.getGlobalGraph(maxNodes))
  ipcMain.handle("note-link:consume-pending", domain.consumePendingNoteLink)
}

function registerAttachmentHandlers(ipcMain, domain) {
  ipcMain.handle("asset:save-attachment", (_event, input) => domain.saveAttachment(input || {}))
  ipcMain.handle("asset:open", (_event, assetId) => domain.openAttachment(assetId))
  ipcMain.handle("asset-management:list", domain.listInventory)
  ipcMain.handle("asset-management:reveal", (_event, assetId) => domain.revealAttachment(assetId))
  ipcMain.handle("asset-management:delete-orphan", (_event, assetId) => domain.deleteOrphan(assetId))
  ipcMain.handle("asset-management:delete-all-orphans", (_event, assetIds) => domain.deleteAllOrphans(assetIds))
  ipcMain.handle("asset-management:repair-integrity", domain.repairIntegrity)
  ipcMain.handle("external-link:open", (_event, url) => domain.openExternalLink(url))
  ipcMain.handle("asset:save-image", (_event, input) => domain.saveImage(input || {}))
}

function registerNoteHandlers(ipcMain, domain) {
  ipcMain.handle("note:create", (_event, folderId) => domain.create(folderId || null))
  ipcMain.handle("note:duplicate", (_event, noteId, targetFolderId, title) => (
    domain.duplicate(noteId, targetFolderId, title)
  ))
  ipcMain.handle("note:update", (_event, noteId, patch) => domain.update(noteId, patch))
  ipcMain.handle("note:bulk-update", (_event, noteIds, patch) => domain.bulkUpdate(noteIds, patch))
  ipcMain.handle("note-conflict:resolve", (_event, conflictNoteId, strategy) => (
    domain.resolveConflict(conflictNoteId, strategy)
  ))
  ipcMain.handle("note-history:list", (_event, noteId) => domain.listHistory(noteId))
  ipcMain.handle("note-history:detail", (_event, noteId, historyId) => domain.getHistory(noteId, historyId))
  ipcMain.handle("note-history:restore", (_event, noteId, historyId) => domain.restoreHistory(noteId, historyId))
  ipcMain.handle("note-history:delete", (_event, noteId, historyId) => domain.deleteHistory(noteId, historyId))
  ipcMain.handle("note:set-deleted", (_event, noteId, deleted) => domain.setDeleted(noteId, deleted))
  ipcMain.handle("note:delete-permanently", (_event, noteId) => domain.deletePermanently(noteId))
  ipcMain.handle("note:empty-trash", domain.emptyTrash)
}

function registerFolderTagHandlers(ipcMain, domain) {
  ipcMain.handle("folder:create", (_event, name, parentId) => domain.createFolder(name, parentId || null))
  ipcMain.handle("folder:rename", (_event, folderId, name) => domain.renameFolder(folderId, name))
  ipcMain.handle("folder:move", (_event, folderId, parentId, beforeFolderId) => (
    domain.moveFolder(folderId, parentId || null, beforeFolderId || null)
  ))
  ipcMain.handle("folder:set-deleted", (_event, folderId) => domain.deleteFolder(folderId))
  ipcMain.handle("folder:restore", (_event, folderId) => domain.restoreFolder(folderId))
  ipcMain.handle("folder:delete-permanently", (_event, folderId) => domain.deleteFolderPermanently(folderId))
  ipcMain.handle("tag:create", (_event, name) => domain.createTag(name))
  ipcMain.handle("tag:delete", (_event, tagId) => domain.deleteTag(tagId))
}

function registerQuickCaptureHandlers(ipcMain, domain) {
  ipcMain.handle("quick-capture:open", domain.open)
  ipcMain.handle("quick-capture:hide", domain.hide)
  ipcMain.handle("quick-capture:settings:get", domain.getSettings)
  ipcMain.handle("quick-capture:settings:save", (_event, input) => domain.saveSettings(input || {}))
  ipcMain.handle("quick-capture:create", (_event, input) => domain.create(input || {}))
}

function registerDataTransferHandlers(ipcMain, domain) {
  ipcMain.handle("data:export-note-markdown", (_event, noteId) => domain.exportNote(noteId))
  ipcMain.handle("data:export-all-markdown", domain.exportAll)
  ipcMain.handle("data:export-selected-markdown", (_event, noteIds) => domain.exportSelected(noteIds))
  ipcMain.handle("data:export-backup", domain.exportBackup)
  ipcMain.handle("data:import-markdown", (_event, folderId) => domain.importMarkdown(folderId || null))
  ipcMain.handle("data:import-backup", domain.importBackup)
}

function registerBackupHandlers(ipcMain, domain) {
  ipcMain.handle("database-backup:list", domain.list)
  ipcMain.handle("database-backup:status", domain.getStatus)
  ipcMain.handle("database-backup:settings:get", domain.getSettings)
  ipcMain.handle("database-backup:settings:save", (_event, input) => domain.saveSettings(input || {}))
  ipcMain.handle("database-backup:create", domain.create)
  ipcMain.handle("database-backup:restore", (_event, backupId) => domain.restore(backupId))
  ipcMain.handle("database-backup:open-directory", domain.openDirectory)
}

function registerSyncHandlers(ipcMain, domain) {
  ipcMain.handle("sync-settings:get", domain.getSettings)
  ipcMain.handle("sync:status", domain.getStatus)
  ipcMain.handle("sync:run", domain.run)
  ipcMain.handle("sync-settings:test", (_event, input) => domain.testConnection(input || {}))
  ipcMain.handle("sync-auth:start", (_event, input) => domain.startAuth(input || {}))
  ipcMain.handle("sync-auth:cancel", domain.cancelAuth)
  ipcMain.handle("sync-settings:save", (_event, input) => domain.saveSettings(input || {}))
  ipcMain.handle("sync-settings:clear", domain.clearSettings)
}

function registerApplicationHandlers(ipcMain, domain) {
  ipcMain.on("app:before-quit-save-result", (_event, requestId, result) => {
    domain.completeQuitSave(Number(requestId), result || {})
  })
  ipcMain.handle("theme:set", (_event, theme) => domain.setTheme(theme))
  ipcMain.handle("app-update:check", domain.checkForUpdates)
  ipcMain.handle("app-update:open-download", (_event, downloadUrl) => domain.openUpdateDownload(downloadUrl))
  ipcMain.handle("app-update:download", (_event, downloadUrl) => domain.downloadUpdate(downloadUrl))
  ipcMain.handle("app-update:open-installer", (_event, filePath) => domain.openUpdateInstaller(filePath))
  ipcMain.handle("app-update:reveal-installer", (_event, filePath) => domain.revealUpdateInstaller(filePath))
}

/** 注册 AI 助手设置与问答接口，密钥和网络请求只停留在主进程。 */
function registerAiAssistantHandlers(ipcMain, domain) {
  ipcMain.handle("ai-assistant:settings:get", domain.getSettings)
  ipcMain.handle("ai-assistant:settings:save", (_event, input) => domain.saveSettings(input || {}))
  ipcMain.handle("ai-assistant:ask", (_event, input) => domain.ask(input || {}))
}

function registerIpcHandlers(ipcMain, domains) {
  registerApplicationHandlers(ipcMain, domains.application)
  registerAiAssistantHandlers(ipcMain, domains.aiAssistant)
  registerWorkspaceHandlers(ipcMain, domains.workspace)
  registerAttachmentHandlers(ipcMain, domains.attachments)
  registerNoteHandlers(ipcMain, domains.notes)
  registerFolderTagHandlers(ipcMain, domains.foldersAndTags)
  registerQuickCaptureHandlers(ipcMain, domains.quickCapture)
  registerDataTransferHandlers(ipcMain, domains.dataTransfer)
  registerBackupHandlers(ipcMain, domains.backups)
  registerSyncHandlers(ipcMain, domains.sync)
}

module.exports = { registerIpcHandlers }
