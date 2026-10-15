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
 * 卡片上带 `data-note-id`：预览层用事件委托接住点击 / 回车，把被嵌入的那篇笔记打开。
 *
 * ⚠️ 两个标识属性**任一存在**即算一张卡（口径与 `src/editor/xynote-embed.ts` 的 `isEmbedHtml` 一致）：
 * - `data-xynote-embed`：本机 uuid，桌面端插入时写；
 * - `data-xynote-embed-server`：服务端主键，**网页端插入的卡片只有它**。
 * 只认前者会让这类卡片在预览里整块消失（渲染成一个零高度的空 div）。
 */
const EMBED_PLACEHOLDER_PATTERN = /<div[^>]*\bdata-xynote-embed(?:-server)?=["'][^"']*["'][^>]*>\s*<\/div>/gi

/** 从占位 div 里取本机 ID（`note:` 之后的部分）；网页端插入的卡片没有这个属性。 */
const EMBED_ID_PATTERN = /\bdata-xynote-embed=["']note:([^"']*)["']/i

/** 从占位 div 里取跨端标识（服务端主键）。与 `data-xynote-embed` 是各自独立的属性。 */
const EMBED_SERVER_PATTERN = /\bdata-xynote-embed-server=["']([^"']*)["']/i

/** 从占位 div 里取插入时写在 `title` 属性上的标题（可能没有）。 */
const EMBED_TITLE_PATTERN = /\btitle=["']([^"']*)["']/i

/** 嵌入卡要展示的信息。字段都可缺省 —— 缺什么就不渲染什么。 */
export interface PreviewEmbedMeta {
  /** 标题。缺省时退回占位 div 上的 `title`，再退回「未命名笔记」。 */
  title?: string | null
  /** 所在文件夹名。空则不渲染这一行。 */
  folderName?: string | null
  /** 纯文本摘要（调用方已去记号并截断）。空则不渲染。 */
  excerpt?: string | null
  /** 已格式化好的日期（`YYYY.MM.DD`）。空则不渲染。 */
  date?: string | null
  /** 目标笔记已被删除（在回收站）。此时只给标题 + 提示，不给摘要与时间。 */
  deleted?: boolean
}

/** 预览渲染需要的外部信息。 */
export interface PreviewRenderOptions {
  /**
   * 按笔记 ID 解析嵌入卡的展示信息；查不到返回 null。
   *
   * 本模块不认识笔记库：标题 / 文件夹 / 摘要 / 时间一律由调用方（编辑器组件）注入 ——
   * 预览渲染是纯函数，只认这一份**同步**给到的数据（异步取详情会破坏纯函数契约）。
   */
  resolveEmbedMeta?: (noteId: string) => PreviewEmbedMeta | null
}

/**
 * 预览卡上的三个图标（material-symbols，与编辑态 `NoteEmbedCard.vue` 同源同图）。
 *
 * 为什么是内联 SVG 而不是 `<Icon>`：预览正文是 `v-html` 出来的死 HTML，挂不上 Vue 组件，
 * 只剩「拼字符串」这一条路。`fill="currentColor"` 让图形跟随文字颜色，换主题不用另写样式。
 *
 * 🔴 之前这里写着「不引入图标，因为 DOMPurify 不放行 svg」—— **那条判断是错的**，
 * 已用项目同一份 dompurify 实测：默认配置完整保留 `svg` / `path` / `viewBox` / `fill` / `d`，
 * 同时剥掉 `onload` / `<script>` / `on*`。所以既不必放宽清洗白名单，也没引入 XSS 面。
 */
const EMBED_ICON_FOLDER =
  '<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M4 20q-.825 0-1.412-.587T2 18V6q0-.825.588-1.412T4 4h5.175q.4 0 .763.15t.637.425L12 6h8q.825 0 1.413.588T22 8v10q0 .825-.587 1.413T20 20zm0-2h16V8h-8.825l-2-2H4zm0 0V6z"/></svg>'
const EMBED_ICON_CLOCK =
  '<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M13 11.6V8q0-.425-.288-.712T12 7t-.712.288T11 8v3.975q0 .2.075.388t.225.337l3.3 3.3q.275.275.7.275T16 16t.275-.7t-.275-.7zM12 22q-2.075 0-3.9-.788t-3.175-2.137T2.788 15.9T2 12t.788-3.9t2.137-3.175T8.1 2.788T12 2t3.9.788t3.175 2.137T21.213 8.1T22 12t-.788 3.9t-2.137 3.175t-3.175 2.138T12 22"/></svg>'
const EMBED_ICON_ARROW =
  '<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M16.175 13H5q-.425 0-.712-.288T4 12t.288-.712T5 11h11.175l-4.9-4.9q-.3-.3-.288-.7t.313-.7q.3-.275.7-.288t.7.288l6.6 6.6q.15.15.213.325t.062.375t-.062.375t-.213.325l-6.6 6.6q-.275.275-.687.275T11.3 19.3q-.3-.3-.3-.712t.3-.713z"/></svg>'

