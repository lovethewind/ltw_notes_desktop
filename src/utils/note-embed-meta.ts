/**
 * 嵌入笔记卡片的展示口径 —— 编辑态卡片与预览态占位卡的**唯一真源**。
 *
 * 同一张卡在两种模式下由两套渲染负责（编辑态是 Crepe 节点视图，预览态是 marked 出的死 HTML），
 * 摘要与日期的算法必须共用这一份，否则「同一张卡换个模式看就不一样」。
 */

/** 摘要截断长度（字符）。编辑卡据此判断要不要给「展开全文」。 */
export const NOTE_EMBED_EXCERPT_LENGTH = 160

/**
 * 把 ISO 时间归成 `YYYY.MM.DD`。
 *
 * :param value: ISO 时间串（如 `2026-10-13T09:51:00.000Z`）。
 * :return: 归好的日期；取不到日期部分时返回空串。
 */
export function formatNoteDate(value: string): string {
  if (!value) return ''
  const match = /^\d{4}-\d{2}-\d{2}/.exec(value)
  return match ? match[0].replace(/-/g, '.') : ''
}

/**
 * 轻量去 markdown 记号，仅用于摘要展示。
 *
 * 不解析 `data-xynote-embed` 占位：占位卡自身也要显示摘要，解析会递归。
 *
 * :param raw: 笔记正文原文。
 * :return: 压成单行的纯文本。
 */
export function stripNoteMarkdown(raw: string): string {
  if (!raw) return ''
  return raw
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1') // 图片 → alt 文本
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1') // 链接 → 文本
    .replace(/<[^>]+>/g, ' ') // 残留 HTML 标签 → 空格（含 data-xynote-embed 容器）
    .replace(/[#>*_`~|-]{1,}/g, ' ') // markdown 记号
    .replace(/\s+/g, ' ')
    .trim()
}
