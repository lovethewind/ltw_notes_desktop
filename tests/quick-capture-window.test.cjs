const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const { resolve } = require('node:path')
const test = require('node:test')

const projectRoot = resolve(__dirname, '..')

test('快速记录窗口在主进程输入事件中响应 Escape', () => {
  const mainSource = readFileSync(resolve(projectRoot, 'electron/main.cjs'), 'utf8')
  const preloadSource = readFileSync(resolve(projectRoot, 'electron/preload.cjs'), 'utf8')
  assert.match(mainSource, /before-input-event/)
  assert.match(mainSource, /input\.key !== "Escape"\) return[\s\S]*?quick-capture:escape/)
  assert.match(preloadSource, /onQuickCaptureEscape[\s\S]*?quick-capture:escape/)
})

test('隐藏快速记录后不会把主窗口带到前台', () => {
  const mainSource = readFileSync(resolve(projectRoot, 'electron/main.cjs'), 'utf8')
  const ipcSource = readFileSync(resolve(projectRoot, 'electron/ipc-handlers.cjs'), 'utf8')

  assert.match(ipcSource, /quick-capture:hide[\s\S]*?domain\.hide/)
  assert.match(mainSource, /hide: \(\) => \{[\s\S]*?quickCaptureWindow\?\.hide\(\)[\s\S]*?process\.platform === "darwin"[\s\S]*?app\.hide\(\)/)
  assert.match(mainSource, /showQuickCaptureWindow[\s\S]*?process\.platform === "darwin"[\s\S]*?app\.show\(\)[\s\S]*?browserWindow\.show\(\)/)
})

test('快速记录状态消息不会覆盖保存按钮', () => {
  const styleSource = readFileSync(resolve(projectRoot, 'src/quick-capture.css'), 'utf8')

  assert.match(styleSource, /\.quick-capture-message[^}]*bottom: 52px/)
})

test('再次呼出快速记录会清除上次保存状态', () => {
  const appSource = readFileSync(resolve(projectRoot, 'src/QuickCaptureApp.vue'), 'utf8')

  assert.match(appSource, /async function focusCapture[^}]*message\.value = ''[^}]*messageIsError\.value = false/)
  assert.doesNotMatch(appSource, /message\.value = '已保存'/)
  assert.match(appSource, /async function saveQuickNote[\s\S]*?await window\.notesDesktop\.hideQuickCapture\(\)/)
})

test('主窗口不再展示快速记录按钮', () => {
  const appSource = readFileSync(resolve(projectRoot, 'src/App.vue'), 'utf8')
  assert.doesNotMatch(appSource, /aria-label="快速记录"/)
})
