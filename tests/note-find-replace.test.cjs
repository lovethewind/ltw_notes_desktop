/**
 * 笔记内查找替换的接线守卫。
 *
 * 替换逻辑本身跑在 ProseMirror / CodeMirror 实例里，node:test 里没有 DOM 可用，
 * 真正的行为由 tests/e2e/ai-assistant.e2e.test.cjs 的同名用例覆盖。
 * 这里守的是「两侧都接住了同一个接口」这类只在特定标签上暴露的接入事故：
 * 少一处 defineExpose、少一个子选择器，界面上表现为「点了没反应」，很难从代码看出来。
 */
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')

const projectRoot = path.resolve(__dirname, '..')
const readSource = (relativePath) =>
  fs.readFileSync(path.join(projectRoot, relativePath), 'utf8')

test('两个编辑器都实现并暴露 replaceText', () => {
  for (const file of ['src/components/MarkdownVisualEditor.vue', 'src/components/MarkdownSourceEditor.vue']) {
    const source = readSource(file)
    assert.match(source, /function replaceText\(/, `${file} 缺少 replaceText 实现`)
    assert.match(source, /defineExpose\(\{[^}]*\breplaceText\b/, `${file} 没有暴露 replaceText`)
  }
})

test('富文本替换：单次只改一处，全部替换倒序一次事务', () => {
  const source = readSource('src/components/MarkdownVisualEditor.vue')

  // 全部替换从后往前改：靠前匹配的偏移不会被打乱，而且整体只产生一次撤销。
  assert.match(source, /for \(let cursor = matches\.length - 1; cursor >= 0; cursor -= 1\)/)
  assert.match(source, /transaction = transaction\.insertText\(replacement/)

  // 单次替换后必须在新文档上重新收集，否则后面所有位置都是旧的。
  const replaceBlock = source.match(/function replaceText\([\s\S]*?\n}\n/)?.[0]
  assert.ok(replaceBlock, '应找到 replaceText 实现')
  const recollects = replaceBlock.match(/collectDocumentMatches\(view\.state\.doc, normalizedKeyword\)/g) || []
  assert.equal(recollects.length, 2, '单次替换后要重新收集一次匹配')

  // 替换文本按纯文本插入：不能换成 markdownToSlice，否则用户写 `**x**` 会凭空长出粗体节点。
  assert.doesNotMatch(replaceBlock, /markdownToSlice/)
  // 预览态下改在里面看不见，必须先回编辑态。
  assert.match(replaceBlock, /if \(previewMode\.value\) togglePreview\(\)/)
})

test('源码替换：一次 dispatch 带全部 changes，单次读当前高亮下标', () => {
  const source = readSource('src/components/MarkdownSourceEditor.vue')
  const replaceBlock = source.match(/function replaceText\([\s\S]*?\n}\n/)?.[0]

  assert.ok(replaceBlock, '应找到 replaceText 实现')
  assert.match(replaceBlock, /changes: matches\.map\(\(match\) => \(\{ from: match\.from, to: match\.to, insert: replacement \}\)\)/)
  // 单次替换要改「当前高亮那一条」，不是永远改第一条。
  assert.match(replaceBlock, /view\.state\.field\(findField\)\?\.active/)
  // 外部文件保真优先：不做转义、不做 Markdown 解析。
  assert.doesNotMatch(replaceBlock, /markdownToSlice|escapeMarkdown/)
})

test('App.vue 把替换接到当前编辑器并回报结果', () => {
  const source = readSource('src/App.vue')

  assert.match(source, /markdownEditorRef\.value\?\.replaceText\(/)
  assert.match(source, /replaceText:\s*\(\s*\n?\s*keyword: string,/)
  // 替换后要同步分数，否则「全部」替换完界面还停在 3/12。
  assert.match(source, /Object\.assign\(noteFindResult, \{ count: result\.count, index: result\.index \}\)/)
  assert.match(source, /showEditorFeedback\(all \? `已替换 \$\{result\.replaced\} 处` : '已替换 1 处'\)/)
})

test('⌘⌥F 展开替换，⌘Enter 在替换框里等于全部替换', () => {
  const source = readSource('src/App.vue')

  assert.match(source, /openCurrentNoteFind\(event\.altKey\)/)
  assert.match(source, /function openCurrentNoteFind\(showReplace = false\)/)
  assert.match(source, /@keydown\.enter\.prevent="replaceInCurrentNote\(\$event\.metaKey \|\| \$event\.ctrlKey\)"/)
})

test('关闭查找会收起替换行，切笔记会清掉替换词', () => {
  const source = readSource('src/App.vue')
  const closeBlock = source.match(/function closeCurrentNoteFind\(\)[\s\S]*?\n}\n/)?.[0]

  assert.ok(closeBlock, '应找到 closeCurrentNoteFind')
  assert.match(closeBlock, /noteReplaceVisible\.value = false/)
  // 替换词不清的话，换一篇笔记按 ⌘⌥F 会带着上一篇的替换目标，误点「全部」就是灾难。
  const clears = source.match(/noteReplaceKeyword\.value = ''/g) || []
  assert.ok(clears.length >= 2, '切笔记与切文件都要清空替换词')
})

test('查找条样式跟着结构一起改：行容器不能再用外层直接子选择器', () => {
  const style = readSource('src/style.css')

  // 输入框已下沉到 .note-find-row 里，`.note-find-bar > input` 会静默失效（不报错只是不生效）。
  assert.match(style, /\.note-find-row > input/)
  assert.match(style, /\.note-find-row > button/)
  assert.doesNotMatch(style, /^\.note-find-bar > input/m)
  // 暗色主题是独立的一段，漏改会得到「浅色主题正常、深色下输入框发黑」。
  const darkSection = style.slice(style.indexOf('html[data-theme="dark"]'))
  assert.match(darkSection, /\.note-find-row > input/)
})
