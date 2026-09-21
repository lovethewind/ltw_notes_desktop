const test = require('node:test')
const assert = require('node:assert/strict')
const { pathToFileURL } = require('node:url')
const { resolve } = require('node:path')

const projectRoot = resolve(__dirname, '..')

/**
 * 预览渲染的真实行为测试。
 *
 * 与其它单测不同，这里不做源码正则匹配，而是**直接调用渲染模块、断言输出 HTML**。
 * 表格单元格的块级渲染规则很细（误伤面大），只有跑真数据才守得住。
 */
let previewModule

test.before(async () => {
  previewModule = await import(pathToFileURL(resolve(projectRoot, 'src/utils/markdown-preview.ts')).href)
})

/** 取表格里某一行的所有单元格内部 HTML（已剥掉 td/th 外壳）。 */
function cellsOf(html) {
  return Array.from(html.matchAll(/<t[hd][^>]*>([\s\S]*?)<\/t[hd]>/g)).map((match) => match[1])
}

/**
 * 取表格正文某一行的单元格。
 *
 * 按行取而不是按全局下标取：表头也算单元格，全局下标很容易数错一格。
 */
function rowCells(html, rowIndex) {
  const body = html.match(/<tbody>([\s\S]*)<\/tbody>/)
  assert.ok(body, '输出里应有表格正文')
  const row = body[1].match(/<tr>([\s\S]*?)<\/tr>/g)?.[rowIndex]
  assert.ok(row, `表格正文没有第 ${rowIndex} 行`)
  return Array.from(row.matchAll(/<t[hd][^>]*>([\s\S]*?)<\/t[hd]>/g)).map((match) => match[1])
}

test('单元格里用 <br> 分行写的块级语法会真正渲染', () => {
  const html = previewModule.renderPreviewMarkdown([
    '| 原型 | 需求描述 |',
    '| --- | --- |',
    '| 图 | ### 大货订单<br>1. 数据<br>* 数据来源：获取领猫SCM<br>* 数据维度：一对一 |',
    ''
  ].join('\n'))

  const cell = rowCells(html, 0)[1]
  assert.match(cell, /<h3>大货订单<\/h3>/, '### 应渲染成真标题')
  assert.match(cell, /<ol>\s*<li>数据<\/li>\s*<\/ol>/, '1. 应渲染成真有序列表')
  assert.match(cell, /<ul>[\s\S]*数据来源：获取领猫SCM[\s\S]*数据维度：一对一[\s\S]*<\/ul>/, '* 应渲染成真无序列表')
  // 表格结构本身不能被破坏。
  assert.equal((html.match(/<table>/g) ?? []).length, 1)
})

test('单元格里的多级列表能嵌套，与钉钉文档一致', () => {
  const html = previewModule.renderPreviewMarkdown([
    '| 层级 | 说明 |',
    '| --- | --- |',
    '| 列表 | * 一级<br>    * 二级<br>        * 三级 |',
    ''
  ].join('\n'))

  const cell = rowCells(html, 0)[1]
  // 三级嵌套 = 三个 ul 互相套住。
  assert.equal((cell.match(/<ul>/g) ?? []).length, 3)
  assert.match(cell, /一级[\s\S]*<ul>[\s\S]*二级[\s\S]*<ul>[\s\S]*三级/)
})

test('单元格里的引用与代码块也能渲染', () => {
  const html = previewModule.renderPreviewMarkdown([
    '| 类型 | 内容 |',
    '| --- | --- |',
    '| 引用 | > 引用行<br>> 引用第二行 |',
    '| 代码 | ```js<br>const a = 1<br>``` |',
    ''
  ].join('\n'))

  assert.match(rowCells(html, 0)[1], /<blockquote>/)
  assert.match(rowCells(html, 1)[1], /<pre><code[^>]*>[\s\S]*const a = 1[\s\S]*<\/code><\/pre>/)
})

test('不含 <br> 的单元格保持行内解析，不会被误判成列表', () => {
  const html = previewModule.renderPreviewMarkdown([
    '| 状态 | 备注 | 数值 |',
    '| --- | --- | --- |',
    '| 1. 未开始 | * 号仓说明 | - 3 |',
    ''
  ].join('\n'))

  const cells = rowCells(html, 0)
  // 这三格以列表符号 / 数字点开头，但作者本意就是纯文本（状态列、备注列很常见）。
  assert.equal(cells[0], '1. 未开始', '数字点开头不该变成有序列表')
  assert.equal(cells[1], '* 号仓说明', '星号开头不该变成无序列表')
  assert.equal(cells[2], '- 3', '连字符开头不该变成无序列表')
  // 整个表格里除了单元格不该冒出任何列表。
  assert.equal((html.match(/<ul>|<ol>/g) ?? []).length, 0)
})

