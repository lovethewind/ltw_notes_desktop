const AdmZip = require("adm-zip")
const { createHash } = require("node:crypto")
const path = require("node:path")

const PORTABLE_BACKUP_FORMAT = "xinyue-notes-archive"
const PORTABLE_BACKUP_VERSION = 1

const MIME_EXTENSIONS = new Map([
  ["image/jpeg", ".jpg"],
  ["image/png", ".png"],
  ["image/gif", ".gif"],
  ["image/webp", ".webp"],
  ["image/svg+xml", ".svg"],
  ["application/pdf", ".pdf"],
  ["application/zip", ".zip"],
  ["text/plain", ".txt"],
  ["text/markdown", ".md"]
])

const EXTENSION_MIME_TYPES = new Map(
  [...MIME_EXTENSIONS.entries()].map(([mimeType, extension]) => [extension, mimeType])
)

function sha256(data) {
  return createHash("sha256").update(data).digest("hex")
}

function getAssetExtension(asset = {}) {
  const fileExtension = path.extname(String(asset.fileName || "")).toLowerCase()
  if (/^\.[a-z0-9]{1,10}$/.test(fileExtension)) return fileExtension
  return MIME_EXTENSIONS.get(String(asset.mimeType || "").toLowerCase()) || ".bin"
}

function getMimeType(fileName) {
  return EXTENSION_MIME_TYPES.get(path.extname(String(fileName || "")).toLowerCase()) || "application/octet-stream"
}

/**
 * 从 Markdown 正文里挑出**本地相对路径**的图片引用。
 *
 * 单文件导入靠它决定要一并搬运哪些图片。只收 `![]()` 里的相对路径：
 *  - 带协议的（http/https/data/file）是网络图或绝对路径，不属于「搬进来」的范围；
 *  - `#` 开头的是页内锚点，不是文件；
 *  - 同时支持 `<img src="...">`，有些编辑器会写成 HTML。
 *
 * @param {unknown} content Markdown 正文。
 * @returns {string[]} 去重后的相对路径（已去掉 `./` 前缀并解码 %20 一类转义）。
 */
