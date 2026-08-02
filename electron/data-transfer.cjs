const AdmZip = require("adm-zip")

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

/**
 * 按文件夹层级创建全部未删除笔记的 Markdown ZIP。
 *
 * @param {{ folders: Record<string, any>[], notes: Record<string, any>[] }} backup 备份数据。
 * @returns {Buffer} ZIP 文件内容。
 */
function createMarkdownZip(backup) {
  const zip = new AdmZip()
  const folderMap = new Map((backup.folders || []).map((folder) => [folder.id, folder]))

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
    zip.addFile(
      `${getFolderPath(note.folderId)}/${fileName}`,
      Buffer.from(createMarkdownDocument(note), "utf8")
    )
  }
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
  for (const entry of zip.getEntries()) {
    const entryName = String(entry.entryName || "").replace(/\\/g, "/")
    const pathParts = entryName.split("/").filter(Boolean)
    if (
      entryName.startsWith("/")
      || /^[a-zA-Z]:\//.test(entryName)
      || pathParts.includes("..")
    ) {
      throw new Error(`压缩包包含不安全路径：${entryName}`)
    }
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
    documents.push({
      ...parseMarkdownDocument(content, fileName.slice(0, -extension.length)),
      folderPath: pathParts.slice(0, -1)
    })
  }
  return documents
}

module.exports = {
  collectMarkdownDocumentsFromZip,
  createMarkdownDocument,
  createMarkdownZip,
  parseMarkdownDocument,
  sanitizeFileName
}
