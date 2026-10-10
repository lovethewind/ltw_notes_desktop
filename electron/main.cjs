const fs = require("node:fs")
const path = require("node:path")
const { createHash, randomBytes } = require("node:crypto")
const { fileURLToPath, pathToFileURL } = require("node:url")
const Database = require("better-sqlite3")
const {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  globalShortcut,
  ipcMain,
  Menu,
  nativeImage,
  nativeTheme,
  net,
  protocol,
  safeStorage,
  shell
} = require("electron")
const { openNotesDatabase } = require("./database.cjs")
const {
  collectMarkdownDocumentsFromZip,
  createCleanMarkdownDocument,
  createMarkdownDocument,
  createMarkdownZip,
  createPortableBackupArchive,
  extractLocalImageReferences,
  getMimeType,
  parsePortableBackupArchive,
  parseMarkdownDocument,
  sanitizeFileName
} = require("./data-transfer.cjs")
const {
  getProfileDataPath,
  migrateAccountProfile,
  migrateDomainProfile,
  shouldConfirmLocalProfileTransfer
} = require("./profile-storage.cjs")
const {
  checkForUpdates,
  downloadReleaseAsset,
  resolveDownloadFileName
} = require("./app-update.cjs")
const { createAiAssistant } = require("./ai-assistant.cjs")
const {
  createDatabaseBackupManager,
  restoreProfileSnapshot
} = require("./database-backup.cjs")
const {
  createDatabaseBackupStatusTracker
} = require("./database-backup-status.cjs")
const {
  loadBackupSettings,
  saveBackupSettings
} = require("./database-backup-settings.cjs")
const {
  loadQuickCaptureSettings,
  saveQuickCaptureSettings
} = require("./quick-capture-settings.cjs")
const { createSyncResultSummary } = require("./sync-result-summary.cjs")
const { appendSyncHistory, loadSyncHistory } = require("./sync-history.cjs")
const {
  cleanAllOrphanAttachments: executeAttachmentCleanup
} = require("./attachment-cleanup.cjs")
const { classifyAttachmentSource } = require("./attachment-source.cjs")
const { executeAttachmentIntegrityRepair } = require("./attachment-integrity.cjs")
const { createQuitSaveCoordinator } = require("./quit-save-coordinator.cjs")
const { registerIpcHandlers: registerFeatureIpcHandlers } = require("./ipc-handlers.cjs")
const { isE2ERuntime, resolveUserDataPath, shouldShowMainWindow } = require("./runtime-paths.cjs")

const DEFAULT_BACKEND_URL = "https://lovethewind.cn"
const DEFAULT_WEB_URL = "https://lovethewind.cn"
const NOTE_SYNC_INTERVAL_MS = 30_000
const LOCAL_CHANGE_SYNC_DELAY_MS = 3_000
const SYNC_SETTINGS_FILE_NAME = "sync-settings.json"
const DESKTOP_AUTH_PROTOCOL = "xinyue-notes"
const LOCAL_ASSET_PROTOCOL = "xinyue-asset"
const LOCAL_ASSET_DIRECTORY_NAME = "assets"
const MAX_IMAGE_ASSET_BYTES = 20 * 1024 * 1024
const MAX_ATTACHMENT_BYTES = 100 * 1024 * 1024
const IMAGE_EXTENSION_BY_MIME_TYPE = new Map([
  ["image/avif", ".avif"],
  ["image/bmp", ".bmp"],
  ["image/gif", ".gif"],
  ["image/jpeg", ".jpg"],
  ["image/png", ".png"],
  ["image/webp", ".webp"]
])

let repository = null
let backupManager = null
let mainWindow = null
let quickCaptureWindow = null
let quickCaptureSettings = null
let isQuitting = false
let closeMainWindowAfterSave = false
let allowMainWindowClose = false
const quitSaveCoordinator = createQuitSaveCoordinator({
  requestSave: (requestId) => {
    if (!mainWindow || mainWindow.isDestroyed() || mainWindow.webContents.isDestroyed()) {
      throw new Error("主窗口已关闭，无法确认当前笔记已保存")
    }
    mainWindow.webContents.send("app:before-quit-save", requestId)
  },
  quit: () => {
    if (closeMainWindowAfterSave && mainWindow && !mainWindow.isDestroyed()) {
      closeMainWindowAfterSave = false
      allowMainWindowClose = true
      // 红色关窗只销毁主窗口，不退出仍驻留在 macOS Dock 中的应用进程。
      quitSaveCoordinator.dispose()
      mainWindow.close()
      return
    }
    app.quit()
  },
  onFailure: (message) => {
    closeMainWindowAfterSave = false
    if (mainWindow && !mainWindow.isDestroyed()) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.show()
      mainWindow.focus()
    }
    void dialog.showMessageBox(mainWindow ?? undefined, {
      type: "error",
      title: "无法退出心悦笔记",
      message: "当前笔记尚未安全保存",
      detail: message,
      buttons: ["知道了"]
    })
  }
})
const backupStatusTracker = createDatabaseBackupStatusTracker((status) => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("database-backup:status", status)
  }
})
let syncSettings = {
  backendUrl: DEFAULT_BACKEND_URL,
  webUrl: DEFAULT_WEB_URL,
  token: "",
  accountId: "",
  accountLabel: ""
}
let pendingSyncConnection = null
let pendingBrowserAuth = null
let pendingNoteLinkId = ""
let syncInFlight = null
let automaticSyncTimer = null
let pendingMutationSyncTimer = null
let syncAfterCurrent = false
let syncStatus = { state: "idle", message: "仅保存在本机", lastSuccessAt: "", lastResult: null, history: [] }
const attachmentIntegrityIssues = new Map()

/** 注册快速记录全局快捷键，注册失败时恢复旧快捷键。 */
function registerQuickCaptureShortcut(shortcut, previousShortcut = "") {
  if (previousShortcut) globalShortcut.unregister(previousShortcut)
  let registered = false
  try {
    registered = globalShortcut.register(shortcut, () => showQuickCaptureWindow())
  } catch {
    registered = false
  }
  if (!registered && previousShortcut) {
    try {
      globalShortcut.register(previousShortcut, () => showQuickCaptureWindow())
    } catch {
      // 原快捷键仅来自已保存且成功使用过的配置，异常时交由设置界面重新录入。
    }
  }
  return registered
}

/** 显示快速记录窗口，并可直接进入快捷键设置。 */
function showQuickCaptureWindow(openSettings = false) {
  const browserWindow = quickCaptureWindow && !quickCaptureWindow.isDestroyed()
    ? quickCaptureWindow
    : createQuickCaptureWindow()
  if (browserWindow.isMinimized()) browserWindow.restore()
  if (process.platform === "darwin") app.show()
  browserWindow.show()
  browserWindow.focus()
  const channel = openSettings ? "quick-capture:open-settings" : "quick-capture:focus"
  if (browserWindow.webContents.isLoading()) {
    browserWindow.webContents.once("did-finish-load", () => browserWindow.webContents.send(channel))
  } else {
    browserWindow.webContents.send(channel)
  }
}

/**
 * 将用户输入规范化为不带 `/api` 后缀的后端地址。
 *
 * @param {string} rawUrl 用户输入的服务地址。
 * @returns {string} 规范化后的服务地址。
 */
function normalizeBackendUrl(rawUrl) {
  const parsedUrl = new URL(String(rawUrl || "").trim())
  if (!["http:", "https:"].includes(parsedUrl.protocol)) {
    throw new Error("后端地址仅支持 http:// 或 https://")
  }
  parsedUrl.hash = ""
  parsedUrl.search = ""
  if (parsedUrl.hostname.toLowerCase() === "www.lovethewind.cn") {
    parsedUrl.hostname = "lovethewind.cn"
  }
  parsedUrl.pathname = parsedUrl.pathname.replace(/\/+$/, "").replace(/\/api$/i, "") || "/"
  return parsedUrl.toString().replace(/\/$/, "")
}

/**
 * 获取同步设置文件的绝对路径。
 *
 * @returns {string} 设置文件路径。
 */
function getSyncSettingsFilePath() {
  return path.join(app.getPath("userData"), SYNC_SETTINGS_FILE_NAME)
}

/**
 * 获取指定后端域名对应的本地数据档案目录。
 *
 * @param {string} backendUrl 已规范化的后端地址。
 * @param {string} accountId 服务端用户唯一 ID，空字符串表示未登录用户。
 * @returns {string} 域名档案目录。
 */
function getBackendProfilePath(backendUrl, accountId) {
  return getProfileDataPath(app.getPath("userData"), backendUrl, accountId)
}

/**
 * 打开指定后端域名和用户对应的本地数据库。
 *
 * @param {string} backendUrl 已规范化的后端地址。
 * @param {string} accountId 服务端用户唯一 ID，空字符串表示未登录用户。
 * @returns {ReturnType<typeof openNotesDatabase>} 数据库仓储。
 */
function openBackendRepository(backendUrl, accountId) {
  const profilePath = getBackendProfilePath(backendUrl, accountId)
  fs.mkdirSync(profilePath, { recursive: true })
  return openNotesDatabase(profilePath)
}

/**
 * 为当前域名和用户档案创建完整备份管理器。
 *
 * @returns {ReturnType<typeof createDatabaseBackupManager>} 当前档案备份管理器。
 */
function createCurrentBackupManager() {
  const profilePath = getBackendProfilePath(syncSettings.backendUrl, syncSettings.accountId)
  return createDatabaseBackupManager({
    profilePath,
    backupDatabase: (targetPath) => repository.backupTo(targetPath),
    getSettings: () => loadBackupSettings(profilePath)
  })
}

/**
 * 获取当前档案的备份策略。
 *
 * @returns {{ schedule: "daily" | "weekly" | "off", retention: number }} 备份策略。
 */
function getCurrentBackupSettings() {
  return loadBackupSettings(getBackendProfilePath(syncSettings.backendUrl, syncSettings.accountId))
}

/**
 * 保存当前档案的备份策略。
 *
 * @param {Record<string, any>} input 原始策略。
 * @returns {Promise<{ schedule: "daily" | "weekly" | "off", retention: number }>} 已保存策略。
 */
async function saveCurrentBackupSettings(input) {
  const profilePath = getBackendProfilePath(syncSettings.backendUrl, syncSettings.accountId)
  const settings = await saveBackupSettings(profilePath, input)
  backupManager = createCurrentBackupManager()
  if (settings.schedule !== "off") await ensureDailyDatabaseBackup()
  return settings
}

/**
 * 验证 SQLite 备份文件可正常读取且通过快速完整性检查。
 *
 * @param {string} backupPath 待验证的备份文件路径。
 * @returns {void}
 */
function validateDatabaseBackup(backupPath) {
  const database = new Database(backupPath, { readonly: true, fileMustExist: true })
  try {
    if (database.pragma("quick_check", { simple: true }) !== "ok") {
      throw new Error("备份数据库完整性检查失败")
    }
  } finally {
    database.close()
  }
}

/**
 * 为当前档案创建指定原因的完整快照。
 *
 * @param {"daily" | "manual" | "before-import" | "pre-restore"} reason 备份原因。
 * @returns {Promise<Record<string, any>>} 新备份摘要。
 */
async function createCurrentDatabaseBackup(reason) {
  if (!backupManager) backupManager = createCurrentBackupManager()
  try {
    const backup = await backupManager.createBackup(reason)
    backupStatusTracker.recordSuccess(backup)
    return backup
  } catch (error) {
    backupStatusTracker.recordFailure(error, false)
    throw error
  }
}

/**
 * 确保当前档案当天已经创建自动备份。
 *
 * @returns {Promise<Record<string, any>>} 每日备份检查结果。
 */
async function ensureDailyDatabaseBackup() {
  if (!backupManager) backupManager = createCurrentBackupManager()
  try {
    const result = await backupManager.ensureDailyBackup()
    if (result.backup) backupStatusTracker.recordSuccess(result.backup)
    return result
  } catch (error) {
    backupStatusTracker.recordFailure(error, true)
    throw error
  }
}

/**
 * 查询当前档案的完整备份。
 *
 * @returns {Promise<Array<Record<string, any>>>} 按时间倒序排列的备份。
 */
async function listCurrentDatabaseBackups() {
  if (!backupManager) backupManager = createCurrentBackupManager()
  return backupManager.listBackups()
}

/**
 * 在文件管理器中打开当前档案的备份目录。
 *
 * @returns {Promise<boolean>} 成功打开时返回 true。
 */
async function openCurrentBackupDirectory() {
  if (!backupManager) backupManager = createCurrentBackupManager()
  const backupDirectory = backupManager.getBackupDirectory()
  await fs.promises.mkdir(backupDirectory, { recursive: true })
  const errorMessage = await shell.openPath(backupDirectory)
  if (errorMessage) throw new Error(errorMessage)
  return true
}

/**
 * 用指定完整快照恢复当前档案，并在失败时回滚到恢复前快照。
 *
 * @param {string} backupId 目标备份文件 ID。
 * @returns {Promise<Record<string, any>>} 恢复结果。
 */
