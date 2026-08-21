const assert = require('node:assert/strict')
const path = require('node:path')
const test = require('node:test')

const { isE2ERuntime, resolveUserDataPath, shouldShowMainWindow } = require('../electron/runtime-paths.cjs')

test('生产运行始终使用心悦笔记正式数据目录', () => {
  assert.equal(
    resolveUserDataPath('/Users/example/Library/Application Support', {
      NODE_ENV: 'production',
      XINYUE_NOTES_E2E_USER_DATA: '/tmp/should-not-use'
    }),
    path.join('/Users/example/Library/Application Support', '心悦笔记')
  )
})

test('端到端测试可以隔离到显式指定的临时数据目录', () => {
  assert.equal(
    resolveUserDataPath('/Users/example/Library/Application Support', {
      NODE_ENV: 'test',
      XINYUE_NOTES_E2E_USER_DATA: '/tmp/xinyue-notes-e2e'
    }),
    path.resolve('/tmp/xinyue-notes-e2e')
  )
})

test('只有测试模式和临时数据目录同时存在时才进入端到端测试运行态', () => {
  assert.equal(isE2ERuntime({
    NODE_ENV: 'test',
    XINYUE_NOTES_E2E_USER_DATA: '/tmp/xinyue-notes-e2e'
  }), true)
  assert.equal(isE2ERuntime({ NODE_ENV: 'test' }), false)
  assert.equal(isE2ERuntime({
    NODE_ENV: 'production',
    XINYUE_NOTES_E2E_USER_DATA: '/tmp/xinyue-notes-e2e'
  }), false)
})

test('端到端测试默认隐藏主窗口且可以显式开启调试窗口', () => {
  const hiddenTestEnv = {
    NODE_ENV: 'test',
    XINYUE_NOTES_E2E_USER_DATA: '/tmp/xinyue-notes-e2e'
  }
  assert.equal(shouldShowMainWindow(hiddenTestEnv), false)
  assert.equal(shouldShowMainWindow({
    ...hiddenTestEnv,
    XINYUE_NOTES_E2E_SHOW_WINDOW: '1'
  }), true)
  assert.equal(shouldShowMainWindow({ NODE_ENV: 'production' }), true)
})