/**
 * 渲染一张嵌入卡片（信息与编辑态卡片对齐，**可点开**）。
 *
 * 卡片是死 HTML（预览正文走 `v-html`），点击由预览层事件委托接住，
 * 目标笔记从 `data-note-id` 上取 —— 所以这个属性是功能的一部分，不能省。
 * `role` / `tabindex` 让它可聚焦，预览层另接一个 keydown（Enter / 空格）保持键盘可达。
 * 这些属性都在 DOMPurify 默认白名单里（`data-*` 由 `ALLOW_DATA_ATTR` 放行），清洗后不会丢。
 *
 * 信息层级与编辑态卡片（`NoteEmbedCard.vue`）一致：文件夹 → 标题 → 摘要 → 底行（时间）+ 箭头。
 *
 * :param rawHtml: 原始占位 div（用于取出目标键与 `title` 属性）。
 * :param options: 预览渲染选项。
 * :return: 卡片 HTML。
 */
function renderEmbedPlaceholder(
  rawHtml: string,
  options?: PreviewRenderOptions
): string {
  // 目标键：本机 ID 优先，退回跨端标识。与调用方 `resolveEmbedMeta` 的匹配口径
  // （`item.id === 键 || item.serverId === 键`）配合，两种卡片都能查得到。
  const noteId = (EMBED_ID_PATTERN.exec(rawHtml)?.[1] ?? '').trim()
    || (EMBED_SERVER_PATTERN.exec(rawHtml)?.[1] ?? '').trim()
  const inlineTitle = EMBED_TITLE_PATTERN.exec(rawHtml)?.[1]?.trim() ?? ''
  const meta = options?.resolveEmbedMeta?.(noteId) ?? null
  // 实时查到的标题优先：占位 div 上的 `title` 是插入那一刻的快照，笔记改名后就过期了。
  const resolved = meta?.title?.trim() || inlineTitle || ''
  const title = escapeHtml(resolved || '未命名笔记')
  // ⚠️ 属性值要把引号也转掉。当前捕获组是 `[^"']+`、本身不含引号，但属性边界
  // 不该依赖正则的这一点 —— 将来放宽匹配就会破。
  const noteRef = escapeHtml(noteId).replace(/"/g, '&quot;')
  const folderName = meta?.folderName?.trim() ?? ''
  const excerpt = meta?.excerpt?.trim() ?? ''
  const date = meta?.date?.trim() ?? ''
  const rows: string[] = []
  if (folderName) {
    rows.push(
      `<span class="markdown-embed-placeholder__folder">${EMBED_ICON_FOLDER}${escapeHtml(folderName)}</span>`
    )
  }
  rows.push(`<span class="markdown-embed-placeholder__title">${title}</span>`)
  if (meta?.deleted) {
    rows.push('<span class="markdown-embed-placeholder__excerpt">此笔记已被删除或移入回收站</span>')
  } else if (excerpt) {
    rows.push(`<span class="markdown-embed-placeholder__excerpt">${escapeHtml(excerpt)}</span>`)
  }
  // 底行只剩时间。原先无论有没有时间都恒定挂一个「嵌入的笔记」标签，
  // 卡片补齐文件夹 / 标题 / 摘要之后它已纯属冗余 —— 卡片外观本身就说明了这段是什么。
  // ⚠️ 回收站态没有时间：此时整行不渲染，别留一个零高度的空壳。
  if (date && !meta?.deleted) {
    const dateHtml = `<span class="markdown-embed-placeholder__date">${EMBED_ICON_CLOCK}${escapeHtml(date)}</span>`
    rows.push(`<span class="markdown-embed-placeholder__foot">${dateHtml}</span>`)
  }
  return [
    `<div class="markdown-embed-placeholder" data-note-id="${noteRef}" role="button" tabindex="0" title="打开笔记">`,
    `<span class="markdown-embed-placeholder__body">${rows.join('')}</span>`,
    // 箭头 = 「这张卡能点开」的静止态暗示。上一轮只做 hover 描边，用户从静态截图上看
    // 毫无变化（「没变化」反馈的根因）。aria-hidden：可点语义已由 role + title 承载，箭头纯装饰。
    // 图形与编辑态 `__open` 按钮同款（`arrow-forward-rounded`），不再用字符 `→` 凑。
    `<span class="markdown-embed-placeholder__action" aria-hidden="true">${EMBED_ICON_ARROW}</span>`,
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
  return html.replace(EMBED_PLACEHOLDER_PATTERN, (match: string) => (
    renderEmbedPlaceholder(match, options)
  ))
}