async function restoreCurrentDatabaseBackup(backupId) {
  if (syncInFlight) await syncInFlight
  if (!backupManager) backupManager = createCurrentBackupManager()
  const currentManager = backupManager
  const sourcePath = await currentManager.resolveBackupPath(backupId)
  const profilePath = getBackendProfilePath(syncSettings.backendUrl, syncSettings.accountId)
  const sourceStats = await fs.promises.stat(sourcePath)
  const stagedSourcePath = path.join(
    profilePath,
    `.selected-${randomBytes(8).toString("hex")}${sourceStats.isDirectory() ? "" : ".sqlite3"}`
  )
  if (sourceStats.isDirectory()) {
    await fs.promises.cp(sourcePath, stagedSourcePath, { recursive: true })
    validateDatabaseBackup(path.join(stagedSourcePath, "notes.sqlite3"))
  } else {
    await fs.promises.copyFile(sourcePath, stagedSourcePath)
    validateDatabaseBackup(stagedSourcePath)
  }
  let safetyBackup
  try {
    safetyBackup = await currentManager.createBackup("pre-restore")
    backupStatusTracker.recordSuccess(safetyBackup)
    const safetyBackupPath = await currentManager.resolveBackupPath(safetyBackup.id)
    if (pendingMutationSyncTimer) clearTimeout(pendingMutationSyncTimer)
    pendingMutationSyncTimer = null
    syncAfterCurrent = false
    await restoreProfileSnapshot({
      sourcePath: stagedSourcePath,
      safetyBackupPath,
      profilePath,
      closeDatabase: () => {
        repository?.close()
        repository = null
      },
      openDatabase: () => {
        repository = openBackendRepository(syncSettings.backendUrl, syncSettings.accountId)
        return repository
      },
      validateDatabase: validateDatabaseBackup
    })
  } finally {
    await fs.promises.rm(stagedSourcePath, { recursive: true, force: true })
  }
  backupManager = createCurrentBackupManager()
  mainWindow?.webContents.send("workspace:changed")
  return {
    restored: true,
    message: "完整备份已恢复",
    safetyBackup
  }
}

/**
 * 从 JWT Token 中读取用户 ID，仅用于兼容旧版设置。
 *
 * @param {string} token 已保存的登录 Token。
 * @returns {string} 用户唯一 ID，无法解析时返回空字符串。
 */
function getAccountIdFromToken(token) {
  try {
    const payload = JSON.parse(Buffer.from(String(token).split(".")[1], "base64url").toString("utf8"))
    return String(payload.user_id || "")
  } catch {
    return ""
  }
}

/**
 * 从用户信息响应中提取稳定的用户唯一 ID。
 *
 * @param {Record<string, any>} userInfo 后端用户信息。
 * @returns {string} 用户唯一 ID。
 */
function getAccountIdFromUserInfo(userInfo) {
  const accountId = String(userInfo?.id ?? userInfo?.uid ?? "")
  if (!accountId) throw new Error("服务未返回用户唯一标识")
  return accountId
}

/**
 * 加密用于同步认证的 Token。
 *
 * @param {string} token 待保存的 Token。
 * @returns {string} 可写入设置文件的密文。
 */
function encryptSyncToken(token) {
  if (!token) return ""
  if (safeStorage.isEncryptionAvailable()) {
    return `safe:${safeStorage.encryptString(token).toString("base64")}`
  }
  return `base64:${Buffer.from(token, "utf8").toString("base64")}`
}

/**
 * 解密设置文件中的同步 Token。
 *
 * @param {string} encryptedToken 已保存的 Token 密文。
 * @returns {string} 解密后的 Token。
 */
function decryptSyncToken(encryptedToken) {
  if (!encryptedToken) return ""
  if (encryptedToken.startsWith("safe:") && safeStorage.isEncryptionAvailable()) {
    return safeStorage.decryptString(Buffer.from(encryptedToken.slice(5), "base64"))
  }
  if (encryptedToken.startsWith("base64:")) {
    return Buffer.from(encryptedToken.slice(7), "base64").toString("utf8")
  }
  return ""
}

/**
 * 从本地文件读取同步设置。
 *
 * @returns {{ backendUrl: string, webUrl: string, token: string, accountId: string, accountLabel: string }} 当前同步设置。
 */
function loadSyncSettings() {
  try {
    const saved = JSON.parse(fs.readFileSync(getSyncSettingsFilePath(), "utf8"))
    const token = decryptSyncToken(String(saved.encryptedToken || ""))
    return {
      backendUrl: normalizeBackendUrl(saved.backendUrl || DEFAULT_BACKEND_URL),
      webUrl: normalizeBackendUrl(saved.webUrl || DEFAULT_WEB_URL),
      token,
      accountId: String(saved.accountId || getAccountIdFromToken(token)),
      accountLabel: String(saved.accountLabel || "")
    }
  } catch (error) {
    if (error && error.code !== "ENOENT") console.warn("读取同步设置失败，已使用默认配置", error)
    return {
      backendUrl: DEFAULT_BACKEND_URL,
      webUrl: DEFAULT_WEB_URL,
      token: "",
      accountId: "",
      accountLabel: ""
    }
  }
}

/**
 * 把同步设置保存到用户数据目录。
 *
 * @param {{ backendUrl: string, webUrl: string, token: string, accountId: string, accountLabel: string }} settings 待保存设置。
 * @returns {Promise<void>} 保存完成后的 Promise。
 */
async function persistSyncSettings(settings) {
  const settingsFilePath = getSyncSettingsFilePath()
  await fs.promises.mkdir(path.dirname(settingsFilePath), { recursive: true })
  await fs.promises.writeFile(settingsFilePath, `${JSON.stringify({
    backendUrl: settings.backendUrl,
    webUrl: settings.webUrl,
    encryptedToken: encryptSyncToken(settings.token),
    accountId: settings.accountId,
    accountLabel: settings.accountLabel
  }, null, 2)}\n`, "utf8")
}

/**
 * 判断当前档案是否包含需要保留的本地内容。
 *
 * @param {ReturnType<typeof openNotesDatabase>} currentRepository 当前数据库仓储。
 * @returns {boolean} 是否存在笔记、文件夹、标签或图片。
 */
function hasRepositoryContent(currentRepository) {
  const workspace = currentRepository.listWorkspace()
  return (
    workspace.notes.length > 0
    || workspace.folders.length > 0
    || workspace.tags.length > 0
    || currentRepository.listImageAssets().length > 0
  )
}

/**
 * 询问登录时如何处理 local 档案中的内容。
 *
 * @param {string} accountLabel 即将登录的账号名称。
 * @returns {Promise<"import" | "keep" | "cancel">} 用户选择的处理方式。
 */
async function promptLocalProfileTransfer(accountLabel) {
  const options = {
    type: "question",
    title: "处理本地笔记",
    message: "检测到未登录状态下保存的本地内容",
    detail: `是否将这些内容导入账号“${accountLabel || "当前账号"}”？导入内容会放在独立文件夹中，不会覆盖账号已有笔记。`,
    buttons: ["导入到当前账号", "保留在本地", "取消登录"],
    defaultId: 0,
    cancelId: 2,
    noLink: true
  }
  const result = mainWindow && !mainWindow.isDestroyed()
    ? await dialog.showMessageBox(mainWindow, options)
    : await dialog.showMessageBox(options)
  return ["import", "keep", "cancel"][result.response] || "cancel"
}

/**
 * 保存同步配置，并在后端域名变化时切换到独立的本地数据库。
 *
 * @param {{ backendUrl: string, webUrl: string, token: string, accountId: string, accountLabel: string }} settings 新同步配置。
 * @returns {Promise<void>} 切换完成后的 Promise。
 */
async function activateSyncProfile(settings) {
  const profileChanged = (
    settings.backendUrl !== syncSettings.backendUrl
    || settings.accountId !== syncSettings.accountId
  )
  if (profileChanged && syncInFlight) await syncInFlight

  const nextProfilePath = getBackendProfilePath(settings.backendUrl, settings.accountId)
  const targetProfileExists = fs.existsSync(path.join(nextProfilePath, "notes.sqlite3"))
  const requiresLocalDecision = shouldConfirmLocalProfileTransfer({
    currentBackendUrl: syncSettings.backendUrl,
    nextBackendUrl: settings.backendUrl,
    currentAccountId: syncSettings.accountId,
    nextAccountId: settings.accountId,
    hasLocalContent: profileChanged && hasRepositoryContent(repository),
    targetProfileExists
  })
  let localBackup = null
  if (requiresLocalDecision) {
    const decision = await promptLocalProfileTransfer(settings.accountLabel)
    if (decision === "cancel") throw new Error("已取消登录切换")
    if (decision === "import") localBackup = await createFullBackupPayload()
  }

  let migratedProfilePath = ""
  if (
    profileChanged
    && settings.backendUrl === syncSettings.backendUrl
    && !syncSettings.accountId
    && settings.accountId
    && migrateAccountProfile(
      app.getPath("userData"),
      settings.backendUrl,
      syncSettings.accountId,
      settings.accountId
    )
  ) {
    migratedProfilePath = getBackendProfilePath(syncSettings.backendUrl, syncSettings.accountId)
  }
  const nextRepository = profileChanged
    ? openBackendRepository(settings.backendUrl, settings.accountId)
    : repository
  if (migratedProfilePath) {
    nextRepository.relocateImageAssetPaths(
      path.join(migratedProfilePath, LOCAL_ASSET_DIRECTORY_NAME),
      path.join(nextProfilePath, LOCAL_ASSET_DIRECTORY_NAME)
    )
  }
  const previousRepository = repository
  const previousSettings = syncSettings
  if (profileChanged) {
    repository = nextRepository
    syncSettings = settings
  }
  try {
    if (localBackup) {
      const restoredBackup = await restoreBackupImageAssets(localBackup)
      nextRepository.importBackup(restoredBackup)
    }
    await persistSyncSettings(settings)
  } catch (error) {
    if (profileChanged) {
      repository = previousRepository
      syncSettings = previousSettings
      nextRepository.close()
    }
    throw error
  }

  syncSettings = settings
  repository = nextRepository
  if (profileChanged) {
    restoreSyncHistory(nextProfilePath, Boolean(settings.token))
    previousRepository?.close()
    backupManager = createCurrentBackupManager()
    backupStatusTracker.reset()
    void ensureDailyDatabaseBackup().catch((error) => {
      console.warn("创建档案每日备份失败", error)
    })
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send("workspace:changed")
    }
  }
}

/**
 * 返回可安全暴露给渲染进程的同步设置。
 *
 * @returns {{ backendUrl: string, webUrl: string, configured: boolean, accountLabel: string }} 同步设置摘要。
 */
function getSyncSettingsView() {
  return {
    backendUrl: syncSettings.backendUrl,
    webUrl: syncSettings.webUrl,
    configured: Boolean(syncSettings.token),
    accountLabel: syncSettings.accountLabel
  }
}

/**
 * 向渲染进程发布同步状态。
 *
 * @param {{ state: string, message: string, lastSuccessAt?: string }} nextStatus 新状态。
 * @returns {void}
 */
function publishSyncStatus(nextStatus) {
  syncStatus = { ...syncStatus, ...nextStatus }
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("sync:status", syncStatus)
  }
}

/** 从当前账号档案恢复最近同步记录。 */
function restoreSyncHistory(profilePath, configured) {
  const history = loadSyncHistory(profilePath)
  const lastResult = history[0] || null
  syncStatus = {
    state: configured && lastResult ? "success" : "idle",
    message: configured && lastResult ? "已恢复最近同步记录" : "仅保存在本机",
    lastSuccessAt: lastResult?.completedAt || "",
    lastResult,
    history
  }
}

/**
 * 将图片文件保存到当前设备的离线资源目录。
 *
 * @param {{ id?: string, fileName?: string, mimeType?: string, data?: ArrayBuffer | Uint8Array }} input 图片数据。
 * @param {boolean} shouldScheduleSync 是否安排云端同步。
 * @returns {Promise<Record<string, any>>} 已保存的图片资源。
 */
async function saveImageAsset(input, shouldScheduleSync = true) {
  const mimeType = String(input?.mimeType || "").toLowerCase()
  const extension = IMAGE_EXTENSION_BY_MIME_TYPE.get(mimeType)
  if (!extension) throw new Error("仅支持 PNG、JPEG、GIF、WebP、AVIF 和 BMP 图片")
  return saveAttachment({ ...input, mimeType, extension }, shouldScheduleSync)
}

/**
 * 将通用附件保存到当前设备的离线资源目录。
 *
 * @param {{ id?: string, fileName?: string, mimeType?: string, extension?: string, data?: ArrayBuffer | Uint8Array }} input 附件数据。
 * @param {boolean} shouldScheduleSync 是否安排云端同步。
 * @returns {Promise<Record<string, any>>} 已保存的附件资源。
 */
