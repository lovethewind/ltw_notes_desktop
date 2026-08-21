const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const {
  MAX_SYNC_HISTORY_ENTRIES,
  appendSyncHistory,
  loadSyncHistory
} = require('../electron/sync-history.cjs')

function createResult(index) {
  const completedAt = new Date(Date.UTC(2026, 7, 12, 12, 0, index)).toISOString()
  return {
    startedAt: new Date(Date.parse(completedAt) - 500).toISOString(),
    completedAt,
    durationMs: 500,
    uploadedCount: index,
    downloadedCount: 1,
    deletedCount: 0,
    attachmentCount: 0,
    conflictCount: 0,
    changes: []
  }
}

test('同步历史按档案持久化并只保留最近记录', async (context) => {
  const profilePath = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'xinyue-sync-history-'))
  context.after(() => fs.rmSync(profilePath, { recursive: true, force: true }))

  let history = []
  for (let index = 0; index < MAX_SYNC_HISTORY_ENTRIES + 2; index += 1) {
    history = await appendSyncHistory(profilePath, createResult(index))
  }

  assert.equal(history.length, MAX_SYNC_HISTORY_ENTRIES)
  assert.equal(history[0].uploadedCount, MAX_SYNC_HISTORY_ENTRIES + 1)
  assert.equal(history.at(-1).uploadedCount, 2)
  assert.deepEqual(loadSyncHistory(profilePath), history)
})

test('同步历史文件损坏时安全回退为空记录', async (context) => {
  const profilePath = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'xinyue-sync-history-broken-'))
  context.after(() => fs.rmSync(profilePath, { recursive: true, force: true }))
  await fs.promises.writeFile(path.join(profilePath, 'sync-history.json'), '{bad json', 'utf8')

  assert.deepEqual(loadSyncHistory(profilePath), [])
})
