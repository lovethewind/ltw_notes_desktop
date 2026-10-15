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

test('行内公式按 KaTeX 渲染，前后文字不受影响', () => {
  const html = previewModule.renderPreviewMarkdown('这是公式 $E=mc^2$ 结束')

  assert.match(html, /^<p>这是公式 <span class="katex">/, '公式应渲染成 KaTeX 结构')
  assert.match(html, /结束<\/p>\s*$/, '公式后面的文字要照常保留')
  // 原文里的美元号不能残留成字面文本。
  assert.doesNotMatch(html, /\$E=mc\^2\$/)
})

test('块级公式独占一段，走 display 模式', () => {
  const html = previewModule.renderPreviewMarkdown('$$\n\n\\frac{a}{b}\n\n$$')

  assert.match(html, /<div class="markdown-math-block"><span class="katex-display">/)
  // 单行紧凑写法（手写文件里常见）也要认。
  const compact = previewModule.renderPreviewMarkdown('$$a^2+b^2=c^2$$')
  assert.match(compact, /markdown-math-block[\s\S]*katex-display/)
})

test('单元格里的行内公式与块级公式都渲染（递归解析器同样挂了公式扩展）', () => {
  const html = previewModule.renderPreviewMarkdown([
    '| 列 | 说明 |',
    '| --- | --- |',
    '| 比例 | 宽高比 $16:9$ |',
    '| 分式 | 尺寸<br>$$\\frac{16}{9}$$ |',
    ''
  ].join('\n'))

  assert.match(rowCells(html, 0)[1], /<span class="katex">/)
  assert.match(rowCells(html, 1)[1], /markdown-math-block[\s\S]*katex-display/)
})

test('转义的美元号保持字面，不当成公式', () => {
  const html = previewModule.renderPreviewMarkdown('价格 \\$100 元')

  assert.equal(html.trim(), '<p>价格 $100 元</p>')
  assert.doesNotMatch(html, /katex/)
})

test('公式内容首尾的空格按编辑器同一口径各剥一个', () => {
  const html = previewModule.renderPreviewMarkdown('$ a $')

  // 与 micromark 的 mathText padding 规则一致：两侧都是空格时各去一个。
  assert.match(html, /<span class="mord mathnormal">a<\/span>/)
})

test('写错的公式不抛错，降级成 KaTeX 的错误标记', () => {
  const html = previewModule.renderPreviewMarkdown('公式 $\\frac{1}{$ 结束')

  assert.match(html, /class="katex-error"/)
  assert.match(html, /结束<\/p>\s*$/)
})

test('预览渲染不污染其它模块用的全局 marked 实例', () => {
  const { marked } = require('marked')

  previewModule.renderPreviewMarkdown('A\nB')

  // 嵌入卡片 / AI 面板 / 更新说明都直接用全局 marked，不能被这里的 breaks / tablecell 覆写影响。
  assert.equal(marked.parse('A\nB', { async: false }), '<p>A\nB</p>\n')
  assert.equal(marked.parse('| a |\n| --- |\n| b |', { async: false }).includes('<table>'), true)
})

test('嵌入卡片占位在预览里换成一张看得见的卡片', () => {
  const html = previewModule.renderPreviewMarkdown('<div data-xynote-embed="note:abc-123"></div>')

  assert.match(html, /class="markdown-embed-placeholder"/)
  // 卡片外观（左边框 + 背景 + 圆角）自己就说明这是嵌入内容，不再另挂「嵌入的笔记」标签。
  assert.doesNotMatch(html, /嵌入的笔记/)
  // 关键：不能再把占位 div 原样吐出来 —— 那样渲染出来是个看不见的空块。
  assert.doesNotMatch(html, /data-xynote-embed/)
})

test('占位卡带着目标笔记 ID，预览层的事件委托靠它打开', () => {
  const html = previewModule.renderPreviewMarkdown('<div data-xynote-embed="note:abc-123"></div>')

  // 属性丢了就等于卡片点不开 —— 这是功能的一部分，不是装饰。
  assert.match(html, /<div class="markdown-embed-placeholder" data-note-id="abc-123" role="button" tabindex="0" title="打开笔记">/)
})

test('只有跨端标识的嵌入卡（网页端插入）同样渲染成可点卡片', () => {
  // 网页端没有本机 uuid，插入的卡片只写 data-xynote-embed-server。
  // 只认 data-xynote-embed 会让这类卡片在预览里整块消失（渲染成一个零高度的空 div）。
  const html = previewModule.renderPreviewMarkdown(
    '<div data-xynote-embed-server="2081338921611808768" title="插入时的标题"></div>',
    { resolveEmbedMeta: () => ({ title: '实时标题', excerpt: '被嵌入笔记的摘要' }) }
  )

  assert.match(html, /class="markdown-embed-placeholder"/)
  assert.doesNotMatch(html, /data-xynote-embed/)
  // 目标键取跨端标识 —— 预览层的事件委托靠它打开被嵌入的笔记。
  assert.match(html, /data-note-id="2081338921611808768"/)
  assert.match(html, /实时标题/)
  assert.match(html, /被嵌入笔记的摘要/)
})

test('两个标识都在时目标键取本机 ID（桌面端插入的卡片）', () => {
  const html = previewModule.renderPreviewMarkdown(
    '<div data-xynote-embed="note:local-uuid" data-xynote-embed-server="9001" title="T"></div>'
  )

  assert.match(html, /data-note-id="local-uuid"/)
})

