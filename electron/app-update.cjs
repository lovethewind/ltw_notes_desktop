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

module.exports = {
  checkForUpdates,
  compareVersions,
  selectMacDownloadUrl
}
