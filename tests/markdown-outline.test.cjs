const test = require('node:test')
const assert = require('node:assert/strict')
const { pathToFileURL } = require('node:url')
const { resolve } = require('node:path')

const projectRoot = resolve(__dirname, '..')

/**
 * 大纲提取的真实行为测试。
 *
 * 与其它单测不同，这里直接调用模块、断言真数据 —— 重点是 `offset`：
 * 源码编辑器（CodeMirror）里没有标题 DOM，「跳到大纲项」全靠这个位置，算错就会跳到别的段落。
 */
let outlineModule

test.before(async () => {
  outlineModule = await import(pathToFileURL(resolve(projectRoot, 'src/utils/markdown-outline.ts')).href)
})

/** 取某个偏移所在行的行首偏移。 */
function lineStartOf(text, offset) {
  return text.lastIndexOf('\n', offset - 1) + 1
}

test('大纲项带位置，且精确落在标题所在行的行首', () => {
  const markdown = ['前言一段。', '', '# 一级标题', '', '正文。', '', '## 二级标题', ''].join('\n')

  const items = outlineModule.extractMarkdownOutline(markdown)

  assert.deepEqual(items.map((item) => item.text), ['一级标题', '二级标题'])
  assert.deepEqual(items.map((item) => item.level), [1, 2])
  assert.deepEqual(items.map((item) => item.index), [0, 1])
  for (const item of items) {
    assert.equal(item.offset, lineStartOf(markdown, item.offset), `第 ${item.index} 项的 offset 不在行首`)
  }
  // 位置要真的指到对应标题上，而不是全部指向文档开头。
  assert.ok(markdown.slice(items[0].offset).startsWith('# 一级标题'))
  assert.ok(markdown.slice(items[1].offset).startsWith('## 二级标题'))
})

test('代码块、表格、引用、缩进都不影响定位（offset 仍落在标题行首）', () => {
  const samples = {
    代码块在前: '```js\nconst a = 1\n```\n\n#### 代码块之后的标题\n',
    表格在前: '| A | B |\n| --- | --- |\n| 1 | 2 |\n\n### 表格之后的标题\n',
    引用在前: '> 引用一段\n\n##### 引用之后的标题\n',
    标题带缩进: '   ### 缩进过的标题\n\n正文\n'
  }

  for (const [name, markdown] of Object.entries(samples)) {
    const items = outlineModule.extractMarkdownOutline(markdown)
    assert.equal(items.length, 1, `${name}：应当只有一个标题`)
    assert.equal(items[0].offset, lineStartOf(markdown, items[0].offset), `${name}：offset 不在行首`)
    assert.match(markdown.slice(items[0].offset).split('\n')[0], /^\s*#{1,6}\s/, `${name}：定位到的那一行不是标题行`)
  }
})

test('代码块里的井号不进大纲，下划线式标题的偏移指向标题文本行', () => {
  const markdown = ['```', '# 这行在代码块里，不算标题', '```', '', '下划线式标题', '===', ''].join('\n')

  const items = outlineModule.extractMarkdownOutline(markdown)

  assert.deepEqual(items.map((item) => item.text), ['下划线式标题'])
  assert.equal(items[0].level, 1)
  assert.equal(markdown.slice(items[0].offset, items[0].offset + '下划线式标题'.length), '下划线式标题')
})

test('多个标题的偏移严格递增，第一个等于文档起点', () => {
  const markdown = '# 甲\n\n正文\n\n## 乙\n\n### 丙\n'
  const offsets = outlineModule.extractMarkdownOutline(markdown).map((item) => item.offset)

  assert.equal(offsets[0], 0)
  for (let index = 1; index < offsets.length; index += 1) {
    assert.ok(offsets[index] > offsets[index - 1], `第 ${index} 项的偏移没有递增`)
  }
})
