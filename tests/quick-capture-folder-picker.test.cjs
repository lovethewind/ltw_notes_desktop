const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const { resolve } = require('node:path')
const test = require('node:test')

const projectRoot = resolve(__dirname, '..')

test('快速记录使用可搜索的自定义文件夹选择器', () => {
  const appSource = readFileSync(resolve(projectRoot, 'src/QuickCaptureApp.vue'), 'utf8')

  assert.doesNotMatch(appSource, /<select\b/)
  assert.match(appSource, /role="listbox"/)
  assert.match(appSource, /placeholder="搜索文件夹"/)
  assert.match(appSource, /folderDepth/)
  assert.match(appSource, /handleFolderPickerKeydown/)
})

test('文件夹选择器打开时 Escape 只关闭选择器', () => {
  const appSource = readFileSync(resolve(projectRoot, 'src/QuickCaptureApp.vue'), 'utf8')

  assert.match(
    appSource,
    /event\.key === 'Escape'[\s\S]*?folderPickerVisible\.value[\s\S]*?folderPickerVisible\.value = false[\s\S]*?return/
  )
})