test('占位卡带静止态可点暗示：箭头不靠 hover 就看得见', () => {
  const html = previewModule.renderPreviewMarkdown('<div data-xynote-embed="note:abc-123"></div>')

  // 上一轮只做 hover 描边 + cursor，用户静态截图下反馈「没变化」——箭头必须在静止态就在。
  // 形状与编辑态打开按钮同款（material-symbols arrow-forward-rounded），是内联 SVG 而非字符。
  assert.match(html, /class="markdown-embed-placeholder__action" aria-hidden="true"><svg/)
  // 可点语义已由 role="button" + title 承载，箭头纯装饰，不进无障碍树。
  assert.match(html, /aria-hidden="true"/)
})

test('嵌入卡片标题优先用实时解析的结果，占位里的旧标题只作兜底', () => {
  const withStaleTitle = '<div data-xynote-embed="note:abc" title="改名之前的标题"></div>'

  const resolved = previewModule.renderPreviewMarkdown(withStaleTitle, {
    resolveEmbedMeta: () => ({ title: '现在的标题' })
  })
  assert.match(resolved, /现在的标题/)
  assert.doesNotMatch(resolved, /改名之前的标题/)

  // 解析不到（目标已删除 / 不在当前工作区）时，退回占位里写的那个。
  const fallback = previewModule.renderPreviewMarkdown(withStaleTitle, {
    resolveEmbedMeta: () => null
  })
  assert.match(fallback, /改名之前的标题/)
})

test('占位卡展示与编辑态卡片同层级的信息：文件夹 / 标题 / 摘要 / 时间', () => {
  const html = previewModule.renderPreviewMarkdown('<div data-xynote-embed="note:abc"></div>', {
    resolveEmbedMeta: () => ({
      title: 'Django Web 四',
      folderName: '学习笔记',
      excerpt: '这是被嵌入笔记的纯文本摘要',
      date: '2026.10.13'
    })
  })

  // 文件夹 / 时间前各带一个 material-symbols 图标（内联 SVG，与编辑态卡片同款）。
  assert.match(html, /class="markdown-embed-placeholder__folder"><svg[\s\S]*?<\/svg>学习笔记</)
  assert.match(html, /class="markdown-embed-placeholder__title">Django Web 四</)
  assert.match(html, /class="markdown-embed-placeholder__excerpt">这是被嵌入笔记的纯文本摘要</)
  assert.match(html, /class="markdown-embed-placeholder__date"><svg[\s\S]*?<\/svg>2026\.10\.13</)
  // 底行的 `__foot` 只包时间一项；「嵌入的笔记」标签已去掉，连空壳都不该留。
  assert.match(html, /class="markdown-embed-placeholder__foot">/)
  assert.doesNotMatch(html, /markdown-embed-placeholder__meta/)
})

test('占位卡缺什么就不渲染什么：没有文件夹 / 摘要 / 时间时不留空块', () => {
  const html = previewModule.renderPreviewMarkdown('<div data-xynote-embed="note:abc"></div>', {
    resolveEmbedMeta: () => ({ title: '只有标题' })
  })

  assert.match(html, /class="markdown-embed-placeholder__title">只有标题</)
  assert.doesNotMatch(html, /markdown-embed-placeholder__folder/)
  assert.doesNotMatch(html, /markdown-embed-placeholder__excerpt/)
  assert.doesNotMatch(html, /markdown-embed-placeholder__date/)
  // 没有文件夹 / 时间就不该有对应图标 —— 整张卡只剩箭头那一个 svg。
  assert.equal((html.match(/<svg/g) || []).length, 1)
})

test('目标笔记在回收站时，占位卡给提示而不是摘要与时间', () => {
  const html = previewModule.renderPreviewMarkdown('<div data-xynote-embed="note:abc"></div>', {
    resolveEmbedMeta: () => ({
      title: '已删除的笔记',
      excerpt: '不该出现的摘要',
      date: '2026.10.13',
      deleted: true
    })
  })

  assert.match(html, /class="markdown-embed-placeholder__title">已删除的笔记</)
  assert.match(html, /此笔记已被删除或移入回收站/)
  assert.doesNotMatch(html, /不该出现的摘要/)
  assert.doesNotMatch(html, /markdown-embed-placeholder__date/)
  // 时间与「嵌入的笔记」标签都没有了 → 底行整行不该渲染，别留空壳。
  assert.doesNotMatch(html, /markdown-embed-placeholder__foot/)
})

test('嵌入卡片查不到标题时给默认文案，不留空', () => {
  const html = previewModule.renderPreviewMarkdown('<div data-xynote-embed="note:gone"></div>')

  assert.match(html, /未命名笔记/)
})

test('卡片各字段里的 HTML 都会被转义，不能借笔记内容注入标签', () => {
  const html = previewModule.renderPreviewMarkdown('<div data-xynote-embed="note:x"></div>', {
    resolveEmbedMeta: () => ({
      title: '<img src=x onerror=alert(1)>',
      folderName: '<b>文件夹</b>',
      excerpt: '<script>alert(1)</script>'
    })
  })

  assert.doesNotMatch(html, /<img/)
  assert.doesNotMatch(html, /<script/)
  assert.match(html, /&lt;img/)
  assert.match(html, /&lt;script/)
})

test('没有嵌入卡片的文档走快速路径，正文里的普通 HTML 块不被误伤', () => {
  const html = previewModule.renderPreviewMarkdown('<div class="note">原样保留</div>')

  assert.match(html, /<div class="note">原样保留<\/div>/)
  assert.doesNotMatch(html, /markdown-embed-placeholder/)
})
