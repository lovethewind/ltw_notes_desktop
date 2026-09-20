const test = require('node:test')
const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const { resolve } = require('node:path')

const projectRoot = resolve(__dirname, '..')

test('主页面按需加载编辑器和低频弹窗', () => {
  const appSource = readFileSync(resolve(projectRoot, 'src/App.vue'), 'utf8')
  const historySource = readFileSync(resolve(projectRoot, 'src/components/NoteHistoryDialog.vue'), 'utf8')

  assert.match(appSource, /defineAsyncComponent/)
  assert.match(appSource, /const MarkdownVisualEditor = defineAsyncComponent\(\(\) => import\('\.\/components\/MarkdownVisualEditor\.vue'\)\)/)
  // 源码编辑器同样按需加载：CodeMirror 只在打开外部文件时才需要解析。
  assert.match(appSource, /const MarkdownSourceEditor = defineAsyncComponent\(\(\) => import\('\.\/components\/MarkdownSourceEditor\.vue'\)\)/)
  assert.doesNotMatch(appSource, /import MarkdownSourceEditor from/)
  assert.match(appSource, /const QuickOpenDialog = defineAsyncComponent\(\(\) => import\('\.\/components\/QuickOpenDialog\.vue'\)\)/)
  assert.match(appSource, /const NoteHistoryDialog = defineAsyncComponent\(\(\) => import\('\.\/components\/NoteHistoryDialog\.vue'\)\)/)
  assert.match(appSource, /const GeneralSettingsDialog = defineAsyncComponent\(\(\) => import\('\.\/components\/GeneralSettingsDialog\.vue'\)\)/)
  assert.match(historySource, /const MarkdownVisualEditor = defineAsyncComponent\(\(\) => import\('\.\/MarkdownVisualEditor\.vue'\)\)/)
  assert.doesNotMatch(appSource, /import MarkdownVisualEditor from/)
  assert.doesNotMatch(historySource, /import MarkdownVisualEditor from/)
})
