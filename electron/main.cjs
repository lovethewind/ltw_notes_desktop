const fs = require("node:fs")
const path = require("node:path")
const { createHash, randomBytes } = require("node:crypto")
const { pathToFileURL } = require("node:url")
const {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  nativeTheme,
  net,
  protocol,
  safeStorage,
  shell
} = require("electron")
const { openNotesDatabase } = require("./database.cjs")
const {
  createMarkdownDocument,
  createMarkdownZip,
  parseMarkdownDocument,
  sanitizeFileName
} = require("./data-transfer.cjs")
const {
  getProfileDataPath,
  migrateAccountProfile,
  migrateDomainProfile,
  shouldConfirmLocalProfileTransfer
} = require("./profile-storage.cjs")

const DEFAULT_BACKEND_URL = "https://lovethewind.cn"
const NOTE_SYNC_INTERVAL_MS = 30_000
const LOCAL_CHANGE_SYNC_DELAY_MS = 3_000
const SYNC_SETTINGS_FILE_NAME = "sync-settings.json"
const DESKTOP_AUTH_PROTOCOL = "xinyue-notes"
const LOCAL_ASSET_PROTOCOL = "xinyue-asset"
const LOCAL_ASSET_DIRECTORY_NAME = "assets"
const MAX_IMAGE_ASSET_BYTES = 20 * 1024 * 1024
const IMAGE_EXTENSION_BY_MIME_TYPE = new Map([
  ["image/avif", ".avif"],
  ["image/bmp", ".bmp"],
  ["image/gif", ".gif"],
  ["image/jpeg", ".jpg"],
  ["image/png", ".png"],
  ["image/webp", ".webp"]
])

let repository = null
let mainWindow = null
let syncSettings = { backendUrl: DEFAULT_BACKEND_URL, token: "", accountId: "", accountLabel: "" }
let pendingSyncConnection = null
let pendingBrowserAuth = null
let syncInFlight = null
let automaticSyncTimer = null
let pendingMutationSyncTimer = null
let syncAfterCurrent = false
let syncStatus = { state: "idle", message: "仅保存在本机", lastSuccessAt: "" }

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
 * @returns {{ backendUrl: string, token: string, accountId: string, accountLabel: string }} 当前同步设置。
 */
function loadSyncSettings() {
  try {
    const saved = JSON.parse(fs.readFileSync(getSyncSettingsFilePath(), "utf8"))
    const token = decryptSyncToken(String(saved.encryptedToken || ""))
    return {
      backendUrl: normalizeBackendUrl(saved.backendUrl || DEFAULT_BACKEND_URL),
      token,
      accountId: String(saved.accountId || getAccountIdFromToken(token)),
      accountLabel: String(saved.accountLabel || "")
    }
  } catch (error) {
    if (error && error.code !== "ENOENT") console.warn("读取同步设置失败，已使用默认配置", error)
    return { backendUrl: DEFAULT_BACKEND_URL, token: "", accountId: "", accountLabel: "" }
  }
}

/**
 * 把同步设置保存到用户数据目录。
 *
 * @param {{ backendUrl: string, token: string, accountId: string, accountLabel: string }} settings 待保存设置。
 * @returns {Promise<void>} 保存完成后的 Promise。
 */
