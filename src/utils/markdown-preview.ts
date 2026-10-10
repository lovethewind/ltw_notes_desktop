import katex from 'katex'
import { Marked, type TokenizerAndRendererExtension, type Tokens } from 'marked'

/**
 * Markdown → 预览 HTML 的渲染逻辑（本地文件预览与笔记预览共用同一套）。
 *
 * 与 `NoteEmbedCard` / `AiAssistantPanel` 那几处的差别有两个：
 *   1. 表格单元格按「富文本文档」的方式渲染（理由见 `renderPreviewCell`）；
 *   2. 认 `$…$` / `$$…$$` 公式（编辑器用 KaTeX 渲染，预览也要跟着渲染）。
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
 * 块级公式：`$$ … $$` 独占一段，内容可跨行。
 *
 * 编辑器（crepe 的 mathBlock）序列化出来的是首尾各带一个换行的写法，但手写文件里
 * `$$公式$$` 也常见，所以两边的换行都做成可选。
 */
const BLOCK_MATH_PATTERN = /^\$\$[ \t]*\n?([\s\S]+?)\n?[ \t]*\$\$(?:[ \t]*\n+|$)/

/**
 * 行内公式：`$…$`。
 *
 * 口径与编辑器（remark-math / micromark-extension-math）对齐：`$` 不与 `$$` 相邻、
 * 内容非空且不跨行（marked 的行内 tokenizer 本来也只在一行内跑）。
 */
const INLINE_MATH_PATTERN = /^\$(?!\$)([^\n$]+?)\$(?!\$)/

/**
 * KaTeX 渲染选项。
 *
 * `output: 'html'` 是刻意的：KaTeX 默认会额外吐一份 MathML（`<math>` / `<mrow>`…），
 * 而 DOMPurify 的默认白名单不含 MathML 标签，会被整段剥掉、留下一堆裸文本。
 * 只取 HTML 表示，既是带样式的那一份，也能原样活过清洗。
 * `throwOnError: false` 让写错的公式渲染成红色原文，而不是把整篇预览打断。
 */
const KATEX_OPTIONS = { throwOnError: false, output: 'html', strict: false } as const

/** 转义 HTML 特殊字符（公式无法渲染时降级回原文用）。 */
function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/**
 * 渲染一条公式。
 *
 * :param latex: LaTeX 原文。
 * :param display: 是否块级（独占一行居中）。
 * :return: 公式 HTML；无法渲染时返回降级的原文 `<code>`。
 */
function renderMath(latex: string, display: boolean): string {
  try {
    return katex.renderToString(latex, { ...KATEX_OPTIONS, displayMode: display })
  } catch {
    return `<code class="markdown-math-fallback">${escapeHtml(display ? `$$${latex}$$` : `$${latex}$`)}</code>`
  }
}

/**
 * 与 micromark 的 mathText resolver 对齐：内容首尾都是空格时，各剥掉一个作 padding。
 *
 * :param text: 美元号之间的原文。
 * :return: 去掉 padding 后的公式原文。
 */
function normalizeInlineMath(text: string): string {
  return text.length > 2 && text.startsWith(' ') && text.endsWith(' ')
    ? text.slice(1, -1)
    : text
}

/**
 * 公式扩展（行内 + 块级）。
 *
 * 每次调用返回一份新对象：主解析器与单元格递归解析器都要挂，共用同一个对象
 * 容易在 marked 内部改状态时互相影响。
 *
 * :return: marked 扩展数组。
 */
function createMathExtensions(): TokenizerAndRendererExtension[] {
  return [
    {
      name: 'blockMath',
      level: 'block',
      start(source: string) {
        return source.indexOf('$$')
      },
      tokenizer(source: string) {
        const match = BLOCK_MATH_PATTERN.exec(source)
        if (!match) return undefined
        return { type: 'blockMath', raw: match[0], text: match[1].trim() }
      },
      renderer(token: Tokens.Generic) {
        return `<div class="markdown-math-block">${renderMath(String(token.text ?? ''), true)}</div>`
      }
    },
    {
      name: 'inlineMath',
      level: 'inline',
      start(source: string) {
        return source.indexOf('$')
      },
      tokenizer(source: string) {
        const match = INLINE_MATH_PATTERN.exec(source)
        if (!match) return undefined
        return { type: 'inlineMath', raw: match[0], text: normalizeInlineMath(match[1]) }
      },
      renderer(token: Tokens.Generic) {
        return renderMath(String(token.text ?? ''), false)
      }
    }
  ]
}