function extractLocalImageReferences(content) {
  const markdown = String(content || "")
  const references = new Set()
  const patterns = [
    /!\[[^\]]*\]\(([^)\s]+)/g,
    /<img\b[^>]*\bsrc=["']([^"']+)["']/gi
  ]
  for (const pattern of patterns) {
    for (const match of markdown.matchAll(pattern)) {
      const target = String(match[1] || "").trim()
      if (!target) continue
      if (/^[a-z][a-z0-9+.-]*:/i.test(target)) continue
      if (target.startsWith("#") || target.startsWith("//")) continue
      let decoded = target
      try {
        decoded = decodeURIComponent(target)
      } catch {
        // 非法转义就按原文处理，不因此丢掉这张图。
      }
      references.add(decoded.replace(/^\.\//, ""))
    }
  }
  return [...references]
}

function assertSafeArchivePath(entryName) {
  const normalized = String(entryName || "").replace(/\\/g, "/")
  const pathParts = normalized.split("/").filter(Boolean)
  if (normalized.startsWith("/") || /^[a-zA-Z]:\//.test(normalized) || pathParts.includes("..")) {
    throw new Error(`压缩包包含不安全路径：${normalized}`)
  }
  return { normalized, pathParts }
}

function replaceAllLiteral(value, search, replacement) {
  return search ? String(value).split(search).join(replacement) : String(value)
}

/**
 * 将标题转换为可安全用于文件或 ZIP 路径的名称。
 *
 * @param {unknown} value 原始名称。
 * @returns {string} 安全文件名。
 */
function sanitizeFileName(value) {
  const sanitized = String(value || "")
    .trim()
    .replace(/[\/\\:*?"<>|\u0000-\u001f]/g, "_")
    .replace(/^\.+/, "")
    .replace(/[.\s]+$/, "")
    .slice(0, 80)
  return sanitized || "未命名"
}

/**
 * 将笔记转换为带可回读元数据的 Markdown 文档。
 *
 * @param {Record<string, any>} note 笔记数据。
 * @returns {string} Markdown 文档。
 */
function createMarkdownDocument(note) {
  const tagNames = (note.tags || []).map((tag) => tag.name).filter(Boolean)
  return [
    "---",
    `title: ${JSON.stringify(String(note.title || "无标题笔记"))}`,
    `tags: ${JSON.stringify(tagNames)}`,
    `createdAt: ${JSON.stringify(String(note.createdAt || ""))}`,
    `updatedAt: ${JSON.stringify(String(note.updatedAt || ""))}`,
    "---",
    String(note.content || "")
  ].join("\n")
}

/**
 * 解析本应用导出的 Markdown 元数据，普通 Markdown 则使用文件名作为标题。
 *
 * @param {unknown} value Markdown 文本。
 * @param {string} fallbackTitle 文件名推导的默认标题。
 * @returns {{ title: string, content: string, tagNames: string[] }} 待导入笔记。
 */
function parseMarkdownDocument(value, fallbackTitle) {
  const markdown = String(value || "").replace(/\r\n/g, "\n")
  if (!markdown.startsWith("---\n")) {
    return {
      title: String(fallbackTitle || "无标题笔记").trim() || "无标题笔记",
      content: markdown,
      tagNames: []
    }
  }
  const endIndex = markdown.indexOf("\n---\n", 4)
  if (endIndex < 0) {
    return {
      title: String(fallbackTitle || "无标题笔记").trim() || "无标题笔记",
      content: markdown,
      tagNames: []
    }
  }
  const metadata = {}
  for (const line of markdown.slice(4, endIndex).split("\n")) {
    const separatorIndex = line.indexOf(":")
    if (separatorIndex < 1) continue
    const key = line.slice(0, separatorIndex).trim()
    const rawValue = line.slice(separatorIndex + 1).trim()
    try {
      metadata[key] = JSON.parse(rawValue)
    } catch {
      metadata[key] = rawValue
    }
  }
  return {
    title: String(metadata.title || fallbackTitle || "无标题笔记").trim().slice(0, 100) || "无标题笔记",
    content: markdown.slice(endIndex + 5),
    tagNames: Array.isArray(metadata.tags)
      ? metadata.tags.map((tag) => String(tag).trim()).filter(Boolean).slice(0, 12)
      : []
  }
}

/** 笔记嵌入卡片在正文里的载体（与 `src/editor/xynote-embed.ts` 写入的形式一致）。 */
const EMBED_PLACEHOLDER_PATTERN = /<div[^>]*\bdata-xynote-embed=["']note:([^"']+)["'][^>]*>\s*<\/div>/gi

/** 占位 div 上可能写着标题的属性。 */
const EMBED_TITLE_PATTERN = /\btitle=["']([^"']*)["']/i

/** 行内字号 mark 序列化出来的 span（只含 font-size 一条声明的形式）。 */
const FONT_SIZE_SPAN_PATTERN = /<span[^>]*\bstyle=["'][^"']*font-size:[^"']*["'][^>]*>([\s\S]*?)<\/span>/gi

/** 富文本为保真空行写下的硬换行。 */
const HARD_BREAK_PATTERN = /<br\s*\/?>/gi

/**
 * 按 ``` / ~~~ 围栏把正文切成「代码段 / 普通段」。
 *
 * 降级替换只能作用在普通段上：代码块里出现的 `<br />`、`<span style="font-size:…">`
 * 是用户要看的原文，一起换掉就等于把导出的文件改坏了。
 *
 * @param {unknown} markdown Markdown 原文。
 * @returns {Array<{ code: boolean, text: string }>} 分段结果（按原文顺序）。
 */
function splitFencedCodeSegments(markdown) {
  const segments = []
  let buffer = []
  let openFence = null

  for (const line of String(markdown || "").split("\n")) {
    const fenceMatch = /^\s{0,3}(`{3,}|~{3,})/.exec(line)
    if (openFence === null) {
      if (fenceMatch) {
        if (buffer.length) segments.push({ code: false, text: buffer.join("\n") })
        buffer = [line]
        openFence = fenceMatch[1]
        continue
      }
      buffer.push(line)
      continue
    }
    buffer.push(line)
    // 闭合围栏必须同种字符且不短于开启的那个（CommonMark 的口径）。
    if (fenceMatch && fenceMatch[1][0] === openFence[0] && fenceMatch[1].length >= openFence.length) {
      segments.push({ code: true, text: buffer.join("\n") })
      buffer = []
      openFence = null
    }
  }
  // 没收上口的围栏按代码块处理，宁可少改也不要动到用户写的原文。
  if (buffer.length) segments.push({ code: openFence !== null, text: buffer.join("\n") })
  return segments
}

/**
 * 把一张嵌入卡片降级成一行可读的引用。
 *
 * @param {string} noteId 被嵌入的笔记 ID。
 * @param {string} rawHtml 原始占位 div（用于取出 `title` 属性）。
 * @param {(noteId: string) => (Record<string, any> | null)} [resolveEmbed] 标题/地址解析器。
 * @returns {string} 一行引用文本。
 */
function renderPortableEmbed(noteId, rawHtml, resolveEmbed) {
  const inlineTitle = (EMBED_TITLE_PATTERN.exec(rawHtml) || [])[1]
  const resolved = typeof resolveEmbed === "function" ? resolveEmbed(noteId) : null
  const title = String((resolved && resolved.title) || inlineTitle || "").trim() || "未命名笔记"
  const url = String((resolved && resolved.url) || "").trim()
  return url ? `> 嵌入的笔记：[${title}](${url})` : `> 嵌入的笔记：${title}`
}

/**
 * 把正文里的应用内部写法降级为通用 Markdown（代码块原样跳过）。
 *
 * @param {unknown} text 一段正文。
 * @param {(noteId: string) => (Record<string, any> | null)} [resolveEmbed] 嵌入卡片解析器。
 * @returns {string} 降级后的正文。
 */
function degradeApplicationMarkup(text, resolveEmbed) {
  return String(text)
    .replace(EMBED_PLACEHOLDER_PATTERN, (match, noteId) => renderPortableEmbed(noteId, match, resolveEmbed))
    .replace(FONT_SIZE_SPAN_PATTERN, "$1")
    .replace(HARD_BREAK_PATTERN, "\n")
    // 硬换行变成真换行后，原本靠多个 <br /> 撑出的空行会堆成长串，收一下。
    .replace(/\n{3,}/g, "\n\n")
}

/**
 * 生成「给外部看」的纯净 Markdown：不含元数据、不含应用私有标签。
 *
 * 与 `createMarkdownDocument` 的分工：
 *   - 那个是**迁移 / 回读**通道（带 front matter，导回来不丢标题标签时间）；
 *   - 这个是**对外分享**通道（任何 Markdown 软件都能正常显示，标题改用一级标题承载）。
 *
 * 降级规则：嵌入卡片 → 一行引用（能解析到网页地址时带链接）、行内字号 span → 纯文本、
 * `<br />` → 真换行。**围栏代码块内原样保留**。
 *
 * @param {Record<string, any>} note 笔记数据。
 * @param {{ resolveEmbed?: (noteId: string) => (Record<string, any> | null) }} [options] 选项。
 * @returns {string} Markdown 文档。
 */
function createCleanMarkdownDocument(note, options = {}) {
  const body = splitFencedCodeSegments(note && note.content)
    .map((segment) => (segment.code ? segment.text : degradeApplicationMarkup(segment.text, options.resolveEmbed)))
    .join("\n")
    .trim()
  const title = String((note && note.title) || "").trim()
  // front matter 被剥掉了，标题改用一级标题承载；正文首行已经是同名标题就不重复加。
  const hasOwnHeading = body.split("\n", 1)[0].trim() === `# ${title}`
  const heading = title && !hasOwnHeading ? `# ${title}\n\n` : ""
  return `${heading}${body}\n`
}

/**
 * 按文件夹层级创建全部未删除笔记的 Markdown ZIP。
 *
 * @param {{ folders: Record<string, any>[], notes: Record<string, any>[] }} backup 备份数据。
 * @returns {Buffer} ZIP 文件内容。
 */
function createMarkdownZip(backup) {
  const zip = new AdmZip()
  const folderMap = new Map((backup.folders || []).map((folder) => [folder.id, folder]))
  const assets = (backup.assets || []).filter((asset) => Buffer.isBuffer(asset.data))
  const archivedAssets = new Map()

  /**
   * 计算文件夹在 ZIP 中的安全路径。
   *
   * @param {string | null} folderId 文件夹 ID。
   * @param {Set<string>} visited 已访问文件夹。
   * @returns {string} ZIP 内相对目录。
   */
  function getFolderPath(folderId, visited = new Set()) {
    if (!folderId) return "未分类"
    const folder = folderMap.get(folderId)
    if (!folder || visited.has(folderId)) return "未分类"
    visited.add(folderId)
    const name = sanitizeFileName(folder.name)
    return folder.parentId
      ? `${getFolderPath(folder.parentId, visited)}/${name}`
      : name
  }

  for (const note of backup.notes || []) {
    if (note.isDeleted) continue
    const noteIdSuffix = sanitizeFileName(String(note.id || "").slice(0, 8))
    const fileName = `${sanitizeFileName(note.title)}-${noteIdSuffix}.md`
    const notePath = `${getFolderPath(note.folderId)}/${fileName}`
    const noteDirectory = path.posix.dirname(notePath)
    let content = String(note.content || "")

    for (const asset of assets) {
      const archivePath = `assets/${sha256(asset.data)}${getAssetExtension(asset)}`
      const relativePath = path.posix.relative(noteDirectory, archivePath)
      const references = [
        asset.localUrl,
        asset.remoteUrl,
        asset.id ? `https://xinyue-asset.local/${encodeURIComponent(asset.id)}` : ""
      ].filter(Boolean)
      if (!references.some((reference) => content.includes(reference))) continue
      for (const reference of references) {
        content = replaceAllLiteral(content, reference, relativePath)
      }
      archivedAssets.set(archivePath, asset.data)
    }

    content = content.replace(
      /data:(image\/[a-z0-9.+-]+);base64,([a-z0-9+/=\r\n]+)/gi,
      (source, mimeType, encoded) => {
        const data = Buffer.from(encoded.replace(/\s/g, ""), "base64")
        if (!data.length) return source
        const archivePath = `assets/${sha256(data)}${getAssetExtension({ mimeType })}`
        archivedAssets.set(archivePath, data)
        return path.posix.relative(noteDirectory, archivePath)
      }
    )
    zip.addFile(
      notePath,
      Buffer.from(createMarkdownDocument({ ...note, content }), "utf8")
    )
  }
  for (const [archivePath, data] of archivedAssets) zip.addFile(archivePath, data)
  return zip.toBuffer()
}

/**
 * 直接读取 Markdown ZIP 中的文档，并保留压缩包内部目录层级。
 *
 * @param {Buffer|string} source ZIP 文件内容或本地路径。
 * @returns {Array<{ title: string, content: string, tagNames: string[], folderPath: string[] }>} Markdown 文档列表。
 */
function collectMarkdownDocumentsFromZip(source) {
  const zip = new AdmZip(source)
  const documents = []
  const entryMap = new Map()
  for (const entry of zip.getEntries()) {
    const { normalized } = assertSafeArchivePath(entry.entryName)
    entryMap.set(normalized, entry)
  }
  for (const entry of zip.getEntries()) {
    const { normalized: entryName, pathParts } = assertSafeArchivePath(entry.entryName)
    if (
      entry.isDirectory
      || !pathParts.length
      || pathParts.includes("__MACOSX")
      || pathParts.some((part) => part === ".DS_Store" || part.startsWith("._"))
    ) {
      continue
    }
    const fileName = pathParts.at(-1)
    const extension = fileName.includes(".") ? `.${fileName.split(".").at(-1).toLowerCase()}` : ""
    if (![".md", ".markdown"].includes(extension)) continue
    const content = entry.getData().toString("utf8")
    const document = {
      ...parseMarkdownDocument(content, fileName.slice(0, -extension.length)),
      folderPath: pathParts.slice(0, -1)
    }
    const resources = []
    const seenResources = new Set()
    const referencePattern = /!?\[[^\]]*\]\((?:<([^>]+)>|([^\s)]+))(?:\s+["'][^"']*["'])?\)/g
    for (const match of content.matchAll(referencePattern)) {
      const sourceUrl = match[1] || match[2] || ""
      if (!sourceUrl || /^(?:[a-z][a-z0-9+.-]*:|#)/i.test(sourceUrl)) continue
      const cleanUrl = sourceUrl.split(/[?#]/, 1)[0]
      let decodedUrl
      try {
        decodedUrl = decodeURIComponent(cleanUrl)
      } catch {
        decodedUrl = cleanUrl
      }
      const resourcePath = path.posix.normalize(path.posix.join(path.posix.dirname(entryName), decodedUrl))
      if (resourcePath.startsWith("../") || path.posix.isAbsolute(resourcePath)) {
        throw new Error(`Markdown 包含不安全资源路径：${sourceUrl}`)
      }
      const resourceEntry = entryMap.get(resourcePath)
      if (!resourceEntry || resourceEntry.isDirectory || seenResources.has(sourceUrl)) continue
      seenResources.add(sourceUrl)
      resources.push({
        sourceUrl,
        fileName: path.posix.basename(resourcePath),
        mimeType: getMimeType(resourcePath),
        data: resourceEntry.getData()
      })
    }
    if (resources.length) document.resources = resources
    documents.push(document)
  }
  return documents
}

/**
 * 创建新版 .xynotes ZIP 容器，元数据和原始附件分开保存。
 *
 * @param {Record<string, any>} backup 数据库备份。
 * @param {Map<string, Buffer>} assetBodies 附件 ID 到原始内容的映射。
 * @returns {Buffer} .xynotes 文件内容。
 */
function createPortableBackupArchive(backup, assetBodies = new Map()) {
  const zip = new AdmZip()
  const archivedBodies = new Map()
  const data = {
    ...backup,
    assets: (backup.assets || []).map((asset) => {
      const body = assetBodies.get(asset.id) || asset.data
      const cleanAsset = { ...asset }
      delete cleanAsset.localPath
      delete cleanAsset.localUrl
      delete cleanAsset.data
      delete cleanAsset.dataBase64
      if (!Buffer.isBuffer(body)) return cleanAsset
      const archivePath = `assets/${sha256(body)}${getAssetExtension(asset)}`
      archivedBodies.set(archivePath, body)
      return { ...cleanAsset, archivePath }
    })
  }
  zip.addFile("manifest.json", Buffer.from(JSON.stringify({
    format: PORTABLE_BACKUP_FORMAT,
    version: PORTABLE_BACKUP_VERSION,
    createdAt: new Date().toISOString(),
    dataEntry: "data.json",
    assetCount: data.assets.length
  }, null, 2)))
  zip.addFile("data.json", Buffer.from(JSON.stringify(data, null, 2)))
  for (const [archivePath, body] of archivedBodies) zip.addFile(archivePath, body)
  return zip.toBuffer()
}

/**
 * 读取新版 .xynotes ZIP 容器。旧版 JSON 文件会给出明确错误。
 *
 * @param {Buffer|string} source ZIP 文件内容或本地路径。
 * @returns {Record<string, any>} 含附件 Buffer 的备份数据。
 */
function parsePortableBackupArchive(source) {
  const raw = Buffer.isBuffer(source) ? source : null
  if (raw && (raw.length < 4 || raw[0] !== 0x50 || raw[1] !== 0x4b)) {
    throw new Error("完整备份格式过旧：请使用新版客户端导出的 .xynotes 文件")
  }
  let zip
  try {
    zip = new AdmZip(source)
  } catch {
    throw new Error("完整备份格式过旧或文件无效：请使用新版客户端导出的 .xynotes 文件")
  }
  const entryMap = new Map()
  for (const entry of zip.getEntries()) {
    const { normalized } = assertSafeArchivePath(entry.entryName)
    entryMap.set(normalized, entry)
  }
  const manifestEntry = entryMap.get("manifest.json")
  const dataEntry = entryMap.get("data.json")
  if (!manifestEntry || !dataEntry) {
    throw new Error("完整备份格式过旧或文件无效：请使用新版客户端导出的 .xynotes 文件")
  }
  let manifest
  let backup
  try {
    manifest = JSON.parse(manifestEntry.getData().toString("utf8"))
    backup = JSON.parse(dataEntry.getData().toString("utf8"))
  } catch {
    throw new Error("完整备份文件损坏：无法读取备份元数据")
  }
  if (manifest.format !== PORTABLE_BACKUP_FORMAT || manifest.version !== PORTABLE_BACKUP_VERSION) {
    throw new Error("完整备份版本不受支持：请使用当前客户端重新导出")
  }
  backup.assets = (backup.assets || []).map((asset) => {
    if (!asset.archivePath) return asset
    const { normalized } = assertSafeArchivePath(asset.archivePath)
    const assetEntry = entryMap.get(normalized)
    if (!assetEntry || assetEntry.isDirectory) {
      throw new Error(`完整备份缺少附件：${asset.fileName || asset.id || normalized}`)
    }
    const restored = { ...asset, data: assetEntry.getData() }
    delete restored.archivePath
    return restored
  })
  return backup
}

module.exports = {
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
}