async function persistSyncSettings(settings) {
  const settingsFilePath = getSyncSettingsFilePath()
  await fs.promises.mkdir(path.dirname(settingsFilePath), { recursive: true })
  await fs.promises.writeFile(settingsFilePath, `${JSON.stringify({
    backendUrl: settings.backendUrl,
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
 * @param {{ backendUrl: string, token: string, accountId: string, accountLabel: string }} settings 新同步配置。
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
    previousRepository?.close()
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send("workspace:changed")
    }
  }
}

/**
 * 返回可安全暴露给渲染进程的同步设置。
 *
 * @returns {{ backendUrl: string, configured: boolean, accountLabel: string }} 同步设置摘要。
 */
function getSyncSettingsView() {
  return {
    backendUrl: syncSettings.backendUrl,
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
  const data = input?.data
  const buffer = data instanceof ArrayBuffer
    ? Buffer.from(data)
    : ArrayBuffer.isView(data) ? Buffer.from(data.buffer, data.byteOffset, data.byteLength) : null
  if (!buffer?.length) throw new Error("图片内容为空")
  if (buffer.length > MAX_IMAGE_ASSET_BYTES) throw new Error("单张图片不能超过 20 MiB")

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
  const asset = repository.createImageAsset({
    id: input?.id ? String(input.id) : undefined,
    fileName: String(input?.fileName || `图片${extension}`).slice(0, 255),
    mimeType,
    byteSize: buffer.length,
    sha256,
    localPath
  })
  if (shouldScheduleSync) scheduleSync()
  return asset
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
 * 将 Markdown 中的本地图片地址转换为可携带的数据地址。
 *
 * @param {unknown} content Markdown 正文。
 * @returns {Promise<string>} 可独立导出的 Markdown 正文。
 */
async function embedLocalImageData(content) {
  let markdown = String(content || "")
  for (const asset of repository.listImageAssets()) {
    if (!markdown.includes(asset.localUrl)) continue
    const body = await fs.promises.readFile(asset.localPath)
    const dataUrl = `data:${asset.mimeType};base64,${body.toString("base64")}`
    markdown = markdown.split(asset.localUrl).join(dataUrl)
  }
  return markdown
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
    if (!asset?.dataBase64) continue
    const body = Buffer.from(String(asset.dataBase64), "base64")
    const restored = await saveImageAsset({
      id: String(asset.id || ""),
      fileName: String(asset.fileName || "备份图片"),
      mimeType: String(asset.mimeType || ""),
      data: body
    }, false)
    if (asset.remoteUrl) {
      repository.markImageAssetUploaded(
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
      }
      item.content = content
    }
  }
  return restoredBackup
}

/**
 * 上传所有尚未同步的本地图片。
 *
 * @param {AbortSignal} signal 请求中止信号。
 * @returns {Promise<number>} 成功上传的图片数量。
 */
async function uploadPendingImageAssets(signal) {
  const pendingAssets = repository.listPendingImageAssets()
  for (const asset of pendingAssets) {
    const signatureResponse = await requestBackendJson(
      `${syncSettings.backendUrl}/api/oss/getSignatureUrl`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          web_token: syncSettings.token
        },
        body: JSON.stringify({
          dirType: "image",
          fileName: asset.fileName
        }),
        signal
      }
    )
    const signature = signatureResponse.data || {}
    const uploadUrl = String(signature.uploadUrl || signature.upload_url || "")
    const remoteUrl = String(signature.url || "")
    const serverSourceId = signature.sourceId || signature.source_id || null
    if (!uploadUrl || !remoteUrl) throw new Error("图片上传签名不完整")
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
      throw new Error(`图片上传失败（HTTP ${uploadResponse.status}）`)
    }
    repository.markImageAssetUploaded(asset.id, remoteUrl, serverSourceId)
  }
  return pendingAssets.length
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
    const asset = parsedUrl.hostname === "local" ? repository.getImageAsset(assetId) : null
    if (!asset?.localPath || !fs.existsSync(asset.localPath)) {
      return new Response("图片不存在", { status: 404 })
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
    publishSyncStatus({ state: "syncing", message: "正在同步…" })
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 60_000)
    try {
      await uploadPendingImageAssets(controller.signal)
      const batch = repository.getSyncBatch()
      const response = await requestBackendJson(`${syncSettings.backendUrl}/api/note-sync/push`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          web_token: syncSettings.token
        },
        body: JSON.stringify(batch),
        signal: controller.signal
      })
      const applied = repository.applySyncResult(response.data || {})
      await cacheRemoteImages(controller.signal)
      const lastSuccessAt = new Date().toISOString()
      const message = applied.conflictCount
        ? `已同步，保留 ${applied.conflictCount} 个冲突副本`
        : "已同步到云端"
      publishSyncStatus({ state: "success", message, lastSuccessAt })
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
  const note = repository.listWorkspace().notes.find((item) => item.id === noteId)
  if (!note) throw new Error("当前笔记不存在")
  const result = await dialog.showSaveDialog(mainWindow, {
    title: "导出当前笔记",
    defaultPath: `${sanitizeFileName(note.title)}.md`,
    filters: [{ name: "Markdown", extensions: ["md"] }]
  })
  if (result.canceled || !result.filePath) return { canceled: true }
  const portableNote = { ...note, content: await embedLocalImageData(note.content) }
  await fs.promises.writeFile(result.filePath, createMarkdownDocument(portableNote), "utf8")
  return { canceled: false, message: "当前笔记已导出", filePath: result.filePath }
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
  backup.notes = await Promise.all(backup.notes.map(async (note) => ({
    ...note,
    content: await embedLocalImageData(note.content)
  })))
  await fs.promises.writeFile(result.filePath, createMarkdownZip(backup))
  const noteCount = backup.notes.filter((note) => !note.isDeleted).length
  return {
    canceled: false,
    message: `已导出 ${noteCount} 篇 Markdown 笔记`,
    filePath: result.filePath
  }
}

/**
 * 导出包含历史版本的完整 JSON 备份。
 *
 * @returns {Promise<Record<string, any>>} 导出结果。
 */
async function exportFullBackup() {
  const result = await dialog.showSaveDialog(mainWindow, {
    title: "创建完整备份",
    defaultPath: `心悦笔记-完整备份-${getExportTimestamp()}.xynotes`,
    filters: [{ name: "心悦笔记备份", extensions: ["xynotes", "json"] }]
  })
  if (result.canceled || !result.filePath) return { canceled: true }
  const backup = await createFullBackupPayload()
  await fs.promises.writeFile(result.filePath, JSON.stringify(backup, null, 2), "utf8")
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
 * 选择 Markdown 文件夹并导入指定文件夹。
 *
 * @param {string | null} folderId 目标文件夹 ID。
 * @returns {Promise<Record<string, any>>} 导入结果。
 */
async function importMarkdownFiles(folderId) {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: "选择 Markdown 文件夹",
    properties: ["openDirectory", "createDirectory"]
  })
  if (result.canceled || !result.filePaths[0]) return { canceled: true }
  const sourcePath = result.filePaths[0]
  const documents = await collectMarkdownDocuments(sourcePath)
  if (!documents.length) throw new Error("所选文件夹中没有 Markdown 文件")
  const sourceFolderName = path.basename(sourcePath) || `Markdown 导入 ${getExportTimestamp()}`
  const imported = applyLocalMutation(() => repository.importMarkdownDocuments(
    documents,
    folderId,
    sourceFolderName
  ))
  mainWindow?.webContents.send("workspace:changed")
  return {
    canceled: false,
    message: `已从“${sourceFolderName}”导入 ${imported.importedNotes} 篇 Markdown 笔记`,
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
    filters: [{ name: "心悦笔记备份", extensions: ["xynotes", "json"] }]
  })
  if (result.canceled || !result.filePaths[0]) return { canceled: true }
  const content = await fs.promises.readFile(result.filePaths[0], "utf8")
  let backup
  try {
    backup = JSON.parse(content)
  } catch {
    throw new Error("备份文件不是有效的 JSON")
  }
  const restoredBackup = await restoreBackupImageAssets(backup)
  const imported = applyLocalMutation(() => repository.importBackup(restoredBackup))
  mainWindow?.webContents.send("workspace:changed")
  return {
    canceled: false,
    message: `已导入 ${imported.importedNotes} 篇笔记和 ${imported.importedHistories} 条历史版本`,
    ...imported
  }
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
 * @param {{ backendUrl: string }} input 待保存的设置。
 * @returns {Promise<{ backendUrl: string, configured: boolean, accountLabel: string }>} 设置摘要。
 */
async function saveSyncSettings(input) {
  const backendUrl = normalizeBackendUrl(input.backendUrl)
  const candidate = pendingSyncConnection?.backendUrl === backendUrl
    ? pendingSyncConnection
    : syncSettings.backendUrl === backendUrl && syncSettings.token ? syncSettings : null
  if (!candidate) throw new Error("请先完成连接测试")
  const nextSettings = {
    backendUrl,
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
 * @returns {Promise<{ backendUrl: string, configured: boolean, accountLabel: string }>} 设置摘要。
 */
async function clearSyncSettings() {
  const nextSettings = {
    backendUrl: syncSettings.backendUrl,
    token: "",
    accountId: syncSettings.accountId,
    accountLabel: syncSettings.accountLabel
  }
  pendingSyncConnection = null
  await activateSyncProfile(nextSettings)
  publishSyncStatus({ state: "idle", message: "仅保存在本机", lastSuccessAt: "" })
  return getSyncSettingsView()
}

/**
 * 打开网页登录页并创建仅保存在内存中的随机授权状态。
 *
 * @param {{ backendUrl: string }} input 浏览器登录参数。
 * @returns {Promise<{ ok: boolean, message: string, backendUrl?: string }>} 启动结果。
 */
async function startBrowserSyncLogin(input) {
  try {
    const backendUrl = normalizeBackendUrl(input.backendUrl)
    const state = randomBytes(32).toString("base64url")
    pendingBrowserAuth = {
      backendUrl,
      state,
      expiresAt: Date.now() + 5 * 60 * 1000
    }
    pendingSyncConnection = null
    const loginUrl = new URL("/notes", `${backendUrl}/`)
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
    await activateSyncProfile({ backendUrl: pending.backendUrl, token, accountId, accountLabel })
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
 * 注册离线数据库 IPC 接口。
 *
 * @returns {void}
 */
function registerIpcHandlers() {
  ipcMain.handle("workspace:list", () => repository.listWorkspace())
  ipcMain.handle("asset:save-image", (_event, input) => saveImageAsset(input || {}))
  ipcMain.handle("note:create", (_event, folderId) => (
    applyLocalMutation(() => repository.createNote(folderId || null))
  ))
  ipcMain.handle("note:update", (_event, noteId, patch) => (
    applyLocalMutation(() => repository.updateNote(noteId, patch))
  ))
  ipcMain.handle("note-history:list", async (_event, noteId) => {
    await performSync()
    return repository.listNoteHistory(noteId)
  })
  ipcMain.handle("note-history:restore", (_event, noteId, historyId) => {
    const restored = repository.restoreNoteHistory(noteId, historyId)
    if (restored) requestImmediateSync()
    return restored
  })
  ipcMain.handle("note-history:delete", (_event, noteId, historyId) => {
    const deleted = repository.deleteNoteHistory(noteId, historyId)
    if (deleted) requestImmediateSync()
    return deleted
  })
  ipcMain.handle("note:set-deleted", (_event, noteId, deleted) => (
    applyLocalMutation(() => repository.setNoteDeleted(noteId, deleted))
  ))
  ipcMain.handle("note:delete-permanently", (_event, noteId) => (
    applyLocalMutation(() => repository.deleteNotePermanently(noteId))
  ))
  ipcMain.handle("note:empty-trash", () => applyLocalMutation(() => repository.emptyTrash()))
  ipcMain.handle("folder:create", (_event, name, parentId) => (
    applyLocalMutation(() => repository.createFolder(name, parentId || null))
  ))
  ipcMain.handle("folder:rename", (_event, folderId, name) => (
    applyLocalMutation(() => repository.renameFolder(folderId, name))
  ))
  ipcMain.handle("folder:set-deleted", (_event, folderId) => (
    applyLocalMutation(() => repository.setFolderDeleted(folderId))
  ))
  ipcMain.handle("folder:restore", (_event, folderId) => (
    applyLocalMutation(() => repository.restoreFolder(folderId))
  ))
  ipcMain.handle("folder:delete-permanently", (_event, folderId) => (
    applyLocalMutation(() => repository.deleteFolderPermanently(folderId))
  ))
  ipcMain.handle("tag:create", (_event, name) => applyLocalMutation(() => repository.createTag(name)))
  ipcMain.handle("tag:delete", (_event, tagId) => applyLocalMutation(() => repository.deleteTag(tagId)))
  ipcMain.handle("data:export-note-markdown", (_event, noteId) => exportNoteMarkdown(noteId))
  ipcMain.handle("data:export-all-markdown", () => exportAllMarkdown())
  ipcMain.handle("data:export-backup", () => exportFullBackup())
  ipcMain.handle("data:import-markdown", (_event, folderId) => importMarkdownFiles(folderId || null))
  ipcMain.handle("data:import-backup", () => importFullBackup())
  ipcMain.handle("theme:set", (_event, theme) => {
    nativeTheme.themeSource = ["light", "dark"].includes(theme) ? theme : "system"
    return nativeTheme.shouldUseDarkColors
  })
  ipcMain.handle("sync-settings:get", () => getSyncSettingsView())
  ipcMain.handle("sync:status", () => syncStatus)
  ipcMain.handle("sync:run", () => performSync())
  ipcMain.handle("sync-settings:test", (_event, input) => testSyncConnection(input || {}))
  ipcMain.handle("sync-auth:start", (_event, input) => startBrowserSyncLogin(input || {}))
  ipcMain.handle("sync-auth:cancel", () => cancelBrowserSyncLogin())
  ipcMain.handle("sync-settings:save", (_event, input) => saveSyncSettings(input || {}))
  ipcMain.handle("sync-settings:clear", () => clearSyncSettings())
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
        { role: "about" },
        { type: "separator" },
        {
          label: "同步设置…",
          accelerator: "CmdOrCtrl+,",
          click: () => mainWindow?.webContents.send("sync-settings:open")
        },
        { type: "separator" },
        { role: "hide" },
        { role: "hideOthers" },
        { role: "unhide" },
        { type: "separator" },
        { role: "quit" }
      ]
    },
    {
      label: "编辑",
      submenu: [
        { role: "undo" },
        { role: "redo" },
        { type: "separator" },
        { role: "cut" },
        { role: "copy" },
        { role: "paste" },
        { role: "selectAll" }
      ]
    },
    {
      label: "显示",
      submenu: [
        { role: "reload" },
        { type: "separator" },
        { role: "resetZoom" },
        { role: "zoomIn" },
        { role: "zoomOut" },
        { type: "separator" },
        { role: "togglefullscreen" }
      ]
    },
    { label: "窗口", submenu: [{ role: "minimize" }, { role: "zoom" }, { role: "front" }] }
  ]))
}

/**
 * 创建离线笔记主窗口。
 *
 * @returns {BrowserWindow} 主窗口。
 */
function createWindow() {
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

  browserWindow.once("ready-to-show", () => browserWindow.show())
  browserWindow.on("closed", () => {
    mainWindow = null
  })
  browserWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url)
    return { action: "deny" }
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

const currentUserDataPath = path.join(app.getPath("appData"), "心悦笔记")
app.setPath("userData", currentUserDataPath)
app.setName("心悦笔记")
app.setAsDefaultProtocolClient(DESKTOP_AUTH_PROTOCOL)
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
  void handleBrowserAuthCallback(url)
})

app.whenReady().then(() => {
  syncSettings = loadSyncSettings()
  migrateDomainProfile(currentUserDataPath, syncSettings.backendUrl, syncSettings.accountId)
  const profilePath = getBackendProfilePath(syncSettings.backendUrl, syncSettings.accountId)
  const domainProfilePath = path.dirname(profilePath)
  repository = openBackendRepository(syncSettings.backendUrl, syncSettings.accountId)
  repository.relocateImageAssetPaths(
    path.join(domainProfilePath, LOCAL_ASSET_DIRECTORY_NAME),
    path.join(profilePath, LOCAL_ASSET_DIRECTORY_NAME)
  )
  registerLocalAssetProtocol()
  registerIpcHandlers()
  installMenu()
  createWindow()
  if (syncSettings.token) {
    setTimeout(() => void performSync(), 1500)
  }
  automaticSyncTimer = setInterval(() => {
    if (syncSettings.token) void performSync()
  }, NOTE_SYNC_INTERVAL_MS)
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on("before-quit", () => {
  if (automaticSyncTimer) clearInterval(automaticSyncTimer)
  automaticSyncTimer = null
  if (pendingMutationSyncTimer) clearTimeout(pendingMutationSyncTimer)
  pendingMutationSyncTimer = null
  repository?.close()
  repository = null
})

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit()
})
