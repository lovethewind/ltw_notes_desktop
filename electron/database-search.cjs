/** 将笔记正文转换为工作区使用的短摘要。 */
function createNoteContentPreview(content, maxLength = 240) {
  const scanLength = Math.max(1024, maxLength * 6)
  return String(content || "")
    .slice(0, scanLength)
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/[#>*_`~[\]()!-]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength)
}

/** 从完整正文中截取包含搜索词的上下文。 */
function createNoteSearchExcerpt(content, keyword) {
  const normalizedKeyword = String(keyword || "").trim().toLocaleLowerCase()
  const text = String(content || "")
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/[#>*_`~[\]()!-]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
  const matchIndex = text.toLocaleLowerCase().indexOf(normalizedKeyword)
  if (matchIndex < 0) return createNoteContentPreview(content)
  const start = Math.max(0, matchIndex - 48)
  const end = Math.min(text.length, matchIndex + normalizedKeyword.length + 96)
  return `${start > 0 ? "…" : ""}${text.slice(start, end)}${end < text.length ? "…" : ""}`
}

/** 使用 SQLite FTS5 搜索标题与完整正文，并组合本地结构化筛选条件。 */
function searchNotes(database, keyword, options, dependencies) {
  const normalizedKeyword = String(keyword || "").trim()
  const requestedLimit = Number(options?.limit || 200)
  const limit = Math.max(1, Math.min(Number.isFinite(requestedLimit) ? requestedLimit : 200, 1000))
  const folderIds = new Set((Array.isArray(options?.folderIds) ? options.folderIds : [])
    .map((id) => String(id || "").trim()).filter(Boolean))
  const tagIds = new Set((Array.isArray(options?.tagIds) ? options.tagIds : [])
    .map((id) => String(id || "").trim()).filter(Boolean))
  const updatedAfterTimestamp = Date.parse(String(options?.updatedAfter || ""))
  const hasUpdatedAfter = Number.isFinite(updatedAfterTimestamp)
  const pinnedOnly = options?.pinnedOnly === true
  const hasFilters = folderIds.size > 0 || tagIds.size > 0 || hasUpdatedAfter || pinnedOnly
  if (!normalizedKeyword && !hasFilters) return []

  // 结构化条件必须在 LIMIT 前由 SQLite 应用，否则大笔记库会先截断候选再漏掉有效结果。
  const filterClauses = []
  const filterParameters = []
  if (folderIds.size) {
    filterClauses.push(`notes.folder_id IN (${Array.from(folderIds, () => "?").join(",")})`)
    filterParameters.push(...folderIds)
  }
  if (pinnedOnly) filterClauses.push("notes.is_pinned = 1")
  if (hasUpdatedAfter) {
    filterClauses.push("notes.updated_at >= ?")
    filterParameters.push(new Date(updatedAfterTimestamp).toISOString())
  }
  if (tagIds.size) {
    filterClauses.push(`notes.id IN (
      SELECT note_id
      FROM note_tags
      WHERE tag_id IN (${Array.from(tagIds, () => "?").join(",")})
      GROUP BY note_id
      HAVING COUNT(DISTINCT tag_id) = ?
    )`)
    filterParameters.push(...tagIds, tagIds.size)
  }
  const structuredFilterSql = filterClauses.length ? ` AND ${filterClauses.join(" AND ")}` : ""
  const candidateLimit = limit
  const noteIds = []
  const seenIds = new Set()
  const appendRows = (rows) => {
    for (const row of rows) {
      if (seenIds.has(row.id)) continue
      seenIds.add(row.id)
      noteIds.push(row.id)
      if (noteIds.length >= candidateLimit) break
    }
  }

  if (!normalizedKeyword) {
    appendRows(database.prepare(`
      SELECT id
      FROM notes
      WHERE is_deleted = 0
        ${structuredFilterSql}
      ORDER BY is_pinned DESC, updated_at DESC
      LIMIT ?
    `).all(...filterParameters, candidateLimit))
  } else if (Array.from(normalizedKeyword).length >= 3) {
    const phrase = `"${normalizedKeyword.replace(/"/g, '""')}"`
    appendRows(database.prepare(`
      SELECT note_search.note_id AS id
      FROM note_search
      JOIN notes ON notes.id = note_search.note_id
      WHERE note_search MATCH ?
        AND notes.is_deleted = 0
        ${structuredFilterSql}
      ORDER BY bm25(note_search)
      LIMIT ?
    `).all(phrase, ...filterParameters, candidateLimit))
  } else {
    appendRows(database.prepare(`
      SELECT id
      FROM notes
      WHERE is_deleted = 0
        AND (instr(lower(title), lower(?)) > 0 OR instr(lower(content), lower(?)) > 0)
        ${structuredFilterSql}
      ORDER BY is_pinned DESC, updated_at DESC
      LIMIT ?
    `).all(normalizedKeyword, normalizedKeyword, ...filterParameters, candidateLimit))
  }

  if (normalizedKeyword && options?.includeMetadata && noteIds.length < candidateLimit) {
    appendRows(database.prepare(`
      SELECT DISTINCT notes.id
      FROM notes
      LEFT JOIN note_tags ON note_tags.note_id = notes.id
      LEFT JOIN tags ON tags.id = note_tags.tag_id
      LEFT JOIN folders ON folders.id = notes.folder_id
      WHERE notes.is_deleted = 0
        AND (instr(lower(tags.name), lower(?)) > 0
          OR instr(lower(folders.name), lower(?)) > 0)
        ${structuredFilterSql}
      ORDER BY notes.is_pinned DESC, notes.updated_at DESC
      LIMIT ?
    `).all(normalizedKeyword, normalizedKeyword, ...filterParameters, candidateLimit))
  }
  if (!noteIds.length) return []

  const placeholders = noteIds.map(() => "?").join(",")
  const rowsById = new Map(database.prepare(`
    SELECT * FROM notes WHERE id IN (${placeholders})
  `).all(...noteIds).map((row) => [row.id, row]))
  const tagsByNoteId = dependencies.selectTagsForNotes(noteIds)
  return noteIds.map((noteId) => {
    const row = rowsById.get(noteId)
    if (!row || row.is_deleted) return null
    if (folderIds.size && !folderIds.has(String(row.folder_id || ""))) return null
    if (pinnedOnly && !row.is_pinned) return null
    if (hasUpdatedAfter && Date.parse(row.updated_at) < updatedAfterTimestamp) return null
    const tags = tagsByNoteId.get(noteId) || []
    if (tagIds.size && !Array.from(tagIds).every((tagId) => tags.some((tag) => tag.id === tagId))) {
      return null
    }
    return {
      ...dependencies.mapNote(row, tags),
      content: normalizedKeyword
        ? createNoteSearchExcerpt(row.content, normalizedKeyword)
        : createNoteContentPreview(row.content),
      contentLoaded: false
    }
  }).filter(Boolean).slice(0, limit)
}

module.exports = {
  createNoteContentPreview,
  searchNotes
}
