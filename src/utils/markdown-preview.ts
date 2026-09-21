import { Marked, type Tokens } from 'marked'

/**
 * 外部 Markdown 文件预览的渲染逻辑。
 *
 * 与 `NoteEmbedCard` / `AiAssistantPanel` 那几处的差别只有一个：表格单元格按「富文本文档」
 * 的方式渲染。理由见 `renderPreviewCell`。
 *
 * 这里只负责把 Markdown 变成 HTML；清洗交给调用方（DOMPurify 依赖 DOM，不在本模块里做）。
 */

/** 检测单元格里有没有 `<br>`。刻意不带 `g`：带 `g` 的正则 `test()` 会推进 `lastIndex`。 */
const HAS_HARD_BREAK = /<br\s*\/?>/i

/** 把 `<br>` 还原成真换行，供块级解析。 */
const HARD_BREAK = /<br\s*\/?>/gi

/**
 * 递归解析后若只剩行内内容，说明整格就是一行文字，可以剥掉外层 `<p>`。
 * 出现这些标签就说明确实解析出了块级结构，必须原样保留。
 */
const BLOCK_LEVEL = /<(h[1-6]|ul|ol|blockquote|pre|table|div|hr)\b/i

/**
 * 递归解析单元格内容用的解析器。
 *
 * 刻意与主解析器分开：单元格递归时若复用带 `tablecell` 覆写的实例，遇到嵌套表格会自我调用。
 */
let cellParser: Marked | null = null

function getCellParser(): Marked {
  if (!cellParser) {
    cellParser = new Marked()
    cellParser.use({ breaks: true, gfm: true })
  }
  return cellParser
}

/**
 * 把预览里的图片地址归一到渲染层真正能加载的形式。
 *
 * `v-html` 按渲染层 origin 解析地址：生产环境是 `file:///…/dist/index.html`，相对路径会指到
 * dist 目录；而 `file:///…` 本身不在 DOMPurify 的协议白名单里，会被整条剥掉。两种写法都要
 * 归一到以文件所在目录为基准的绝对路径。
 *
 * :param rawSource: Markdown 原文里的图片地址。
 * :param documentPath: 当前文件在磁盘上的绝对路径。
 * :return: 可交给 img 的地址；无法判定时原样返回。
 */
export function resolvePreviewImageSource(rawSource: string, documentPath: string): string {
  const source = rawSource.trim()
  if (!source) return ''
  // file:///Users/x/a.png → /Users/x/a.png（URL 里的空格写作 %20，要还原）。
  if (/^file:/i.test(source)) {
    try {
      return decodeURIComponent(new URL(source).pathname)
    } catch {
      return source
    }
  }
  // 其余带协议的（http / https / data 等）交给浏览器，DOMPurify 会再筛一遍。
  if (/^[a-z][a-z0-9+.-]*:/i.test(source)) return source
  // 相对路径以文件所在目录为基准；取不到目录就不猜。
  const directory = documentPath.slice(0, documentPath.lastIndexOf('/') + 1)
  return directory ? `${directory}${source.replace(/^\.\//, '')}` : source
}

/**
 * 渲染一个表格单元格。
 *
 * GFM 规范规定单元格只做行内解析（原文：`Block-level elements cannot be inserted in a table`），
 * GitHub、Typora 都遵守。但钉钉、飞书这类文档产品的表格是「能装块级内容的富文本容器」，
 * 用户按那种习惯写文档（`### 标题<br>1. 列表<br>* 子项`），照着规范渲染就成了一坨字面文本。
 * 这里按后者渲染：含 `<br>` 的单元格把 `<br>` 还原成真换行，再按块级解析一遍。
 *
 * 不含 `<br>` 的单元格保持行内解析 —— 否则「`* 号仓说明`」这种以列表符号开头的纯文本
 * （状态列、备注列里很常见）会被误判成列表项。
 *
 * :param rawText: 单元格的 Markdown 原文。
 * :param parser: 用于递归解析的解析器。
 * :return: 单元格内部 HTML（不含 td/th 外壳）。
 */
function renderPreviewCell(rawText: string, parser: Marked): string {
  if (!HAS_HARD_BREAK.test(rawText)) return parser.parseInline(rawText, { async: false }) as string
  const html = (parser.parse(rawText.replace(HARD_BREAK, '\n'), { async: false }) as string).trim()
  const singleParagraph = html.match(/^<p>([\s\S]*)<\/p>$/)
  if (singleParagraph && !BLOCK_LEVEL.test(singleParagraph[1])) {
    return singleParagraph[1].replace(/\n/g, '<br>')
  }
  return html
}

/** 预览解析器。无状态，跨次渲染复用。 */
let previewParser: Marked | null = null

function getPreviewParser(): Marked {
  if (!previewParser) {
    previewParser = new Marked()
    previewParser.use({
      // GitHub 风格：段落里单个回车就断行。正文用它更符合所见即所得直觉。
      breaks: true,
      gfm: true,
      renderer: {
        // 覆写整个方法就要自己补 td/th 外壳与对齐属性。
        tablecell(token: Tokens.TableCell) {
          const tag = token.header ? 'th' : 'td'
          const align = token.align ? ` align="${token.align}"` : ''
          return `<${tag}${align}>${renderPreviewCell(token.text, getCellParser())}</${tag}>`
        }
      }
    })
  }
  return previewParser
}

/**
 * 把 Markdown 原文渲染成预览 HTML。
 *
 * :param source: Markdown 原文。
 * :return: HTML 字符串（未清洗）。
 */
export function renderPreviewMarkdown(source: string): string {
  return getPreviewParser().parse(source, { async: false }) as string
}
