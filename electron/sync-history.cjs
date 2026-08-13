const fs = require('node:fs')
const path = require('node:path')

const MAX_SYNC_HISTORY_ENTRIES = 20
const SYNC_HISTORY_FILE_NAME = 'sync-history.json'
const VALID_ENTITY_TYPES = new Set(['note', 'folder', 'tag', 'history'])
const VALID_CHANGE_KINDS = new Set(['upload', 'download', 'delete'])

function toNonNegativeInteger(value) {
  return Math.max(0, Math.round(Number(value) || 0))
}

function normalizeSyncResultChange(input) {
  if (!input || !VALID_ENTITY_TYPES.has(input.entityType) || !VALID_CHANGE_KINDS.has(input.kind)) return null
  return {
    id: String(input.id || ''),
    title: String(input.title || '未命名项目').slice(0, 100),
    entityType: input.entityType,
    kind: input.kind,
    occurredAt: String(input.occurredAt || '')
  }
}

function normalizeSyncResultSummary(input) {
  if (!input || !Number.isFinite(Date.parse(input.completedAt))) return null
  const completedAt = new Date(input.completedAt).toISOString()
  const startedAt = Number.isFinite(Date.parse(input.startedAt))
    ? new Date(input.startedAt).toISOString()
    : completedAt
  return {
    startedAt,
    completedAt,
    durationMs: toNonNegativeInteger(input.durationMs),
    uploadedCount: toNonNegativeInteger(input.uploadedCount),
    downloadedCount: toNonNegativeInteger(input.downloadedCount),
    deletedCount: toNonNegativeInteger(input.deletedCount),
    attachmentCount: toNonNegativeInteger(input.attachmentCount),
    conflictCount: toNonNegativeInteger(input.conflictCount),
    changes: Array.isArray(input.changes)
      ? input.changes.map(normalizeSyncResultChange).filter(Boolean).slice(0, 6)
      : []
  }
}

function normalizeSyncHistory(input) {
  if (!Array.isArray(input)) return []
  const seen = new Set()
  return input
    .map(normalizeSyncResultSummary)
    .filter((result) => {
      if (!result || seen.has(result.completedAt)) return false
      seen.add(result.completedAt)
      return true
    })
    .sort((left, right) => right.completedAt.localeCompare(left.completedAt))
    .slice(0, MAX_SYNC_HISTORY_ENTRIES)
}

function getSyncHistoryFilePath(profilePath) {
  return path.join(profilePath, SYNC_HISTORY_FILE_NAME)
}

function loadSyncHistory(profilePath) {
  try {
    return normalizeSyncHistory(JSON.parse(fs.readFileSync(getSyncHistoryFilePath(profilePath), 'utf8')))
  } catch {
    return []
  }
}

async function saveSyncHistory(profilePath, input) {
  const history = normalizeSyncHistory(input)
  await fs.promises.mkdir(profilePath, { recursive: true })
  const filePath = getSyncHistoryFilePath(profilePath)
  const temporaryPath = `${filePath}.${process.pid}.${Date.now()}.tmp`
  try {
    await fs.promises.writeFile(temporaryPath, `${JSON.stringify(history, null, 2)}\n`, 'utf8')
    await fs.promises.rename(temporaryPath, filePath)
  } finally {
    await fs.promises.rm(temporaryPath, { force: true })
  }
  return history
}

async function appendSyncHistory(profilePath, result) {
  return saveSyncHistory(profilePath, [result, ...loadSyncHistory(profilePath)])
}

module.exports = {
  MAX_SYNC_HISTORY_ENTRIES,
  appendSyncHistory,
  loadSyncHistory,
  normalizeSyncHistory,
  saveSyncHistory
}
