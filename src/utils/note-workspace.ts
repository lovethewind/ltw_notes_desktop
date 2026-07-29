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