async function saveAttachment(input, shouldScheduleSync = true) {
  const mimeType = String(input?.mimeType || "application/octet-stream").toLowerCase()
  const requestedExtension = String(input?.extension || path.extname(String(input?.fileName || ""))).toLowerCase()
  const extension = /^\.[a-z0-9]{1,16}$/.test(requestedExtension) ? requestedExtension : ".bin"
  const data = input?.data
  const buffer = data instanceof ArrayBuffer
    ? Buffer.from(data)
    : ArrayBuffer.isView(data) ? Buffer.from(data.buffer, data.byteOffset, data.byteLength) : null
  if (!buffer?.length) throw new Error("附件内容为空")
  const maximumBytes = mimeType.startsWith("image/") ? MAX_IMAGE_ASSET_BYTES : MAX_ATTACHMENT_BYTES
  if (buffer.length > maximumBytes) {
    throw new Error(mimeType.startsWith("image/") ? "单张图片不能超过 20 MiB" : "单个附件不能超过 100 MiB")
  }

  const sha256 = createHash("sha256").update(buffer).digest("hex")
  const directory = path.join(
    getBackendProfilePath(syncSettings.backendUrl, syncSettings.accountId),
    LOCAL_ASSET_DIRECTORY_NAME,
    sha256.slice(0, 2)
  )
  const localPath = path.join(directory, `${sha256}${extension}`)
  await fs.promises.mkdir(directory, { recursive: true })
  try {
    await fs.promises.writeFile(localPath, buffer, { flag: "wx" })
  } catch (error) {
    if (error?.code !== "EEXIST") throw error
  }
  const asset = repository.createAsset({
    id: input?.id ? String(input.id) : undefined,
    fileName: String(input?.fileName || `附件${extension}`).slice(0, 255),
    mimeType,
    byteSize: buffer.length,
    sha256,
    localPath
  })
  if (shouldScheduleSync) scheduleSync()
  return asset
}

/**
 * 使用系统默认应用打开本地附件。
 *
 * @param {string} assetId 附件资源 ID。
 * @returns {Promise<boolean>} 是否成功发起打开操作。
 */
async function openAttachment(assetId) {
  const asset = repository.getAsset(String(assetId || ""))
  if (!asset?.localPath || !fs.existsSync(asset.localPath)) throw new Error("附件不存在")
  const errorMessage = await shell.openPath(asset.localPath)
  if (errorMessage) throw new Error(errorMessage)
  return true
}

/** 根据 MIME 类型和扩展名返回附件管理分类。 */
function getAttachmentKind(asset) {
  const mimeType = String(asset.mimeType || "").toLowerCase()
  const extension = path.extname(String(asset.fileName || "")).toLowerCase()
  if (mimeType.startsWith("image/")) return "image"
  if (
    mimeType.startsWith("text/")
    || /(?:pdf|json|xml|msword|officedocument|opendocument|rtf)/.test(mimeType)
    || [".md", ".csv", ".tsv", ".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx", ".pdf"].includes(extension)
  ) return "document"
  return "other"
}

/** 返回附带本地文件状态和空间统计的附件管理清单。 */
function listAttachmentInventory() {
  const items = repository.listAttachmentInventory().map((asset) => {
    let localBytes = 0
    let localExists = false
    try {
      const stats = fs.statSync(asset.localPath)
      localExists = stats.isFile()
      if (localExists) localBytes = stats.size
    } catch {
      // 文件缺失会作为可筛选状态返回，不阻断清单加载。
    }
    const source = classifyAttachmentSource(asset, syncSettings)
    const integrityIssue = attachmentIntegrityIssues.get(asset.id) || ""
    return {
      ...asset,
      ...source,
      kind: getAttachmentKind(asset),
      localExists,
      localBytes,
      integrityIssue,
      state: !localExists
        ? "missing"
        : integrityIssue === "corrupt" ? "corrupt" : asset.remoteUrl ? "uploaded" : "pending"
    }
  })
  return {
    items,
    totalCount: items.length,
    localBytes: items.reduce((total, asset) => total + asset.localBytes, 0),
    uploadedCount: items.filter((asset) => asset.state === "uploaded").length,
    pendingCount: items.filter((asset) => asset.state === "pending").length,
    missingCount: items.filter((asset) => asset.state === "missing").length,
    corruptCount: items.filter((asset) => asset.state === "corrupt").length,
    orphanCount: items.filter((asset) => asset.isOrphan).length,
    managedCount: items.filter((asset) => asset.sourceKind === "managed").length,
    externalCacheCount: items.filter((asset) => asset.sourceKind === "external-cache").length
  }
}

/** 下载指定附件的云端原始内容，并执行统一大小限制。 */
async function downloadAttachmentBody(asset, signal) {
  if (!asset.remoteUrl) throw new Error("附件没有云端地址")
  const maximumBytes = String(asset.mimeType || "").startsWith("image/")
    ? MAX_IMAGE_ASSET_BYTES
    : MAX_ATTACHMENT_BYTES
  const response = await net.fetch(asset.remoteUrl, {
    signal,
    bypassCustomProtocolHandlers: true
  })
  if (!response.ok) throw new Error(`云端附件下载失败（HTTP ${response.status}）`)
  const declaredSize = Number(response.headers.get("content-length") || 0)
  if (declaredSize > maximumBytes) throw new Error("云端附件超过大小限制")
  const body = Buffer.from(await response.arrayBuffer())
  if (body.length > maximumBytes) throw new Error("云端附件超过大小限制")
  return body
}

/** 将校验通过的附件原子写回原本地路径。 */
async function replaceLocalAttachment(asset, body) {
  const localPath = String(asset.localPath || "")
  if (!localPath) throw new Error("附件缺少本地存储路径")
  await fs.promises.mkdir(path.dirname(localPath), { recursive: true })
  const temporaryPath = `${localPath}.repair-${randomBytes(8).toString("hex")}`
  try {
    await fs.promises.writeFile(temporaryPath, body, { flag: "wx" })
    await fs.promises.rename(temporaryPath, localPath)
  } catch (error) {
    await fs.promises.rm(temporaryPath, { force: true }).catch(() => {})
    throw error
  }
}

/** 在 Finder 中显示附件文件。 */
async function revealAttachment(assetId) {
  const asset = repository.getAsset(String(assetId || ""))
  if (!asset?.localPath || !fs.existsSync(asset.localPath)) throw new Error("附件文件不存在")
  shell.showItemInFolder(asset.localPath)
  return true
}

/** 清理未被当前笔记或历史版本引用的附件，并将本地文件移入废纸篓。 */
async function deleteOrphanAttachment(assetId) {
  const asset = repository.deleteOrphanAsset(String(assetId || ""))
  if (!asset) throw new Error("附件不存在或已被清理")
  if (!asset.localPath || !fs.existsSync(asset.localPath)) {
    return { assetId: asset.id, removedLocalFile: false }
  }
  try {
    await shell.trashItem(asset.localPath)
    return { assetId: asset.id, removedLocalFile: true }
  } catch (error) {
    const restored = repository.createAsset({
      id: asset.id,
      fileName: asset.fileName,
      mimeType: asset.mimeType,
      byteSize: asset.byteSize,
      sha256: asset.sha256,
      localPath: asset.localPath
    })
    if (asset.remoteUrl) {
      repository.markAssetUploaded(restored.id, asset.remoteUrl, asset.serverSourceId)
    }
    throw error
  }
}

/** 批量清理用户已确认的孤立附件，单项失败不会中断后续附件。 */
async function deleteAllOrphanAttachments(assetIds) {
  const requestedIds = [...new Set(
    (Array.isArray(assetIds) ? assetIds : [])
      .map((assetId) => String(assetId || "").trim())
      .filter(Boolean)
  )]
  const inventory = new Map(
    repository.listAttachmentInventory().map((asset) => [asset.id, asset])
  )
  const candidates = requestedIds.map((assetId) => (
    inventory.get(assetId) || { id: assetId, fileName: "未知附件" }
  ))
  return executeAttachmentCleanup(candidates, deleteOrphanAttachment)
}

/**
 * 使用系统默认浏览器打开经过校验的外部网页链接。
 *
 * @param {string} rawUrl 待打开的网页地址。
 * @returns {Promise<boolean>} 是否成功发起打开操作。
 */
async function openExternalLink(rawUrl) {
  const targetUrl = new URL(String(rawUrl || ""))
  if (!["http:", "https:"].includes(targetUrl.protocol)) throw new Error("仅支持 http 或 https 链接")
  const notePathMatch = targetUrl.pathname.match(/^\/notes\/([^/]+)\/?$/)
  if (targetUrl.origin === new URL(syncSettings.webUrl).origin && notePathMatch) {
    notifyOpenNoteLink(decodeURIComponent(notePathMatch[1]))
    return true
  }
  await shell.openExternal(targetUrl.toString())
  return true
}

/** 附件可移植地址（导出产物里的写法）所用主机名。 */
const PORTABLE_ASSET_HOSTNAME = "xinyue-asset.local"

/**
 * 把预览里回传的图片地址解析成磁盘路径。
 *
 * 预览里的 `<img>` 有四种来源，渲染层一律只回传 `currentSrc`：
 *   1. `xinyue-asset://local/<id>` —— 笔记附件，由主进程的私有协议独家服务；
 *   2. `https://xinyue-asset.local/<id>` —— 附件可移植写法（导出后又被导入的笔记里会有）；
 *   3. `file:///…` / 绝对路径 —— 本地 Markdown 文件里的图片（相对路径已被渲染层归一）；
 *   4. `http(s)://…` —— 网络图片。
 *
 * @param {string} rawSrc 图片地址。
 * @returns {string} 磁盘上的绝对路径。
 */
function resolveImageSourcePath(rawSrc) {
  const source = String(rawSrc || "").trim()
  if (!source) throw new Error("图片地址为空")

  if (source.startsWith(`${LOCAL_ASSET_PROTOCOL}://`) || /^https?:\/\//i.test(source)) {
    const parsedUrl = new URL(source)
    if (source.startsWith(`${LOCAL_ASSET_PROTOCOL}://`) || parsedUrl.hostname === PORTABLE_ASSET_HOSTNAME) {
      const assetId = decodeURIComponent(parsedUrl.pathname.replace(/^\/+/, ""))
      const asset = repository.getAsset(assetId)
      if (!asset?.localPath || !fs.existsSync(asset.localPath)) throw new Error("附件不存在")
      return asset.localPath
    }
    // 网络图片没有本地路径，交给调用方走下载分支。
    return ""
  }

  const filePath = source.startsWith("file:") ? fileURLToPath(source) : source
  if (!path.isAbsolute(filePath) || !fs.existsSync(filePath)) throw new Error("图片文件不存在")
  return filePath
}

/**
 * 读取预览里某张图片的字节，供复制到剪贴板与另存为使用。
 *
 * @param {string} rawSrc 图片地址（渲染层回传的 `currentSrc`）。
 * @returns {Promise<{ buffer: Buffer, fileName: string }>} 图片字节与推荐文件名。
 */
async function readPreviewImageBuffer(rawSrc) {
  const source = String(rawSrc || "").trim()
  const localPath = resolveImageSourcePath(source)
  if (localPath) {
    const stat = await fs.promises.stat(localPath)
    if (!stat.isFile()) throw new Error("图片地址不是一个文件")
    return { buffer: await fs.promises.readFile(localPath), fileName: path.basename(localPath) }
  }
  const response = await net.fetch(source)
  if (!response.ok) throw new Error(`图片下载失败（HTTP ${response.status}）`)
  const buffer = Buffer.from(await response.arrayBuffer())
  // 地址末尾取不到扩展名时用 image.png 兜底，别让「未命名」这种占位名进另存为对话框。
  const remoteName = decodeURIComponent(new URL(source).pathname.split("/").pop() || "")
  return { buffer, fileName: path.extname(remoteName) ? sanitizeFileName(remoteName) : "image.png" }
}

/**
 * 把预览里的图片复制到系统剪贴板。
 *
 * 走主进程而不是渲染层的 `navigator.clipboard`：`file://` 与私有协议都取不到可写的
 * `Blob`，而主进程能直接把字节读成 `nativeImage`。
 *
 * @param {string} rawSrc 图片地址。
 * @returns {Promise<{ ok: boolean, message: string }>} 复制结果，不抛异常（错误信息直接给界面提示）。
 */
async function copyPreviewImage(rawSrc) {
  try {
    const { buffer } = await readPreviewImageBuffer(rawSrc)
    const image = nativeImage.createFromBuffer(buffer)
    if (image.isEmpty()) return { ok: false, message: "该图片格式暂不支持复制到剪贴板" }
    clipboard.writeImage(image)
    return { ok: true, message: "图片已复制" }
  } catch (error) {
    return { ok: false, message: error?.message || "复制图片失败" }
  }
}

/**
 * 把预览里的图片另存为本地文件。
 *
 * @param {string} rawSrc 图片地址。
 * @returns {Promise<{ ok: boolean, canceled?: boolean, fileName?: string, message?: string }>} 保存结果。
 */
async function savePreviewImageAs(rawSrc) {
  try {
    const { buffer, fileName } = await readPreviewImageBuffer(rawSrc)
    const result = await dialog.showSaveDialog(mainWindow, { title: "保存图片", defaultPath: fileName })
    if (result.canceled || !result.filePath) return { ok: true, canceled: true }
    await fs.promises.writeFile(result.filePath, buffer)
    return { ok: true, canceled: false, fileName: path.basename(result.filePath) }
  } catch (error) {
    return { ok: false, message: error?.message || "保存图片失败" }
  }
}

/**
 * 根据响应类型和文件名推断可离线展示的图片类型。
 *
 * @param {string | null} contentType HTTP Content-Type。
 * @param {string} remoteUrl 远程图片地址。
 * @returns {string | null} 支持的图片 MIME 类型。
 */
