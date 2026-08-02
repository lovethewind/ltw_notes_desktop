const { randomUUID } = require("node:crypto")
const path = require("node:path")
const Database = require("better-sqlite3")

const HISTORY_INTERVAL_MS = 5 * 60 * 1000
const MAX_NOTE_CONTENT_BYTES = 15 * 1024 * 1024
const LOCAL_ASSET_URL_PREFIX = "xinyue-asset://local/"
const INTERNAL_ATTACHMENT_URL_PREFIX = "https://xinyue-asset.local/"

/**
 * 返回当前 ISO 时间。
 *
 * @returns {string} 当前时间。
 */
function nowIso() {
  return new Date().toISOString()
}

/**
 * 将历史正文转换为不含 HTML 标签的单行摘要。
 *
 * @param {unknown} content 历史正文。
 * @returns {string} 最多 120 个字符的纯文本摘要。
 */
function createHistoryContentPreview(content) {
  return String(content || "")
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;|&#160;/gi, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120)
}

/**
 * 按 UTF-8 字节数校验并返回笔记正文。
 *
 * @param {unknown} content 笔记正文。
 * @returns {string} 已通过大小校验的正文。
 * @throws {Error} 正文超过 15 MiB 时抛出。
 */
function validateNoteContent(content) {
  const normalizedContent = String(content || "")
  if (Buffer.byteLength(normalizedContent, "utf8") > MAX_NOTE_CONTENT_BYTES) {
    throw new Error("笔记正文不能超过 15 MiB")
  }
  return normalizedContent
}

/**
 * 将图片资源行转换为业务对象。
 *
 * @param {Record<string, any>} row 图片资源数据库行。
 * @returns {Record<string, any>} 图片资源对象。
 */
