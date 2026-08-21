const assert = require('node:assert/strict')
const test = require('node:test')

const {
  collectBlockedFolderDropIds,
  getDragAutoScrollDelta
} = require('../src/utils/resource-drag.ts')

const folders = [
  { id: 'root', parentId: null },
  { id: 'child', parentId: 'root' },
  { id: 'grandchild', parentId: 'child' },
  { id: 'sibling', parentId: null }
]

test('文件夹不能拖到自身或后代，但允许拖到其他分支', () => {
  const blockedIds = collectBlockedFolderDropIds('root', folders)

  assert.deepEqual([...blockedIds].sort(), ['child', 'grandchild', 'root'])
  assert.equal(blockedIds.has('sibling'), false)
})

test('拖拽靠近滚动区边缘时按距离计算滚动方向和速度', () => {
  assert.equal(getDragAutoScrollDelta(120, 100, 500), -8)
  assert.equal(getDragAutoScrollDelta(480, 100, 500), 8)
  assert.equal(getDragAutoScrollDelta(300, 100, 500), 0)
  assert.equal(getDragAutoScrollDelta(80, 100, 500), -16)
  assert.equal(getDragAutoScrollDelta(520, 100, 500), 16)
})
