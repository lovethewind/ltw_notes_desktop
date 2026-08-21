const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')

const {
  DEFAULT_QUICK_CAPTURE_SHORTCUT,
  loadQuickCaptureSettings,
  normalizeQuickCaptureSettings,
  saveQuickCaptureSettings
} = require('../electron/quick-capture-settings.cjs')

test('快速记录设置提供稳定默认值并清理异常输入', () => {
  assert.deepEqual(normalizeQuickCaptureSettings({}), {
    shortcut: DEFAULT_QUICK_CAPTURE_SHORTCUT,
    folderId: null
  })
  assert.deepEqual(normalizeQuickCaptureSettings({ shortcut: '  CommandOrControl+K  ', folderId: 42 }), {
    shortcut: 'CommandOrControl+K',
    folderId: null
  })
})

test('快速记录设置持久化快捷键和最近文件夹', async (context) => {
  const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'xinyue-quick-capture-'))
  context.after(() => fs.promises.rm(directory, { recursive: true, force: true }))

  await saveQuickCaptureSettings(directory, { shortcut: 'CommandOrControl+Shift+K', folderId: 'folder-1' })
  assert.deepEqual(loadQuickCaptureSettings(directory), {
    shortcut: 'CommandOrControl+Shift+K',
    folderId: 'folder-1'
  })
})