test('单元格里的行内格式与图片照常工作', () => {
  const html = previewModule.renderPreviewMarkdown([
    '| 行内 | 图片 |',
    '| --- | --- |',
    '| **加粗** 与 `码` 与 [链接](https://a.b) | ![图](pic.png) |',
    ''
  ].join('\n'))

  const cells = rowCells(html, 0)
  assert.match(cells[0], /<strong>加粗<\/strong>/)
  assert.match(cells[0], /<code>码<\/code>/)
  assert.match(cells[0], /<a href="https:\/\/a\.b">链接<\/a>/)
  assert.match(cells[1], /<img src="pic\.png" alt="图">/)
})

test('含 <br> 的普通两行文字仍是两行，不额外包段落', () => {
  const html = previewModule.renderPreviewMarkdown([
    '| 字段 | 说明 |',
    '| --- | --- |',
    '| 换行 | 第一行<br>第二行 |',
    ''
  ].join('\n'))

  const cell = rowCells(html, 0)[1]
  assert.equal(cell, '第一行<br>第二行')
  assert.doesNotMatch(cell, /<p>/)
})

test('表格外的段落：单个回车就断行', () => {
  const html = previewModule.renderPreviewMarkdown('第一行\n第二行')

  assert.equal(html.trim(), '<p>第一行<br>第二行</p>')
})

test('表头单元格与数据单元格遵循同一套规则', () => {
  const html = previewModule.renderPreviewMarkdown([
    '| 第一列 | 第二列 |',
    '| --- | --- |',
    '| a | b |',
    ''
  ].join('\n'))

  assert.match(html, /<th[^>]*>第一列<\/th>/)
  assert.match(html, /<td[^>]*>a<\/td>/)
})

test('单元格对齐属性被保留', () => {
  const html = previewModule.renderPreviewMarkdown([
    '| 左 | 中 | 右 |',
    '| :--- | :---: | ---: |',
    '| a | b | c |',
    ''
  ].join('\n'))

  assert.match(html, /<th align="left">左<\/th>/)
  assert.match(html, /<th align="center">中<\/th>/)
  assert.match(html, /<th align="right">右<\/th>/)
})

test('图片地址归一：file:// 去协议、相对路径按文件目录拼绝对、网络地址放行', () => {
  const { resolvePreviewImageSource } = previewModule
  const docPath = '/Users/me/docs/需求.md'

  // file:// 不在 DOMPurify 白名单里，必须去掉协议，否则整条 src 会被剥掉。
  assert.equal(resolvePreviewImageSource('file:///Users/me/a.png', docPath), '/Users/me/a.png')
  assert.equal(resolvePreviewImageSource('file:///Users/me/%E5%9B%BE.png', docPath), '/Users/me/图.png')
  // 相对路径若原样交给 v-html，会以 dist 目录为基准解析。
  assert.equal(resolvePreviewImageSource('images/a.png', docPath), '/Users/me/docs/images/a.png')
  assert.equal(resolvePreviewImageSource('./a.png', docPath), '/Users/me/docs/a.png')
  // 网络地址与 data URI 交给浏览器，DOMPurify 会再筛。
  assert.equal(resolvePreviewImageSource('https://cdn.x.com/a.png', docPath), 'https://cdn.x.com/a.png')
  assert.equal(resolvePreviewImageSource('data:image/png;base64,AAA', docPath), 'data:image/png;base64,AAA')
  assert.equal(resolvePreviewImageSource('', docPath), '')
})

test('预览渲染不污染其它模块用的全局 marked 实例', () => {
  const { marked } = require('marked')

  previewModule.renderPreviewMarkdown('A\nB')

  // 嵌入卡片 / AI 面板 / 更新说明都直接用全局 marked，不能被这里的 breaks / tablecell 覆写影响。
  assert.equal(marked.parse('A\nB', { async: false }), '<p>A\nB</p>\n')
  assert.equal(marked.parse('| a |\n| --- |\n| b |', { async: false }).includes('<table>'), true)
})
