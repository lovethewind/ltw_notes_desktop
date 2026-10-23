const { contextBridge, ipcRenderer, webUtils } = require("electron")

contextBridge.exposeInMainWorld("notesDesktop", {
  listWorkspace: () => ipcRenderer.invoke("workspace:list"),
  getWorkspaceSession: () => ipcRenderer.invoke("workspace-session:get"),
  saveWorkspaceSession: (input) => ipcRenderer.invoke("workspace-session:save", input),
  saveNoteViewState: (noteId, scrollTop) => (
    ipcRenderer.invoke("workspace-session:save-view-state", noteId, scrollTop)
  ),
  getNote: (noteId) => ipcRenderer.invoke("note:detail", noteId),
  searchNotes: (keyword, options) => ipcRenderer.invoke("note:search", keyword, options),
  getAiAssistantSettings: () => ipcRenderer.invoke("ai-assistant:settings:get"),
  saveAiAssistantSettings: (input) => ipcRenderer.invoke("ai-assistant:settings:save", input),
  askAiAssistant: (input) => ipcRenderer.invoke("ai-assistant:ask", input),
  /**
   * 流式提问：返回值与非流式一致，过程中通过 `onAiAssistantDelta` 推送增量。
   *
   * @param {Record<string, any>} input 含 requestId，主进程原样回传用于过滤。
   * @returns {Promise<Record<string, any>>} 最终答案与来源。
   */
  askAiAssistantStream: (input) => ipcRenderer.invoke("ai-assistant:ask-stream", input),
  /**
   * 停止生成：中止主进程那条流式请求（不是只丢增量）。
   *
   * @param {string} requestId 与提问时同一个 requestId。
   * @returns {Promise<boolean>} 是否真的停掉了一条在跑的请求。
   */
  abortAiAssistantStream: (requestId) => ipcRenderer.invoke("ai-assistant:abort", requestId),
  /**
   * 监听流式增量。
   *
   * @param {(payload: { requestId: string, delta: string }) => void} callback 增量回调。
   * @returns {() => void} 取消监听函数。
   */
  onAiAssistantDelta: (callback) => {
    const listener = (_event, payload) => callback(payload || {})
    ipcRenderer.on("ai-assistant:delta", listener)
    return () => ipcRenderer.removeListener("ai-assistant:delta", listener)
  },
  /**
   * 列出本机保存的历史对话（置顶在前、其余最新在前，不含正文）。
   *
   * @param {{ keyword?: string, noteId?: string }} [options] 筛选条件；
   *   `keyword` 按标题或任意一轮提问匹配，`noteId` 只列归属这篇笔记的会话。
   */
  listAiConversations: (options) => ipcRenderer.invoke("ai-conversation:list", options),
  /** 读一个历史对话的完整轮次；不存在时返回 null。 */
  getAiConversation: (conversationId) => ipcRenderer.invoke("ai-conversation:get", conversationId),
  /**
   * 追加一轮已完成的问答；`conversationId` 为空时按需新建会话。
   *
   * `noteId` 只在新建会话时生效，记下「在哪篇笔记下开始问的」，追问不改归属。
   *
   * @param {{ conversationId?: string, question: string, answer: string,
   *   sources?: unknown[], citationMissing?: boolean, noteId?: string }} input 轮次内容。
   * @returns {Promise<{ conversationId: string, turnId: string } | null>} 落库后的 ID。
   */
  appendAiConversationTurn: (input) => ipcRenderer.invoke("ai-conversation:append-turn", input),
  /** 重写某一轮的回答（重新生成），不动问题与位置。 */
  replaceAiConversationTurn: (input) => ipcRenderer.invoke("ai-conversation:replace-turn", input),
  /** 给历史对话改名；空标题返回 false。 */
  renameAiConversation: (conversationId, title) => ipcRenderer.invoke("ai-conversation:rename", conversationId, title),
  /** 置顶 / 取消置顶一条历史对话。 */
  setAiConversationPinned: (conversationId, pinned) => ipcRenderer.invoke("ai-conversation:pin", conversationId, pinned),
  /** 删除一个历史对话（轮次级联删除）。 */
  deleteAiConversation: (conversationId) => ipcRenderer.invoke("ai-conversation:delete", conversationId),
  /** 清空全部历史对话。 */
  clearAiConversations: () => ipcRenderer.invoke("ai-conversation:clear"),
  /** @param {string} noteId 笔记 ID；@returns {Promise<boolean>} 是否已发起打开。 */
  openNoteLink: (noteId) => ipcRenderer.invoke("note-link:open-local", noteId),
  /** 查询引用了指定笔记的本地笔记列表。 */
  getNoteBacklinks: (noteId) => ipcRenderer.invoke("note:backlinks", noteId),
  /** 查询指定笔记显式引用了的本地笔记列表（出链）。 */
  getNoteOutlinks: (noteId) => ipcRenderer.invoke("note:outlinks", noteId),
  /** 以指定笔记为中心查询局部引用图谱。 @param {string} noteId @param {number} [maxDepth] */
  getNoteGraph: (noteId, maxDepth) => ipcRenderer.invoke("note:graph", noteId, maxDepth),
  /** 查询全库双链关系图谱。 @param {number} [maxNodes] 节点数量上限。 */
  getGlobalGraph: (maxNodes) => ipcRenderer.invoke("note:graph:global", maxNodes),
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
  /** 监听应用退出前的强制保存请求。 */
  onBeforeQuitSave: (callback) => {
    const listener = (_event, requestId) => callback(Number(requestId))
    ipcRenderer.on("app:before-quit-save", listener)
    return () => ipcRenderer.removeListener("app:before-quit-save", listener)
  },
  /** 将退出前保存结果回报给主进程。 */
  completeBeforeQuitSave: (requestId, result) => {
    ipcRenderer.send("app:before-quit-save-result", requestId, result)
  },
  /**
   * 弹出系统文件选择器并读取选中的外部 Markdown 文件。
   *
   * 外部文件标签刻意不入库、不参与同步：文件本身即唯一真相来源。
   *
   * @returns {Promise<{ canceled: true } | { filePath: string, fileName: string, content: string }>}
   */
  pickMarkdownFile: () => ipcRenderer.invoke("local-file:pick"),
  /** 按绝对路径读取外部 Markdown 文件（供拖拽入窗使用）。 */
  readMarkdownFile: (filePath) => ipcRenderer.invoke("local-file:read", filePath),
  /** 将正文写回外部 Markdown 文件。 */
  saveMarkdownFile: (filePath, content) => ipcRenderer.invoke("local-file:save", filePath, content),
  /** 将正文另存为新的 Markdown 文件。 */
  saveMarkdownFileAs: (defaultName, content) => (
    ipcRenderer.invoke("local-file:save-as", defaultName, content)
  ),
  /**
   * 读取系统剪贴板内容（富文本粘贴用）。
   *
   * 渲染层的 `navigator.clipboard.readText()` 只能拿到纯文本，拿不到 `text/html`；
   * 而「粘贴（富文本）」需要 HTML 表示，故走主进程 `clipboard` 模块。
   *
   * @returns {Promise<{ text: string, html: string }>} 纯文本与 HTML（无则空串）。
   */
  readClipboard: () => ipcRenderer.invoke("clipboard:read"),
  /**
   * 读取拖入窗口的文件在磁盘上的绝对路径。
   *
   * Electron 32 起 File.path 被移除，只能在 preload 里通过 webUtils 取路径；
   * 取不到时返回空字符串，调用方应提示改用「打开 Markdown 文件…」。
   *
   * @param {File} file 拖拽事件携带的文件对象。
   * @returns {string} 绝对路径，取不到时为空串。
   */
  getDroppedFilePath: (file) => {
    try {
      return webUtils.getPathForFile(file)
    } catch {
      return ""
    }
  },
  /** 监听菜单栏「打开 Markdown 文件…」。 */
  onOpenLocalFile: (callback) => {
    const listener = () => callback()
    ipcRenderer.on("local-file:open-request", listener)
    return () => ipcRenderer.removeListener("local-file:open-request", listener)
  },
  /** 监听菜单栏「保存」（当前文档为笔记时由渲染层回落到笔记保存）。 */
  onSaveLocalFile: (callback) => {
    const listener = () => callback()
    ipcRenderer.on("local-file:save-request", listener)
    return () => ipcRenderer.removeListener("local-file:save-request", listener)
  },
  /** 监听菜单栏「另存为…」。 */
  onSaveLocalFileAs: (callback) => {
    const listener = () => callback()
    ipcRenderer.on("local-file:save-as-request", listener)
    return () => ipcRenderer.removeListener("local-file:save-as-request", listener)
  },
  saveAttachment: (input) => ipcRenderer.invoke("asset:save-attachment", input),
  openAttachment: (assetId) => ipcRenderer.invoke("asset:open", assetId),
  listAttachmentInventory: () => ipcRenderer.invoke("asset-management:list"),
  revealAttachment: (assetId) => ipcRenderer.invoke("asset-management:reveal", assetId),
  deleteOrphanAttachment: (assetId) => ipcRenderer.invoke("asset-management:delete-orphan", assetId),
  deleteAllOrphanAttachments: (assetIds) => ipcRenderer.invoke("asset-management:delete-all-orphans", assetIds),
  repairAttachmentIntegrity: () => ipcRenderer.invoke("asset-management:repair-integrity"),
  openExternalLink: (url) => ipcRenderer.invoke("external-link:open", url),
  saveImageAsset: (input) => ipcRenderer.invoke("asset:save-image", input),
  /**
   * 复制预览里的图片到系统剪贴板。
   *
   * 走主进程：`file://` 与 `xinyue-asset://` 在渲染层都拿不到可写的 Blob。
   *
   * @param {string} src 图片地址（传 `currentSrc`）。
   * @returns {Promise<{ ok: boolean, message: string }>} 复制结果。
   */
  copyPreviewImage: (src) => ipcRenderer.invoke("image:copy", src),
  /**
   * 把预览里的图片另存为本地文件。
   *
   * @param {string} src 图片地址。
   * @returns {Promise<{ ok: boolean, canceled?: boolean, fileName?: string, message?: string }>} 保存结果。
   */
  savePreviewImageAs: (src) => ipcRenderer.invoke("image:save-as", src),
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
  bulkUpdateNotes: (noteIds, patch) => ipcRenderer.invoke("note:bulk-update", noteIds, patch),
  resolveNoteConflict: (conflictNoteId, strategy) => (
    ipcRenderer.invoke("note-conflict:resolve", conflictNoteId, strategy)
  ),
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
  exportNoteMarkdownClean: (noteId) => ipcRenderer.invoke("data:export-note-markdown-clean", noteId),
  exportAllMarkdown: () => ipcRenderer.invoke("data:export-all-markdown"),
  exportSelectedMarkdown: (noteIds) => ipcRenderer.invoke("data:export-selected-markdown", noteIds),
  exportFullBackup: () => ipcRenderer.invoke("data:export-backup"),
  /** 预览「本机笔记地址转网页地址」将改动的范围（只读）。 */
  previewLocalNoteLinkRewrite: () => ipcRenderer.invoke("data:preview-local-note-link-rewrite"),
  /** 手动把正文里仍使用本机地址的笔记链接改写成网页地址。 */
  rewriteLocalNoteLinks: () => ipcRenderer.invoke("data:rewrite-local-note-links"),
  /** 预览「给嵌入卡片补线上标识」将改动的范围（只读）。 */
  previewEmbedServerIdFill: () => ipcRenderer.invoke("data:preview-embed-server-id-fill"),
  /** 手动给正文里的嵌入卡片补上跨端标识，供网页端渲染成卡片。 */
  fillEmbedServerIds: () => ipcRenderer.invoke("data:fill-embed-server-ids"),
  importMarkdown: (folderId) => ipcRenderer.invoke("data:import-markdown", folderId),
  importSingleMarkdown: (folderId) => ipcRenderer.invoke("data:import-single-markdown", folderId),
  /** 把当前已打开的外部文件导入笔记库（正文由编辑器给出，可能含未保存的改动）。 */
  importMarkdownPath: (filePath, content, folderId) =>
    ipcRenderer.invoke("data:import-markdown-path", filePath, content, folderId),
  importFullBackup: () => ipcRenderer.invoke("data:import-backup"),
  /**
   * 监听菜单栏打开数据管理窗口的请求。
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
  downloadUpdate: (downloadUrl) => ipcRenderer.invoke("app-update:download", downloadUrl),
  openUpdateInstaller: (filePath) => ipcRenderer.invoke("app-update:open-installer", filePath),
  revealUpdateInstaller: (filePath) => ipcRenderer.invoke("app-update:reveal-installer", filePath),
  onUpdateDownloadProgress: (callback) => {
    const listener = (_event, progress) => callback(progress)
    ipcRenderer.on("app-update:download-progress", listener)
    return () => ipcRenderer.removeListener("app-update:download-progress", listener)
  },
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