function inferRemoteImageMimeType(contentType, remoteUrl) {
  const normalizedType = String(contentType || "").split(";", 1)[0].trim().toLowerCase()
  if (IMAGE_EXTENSION_BY_MIME_TYPE.has(normalizedType)) return normalizedType
  const extension = path.extname(new URL(remoteUrl).pathname).toLowerCase()
  const match = [...IMAGE_EXTENSION_BY_MIME_TYPE.entries()]
    .find(([, currentExtension]) => currentExtension === extension)
  return match?.[0] || (extension === ".jpeg" ? "image/jpeg" : null)
}

/**
 * 下载云端笔记图片到当前设备缓存。
 *
 * 单张图片失败不会阻断笔记正文同步，后续同步会继续重试。
 *
 * @param {AbortSignal} signal 请求中止信号。
 * @returns {Promise<number>} 成功缓存的图片数量。
 */
async function cacheRemoteImages(signal) {
  const remoteUrls = repository.listRemoteImageUrlsToCache().slice(0, 20)
  let cachedCount = 0
  for (const remoteUrl of remoteUrls) {
    try {
      const response = await net.fetch(remoteUrl, {
        signal,
        bypassCustomProtocolHandlers: true
      })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const declaredSize = Number(response.headers.get("content-length") || 0)
      if (declaredSize > MAX_IMAGE_ASSET_BYTES) throw new Error("图片超过 20 MiB")
      const mimeType = inferRemoteImageMimeType(response.headers.get("content-type"), remoteUrl)
      if (!mimeType) throw new Error("图片格式不受支持")
      const body = Buffer.from(await response.arrayBuffer())
      if (body.length > MAX_IMAGE_ASSET_BYTES) throw new Error("图片超过 20 MiB")
      const fileName = decodeURIComponent(path.basename(new URL(remoteUrl).pathname)) || "同步图片"
      const asset = await saveImageAsset({ fileName, mimeType, data: body }, false)
      repository.markImageAssetUploaded(asset.id, remoteUrl)
      cachedCount += 1
    } catch (error) {
      console.warn(`缓存笔记图片失败，将在后续同步重试：${remoteUrl}`, error)
    }
  }
  return cachedCount
}

/**
 * 下载云端笔记附件到当前设备缓存。
 *
 * 单个附件失败不会阻断笔记正文同步，后续同步会继续重试。
 *
 * @param {AbortSignal} signal 请求中止信号。
 * @returns {Promise<number>} 成功缓存的附件数量。
 */
async function cacheRemoteAttachments(signal) {
  const references = repository.listRemoteAttachmentReferencesToCache().slice(0, 10)
  let cachedCount = 0
  for (const reference of references) {
    try {
      if (reference.byteSize > MAX_ATTACHMENT_BYTES) throw new Error("附件超过 100 MiB")
      const response = await net.fetch(reference.url, {
        signal,
        bypassCustomProtocolHandlers: true
      })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const declaredSize = Number(response.headers.get("content-length") || 0)
      if (declaredSize > MAX_ATTACHMENT_BYTES) throw new Error("附件超过 100 MiB")
      const body = Buffer.from(await response.arrayBuffer())
      if (body.length > MAX_ATTACHMENT_BYTES) throw new Error("附件超过 100 MiB")
      const asset = await saveAttachment({
        fileName: reference.fileName,
        mimeType: reference.mimeType,
        data: body
      }, false)
      repository.markAssetUploaded(asset.id, reference.url)
      cachedCount += 1
    } catch (error) {
      console.warn(`缓存笔记附件失败，将在后续同步重试：${reference.url}`, error)
    }
  }
  return cachedCount
}

/**
 * 创建包含本地图片文件的完整备份数据。
 *
 * @returns {Promise<Record<string, any>>} 完整备份数据。
 */
async function createFullBackupPayload() {
  const backup = repository.exportBackup()
  backup.assets = await Promise.all((backup.assets || []).map(async (asset) => ({
    id: asset.id,
    fileName: asset.fileName,
    mimeType: asset.mimeType,
    byteSize: asset.byteSize,
    sha256: asset.sha256,
    remoteUrl: asset.remoteUrl,
    serverSourceId: asset.serverSourceId,
    createdAt: asset.createdAt,
    updatedAt: asset.updatedAt,
    dataBase64: (await fs.promises.readFile(asset.localPath)).toString("base64")
  })))
  return backup
}

/**
 * 从完整备份恢复本地图片并修正资源 ID。
 *
 * @param {Record<string, any>} backup 完整备份数据。
 * @returns {Promise<Record<string, any>>} 可导入数据库的备份数据。
 */
async function restoreBackupImageAssets(backup) {
  const restoredBackup = structuredClone(backup)
  const assetIdMap = new Map()
  for (const asset of restoredBackup.assets || []) {
    if (!asset?.data && !asset?.dataBase64) continue
    const body = asset.data
      ? Buffer.from(asset.data)
      : Buffer.from(String(asset.dataBase64), "base64")
    const restored = await saveAttachment({
      id: String(asset.id || ""),
      fileName: String(asset.fileName || "备份图片"),
      mimeType: String(asset.mimeType || ""),
      data: body
    }, false)
    if (asset.remoteUrl) {
      repository.markAssetUploaded(
        restored.id,
        String(asset.remoteUrl),
        asset.serverSourceId ? String(asset.serverSourceId) : null
      )
    }
    assetIdMap.set(String(asset.id), restored.id)
  }
  for (const collectionName of ["notes", "histories"]) {
    for (const item of restoredBackup[collectionName] || []) {
      let content = String(item.content || "")
      for (const [sourceId, targetId] of assetIdMap) {
        content = content
          .split(`${LOCAL_ASSET_PROTOCOL}://local/${sourceId}`)
          .join(`${LOCAL_ASSET_PROTOCOL}://local/${targetId}`)
          .split(`https://xinyue-asset.local/${encodeURIComponent(sourceId)}`)
          .join(`https://xinyue-asset.local/${encodeURIComponent(targetId)}`)
      }
      item.content = content
    }
  }
  return restoredBackup
}

/**
 * 为归档导出读取当前可用的附件原始文件。
 *
 * @param {Record<string, any>} backup 仓储备份数据。
 * @returns {Promise<Map<string, Buffer>>} 附件 ID 到原始内容的映射。
 */
async function readBackupAssetBodies(backup) {
  const bodies = new Map()
  await Promise.all((backup.assets || []).map(async (asset) => {
    if (!asset.localPath) return
    try {
      bodies.set(asset.id, await fs.promises.readFile(asset.localPath))
    } catch (error) {
      if (error?.code !== "ENOENT") throw error
    }
  }))
  return bodies
}

/**
 * 将 Markdown ZIP 中的相对资源保存到附件目录并改写正文引用。
 *
 * @param {Array<Record<string, any>>} documents Markdown 文档。
 * @returns {Promise<Array<Record<string, any>>>} 可写入数据库的文档。
 */
async function restoreMarkdownResources(documents) {
  for (const document of documents) {
    let content = String(document.content || "")
    for (const resource of document.resources || []) {
      const asset = await saveAttachment({
        fileName: resource.fileName,
        mimeType: resource.mimeType,
        data: Buffer.from(resource.data)
      }, false)
      const targetUrl = String(resource.mimeType || "").startsWith("image/")
        ? asset.localUrl
        : `https://xinyue-asset.local/${encodeURIComponent(asset.id)}`
      content = content.split(resource.sourceUrl).join(targetUrl)
    }
    document.content = content
    delete document.resources
  }
  return documents
}

/** 上传单个待同步附件，并在成功后更新本地资源记录。 */
async function uploadPendingAsset(asset, signal) {
  const signatureResponse = await requestBackendJson(
      `${syncSettings.backendUrl}/api/oss/getSignatureUrl`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          web_token: syncSettings.token
        },
        body: JSON.stringify({
          dirType: asset.mimeType.startsWith("image/") ? "image" : "attach",
          fileName: asset.fileName
        }),
        signal
      }
  )
  const signature = signatureResponse.data || {}
  const uploadUrl = String(signature.uploadUrl || signature.upload_url || "")
  const remoteUrl = String(signature.url || "")
  const serverSourceId = signature.sourceId || signature.source_id || null
  if (!uploadUrl || !remoteUrl) throw new Error("附件上传签名不完整")
  const uploadResponse = await net.fetch(uploadUrl, {
    method: "PUT",
    headers: {
      ...(signature.signedHeaders || signature.signed_headers || {}),
      "Content-Type": signature.contentType || signature.content_type || asset.mimeType,
      "Content-Disposition": signature.contentDisposition || signature.content_disposition || "inline",
      "x-oss-forbid-overwrite": "true"
    },
    body: await fs.promises.readFile(asset.localPath),
    signal,
    bypassCustomProtocolHandlers: true
  })
  if (!uploadResponse.ok) {
    throw new Error(`附件上传失败（HTTP ${uploadResponse.status}）`)
  }
  repository.markAssetUploaded(asset.id, remoteUrl, serverSourceId)
}

/** 上传所有尚未同步的本地图片。 */
async function uploadPendingImageAssets(signal) {
  const pendingAssets = repository.listPendingImageAssets()
  for (const asset of pendingAssets) await uploadPendingAsset(asset, signal)
  return pendingAssets.length
}

/** 校验全部附件，并修复可从云端恢复或可重新上传的项目。 */
async function repairAttachmentIntegrity() {
  if (syncInFlight) await syncInFlight
  attachmentIntegrityIssues.clear()
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 5 * 60_000)
  try {
    const result = await executeAttachmentIntegrityRepair(
      repository.listAttachmentInventory(),
      {
        readLocal: async (asset) => {
          try {
            return await fs.promises.readFile(asset.localPath)
          } catch (error) {
            if (error?.code === "ENOENT") return null
            throw error
          }
        },
        download: (asset) => downloadAttachmentBody(asset, controller.signal),
        writeLocal: replaceLocalAttachment,
        upload: async (asset) => {
          if (!syncSettings.token) throw new Error("未连接云端，无法上传本地附件")
          await uploadPendingAsset(asset, controller.signal)
        }
      }
    )
    for (const failure of result.failures) {
      if (["missing", "corrupt"].includes(failure.issue)) {
        attachmentIntegrityIssues.set(failure.assetId, failure.issue)
      }
    }
    return result
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 注册本地图片读取协议。
 *
 * @returns {void}
 */
function registerLocalAssetProtocol() {
  protocol.handle(LOCAL_ASSET_PROTOCOL, (request) => {
    const parsedUrl = new URL(request.url)
    const assetId = decodeURIComponent(parsedUrl.pathname.replace(/^\/+/, ""))
    const asset = parsedUrl.hostname === "local" ? repository.getAsset(assetId) : null
    if (!asset?.localPath || !fs.existsSync(asset.localPath)) {
      return new Response("附件不存在", { status: 404 })
    }
    return net.fetch(pathToFileURL(asset.localPath).toString())
  })
}

/**
 * 将本地待同步变更推送到云端并应用最新快照。
 *
 * @returns {Promise<Record<string, any>>} 同步状态。
 */
async function performSync() {
  if (pendingMutationSyncTimer) {
    clearTimeout(pendingMutationSyncTimer)
    pendingMutationSyncTimer = null
  }
  if (syncInFlight) return syncInFlight
  if (!syncSettings.token) {
    publishSyncStatus({ state: "idle", message: "仅保存在本机" })
    return syncStatus
  }
  syncInFlight = (async () => {
    const startedAt = new Date().toISOString()
    publishSyncStatus({ state: "syncing", message: "正在同步…" })
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 60_000)
    try {
      const uploadedAssetCount = await uploadPendingImageAssets(controller.signal)
      const batch = repository.getSyncBatch()
      const beforeWorkspace = repository.listFullWorkspace()
      const { outboxIds, ...syncPayload } = batch
      const response = await requestBackendJson(`${syncSettings.backendUrl}/api/note-sync/push`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          web_token: syncSettings.token
        },
        body: JSON.stringify(syncPayload),
        signal: controller.signal
      })
      const applied = repository.applySyncResult(response.data || {}, outboxIds)
      await cacheRemoteImages(controller.signal)
      await cacheRemoteAttachments(controller.signal)
      const lastSuccessAt = new Date().toISOString()
      const lastResult = createSyncResultSummary({
        batch,
        beforeWorkspace,
        afterWorkspace: repository.listFullWorkspace(),
        uploadedAssetCount,
        conflictCount: applied.conflictCount,
        startedAt,
        completedAt: lastSuccessAt
      })
      const message = applied.conflictCount
        ? `已同步，保留 ${applied.conflictCount} 个冲突副本`
        : "已同步到云端"
      let history = [lastResult, ...(syncStatus.history || [])].slice(0, 20)
      try {
        history = await appendSyncHistory(
          getBackendProfilePath(syncSettings.backendUrl, syncSettings.accountId),
          lastResult
        )
      } catch (error) {
        console.warn("保存同步历史失败，本次结果仅保留在内存中", error)
      }
      publishSyncStatus({ state: "success", message, lastSuccessAt, lastResult, history })
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send("workspace:changed")
      }
      return syncStatus
    } catch (error) {
      const message = error?.name === "AbortError"
        ? "同步超时，将在联网后重试"
        : error instanceof Error ? error.message : "同步失败，将自动重试"
      publishSyncStatus({ state: "error", message })
      return syncStatus
    } finally {
      clearTimeout(timer)
    }
  })()
  try {
    return await syncInFlight
  } finally {
    syncInFlight = null
    if (syncAfterCurrent) {
      syncAfterCurrent = false
      scheduleSync()
    }
  }
}