function mapImageAsset(row) {
  return {
    id: row.id,
    fileName: row.file_name,
    mimeType: row.mime_type,
    byteSize: row.byte_size,
    sha256: row.sha256,
    localPath: row.local_path,
    localUrl: `${LOCAL_ASSET_URL_PREFIX}${row.id}`,
    remoteUrl: row.remote_url,
    serverSourceId: row.server_source_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}

/**
 * 创建离线笔记数据库仓储。
 *
 * @param {string} userDataPath Electron 用户数据目录。
 * @returns {ReturnType<typeof createRepository>} 数据仓储。
 */
function openNotesDatabase(userDataPath) {
  const database = new Database(path.join(userDataPath, "notes.sqlite3"))
  database.pragma("journal_mode = WAL")
  database.pragma("foreign_keys = ON")
  database.pragma("busy_timeout = 5000")
  database.exec(`
    CREATE TABLE IF NOT EXISTS folders (
      id TEXT PRIMARY KEY,
      server_id TEXT,
      parent_id TEXT REFERENCES folders(id) ON DELETE SET NULL,
      name TEXT NOT NULL,
      sort_order INTEGER NOT NULL DEFAULT 0,
      is_deleted INTEGER NOT NULL DEFAULT 0,
      deleted_at TEXT,
      deleted_root_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      server_updated_at TEXT,
      revision INTEGER NOT NULL DEFAULT 0,
      dirty INTEGER NOT NULL DEFAULT 1
    );
    CREATE TABLE IF NOT EXISTS tags (
      id TEXT PRIMARY KEY,
      server_id TEXT,
      name TEXT NOT NULL COLLATE NOCASE UNIQUE,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      server_updated_at TEXT,
      revision INTEGER NOT NULL DEFAULT 0,
      dirty INTEGER NOT NULL DEFAULT 1
    );
    CREATE TABLE IF NOT EXISTS notes (
      id TEXT PRIMARY KEY,
      server_id TEXT,
      folder_id TEXT REFERENCES folders(id) ON DELETE SET NULL,
      title TEXT NOT NULL DEFAULT '无标题笔记',
      content TEXT NOT NULL DEFAULT '',
      is_pinned INTEGER NOT NULL DEFAULT 0,
      is_deleted INTEGER NOT NULL DEFAULT 0,
      deleted_at TEXT,
      deleted_by_folder_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      server_updated_at TEXT,
      revision INTEGER NOT NULL DEFAULT 0,
      dirty INTEGER NOT NULL DEFAULT 1
    );
    CREATE INDEX IF NOT EXISTS idx_notes_list
      ON notes(is_deleted, is_pinned, updated_at DESC);
    CREATE TABLE IF NOT EXISTS note_tags (
      note_id TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
      tag_id TEXT NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
      PRIMARY KEY(note_id, tag_id)
    );
    CREATE TABLE IF NOT EXISTS note_history (
      id TEXT PRIMARY KEY,
      note_id TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      content TEXT NOT NULL,
      folder_id TEXT,
      tag_names TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL,
      dirty INTEGER NOT NULL DEFAULT 1
    );
    CREATE INDEX IF NOT EXISTS idx_note_history_time
      ON note_history(note_id, created_at DESC);
    CREATE TABLE IF NOT EXISTS note_assets (
      id TEXT PRIMARY KEY,
      file_name TEXT NOT NULL,
      mime_type TEXT NOT NULL,
      byte_size INTEGER NOT NULL,
      sha256 TEXT NOT NULL UNIQUE,
      local_path TEXT NOT NULL,
      remote_url TEXT,
      server_source_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_note_assets_remote_url
      ON note_assets(remote_url) WHERE remote_url IS NOT NULL;
    CREATE TABLE IF NOT EXISTS outbox (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      entity_type TEXT NOT NULL,
      entity_id TEXT NOT NULL,
      operation TEXT NOT NULL,
      payload TEXT NOT NULL,
      created_at TEXT NOT NULL,
      attempt_count INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_outbox_pending ON outbox(id);
    CREATE TABLE IF NOT EXISTS sync_state (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `)
  const folderColumns = database.prepare("PRAGMA table_info(folders)").all()
  if (!folderColumns.some((column) => column.name === "parent_id")) {
    database.exec("ALTER TABLE folders ADD COLUMN parent_id TEXT REFERENCES folders(id) ON DELETE SET NULL")
  }
  for (const [columnName, definition] of [
    ["is_deleted", "INTEGER NOT NULL DEFAULT 0"],
    ["deleted_at", "TEXT"],
    ["deleted_root_id", "TEXT"]
  ]) {
    if (!folderColumns.some((column) => column.name === columnName)) {
      database.exec(`ALTER TABLE folders ADD COLUMN ${columnName} ${definition}`)
    }
  }
  const noteColumns = database.prepare("PRAGMA table_info(notes)").all()
  if (!noteColumns.some((column) => column.name === "deleted_by_folder_id")) {
    database.exec("ALTER TABLE notes ADD COLUMN deleted_by_folder_id TEXT")
  }
  for (const tableName of ["folders", "tags", "notes"]) {
    const columns = database.prepare(`PRAGMA table_info(${tableName})`).all()
    if (!columns.some((column) => column.name === "server_updated_at")) {
      database.exec(`ALTER TABLE ${tableName} ADD COLUMN server_updated_at TEXT`)
    }
  }
  const historyColumns = database.prepare("PRAGMA table_info(note_history)").all()
  if (!historyColumns.some((column) => column.name === "dirty")) {
    database.exec("ALTER TABLE note_history ADD COLUMN dirty INTEGER NOT NULL DEFAULT 1")
  }
  const assetColumns = database.prepare("PRAGMA table_info(note_assets)").all()
  if (!assetColumns.some((column) => column.name === "server_source_id")) {
    database.exec("ALTER TABLE note_assets ADD COLUMN server_source_id TEXT")
  }
  database.exec(`
    DELETE FROM note_history
    WHERE id IN (
      SELECT id
      FROM (
        SELECT id, ROW_NUMBER() OVER (
          PARTITION BY note_id ORDER BY created_at DESC, id DESC
        ) AS position
        FROM note_history
      )
      WHERE position > 50
    )
  `)
  database.exec("CREATE INDEX IF NOT EXISTS idx_folders_parent ON folders(parent_id, sort_order)")
  database.exec("CREATE INDEX IF NOT EXISTS idx_folders_deleted ON folders(is_deleted, deleted_root_id)")
  return createRepository(database)
}

/**
 * 将数据库笔记行转换为渲染层结构。
 *
 * @param {Record<string, any>} row 数据库行。
 * @param {Array<{ id: string, name: string }>} tags 标签列表。
 * @returns {Record<string, any>} 笔记对象。
 */
function mapNote(row, tags = []) {
  return {
    id: row.id,
    serverId: row.server_id,
    folderId: row.folder_id,
    title: row.title,
    content: row.content,
    isPinned: Boolean(row.is_pinned),
    isDeleted: Boolean(row.is_deleted),
    deletedAt: row.deleted_at,
    deletedByFolderId: row.deleted_by_folder_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    serverUpdatedAt: row.server_updated_at,
    revision: row.revision,
    dirty: Boolean(row.dirty),
    tags
  }
}

/**
 * 构造 SQLite 仓储操作。
 *
 * @param {Database.Database} database SQLite 连接。
 * @returns {Record<string, Function>} 仓储方法。
 */
function createRepository(database) {
  /**
   * 使用 SQLite 在线备份 API 创建一致性数据库快照。
   *
   * @param {string} targetPath 目标备份文件路径。
   * @returns {Promise<Record<string, any>>} SQLite 备份元数据。
   */
  async function backupTo(targetPath) {
    return database.backup(targetPath)
  }

  const selectTagsForNote = database.prepare(`
    SELECT t.id, t.name
    FROM tags t
    JOIN note_tags nt ON nt.tag_id = t.id
    WHERE nt.note_id = ?
    ORDER BY t.name COLLATE NOCASE
  `)

  /**
   * 将图片资源的旧目录前缀替换为当前档案目录。
   *
   * @param {string} previousDirectory 迁移前的图片资源目录。
   * @param {string} currentDirectory 迁移后的图片资源目录。
   * @returns {number} 更新的图片资源数量。
   */
  function relocateImageAssetPaths(previousDirectory, currentDirectory) {
    const result = database.prepare(`
      UPDATE note_assets
      SET local_path = replace(local_path, ?, ?)
      WHERE local_path = ? OR local_path LIKE ?
    `).run(
      previousDirectory,
      currentDirectory,
      previousDirectory,
      `${previousDirectory}${path.sep}%`
    )
    return result.changes
  }

  /**
   * 添加或合并待同步操作。
   *
   * @param {string} entityType 实体类型。
   * @param {string} entityId 本地实体 ID。
   * @param {string} operation 操作类型。
   * @param {object} payload 操作数据。
   * @returns {void}
   */
  function enqueue(entityType, entityId, operation, payload) {
    database.prepare("DELETE FROM outbox WHERE entity_type = ? AND entity_id = ?")
      .run(entityType, entityId)
    database.prepare(`
      INSERT INTO outbox(entity_type, entity_id, operation, payload, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(entityType, entityId, operation, JSON.stringify(payload), nowIso())
  }

  /**
   * 获取单篇笔记。
   *
   * @param {string} noteId 笔记 ID。
   * @returns {Record<string, any> | null} 笔记详情。
   */
  function getNote(noteId) {
    const row = database.prepare("SELECT * FROM notes WHERE id = ?").get(noteId)
    return row ? mapNote(row, selectTagsForNote.all(noteId)) : null
  }

  /**
   * 将本地图片地址替换为已上传的云端地址。
   *
   * @param {unknown} content Markdown 正文。
   * @returns {string} 适合发送到云端的正文。
   */
  function expandImageAssetReferences(content) {
    let markdown = String(content || "")
    const assets = database.prepare(`
      SELECT * FROM note_assets WHERE remote_url IS NOT NULL ORDER BY created_at
    `).all()
    for (const row of assets) {
      markdown = markdown.split(`${LOCAL_ASSET_URL_PREFIX}${row.id}`).join(row.remote_url)
      markdown = markdown.split(`${INTERNAL_ATTACHMENT_URL_PREFIX}${row.id}`).join(row.remote_url)
    }
    return markdown
  }

  /**
   * 将云端图片地址恢复为当前设备的离线地址。
   *
   * @param {unknown} content Markdown 正文。
   * @returns {string} 适合本地编辑和预览的正文。
   */
  function localizeImageAssetReferences(content) {
    let markdown = String(content || "")
    const assets = database.prepare("SELECT * FROM note_assets ORDER BY created_at").all()
    for (const row of assets) {
      const isImage = String(row.mime_type || "").startsWith("image/")
      if (isImage && row.remote_url) {
        markdown = markdown.split(row.remote_url).join(`${LOCAL_ASSET_URL_PREFIX}${row.id}`)
        continue
      }
      if (isImage) continue
      const attachmentUrl = row.remote_url || `${INTERNAL_ATTACHMENT_URL_PREFIX}${row.id}`
      markdown = markdown.split(`${LOCAL_ASSET_URL_PREFIX}${row.id}`).join(attachmentUrl)
      markdown = markdown.split(`${INTERNAL_ATTACHMENT_URL_PREFIX}${row.id}`).join(attachmentUrl)
    }
    return markdown
  }

  /**
   * 提取尚未缓存的 Markdown 远程图片地址。
   *
   * @returns {string[]} 远程图片地址。
   */
  function listRemoteImageUrlsToCache() {
    const knownUrls = new Set(
      database.prepare("SELECT remote_url FROM note_assets WHERE remote_url IS NOT NULL")
        .all()
        .map((row) => row.remote_url)
    )
    const urls = new Set()
    const rows = database.prepare(`
      SELECT content FROM notes
      UNION ALL
      SELECT content FROM note_history
    `).all()
    const imagePattern = /!\[[^\]]*]\((https?:\/\/[^)\s]+)(?:\s+["'][^)]*["'])?\)/gi
    for (const row of rows) {
      for (const match of String(row.content || "").matchAll(imagePattern)) {
        if (!knownUrls.has(match[1])) urls.add(match[1])
      }
    }
    return [...urls]
  }

  /**
   * 提取尚未缓存的 Markdown 远程附件引用。
   *
   * @returns {Array<{ url: string, fileName: string, mimeType: string, byteSize: number }>} 远程附件信息。
   */
  function listRemoteAttachmentReferencesToCache() {
    const knownUrls = new Set(
      database.prepare("SELECT remote_url FROM note_assets WHERE remote_url IS NOT NULL")
        .all()
        .map((row) => row.remote_url)
    )
    const references = new Map()
    const rows = database.prepare(`
      SELECT content FROM notes
      UNION ALL
      SELECT content FROM note_history
    `).all()
    const attachmentPattern = /\[((?:\\.|[^\\\]])+)\]\((https?:\/\/[^)\s]+)\s+["']attachment\|([^|"']*)\|(\d+)["']\)/gi
    for (const row of rows) {
      for (const match of String(row.content || "").matchAll(attachmentPattern)) {
        if (knownUrls.has(match[2])) continue
        references.set(match[2], {
          url: match[2],
          fileName: match[1]
            .replaceAll("\\[", "[")
            .replaceAll("\\]", "]")
            .replaceAll("\\\\", "\\"),
          mimeType: decodeURIComponent(match[3] || "application/octet-stream"),
          byteSize: Number(match[4] || 0)
        })
      }
    }
    return [...references.values()]
  }

  /**
   * 创建或复用本地图片资源。
   *
   * :param {object} input: 图片资源信息。
   * :return: 图片资源对象。
   *
   * @param {{ fileName: string, mimeType: string, byteSize: number, sha256: string, localPath: string }} input 图片资源信息。
   * @returns {Record<string, any>} 图片资源对象。
   */
  function createImageAsset(input) {
    const existing = database.prepare("SELECT * FROM note_assets WHERE sha256 = ?").get(input.sha256)
    const timestamp = nowIso()
    if (existing) {
      database.prepare(`
        UPDATE note_assets
        SET file_name = ?, mime_type = ?, byte_size = ?, local_path = ?, updated_at = ?
        WHERE id = ?
      `).run(
        input.fileName,
        input.mimeType,
        input.byteSize,
        input.localPath,
        timestamp,
        existing.id
      )
      return mapImageAsset(database.prepare("SELECT * FROM note_assets WHERE id = ?").get(existing.id))
    }
    const id = input.id || randomUUID()
    database.prepare(`
      INSERT INTO note_assets(
        id, file_name, mime_type, byte_size, sha256, local_path, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      input.fileName,
      input.mimeType,
      input.byteSize,
      input.sha256,
      input.localPath,
      timestamp,
      timestamp
    )
    return mapImageAsset(database.prepare("SELECT * FROM note_assets WHERE id = ?").get(id))
  }

  /**
   * 获取本地图片资源。
   *
   * @param {string} assetId 图片资源 ID。
   * @returns {Record<string, any> | null} 图片资源对象。
   */
  function getImageAsset(assetId) {
    const row = database.prepare("SELECT * FROM note_assets WHERE id = ?").get(assetId)
    return row ? mapImageAsset(row) : null
  }

  /**
   * 获取尚未上传的本地图片资源。
   *
   * @returns {Record<string, any>[]} 待上传图片资源。
   */
  function listPendingImageAssets() {
    return database.prepare(`
      SELECT * FROM note_assets WHERE remote_url IS NULL ORDER BY created_at
    `).all().map(mapImageAsset)
  }

  /**
   * 获取全部本地图片资源。
   *
   * @returns {Record<string, any>[]} 图片资源列表。
   */
  function listImageAssets() {
    return database.prepare(`
      SELECT * FROM note_assets ORDER BY created_at
    `).all().map(mapImageAsset)
  }

  /**
   * 记录图片资源上传后的云端地址。
   *
   * @param {string} assetId 图片资源 ID。
   * @param {string} remoteUrl 云端图片地址。
   * @param {string | null} serverSourceId 服务端资源 ID。
   * @returns {Record<string, any> | null} 更新后的图片资源。
   */
  function markImageAssetUploaded(assetId, remoteUrl, serverSourceId = null) {
    database.prepare(`
      UPDATE note_assets
      SET remote_url = ?,
          server_source_id = COALESCE(?, server_source_id),
          updated_at = ?
      WHERE id = ?
    `).run(remoteUrl, serverSourceId ? String(serverSourceId) : null, nowIso(), assetId)
    return getImageAsset(assetId)
  }

  /**
   * 获取单个文件夹。
   *
   * @param {string} folderId 文件夹 ID。
   * @returns {Record<string, any> | null} 文件夹详情。
   */
  function getFolder(folderId) {
    const row = database.prepare(`
      SELECT id, server_id AS serverId, parent_id AS parentId, name,
             sort_order AS sortOrder, is_deleted AS isDeleted,
             deleted_at AS deletedAt, deleted_root_id AS deletedRootId,
             created_at AS createdAt,
             updated_at AS updatedAt, server_updated_at AS serverUpdatedAt, dirty
      FROM folders WHERE id = ?
    `).get(folderId)
    return row ? { ...row, isDeleted: Boolean(row.isDeleted), dirty: Boolean(row.dirty) } : null
  }

  /**
   * 获取离线工作区完整数据。
   *
   * @returns {object} 文件夹、标签、笔记与同步统计。
   */
  function listWorkspace() {
    const folders = database.prepare(`
      SELECT id, server_id AS serverId, parent_id AS parentId, name, sort_order AS sortOrder,
             is_deleted AS isDeleted, deleted_at AS deletedAt,
             deleted_root_id AS deletedRootId, created_at AS createdAt,
             updated_at AS updatedAt, dirty
             , server_updated_at AS serverUpdatedAt
      FROM folders ORDER BY sort_order, name COLLATE NOCASE
    `).all().map((folder) => ({
      ...folder,
      isDeleted: Boolean(folder.isDeleted),
      dirty: Boolean(folder.dirty)
    }))
    const tags = database.prepare(`
      SELECT id, server_id AS serverId, name, created_at AS createdAt,
             updated_at AS updatedAt, server_updated_at AS serverUpdatedAt, dirty
      FROM tags
      ORDER BY
        CASE WHEN server_id IS NULL THEN 1 ELSE 0 END,
        CAST(server_id AS INTEGER),
        created_at,
        name COLLATE NOCASE
    `).all().map((tag) => ({ ...tag, dirty: Boolean(tag.dirty) }))
    const notes = database.prepare(`
      SELECT * FROM notes ORDER BY is_pinned DESC, updated_at DESC
    `).all().map((row) => {
      const note = mapNote(row, selectTagsForNote.all(row.id))
      return { ...note, content: localizeImageAssetReferences(note.content) }
    })
    const pendingCount = database.prepare("SELECT COUNT(*) AS total FROM outbox").get().total
    return { folders, tags, notes, pendingCount }
  }

  /**
   * 创建一篇本地笔记。
   *
   * @param {string | null} folderId 文件夹 ID。
   * @returns {Record<string, any>} 新笔记。
   */
  function createNote(folderId = null) {
    const id = randomUUID()
    const timestamp = nowIso()
    database.prepare(`
      INSERT INTO notes(id, folder_id, title, content, created_at, updated_at)
      VALUES (?, ?, '无标题笔记', '', ?, ?)
    `).run(id, folderId, timestamp, timestamp)
    const note = getNote(id)
    enqueue("note", id, "upsert", note)
    return note
  }

  /**
   * 复制一篇笔记到指定文件夹。
   *
   * @param {string} noteId 原笔记 ID。
   * @param {string | null | undefined} targetFolderId 目标文件夹 ID；省略时保留原位置。
   * @param {string | undefined} requestedTitle 用户指定的副本标题。
   * @returns {Record<string, any>} 新建的笔记副本。
   */
  const duplicateNote = database.transaction((noteId, targetFolderId = undefined, requestedTitle = undefined) => {
    const source = database.prepare("SELECT * FROM notes WHERE id = ?").get(noteId)
    if (!source || source.is_deleted) throw new Error("原笔记不存在或已被删除")
    const folderId = targetFolderId === undefined ? source.folder_id : targetFolderId || null
    if (folderId) {
      const folder = getFolder(folderId)
      if (!folder || folder.isDeleted) throw new Error("目标文件夹不存在")
    }
    const id = randomUUID()
    const timestamp = nowIso()
    const defaultTitle = `${source.title.slice(0, 97)} 副本`
    const title = (typeof requestedTitle === "string" ? requestedTitle.trim().slice(0, 100) : "") || defaultTitle
    const content = localizeImageAssetReferences(source.content)
    database.prepare(`
      INSERT INTO notes(id, folder_id, title, content, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(id, folderId, title, content, timestamp, timestamp)
    replaceNoteTags(id, selectTagsForNote.all(noteId).map((tag) => tag.name))
    const note = getNote(id)
    enqueue("note", id, "upsert", note)
    return note
  })

  /** 创建一篇已填写内容的快速记录。 */
  const createQuickNote = database.transaction((input = {}) => {
    const content = validateNoteContent(typeof input.content === "string" ? input.content.trim() : "")
    const requestedTitle = typeof input.title === "string" ? input.title.trim() : ""
    if (!requestedTitle && !content) throw new Error("快速记录内容不能为空")
    const folderId = typeof input.folderId === "string" && input.folderId ? input.folderId : null
    if (folderId) {
      const folder = getFolder(folderId)
      if (!folder || folder.isDeleted) throw new Error("目标文件夹不存在")
    }
    const generatedTitle = Array.from(content.replace(/\s+/g, " ").trim()).slice(0, 30).join("")
    const title = (requestedTitle || generatedTitle || "快速记录").slice(0, 100)
    const id = randomUUID()
    const timestamp = nowIso()
    database.prepare(`
      INSERT INTO notes(id, folder_id, title, content, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(id, folderId, title, content, timestamp, timestamp)
    const note = getNote(id)
    enqueue("note", id, "upsert", note)
    return note
  })

  /**
   * 为当前笔记按时间间隔保存历史快照。
   *
   * @param {Record<string, any>} current 当前数据库行。
   * @param {boolean} force 是否忽略时间间隔强制保存。
   * @returns {void}
   */
  function createHistoryIfNeeded(current, force = false) {
    const latest = database.prepare(`
      SELECT created_at FROM note_history WHERE note_id = ? ORDER BY created_at DESC LIMIT 1
    `).get(current.id)
    if (!force && latest && Date.now() - Date.parse(latest.created_at) < HISTORY_INTERVAL_MS) return
    const tagNames = selectTagsForNote.all(current.id).map((tag) => tag.name)
    database.prepare(`
      INSERT INTO note_history(id, note_id, title, content, folder_id, tag_names, created_at, dirty)
      VALUES (?, ?, ?, ?, ?, ?, ?, 1)
    `).run(
      randomUUID(),
      current.id,
      current.title,
      current.content,
      current.folder_id,
      JSON.stringify(tagNames),
      nowIso()
    )
    database.prepare(`
      DELETE FROM note_history
      WHERE note_id = ? AND id NOT IN (
        SELECT id FROM note_history WHERE note_id = ? ORDER BY created_at DESC LIMIT 50
      )
    `).run(current.id, current.id)
  }

  /**
   * 查询笔记历史版本列表。
   *
   * @param {string} noteId 笔记 ID。
   * @returns {Array<Record<string, any>>} 按时间倒序排列的历史版本。
   */
  function listNoteHistory(noteId) {
    return database.prepare(`
      SELECT id, note_id AS noteId, title, substr(content, 1, 480) AS contentPrefix,
             folder_id AS folderId,
             tag_names AS tagNames, created_at AS createdAt
      FROM note_history
      WHERE note_id = ?
      ORDER BY created_at DESC
      LIMIT 50
    `).all(noteId).map((history) => ({
      id: history.id,
      noteId: history.noteId,
      title: history.title,
      content: "",
      folderId: history.folderId,
      tagNames: JSON.parse(history.tagNames || "[]"),
      createdAt: history.createdAt,
      contentPreview: createHistoryContentPreview(history.contentPrefix)
    }))
  }

  /**
   * 按需查询一条历史版本的完整正文。
   *
   * @param {string} noteId 笔记 ID。
   * @param {string} historyId 历史版本 ID。
   * @returns {Record<string, any> | null} 历史版本详情，不存在时返回空值。
   */
  function getNoteHistory(noteId, historyId) {
    const history = database.prepare(`
      SELECT id, note_id AS noteId, title, content, folder_id AS folderId,
             tag_names AS tagNames, created_at AS createdAt
      FROM note_history
      WHERE id = ? AND note_id = ?
    `).get(historyId, noteId)
    if (!history) return null
    return {
      ...history,
      content: localizeImageAssetReferences(history.content),
      tagNames: JSON.parse(history.tagNames || "[]"),
      contentPreview: createHistoryContentPreview(history.content.slice(0, 480))
    }
  }

  /**
   * 恢复指定历史版本，并先强制保留当前内容快照。
   *
   * @param {string} noteId 笔记 ID。
   * @param {string} historyId 历史版本 ID。
   * @returns {Record<string, any> | null} 恢复后的笔记。
   */
  const restoreNoteHistory = database.transaction((noteId, historyId) => {
    const current = database.prepare("SELECT * FROM notes WHERE id = ?").get(noteId)
    const history = database.prepare(`
      SELECT * FROM note_history WHERE id = ? AND note_id = ?
    `).get(historyId, noteId)
    if (!current || !history) return null
    const restoredContent = validateNoteContent(history.content)
    createHistoryIfNeeded(current, true)
    const timestamp = nowIso()
    database.prepare(`
      UPDATE notes
      SET title = ?, content = ?, folder_id = ?, updated_at = ?, dirty = 1
      WHERE id = ?
    `).run(history.title, restoredContent, history.folder_id, timestamp, noteId)
    replaceNoteTags(noteId, JSON.parse(history.tag_names || "[]"))
    const note = getNote(noteId)
    enqueue("note", noteId, "upsert", note)
    return note
  })

  /**
   * 删除一条本地历史版本。
   *
   * @param {string} noteId 笔记 ID。
   * @param {string} historyId 历史版本 ID。
   * @returns {boolean} 是否删除成功。
   */
  function deleteNoteHistory(noteId, historyId) {
    const result = database.prepare(`
      DELETE FROM note_history WHERE id = ? AND note_id = ?
    `).run(historyId, noteId)
    if (result.changes) {
      enqueue("history", historyId, "delete", { id: historyId, serverId: null })
    }
    return Boolean(result.changes)
  }

  /**
   * 规范化笔记标签名称。
   *
   * @param {string[]} tagNames 标签名称。
   * @returns {string[]} 去重并限制数量后的标签名称。
   */
  function normalizeTagNames(tagNames) {
    return [...new Set(tagNames.map((name) => name.trim()).filter(Boolean))].slice(0, 12)
  }

  /**
   * 判断两组标签名称是否表示同一集合。
   *
   * @param {string[]} left 左侧标签名称。
   * @param {string[]} right 右侧标签名称。
   * @returns {boolean} 忽略顺序后完全相同时返回 true。
   */
  function haveSameTagNames(left, right) {
    if (left.length !== right.length) return false
    const normalizedLeft = [...left].sort((first, second) => first.localeCompare(second))
    const normalizedRight = [...right].sort((first, second) => first.localeCompare(second))
    return normalizedLeft.every((name, index) => name === normalizedRight[index])
  }

  /**
   * 替换笔记标签关系并自动创建缺失标签。
   *
   * @param {string} noteId 笔记 ID。
   * @param {string[]} tagNames 标签名称。
   * @returns {void}
   */
  function replaceNoteTags(noteId, tagNames) {
    const normalizedNames = normalizeTagNames(tagNames)
    database.prepare("DELETE FROM note_tags WHERE note_id = ?").run(noteId)
    const findTag = database.prepare("SELECT id FROM tags WHERE name = ? COLLATE NOCASE")
    const insertTag = database.prepare(`
      INSERT INTO tags(id, name, created_at, updated_at) VALUES (?, ?, ?, ?)
    `)
    const insertRelation = database.prepare(`
      INSERT OR IGNORE INTO note_tags(note_id, tag_id) VALUES (?, ?)
    `)
    for (const name of normalizedNames) {
      let tag = findTag.get(name)
      if (!tag) {
        const tagId = randomUUID()
        const timestamp = nowIso()
        insertTag.run(tagId, name, timestamp, timestamp)
        tag = { id: tagId }
        enqueue("tag", tagId, "upsert", { id: tagId, name })
      }
      insertRelation.run(noteId, tag.id)
    }
  }

  /**
   * 更新笔记及其标签。
   *
   * @param {string} noteId 笔记 ID。
   * @param {Record<string, any>} patch 更新内容。
   * @returns {Record<string, any> | null} 更新后的笔记。
   */
  const updateNote = database.transaction((noteId, patch) => {
    const current = database.prepare("SELECT * FROM notes WHERE id = ?").get(noteId)
    if (!current) return null
    const nextContent = typeof patch.content === "string"
      ? validateNoteContent(patch.content)
      : current.content
    const currentTagNames = selectTagsForNote.all(noteId).map((tag) => tag.name)
    const nextTagNames = Array.isArray(patch.tagNames)
      ? normalizeTagNames(patch.tagNames)
      : currentTagNames
    const next = {
      title: (typeof patch.title === "string" ? patch.title.slice(0, 100) : current.title) || "无标题笔记",
      content: nextContent,
      folderId: Object.hasOwn(patch, "folderId") ? patch.folderId : current.folder_id,
      isPinned: typeof patch.isPinned === "boolean" ? Number(patch.isPinned) : current.is_pinned,
      updatedAt: current.updated_at
    }
    if (
      next.title === current.title
      && next.content === current.content
      && next.folderId === current.folder_id
      && next.isPinned === current.is_pinned
      && haveSameTagNames(nextTagNames, currentTagNames)
    ) return getNote(noteId)
    if (
      next.title !== current.title
      || next.content !== current.content
    ) createHistoryIfNeeded(current)
    next.updatedAt = nowIso()
    database.prepare(`
      UPDATE notes
      SET title = ?, content = ?, folder_id = ?, is_pinned = ?, updated_at = ?, dirty = 1
      WHERE id = ?
    `).run(next.title, next.content, next.folderId, next.isPinned, next.updatedAt, noteId)
    if (Array.isArray(patch.tagNames)) replaceNoteTags(noteId, nextTagNames)
    const note = getNote(noteId)
    enqueue("note", noteId, "upsert", note)
    return note
  })

  /**
   * 修改笔记回收站状态。
   *
   * @param {string} noteId 笔记 ID。
   * @param {boolean} deleted 是否进入回收站。
   * @returns {Record<string, any> | null} 更新后的笔记。
   */
  function setNoteDeleted(noteId, deleted) {
    const timestamp = nowIso()
    database.prepare(`
      UPDATE notes
      SET is_deleted = ?, deleted_at = ?, deleted_by_folder_id = NULL,
          updated_at = ?, dirty = 1
      WHERE id = ?
    `).run(Number(deleted), deleted ? timestamp : null, timestamp, noteId)
    const note = getNote(noteId)
    if (note) enqueue("note", noteId, "upsert", note)
    return note
  }

  /**
   * 永久删除笔记并保留待同步墓碑。
   *
   * @param {string} noteId 笔记 ID。
   * @returns {boolean} 是否删除成功。
   */
  function deleteNotePermanently(noteId) {
    const current = getNote(noteId)
    if (!current) return false
    const result = database.prepare("DELETE FROM notes WHERE id = ? AND is_deleted = 1").run(noteId)
    if (result.changes) enqueue("note", noteId, "delete", { id: noteId, serverId: current.serverId })
    return Boolean(result.changes)
  }

  /**
   * 永久删除回收站中的全部文件夹、笔记并保留待同步墓碑。
   *
   * @returns {number} 实际删除的文件夹和笔记数量。
   */
  const emptyTrash = database.transaction(() => {
    const deletedFolderRoots = database.prepare(`
      SELECT id FROM folders
      WHERE is_deleted = 1 AND deleted_root_id = id
      ORDER BY deleted_at
    `).all()
    let deletedCount = 0
    for (const folder of deletedFolderRoots) {
      deletedCount += deleteFolderPermanentlyInternal(folder.id)
    }
    const deletedNotes = database.prepare("SELECT id, server_id AS serverId FROM notes WHERE is_deleted = 1").all()
    const result = database.prepare("DELETE FROM notes WHERE is_deleted = 1").run()
    for (const note of deletedNotes) {
      enqueue("note", note.id, "delete", { id: note.id, serverId: note.serverId })
    }
    return deletedCount + result.changes
  })

  /**
   * 创建文件夹。
   *
   * @param {string} name 文件夹名称。
   * @param {string | null} parentId 父文件夹 ID。
   * @returns {Record<string, any>} 新文件夹。
   */
  function createFolder(name, parentId = null) {
    const normalizedName = String(name || "").trim().slice(0, 60)
    if (!normalizedName) throw new Error("文件夹名称不能为空")
    if (parentId && !getFolder(parentId)) throw new Error("父文件夹不存在")
    const id = randomUUID()
    const timestamp = nowIso()
    const sortOrder = database.prepare(`
      SELECT COALESCE(MAX(sort_order), -1) + 1 AS value FROM folders WHERE parent_id IS ?
    `).get(parentId).value
    database.prepare(`
      INSERT INTO folders(id, parent_id, name, sort_order, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(id, parentId, normalizedName, sortOrder, timestamp, timestamp)
    const folder = {
      id,
      serverId: null,
      parentId,
      name: normalizedName,
      sortOrder,
      isDeleted: false,
      deletedAt: null,
      deletedRootId: null,
      createdAt: timestamp,
      updatedAt: timestamp,
      dirty: true
    }
    enqueue("folder", id, "upsert", folder)
    return folder
  }

  /**
   * 重命名文件夹。
   *
   * @param {string} folderId 文件夹 ID。
   * @param {string} name 新文件夹名称。
   * @returns {Record<string, any> | null} 更新后的文件夹，不存在时返回空值。
   */
  function renameFolder(folderId, name) {
    const normalizedName = String(name || "").trim().slice(0, 60)
    if (!normalizedName) throw new Error("文件夹名称不能为空")
    const timestamp = nowIso()
    const result = database.prepare(`
      UPDATE folders SET name = ?, updated_at = ?, dirty = 1 WHERE id = ?
    `).run(normalizedName, timestamp, folderId)
    if (!result.changes) return null
    const folder = getFolder(folderId)
    enqueue("folder", folderId, "upsert", folder)
    return folder
  }

  /**
   * 移动文件夹并重新编号来源与目标层级的排序值。
   *
   * @param {string} folderId 待移动文件夹 ID。
   * @param {string | null} parentId 新父文件夹 ID。
   * @param {string | null} beforeFolderId 新层级中排在其前面的文件夹 ID，空值表示末尾。
   * @returns {Record<string, any>} 移动后的文件夹。
   */
  const moveFolder = database.transaction((folderId, parentId = null, beforeFolderId = null) => {
    const current = getFolder(folderId)
    if (!current || current.isDeleted) throw new Error("文件夹不存在")
    if (folderId === parentId) throw new Error("文件夹不能移动到自身或子文件夹")
    let ancestorId = parentId
    const visited = new Set()
    while (ancestorId) {
      if (ancestorId === folderId || visited.has(ancestorId)) {
        throw new Error("文件夹不能移动到自身或子文件夹")
      }
      visited.add(ancestorId)
      const ancestor = getFolder(ancestorId)
      if (!ancestor || ancestor.isDeleted) throw new Error("目标文件夹不存在")
      ancestorId = ancestor.parentId
    }
    if (beforeFolderId === folderId) beforeFolderId = null
    if (beforeFolderId) {
      const beforeFolder = getFolder(beforeFolderId)
      if (!beforeFolder || beforeFolder.isDeleted || beforeFolder.parentId !== parentId) {
        throw new Error("目标排序位置无效")
      }
    }

    const timestamp = nowIso()
    const sourceParentId = current.parentId
    database.prepare("UPDATE folders SET parent_id = ? WHERE id = ?").run(parentId, folderId)
    const affectedIds = new Set([folderId])

    /**
     * 按指定顺序持久化同级文件夹。
     *
     * @param {string | null} siblingParentId 父文件夹 ID。
     * @param {string | null} movingId 要插入的文件夹 ID。
     * @param {string | null} beforeId 插入位置后的文件夹 ID。
     * @returns {void}
     */
    function reorderSiblings(siblingParentId, movingId = null, beforeId = null) {
      const siblingIds = database.prepare(`
        SELECT id FROM folders
        WHERE parent_id IS ? AND is_deleted = 0 AND id != ?
        ORDER BY sort_order, name COLLATE NOCASE
      `).all(siblingParentId, movingId || "").map((folder) => folder.id)
      if (movingId) {
        const insertionIndex = beforeId ? siblingIds.indexOf(beforeId) : siblingIds.length
        siblingIds.splice(insertionIndex < 0 ? siblingIds.length : insertionIndex, 0, movingId)
      }
      const updateOrder = database.prepare(`
        UPDATE folders SET sort_order = ?, updated_at = ?, dirty = 1 WHERE id = ?
      `)
      siblingIds.forEach((id, index) => {
        updateOrder.run(index, timestamp, id)
        affectedIds.add(id)
      })
    }

    if (sourceParentId !== parentId) reorderSiblings(sourceParentId)
    reorderSiblings(parentId, folderId, beforeFolderId)
    for (const id of affectedIds) enqueue("folder", id, "upsert", getFolder(id))
    return getFolder(folderId)
  })

  /**
   * 收集指定状态下的文件夹子树。
   *
   * @param {string} rootId 根文件夹 ID。
   * @param {boolean} deleted 是否查询回收站文件夹。
   * @returns {string[]} 从根节点开始的文件夹 ID。
   */
  function collectFolderSubtreeIds(rootId, deleted) {
    const folders = database.prepare(`
      SELECT id, parent_id AS parentId
      FROM folders
      WHERE is_deleted = ?
      ORDER BY sort_order, name COLLATE NOCASE
    `).all(Number(deleted))
    const folderIds = new Set(folders.map((folder) => folder.id))
    if (!folderIds.has(rootId)) return []
    const childIds = new Map()
    for (const folder of folders) {
      if (!folder.parentId) continue
      const children = childIds.get(folder.parentId) || []
      children.push(folder.id)
      childIds.set(folder.parentId, children)
    }
    const result = []
    const pending = [rootId]
    while (pending.length) {
      const currentId = pending.pop()
      result.push(currentId)
      pending.push(...(childIds.get(currentId) || []).reverse())
    }
    return result
  }

  /**
   * 将文件夹子树及其中未删除笔记移入回收站。
   *
   * @param {string} folderId 文件夹 ID。
   * @returns {boolean} 是否删除成功。
   */
  const setFolderDeleted = database.transaction((folderId) => {
    const folderIds = collectFolderSubtreeIds(folderId, false)
    if (!folderIds.length) return false
    const placeholders = folderIds.map(() => "?").join(",")
    const timestamp = nowIso()
    const noteIds = database.prepare(`
      SELECT id FROM notes
      WHERE folder_id IN (${placeholders}) AND is_deleted = 0
    `).all(...folderIds).map((note) => note.id)
    database.prepare(`
      UPDATE folders
      SET is_deleted = 1, deleted_at = ?, deleted_root_id = ?,
          updated_at = ?, dirty = 1
      WHERE id IN (${placeholders}) AND is_deleted = 0
    `).run(timestamp, folderId, timestamp, ...folderIds)
    database.prepare(`
      UPDATE notes
      SET is_deleted = 1, deleted_at = ?, deleted_by_folder_id = ?,
          updated_at = ?, dirty = 1
      WHERE folder_id IN (${placeholders}) AND is_deleted = 0
    `).run(timestamp, folderId, timestamp, ...folderIds)
    for (const currentFolderId of folderIds) {
      const currentFolder = getFolder(currentFolderId)
      if (currentFolder) enqueue("folder", currentFolderId, "upsert", currentFolder)
    }
    for (const noteId of noteIds) {
      const note = getNote(noteId)
      if (note) enqueue("note", noteId, "upsert", note)
    }
    return true
  })

  /**
   * 恢复同一次删除操作移入回收站的文件夹子树及笔记。
   *
   * @param {string} folderId 删除操作的根文件夹 ID。
   * @returns {boolean} 是否恢复成功。
   */
  const restoreFolder = database.transaction((folderId) => {
    const folderIds = database.prepare(`
      SELECT id FROM folders
      WHERE is_deleted = 1 AND deleted_root_id = ?
      ORDER BY sort_order, name COLLATE NOCASE
    `).all(folderId).map((folder) => folder.id)
    if (!folderIds.includes(folderId)) return false
    const placeholders = folderIds.map(() => "?").join(",")
    const noteIds = database.prepare(`
      SELECT id FROM notes WHERE deleted_by_folder_id = ?
    `).all(folderId).map((note) => note.id)
    const timestamp = nowIso()
    database.prepare(`
      UPDATE folders
      SET is_deleted = 0, deleted_at = NULL, deleted_root_id = NULL,
          updated_at = ?, dirty = 1
      WHERE id IN (${placeholders})
    `).run(timestamp, ...folderIds)
    database.prepare(`
      UPDATE notes
      SET is_deleted = 0, deleted_at = NULL, deleted_by_folder_id = NULL,
          updated_at = ?, dirty = 1
      WHERE deleted_by_folder_id = ?
    `).run(timestamp, folderId)
    for (const currentFolderId of folderIds) {
      enqueue("folder", currentFolderId, "upsert", getFolder(currentFolderId))
    }
    for (const noteId of noteIds) enqueue("note", noteId, "upsert", getNote(noteId))
    return true
  })

  /**
   * 永久删除回收站中的文件夹子树及随文件夹删除的笔记。
   *
   * @param {string} folderId 删除操作的根文件夹 ID。
   * @returns {boolean} 是否删除成功。
   */
  /**
   * 在当前事务内永久删除一个文件夹删除批次。
   *
   * @param {string} folderId 删除操作的根文件夹 ID。
   * @returns {number} 实际删除的文件夹和笔记数量。
   */
  function deleteFolderPermanentlyInternal(folderId) {
    const folders = database.prepare(`
      SELECT id, server_id AS serverId FROM folders
      WHERE is_deleted = 1 AND deleted_root_id = ?
    `).all(folderId)
    if (!folders.some((folder) => folder.id === folderId)) return false
    const folderIds = folders.map((folder) => folder.id)
    const placeholders = folderIds.map(() => "?").join(",")
    const deletedNotes = database.prepare(`
      SELECT id, server_id AS serverId FROM notes WHERE deleted_by_folder_id = ?
    `).all(folderId)
    const retainedNoteIds = database.prepare(`
      SELECT id FROM notes
      WHERE folder_id IN (${placeholders}) AND deleted_by_folder_id IS NULL
    `).all(...folderIds).map((note) => note.id)
    database.prepare("DELETE FROM notes WHERE deleted_by_folder_id = ?").run(folderId)
    database.prepare(`
      UPDATE notes SET folder_id = NULL, updated_at = ?, dirty = 1
      WHERE folder_id IN (${placeholders})
    `).run(nowIso(), ...folderIds)
    database.prepare(`
      DELETE FROM folders WHERE id IN (${placeholders})
    `).run(...folderIds)
    for (const note of deletedNotes) {
      enqueue("note", note.id, "delete", { id: note.id, serverId: note.serverId })
    }
    for (const noteId of retainedNoteIds) enqueue("note", noteId, "upsert", getNote(noteId))
    for (const folder of folders) {
      enqueue("folder", folder.id, "delete", { id: folder.id, serverId: folder.serverId })
    }
    return folders.length + deletedNotes.length
  }

  const deleteFolderPermanently = database.transaction((folderId) => {
    return Boolean(deleteFolderPermanentlyInternal(folderId))
  })

  /**
   * 创建标签，名称重复时返回已有标签。
   *
   * @param {string} name 标签名称。
   * @returns {Record<string, any>} 新建或已存在的标签。
   */
  function createTag(name) {
    const normalizedName = String(name || "").trim().slice(0, 30)
    if (!normalizedName) throw new Error("标签名称不能为空")
    const existing = database.prepare(`
      SELECT id, server_id AS serverId, name, created_at AS createdAt,
             updated_at AS updatedAt, dirty
      FROM tags WHERE name = ? COLLATE NOCASE
    `).get(normalizedName)
    if (existing) return { ...existing, dirty: Boolean(existing.dirty) }
    const id = randomUUID()
    const timestamp = nowIso()
    database.prepare(`
      INSERT INTO tags(id, name, created_at, updated_at) VALUES (?, ?, ?, ?)
    `).run(id, normalizedName, timestamp, timestamp)
    const tag = {
      id,
      serverId: null,
      name: normalizedName,
      createdAt: timestamp,
      updatedAt: timestamp,
      dirty: true
    }
    enqueue("tag", id, "upsert", tag)
    return tag
  }

  /**
   * 删除标签并解除全部关联。
   *
   * @param {string} tagId 标签 ID。
   * @returns {boolean} 是否删除成功。
   */
  function deleteTag(tagId) {
    const tag = database.prepare("SELECT server_id AS serverId FROM tags WHERE id = ?").get(tagId)
    const result = database.prepare("DELETE FROM tags WHERE id = ?").run(tagId)
    if (result.changes) enqueue("tag", tagId, "delete", { id: tagId, serverId: tag?.serverId || null })
    return Boolean(result.changes)
  }

  /**
   * 导出可完整恢复的本地数据备份。
   *
   * @returns {Record<string, any>} 版本化备份数据。
   */
  function exportBackup() {
    const workspace = listWorkspace()
    const histories = database.prepare(`
      SELECT id, note_id AS noteId, title, content, folder_id AS folderId,
             tag_names AS tagNames, created_at AS createdAt
      FROM note_history
      ORDER BY note_id, created_at DESC
    `).all().map((history) => ({
      ...history,
      tagNames: JSON.parse(history.tagNames || "[]")
    }))
    return {
      format: "xinyue-notes-backup",
      version: 2,
      exportedAt: nowIso(),
      folders: workspace.folders,
      tags: workspace.tags,
      notes: workspace.notes,
      histories,
      assets: listImageAssets()
    }
  }

  /**
   * 将多篇 Markdown 文档作为新笔记导入指定文件夹。
   *
   * @param {Array<{ title: string, content: string, tagNames?: string[], folderPath?: string[] }>} documents 待导入文档。
   * @param {string | null} folderId 目标文件夹 ID。
   * @param {string} sourceFolderName 来源文件夹名称，传入时会保留目录层级。
   * @returns {{ importedFolders: number, importedNotes: number, noteIds: string[], rootFolderId?: string }} 导入结果。
   */
  const importMarkdownDocuments = database.transaction((
    documents,
    folderId = null,
    sourceFolderName = ""
  ) => {
    const targetFolderId = folderId && database.prepare(
      "SELECT id FROM folders WHERE id = ? AND is_deleted = 0"
    ).get(folderId) ? folderId : null
    const normalizedSourceName = String(sourceFolderName || "").trim().slice(0, 100)

    /**
     * 查找目标位置下可用于合并的同名文件夹。
     *
     * @param {string} name 文件夹名称。
     * @param {string | null} parentId 父文件夹 ID。
     * @returns {{ id: string } | null} 已存在文件夹。
     */
    function findImportFolder(name, parentId) {
      return database.prepare(`
        SELECT id
        FROM folders
        WHERE is_deleted = 0 AND name = ? COLLATE NOCASE AND parent_id IS ?
        ORDER BY sort_order, created_at
        LIMIT 1
      `).get(name, parentId) || null
    }

    const existingRootFolder = normalizedSourceName
      ? findImportFolder(normalizedSourceName, targetFolderId)
      : null
    const rootFolder = normalizedSourceName
      ? existingRootFolder || createFolder(normalizedSourceName, targetFolderId)
      : null
    const importedFolderIds = new Map()
    let importedFolders = rootFolder && !existingRootFolder ? 1 : 0
    const noteIds = []
    for (const document of documents) {
      let documentFolderId = rootFolder?.id || targetFolderId
      const folderPath = Array.isArray(document.folderPath) ? document.folderPath : []
      const normalizedPath = []
      for (const folderName of folderPath) {
        const normalizedName = String(folderName || "").trim().slice(0, 100)
        if (!normalizedName || normalizedName === "." || normalizedName === "..") continue
        normalizedPath.push(normalizedName)
        const folderKey = normalizedPath.join("\u0000")
        if (!importedFolderIds.has(folderKey)) {
          const existingFolder = findImportFolder(normalizedName, documentFolderId)
          const importedFolder = existingFolder || createFolder(normalizedName, documentFolderId)
          importedFolderIds.set(folderKey, importedFolder.id)
          if (!existingFolder) importedFolders += 1
        }
        documentFolderId = importedFolderIds.get(folderKey)
      }
      const id = randomUUID()
      const timestamp = nowIso()
      database.prepare(`
        INSERT INTO notes(
          id, folder_id, title, content, created_at, updated_at, dirty
        ) VALUES (?, ?, ?, ?, ?, ?, 1)
      `).run(
        id,
        documentFolderId,
        String(document.title || "无标题笔记").trim().slice(0, 100) || "无标题笔记",
        validateNoteContent(document.content),
        timestamp,
        timestamp
      )
      replaceNoteTags(id, Array.isArray(document.tagNames) ? document.tagNames : [])
      const note = getNote(id)
      enqueue("note", id, "upsert", note)
      noteIds.push(id)
    }
    return {
      importedFolders,
      importedNotes: noteIds.length,
      noteIds,
      ...(rootFolder ? { rootFolderId: rootFolder.id } : {})
    }
  })

  /**
   * 将完整备份作为独立副本导入当前数据库。
   *
   * @param {Record<string, any>} backup 版本化备份数据。
   * @returns {{ importedFolders: number, importedNotes: number, importedHistories: number, rootFolderId: string }} 导入结果。
   */
  const importBackup = database.transaction((backup) => {
    if (
      !backup
      || backup.format !== "xinyue-notes-backup"
      || ![1, 2].includes(Number(backup.version))
      || !Array.isArray(backup.folders)
      || !Array.isArray(backup.notes)
      || !Array.isArray(backup.histories)
    ) {
      throw new Error("备份文件格式不正确或版本不受支持")
    }
    const timestamp = nowIso()
    const rootName = `导入备份 ${timestamp.slice(0, 19).replace("T", " ")} ${randomUUID().slice(0, 4)}`
    const rootFolder = createFolder(rootName)
    const folderIds = new Map()
    const pendingFolders = backup.folders.map((folder) => ({ ...folder }))
    while (pendingFolders.length) {
      let progressed = false
      for (const folder of pendingFolders.slice()) {
        if (folder.parentId && !folderIds.has(folder.parentId)) continue
        const imported = createFolder(
          String(folder.name || "未命名文件夹").trim().slice(0, 100) || "未命名文件夹",
          folder.parentId ? folderIds.get(folder.parentId) : rootFolder.id
        )
        folderIds.set(folder.id, imported.id)
        pendingFolders.splice(pendingFolders.indexOf(folder), 1)
        progressed = true
      }
      if (progressed) continue
      for (const folder of pendingFolders.splice(0)) {
        const imported = createFolder(
          String(folder.name || "未命名文件夹").trim().slice(0, 100) || "未命名文件夹",
          rootFolder.id
        )
        folderIds.set(folder.id, imported.id)
      }
    }

    const noteIds = new Map()
    for (const note of backup.notes) {
      const id = randomUUID()
      const createdAt = Number.isFinite(Date.parse(note.createdAt)) ? note.createdAt : timestamp
      const updatedAt = Number.isFinite(Date.parse(note.updatedAt)) ? note.updatedAt : timestamp
      database.prepare(`
        INSERT INTO notes(
          id, folder_id, title, content, is_pinned, created_at, updated_at, dirty
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 1)
      `).run(
        id,
        folderIds.get(note.folderId) || rootFolder.id,
        String(note.title || "无标题笔记").trim().slice(0, 100) || "无标题笔记",
        validateNoteContent(note.content),
        Number(Boolean(note.isPinned)),
        createdAt,
        updatedAt
      )
      const tagNames = Array.isArray(note.tags)
        ? note.tags.map((tag) => String(tag.name || "").trim()).filter(Boolean)
        : []
      replaceNoteTags(id, tagNames)
      enqueue("note", id, "upsert", getNote(id))
      noteIds.set(note.id, id)
    }

    let importedHistories = 0
    for (const history of backup.histories) {
      const noteId = noteIds.get(history.noteId)
      if (!noteId) continue
      const createdAt = Number.isFinite(Date.parse(history.createdAt)) ? history.createdAt : timestamp
      database.prepare(`
        INSERT INTO note_history(
          id, note_id, title, content, folder_id, tag_names, created_at, dirty
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 1)
      `).run(
        randomUUID(),
        noteId,
        String(history.title || "无标题笔记").slice(0, 100),
        validateNoteContent(history.content),
        folderIds.get(history.folderId) || rootFolder.id,
        JSON.stringify(Array.isArray(history.tagNames) ? history.tagNames.slice(0, 12) : []),
        createdAt
      )
      importedHistories += 1
    }
    return {
      importedFolders: folderIds.size + 1,
      importedNotes: noteIds.size,
      importedHistories,
      rootFolderId: rootFolder.id
    }
  })

  /**
   * 构造待发送到云端的同步批次。
   *
   * @returns {object} 文件夹、标签、笔记和删除墓碑。
   */
  function getSyncBatch() {
    const rows = database.prepare("SELECT * FROM outbox ORDER BY id").all()
    const notes = []
    const tombstones = []
    for (const row of rows) {
      const payload = JSON.parse(row.payload)
      if (row.operation === "delete") {
        tombstones.push({
          entityType: row.entity_type,
          clientId: row.entity_id,
          serverId: payload.serverId || null
        })
        continue
      }
      if (row.entity_type === "note") {
        const note = getNote(row.entity_id)
        if (note) {
          notes.push({
            clientId: note.id,
            serverId: note.serverId || null,
            folderClientId: note.folderId,
            title: note.title,
            content: expandImageAssetReferences(note.content),
            isPinned: note.isPinned,
            isDeleted: note.isDeleted,
            deletedTime: note.deletedAt,
            deletedByFolderClientId: note.deletedByFolderId,
            tagClientIds: note.tags.map((tag) => tag.id),
            baseUpdateTime: note.serverUpdatedAt || null
          })
        }
      }
    }
    const allFolders = database.prepare(`
      SELECT id AS clientId, server_id AS serverId, parent_id AS parentClientId,
             name, sort_order AS sortOrder, is_deleted AS isDeleted,
             deleted_at AS deletedTime, deleted_root_id AS deletedRootClientId
      FROM folders
      ORDER BY sort_order, name COLLATE NOCASE
    `).all()
    const allTags = database.prepare(`
      SELECT id AS clientId, server_id AS serverId, name
      FROM tags
      ORDER BY name COLLATE NOCASE
    `).all()
    const histories = database.prepare(`
      SELECT h.id AS clientId, h.note_id AS noteClientId, h.title, h.content,
             h.folder_id AS folderClientId, h.tag_names AS tagNames,
             h.created_at AS createdAt
      FROM note_history h
      JOIN notes n ON n.id = h.note_id
      WHERE h.dirty = 1
      ORDER BY h.created_at
    `).all().map((history) => ({
      ...history,
      content: expandImageAssetReferences(history.content),
      tagNames: JSON.parse(history.tagNames || "[]")
    }))
    return {
      folders: allFolders,
      tags: allTags,
      notes,
      histories,
      tombstones,
      outboxIds: rows.map((row) => row.id)
    }
  }

  /**
   * 应用云端合并结果并保留正文冲突副本。
   *
   * @param {Record<string, any>} result 云端同步结果。
   * @param {number[] | null} acknowledgedOutboxIds 本轮已发送并可确认的待同步记录 ID。
   * @returns {{ conflictCount: number }} 应用结果。
   */
  const applySyncResult = database.transaction((result, acknowledgedOutboxIds = null) => {
    const snapshot = result.snapshot || { folders: [], tags: [], notes: [] }
    const hasHistorySnapshot = Array.isArray(snapshot.histories)
    const conflictIds = new Set(result.conflictClientIds || [])
    for (const mapping of result.mappings || []) {
      const tableName = mapping.entityType === "folder"
        ? "folders"
        : mapping.entityType === "tag" ? "tags" : "notes"
      database.prepare(`
        UPDATE ${tableName}
        SET server_id = ?, server_updated_at = ?
        WHERE id = ?
      `).run(String(mapping.serverId), mapping.updatedAt || null, mapping.clientId)
    }

    for (const clientId of conflictIds) {
      const current = getNote(clientId)
      if (!current) continue
      const conflictId = randomUUID()
      const timestamp = nowIso()
      database.prepare(`
        INSERT INTO notes(
          id, folder_id, title, content, is_pinned, is_deleted, deleted_at,
          deleted_by_folder_id,
          created_at, updated_at, dirty
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
      `).run(
        conflictId,
        current.folderId,
        `${current.title}（冲突副本）`.slice(0, 100),
        current.content,
        Number(current.isPinned),
        Number(current.isDeleted),
        current.deletedAt,
        current.deletedByFolderId,
        timestamp,
        timestamp
      )
      for (const tag of current.tags) {
        database.prepare("INSERT OR IGNORE INTO note_tags(note_id, tag_id) VALUES (?, ?)")
          .run(conflictId, tag.id)
      }
      enqueue("note", conflictId, "upsert", getNote(conflictId))
    }

    const confirmedIds = Array.isArray(acknowledgedOutboxIds)
      ? acknowledgedOutboxIds
      : database.prepare("SELECT id FROM outbox").all().map((row) => row.id)
    if (confirmedIds.length) {
      const placeholders = confirmedIds.map(() => "?").join(",")
      database.prepare(`DELETE FROM outbox WHERE id IN (${placeholders})`).run(...confirmedIds)
    }
    const pendingMutations = database.prepare(`
      SELECT entity_type AS entityType, entity_id AS entityId
      FROM outbox
    `).all()
    const pendingMutationIds = new Map()
    for (const item of pendingMutations) {
      if (!pendingMutationIds.has(item.entityType)) pendingMutationIds.set(item.entityType, new Set())
      pendingMutationIds.get(item.entityType).add(item.entityId)
    }

    const folderLocalIds = new Map()
    for (const remote of snapshot.folders || []) {
      if (pendingMutationIds.get("folder")?.has(remote.clientId)) {
        const pendingLocal = database.prepare(`
          SELECT id FROM folders WHERE server_id = ? OR id = ? LIMIT 1
        `).get(String(remote.serverId), remote.clientId)
        if (pendingLocal) folderLocalIds.set(remote.clientId, pendingLocal.id)
        continue
      }
      let local = database.prepare(`
        SELECT id FROM folders WHERE server_id = ? OR id = ? LIMIT 1
      `).get(String(remote.serverId), remote.clientId)
      const localId = local?.id || remote.clientId
      if (!local) {
        database.prepare(`
          INSERT INTO folders(
            id, server_id, name, sort_order, is_deleted, deleted_at,
            created_at, updated_at,
            server_updated_at, dirty
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
        `).run(
          localId,
          String(remote.serverId),
          remote.name,
          remote.sortOrder || 0,
          Number(Boolean(remote.isDeleted)),
          remote.deletedTime || null,
          remote.createdAt,
          remote.updatedAt,
          remote.updatedAt
        )
      } else {
        database.prepare(`
          UPDATE folders
          SET server_id = ?, name = ?, sort_order = ?, is_deleted = ?,
              deleted_at = ?, updated_at = ?,
              server_updated_at = ?, dirty = 0
          WHERE id = ?
        `).run(
          String(remote.serverId),
          remote.name,
          remote.sortOrder || 0,
          Number(Boolean(remote.isDeleted)),
          remote.deletedTime || null,
          remote.updatedAt,
          remote.updatedAt,
          localId
        )
      }
      folderLocalIds.set(remote.clientId, localId)
    }
    for (const remote of snapshot.folders || []) {
      if (pendingMutationIds.get("folder")?.has(remote.clientId)) continue
      database.prepare(`
        UPDATE folders SET parent_id = ?, deleted_root_id = ? WHERE id = ?
      `).run(
        folderLocalIds.get(remote.parentClientId) || null,
        folderLocalIds.get(remote.deletedRootClientId) || null,
        folderLocalIds.get(remote.clientId)
      )
    }

    const tagLocalIds = new Map()
    for (const remote of snapshot.tags || []) {
      if (pendingMutationIds.get("tag")?.has(remote.clientId)) {
        const pendingLocal = database.prepare(`
          SELECT id FROM tags WHERE server_id = ? OR id = ? LIMIT 1
        `).get(String(remote.serverId), remote.clientId)
        if (pendingLocal) tagLocalIds.set(remote.clientId, pendingLocal.id)
        continue
      }
      let local = database.prepare(`
        SELECT id FROM tags WHERE server_id = ? OR id = ? OR name = ? COLLATE NOCASE LIMIT 1
      `).get(String(remote.serverId), remote.clientId, remote.name)
      const localId = local?.id || remote.clientId
      if (!local) {
        database.prepare(`
          INSERT INTO tags(
            id, server_id, name, created_at, updated_at, server_updated_at, dirty
          ) VALUES (?, ?, ?, ?, ?, ?, 0)
        `).run(
          localId,
          String(remote.serverId),
          remote.name,
          remote.createdAt,
          remote.updatedAt,
          remote.updatedAt
        )
      } else {
        database.prepare(`
          UPDATE tags
          SET server_id = ?, name = ?, updated_at = ?, server_updated_at = ?, dirty = 0
          WHERE id = ?
        `).run(String(remote.serverId), remote.name, remote.updatedAt, remote.updatedAt, localId)
      }
      tagLocalIds.set(remote.clientId, localId)
    }

    const noteLocalIds = new Map()
    for (const remote of snapshot.notes || []) {
      if (pendingMutationIds.get("note")?.has(remote.clientId)) {
        const pendingLocal = database.prepare(`
          SELECT id FROM notes WHERE server_id = ? OR id = ? LIMIT 1
        `).get(String(remote.serverId), remote.clientId)
        if (pendingLocal) noteLocalIds.set(remote.clientId, pendingLocal.id)
        continue
      }
      let local = database.prepare(`
        SELECT id FROM notes WHERE server_id = ? OR id = ? LIMIT 1
      `).get(String(remote.serverId), remote.clientId)
      const localId = local?.id || remote.clientId
      if (!local) {
        database.prepare(`
          INSERT INTO notes(
            id, server_id, folder_id, title, content, is_pinned, is_deleted,
            deleted_at, deleted_by_folder_id, created_at, updated_at,
            server_updated_at, dirty
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
        `).run(
          localId,
          String(remote.serverId),
          folderLocalIds.get(remote.folderClientId) || null,
          remote.title,
          localizeImageAssetReferences(remote.content),
          Number(remote.isPinned),
          Number(remote.isDeleted),
          remote.deletedTime,
          folderLocalIds.get(remote.deletedByFolderClientId) || null,
          remote.createdAt,
          remote.updatedAt,
          remote.updatedAt
        )
      } else {
        database.prepare(`
          UPDATE notes
          SET server_id = ?, folder_id = ?, title = ?, content = ?, is_pinned = ?,
              is_deleted = ?, deleted_at = ?, deleted_by_folder_id = ?, updated_at = ?,
              server_updated_at = ?, dirty = 0
          WHERE id = ?
        `).run(
          String(remote.serverId),
          folderLocalIds.get(remote.folderClientId) || null,
          remote.title,
          localizeImageAssetReferences(remote.content),
          Number(remote.isPinned),
          Number(remote.isDeleted),
          remote.deletedTime,
          folderLocalIds.get(remote.deletedByFolderClientId) || null,
          remote.updatedAt,
          remote.updatedAt,
          localId
        )
      }
      noteLocalIds.set(remote.clientId, localId)
      database.prepare("DELETE FROM note_tags WHERE note_id = ?").run(localId)
      for (const tagClientId of remote.tagClientIds || []) {
        const tagId = tagLocalIds.get(tagClientId)
        if (tagId) {
          database.prepare("INSERT OR IGNORE INTO note_tags(note_id, tag_id) VALUES (?, ?)")
            .run(localId, tagId)
        }
      }
    }

    if (hasHistorySnapshot) {
      const remoteHistoryIds = []
      for (const remote of snapshot.histories) {
        const noteId = noteLocalIds.get(remote.noteClientId)
        if (!noteId) continue
        remoteHistoryIds.push(remote.clientId)
        database.prepare(`
          INSERT INTO note_history(
            id, note_id, title, content, folder_id, tag_names, created_at, dirty
          ) VALUES (?, ?, ?, ?, ?, ?, ?, 0)
          ON CONFLICT(id) DO UPDATE SET
            note_id = excluded.note_id,
            title = excluded.title,
            content = excluded.content,
            folder_id = excluded.folder_id,
            tag_names = excluded.tag_names,
            created_at = excluded.created_at,
            dirty = 0
        `).run(
          remote.clientId,
          noteId,
          remote.title,
          localizeImageAssetReferences(remote.content),
          folderLocalIds.get(remote.folderClientId) || null,
          JSON.stringify(remote.tagNames || []),
          remote.createdAt
        )
      }
      const historyPlaceholders = remoteHistoryIds.map(() => "?").join(",")
      const removeMissingHistoriesSql = remoteHistoryIds.length
        ? `DELETE FROM note_history WHERE dirty = 0 AND id NOT IN (${historyPlaceholders})`
        : "DELETE FROM note_history WHERE dirty = 0"
      database.prepare(removeMissingHistoriesSql).run(...remoteHistoryIds)
      database.prepare(`
        DELETE FROM note_history
        WHERE id IN (
          SELECT id
          FROM (
            SELECT id, ROW_NUMBER() OVER (
              PARTITION BY note_id ORDER BY created_at DESC, id DESC
            ) AS position
            FROM note_history
          )
          WHERE position > 50
        )
      `).run()
    }

    const remoteFolderIds = (snapshot.folders || []).map((item) => String(item.serverId))
    const remoteTagIds = (snapshot.tags || []).map((item) => String(item.serverId))
    const remoteNoteIds = (snapshot.notes || []).map((item) => String(item.serverId))
    removeMissingCleanEntities("notes", remoteNoteIds)
    removeMissingCleanEntities("tags", remoteTagIds)
    removeMissingCleanEntities("folders", remoteFolderIds)
    database.prepare("UPDATE folders SET dirty = 0 WHERE server_id IS NOT NULL").run()
    database.prepare("UPDATE tags SET dirty = 0 WHERE server_id IS NOT NULL").run()
    database.prepare("UPDATE notes SET dirty = 0 WHERE server_id IS NOT NULL").run()
    if (hasHistorySnapshot) {
      database.prepare("UPDATE note_history SET dirty = 0").run()
    }
    database.prepare(`
      INSERT INTO sync_state(key, value) VALUES ('last_success_at', ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run(nowIso())
    return { conflictCount: conflictIds.size }
  })

  /**
   * 删除云端快照中已不存在且本地无待同步修改的实体。
   *
   * @param {string} tableName 表名。
   * @param {string[]} remoteServerIds 云端仍存在的服务端 ID。
   * @returns {void}
   */
  function removeMissingCleanEntities(tableName, remoteServerIds) {
    const placeholders = remoteServerIds.map(() => "?").join(",")
    const sql = remoteServerIds.length
      ? `DELETE FROM ${tableName} WHERE dirty = 0 AND server_id IS NOT NULL AND server_id NOT IN (${placeholders})`
      : `DELETE FROM ${tableName} WHERE dirty = 0 AND server_id IS NOT NULL`
    database.prepare(sql).run(...remoteServerIds)
  }

  return {
    backupTo,
    close: () => database.close(),
    relocateImageAssetPaths,
    listWorkspace,
    createNote,
    duplicateNote,
    createQuickNote,
    updateNote,
    listNoteHistory,
    getNoteHistory,
    restoreNoteHistory,
    deleteNoteHistory,
    setNoteDeleted,
    deleteNotePermanently,
    emptyTrash,
    createFolder,
    renameFolder,
    moveFolder,
    setFolderDeleted,
    restoreFolder,
    deleteFolderPermanently,
    createTag,
    deleteTag,
    exportBackup,
    importBackup,
    importMarkdownDocuments,
    createAsset: createImageAsset,
    createImageAsset,
    getAsset: getImageAsset,
    getImageAsset,
    listAssets: listImageAssets,
    listImageAssets,
    listPendingAssets: listPendingImageAssets,
    listPendingImageAssets,
    listRemoteAttachmentReferencesToCache,
    listRemoteImageUrlsToCache,
    markAssetUploaded: markImageAssetUploaded,
    markImageAssetUploaded,
    getSyncBatch,
    applySyncResult
  }
}

module.exports = { openNotesDatabase }
