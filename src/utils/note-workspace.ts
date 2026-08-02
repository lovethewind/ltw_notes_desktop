export type NoteNavigationKind = 'all' | 'pinned' | 'trash'

export interface NoteNavigationCounts {
  all: number
  pinned: number
  trash: number
}

export const NOTE_AUTOSAVE_DELAY_MS = 1500

/**
 * 将笔记更新时间格式化为两端统一的简洁文本。
 *
 * :param value: ISO 时间或可被 Date 解析的时间文本。
 * :param now: 当前时间戳，测试时可传入固定值。
 * :return: 相对时间或月日文本。
 */
export function formatNoteUpdatedTime(value: string, now: number = Date.now()): string {
  const timestamp = Date.parse(value)
  if (!Number.isFinite(timestamp)) return ''
  const diff = Math.max(0, now - timestamp)
  if (diff < 60_000) return '刚刚'
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`
  return new Intl.DateTimeFormat('zh-CN', { month: 'short', day: 'numeric' }).format(new Date(timestamp))
}

/**
 * 将 Markdown 或 HTML 正文转换为一行列表摘要。
 *
 * :param content: 笔记正文。
 * :return: 去除标记并合并空白后的单行摘要。
 */
export function formatNoteExcerpt(content: string): string {
  return content
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/[#>*_`~[\]()!-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * 从有限正文前缀生成侧边栏短摘要。
 *
 * :param content: 笔记正文。
 * :param maxLength: 摘要最大字符数。
 * :return: 最长为指定字符数的单行摘要。
 */
export function formatNotePreview(content: string, maxLength: number = 120): string {
  const scanLength = Math.max(512, maxLength * 4)
  return formatNoteExcerpt(content.slice(0, scanLength)).slice(0, maxLength)
}

/**
 * 判断笔记标题或正文是否匹配搜索词。
 *
 * :param note: 待搜索笔记。
 * :param keyword: 已规范为小写的搜索词。
 * :return: 标题或正文包含搜索词时返回 true。
 */
export function matchesNoteSearch(
  note: { title: string, content: string },
  keyword: string
): boolean {
  if (!keyword) return true
  return note.title.toLocaleLowerCase().includes(keyword)
    || formatNoteExcerpt(note.content).toLocaleLowerCase().includes(keyword)
}

/**
 * 生成包含正文命中位置的搜索结果摘要。
 *
 * :param note: 待展示笔记。
 * :param keyword: 原始搜索词。
 * :return: 正文命中上下文；未命中时返回普通摘要。
 */
export function formatNoteSearchExcerpt(
  note: { content: string },
  keyword: string
): string {
  const normalizedKeyword = keyword.trim().toLocaleLowerCase()
  if (!normalizedKeyword) return formatNotePreview(note.content)
  const excerpt = formatNoteExcerpt(note.content)
  const matchIndex = excerpt.toLocaleLowerCase().indexOf(normalizedKeyword)
  if (matchIndex < 0) return excerpt
  const start = Math.max(0, matchIndex - 28)
  const end = Math.min(excerpt.length, matchIndex + normalizedKeyword.length + 52)
  return `${start > 0 ? '…' : ''}${excerpt.slice(start, end)}${end < excerpt.length ? '…' : ''}`
}
