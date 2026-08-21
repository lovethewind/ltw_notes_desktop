const assert = require('node:assert/strict')
const test = require('node:test')
const { createSyncResultSummary } = require('../electron/sync-result-summary.cjs')

test('同步结果按真实本地变更、云端变化、删除和附件分类', () => {
  const beforeWorkspace = {
    folders: [{ id: 'folder-1', name: '工作', parentId: null, sortOrder: 0, isDeleted: false }],
    tags: [{ id: 'tag-1', name: '待办' }],
    notes: [
      { id: 'local-note', title: '项目流程', content: '旧内容', folderId: null, isPinned: false, isDeleted: false, tags: [] },
      { id: 'remote-note', title: '环境相关', content: '旧环境', folderId: null, isPinned: false, isDeleted: false, tags: [] },
      { id: 'removed-note', title: '旧测试笔记', content: '', folderId: null, isPinned: false, isDeleted: false, tags: [] }
    ]
  }
  const afterWorkspace = {
    folders: beforeWorkspace.folders,
    tags: beforeWorkspace.tags,
    notes: [
      beforeWorkspace.notes[0],
      { ...beforeWorkspace.notes[1], content: '云端新环境' },
      { ...beforeWorkspace.notes[2], isDeleted: true }
    ]
  }
  const result = createSyncResultSummary({
    batch: {
      outboxIds: [1, 2, 3],
      notes: [{ clientId: 'local-note', title: '项目流程', isDeleted: false }],
      histories: [{ clientId: 'history-1', noteClientId: 'local-note', title: '项目流程' }],
      tombstones: [{ entityType: 'note', clientId: 'removed-note' }]
    },
    beforeWorkspace,
    afterWorkspace,
    uploadedAssetCount: 2,
    conflictCount: 0,
    startedAt: '2026-08-12T06:38:00.000Z',
    completedAt: '2026-08-12T06:38:03.200Z'
  })

  assert.equal(result.uploadedCount, 2)
  assert.equal(result.downloadedCount, 1)
  assert.equal(result.deletedCount, 1)
  assert.equal(result.attachmentCount, 2)
  assert.equal(result.conflictCount, 0)
  assert.equal(result.durationMs, 3200)
  assert.deepEqual(result.changes.map(({ title, kind }) => ({ title, kind })), [
    { title: '项目流程', kind: 'upload' },
    { title: '环境相关', kind: 'download' },
    { title: '旧测试笔记', kind: 'delete' }
  ])
})

test('本地上传后的服务端回显不会重复计算为云端下载', () => {
  const beforeNote = { id: 'note-1', title: '流程', content: '本地新内容', folderId: null, isPinned: false, isDeleted: false, tags: [] }
  const result = createSyncResultSummary({
    batch: { outboxIds: [1], notes: [{ clientId: 'note-1', title: '流程', isDeleted: false }], histories: [], tombstones: [] },
    beforeWorkspace: { folders: [], tags: [], notes: [beforeNote] },
    afterWorkspace: { folders: [], tags: [], notes: [{ ...beforeNote, serverId: 'server-1', serverUpdatedAt: '2026-08-12T06:38:00.000Z' }] },
    uploadedAssetCount: 0,
    conflictCount: 1,
    startedAt: '2026-08-12T06:38:00.000Z',
    completedAt: '2026-08-12T06:38:00.500Z'
  })

  assert.equal(result.downloadedCount, 0)
  assert.equal(result.conflictCount, 1)
})