/**
 * 将本地变更的云端同步延迟到连续操作结束后执行。
 *
 * @returns {void}
 */
function scheduleSync() {
  if (!syncSettings.token) return
  if (syncInFlight) {
    syncAfterCurrent = true
    return
  }
  if (pendingMutationSyncTimer) clearTimeout(pendingMutationSyncTimer)
  pendingMutationSyncTimer = setTimeout(() => {
    pendingMutationSyncTimer = null
    void performSync()
  }, LOCAL_CHANGE_SYNC_DELAY_MS)
}

/**
 * 立即请求一次同步；若当前正在同步，则在结束后补发。
 *
 * @returns {void}
 */
function requestImmediateSync() {
  if (syncInFlight) {
    syncAfterCurrent = true
    return
  }
  void performSync()
}

/**
 * 执行本地数据变更，并在成功后安排防抖同步。
 *
 * @template T
 * @param {() => T} mutation 本地数据变更。
 * @returns {T} 数据变更结果。
 */
function applyLocalMutation(mutation) {
  const result = mutation()
  if (result) scheduleSync()
  return result
}

/**
 * 将时间数字补齐为两位。
 *
 * @param {number} value 时间数字。
 * @returns {string} 两位时间文本。
 */
function padTimePart(value) {
  return String(value).padStart(2, "0")
}

/**
 * 返回适合备份文件名的本地时间戳。
 *
 * @returns {string} 紧凑时间戳。
 */
function getExportTimestamp() {
  const now = new Date()
  return [
    now.getFullYear(),
    padTimePart(now.getMonth() + 1),
    padTimePart(now.getDate()),
    "-",
    padTimePart(now.getHours()),
    padTimePart(now.getMinutes()),
    padTimePart(now.getSeconds())
  ].join("")
}

/**
 * 导出当前笔记为 Markdown 文件。
 *
 * @param {string} noteId 笔记 ID。
 * @returns {Promise<Record<string, any>>} 导出结果。
 */
async function exportNoteMarkdown(noteId) {
  const note = repository.getNoteForEditing(noteId)
  if (!note) throw new Error("当前笔记不存在")
  const result = await dialog.showSaveDialog(mainWindow, {
    title: "导出当前笔记",
    defaultPath: `${sanitizeFileName(note.title)}.md`,
    filters: [{ name: "Markdown", extensions: ["md"] }]
  })
  if (result.canceled || !result.filePath) return { canceled: true }
  const portableNote = { ...note, content: repository.expandAssetReferences(note.content) }
  await fs.promises.writeFile(result.filePath, createMarkdownDocument(portableNote), "utf8")
  const unresolvedCount = repository.listAssets().filter((asset) => (
    !asset.remoteUrl
    && [asset.localUrl, `https://xinyue-asset.local/${encodeURIComponent(asset.id)}`]
      .some((reference) => portableNote.content.includes(reference))
  )).length
  return {
    canceled: false,
    message: unresolvedCount
      ? `当前笔记已导出；${unresolvedCount} 个未上传附件仍使用本应用本地地址`
      : "当前笔记已导出，资源保留原始地址",
    filePath: result.filePath
  }
}

/**
 * 解析一张嵌入卡片指向的笔记，供纯净导出写成「带网页链接的一行引用」。
 *
 * @param {string} embeddedId 被嵌入的笔记 ID。
 * @returns {{ title: string, url: string } | null} 标题与网页地址；目标不存在时返回 null。
 */
function resolveEmbeddedNote(embeddedId) {
  const target = repository.getNote(embeddedId)
  if (!target) return null
  const base = String(syncSettings.webUrl || "").replace(/\/+$/, "")
  // 没同步到云端的笔记没有 serverId，写不出可访问的地址，退回纯文本引用。
  return {
    title: target.title,
    url: target.serverId && base ? `${base}/notes/${target.serverId}` : ""
  }
}

/**
 * 导出当前笔记为「纯净」Markdown —— 给其他软件看的那一份。
 *
 * 与 `exportNoteMarkdown` 的分工：那个保留 front matter、正文原样落盘，用于以后导回本应用；
 * 这个把嵌入卡片、行内字号、保真硬换行降级成通用写法，并且不写元数据。
 *
 * @param {string} noteId 笔记 ID。
 * @returns {Promise<Record<string, any>>} 导出结果。
 */
async function exportNoteMarkdownClean(noteId) {
  const note = repository.getNoteForEditing(noteId)
  if (!note) throw new Error("当前笔记不存在")
  const result = await dialog.showSaveDialog(mainWindow, {
    title: "导出为纯净 Markdown",
    defaultPath: `${sanitizeFileName(note.title)}.md`,
    filters: [{ name: "Markdown", extensions: ["md"] }]
  })
  if (result.canceled || !result.filePath) return { canceled: true }
  const portableNote = { ...note, content: repository.expandAssetReferences(note.content) }
  await fs.promises.writeFile(
    result.filePath,
    createCleanMarkdownDocument(portableNote, { resolveEmbed: resolveEmbeddedNote }),
    "utf8"
  )
  return {
    canceled: false,
    message: "已导出为纯净 Markdown，可直接用其他软件打开",
    filePath: result.filePath
  }
}

/**
 * 将全部未删除笔记按文件夹层级导出为 Markdown ZIP。
 *
 * @returns {Promise<Record<string, any>>} 导出结果。
 */
async function exportAllMarkdown() {
  const result = await dialog.showSaveDialog(mainWindow, {
    title: "导出全部笔记",
    defaultPath: `心悦笔记-Markdown-${getExportTimestamp()}.zip`,
    filters: [{ name: "ZIP 压缩包", extensions: ["zip"] }]
  })
  if (result.canceled || !result.filePath) return { canceled: true }
  const backup = repository.exportBackup()
  const assetBodies = await readBackupAssetBodies(backup)
  backup.assets = (backup.assets || []).map((asset) => ({
    ...asset,
    data: assetBodies.get(asset.id)
  }))
  await fs.promises.writeFile(result.filePath, createMarkdownZip(backup))
  const noteCount = backup.notes.filter((note) => !note.isDeleted).length
  return {
    canceled: false,
    message: `已导出 ${noteCount} 篇 Markdown 笔记`,
    filePath: result.filePath
  }
}

/** 将用户选中的未删除笔记导出为 Markdown ZIP。 */
async function exportSelectedMarkdown(noteIds) {
  const selectedIds = new Set(Array.isArray(noteIds) ? noteIds.filter((id) => typeof id === "string" && id) : [])
  if (!selectedIds.size) throw new Error("请先选择要导出的笔记")
  const backup = repository.exportBackup()
  backup.notes = backup.notes.filter((note) => selectedIds.has(note.id) && !note.isDeleted)
  if (!backup.notes.length) throw new Error("所选内容中没有可导出的笔记")
  const result = await dialog.showSaveDialog(mainWindow, {
    title: "导出所选笔记",
    defaultPath: `心悦笔记-所选${backup.notes.length}篇-${getExportTimestamp()}.zip`,
    filters: [{ name: "ZIP 压缩包", extensions: ["zip"] }]
  })
  if (result.canceled || !result.filePath) return { canceled: true }
  const assetBodies = await readBackupAssetBodies(backup)
  backup.assets = (backup.assets || []).map((asset) => ({ ...asset, data: assetBodies.get(asset.id) }))
  await fs.promises.writeFile(result.filePath, createMarkdownZip(backup))
  return {
    canceled: false,
    message: `已导出 ${backup.notes.length} 篇 Markdown 笔记`,
    filePath: result.filePath
  }
}

/**
 * 导出包含历史版本和原始附件的完整 .xynotes 备份。
 *
 * @returns {Promise<Record<string, any>>} 导出结果。
 */
async function exportFullBackup() {
  const result = await dialog.showSaveDialog(mainWindow, {
    title: "创建完整备份",
    defaultPath: `心悦笔记-完整备份-${getExportTimestamp()}.xynotes`,
    filters: [{ name: "心悦笔记备份", extensions: ["xynotes"] }]
  })
  if (result.canceled || !result.filePath) return { canceled: true }
  const backup = repository.exportBackup()
  const assetBodies = await readBackupAssetBodies(backup)
  await fs.promises.writeFile(result.filePath, createPortableBackupArchive(backup, assetBodies))
  return {
    canceled: false,
    message: `完整备份已创建，包含 ${backup.notes.length} 篇笔记`,
    filePath: result.filePath
  }
}

/**
 * 递归读取目录内的 Markdown 文档。
 *
 * @param {string} rootPath 来源根目录。
 * @param {string} currentPath 当前扫描目录。
 * @returns {Promise<Array<{ title: string, content: string, tagNames: string[], folderPath: string[] }>>} Markdown 文档列表。
 */
async function collectMarkdownDocuments(rootPath, currentPath = rootPath) {
  const documents = []
  const entries = await fs.promises.readdir(currentPath, { withFileTypes: true })
  entries.sort((left, right) => left.name.localeCompare(right.name, "zh-CN"))
  for (const entry of entries) {
    const entryPath = path.join(currentPath, entry.name)
    if (entry.isDirectory()) {
      documents.push(...await collectMarkdownDocuments(rootPath, entryPath))
      continue
    }
    if (!entry.isFile() || ![".md", ".markdown"].includes(path.extname(entry.name).toLowerCase())) {
      continue
    }
    const content = await fs.promises.readFile(entryPath, "utf8")
    const relativeDirectory = path.relative(rootPath, path.dirname(entryPath))
    documents.push({
      ...parseMarkdownDocument(content, path.basename(entryPath, path.extname(entryPath))),
      folderPath: relativeDirectory && relativeDirectory !== "."
        ? relativeDirectory.split(path.sep)
        : []
    })
  }
  return documents
}

/**
 * 读取单个 Markdown 文件，并收集它引用的本地图片资源。
 *
 * 与文件夹导入的差别：单文件导入**不建来源文件夹**（一篇笔记而已，多套一层目录很啰嗦），
 * 但**图片要一并搬进来** —— 这是它相对「复制粘贴正文」的主要价值：粘贴只带文字，
 * 图片会全部断链。资源与正文同目录或在其子目录时才算命中。
 *
 * @param {string} filePath 选中的 Markdown 文件绝对路径。
 * @param {string | null} [contentOverride] 正文覆盖值（「把已打开的文件导入到笔记」时用，
 *        此时正文来自编辑器（可能含未保存的改动），不能再从磁盘读；图片仍按文件所在目录找）。
 * @returns {Promise<{ document: Record<string, any>, resourceCount: number }>} 文档与资源数量。
 */
async function collectSingleMarkdownDocument(filePath, contentOverride) {
  const content = typeof contentOverride === "string"
    ? contentOverride
    : await fs.promises.readFile(filePath, "utf8")
  const rootDirectory = path.dirname(filePath)
  const document = {
    ...parseMarkdownDocument(content, path.basename(filePath, path.extname(filePath))),
    folderPath: []
  }

  // 只认正文里真正出现过的相对路径引用，避免把同目录无关文件一并打包。
  const referenced = extractLocalImageReferences(document.content)
  if (!referenced.length) return { document, resourceCount: 0 }

  const resources = []
  for (const relativePath of referenced) {
    const absolutePath = path.resolve(rootDirectory, relativePath)
    // 防目录穿越：只允许读取所选文件所在目录（含子目录）内的资源。
    if (!absolutePath.startsWith(rootDirectory + path.sep)) continue
    try {
      const stats = await fs.promises.stat(absolutePath)
      if (!stats.isFile()) continue
      resources.push({
        fileName: path.basename(absolutePath),
        mimeType: getMimeType(absolutePath),
        sourceUrl: relativePath,
        data: await fs.promises.readFile(absolutePath)
      })
    } catch (error) {
      if (error?.code !== "ENOENT") throw error
    }
  }
  if (resources.length) document.resources = resources
  return { document, resourceCount: resources.length }
}

/**
 * 选择单个 Markdown 文件并导入指定文件夹。
 *
 * @param {string | null} folderId 目标文件夹 ID。
 * @returns {Promise<Record<string, any>>} 导入结果。
 */
async function importSingleMarkdownFile(folderId) {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: "导入 Markdown 文件",
    properties: ["openFile"],
    filters: [{ name: "Markdown 文件", extensions: ["md", "markdown"] }]
  })
  if (result.canceled || !result.filePaths[0]) return { canceled: true }
  const filePath = result.filePaths[0]
  const { document, resourceCount } = await collectSingleMarkdownDocument(filePath)
  if (!String(document.content || "").trim()) throw new Error("所选文件没有可导入的内容")
  await restoreMarkdownResources([document])
  const imported = applyLocalMutation(() => repository.importMarkdownDocuments(
    [document],
    folderId,
    ""
  ))
  mainWindow?.webContents.send("workspace:changed")
  const resourceSuffix = resourceCount ? `，${resourceCount} 个图片资源` : ""
  return {
    canceled: false,
    message: `已导入“${document.title}”${resourceSuffix}`,
    ...imported
  }
}

/**
 * 把「当前已打开的外部文件」导入笔记库。
 *
 * 与 importSingleMarkdownFile 的区别只有一处：不弹系统文件选择框 —— 文件已经开着，
 * 用户要的是「把手上这份存进笔记库」，再让他去磁盘里找一遍是多余的。
 * 正文取编辑器传过来的当前值（未保存的改动也算），图片仍按文件所在目录收集。
 *
 * @param {string} filePath 文件在磁盘上的绝对路径。
 * @param {string | null} folderId 目标文件夹 ID。
 * @param {string} [content] 编辑器里的当前正文。
 * @returns {Promise<Record<string, any>>} 导入结果。
 */
