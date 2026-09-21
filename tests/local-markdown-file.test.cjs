const test = require('node:test')
const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const { resolve } = require('node:path')

const projectRoot = resolve(__dirname, '..')
const readSource = (filePath) => readFileSync(resolve(projectRoot, filePath), 'utf8')

/**
 * 外部 Markdown 文件的「格式保真」约束。
 *
 * 背景：富文本编辑器（Milkdown/Crepe）把正文解析成 AST 再重新序列化，`<br>` 会被整篇抹掉、
 * 行内 `*` 会被转义、空单元格会被写成 `<br />` —— 用户只改一个字，整篇表格就被重排。
 * 因此外部文件必须走源码编辑器，且源码编辑器内部不得再引入任何 Markdown 解析/序列化实现。
 */
test('外部文件标签用源码编辑器，不再走富文本编辑器', () => {
  const appSource = readSource('src/App.vue')

  const fileBranch = appSource.match(/<MarkdownSourceEditor[\s\S]*?\/>/)
  assert.ok(fileBranch, 'App.vue 里应能找到外部文件的编辑器分支')
  assert.match(fileBranch[0], /v-if="activeFileDoc"/)
  // key 取文件路径：每个文件标签一套独立撤销栈，撤销不会串到另一个文件。
  assert.match(fileBranch[0], /:key="activeFileDoc\.filePath"/)
  assert.match(fileBranch[0], /:value="activeFileDoc\.content"/)
  assert.match(fileBranch[0], /@change="updateFileDocContent"/)
  // 源码模式没有笔记库能力，传 note-library-enabled 反而是误导。
  assert.doesNotMatch(fileBranch[0], /note-library-enabled/)

  // 富文本编辑器只剩笔记分支。
  const noteBranch = appSource.match(/<MarkdownVisualEditor[\s\S]{0,220}?v-else-if="activeNote"/)
  assert.ok(noteBranch, '笔记仍应使用富文本编辑器')
})

test('源码编辑器不引入任何 Markdown 解析/序列化实现', () => {
  const source = readSource('src/components/MarkdownSourceEditor.vue')

  assert.match(source, /from '@codemirror\/view'/)
  assert.match(source, /from '@codemirror\/lang-markdown'/)
  assert.doesNotMatch(source, /@milkdown/)
  assert.doesNotMatch(source, /remark-/)

  /*
   * marked / DOMPurify 只允许服务「预览」这一个方向：把窗口里的 Markdown 渲染成只读 HTML。
   * 保存方向（CodeMirror 文档 → emit('change')）必须继续走原文，逐字节写回磁盘。
   * 这条不变量由 tests/markdown-preview-mode.test.cjs 更严格地守着；
   * 这里只兜底：解析器不许出现在任何回传正文的代码行上。
   */
  const emitLines = source
    .split('\n')
    .filter((line) => line.includes("emit('change'"))
    .filter((line) => !line.trim().startsWith('*') && !line.trim().startsWith('//'))
  assert.ok(emitLines.length > 0)
  for (const line of emitLines) {
    assert.doesNotMatch(line, /marked|DOMPurify/, `回传正文的代码行不该经过 Markdown 解析器：${line.trim()}`)
  }
})

test('源码编辑器把编辑器原文原样回传，不做规范化', () => {
  const source = readSource('src/components/MarkdownSourceEditor.vue')

  assert.match(source, /emit\('change', update\.state\.doc\.toString\(\), props\.documentId\)/)
})

test('源码编辑器与富文本编辑器暴露同一套查找接口', () => {
  const source = readSource('src/components/MarkdownSourceEditor.vue')
  const visualSource = readSource('src/components/MarkdownVisualEditor.vue')

  // App.vue 的「在当前笔记中查找」是同一条链路，两个编辑器都要接住它。
  assert.match(source, /defineExpose\(\{ clearFindHighlight, findText, getScrollTop \}\)/)
  assert.match(visualSource, /defineExpose\(\{ clearFindHighlight, findText, getScrollTop \}\)/)
})
