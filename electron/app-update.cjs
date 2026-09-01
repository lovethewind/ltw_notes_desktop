const fs = require("node:fs")
const path = require("node:path")
const { finished } = require("node:stream/promises")

const RELEASE_API_URL = "https://api.github.com/repos/lovethewind/ltw_notes_desktop/releases/latest"

/**
 * 将版本号规范化为可比较的数字数组。
 *
 * @param {string} version 原始版本号。
 * @returns {number[]} 版本号数字段。
 */
function parseVersion(version) {
  const normalized = String(version || "").trim().replace(/^v/i, "").split("-")[0]
  if (!/^\d+(?:\.\d+)*$/.test(normalized)) throw new Error(`无法识别版本号：${version}`)
  return normalized.split(".").map((part) => Number(part))
}

/**
 * 比较两个语义版本号。
 *
 * @param {string} left 左侧版本号。
 * @param {string} right 右侧版本号。
 * @returns {-1 | 0 | 1} 左侧较旧、相同或较新。
 */
function compareVersions(left, right) {
  const leftParts = parseVersion(left)
  const rightParts = parseVersion(right)
  const length = Math.max(leftParts.length, rightParts.length)
  for (let index = 0; index < length; index += 1) {
    const difference = (leftParts[index] || 0) - (rightParts[index] || 0)
    if (difference > 0) return 1
    if (difference < 0) return -1
  }
  return 0
}

/**
 * 从 Release 附件中选择当前 macOS 架构对应的 DMG。
 *
 * @param {Record<string, any>} release GitHub Release 数据。
 * @param {string} architecture 当前 CPU 架构。
 * @returns {string} 下载地址；没有匹配附件时返回发布页地址。
 */
function selectMacDownloadUrl(release, architecture) {
  const assets = Array.isArray(release.assets) ? release.assets : []
  const architecturePattern = architecture === "arm64" ? /arm64/i : /(?:x64|x86_64)/i
  const matchingAsset = assets.find((asset) => (
    /\.dmg$/i.test(String(asset.name || ""))
    && architecturePattern.test(String(asset.name || ""))
  ))
  return String(matchingAsset?.browser_download_url || release.html_url || "")
}

/**
 * 从 GitHub Releases 检查心悦笔记的新版本。
 *
 * @param {{
 *   currentVersion: string,
 *   architecture: string,
 *   request: (url: string, options: Record<string, any>) => Promise<Record<string, any>>
 * }} options 检查参数。
 * @returns {Promise<Record<string, string>>} 可安全展示给渲染进程的检查结果。
 */
async function checkForUpdates({ currentVersion, architecture, request }) {
  const response = await request(RELEASE_API_URL, {
    headers: {
      Accept: "application/vnd.github+json",
      "User-Agent": "xinyue-notes-desktop"
    }
  })
  if (response.status === 404) {
    return {
      status: "unpublished",
      currentVersion,
      latestVersion: "",
      title: "暂无发布版本",
      releaseNotes: "",
      downloadUrl: ""
    }
  }
  if (!response.ok) {
    throw new Error(`检查更新失败（GitHub 返回 ${response.status || "未知状态"}）`)
  }
  const release = await response.json()
  if (release.draft || release.prerelease || !release.tag_name) {
    throw new Error("最新发布版本信息无效")
  }
  const latestVersion = String(release.tag_name).replace(/^v/i, "")
  const available = compareVersions(latestVersion, currentVersion) > 0
  return {
    status: available ? "available" : "latest",
    currentVersion,
    latestVersion,
    title: String(release.name || `心悦笔记 ${latestVersion}`),
    releaseNotes: String(release.body || ""),
    downloadUrl: available ? selectMacDownloadUrl(release, architecture) : ""
  }
}

/**
 * 从下载地址解析安全的安装包文件名。
 *
 * GitHub 的 Release 附件名可能包含中文（如“心悦笔记-0.7.0-arm64.dmg”），
 * 路径会被 URL 编码，这里解码后再剔除文件系统不允许的字符。
 *
 * @param {string} downloadUrl 下载地址。
 * @param {{ fallbackName?: string }} [options] 解析失败时的兜底文件名。
 * @returns {string} 安全的 DMG 文件名。
 */
function resolveDownloadFileName(downloadUrl, { fallbackName } = {}) {
  try {
    const pathname = new URL(downloadUrl).pathname
    const encoded = pathname.split("/").pop() || ""
    const fileName = decodeURIComponent(encoded)
    const safeName = fileName.replace(/[\\/:"*?<>|]/g, "_")
    if (safeName && /\.dmg$/i.test(safeName)) return safeName
  } catch {
    // URL 无法解析或文件名非法时退回到兜底名称。
  }
  return fallbackName || "xinyue-notes.dmg"
}

/**
 * 从 GitHub Release 流式下载 DMG 安装包并实时上报进度。
 *
 * 通过注入的 request 与进度回调，既能在主进程复用 Electron 的 net.fetch，
 * 也能在单元测试里用模拟响应验证进度与落盘行为。
 *
 * @param {{
 *   downloadUrl: string,
 *   request: (url: string, options: Record<string, any>) => Promise<Record<string, any>>,
 *   savePath: string,
 *   onProgress?: (progress: { received: number; total: number }) => void
 * }} options 下载参数。
 * @returns {Promise<{ filePath: string; total: number }>} 下载完成后的文件信息。
 */
async function downloadReleaseAsset({ downloadUrl, request, savePath, onProgress }) {
  const response = await request(downloadUrl, {
    headers: {
      Accept: "application/octet-stream",
      "User-Agent": "xinyue-notes-desktop"
    },
    bypassCustomProtocolHandlers: true
  })
  if (!response.ok) {
    throw new Error(`安装包下载失败（GitHub 返回 ${response.status || "未知状态"}）`)
  }
  if (!response.body || typeof response.body.getReader !== "function") {
    throw new Error("安装包下载失败（响应缺少文件流）")
  }
  const total = Number(response.headers.get("content-length") || 0)
  await fs.promises.mkdir(path.dirname(savePath), { recursive: true })
  const fileStream = fs.createWriteStream(savePath)
  let received = 0
  try {
    const reader = response.body.getReader()
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      if (!value || value.byteLength === 0) continue
      received += value.byteLength
      if (!fileStream.write(Buffer.from(value))) {
        await new Promise((resolve, reject) => {
          fileStream.once("drain", resolve)
          fileStream.once("error", reject)
        })
      }
      onProgress?.({ received, total })
    }
    fileStream.end()
    await finished(fileStream)
  } catch (error) {
    fileStream.destroy()
    if (fs.existsSync(savePath)) await fs.promises.unlink(savePath).catch(() => {})
    throw error
  }
  return { filePath: savePath, total }
}

module.exports = {
  checkForUpdates,
  compareVersions,
  selectMacDownloadUrl,
  resolveDownloadFileName,
  downloadReleaseAsset
}