async function importMarkdownFromPath(filePath, folderId, content) {
  if (!filePath || !isMarkdownLikePath(filePath)) throw new Error("请先打开一个 Markdown 文件")
  const { document, resourceCount } = await collectSingleMarkdownDocument(filePath, content)
  if (!String(document.content || "").trim()) throw new Error("当前文件没有可导入的内容")
  await restoreMarkdownResources([document])
  const imported = applyLocalMutation(() => repository.importMarkdownDocuments(
    [document],
    folderId,
    ""
  ))
  mainWindow?.webContents.send("workspace:changed")
  const resourceSuffix = resourceCount ? `，${resourceCount} 个图片资源` : ""
  return {
    canceled: false,
    message: `已导入“${document.title}”${resourceSuffix}`,
    ...imported
  }
}

/**
 * 选择 Markdown 文件夹或 ZIP 压缩包并导入指定文件夹。
 *
 * @param {string | null} folderId 目标文件夹 ID。
 * @returns {Promise<Record<string, any>>} 导入结果。
 */
async function importMarkdownFiles(folderId) {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: "选择 Markdown 文件夹或 ZIP 压缩包",
    properties: ["openFile", "openDirectory", "createDirectory"],
    filters: [{ name: "Markdown ZIP 压缩包", extensions: ["zip"] }]
  })
  if (result.canceled || !result.filePaths[0]) return { canceled: true }
  const sourcePath = result.filePaths[0]
  const sourceStats = await fs.promises.stat(sourcePath)
  const isZipSource = sourceStats.isFile() && path.extname(sourcePath).toLowerCase() === ".zip"
  if (sourceStats.isFile() && !isZipSource) throw new Error("请选择 ZIP 压缩包或 Markdown 文件夹")
  const documents = isZipSource
    ? collectMarkdownDocumentsFromZip(await fs.promises.readFile(sourcePath))
    : await collectMarkdownDocuments(sourcePath)
  if (!documents.length) throw new Error("所选内容中没有 Markdown 文件")
  await restoreMarkdownResources(documents)
  const sourceFolderName = isZipSource ? "" : path.basename(sourcePath)
  const sourceLabel = path.basename(sourcePath) || `Markdown 导入 ${getExportTimestamp()}`
  const imported = applyLocalMutation(() => repository.importMarkdownDocuments(
    documents,
    folderId,
    sourceFolderName
  ))
  mainWindow?.webContents.send("workspace:changed")
  return {
    canceled: false,
    message: `已从“${sourceLabel}”导入 ${imported.importedNotes} 篇 Markdown 笔记`,
    ...imported
  }
}

/**
 * 选择完整备份文件并作为独立副本导入。
 *
 * @returns {Promise<Record<string, any>>} 导入结果。
 */
async function importFullBackup() {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: "导入完整备份",
    properties: ["openFile"],
    filters: [{ name: "心悦笔记备份", extensions: ["xynotes"] }]
  })
  if (result.canceled || !result.filePaths[0]) return { canceled: true }
  const content = await fs.promises.readFile(result.filePaths[0])
  const backup = parsePortableBackupArchive(content)
  const restoredBackup = await restoreBackupImageAssets(backup)
  await createCurrentDatabaseBackup("before-import")
  const imported = applyLocalMutation(() => repository.importBackup(restoredBackup))
  mainWindow?.webContents.send("workspace:changed")
  return {
    canceled: false,
    message: `已导入 ${imported.importedNotes} 篇笔记和 ${imported.importedHistories} 条历史版本`,
    ...imported
  }
}

/**
 * 外部 Markdown 文件的大小上限。超过后不再读取，避免误开超大文件拖垮编辑器。
 */
const EXTERNAL_MARKDOWN_MAX_BYTES = 8 * 1024 * 1024

/**
 * 判断路径是否属于可编辑的纯文本/Markdown 文件。
 *
 * 读写外部文件时都要求命中该白名单：渲染层虽然受 contextIsolation 保护，
 * 但主进程仍不应接受任意路径的读写请求。
 *
 * @param {string} filePath 待判断的路径。
 * @returns {boolean} 扩展名属于 md/markdown/mdown/txt/text 时返回 true。
 */
function isMarkdownLikePath(filePath) {
  return /\.(md|markdown|mdown|txt|text)$/i.test(String(filePath || ""))
}

/**
 * 读取外部 Markdown 文件。
 *
 * 该链路刻意不入库、不参与同步：文件本身即唯一真相来源，应用只做「打开—编辑—写回」。
 *
 * @param {string} filePath 目标文件绝对路径。
 * @returns {Promise<Record<string, any>>} 文件路径、名称与正文。
 */
async function readLocalMarkdownFile(filePath) {
  const targetPath = String(filePath || "")
  if (!targetPath) throw new Error("缺少文件路径")
  if (!isMarkdownLikePath(targetPath)) throw new Error("只支持打开 Markdown 或纯文本文件")
  const stat = await fs.promises.stat(targetPath)
  if (!stat.isFile()) throw new Error("目标不是文件")
  if (stat.size > EXTERNAL_MARKDOWN_MAX_BYTES) {
    throw new Error(`文件超过 ${Math.round(EXTERNAL_MARKDOWN_MAX_BYTES / 1024 / 1024)} MB，暂不支持打开`)
  }
  const raw = await fs.promises.readFile(targetPath, "utf8")
  return {
    filePath: targetPath,
    fileName: path.basename(targetPath),
    // 去掉 UTF-8 BOM：它会在正文首行留下不可见字符，写回时还会被重复带上。
    content: raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw,
    modifiedAt: stat.mtime.toISOString()
  }
}

/**
 * 弹出系统文件选择器并读取用户选中的 Markdown 文件。
 *
 * @returns {Promise<Record<string, any>>} 文件信息；用户取消时返回 { canceled: true }。
 */
async function pickLocalMarkdownFile() {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: "打开 Markdown 文件",
    properties: ["openFile"],
    filters: [{ name: "Markdown", extensions: ["md", "markdown", "mdown", "txt", "text"] }]
  })
  if (result.canceled || !result.filePaths[0]) return { canceled: true }
  return readLocalMarkdownFile(result.filePaths[0])
}

/**
 * 将正文写回外部 Markdown 文件。
 *
 * @param {string} filePath 目标文件绝对路径。
 * @param {string} content 最新正文。
 * @returns {Promise<Record<string, any>>} 写入结果。
 */
async function saveLocalMarkdownFile(filePath, content) {
  const targetPath = String(filePath || "")
  if (!targetPath) throw new Error("缺少文件路径")
  if (!isMarkdownLikePath(targetPath)) throw new Error("只支持写回 Markdown 或纯文本文件")
  await fs.promises.writeFile(targetPath, String(content ?? ""), "utf8")
  const stat = await fs.promises.stat(targetPath)
  return {
    canceled: false,
    filePath: targetPath,
    fileName: path.basename(targetPath),
    modifiedAt: stat.mtime.toISOString()
  }
}

/**
 * 将正文另存为新的 Markdown 文件，并把后续保存指向新路径。
 *
 * @param {string} defaultName 默认文件名（通常沿用原文件名）。
 * @param {string} content 待写入正文。
 * @returns {Promise<Record<string, any>>} 写入结果；用户取消时返回 { canceled: true }。
 */
async function saveLocalMarkdownFileAs(defaultName, content) {
  const suggested = path.basename(String(defaultName || "").trim() || "未命名.md")
  const result = await dialog.showSaveDialog(mainWindow, {
    title: "另存为 Markdown 文件",
    defaultPath: isMarkdownLikePath(suggested) ? suggested : `${suggested}.md`,
    filters: [{ name: "Markdown", extensions: ["md"] }]
  })
  if (result.canceled || !result.filePath) return { canceled: true }
  return saveLocalMarkdownFile(result.filePath, content)
}

/**
 * 请求后端 JSON 接口并校验统一响应码。
 *
 * @param {string} url 接口地址。
 * @param {RequestInit} options 请求配置。
 * @returns {Promise<Record<string, any>>} 统一响应体。
 */
async function requestBackendJson(url, options) {
  const response = await net.fetch(url, {
    ...options,
    bypassCustomProtocolHandlers: true
  })
  const text = await response.text()
  let body
  try {
    body = text ? JSON.parse(text) : {}
  } catch {
    throw new Error(`服务返回了无法识别的数据（HTTP ${response.status}）`)
  }
  if (!response.ok) throw new Error(body.message || `服务返回 HTTP ${response.status}`)
  if (Number(body.code) !== 200) throw new Error(body.message || `服务返回业务码 ${body.code}`)
  return body
}

/**
 * 使用账号密码或已保存 Token 测试同步服务连接。
 *
 * @param {{ backendUrl: string, username?: string, password?: string }} input 连接测试参数。
 * @returns {Promise<{ ok: boolean, message: string, backendUrl?: string, accountLabel?: string }>} 测试结果。
 */
