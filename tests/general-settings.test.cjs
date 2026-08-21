const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const { resolve } = require('node:path')
const test = require('node:test')

const projectRoot = resolve(__dirname, '..')

test('应用菜单使用 Command 逗号打开通用设置', () => {
  const mainSource = readFileSync(resolve(projectRoot, 'electron/main.cjs'), 'utf8')
  const preloadSource = readFileSync(resolve(projectRoot, 'electron/preload.cjs'), 'utf8')

  assert.match(mainSource, /label: "通用设置…"[\s\S]*?accelerator: "CmdOrCtrl\+,"[\s\S]*?general-settings:open/)
  assert.match(preloadSource, /onOpenGeneralSettings[\s\S]*?general-settings:open/)
})

test('通用设置可以修改快速记录快捷键和树形连接线', () => {
  const appSource = readFileSync(resolve(projectRoot, 'src/App.vue'), 'utf8')
  const settingsSource = readFileSync(resolve(projectRoot, 'src/components/GeneralSettingsDialog.vue'), 'utf8')
  const styleSource = readFileSync(resolve(projectRoot, 'src/style.css'), 'utf8')

  assert.match(settingsSource, /aria-label="通用设置"/)
  assert.match(settingsSource, /saveQuickCaptureSettings/)
  assert.match(settingsSource, /notes-show-tree-lines/)
  assert.match(appSource, /tree-lines-hidden/)
  assert.match(styleSource, /tree-lines-hidden[\s\S]*?folder-children::before/)
})