/**
 * 递归解析单元格内容用的解析器。
 *
 * 刻意与主解析器分开：单元格递归时若复用带 `tablecell` 覆写的实例，遇到嵌套表格会自我调用。
 */
let cellParser: Marked | null = null

function getCellParser(): Marked {
  if (!cellParser) {
    cellParser = new Marked()
    cellParser.use({ breaks: true, gfm: true, extensions: createMathExtensions() })
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
 * :param documentPath: 当前文件在磁盘上的绝对路径；笔记正文没有磁盘路径，传空串即可
 *                      （相对路径原样返回，`file:` 与网络地址仍会被归一）。
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

/**
 * 笔记嵌入卡片在 Markdown 正文里的载体（由 `src/editor/xynote-embed.ts` 写入）。
 *
 * 编辑器拿它承载自定义块节点，好处是往返无损；但**预览渲染器不认识这个 div**，
 * 只会原样输出一个没有内容的空块 —— 嵌入的笔记在预览里等于凭空消失。
 * 这里把它换成一张可见的占位卡片，至少让读者知道「这里原本有一张卡片」。
 */
const EMBED_PLACEHOLDER_PATTERN = /<div[^>]*\bdata-xynote-embed=["']note:([^"']+)["'][^>]*>\s*<\/div>/gi

/** 从占位 div 里取插入时写在 `title` 属性上的标题（可能没有）。 */
const EMBED_TITLE_PATTERN = /\btitle=["']([^"']*)["']/i

/** 预览渲染需要的外部信息。 */
export interface PreviewRenderOptions {
  /**
   * 按笔记 ID 解析标题；查不到返回空。
   *
   * 本模块不认识笔记库，标题由调用方（编辑器组件）注入；取不到就退回「未命名嵌入笔记」。
   */
  resolveEmbedTitle?: (noteId: string) => string | null
}

/**
 * 渲染一张嵌入占位卡片。
 *
 * :param noteId: 被嵌入的笔记 ID。
 * :param rawHtml: 原始占位 div（用于取出 `title` 属性）。
 * :param options: 预览渲染选项。
 * :return: 卡片 HTML。
 */
function renderEmbedPlaceholder(
  noteId: string,
  rawHtml: string,
  options?: PreviewRenderOptions
): string {
  const inlineTitle = EMBED_TITLE_PATTERN.exec(rawHtml)?.[1]?.trim() ?? ''
  // 实时查到的标题优先：占位 div 上的 `title` 是插入那一刻的快照，笔记改名后就过期了。
  const resolved = options?.resolveEmbedTitle?.(noteId)?.trim() || inlineTitle || ''
  const title = escapeHtml(resolved || '未命名笔记')
  return [
    '<div class="markdown-embed-placeholder">',
    `<span class="markdown-embed-placeholder__title">${title}</span>`,
    '<span class="markdown-embed-placeholder__meta">嵌入的笔记</span>',
    '</div>'
  ].join('')
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
      extensions: createMathExtensions(),
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
 * :param options: 渲染选项（嵌入卡片标题解析等）。
 * :return: HTML 字符串（未清洗）。
 */
export function renderPreviewMarkdown(source: string, options?: PreviewRenderOptions): string {
  const html = getPreviewParser().parse(source, { async: false }) as string
  // 绝大多数文档没有嵌入卡片，先做一次廉价的包含判断，不白跑一遍正则。
  if (!html.includes('data-xynote-embed')) return html
  return html.replace(EMBED_PLACEHOLDER_PATTERN, (match: string, noteId: string) => (
    renderEmbedPlaceholder(noteId, match, options)
  ))
}
