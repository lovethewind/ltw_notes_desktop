const { createHash } = require("node:crypto")

const EMBEDDED_IMAGE_PATTERN = /data:(image\/[a-z0-9.+-]+)(?:;[^,;]+)*;base64,([a-z0-9+/]+={0,2})/gi

/**
 * 校验并解码 Base64，避免 Node.js 的宽松解码误认损坏内容。
 *
 * @param {string} encoded Base64 文本。
 * @returns {Buffer | null} 图片二进制。
 */
function decodeBase64(encoded) {
  const normalized = String(encoded || "")
  if (!normalized || normalized.length % 4 === 1) return null
  const data = Buffer.from(normalized, "base64")
  if (!data.length) return null
  const canonicalSource = normalized.replace(/=+$/, "")
  const canonicalData = data.toString("base64").replace(/=+$/, "")
  return canonicalSource === canonicalData ? data : null
}

/**
 * 扫描正文内可安全迁移的 Base64 图片。
 *
 * @param {unknown} content Markdown 或 HTML 正文。
 * @returns {Array<{ source: string, mimeType: string, data: Buffer, sha256: string }>} 图片列表。
 */
function collectEmbeddedBase64Images(content) {
  const images = []
  for (const match of String(content || "").matchAll(EMBEDDED_IMAGE_PATTERN)) {
    const data = decodeBase64(match[2])
    if (!data) continue
    images.push({
      source: match[0],
      mimeType: match[1].toLowerCase(),
      data,
      sha256: createHash("sha256").update(data).digest("hex")
    })
  }
  return images
}

/**
 * 将正文中的 Base64 图片替换为附件地址，同一二进制只解析一次。
 *
 * @param {unknown} content Markdown 或 HTML 正文。
 * @param {(image: { source: string, mimeType: string, data: Buffer, sha256: string }) => string | null} resolveUrl 解析目标附件地址。
 * @returns {{ content: string, replacedCount: number, uniqueImageCount: number }} 迁移结果。
 */
function replaceEmbeddedBase64Images(content, resolveUrl) {
  let migrated = String(content || "")
  let replacedCount = 0
  const resolvedUrls = new Map()
  for (const image of collectEmbeddedBase64Images(migrated)) {
    if (!resolvedUrls.has(image.sha256)) {
      resolvedUrls.set(image.sha256, resolveUrl(image) || null)
    }
    const targetUrl = resolvedUrls.get(image.sha256)
    if (!targetUrl) continue
    const occurrences = migrated.split(image.source).length - 1
    if (!occurrences) continue
    migrated = migrated.split(image.source).join(targetUrl)
    replacedCount += occurrences
  }
  return {
    content: migrated,
    replacedCount,
    uniqueImageCount: [...resolvedUrls.values()].filter(Boolean).length
  }
}

module.exports = {
  collectEmbeddedBase64Images,
  replaceEmbeddedBase64Images
}
