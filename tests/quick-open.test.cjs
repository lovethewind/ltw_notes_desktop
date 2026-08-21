const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const { resolve } = require('node:path')
const test = require('node:test')

const projectRoot = resolve(__dirname, '..')

test('快速打开支持全库搜索和键盘选择', () => {
  const appSource = readFileSync(resolve(projectRoot, 'src/App.vue'), 'utf8')
  const quickOpenSource = readFileSync(resolve(projectRoot, 'src/components/QuickOpenDialog.vue'), 'utf8')

  assert.match(appSource, /notes-quick-open-shortcut/)
  assert.match(appSource, /CommandOrControl\+O/)
  assert.match(quickOpenSource, /aria-label="快速打开笔记"/)
  assert.match(quickOpenSource, /搜索标题、正文、标签或文件夹/)
  assert.match(quickOpenSource, /const results = computed[\s\S]*?note\.content[\s\S]*?note\.tags[\s\S]*?folderPath/)
  assert.match(quickOpenSource, /function handleKeydown[\s\S]*?ArrowDown[\s\S]*?ArrowUp[\s\S]*?Enter/)
  assert.match(quickOpenSource, /scrollActiveResultIntoView[\s\S]*?scrollIntoView\(\{ block: 'nearest' \}\)/)
  assert.match(quickOpenSource, /ref="resultsElement"/)
})

test('通用设置可以修改快速打开快捷键', () => {
  const appSource = readFileSync(resolve(projectRoot, 'src/App.vue'), 'utf8')
  const settingsSource = readFileSync(resolve(projectRoot, 'src/components/GeneralSettingsDialog.vue'), 'utf8')

  assert.match(settingsSource, /快速打开快捷键/)
  assert.match(settingsSource, /recordShortcut\(\$event, 'open'\)/)
  assert.match(settingsSource, /localStorage\.setItem\('notes-quick-open-shortcut'/)
  assert.match(appSource, /matchesShortcut\(event, quickOpenShortcut\.value\)/)
})

test('正文命中后会打开笔记内查找并定位首个结果', () => {
  const appSource = readFileSync(resolve(projectRoot, 'src/App.vue'), 'utf8')
  const quickOpenSource = readFileSync(resolve(projectRoot, 'src/components/QuickOpenDialog.vue'), 'utf8')

  assert.match(quickOpenSource, /interface QuickOpenSelection[\s\S]*?contentMatched: boolean/)
  assert.match(appSource, /async function chooseQuickOpenResult\(selection: QuickOpenSelection\)/)
  assert.match(appSource, /selection\.contentMatched[\s\S]*?noteFindVisible\.value = true[\s\S]*?noteFindKeyword\.value = selection\.keyword[\s\S]*?findInCurrentNote\(1\)/)
})

test('快速打开会保存并复用最近搜索词', () => {
  const quickOpenSource = readFileSync(resolve(projectRoot, 'src/components/QuickOpenDialog.vue'), 'utf8')

  assert.match(quickOpenSource, /notes-quick-open-history/)
  assert.match(quickOpenSource, /rememberKeyword/)
  assert.match(quickOpenSource, /v-for="item in history"/)
  assert.match(quickOpenSource, /saveHistory\(history\.filter/)
  assert.match(quickOpenSource, /saveHistory\(\[\]\)/)
})
