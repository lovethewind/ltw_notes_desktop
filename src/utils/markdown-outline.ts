import { Lexer, type Token, type Tokens } from 'marked'

export interface MarkdownOutlineItem {
  index: number
  level: number
  text: string
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
 * :param markdown: Markdown 原文。
 * :return: 按出现顺序排列的大纲项目。
 */
export function extractMarkdownOutline(markdown: string): MarkdownOutlineItem[] {
  return Lexer.lex(markdown)
    .filter((token): token is Tokens.Heading => token.type === 'heading')
    .map((token, index) => ({
      index,
      level: token.depth,
      text: extractInlineText(token.tokens) || token.text
    }))
}