async function testSyncConnection(input) {
  pendingSyncConnection = null
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 8000)
  try {
    const backendUrl = normalizeBackendUrl(input.backendUrl)
    const username = String(input.username || "").trim()
    const password = String(input.password || "")
    let token = ""
    if (username || password) {
      if (!username || !password) throw new Error("请输入完整的账号和密码")
      const loginResponse = await requestBackendJson(`${backendUrl}/api/user/common/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password }),
        signal: controller.signal
      })
      token = String(loginResponse.data?.token || "")
      if (!token) throw new Error("登录成功但服务未返回 Token")
    } else if (backendUrl === syncSettings.backendUrl && syncSettings.token) {
      token = syncSettings.token
    } else {
      throw new Error("首次连接或更换后端地址时需要填写账号和密码")
    }
    const infoResponse = await requestBackendJson(`${backendUrl}/api/user/info`, {
      method: "GET",
      headers: { web_token: token },
      signal: controller.signal
    })
    const accountLabel = String(
      infoResponse.data?.nickname
      || infoResponse.data?.username
      || username
      || "已登录账号"
    )
    const accountId = getAccountIdFromUserInfo(infoResponse.data)
    pendingSyncConnection = { backendUrl, token, accountId, accountLabel }
    return { ok: true, message: "连接与身份验证成功", backendUrl, accountLabel }
  } catch (error) {
    const message = error?.name === "AbortError"
      ? "连接超时，请检查后端地址和网络"
      : error instanceof Error ? error.message : "连接失败"
    return { ok: false, message }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 保存已通过连接测试的同步设置。
 *
 * @param {{ backendUrl: string, webUrl: string }} input 待保存的设置。
 * @returns {Promise<{ backendUrl: string, webUrl: string, configured: boolean, accountLabel: string }>} 设置摘要。
 */
async function saveSyncSettings(input) {
  const backendUrl = normalizeBackendUrl(input.backendUrl)
  const webUrl = normalizeBackendUrl(input.webUrl || DEFAULT_WEB_URL)
  const candidate = pendingSyncConnection?.backendUrl === backendUrl
    ? pendingSyncConnection
    : syncSettings.backendUrl === backendUrl && syncSettings.token ? syncSettings : null
  if (!candidate) throw new Error("请先完成连接测试")
  const nextSettings = {
    backendUrl,
    webUrl,
    token: candidate.token,
    accountId: candidate.accountId,
    accountLabel: candidate.accountLabel
  }
  await activateSyncProfile(nextSettings)
  pendingSyncConnection = null
  void performSync()
  return getSyncSettingsView()
}

/**
 * 清除已保存的同步账号。
 *
 * @returns {Promise<{ backendUrl: string, webUrl: string, configured: boolean, accountLabel: string }>} 设置摘要。
 */
async function clearSyncSettings() {
  const nextSettings = {
    backendUrl: syncSettings.backendUrl,
    webUrl: syncSettings.webUrl,
    token: "",
    accountId: syncSettings.accountId,
    accountLabel: syncSettings.accountLabel
  }
  pendingSyncConnection = null
  await activateSyncProfile(nextSettings)
  publishSyncStatus({ state: "idle", message: "仅保存在本机", lastSuccessAt: "", lastResult: null, history: [] })
  return getSyncSettingsView()
}

/**
 * 打开网页登录页并创建仅保存在内存中的随机授权状态。
 *
 * @param {{ backendUrl: string, webUrl: string }} input 浏览器登录参数。
 * @returns {Promise<{ ok: boolean, message: string, backendUrl?: string }>} 启动结果。
 */
async function startBrowserSyncLogin(input) {
  try {
    const backendUrl = normalizeBackendUrl(input.backendUrl)
    const webUrl = normalizeBackendUrl(input.webUrl || DEFAULT_WEB_URL)
    const state = randomBytes(32).toString("base64url")
    pendingBrowserAuth = {
      backendUrl,
      webUrl,
      state,
      expiresAt: Date.now() + 5 * 60 * 1000
    }
    pendingSyncConnection = null
    const loginUrl = new URL("/notes", `${webUrl}/`)
    loginUrl.searchParams.set("desktop_login", "1")
    loginUrl.searchParams.set("state", state)
    await shell.openExternal(loginUrl.toString())
    return {
      ok: true,
      message: "已打开浏览器，请完成登录或微信扫码授权",
      backendUrl
    }
  } catch (error) {
    pendingBrowserAuth = null
    return {
      ok: false,
      message: error instanceof Error ? error.message : "无法打开浏览器登录"
    }
  }
}

/**
 * 取消当前等待中的浏览器登录授权。
 *
 * @returns {{ ok: boolean, message: string }} 取消结果。
 */
function cancelBrowserSyncLogin() {
  pendingBrowserAuth = null
  return { ok: true, message: "已取消浏览器授权" }
}

/**
 * 将浏览器授权结果发送给渲染进程并激活应用窗口。
 *
 * @param {{ ok: boolean, message: string }} result 授权结果。
 * @returns {void}
 */
function notifyBrowserAuthResult(result) {
  if (!mainWindow || mainWindow.isDestroyed()) return
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.show()
  mainWindow.focus()
  mainWindow.webContents.send("sync-auth:result", result)
}

/**
 * 校验深链接状态、兑换一次性授权码并保存同步账号。
 *
 * @param {string} rawUrl 浏览器回跳链接。
 * @returns {Promise<void>} 授权处理完成后的 Promise。
 */
async function handleBrowserAuthCallback(rawUrl) {
  let callbackUrl
  try {
    callbackUrl = new URL(rawUrl)
  } catch {
    notifyBrowserAuthResult({ ok: false, message: "浏览器返回的授权地址无效" })
    return
  }
  if (
    callbackUrl.protocol !== `${DESKTOP_AUTH_PROTOCOL}:`
    || callbackUrl.hostname !== "auth"
    || callbackUrl.pathname !== "/callback"
  ) return

  const code = callbackUrl.searchParams.get("code") || ""
  const state = callbackUrl.searchParams.get("state") || ""
  const pending = pendingBrowserAuth
  pendingBrowserAuth = null
  if (
    !pending
    || pending.expiresAt < Date.now()
    || state !== pending.state
    || !/^[A-Za-z0-9_-]{32,128}$/.test(code)
  ) {
    notifyBrowserAuthResult({ ok: false, message: "浏览器登录已失效，请重新发起授权" })
    return
  }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 8000)
  try {
    const exchangeResponse = await requestBackendJson(
      `${pending.backendUrl}/api/user/common/desktop/exchange`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ state, code }),
        signal: controller.signal
      }
    )
    const token = String(exchangeResponse.data?.token || "")
    if (!token) throw new Error("授权成功但服务未返回 Token")
    const infoResponse = await requestBackendJson(`${pending.backendUrl}/api/user/info`, {
      method: "GET",
      headers: { web_token: token },
      signal: controller.signal
    })
    const accountLabel = String(
      infoResponse.data?.nickname
      || infoResponse.data?.username
      || "已登录账号"
    )
    const accountId = getAccountIdFromUserInfo(infoResponse.data)
    await activateSyncProfile({
      backendUrl: pending.backendUrl,
      webUrl: pending.webUrl,
      token,
      accountId,
      accountLabel
    })
    notifyBrowserAuthResult({ ok: true, message: `已登录：${accountLabel}` })
    void performSync()
  } catch (error) {
    const message = error?.name === "AbortError"
      ? "授权兑换超时，请检查网络后重试"
      : error instanceof Error ? error.message : "浏览器授权失败"
    notifyBrowserAuthResult({ ok: false, message })
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 激活应用窗口并通知渲染进程打开指定笔记。
 *
 * @param {string} noteId 笔记 ID。
 * @returns {void}
 */
function notifyOpenNoteLink(noteId) {
  if (!mainWindow || mainWindow.isDestroyed()) {
    pendingNoteLinkId = noteId
    return
  }
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.show()
  mainWindow.focus()
  mainWindow.webContents.send("note-link:open", noteId)
}

/**
 * 分流应用深链接，笔记链接直接打开笔记，其余链接继续交给登录回调。
 *
 * @param {string} rawUrl 待处理的应用深链接。
 * @returns {Promise<void>} 深链接处理完成后的 Promise。
 */
async function handleAppDeepLink(rawUrl) {
  let callbackUrl
  try {
    callbackUrl = new URL(rawUrl)
  } catch {
    return
  }
  if (
    callbackUrl.protocol === `${DESKTOP_AUTH_PROTOCOL}:`
    && callbackUrl.hostname === "note"
  ) {
    const noteId = decodeURIComponent(callbackUrl.pathname.slice(1)).trim()
    if (noteId) notifyOpenNoteLink(noteId)
    return
  }
  await handleBrowserAuthCallback(rawUrl)
}

/**
 * 注册离线数据库 IPC 接口。
 *
 * @returns {void}
 */
function registerIpcHandlers() {
  const aiAssistant = createAiAssistant({
    settingsPath: path.join(app.getPath("userData"), "ai-settings.json"),
    encryptSecret: encryptSyncToken,
    decryptSecret: decryptSyncToken,
    repository,
    request: (url, options) => net.fetch(url, {
      ...options,
      bypassCustomProtocolHandlers: true
    })
  })
  registerFeatureIpcHandlers(ipcMain, {
    application: {
      completeQuitSave: (requestId, result) => quitSaveCoordinator.complete(requestId, result),
      setTheme: (theme) => {
        nativeTheme.themeSource = ["light", "dark"].includes(theme) ? theme : "system"
        return nativeTheme.shouldUseDarkColors
      },
      checkForUpdates: () => checkForUpdates({
        currentVersion: app.getVersion(),
        architecture: process.arch,
        request: (url, options) => net.fetch(url, options)
      }),
      openUpdateDownload: (downloadUrl) => {
        const parsedUrl = new URL(String(downloadUrl || ""))
        if (!["github.com", "objects.githubusercontent.com"].includes(parsedUrl.hostname)) {
          throw new Error("更新下载地址不受信任")
        }
        return shell.openExternal(parsedUrl.toString())
      },
      downloadUpdate: (downloadUrl) => {
        const parsedUrl = new URL(String(downloadUrl || ""))
        if (
          !["github.com", "objects.githubusercontent.com", "githubusercontent.com"]
            .includes(parsedUrl.hostname)
        ) {
          throw new Error("更新下载地址不受信任")
        }
        const savePath = path.join(
          app.getPath("downloads"),
          resolveDownloadFileName(parsedUrl.toString(), {
            fallbackName: `xinyue-notes-macos-${app.getVersion()}-${process.arch}.dmg`
          })
        )
        // 下载字节较大，限频推送进度，避免高频 IPC 挤占渲染进程。
        let lastReportedBytes = 0
        return downloadReleaseAsset({
          downloadUrl: parsedUrl.toString(),
          request: (url, options) => net.fetch(url, {
            ...options,
            bypassCustomProtocolHandlers: true
          }),
          savePath,
          onProgress: (progress) => {
            const reachedEnd = progress.total > 0 && progress.received >= progress.total
            const enoughDelta = progress.received - lastReportedBytes >= 512 * 1024
            if (!reachedEnd && !enoughDelta && lastReportedBytes > 0) return
            lastReportedBytes = progress.received
            if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.webContents.isDestroyed()) {
              mainWindow.webContents.send("app-update:download-progress", {
                received: progress.received,
                total: progress.total
              })
            }
          }
        })
      },
      openUpdateInstaller: (filePath) => {
        const safePath = String(filePath || "")
        if (!/\.dmg$/i.test(safePath) || !fs.existsSync(safePath)) {
          throw new Error("安装包路径无效")
        }
        return shell.openPath(safePath)
      },
      revealUpdateInstaller: (filePath) => {
        const safePath = String(filePath || "")
        if (!/\.dmg$/i.test(safePath) || !fs.existsSync(safePath)) {
          throw new Error("安装包路径无效")
        }
        shell.showItemInFolder(safePath)
        return true
      }
    },
    aiAssistant,
    workspace: {
      listWorkspace: () => repository.listWorkspace(),
      getSession: () => repository.getWorkspaceSession(),
      saveSession: (input) => repository.saveWorkspaceSession(input),
      saveViewState: (noteId, scrollTop) => repository.saveNoteViewState(noteId, scrollTop),
      getNote: (noteId) => repository.getNoteForEditing(noteId),
      searchNotes: (keyword, options) => repository.searchNotes(keyword, options),
      getBacklinks: (noteId) => repository.getBacklinks(noteId),
      getOutlinks: (noteId) => repository.getNoteOutlinks(noteId),
      getNoteGraph: (noteId, maxDepth) => repository.getNoteGraph(noteId, maxDepth),
      getGlobalGraph: (maxNodes) => repository.getGlobalGraph(maxNodes),
      openNoteLink: (noteId) => {
        const normalizedNoteId = String(noteId || "").trim()
        if (normalizedNoteId) notifyOpenNoteLink(normalizedNoteId)
        return Boolean(normalizedNoteId)
      },
      consumePendingNoteLink: () => {
        const noteId = pendingNoteLinkId
        pendingNoteLinkId = ""
        return noteId
      }
    },
    attachments: {
      saveAttachment,
      openAttachment,
      listInventory: listAttachmentInventory,
      revealAttachment,
      deleteOrphan: deleteOrphanAttachment,
      deleteAllOrphans: deleteAllOrphanAttachments,
      repairIntegrity: repairAttachmentIntegrity,
      openExternalLink,
      saveImage: saveImageAsset,
      copyPreviewImage,
      savePreviewImageAs
    },
    notes: {
      create: (folderId) => applyLocalMutation(() => repository.createNote(folderId)),
      duplicate: (noteId, targetFolderId, title) => (
        applyLocalMutation(() => repository.duplicateNote(noteId, targetFolderId, title))
      ),
      update: (noteId, patch) => applyLocalMutation(() => repository.updateNote(noteId, patch)),
      bulkUpdate: (noteIds, patch) => (
        applyLocalMutation(() => repository.bulkUpdateNotes(noteIds, patch))
      ),
      resolveConflict: (conflictNoteId, strategy) => (
        applyLocalMutation(() => repository.resolveNoteConflict(conflictNoteId, strategy))
      ),
      listHistory: (noteId) => repository.listNoteHistory(noteId),
      getHistory: (noteId, historyId) => repository.getNoteHistory(noteId, historyId),
      restoreHistory: (noteId, historyId) => {
        const restored = repository.restoreNoteHistory(noteId, historyId)
        if (restored) requestImmediateSync()
        return restored
      },
      deleteHistory: (noteId, historyId) => {
        const deleted = repository.deleteNoteHistory(noteId, historyId)
        if (deleted) requestImmediateSync()
        return deleted
      },
      setDeleted: (noteId, deleted) => (
        applyLocalMutation(() => repository.setNoteDeleted(noteId, deleted))
      ),
      deletePermanently: (noteId) => (
        applyLocalMutation(() => repository.deleteNotePermanently(noteId))
      ),
      emptyTrash: () => applyLocalMutation(() => repository.emptyTrash())
    },
    foldersAndTags: {
      createFolder: (name, parentId) => (
        applyLocalMutation(() => repository.createFolder(name, parentId))
      ),
      renameFolder: (folderId, name) => (
        applyLocalMutation(() => repository.renameFolder(folderId, name))
      ),
      moveFolder: (folderId, parentId, beforeFolderId) => (
        applyLocalMutation(() => repository.moveFolder(folderId, parentId, beforeFolderId))
      ),
      deleteFolder: (folderId) => (
        applyLocalMutation(() => repository.setFolderDeleted(folderId))
      ),
      restoreFolder: (folderId) => (
        applyLocalMutation(() => repository.restoreFolder(folderId))
      ),
      deleteFolderPermanently: (folderId) => (
        applyLocalMutation(() => repository.deleteFolderPermanently(folderId))
      ),
      createTag: (name) => applyLocalMutation(() => repository.createTag(name)),
      deleteTag: (tagId) => applyLocalMutation(() => repository.deleteTag(tagId))
    },
    quickCapture: {
      open: () => {
        showQuickCaptureWindow()
        return true
      },
      hide: () => {
        quickCaptureWindow?.hide()
        if (process.platform === "darwin") app.hide()
        return true
      },
      getSettings: () => ({ ...quickCaptureSettings }),
      saveSettings: async (input) => {
        const previous = quickCaptureSettings
        const requestedShortcut = String(input?.shortcut || "").trim()
        if (!requestedShortcut) throw new Error("请先录入快捷键")
        if (!registerQuickCaptureShortcut(requestedShortcut, previous.shortcut)) {
          throw new Error("快捷键已被系统或其他应用占用，请换一个组合")
        }
        try {
          quickCaptureSettings = await saveQuickCaptureSettings(app.getPath("userData"), {
            shortcut: requestedShortcut,
            folderId: input?.folderId
          })
          return { ...quickCaptureSettings }
        } catch (error) {
          globalShortcut.unregister(requestedShortcut)
          registerQuickCaptureShortcut(previous.shortcut)
          throw error
        }
      },
      create: async (input) => {
        const note = applyLocalMutation(() => repository.createQuickNote(input))
        quickCaptureSettings = await saveQuickCaptureSettings(app.getPath("userData"), {
          ...quickCaptureSettings,
          folderId: note.folderId
        })
        mainWindow?.webContents.send("workspace:changed")
        return note
      }
    },
    localFiles: {
      pick: pickLocalMarkdownFile,
      read: (filePath) => readLocalMarkdownFile(filePath),
      save: (filePath, content) => saveLocalMarkdownFile(filePath, content),
      saveAs: (defaultName, content) => saveLocalMarkdownFileAs(defaultName, content),
      /**
       * 读取系统剪贴板：渲染层 `navigator.clipboard.readText()` 拿不到 `text/html`，
       * 而「粘贴（富文本）」需要 HTML 表示，故由主进程 clipboard 模块提供。
       */
      readClipboard: () => {
        const formats = clipboard.availableFormats().map((f) => String(f).toLowerCase())
        return {
          text: clipboard.readText(),
          html: formats.some((f) => f.startsWith("text/html")) ? clipboard.readHTML() : ""
        }
      }
    },
    dataTransfer: {
      exportNote: exportNoteMarkdown,
      exportNoteClean: exportNoteMarkdownClean,
      exportAll: exportAllMarkdown,
      exportSelected: exportSelectedMarkdown,
      exportBackup: exportFullBackup,
      importMarkdown: importMarkdownFiles,
      importSingleMarkdown: importSingleMarkdownFile,
      importMarkdownPath: importMarkdownFromPath,
      importBackup: importFullBackup
    },
    backups: {
      list: listCurrentDatabaseBackups,
      getStatus: () => backupStatusTracker.getStatus(),
      getSettings: getCurrentBackupSettings,
      saveSettings: saveCurrentBackupSettings,
      create: () => createCurrentDatabaseBackup("manual"),
      restore: restoreCurrentDatabaseBackup,
      openDirectory: openCurrentBackupDirectory
    },
    sync: {
      getSettings: getSyncSettingsView,
      getStatus: () => syncStatus,
      run: performSync,
      testConnection: testSyncConnection,
      startAuth: startBrowserSyncLogin,
      cancelAuth: cancelBrowserSyncLogin,
      saveSettings: saveSyncSettings,
      clearSettings: clearSyncSettings
    }
  })
}

/**
 * 安装符合 macOS 习惯的应用菜单。
 *
 * @returns {void}
 */
function installMenu() {
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    {
      label: app.name,
      submenu: [
        { label: "关于 心悦笔记", role: "about" },
        { type: "separator" },
        {
          label: "快速记录…",
          click: () => showQuickCaptureWindow()
        },
        {
          label: "通用设置…",
          accelerator: "CmdOrCtrl+,",
          click: () => mainWindow?.webContents.send("general-settings:open")
        },
        {
          label: "导入导出…",
          click: () => mainWindow?.webContents.send("data-transfer:open")
        },
        { type: "separator" },
        {
          label: "同步设置…",
          click: () => mainWindow?.webContents.send("sync-settings:open")
        },
        {
          label: "检查更新…",
          click: () => mainWindow?.webContents.send("app-update:check-request", false)
        },
        { type: "separator" },
        { label: "隐藏心悦笔记", role: "hide" },
        { label: "隐藏其他应用", role: "hideOthers" },
        { label: "全部显示", role: "unhide" },
        { type: "separator" },
        { label: "退出心悦笔记", role: "quit" }
      ]
    },
    {
      label: "文件",
      submenu: [
        {
          // 刻意不用 CmdOrCtrl+O：「快速打开」的默认快捷键就是它，且由渲染层抢先消费。
          label: "打开 Markdown 文件…",
          accelerator: "CmdOrCtrl+Shift+O",
          click: () => mainWindow?.webContents.send("local-file:open-request")
        },
        { type: "separator" },
        {
          label: "保存",
          accelerator: "CmdOrCtrl+S",
          click: () => mainWindow?.webContents.send("local-file:save-request")
        },
        {
          label: "另存为…",
          accelerator: "CmdOrCtrl+Shift+S",
          click: () => mainWindow?.webContents.send("local-file:save-as-request")
        }
      ]
    },
    {
      label: "编辑",
      submenu: [
        { label: "撤销", role: "undo" },
        { label: "重做", role: "redo" },
        { type: "separator" },
        { label: "剪切", role: "cut" },
        { label: "复制", role: "copy" },
        { label: "粘贴", role: "paste" },
        { label: "全选", role: "selectAll" }
      ]
    },
    {
      label: "搜索",
      submenu: [
        {
          label: "搜索全部笔记…",
          accelerator: "CmdOrCtrl+K",
          click: () => mainWindow?.webContents.send("search:open", "workspace")
        },
        {
          label: "快速打开…",
          click: () => mainWindow?.webContents.send("search:open", "quick-open")
        },
        { type: "separator" },
        {
          label: "在当前笔记中查找",
          accelerator: "CmdOrCtrl+F",
          click: () => mainWindow?.webContents.send("search:open", "current-note")
        }
      ]
    },
    {
      label: "显示",
      submenu: [
        { label: "重新加载", role: "reload" },
        { type: "separator" },
        { label: "实际大小", role: "resetZoom" },
        { label: "放大", role: "zoomIn" },
        { label: "缩小", role: "zoomOut" },
        { type: "separator" },
        { label: "进入全屏", role: "togglefullscreen" }
      ]
    },
    {
      label: "窗口",
      submenu: [
        { label: "最小化", role: "minimize" },
        { label: "缩放", role: "zoom" },
        { label: "前置全部窗口", role: "front" }
      ]
    },
    {
      label: "开发者",
      submenu: [
        {
          label: "打开开发者工具",
          accelerator: "CmdOrCtrl+Alt+I",
          click: () => openDevToolsForCurrentTarget()
        },
        { type: "separator" },
        {
          label: "重新加载主窗口",
          click: () => reloadCurrentTarget()
        }
      ]
    }
  ]))
}

/**
 * 打开当前活跃窗口（主窗口或快速记录窗口）的开发者工具，
 * 便于诊断渲染层报错。若没有可用的窗口则忽略。
 *
 * @returns {void}
 */
function openDevToolsForCurrentTarget() {
  const candidate = (BrowserWindow.getFocusedWindow() || mainWindow)
  if (candidate && !candidate.isDestroyed() && !candidate.webContents.isDestroyed()) {
    candidate.webContents.openDevTools({ mode: "detach" })
    return
  }
  if (quickCaptureWindow && !quickCaptureWindow.isDestroyed()
      && !quickCaptureWindow.webContents.isDestroyed()) {
    quickCaptureWindow.webContents.openDevTools({ mode: "detach" })
  }
}

/**
 * 重新加载当前活跃窗口（主窗口优先），用于菜单调试入口。
 *
 * @returns {void}
 */
function reloadCurrentTarget() {
  const candidate = (BrowserWindow.getFocusedWindow() || mainWindow)
  if (candidate && !candidate.isDestroyed() && !candidate.webContents.isDestroyed()) {
    candidate.webContents.reload()
  }
}

/**
 * 创建离线笔记主窗口。
 *
 * @returns {BrowserWindow} 主窗口。
 */
function createWindow() {
  allowMainWindowClose = false
  const browserWindow = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 980,
    minHeight: 660,
    show: false,
    title: "心悦笔记",
    backgroundColor: "#0b1424",
    titleBarStyle: "hiddenInset",
    trafficLightPosition: { x: 18, y: 18 },
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: true
    }
  })

  // 自动化测试默认保持后台隐藏，避免窗口闪现和抢占用户焦点。
  browserWindow.once("ready-to-show", () => {
    if (shouldShowMainWindow(process.env)) browserWindow.show()
  })
  browserWindow.webContents.once("did-finish-load", () => {
    if (app.isPackaged) {
      setTimeout(() => {
        if (!browserWindow.isDestroyed() && !browserWindow.webContents.isDestroyed()) {
          browserWindow.webContents.send("app-update:check-request", true)
        }
      }, 3000)
    }
  })
  browserWindow.on("close", (event) => {
    if (isQuitting || allowMainWindowClose) return
    closeMainWindowAfterSave = true
    // macOS 红色关窗也必须等待渲染器把草稿和标签会话写入 SQLite。
    quitSaveCoordinator.requestQuit(event)
  })
  browserWindow.on("closed", () => {
    closeMainWindowAfterSave = false
    allowMainWindowClose = false
    mainWindow = null
  })
  browserWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url)
    return { action: "deny" }
  })
  browserWindow.webContents.on("will-navigate", (event, url) => {
    let targetUrl
    try {
      targetUrl = new URL(url)
    } catch {
      event.preventDefault()
      return
    }
    if (targetUrl.protocol === `${LOCAL_ASSET_PROTOCOL}:`) {
      event.preventDefault()
      return
    }
    if (!["http:", "https:"].includes(targetUrl.protocol)) return
    event.preventDefault()
    if (targetUrl.hostname !== "xinyue-note.local") {
      void shell.openExternal(targetUrl.toString())
    }
  })

  const devServerUrl = process.env.VITE_DEV_SERVER_URL
  if (devServerUrl) {
    void browserWindow.loadURL(devServerUrl)
  } else {
    void browserWindow.loadFile(path.join(__dirname, "../dist/index.html"))
  }
  mainWindow = browserWindow
  return browserWindow
}

/** 创建轻量快速记录窗口。 */
function createQuickCaptureWindow() {
  const browserWindow = new BrowserWindow({
    width: 620,
    height: 500,
    minWidth: 520,
    minHeight: 420,
    show: false,
    resizable: true,
    title: "快速记录",
    backgroundColor: "#f7faff",
    titleBarStyle: "hiddenInset",
    trafficLightPosition: { x: 16, y: 16 },
    alwaysOnTop: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: true
    }
  })
  browserWindow.on("close", (event) => {
    if (isQuitting) return
    event.preventDefault()
    browserWindow.hide()
  })
  browserWindow.on("closed", () => {
    quickCaptureWindow = null
  })
  browserWindow.webContents.on("before-input-event", (event, input) => {
    if (input.type !== "keyDown" || input.key !== "Escape") return
    event.preventDefault()
    browserWindow.webContents.send("quick-capture:escape")
  })
  const devServerUrl = process.env.VITE_DEV_SERVER_URL
  if (devServerUrl) void browserWindow.loadURL(`${devServerUrl}/quick-capture.html`)
  else void browserWindow.loadFile(path.join(__dirname, "../dist/quick-capture.html"))
  quickCaptureWindow = browserWindow
  return browserWindow
}

const e2eRuntime = isE2ERuntime(process.env)
const currentUserDataPath = resolveUserDataPath(app.getPath("appData"), process.env)
app.setPath("userData", currentUserDataPath)
app.setName("心悦笔记")
// E2E 只验证应用内行为，不注册系统协议或全局快捷键，避免污染开发机设置。
if (!e2eRuntime) app.setAsDefaultProtocolClient(DESKTOP_AUTH_PROTOCOL)
protocol.registerSchemesAsPrivileged([{
  scheme: LOCAL_ASSET_PROTOCOL,
  privileges: {
    standard: true,
    secure: true,
    supportFetchAPI: true,
    corsEnabled: true
  }
}])

app.on("open-url", (event, url) => {
  event.preventDefault()
  void handleAppDeepLink(url)
})

app.whenReady().then(() => {
  syncSettings = loadSyncSettings()
  quickCaptureSettings = loadQuickCaptureSettings(app.getPath("userData"))
  migrateDomainProfile(currentUserDataPath, syncSettings.backendUrl, syncSettings.accountId)
  const profilePath = getBackendProfilePath(syncSettings.backendUrl, syncSettings.accountId)
  const domainProfilePath = path.dirname(profilePath)
  repository = openBackendRepository(syncSettings.backendUrl, syncSettings.accountId)
  restoreSyncHistory(profilePath, Boolean(syncSettings.token))
  backupManager = createCurrentBackupManager()
  repository.relocateImageAssetPaths(
    path.join(domainProfilePath, LOCAL_ASSET_DIRECTORY_NAME),
    path.join(profilePath, LOCAL_ASSET_DIRECTORY_NAME)
  )
  registerLocalAssetProtocol()
  registerIpcHandlers()
  installMenu()
  createWindow()
  if (!e2eRuntime && !registerQuickCaptureShortcut(quickCaptureSettings.shortcut)) {
    console.warn(`快速记录快捷键注册失败: ${quickCaptureSettings.shortcut}`)
  }
  if (!e2eRuntime) {
    setTimeout(() => {
      void ensureDailyDatabaseBackup().catch((error) => {
        console.warn("创建每日数据库备份失败", error)
      })
    }, 1000)
  }
  if (syncSettings.token) {
    setTimeout(() => void performSync(), 1500)
  }
  automaticSyncTimer = setInterval(() => {
    if (syncSettings.token) void performSync()
  }, NOTE_SYNC_INTERVAL_MS)
  app.on("activate", () => {
    if (!mainWindow || mainWindow.isDestroyed()) createWindow()
  })
})

app.on("before-quit", (event) => {
  closeMainWindowAfterSave = false
  const canRequestRendererSave = mainWindow
    && !mainWindow.isDestroyed()
    && !mainWindow.webContents.isDestroyed()
  if (canRequestRendererSave && !quitSaveCoordinator.requestQuit(event)) return
  isQuitting = true
  globalShortcut.unregisterAll()
  if (automaticSyncTimer) clearInterval(automaticSyncTimer)
  automaticSyncTimer = null
  if (pendingMutationSyncTimer) clearTimeout(pendingMutationSyncTimer)
  pendingMutationSyncTimer = null
  repository?.close()
  repository = null
  backupManager = null
  quitSaveCoordinator.dispose()
})

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit()
})
