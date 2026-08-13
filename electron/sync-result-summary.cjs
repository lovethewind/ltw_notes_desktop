const MAX_CHANGE_ITEMS = 6

/**
 * 生成只包含用户可见字段的稳定快照，忽略服务端 ID、脏标记和更新时间等同步元数据。
 *
 * @param {Record<string, any>} entity 工作区实体。
 * @param {"note" | "folder" | "tag"} entityType 实体类型。
 * @returns {string} 可比较快照。
 */
function getVisibleEntityFingerprint(entity, entityType) {
  if (entityType === "note") {
    return JSON.stringify({
      title: entity.title || "",
      content: entity.content || "",
      folderId: entity.folderId || null,
      isPinned: Boolean(entity.isPinned),
      isDeleted: Boolean(entity.isDeleted),
      deletedAt: entity.deletedAt || null,
      deletedByFolderId: entity.deletedByFolderId || null,
      tagNames: Array.isArray(entity.tags) ? entity.tags.map((tag) => tag.name).sort() : []
    })
  }
  if (entityType === "folder") {
    return JSON.stringify({
      name: entity.name || "",
      parentId: entity.parentId || null,
      sortOrder: Number(entity.sortOrder || 0),
      isDeleted: Boolean(entity.isDeleted),
      deletedAt: entity.deletedAt || null
    })
  }
  return JSON.stringify({ name: entity.name || "" })
}

/**
 * 汇总一次同步中真实发生的用户可见变化。
 *
 * @param {Record<string, any>} input 同步前后数据及批次信息。
 * @returns {Record<string, any>} 可直接展示的同步结果。
 */
function createSyncResultSummary(input) {
  const batch = input.batch || {}
  const beforeWorkspace = input.beforeWorkspace || { folders: [], tags: [], notes: [] }
  const afterWorkspace = input.afterWorkspace || { folders: [], tags: [], notes: [] }
  const completedAt = String(input.completedAt || new Date().toISOString())
  const localNoteIds = new Set((batch.notes || []).map((note) => String(note.clientId || "")))
  const localDeletedKeys = new Set()
  const changes = []
  const changeKeys = new Set()

  const addChange = (change) => {
    const key = `${change.kind}:${change.id}`
    if (!change.id || changeKeys.has(key) || changes.length >= MAX_CHANGE_ITEMS) return
    changeKeys.add(key)
    changes.push({ ...change, occurredAt: completedAt })
  }

  for (const note of batch.notes || []) {
    if (note.isDeleted) {
      localDeletedKeys.add(`note:${note.clientId}`)
      continue
    }
    addChange({ id: String(note.clientId || ""), title: note.title || "无标题笔记", entityType: "note", kind: "upload" })
  }
  for (const history of batch.histories || []) {
    addChange({ id: String(history.noteClientId || history.clientId || ""), title: history.title || "历史版本", entityType: "history", kind: "upload" })
  }
  for (const tombstone of batch.tombstones || []) {
    const entityType = String(tombstone.entityType || "note")
    const id = String(tombstone.clientId || "")
    localDeletedKeys.add(`${entityType}:${id}`)
  }

  const remoteDeletedKeys = new Set()
  let downloadedCount = 0
  for (const entityType of ["note", "folder", "tag"]) {
    const collectionName = `${entityType}s`
    const beforeItems = Array.isArray(beforeWorkspace[collectionName]) ? beforeWorkspace[collectionName] : []
    const afterItems = Array.isArray(afterWorkspace[collectionName]) ? afterWorkspace[collectionName] : []
    const beforeById = new Map(beforeItems.map((item) => [String(item.id), item]))
    const afterById = new Map(afterItems.map((item) => [String(item.id), item]))
    const locallyTouched = entityType === "note" ? localNoteIds : new Set()

    for (const [id, before] of beforeById) {
      if (locallyTouched.has(id) || localDeletedKeys.has(`${entityType}:${id}`)) continue
      const after = afterById.get(id)
      if (!after || (!before.isDeleted && after.isDeleted)) {
        remoteDeletedKeys.add(`${entityType}:${id}`)
        addChange({ id, title: before.title || before.name || "已删除项目", entityType, kind: "delete" })
      }
    }
    for (const [id, after] of afterById) {
      if (locallyTouched.has(id) || localDeletedKeys.has(`${entityType}:${id}`)) continue
      const before = beforeById.get(id)
      if (after.isDeleted && !before?.isDeleted) continue
      if (!before || getVisibleEntityFingerprint(before, entityType) !== getVisibleEntityFingerprint(after, entityType)) {
        downloadedCount += 1
        addChange({ id, title: after.title || after.name || "云端项目", entityType, kind: "download" })
      }
    }
  }

  for (const key of localDeletedKeys) {
    const [entityType, id] = key.split(":")
    const source = (beforeWorkspace[`${entityType}s`] || []).find((item) => String(item.id) === id)
    addChange({ id, title: source?.title || source?.name || "已删除项目", entityType, kind: "delete" })
  }

  const startedTime = Date.parse(input.startedAt || "")
  const completedTime = Date.parse(completedAt)
  return {
    startedAt: String(input.startedAt || completedAt),
    completedAt,
    durationMs: Number.isFinite(startedTime) && Number.isFinite(completedTime) ? Math.max(0, completedTime - startedTime) : 0,
    uploadedCount: (batch.notes || []).filter((note) => !note.isDeleted).length + (batch.histories || []).length,
    downloadedCount,
    deletedCount: new Set([...localDeletedKeys, ...remoteDeletedKeys]).size,
    attachmentCount: Math.max(0, Number(input.uploadedAssetCount || 0)),
    conflictCount: Math.max(0, Number(input.conflictCount || 0)),
    changes
  }
}

module.exports = { createSyncResultSummary, getVisibleEntityFingerprint }
