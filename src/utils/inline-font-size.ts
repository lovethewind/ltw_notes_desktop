/**
 * 行内字号（选中文字字号 / 后续输入字号）的纯逻辑。
 *
 * ## 为什么字号要写进正文
 *
 * markdown **没有行内字号语法**，想给一段文字单独设字号，只能落成标准 HTML：
 * `<span style="font-size:18px">…</span>`。这条表达同时满足三方：
 *  - 编辑器自身往返（本模块配套 `src/editor/xynote-font-size.ts` 做 mdast 转换）；
 *  - Web 端 `ltw_front_v3`（marked 原样保留行内 HTML，已实测）；
 *  - 纯文本编辑器（安全退化为可见 HTML，而不是丢格式）。
 *
 * ## 为什么单独成模块
 *
 * span 配对、字号解析、空白选区判定都是**纯逻辑**，按项目既有约定
 * （见 `src/utils/markdown-preview.ts` 与 `tests/markdown-preview-render.test.cjs`），
 * 这类逻辑要用**真实行为断言**守住，而不是对 `.vue` 源码做正则匹配。
 *
 * ## 关键设计：严格正则，只认「纯字号」span
 *
 * 识别正则**只接受仅含 font-size 一条声明的 span**：
 *
 *     匹配 ✅  <span style="font-size:18px">   <span style = " font-size: 18px ; ">
 *     放过 ❌  <span style="font-size:18px;color:red">   <span class="x" style="font-size:18px">
 *
 * 原因：本功能序列化时**只会写回 `font-size` 一条声明**。若把带其它样式的 span
 * 也转成字号 mark，用户手写的 `color:red` 会在保存时被静默抹掉 —— 那是数据损失。
 * 所以宽松匹配换来的是「多认几个 span」，代价却是「吃掉别人的样式」，不划算；
 * 认不出的 span 原样保留为 html 节点即可（安全降级）。
 */

/**
 * 可选字号档位（px）。
 *
 * 前段（9/10/11/12/14/16/18/20/22）对齐钉钉文档的字号下拉，
 * 额外补一个 **15** —— 它是本项目正文的既有基准（Crepe 原始默认 16），
 * `src/style.css` 里标题与表格的字号都以它为基准 `calc` 等比换算；
 * 少了 15 会让「默认档」无处安放（用户也就没法把字号改回默认）。
 *
 * 尾段（24/26/28/36/42/48/72）是 2026-10-08 按用户给的参考图追加的大字号粗粒度阶梯
 * （与 Word 一类的字号下拉同构：28 之后不再逐级 +2，避免档位无限膨胀）。
 *
 * ⚠️ 档位数一多，面板（`max-height: 320px`）必然出现滚动 —— 这是**预期行为**，
 * 刻意不做两列/分页：与 Word/钉钉字号下拉一致，且保证「一列 ↕ 滚动」这一条
 * 交互心智不变（气泡面板的「翻到按钮上方」定位也因此仍按 320px 上限算）。
 */
export const FONT_SCALE_STEPS = [
  9, 10, 11, 12, 14, 15, 16, 18, 20, 22, 24, 26, 28, 36, 42, 48, 72
] as const

/** 默认档位下标，指向 15px。 */
export const DEFAULT_FONT_SCALE_INDEX = 5

/**
 * ⚠️ 本模块**刻意不 import 任何本项目的其它模块**（档位表因此内联在这里）。
 *
 * 原因：`tests/*.test.cjs` 用 `pathToFileURL(...).href` 直接加载 `.ts` 源码，
 * 而 Node 的类型剥离**不解析省略扩展名的相对导入**（实测报 `ERR_MODULE_NOT_FOUND`：
 * `Cannot find module '.../src/utils/editor-font-scale'`）。
 * 保持零本地依赖，纯逻辑才能被测试真正加载并断言 —— 否则测试会在 import 阶段就崩。
 */

/** 行内字号在 mdast 侧的自定义类型名（须与 `src/editor/xynote-font-size.ts` 一致）。 */
export const FONT_SIZE_MDAST_TYPE = 'xynoteFontSize'

/** 正文默认字号（px）。不做任何标记时正文就是这个字号。 */
export const DEFAULT_BODY_FONT_SIZE: number = FONT_SCALE_STEPS[DEFAULT_FONT_SCALE_INDEX]

/**
 * 字号 span 的**开**标签正则（严格：仅允许 `style` 且仅含 `font-size` 一条声明）。
 *
 * 捕获组 1 = 字号数值（px）。
 */
