const { randomUUID } = require("node:crypto")
const path = require("node:path")
const Database = require("better-sqlite3")
const { initializeNotesDatabase } = require("./database-schema.cjs")
const {
  createNoteContentPreview,
  searchNotes: searchNotesDatabase
} = require("./database-search.cjs")
const {
  rewriteLocalNoteLinksInContent,
  fillEmbedServerIdsInContent
} = require("./local-note-links.cjs")

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
  initializeNotesDatabase(database)
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
    conflictSourceId: row.conflict_source_id || null,
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

  /** 一次读取指定笔记集合的标签，避免列表逐篇查询。 */
  function selectTagsForNotes(noteIds) {
    if (!noteIds.length) return new Map()
    const placeholders = noteIds.map(() => "?").join(",")
    const rows = database.prepare(`
      SELECT nt.note_id AS noteId, t.id, t.name
      FROM note_tags nt
      JOIN tags t ON t.id = nt.tag_id
      WHERE nt.note_id IN (${placeholders})
      ORDER BY t.name COLLATE NOCASE
    `).all(...noteIds)
    const tagsByNoteId = new Map()
    for (const row of rows) {
      const tags = tagsByNoteId.get(row.noteId) || []
      tags.push({ id: row.id, name: row.name })
      tagsByNoteId.set(row.noteId, tags)
    }
    return tagsByNoteId
  }

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
   * 先按本机 ID 精确查；**未命中再按云端 `server_id` 回落一次**。
   *
   * 为什么需要回落：笔记嵌入卡片在网页端只能承载服务端数字主键（网页端没有本机 uuid
   * 这回事），同步回来之后 `getNote(雪花 ID)` 按 `id` 查必然 0 行 —— 表现为「网页里插入的
   * 笔记，在桌面端显示不存在」。本机以 `server_id` 映射同一篇笔记，故补这一路。
   *
   * 只认入参的字符串形态：雪花 ID 超出 JS 安全整数范围，若被当 number 传进来会丢精度。
   *
   * @param {string} noteId 笔记 ID（本机 uuid，或服务端数字主键）。
   * @returns {Record<string, any> | null} 笔记详情。
   */
  function getNote(noteId) {
    if (noteId === null || noteId === undefined || noteId === "") return null
    const key = String(noteId)
    let row = database.prepare("SELECT * FROM notes WHERE id = ?").get(key)
    // 回落不带 is_deleted 条件：已删除的目标也要能查到，调用方才能区分「已删除」与「不存在」。
    if (!row) row = database.prepare("SELECT * FROM notes WHERE server_id = ?").get(key)
    return row ? mapNote(row, selectTagsForNote.all(row.id)) : null
  }

  /** 获取进入编辑器所需的完整笔记正文。 */
  function getNoteForEditing(noteId) {
    const note = getNote(noteId)
    if (!note) return null
    return {
      ...note,
      content: localizeImageAssetReferences(note.content),
      contentLoaded: true
    }
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
   * 查询附件及其在当前笔记和历史版本中的引用情况。
   *
   * @returns {Array<Record<string, any>>} 附件管理清单。
   */
  function listAttachmentInventory() {
    const assets = database.prepare("SELECT * FROM note_assets ORDER BY created_at DESC").all()
    const notes = database.prepare(`
      SELECT id, title, content, is_deleted AS isDeleted
      FROM notes
      ORDER BY updated_at DESC
    `).all()
    const histories = database.prepare("SELECT note_id AS noteId, content FROM note_history").all()
    return assets.map((row) => {
      const tokens = [
        `${LOCAL_ASSET_URL_PREFIX}${row.id}`,
        `${INTERNAL_ATTACHMENT_URL_PREFIX}${row.id}`,
        row.remote_url
      ].filter(Boolean)
      const isReferenced = (content) => tokens.some((token) => String(content || "").includes(token))
      const noteReferences = notes
        .filter((note) => isReferenced(note.content))
        .map((note) => ({
          id: note.id,
          title: note.title,
          isDeleted: Boolean(note.isDeleted)
        }))
      const historyReferenceCount = histories.reduce(
        (count, history) => count + Number(isReferenced(history.content)),
        0
      )
      const referenceCount = noteReferences.length + historyReferenceCount
      return {
        ...mapImageAsset(row),
        noteReferences,
        historyReferenceCount,
        referenceCount,
        isOrphan: referenceCount === 0
      }
    })
  }

  /**
   * 删除确认未被当前笔记或历史版本引用的附件记录。
   *
   * @param {string} assetId 附件资源 ID。
   * @returns {Record<string, any> | null} 被删除的附件；不存在时返回空值。
   */
  const deleteOrphanAsset = database.transaction((assetId) => {
    const asset = listAttachmentInventory().find((item) => item.id === assetId)
    if (!asset) return null
    if (!asset.isOrphan) throw new Error("附件仍被笔记引用，不能清理")
    database.prepare("DELETE FROM note_assets WHERE id = ?").run(assetId)
    return asset
  })

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

  /** 获取工作区中不含笔记正文的公共集合。 */
  function listWorkspaceCollections() {
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
    const pendingCount = database.prepare("SELECT COUNT(*) AS total FROM outbox").get().total
    return { folders, tags, pendingCount }
  }

  /**
   * 获取离线工作区列表数据。
   *
   * @returns {object} 文件夹、标签、笔记摘要与同步统计。
   */
  function listWorkspace() {
    const workspace = listWorkspaceCollections()
    const noteRows = database.prepare(`
      SELECT n.id, n.server_id, n.folder_id, n.title,
             COALESCE(p.content_prefix, '') AS content,
             n.is_pinned, n.is_deleted, n.deleted_at, n.deleted_by_folder_id,
             n.conflict_source_id, n.created_at, n.updated_at, n.server_updated_at,
             n.revision, n.dirty
      FROM notes n
      LEFT JOIN note_previews p ON p.note_id = n.id
      ORDER BY n.is_pinned DESC, n.updated_at DESC
    `).all()
    const tagsByNoteId = selectTagsForNotes(noteRows.map((row) => row.id))
    const notes = noteRows.map((row) => ({
      ...mapNote(row, tagsByNoteId.get(row.id) || []),
      content: createNoteContentPreview(row.content),
      contentLoaded: false
    }))
    return { ...workspace, notes }
  }

  /** 获取仅供同步、备份和导出使用的完整工作区快照。 */
  function listFullWorkspace() {
    const workspace = listWorkspaceCollections()
    const noteRows = database.prepare(`
      SELECT * FROM notes ORDER BY is_pinned DESC, updated_at DESC
    `).all()
    const tagsByNoteId = selectTagsForNotes(noteRows.map((row) => row.id))
    const notes = noteRows.map((row) => ({
      ...mapNote(row, tagsByNoteId.get(row.id) || []),
      content: localizeImageAssetReferences(row.content),
      contentLoaded: true
    }))
    return { ...workspace, notes }
  }

  /** 获取当前本地档案的标签页会话和滚动位置。 */
  function getWorkspaceSession() {
    const tabs = database.prepare(`
      SELECT tabs.note_id AS noteId,
             tabs.is_pinned AS isPinned,
             COALESCE(view.scroll_top, 0) AS scrollTop
      FROM workspace_session_tabs tabs
      JOIN notes ON notes.id = tabs.note_id AND notes.is_deleted = 0
      LEFT JOIN note_view_states view ON view.note_id = tabs.note_id
      ORDER BY tabs.position, tabs.note_id
    `).all().map((tab) => ({
      noteId: tab.noteId,
      isPinned: Boolean(tab.isPinned),
      scrollTop: Math.max(0, Number(tab.scrollTop) || 0)
    }))
    const activeNoteId = database.prepare(`
      SELECT session.active_note_id AS activeNoteId
      FROM workspace_session session
      JOIN notes ON notes.id = session.active_note_id AND notes.is_deleted = 0
      WHERE session.id = 1
    `).get()?.activeNoteId || null
    return {
      tabs,
      activeNoteId: tabs.some((tab) => tab.noteId === activeNoteId) ? activeNoteId : null
    }
  }

  /** 保存当前本地档案的标签页顺序、固定状态和活动笔记。 */
  const saveWorkspaceSession = database.transaction((input = {}) => {
    const requestedTabs = Array.isArray(input.tabs) ? input.tabs.slice(0, 100) : []
    const requestedIds = [...new Set(requestedTabs
      .map((tab) => String(tab?.noteId || "").trim())
      .filter(Boolean))]
    const validIds = new Set()
    if (requestedIds.length) {
      const placeholders = requestedIds.map(() => "?").join(",")
      for (const row of database.prepare(`
        SELECT id FROM notes
        WHERE is_deleted = 0 AND id IN (${placeholders})
      `).all(...requestedIds)) validIds.add(row.id)
    }
    const tabsById = new Map(requestedTabs.map((tab) => [String(tab?.noteId || "").trim(), tab]))
    const tabs = requestedIds
      .filter((noteId) => validIds.has(noteId))
      .map((noteId) => ({ noteId, isPinned: Boolean(tabsById.get(noteId)?.isPinned) }))
    const timestamp = nowIso()
    database.prepare("DELETE FROM workspace_session_tabs").run()
    const insertTab = database.prepare(`
      INSERT INTO workspace_session_tabs(note_id, position, is_pinned, updated_at)
      VALUES (?, ?, ?, ?)
    `)
    tabs.forEach((tab, position) => insertTab.run(
      tab.noteId,
      position,
      Number(tab.isPinned),
      timestamp
    ))
    const requestedActiveNoteId = String(input.activeNoteId || "").trim()
    const activeNoteId = tabs.some((tab) => tab.noteId === requestedActiveNoteId)
      ? requestedActiveNoteId
      : null
    database.prepare(`
      INSERT INTO workspace_session(id, active_note_id, updated_at)
      VALUES (1, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        active_note_id = excluded.active_note_id,
        updated_at = excluded.updated_at
    `).run(activeNoteId, timestamp)
    return getWorkspaceSession()
  })

  /** 保存单篇笔记的本地阅读滚动位置。 */
  function saveNoteViewState(noteId, scrollTop) {
    const normalizedNoteId = String(noteId || "").trim()
    const note = database.prepare("SELECT id FROM notes WHERE id = ? AND is_deleted = 0")
      .get(normalizedNoteId)
    if (!note) return false
    const normalizedScrollTop = Math.max(0, Math.min(
      Math.round(Number(scrollTop) || 0),
      100_000_000
    ))
    database.prepare(`
      INSERT INTO note_view_states(note_id, scroll_top, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(note_id) DO UPDATE SET
        scroll_top = excluded.scroll_top,
        updated_at = excluded.updated_at
    `).run(normalizedNoteId, normalizedScrollTop, nowIso())
    return true
  }

  /*
   * ===== AI 对话历史（只在本机、只跟当前档案库） =====
   *
   * 只存「已完成」的轮次：流式失败或中途关面板留下的半截回答不落库，
   * 否则恢复出来的对话里会夹着一条永远写不完的回答。
   *
   * 不参与同步：跨端契约里没有 AI 会话，网页端也没有对应界面；
   * 会话里的正文片段属于敏感内容，留在本机更可控。
   */

  /** 会话保留条数上限。 */
  const AI_CONVERSATION_LIMIT = 50
  /** 会话保留天数上限。 */
  const AI_CONVERSATION_MAX_AGE_DAYS = 30
  /** 单条来源摘要在库里的最大长度，防止把整篇笔记塞进来。 */
  const AI_SOURCE_EXCERPT_LIMIT = 400
  /** 来源命中词在库里的最大长度；检索词本身不超过 32 字，留点余量。 */
  const AI_SOURCE_TERM_LIMIT = 64

  /** 把问题压成一行标题，用于历史列表。 */
  function aiConversationTitle(question) {
    const flattened = String(question || "").replace(/\s+/g, " ").trim()
    if (!flattened) return "新对话"
    return flattened.length > 30 ? `${flattened.slice(0, 30)}…` : flattened
  }

  /** 归一化来源数组，顺手截断超长摘要。 */
  function normalizeAiSources(sources) {
    if (!Array.isArray(sources)) return []
    return sources.slice(0, 12).map((source) => ({
      id: String(source?.id || ""),
      noteId: String(source?.noteId || ""),
      title: String(source?.title || ""),
      excerpt: String(source?.excerpt || "").slice(0, AI_SOURCE_EXCERPT_LIMIT),
      // 命中词要跟着存：恢复历史后点来源还能定位到正文命中处。
      matchTerm: source?.matchTerm ? String(source.matchTerm).slice(0, AI_SOURCE_TERM_LIMIT) : null,
      // 长笔记只取了前 N 字：恢复历史时这条提示也得跟着回来。
      truncated: Boolean(source?.truncated)
    }))
  }

  /** 按「最近 50 条 / 30 天」清理旧会话，连带轮次一起走。 */
  function pruneAiConversations() {
    const cutoff = new Date(
      Date.now() - AI_CONVERSATION_MAX_AGE_DAYS * 24 * 60 * 60 * 1000
    ).toISOString()
    // 置顶的会话不受时间线约束：用户手动钉住的对话，不该因为「30 天没问」被清掉。
    database.prepare("DELETE FROM ai_conversations WHERE updated_at < ? AND pinned = 0").run(cutoff)
    // 条数上限里先扣掉置顶占的名额，剩下的才轮到普通会话按新旧裁。
    const pinnedCount = Number(
      database.prepare("SELECT COUNT(*) AS total FROM ai_conversations WHERE pinned = 1").get()?.total
    ) || 0
    database.prepare(`
      DELETE FROM ai_conversations
      WHERE pinned = 0 AND id NOT IN (
        SELECT id FROM ai_conversations
        WHERE pinned = 0
        ORDER BY updated_at DESC, rowid DESC
        LIMIT ?
      )
    `).run(Math.max(0, AI_CONVERSATION_LIMIT - pinnedCount))
  }

  /**
   * 列出历史会话，置顶在前、其余最新在前；不带轮次正文，列表页用不到。
   *
   * `keyword` 非空时按标题或任意一轮的提问做子串匹配。搜提问而不只搜标题：
   * 标题只截了第一个问题的前 30 字，追问里的关键词否则永远搜不到。
   *
   * `noteId` 非空时只返回归属该篇笔记的会话 —— 面板打开时靠它找「该续接哪一条」。
   */
  function listAiConversations(options = {}) {
    const term = String(options.keyword || "").replace(/\s+/g, " ").trim()
    const scopedNoteId = String(options.noteId || "").trim()
    const params = []
    const conditions = []
    if (term) {
      // LIKE 里的 % _ \ 要先转义，否则用户输入「100%」会变成通配。
      const like = `%${term.replace(/[\\%_]/g, (character) => `\\${character}`)}%`
      conditions.push(`(
        conversation.title LIKE ? ESCAPE '\\'
        OR EXISTS (
          SELECT 1 FROM ai_conversation_turns hit
          WHERE hit.conversation_id = conversation.id
            AND hit.question LIKE ? ESCAPE '\\'
        )
      )`)
      params.push(like, like)
    }
    if (scopedNoteId) {
      conditions.push("conversation.note_id = ?")
      params.push(scopedNoteId)
    }
    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : ""
    return database.prepare(`
      SELECT conversation.id AS id,
             conversation.title AS title,
             conversation.pinned AS pinned,
             conversation.note_id AS noteId,
             -- 软删除的笔记（is_deleted = 1）也按「已删除」算：跳过去只会打开回收站里的条目。
             CASE WHEN note.id IS NULL OR note.is_deleted = 1
                  THEN NULL ELSE note.title END AS noteTitle,
             conversation.created_at AS createdAt,
             conversation.updated_at AS updatedAt,
             COUNT(turn.id) AS turnCount
      FROM ai_conversations conversation
      LEFT JOIN notes note ON note.id = conversation.note_id
      LEFT JOIN ai_conversation_turns turn ON turn.conversation_id = conversation.id
      ${where}
      GROUP BY conversation.id
      -- updated_at 只到毫秒，连续操作会打平；用 rowid 兜底才符合「后动的在前」。
      ORDER BY conversation.pinned DESC, conversation.updated_at DESC, conversation.rowid DESC
    `).all(...params).map((row) => ({
      id: row.id,
      title: row.title,
      pinned: Boolean(row.pinned),
      noteId: row.noteId || null,
      noteTitle: row.noteTitle || null,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      turnCount: Number(row.turnCount) || 0
    }))
  }

  /** 读一整个会话（含轮次）；不存在时返回 null。 */
  function getAiConversation(conversationId) {
    const normalizedId = String(conversationId || "").trim()
    if (!normalizedId) return null
    const conversation = database.prepare(`
      SELECT conversation.id AS id,
             conversation.title AS title,
             conversation.pinned AS pinned,
             conversation.note_id AS noteId,
             CASE WHEN note.id IS NULL OR note.is_deleted = 1
                  THEN NULL ELSE note.title END AS noteTitle,
             conversation.created_at AS createdAt,
             conversation.updated_at AS updatedAt
      FROM ai_conversations conversation
      LEFT JOIN notes note ON note.id = conversation.note_id
      WHERE conversation.id = ?
    `).get(normalizedId)
    if (!conversation) return null
    const turns = database.prepare(`
      SELECT id, question, answer, sources_json AS sourcesJson,
             citation_missing AS citationMissing, created_at AS createdAt
      FROM ai_conversation_turns
      WHERE conversation_id = ?
      ORDER BY position ASC
    `).all(normalizedId).map((row) => {
      let sources = []
      try {
        const parsed = JSON.parse(row.sourcesJson || "[]")
        sources = normalizeAiSources(parsed)
      } catch {
        sources = []
      }
      return {
        id: row.id,
        question: row.question,
        answer: row.answer,
        sources,
        citationMissing: Boolean(row.citationMissing),
        createdAt: row.createdAt
      }
    })
    return {
      ...conversation,
      pinned: Boolean(conversation.pinned),
      noteId: conversation.noteId || null,
      noteTitle: conversation.noteTitle || null,
      turns
    }
  }

  /**
   * 追加一轮已完成的问答。
   *
   * `conversationId` 为空时按需新建（渲染层点「＋」不会立刻落库，
   * 避免出现一堆没问过话的空会话）。返回真实的会话 ID 供界面回填。
   *
   * `noteId` 只在新建时写入：一条对话归属「开始提问时打开的那篇笔记」，
   * 之后切到别的笔记接着追问也不改归属 —— 一段上下文自始至终围绕同一篇。
   */
  const appendAiConversationTurn = database.transaction((input = {}) => {
    const question = String(input.question || "").trim()
    const answer = String(input.answer || "").trim()
    if (!question || !answer) return null
    const timestamp = nowIso()
    let conversationId = String(input.conversationId || "").trim()
    const existing = conversationId
      ? database.prepare("SELECT id FROM ai_conversations WHERE id = ?").get(conversationId)
      : null
    if (!existing) {
      conversationId = randomUUID()
      database.prepare(`
        INSERT INTO ai_conversations(id, title, note_id, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?)
      `).run(
        conversationId,
        aiConversationTitle(question),
        String(input.noteId || "").trim() || null,
        timestamp,
        timestamp
      )
      pruneAiConversations()
    }
    const position = Number(database.prepare(`
      SELECT COALESCE(MAX(position), -1) + 1 AS next FROM ai_conversation_turns
      WHERE conversation_id = ?
    `).get(conversationId)?.next) || 0
    const turnId = randomUUID()
    database.prepare(`
      INSERT INTO ai_conversation_turns(
        id, conversation_id, position, question, answer, sources_json, citation_missing, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      turnId,
      conversationId,
      position,
      question,
      answer,
      JSON.stringify(normalizeAiSources(input.sources)),
      input.citationMissing ? 1 : 0,
      timestamp
    )
    database.prepare("UPDATE ai_conversations SET updated_at = ? WHERE id = ?")
      .run(timestamp, conversationId)
    return { conversationId, turnId }
  })

  /**
   * 重写某一轮的回答（界面上的「重新生成」）。
   *
   * 只换答案与来源，不动问题、位置和会话：重答不该让这一轮在会话里换顺序，
   * 也不该在历史里多出一条一模一样的提问。
   */
  const replaceAiConversationTurn = database.transaction((input = {}) => {
    const turnId = String(input.turnId || "").trim()
    const answer = String(input.answer || "").trim()
    if (!turnId || !answer) return false
    const existing = database.prepare(
      "SELECT conversation_id AS conversationId FROM ai_conversation_turns WHERE id = ?"
    ).get(turnId)
    if (!existing) return false
    database.prepare(`
      UPDATE ai_conversation_turns
      SET answer = ?, sources_json = ?, citation_missing = ?
      WHERE id = ?
    `).run(
      answer,
      JSON.stringify(normalizeAiSources(input.sources)),
      input.citationMissing ? 1 : 0,
      turnId
    )
    database.prepare("UPDATE ai_conversations SET updated_at = ? WHERE id = ?")
      .run(nowIso(), existing.conversationId)
    return true
  })

  /**
   * 重命名会话。
   *
   * 故意不动 `updated_at`：改名是整理动作，不该把一条旧对话顶到列表最前
   * ——用户刚拖下来的顺序会被一次改名打乱，看着像「排序坏了」。
   */
  function renameAiConversation(conversationId, title) {
    const normalizedId = String(conversationId || "").trim()
    const normalizedTitle = String(title || "").replace(/\s+/g, " ").trim().slice(0, 80)
    if (!normalizedId || !normalizedTitle) return false
    const result = database.prepare("UPDATE ai_conversations SET title = ? WHERE id = ?")
      .run(normalizedTitle, normalizedId)
    return Number(result.changes) > 0
  }

  /** 置顶 / 取消置顶；同样不碰 `updated_at`，理由同重命名。 */
  function setAiConversationPinned(conversationId, pinned) {
    const normalizedId = String(conversationId || "").trim()
    if (!normalizedId) return false
    const result = database.prepare("UPDATE ai_conversations SET pinned = ? WHERE id = ?")
      .run(pinned ? 1 : 0, normalizedId)
    return Number(result.changes) > 0
  }

  /** 删除一个会话（轮次由外键级联删除）。 */  function deleteAiConversation(conversationId) {
    const normalizedId = String(conversationId || "").trim()
    if (!normalizedId) return false
    const result = database.prepare("DELETE FROM ai_conversations WHERE id = ?").run(normalizedId)
    return Number(result.changes) > 0
  }

  /** 清空全部会话历史。 */
  function clearAiConversations() {
    const result = database.prepare("DELETE FROM ai_conversations").run()
    return Number(result.changes) || 0
  }

  /**
   * 使用 SQLite FTS5 搜索标题与完整正文，可选匹配标签和文件夹名称。
   */
  function searchNotes(keyword, options = {}) {
    return searchNotesDatabase(database, keyword, options, {
      mapNote,
      selectTagsForNotes
    })
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
    refreshNoteLinks(id, content)
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
    refreshNoteLinks(id, content)
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
    refreshNoteLinks(noteId, restoredContent)
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
    refreshNoteLinks(noteId, next.content)
    if (Array.isArray(patch.tagNames)) replaceNoteTags(noteId, nextTagNames)
    const note = getNote(noteId)
    enqueue("note", noteId, "upsert", note)
    return note
  })

  /**
   * 根据笔记正文重新计算其指向的内部笔记链接引用关系。
   *
   * @param {string} noteId 当前笔记 ID。
   * @param {string} content 笔记正文。
   * @returns {void}
   */
  /**
   * 从笔记正文解析其引用的本地笔记 ID 集合。
   *
   * 同时支持三种引用来源：
   * 1. 桌面端内部链接：https://xinyue-note.local/{noteId}（旧格式 xinyue-notes://note/{noteId} 仍兼容）
   * 2. 网页版笔记链接：{后端域名}/notes/{serverId} 或 /articles/{serverId}，需通过 server_id 回落到本地笔记。
   * 3. 笔记嵌入卡片：`<div data-xynote-embed="note:{noteId}">`，noteId 为本地笔记 ID。
   *
   * 新增来源时必须同步递增 rebuildAllNoteLinks 的 `note_links_version`，
   * 否则老库里的关系表不会重算、会一直缺这一来源。
   *
   * @param {string} noteId 当前笔记 ID。
   * @param {string} content 笔记正文。
   * @returns {Set<string>} 被引用笔记的本地 ID 集合。
   */
  function resolveNoteLinkTargetIds(noteId, content) {
    const targetIds = new Set()
    if (typeof content !== "string") return targetIds
    const internalLinkPattern = /xinyue-notes:\/\/note\/([^"'<>\s)]+)/g
    let match
    while ((match = internalLinkPattern.exec(content)) !== null) {
      const raw = match[1]
      let targetId = raw
      try {
        targetId = decodeURIComponent(raw)
      } catch {
        targetId = raw
      }
      if (targetId && targetId !== noteId) targetIds.add(targetId)
    }
    // 桌面端新格式：https://xinyue-note.local/{noteId}，沿用与旧格式相同的 ID 提取逻辑
    const desktopLinkPattern = /https:\/\/xinyue-note\.local\/([^"'<>\s)]+)/g
    while ((match = desktopLinkPattern.exec(content)) !== null) {
      const raw = match[1]
      let targetId = raw
      try {
        targetId = decodeURIComponent(raw)
      } catch {
        targetId = raw
      }
      if (targetId && targetId !== noteId) targetIds.add(targetId)
    }
    const findLocalByServerId = database.prepare(
      "SELECT id FROM notes WHERE server_id = ? AND is_deleted = 0"
    )
    const findLocalById = database.prepare("SELECT id FROM notes WHERE id = ? AND is_deleted = 0")
    const webLinkPattern = /\/(?:notes|articles)\/(\d+)/g
    while ((match = webLinkPattern.exec(content)) !== null) {
      const local = findLocalByServerId.get(match[1])
      if (local && local.id !== noteId) targetIds.add(local.id)
    }
    // 笔记嵌入卡片：`<div data-xynote-embed="note:{noteId}" data-xynote-embed-server="{serverId}">`。
    // 两个标识属性互为补充，**任一存在即算一张嵌入卡**（见 src/editor/xynote-embed.ts）：
    // - `data-xynote-embed` 是本机 uuid（桌面端插入时写，值带 `note:` 前缀）；
    // - `data-xynote-embed-server` 是服务端数字主键（网页端插入时只写它）。
    // 嵌入在语义上同样是「本篇引用了目标」，必须与普通链接一样写进 note_links，
    // 否则右侧「关系」列表与图谱会漏掉嵌入关系（历史实现只解析 URL 形式，故漏统计）。
    const addEmbedTarget = (raw) => {
      let targetId = raw
      try {
        targetId = decodeURIComponent(raw)
      } catch {
        targetId = raw
      }
      if (!targetId || targetId === noteId) return
      // 正常情况下就是本地笔记 ID；跨设备同步回来的嵌入可能带的是对端库里的 ID，
      // 此时按 server_id 回落一次，仍未命中说明目标笔记在本机不存在，直接丢弃。
      if (!findLocalById.get(targetId)) {
        const local = findLocalByServerId.get(targetId)
        if (!local) return
        targetId = local.id
      }
      if (targetId !== noteId) targetIds.add(targetId)
    }
    const embedPattern = /data-xynote-embed=["']note:([^"']+)["']/g
    while ((match = embedPattern.exec(content)) !== null) addEmbedTarget(match[1])
    // 只写跨端属性的卡片（网页端插入）走这一路；与上一路可能命中同一张卡，Set 天然去重。
    const embedServerPattern = /data-xynote-embed-server=["']([^"']+)["']/g
    while ((match = embedServerPattern.exec(content)) !== null) addEmbedTarget(match[1])
    return targetIds
  }

  /**
   * 根据笔记正文重新计算其指向的内部笔记链接引用关系。
   *
   * ⚠️ 约定：**任何写入 `notes.content` 的路径都必须紧接着调用本函数**，
   * 并把「实际落库的那份正文」传进来（例如 `validateNoteContent` / `localizeImageAssetReferences`
   * 处理后的字符串，而非处理前的原始值）。漏掉就会出现「正文已更新、关系表还是旧的」，
   * 表现为「关系」面板与图谱数据陈旧。
   * 已接入的写入点：duplicateNote / createQuickNote / updateNote /
   * restoreNoteHistory / applySyncResult / resolveNoteConflict(local) /
   * importMarkdownDocuments / importBackup。
   * （createNote 建的是空正文笔记，无需调用。）
   *
   * 本函数自身开事务，可安全嵌套在其它 `database.transaction` 内（better-sqlite3 走 savepoint）。
   *
   * @param {string} noteId 当前笔记 ID。
   * @param {string} content 笔记正文（落库后的最终值）。
   * @returns {void}
   */
  function refreshNoteLinks(noteId, content) {
    const targetIds = resolveNoteLinkTargetIds(noteId, content)
    const deleteLinks = database.prepare("DELETE FROM note_links WHERE source_note_id = ?")
    const insertLink = database.prepare(
      "INSERT OR IGNORE INTO note_links(source_note_id, target_note_id) VALUES (?, ?)"
    )
    const rebuild = database.transaction(() => {
      deleteLinks.run(noteId)
      for (const targetId of targetIds) insertLink.run(noteId, targetId)
    })
    rebuild()
  }

  /**
   * 为所有未删除的笔记重建一次引用关系，仅在解析规则升级时触发。
   *
   * 版本号语义：`note_links_version` 记录的**不是**表结构版本，而是
   * `resolveNoteLinkTargetIds` 的解析规则版本 —— 规则一变，旧库里的关系就是错的，
   * 必须整表重建一次。当前版本 3（笔记嵌入新增 `data-xynote-embed-server` 来源：
   * 网页端插入的卡片只写跨端属性，旧库按「只认 `data-xynote-embed`」解析会整条漏掉）。
   *
   * :return: 无返回值。
   */
  function rebuildAllNoteLinks() {
    const version = database.prepare(
      "SELECT value FROM sync_state WHERE key = 'note_links_version'"
    ).get()?.value
    if (version === "3") return
    const rows = database.prepare("SELECT id, content FROM notes WHERE is_deleted = 0").all()
    const insertLink = database.prepare(
      "INSERT OR IGNORE INTO note_links(source_note_id, target_note_id) VALUES (?, ?)"
    )
    const rebuild = database.transaction(() => {
      database.prepare("DELETE FROM note_links").run()
      for (const row of rows) {
        for (const targetId of resolveNoteLinkTargetIds(row.id, row.content)) {
          insertLink.run(row.id, targetId)
        }
      }
      database.prepare(`
        INSERT INTO sync_state(key, value) VALUES ('note_links_version', '3')
        ON CONFLICT(key) DO UPDATE SET value = excluded.value
      `).run()
    })
    rebuild()
  }

  /**
   * 遍历笔记，计算每篇正文里的本机地址能改写多少条。
   *
   * @param {string} webBaseUrl 网页版地址前缀。
   * @param {Array<{ id: string, title: string, content: string }> | null} [rows] 指定待扫描的笔记；
   *   省略时扫全库。给「同步完成后的提示」用：那条路径已经先用 SQL 把候选缩到含本机地址的笔记，
   *   不必把全库正文再捞一遍（`totals.scannedNotes` 随之表示「实际扫描的篇数」）。
   * @returns {{
   *   totals: {
   *     scannedNotes: number, linkedNotes: number, totalLinks: number,
   *     convertibleLinks: number, missingLinks: number, unsyncedLinks: number, noWebBaseLinks: number
   *   },
   *   affected: Array<{ id: string, title: string, content: string, changed: number }>
   * }} 统计与待改写项。
   */
  function collectLocalNoteLinkRewrite(webBaseUrl, rows = null) {
    const scannedRows = rows || database.prepare("SELECT id, title, content FROM notes WHERE is_deleted = 0").all()
    const findTarget = database.prepare(
      "SELECT id, server_id FROM notes WHERE id = ? AND is_deleted = 0"
    )
    // 同一目标常被多篇（甚至同一篇多次）引用，缓存一次解析结果。
    const targetCache = new Map()
    const resolveTarget = (targetId) => {
      if (targetCache.has(targetId)) return targetCache.get(targetId)
      const row = findTarget.get(targetId)
      const resolved = row ? { id: row.id, serverId: row.server_id } : null
      targetCache.set(targetId, resolved)
      return resolved
    }
    const totals = {
      scannedNotes: scannedRows.length,
      linkedNotes: 0,
      totalLinks: 0,
      convertibleLinks: 0,
      missingLinks: 0,
      unsyncedLinks: 0,
      noWebBaseLinks: 0
    }
    const affected = []
    for (const row of scannedRows) {
      const outcome = rewriteLocalNoteLinksInContent(row.content, { resolveTarget, webBaseUrl })
      if (!outcome.total) continue
      totals.linkedNotes += 1
      totals.totalLinks += outcome.total
      totals.convertibleLinks += outcome.changed
      totals.missingLinks += outcome.missing
      totals.unsyncedLinks += outcome.unsynced
      totals.noWebBaseLinks += outcome.noWebBase
      if (outcome.changed > 0) {
        affected.push({
          id: row.id,
          title: row.title || "（无标题）",
          content: outcome.content,
          changed: outcome.changed
        })
      }
    }
    return { totals, affected }
  }

  /**
   * 扫描全库正文里仍使用本机地址的笔记链接，**只读**统计可转成网页地址的范围。
   *
   * 存在的意义：`buildNoteHref` 只在插入那一刻决定地址，历史链接与「先插链接、目标后同步」
   * 的链接都不会回填（见 `docs/specs/2026-09-05-note-link-online-url.md` 的「存量不清扫」决策）。
   * 这里把「要不要清扫」交给用户手动决定，先给一份可预览的账。
   *
   * @param {string} webBaseUrl 网页版地址前缀（来自同步设置）。
   * @returns {{
   *   scannedNotes: number, linkedNotes: number, convertibleNotes: number,
   *   totalLinks: number, convertibleLinks: number,
   *   missingLinks: number, unsyncedLinks: number, noWebBaseLinks: number,
   *   samples: Array<{ noteId: string, title: string, changed: number }>
   * }} 预览统计。
   */
  function previewLocalNoteLinkRewrite(webBaseUrl) {
    const { totals, affected } = collectLocalNoteLinkRewrite(webBaseUrl)
    return {
      scannedNotes: totals.scannedNotes,
      linkedNotes: totals.linkedNotes,
      convertibleNotes: affected.length,
      totalLinks: totals.totalLinks,
      convertibleLinks: totals.convertibleLinks,
      missingLinks: totals.missingLinks,
      unsyncedLinks: totals.unsyncedLinks,
      noWebBaseLinks: totals.noWebBaseLinks,
      samples: affected.slice(0, 5).map((item) => ({
        noteId: item.id,
        title: item.title,
        changed: item.changed
      }))
    }
  }

  /**
   * 同步完成时的提示用：本轮新同步上去的笔记，是不是让正文里的本机地址「现在可以转」了。
   *
   * 与 `previewLocalNoteLinkRewrite`（用户主动点「本机地址转为线上地址」）同一套口径，区别只在
   * **扫描范围**：这里先用 SQL 把候选缩到「正文里还含本机地址写法」的笔记 —— 绝大多数正文没有
   * 这种地址，别让每次同步都把全库正文捞进 JS 跑一遍正则。
   *
   * 返回 `null` 表示「没什么可说的」（没有候选 / 没配网页地址 / 一条都转不了）；同步完成面板
   * 据此决定要不要出声。**全程只读，不改任何数据** —— 真改写仍要用户点确认。
   *
   * @param {string} webBaseUrl 网页版地址前缀（来自同步设置）。
   * @returns {{ convertibleNotes: number, convertibleLinks: number, unsyncedLinks: number, missingLinks: number } | null}
   *   可转范围；没有可提示的内容时为 `null`。
   */
  function previewLocalNoteLinkHint(webBaseUrl) {
    // LIKE 里的两个字面量不含 `%` / `_`，无需转义。两处写法与 `local-note-links.cjs` 同口径。
    const rows = database.prepare(`
      SELECT id, title, content FROM notes
      WHERE is_deleted = 0
        AND (content LIKE '%xinyue-note.local%' OR content LIKE '%xinyue-notes://note/%')
    `).all()
    if (!rows.length) return null
    const { totals, affected } = collectLocalNoteLinkRewrite(webBaseUrl, rows)
    if (!totals.convertibleLinks) return null
    return {
      convertibleNotes: affected.length,
      convertibleLinks: totals.convertibleLinks,
      unsyncedLinks: totals.unsyncedLinks,
      missingLinks: totals.missingLinks
    }
  }

  /**
   * 把全库正文里的本机笔记地址改写成网页版地址。
   *
   * ⚠️ 逐篇走 `updateNote` 而非直接 `UPDATE notes`：只有这条路径会一并处理历史版本、
   * `dirty = 1`、`refreshNoteLinks` 与同步入队。**关系表必须跟着刷新**
   * （note_links 硬规则第 2 条），否则改完正文后「关系」面板与图谱会停在旧数据上。
   *
   * 改写前后的引用关系不会漂：网页地址 `{web}/notes/{serverId}` 仍被
   * `resolveNoteLinkTargetIds` 的 webLinkPattern 认回同一篇本地笔记。
   *
   * @param {string} webBaseUrl 网页版地址前缀（来自同步设置）。
   * @returns {{
   *   noteCount: number, linkCount: number,
   *   missingLinks: number, unsyncedLinks: number, noWebBaseLinks: number,
   *   changedNotes: Array<{ id: string, title: string, changed: number }>
   * }} 实际改写结果。
   */
  function rewriteLocalNoteLinks(webBaseUrl) {
    const { totals, affected } = collectLocalNoteLinkRewrite(webBaseUrl)
    const changedNotes = []
    for (const item of affected) {
      const updated = updateNote(item.id, { content: item.content })
      if (!updated) continue
      changedNotes.push({ id: item.id, title: item.title, changed: item.changed })
    }
    return {
      noteCount: changedNotes.length,
      linkCount: changedNotes.reduce((sum, item) => sum + item.changed, 0),
      missingLinks: totals.missingLinks,
      unsyncedLinks: totals.unsyncedLinks,
      noWebBaseLinks: totals.noWebBaseLinks,
      changedNotes
    }
  }

  /**
   * 扫描全库正文，收集需要补跨端标识的嵌入卡片（读操作，不落库）。
   *
   * 与 `collectLocalNoteLinkRewrite` 并列：那条处理 URL 链接、**明确不碰嵌入卡**，
   * 这条只管嵌入卡。两者共用「按 id 查目标并缓存」的解析口径，但目标不同、互不替代。
   *
   * @returns {{
   *   totals: {
   *     scannedNotes: number, embeddedNotes: number, totalEmbeds: number,
   *     fillableEmbeds: number, missingEmbeds: number, unsyncedEmbeds: number,
   *     alreadyFilledEmbeds: number
   *   },
   *   affected: Array<{ id: string, title: string, content: string, changed: number }>
   * }} 统计与待写入项（`affected[].content` 已是补好标识的新正文）。
   */
  function collectEmbedServerIdFill() {
    const rows = database.prepare("SELECT id, title, content FROM notes WHERE is_deleted = 0").all()
    const findTarget = database.prepare(
      "SELECT id, server_id FROM notes WHERE id = ? AND is_deleted = 0"
    )
    // 同一目标常被多篇（甚至同一篇多次）嵌入，缓存一次解析结果。
    const targetCache = new Map()
    const resolveTarget = (targetId) => {
      if (targetCache.has(targetId)) return targetCache.get(targetId)
      const row = findTarget.get(targetId)
      const resolved = row ? { id: row.id, serverId: row.server_id } : null
      targetCache.set(targetId, resolved)
      return resolved
    }
    const totals = {
      scannedNotes: rows.length,
      embeddedNotes: 0,
      totalEmbeds: 0,
      fillableEmbeds: 0,
      missingEmbeds: 0,
      unsyncedEmbeds: 0,
      alreadyFilledEmbeds: 0
    }
    const affected = []
    for (const row of rows) {
      const outcome = fillEmbedServerIdsInContent(row.content, { resolveTarget })
      if (!outcome.total) continue
      totals.embeddedNotes += 1
      totals.totalEmbeds += outcome.total
      totals.fillableEmbeds += outcome.changed
      totals.missingEmbeds += outcome.missing
      totals.unsyncedEmbeds += outcome.unsynced
      totals.alreadyFilledEmbeds += outcome.alreadyFilled
      if (outcome.changed > 0) {
        affected.push({
          id: row.id,
          title: row.title || "（无标题）",
          content: outcome.content,
          changed: outcome.changed
        })
      }
    }
    return { totals, affected }
  }

  /**
   * 扫描全库正文里的嵌入卡片，**只读**统计有多少张缺跨端标识。
   *
   * 为什么需要人工触发：嵌入卡以本机 uuid 承载，网页端只认服务端数字主键。新插入的卡片
   * 会直接带上跨端标识，**存量卡片**没有 —— 与「本机地址转为线上地址」同样属于存量清理，
   * 由用户先看账再决定。设计见 docs/specs/2026-10-12-note-embed-web-render.md。
   *
   * @returns {{
   *   scannedNotes: number, embeddedNotes: number, convertibleNotes: number,
   *   totalEmbeds: number, fillableEmbeds: number,
   *   missingEmbeds: number, unsyncedEmbeds: number, alreadyFilledEmbeds: number,
   *   samples: Array<{ noteId: string, title: string, changed: number }>
   * }} 预览统计。
   */
  function previewEmbedServerIdFill() {
    const { totals, affected } = collectEmbedServerIdFill()
    return {
      scannedNotes: totals.scannedNotes,
      embeddedNotes: totals.embeddedNotes,
      convertibleNotes: affected.length,
      totalEmbeds: totals.totalEmbeds,
      fillableEmbeds: totals.fillableEmbeds,
      missingEmbeds: totals.missingEmbeds,
      unsyncedEmbeds: totals.unsyncedEmbeds,
      alreadyFilledEmbeds: totals.alreadyFilledEmbeds,
      samples: affected.slice(0, 5).map((item) => ({
        noteId: item.id,
        title: item.title,
        changed: item.changed
      }))
    }
  }

  /**
   * 给全库正文里的嵌入卡片补上跨端标识属性。
   *
   * ⚠️ 逐篇走 `updateNote` 而非直接 `UPDATE notes`：只有这条路径会一并处理历史版本、
   * `dirty = 1`、`refreshNoteLinks` 与同步入队。补的是 `data-xynote-embed-server`，
   * **不改** `data-xynote-embed`（本机 ID 是桌面端解析键），所以引用关系本身不变；
   * 但正文既然落库就必须走同一条受控路径（note_links 硬规则第 2 条）。
   *
   * @returns {{
   *   noteCount: number, embedCount: number,
   *   missingEmbeds: number, unsyncedEmbeds: number,
   *   changedNotes: Array<{ id: string, title: string, changed: number }>
   * }} 实际回填结果。
   */
  function fillEmbedServerIds() {
    const { totals, affected } = collectEmbedServerIdFill()
    const changedNotes = []
    for (const item of affected) {
      const updated = updateNote(item.id, { content: item.content })
      if (!updated) continue
      changedNotes.push({ id: item.id, title: item.title, changed: item.changed })
    }
    return {
      noteCount: changedNotes.length,
      embedCount: changedNotes.reduce((sum, item) => sum + item.changed, 0),
      missingEmbeds: totals.missingEmbeds,
      unsyncedEmbeds: totals.unsyncedEmbeds,
      changedNotes
    }
  }

  /**
   * 查询引用了指定笔记的所有本地笔记。
   *
   * @param {string} noteId 目标笔记 ID。
   * @returns {Array<{ id: string, title: string, isDeleted: boolean, updatedAt: string }>} 引用来源列表。
   */
  function getBacklinks(noteId) {
    return database.prepare(`
      SELECT n.id AS id, n.title AS title, n.folder_id AS folderId,
             n.is_deleted AS isDeleted, n.updated_at AS updatedAt
      FROM note_links l
      JOIN notes n ON n.id = l.source_note_id
      WHERE l.target_note_id = ? AND n.is_deleted = 0
      ORDER BY n.updated_at DESC
    `).all(noteId).map((row) => ({
      id: row.id,
      title: row.title || "（无标题）",
      folderId: row.folderId,
      isDeleted: Boolean(row.isDeleted),
      updatedAt: row.updatedAt
    }))
  }

  /**
   * 查询指定笔记显式引用了的本地笔记（出边）。
   *
   * 与 getBacklinks 方向相反：一个回答“谁引用了我”，一个回答“我引用了谁”。
   * 同样只读 note_links 表（显式链接），不做标题字符串匹配。已删除笔记不参与。
   *
   * @param {string} noteId 源笔记 ID。
   * @returns {Array<{ id: string, title: string, folderId: string | null, isDeleted: boolean, updatedAt: string }>} 被引用笔记列表。
   */
  function getNoteOutlinks(noteId) {
    return database.prepare(`
      SELECT n.id AS id, n.title AS title, n.folder_id AS folderId,
             n.is_deleted AS isDeleted, n.updated_at AS updatedAt
      FROM note_links l
      JOIN notes n ON n.id = l.target_note_id
      WHERE l.source_note_id = ? AND n.is_deleted = 0
      ORDER BY n.updated_at DESC
    `).all(noteId).map((row) => ({
      id: row.id,
      title: row.title || "（无标题）",
      folderId: row.folderId,
      isDeleted: Boolean(row.isDeleted),
      updatedAt: row.updatedAt
    }))
  }

  /**
   * 以指定笔记为中心，向外/向内展开 maxDepth 跳的局部引用图谱。
   *
   * 只基于 note_links 表（显式链接），每跳同时覆盖“引用它”与“它引用”两个方向，
   * 用递归 CTE 配合路径串防环。已删除笔记不参与。
   *
   * @param {string} noteId 中心笔记 ID。
   * @param {number} maxDepth 最大跳数（1-3，超出截断）。
   * @returns {{ nodes: Array<{ id: string, title: string, folderId: string | null, depth: number }>, links: Array<{ source: string, target: string }>, rootId: string }} 图谱数据。
   */
  function getNoteGraph(noteId, maxDepth = 2) {
    const depth = Math.max(1, Math.min(3, Number(maxDepth) || 2))
    const root = database.prepare("SELECT id FROM notes WHERE id = ? AND is_deleted = 0").get(noteId)
    if (!root) return { nodes: [], links: [], rootId: noteId }

    // 递归 CTE：从中心出发，沿 note_links 双向展开（source -> target 及反向）。
    // 用 path 记录已访问节点串，避免环形引用导致无限递归。
    const rows = database.prepare(`
      WITH RECURSIVE reach(note_id, depth, path) AS (
        SELECT :root, 0, ',' || :root || ','
        UNION ALL
        SELECT next.target_id, reach.depth + 1, reach.path || next.target_id || ','
        FROM reach
        JOIN (
          SELECT source_note_id AS source_id, target_note_id AS target_id FROM note_links WHERE source_note_id != target_note_id
          UNION ALL
          SELECT target_note_id AS source_id, source_note_id AS target_id FROM note_links WHERE source_note_id != target_note_id
        ) next ON next.source_id = reach.note_id
        WHERE reach.depth < :depth
          AND instr(reach.path, ',' || next.target_id || ',') = 0
      )
      SELECT n.id AS id, n.title AS title, n.folder_id AS folderId,
             reach.depth AS depth
      FROM reach
      LEFT JOIN notes n ON n.id = reach.note_id
      WHERE n.is_deleted = 0 OR reach.note_id = :root
      ORDER BY reach.depth, n.title
    `).all({ root: noteId, depth })

    const nodes = rows.map((row) => ({
      id: row.id,
      title: row.title || "（无标题）",
      folderId: row.folderId,
      depth: row.depth
    }))

    const nodeIds = new Set(nodes.map((node) => node.id))
    // 收集可达集合内的邻接边（去重、排除自环），方向统一为 source -> target 的有向边。
    const edgeRows = database.prepare(`
      SELECT DISTINCT source_note_id AS source, target_note_id AS target
      FROM note_links
      WHERE source_note_id != target_note_id
    `).all()
    const links = edgeRows
      .filter((edge) => nodeIds.has(edge.source) && nodeIds.has(edge.target))
      .map((edge) => ({ source: edge.source, target: edge.target }))

    return { nodes, links, rootId: noteId }
  }

  /**
   * 构建全库双链关系图谱。
   *
   * 只纳入至少参与一条关系的未删除笔记，并按连接度从高到低裁剪到上限，
   * 避免全库节点过多时力导向布局卡顿。返回的边均为两端都在节点集合内的去重有向边。
   *
   * @param {number} [maxNodes=500] 节点数量上限。
   * @returns {{ nodes: Array<{ id: string, title: string, folderId: string | null, depth: number }>, links: Array<{ source: string, target: string }> }} 全库图谱数据。
   */
  function getGlobalGraph(maxNodes = 500) {
    // maxNodes 是节点的硬上限，避免渲染超大图；下限为 1，防止取非正值时返回空图。
    const requested = Number(maxNodes)
    const limit = Math.max(1, Math.min(1000, Number.isFinite(requested) && requested > 0 ? requested : 500))
    const liveRows = database.prepare(`
      SELECT id, title, folder_id AS folderId FROM notes WHERE is_deleted = 0
    `).all()
    const liveById = new Map(liveRows.map((row) => [row.id, row]))
    if (liveById.size === 0) return { nodes: [], links: [] }

    const edgeRows = database.prepare(`
      SELECT DISTINCT source_note_id AS source, target_note_id AS target
      FROM note_links WHERE source_note_id != target_note_id
    `).all()

    // 只保留两端都是未删除笔记的边，并累计每条节点被引用的次数作为连接度。
    const degreeByNode = new Map()
    const validEdges = []
    for (const edge of edgeRows) {
      if (!liveById.has(edge.source) || !liveById.has(edge.target)) continue
      validEdges.push(edge)
      degreeByNode.set(edge.source, (degreeByNode.get(edge.source) || 0) + 1)
      degreeByNode.set(edge.target, (degreeByNode.get(edge.target) || 0) + 1)
    }
    if (validEdges.length === 0) return { nodes: [], links: [] }

    // 有参与关系的节点按连接度降序，再按标题稳定排序后截断。
    const rankedNodeIds = [...degreeByNode.keys()]
      .sort((left, right) => {
        const byDegree = (degreeByNode.get(right) || 0) - (degreeByNode.get(left) || 0)
        if (byDegree !== 0) return byDegree
        return String(liveById.get(left)?.title || "").localeCompare(String(liveById.get(right)?.title || ""))
      })
      .slice(0, limit)
    const selectedIds = new Set(rankedNodeIds)
    const nodes = rankedNodeIds.map((id) => ({
      id,
      title: liveById.get(id)?.title || "（无标题）",
      folderId: liveById.get(id)?.folderId ?? null,
      depth: 0
    }))
    const links = validEdges
      .filter((edge) => selectedIds.has(edge.source) && selectedIds.has(edge.target))
      .map((edge) => ({ source: edge.source, target: edge.target }))
    return { nodes, links }
  }

  /** 返回仍待处理且原笔记存在的同步冲突。 */
  function listNoteConflicts() {
    return database.prepare(`
      SELECT id, conflict_source_id AS sourceId
      FROM notes
      WHERE conflict_source_id IS NOT NULL
      ORDER BY updated_at DESC
    `).all().map((row) => ({
      original: getNote(row.sourceId),
      conflict: getNote(row.id)
    })).filter((pair) => pair.original && pair.conflict)
  }

  /** 将即将丢弃的冲突副本保存为原笔记的历史版本。 */
  function preserveConflictAsHistory(originalId, conflict) {
    const title = String(conflict.title || "")
      .replace(/（冲突副本）$/, "")
      .slice(0, 100) || "无标题笔记"
    const tagNames = selectTagsForNote.all(conflict.id).map((tag) => tag.name)
    database.prepare(`
      INSERT INTO note_history(id, note_id, title, content, folder_id, tag_names, created_at, dirty)
      VALUES (?, ?, ?, ?, ?, ?, ?, 1)
    `).run(
      randomUUID(),
      originalId,
      title,
      validateNoteContent(conflict.content),
      conflict.folder_id,
      JSON.stringify(tagNames),
      nowIso()
    )
    database.prepare(`
      DELETE FROM note_history
      WHERE note_id = ? AND id NOT IN (
        SELECT id FROM note_history WHERE note_id = ? ORDER BY created_at DESC LIMIT 50
      )
    `).run(originalId, originalId)
  }

  /**
   * 在一个事务内处理同步冲突。
   *
   * @param {string} conflictNoteId 冲突副本 ID。
   * @param {"local" | "remote" | "both"} strategy 处理策略。
   * @returns {{ strategy: string, note: Record<string, any> }} 处理结果。
   */
  const resolveNoteConflict = database.transaction((conflictNoteId, strategy) => {
    if (!["local", "remote", "both"].includes(strategy)) throw new Error("不支持的冲突处理方式")
    const conflict = database.prepare("SELECT * FROM notes WHERE id = ? AND conflict_source_id IS NOT NULL")
      .get(conflictNoteId)
    if (!conflict) throw new Error("冲突副本不存在或已处理")
    const original = database.prepare("SELECT * FROM notes WHERE id = ?").get(conflict.conflict_source_id)
    if (!original) throw new Error("冲突对应的原笔记不存在")

    if (strategy === "both") {
      database.prepare(`
        UPDATE notes SET conflict_source_id = NULL, updated_at = ?, dirty = 1 WHERE id = ?
      `).run(nowIso(), conflictNoteId)
      const retained = getNote(conflictNoteId)
      enqueue("note", conflictNoteId, "upsert", retained)
      return { strategy, note: retained }
    }

    if (strategy === "local") {
      createHistoryIfNeeded(original, true)
      const mergedContent = validateNoteContent(conflict.content)
      database.prepare(`
        UPDATE notes
        SET folder_id = ?, title = ?, content = ?, is_pinned = ?, is_deleted = ?,
            deleted_at = ?, deleted_by_folder_id = ?, updated_at = ?, dirty = 1
        WHERE id = ?
      `).run(
        conflict.folder_id,
        String(conflict.title || "").replace(/（冲突副本）$/, "").slice(0, 100) || "无标题笔记",
        mergedContent,
        conflict.is_pinned,
        conflict.is_deleted,
        conflict.deleted_at,
        conflict.deleted_by_folder_id,
        nowIso(),
        original.id
      )
      // 副本正文整体覆盖了原笔记，引用关系必须按新正文重算；两个版本的链接可能完全不同。
      refreshNoteLinks(original.id, mergedContent)
      replaceNoteTags(original.id, selectTagsForNote.all(conflictNoteId).map((tag) => tag.name))
      enqueue("note", original.id, "upsert", getNote(original.id))
    } else {
      preserveConflictAsHistory(original.id, conflict)
    }

    database.prepare("DELETE FROM outbox WHERE entity_type = 'note' AND entity_id = ?").run(conflictNoteId)
    database.prepare("DELETE FROM notes WHERE id = ?").run(conflictNoteId)
    if (conflict.server_id) {
      enqueue("note", conflictNoteId, "delete", { id: conflictNoteId, serverId: conflict.server_id })
    }
    return { strategy, note: getNote(original.id) }
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
    const current = getNote(noteId)
    const currentFolder = current?.folderId ? getFolder(current.folderId) : null
    const targetFolderId = !deleted && currentFolder?.isDeleted ? null : current?.folderId ?? null
    database.prepare(`
      UPDATE notes
      SET folder_id = ?, is_deleted = ?, deleted_at = ?, deleted_by_folder_id = NULL,
          updated_at = ?, dirty = 1
      WHERE id = ?
    `).run(targetFolderId, Number(deleted), deleted ? timestamp : null, timestamp, noteId)
    const note = getNote(noteId)
    if (note) enqueue("note", noteId, "upsert", note)
    return note
  }

  /**
   * 在单个事务中批量修改笔记属性，并为每篇发生变化的笔记写入同步队列。
   *
   * @param {string[]} noteIds 待修改的笔记 ID。
   * @param {Record<string, any>} patch 批量修改内容。
   * @returns {Record<string, any>[]} 更新后的笔记。
   */
  const bulkUpdateNotes = database.transaction((noteIds, patch = {}) => {
    const ids = [...new Set(Array.isArray(noteIds) ? noteIds.filter((id) => typeof id === "string" && id) : [])]
    if (!ids.length) return []
    if (ids.length > 1000) throw new Error("单次最多批量处理 1000 篇笔记")
    const notes = ids.map((noteId) => {
      const note = getNote(noteId)
      if (!note) throw new Error(`笔记不存在：${noteId}`)
      return note
    })
    if (patch.permanentlyDelete) {
      if (notes.some((note) => !note.isDeleted)) throw new Error("只能永久删除回收站中的笔记")
      for (const note of notes) deleteNotePermanently(note.id)
      return []
    }
    if (Object.hasOwn(patch, "folderId") && patch.folderId !== null) {
      const folder = database.prepare("SELECT id FROM folders WHERE id = ? AND is_deleted = 0").get(patch.folderId)
      if (!folder) throw new Error("目标文件夹不存在或已在回收站")
    }
    const addTagNames = normalizeTagNames(Array.isArray(patch.addTagNames) ? patch.addTagNames : [])
    const removeTagNames = new Set(normalizeTagNames(Array.isArray(patch.removeTagNames) ? patch.removeTagNames : []))
    return notes.map((note) => {
      const notePatch = {}
      if (Object.hasOwn(patch, "folderId")) notePatch.folderId = patch.folderId
      if (typeof patch.isPinned === "boolean") notePatch.isPinned = patch.isPinned
      if (addTagNames.length || removeTagNames.size) {
        const tagNames = note.tags.map((tag) => tag.name).filter((name) => !removeTagNames.has(name))
        notePatch.tagNames = [...new Set([...tagNames, ...addTagNames])]
      }
      if (Object.keys(notePatch).length) updateNote(note.id, notePatch)
      if (typeof patch.isDeleted === "boolean") setNoteDeleted(note.id, patch.isDeleted)
      return getNote(note.id)
    })
  })

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
    const workspace = listFullWorkspace()
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
      const importedContent = validateNoteContent(document.content)
      database.prepare(`
        INSERT INTO notes(
          id, folder_id, title, content, created_at, updated_at, dirty
        ) VALUES (?, ?, ?, ?, ?, ?, 1)
      `).run(
        id,
        documentFolderId,
        String(document.title || "无标题笔记").trim().slice(0, 100) || "无标题笔记",
        importedContent,
        timestamp,
        timestamp
      )
      // 导入的 Markdown 里可能带线上笔记链接（/{notes|articles}/{serverId} 形式），
      // 不刷新的话这些关系不会进 note_links。
      refreshNoteLinks(id, importedContent)
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
      const importedContent = validateNoteContent(note.content)
      database.prepare(`
        INSERT INTO notes(
          id, folder_id, title, content, is_pinned, created_at, updated_at, dirty
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 1)
      `).run(
        id,
        folderIds.get(note.folderId) || rootFolder.id,
        String(note.title || "无标题笔记").trim().slice(0, 100) || "无标题笔记",
        importedContent,
        Number(Boolean(note.isPinned)),
        createdAt,
        updatedAt
      )
      // 备份正文里的线上笔记链接（/{notes|articles}/{serverId}）需要在这里建立关系；
      // 指向旧库本地 ID 的链接会因导入后换 ID 而解析不到，属预期（导入即复制为新副本）。
      refreshNoteLinks(id, importedContent)
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
   * @returns {{ conflictCount: number, newlySyncedNoteIds: string[] }} 应用结果。
   *   `newlySyncedNoteIds` = 本轮**从「没有 server_id」变成有**的笔记：同步完成后的
   *   「本机地址可以转网页地址了」提示只看这批，不必每次同步都去扫全库。
   */
  const applySyncResult = database.transaction((result, acknowledgedOutboxIds = null) => {
    const snapshot = result.snapshot || { folders: [], tags: [], notes: [] }
    const hasHistorySnapshot = Array.isArray(snapshot.histories)
    const conflictIds = new Set(result.conflictClientIds || [])
    // 先一次性取「已经同步过的笔记」，避免为每条映射单查一次（首次全量同步时映射会很多）。
    const alreadySyncedNoteIds = new Set(
      database.prepare("SELECT id FROM notes WHERE server_id IS NOT NULL AND server_id <> ''")
        .all()
        .map((row) => String(row.id))
    )
    const newlySyncedNoteIds = []
    for (const mapping of result.mappings || []) {
      const tableName = mapping.entityType === "folder"
        ? "folders"
        : mapping.entityType === "tag" ? "tags" : "notes"
      database.prepare(`
        UPDATE ${tableName}
        SET server_id = ?, server_updated_at = ?
        WHERE id = ?
      `).run(String(mapping.serverId), mapping.updatedAt || null, mapping.clientId)
      if (
        tableName === "notes"
        && mapping.serverId
        && !alreadySyncedNoteIds.has(String(mapping.clientId))
      ) {
        newlySyncedNoteIds.push(String(mapping.clientId))
      }
    }

    for (const clientId of conflictIds) {
      const current = getNote(clientId)
      if (!current) continue
      const conflictId = randomUUID()
      const timestamp = nowIso()
      database.prepare(`
        INSERT INTO notes(
          id, folder_id, title, content, is_pinned, is_deleted, deleted_at,
          deleted_by_folder_id, conflict_source_id,
          created_at, updated_at, dirty
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
      `).run(
        conflictId,
        current.folderId,
        `${current.title}（冲突副本）`.slice(0, 100),
        current.content,
        Number(current.isPinned),
        Number(current.isDeleted),
        current.deletedAt,
        current.deletedByFolderId,
        current.id,
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
    /**
     * 本次快照落库的笔记（[本地 id, 落库正文]）。
     * 必须等**整批**笔记都写完再统一重算引用关系：快照内两篇笔记互相引用时，
     * 被引用方可能排在后面尚未插入，逐条即时刷新会漏掉这类边。
     */
    const syncedNoteContents = []
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
      // 远端正文里的图片/附件地址需本地化后再落库；关系表也必须用这同一份字符串，
      // 保证「库里存的正文」与「解析引用关系用的正文」完全一致。
      const localizedContent = localizeImageAssetReferences(remote.content)
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
          localizedContent,
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
          localizedContent,
          Number(remote.isPinned),
          Number(remote.isDeleted),
          remote.deletedTime,
          folderLocalIds.get(remote.deletedByFolderClientId) || null,
          remote.updatedAt,
          remote.updatedAt,
          localId
        )
      }
      // 正文先记账，等整批笔记落库完毕后统一重算引用关系（见 syncedNoteContents 注释）。
      syncedNoteContents.push([localId, localizedContent])
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

    // 整批笔记落库完毕，统一重算引用关系：网页端新增/删除的链接与嵌入卡片要同步反映到
    // 本地 note_links，否则「关系」面板与图谱会一直停在旧数据上，直到本地编辑一次。
    for (const [syncedNoteId, syncedContent] of syncedNoteContents) {
      refreshNoteLinks(syncedNoteId, syncedContent)
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
    return { conflictCount: conflictIds.size, newlySyncedNoteIds }
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

  rebuildAllNoteLinks()

  return {
    backupTo,
    close: () => database.close(),
    relocateImageAssetPaths,
    listWorkspace,
    listFullWorkspace,
    getWorkspaceSession,
    saveWorkspaceSession,
    saveNoteViewState,
    listAiConversations,
    getAiConversation,
    appendAiConversationTurn,
    replaceAiConversationTurn,
    renameAiConversation,
    setAiConversationPinned,
    deleteAiConversation,
    clearAiConversations,
    getNote,
    getNoteForEditing,
    searchNotes,
    createNote,
    duplicateNote,
    createQuickNote,
    updateNote,
    getBacklinks,
    getNoteOutlinks,
    getNoteGraph,
    getGlobalGraph,
    previewLocalNoteLinkRewrite,
    previewLocalNoteLinkHint,
    rewriteLocalNoteLinks,
    previewEmbedServerIdFill,
    fillEmbedServerIds,
    bulkUpdateNotes,
    listNoteConflicts,
    resolveNoteConflict,
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
    expandAssetReferences: expandImageAssetReferences,
    exportBackup,
    importBackup,
    importMarkdownDocuments,
    createAsset: createImageAsset,
    createImageAsset,
    getAsset: getImageAsset,
    getImageAsset,
    listAssets: listImageAssets,
    listImageAssets,
    listAttachmentInventory,
    listPendingAssets: listPendingImageAssets,
    listPendingImageAssets,
    listRemoteAttachmentReferencesToCache,
    listRemoteImageUrlsToCache,
    markAssetUploaded: markImageAssetUploaded,
    markImageAssetUploaded,
    deleteOrphanAsset,
    getSyncBatch,
    applySyncResult
  }
}

module.exports = { openNotesDatabase }
