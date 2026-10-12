import { Lexer, type Token, type Tokens } from 'marked'

export interface MarkdownOutlineItem {
  index: number
  level: number
  text: string
  /**
   * 标题在整个文档里的起始偏移（字符数）。
   *
   * 源码编辑器（CodeMirror）里没有标题 DOM，「跳到大纲项」只能靠位置，所以这里一并给出。
   * 值由顶层 token 的 `raw` 长度累加得到：marked 的 token 是逐段消费原文的，
   * 前面的 raw 加起来正好是当前 token 的起点（`tests/markdown-outline.test.cjs` 钉住了这个前提）。
   * 富文本编辑器不用它 —— 那边两态都有标题 DOM，靠 `getBoundingClientRect` 定位。
   */
  offset: number
}

/**
 * 提取行内标记中的纯文本。
 *
 * :param tokens: Markdown 行内标记。
 * :return: 拼接后的纯文本。
 */
function extractInlineText(tokens: Token[]): string {
  return tokens
    .map((token) => ('text' in token && typeof token.text === 'string' ? token.text : ''))
    .join('')
    .trim()
}

/**
 * 从 Markdown 中提取标题大纲。
 *
 * 遍历顶层 token 并累加 `raw` 长度，得到每个标题在原文里的起始偏移。
 * 代码块里的 `#` 不会成为 heading token，因此天然被排除。
 *
 * :param markdown: Markdown 原文。
 * :return: 按出现顺序排列的大纲项目（含起始偏移）。
 */
export function extractMarkdownOutline(markdown: string): MarkdownOutlineItem[] {
  const items: MarkdownOutlineItem[] = []
  let offset = 0
  for (const token of Lexer.lex(markdown)) {
    if (token.type === 'heading') {
      const heading = token as Tokens.Heading
      items.push({
        index: items.length,
        level: heading.depth,
        text: extractInlineText(heading.tokens) || heading.text,
        offset
      })
    }
    if (typeof token.raw === 'string') offset += token.raw.length
  }
  return items
}
