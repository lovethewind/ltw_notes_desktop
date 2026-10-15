const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const { resolve } = require('node:path')
const test = require('node:test')

const projectRoot = resolve(__dirname, '..')

test('桌面菜单使用中文系统操作标签', () => {
  const mainSource = readFileSync(resolve(projectRoot, 'electron/main.cjs'), 'utf8')
  const expectedLabels = [
    '关于 心悦笔记',
    '隐藏心悦笔记',
    '隐藏其他应用',
    '全部显示',
    '退出心悦笔记',
    '撤销',
    '重做',
    '剪切',
    '复制',
    '粘贴',
    '全选',
    '重新加载',
    '实际大小',
    '放大',
    '缩小',
    '进入全屏',
    '最小化',
    '缩放',
    '前置全部窗口'
  ]

  for (const label of expectedLabels) assert.match(mainSource, new RegExp(`label: "${label}"`))
})

test('桌面菜单可以通知主页面打开数据管理窗口', () => {
  const mainSource = readFileSync(resolve(projectRoot, 'electron/main.cjs'), 'utf8')
  const preloadSource = readFileSync(resolve(projectRoot, 'electron/preload.cjs'), 'utf8')
  const appSource = readFileSync(resolve(projectRoot, 'src/App.vue'), 'utf8')

  assert.match(mainSource, /label: "数据管理…"[\s\S]*?data-transfer:open/)
  assert.match(preloadSource, /onOpenDataTransfer[\s\S]*?ipcRenderer\.on\("data-transfer:open"/)
  assert.match(appSource, /onOpenDataTransfer\(openDataTransfer\)/)
})

test('桌面菜单提供搜索入口并通知主页面执行对应搜索', () => {
  const mainSource = readFileSync(resolve(projectRoot, 'electron/main.cjs'), 'utf8')
  const preloadSource = readFileSync(resolve(projectRoot, 'electron/preload.cjs'), 'utf8')
  const appSource = readFileSync(resolve(projectRoot, 'src/App.vue'), 'utf8')

  assert.match(mainSource, /label: "搜索"[\s\S]*?label: "搜索全部笔记…"[\s\S]*?label: "快速打开…"[\s\S]*?label: "在当前笔记中查找"/)
  assert.match(mainSource, /search:open", "workspace"[\s\S]*?search:open", "quick-open"[\s\S]*?search:open", "current-note"/)
  assert.match(preloadSource, /onOpenSearch[\s\S]*?ipcRenderer\.on\("search:open"/)
  assert.match(appSource, /onOpenSearch\(handleSearchMenuCommand\)/)
})
