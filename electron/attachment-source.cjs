/**
 * 从 HTTP(S) 地址提取标准化主机名。
 *
 * @param {unknown} value 待解析地址。
 * @returns {string} 小写主机名；无效或非 HTTP(S) 地址返回空字符串。
 */
function getHttpHostname(value) {
  try {
    const url = new URL(String(value || ""))
    if (!["http:", "https:"].includes(url.protocol)) return ""
    return url.hostname.toLowerCase().replace(/\.$/, "")
  } catch {
    return ""
  }
}

/**
 * 判断主机是否等于可信主机或属于其子域名。
 *
 * @param {string} hostname 待判断主机。
 * @param {string} trustedHostname 可信主机。
 * @returns {boolean} 是否属于可信站点。
 */
function isSameOrSubdomain(hostname, trustedHostname) {
  return Boolean(
    hostname
    && trustedHostname
    && (hostname === trustedHostname || hostname.endsWith(`.${trustedHostname}`))
  )
}

/**
 * 将资源划分为笔记附件或外链缓存。
 *
 * 本地资源、服务端签发资源、配置站点及其子域资源属于笔记附件；
 * 其余远程资源仍可下载缓存，但在附件管理中明确标记为外链缓存。
 *
 * @param {{ remoteUrl?: unknown, serverSourceId?: unknown }} asset 附件资源。
 * @param {{ backendUrl?: unknown, webUrl?: unknown }} settings 当前同步站点配置。
 * @returns {{ sourceKind: "managed" | "external-cache", sourceHost: string }} 来源分类。
 */
function classifyAttachmentSource(asset, settings) {
  const remoteUrl = String(asset?.remoteUrl || "").trim()
  const sourceHost = getHttpHostname(remoteUrl)
  if (!remoteUrl || asset?.serverSourceId) {
    return { sourceKind: "managed", sourceHost }
  }

  const trustedHosts = [settings?.backendUrl, settings?.webUrl]
    .map(getHttpHostname)
    .filter(Boolean)
  const sourceKind = trustedHosts.some((hostname) => isSameOrSubdomain(sourceHost, hostname))
    ? "managed"
    : "external-cache"
  return { sourceKind, sourceHost }
}

module.exports = {
  classifyAttachmentSource,
  getHttpHostname,
  isSameOrSubdomain
}