export const FONT_SIZE_OPEN_TAG_RE =
  /^<span\s+style\s*=\s*["']\s*font-size\s*:\s*(\d+)px\s*;?\s*["']\s*>$/i

/** 任意 `</span>` 闭标签。 */
export const SPAN_CLOSE_TAG_RE = /^<\/span\s*>$/i

/** mdast inline 节点（只取本模块关心的字段，其余原样透传）。 */
export interface MdastInlineNode {
  type?: string
  value?: unknown
  children?: MdastInlineNode[]
  [key: string]: unknown
}

/**
 * 从 span 开标签文本解析字号。
 *
 * :param html: mdast html 节点的 value（如 `<span style="font-size:18px">`）。
 * :return: 字号（px）；不是纯字号 span 时返回 null。
 */
export function parseFontSizeOpenTag(html: string): number | null {
  const matched = FONT_SIZE_OPEN_TAG_RE.exec(html.trim())
  if (!matched) return null
  const size = Number(matched[1])
  return Number.isFinite(size) && size > 0 ? size : null
}

/**
 * 是否为 `</span>` 闭标签。
 *
 * :param html: mdast html 节点的 value。
 * :return: 是闭标签返回 true。
 */
export function isSpanCloseTag(html: string): boolean {
  return SPAN_CLOSE_TAG_RE.test(html.trim())
}

/**
 * 判断字号是否等于正文默认值。
 *
 * 等于默认值时**应当移除标记**而不是写一个 `<span style="font-size:15px">`：
 * 后者与不写等价，却会污染源码、并在每次往返里被搬运一次。
 *
 * :param size: 字号（px）。
 * :return: 等于默认值返回 true。
 */
export function isDefaultFontSize(size: number): boolean {
  return size === DEFAULT_BODY_FONT_SIZE
}

/**
 * 判断文本是否「无实质内容」（纯空白）。
 *
 * ProseMirror 的 `selection.empty` 只在**光标**时为 true；选中一个空格时它仍是
 * 「有选区」。但给空白加字号 span 毫无意义，还会在源码里留下
 * `<span style="font-size:18px"> </span>` 这种垃圾 —— 所以这类选区按**无选区**处理，
 * 走 `storedMarks`（只影响后续输入）。
 *
 * :param text: 选区文本。
 * :return: 全部为空白字符（或空串）返回 true。
 */
export function isBlankText(text: string): boolean {
  return text.trim() === ''
}

/**
 * 把**扁平的** mdast inline 序列按 span 配对转成嵌套结构。
 *
 * ## 为什么是「扁平」
 *
 * 实测（`mdast-util-from-markdown`）：`<span18>a<span22>b</span>c</span>` 在 mdast 里是
 * **同层兄弟序列**，not 嵌套树：
 *
 *     html(<span18>) · text_a · html(<span22>) · text_b · html(</span>) · text_c · html(</span>)
 *
 * 所以用一个**栈**就能还原成正确的嵌套区间。闭标签一律被吸收（不出现在结果里）。
 *
 * ## 安全约束
 *
 * - 栈空时遇到 `</span>` **原样保留**：否则文档里与其无关的裸 `</span>` 会被吞掉，属数据损坏。
 * - 返回**新数组/新对象**，不改入参（mdast 树可能被其它插件复用）。
 * - 已有 children 的节点（如 `strong`）会**递归**处理，span 开在 mark 内的情况同样成立。
 *
 * :param children: 同一层的 mdast inline 节点数组。
 * :return: 转换后的新数组。
 */
export function nestFontSizeSpans(children: MdastInlineNode[]): MdastInlineNode[] {
  const result: MdastInlineNode[] = []
  /** 当前已开启、尚未闭合的字号容器（栈顶是最近的 span）。 */
  const open: MdastInlineNode[] = []

  const append = (node: MdastInlineNode): void => {
    const target = open.length ? open[open.length - 1].children : result
    target?.push(node)
  }

  for (const child of children) {
    // 带子节点的（strong/emphasis/link…）：递归处理后透传，span 开在 mark 内也能配对。
    if (Array.isArray(child.children)) {
      append({ ...child, children: nestFontSizeSpans(child.children) })
      continue
    }

    if (child.type === 'html') {
      const html = String(child.value ?? '')

      const size = parseFontSizeOpenTag(html)
      if (size !== null) {
        const container: MdastInlineNode = {
          type: FONT_SIZE_MDAST_TYPE,
          size,
          children: []
        }
        append(container)
        open.push(container)
        continue
      }

      if (isSpanCloseTag(html)) {
        // ⚠️ 栈空说明这个 </span> 与我们无关 —— 必须放回，不能吞掉。
        if (open.length) {
          open.pop()
          continue
        }
      }
    }

    append(child)
  }

  // 未闭合的 span：容器已在树上（内容不丢），此处仅需丢弃残留的栈状态。
  return result
}
