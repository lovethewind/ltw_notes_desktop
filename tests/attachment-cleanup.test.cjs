const assert = require('node:assert/strict')
const test = require('node:test')

const {
  cleanAllOrphanAttachments
} = require('../electron/attachment-cleanup.cjs')

test('一键清理会逐个处理全部孤立附件并保留失败项', async () => {
  const calls = []
  const result = await cleanAllOrphanAttachments([
    { id: 'asset-local', fileName: '本地附件.pdf' },
    { id: 'asset-failed', fileName: '清理失败.zip' },
    { id: 'asset-missing', fileName: '文件已缺失.png' }
  ], async (assetId) => {
    calls.push(assetId)
    if (assetId === 'asset-failed') throw new Error('废纸篓暂时不可用')
    return { assetId, removedLocalFile: assetId === 'asset-local' }
  })

  assert.deepEqual(calls, ['asset-local', 'asset-failed', 'asset-missing'])
  assert.deepEqual(result, {
    candidateCount: 3,
    removedCount: 2,
    removedLocalFileCount: 1,
    failedCount: 1,
    failures: [{
      assetId: 'asset-failed',
      fileName: '清理失败.zip',
      message: '废纸篓暂时不可用'
    }]
  })
})

test('没有孤立附件时一键清理返回空统计且不执行删除', async () => {
  let called = false
  const result = await cleanAllOrphanAttachments([], async () => {
    called = true
    throw new Error('不应执行')
  })

  assert.equal(called, false)
  assert.deepEqual(result, {
    candidateCount: 0,
    removedCount: 0,
    removedLocalFileCount: 0,
    failedCount: 0,
    failures: []
  })
})
