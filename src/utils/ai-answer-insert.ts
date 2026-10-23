/**
 * 把 AI 回答整理成可以写进笔记的 Markdown（纯函数，不碰 DOM / Vue）。
 *
 * 回答在界面上是渲染好的 HTML（`[S1]` 已被后处理成可点 chip），但**落地必须回到
 * Markdown 源码**：插进编辑器的东西要能被 Crepe 重新解析、要能原样存库、要能同步到
 * 网页端。所以这里只处理模型吐出的原始 `answer` 文本，不复用渲染结果。
 *
 * 两条规则值得单独说明：
 *  - **`[Sn]` 标记保留**。写进笔记后它仍然是「这句有出处」的唯一线索，剥掉就成了
 *    无来源的断言；配合末尾的来源列表，读者还能顺着找回去。
 *  - **来源按原序号排列**。正文里的 `[S1]` 与列表第 1 条是同一条笔记（主进程就是按
 *    数组顺序发号的），所以列表用有序列表且**跳过重复但继续递增**，编号不会错位。
 */

/** 落地时要用到的来源信息（只取渲染所需字段）。 */
export interface AiAnswerNoteSource {
  title: string
  noteId: string
}

/** 本机笔记链接的假域名；与编辑器内「复制笔记链接」写进正文的地址同一个。 */
const LOCAL_NOTE_ORIGIN = 'https://xinyue-note.local'

/** 新笔记标题的最大字数，与历史对话标题同一口径（都是问题的前 30 个字符）。 */
const TITLE_CHARACTER_LIMIT = 30

/**
 * 转义 Markdown 链接文本里的方括号与反斜杠。
 *
 * 笔记标题是用户随手写的，`[草稿] 想法` 这种标题直接塞进 `[标题](url)` 会把链接语法
 * 提前闭合，落地后变成一段乱码。
 *
 * :param text: 原始标题。
 * :return: 可安全放进链接文本的标题。
 */
function escapeLinkText(text: string): string {
  return String(text || '').replace(/[[\]\\]/g, '\\$&').trim() || '未命名笔记'
}

/**
 * 从提问里取一个新笔记标题。
 *
 * :param question: 用户这次的问题。
 * :return: 压平空白后的前 30 个字符；空问题退回「AI 回答」。
 */
export function deriveAiAnswerNoteTitle(question: string): string {
  const flattened = String(question || '').replace(/\s+/g, ' ').trim()
  if (!flattened) return 'AI 回答'
  // Array.from 按码点切分，避免 emoji 被截成半个代理对（与历史会话标题同一写法）。
  return Array.from(flattened).slice(0, TITLE_CHARACTER_LIMIT).join('')
}

/**
 * 拼装「回答正文 + 参考来源」。
 *
 * :param answer: 模型返回的原始 Markdown。
 * :param sources: 本轮检索到的来源，顺序即 `[S1]`、`[S2]`… 的编号顺序。
 * :return: 可直接写进笔记的 Markdown；正文为空时返回空串（调用方据此放弃落地）。
 */
export function buildAiAnswerNoteMarkdown(
  answer: string,
  sources: AiAnswerNoteSource[] = []
): string {
  const body = String(answer || '')
    // 流式收尾偶尔会带上终止标记，它不是正文的一部分。
    .replace(/\s*\[DONE\]\s*$/i, '')
    .trim()
  if (!body) return ''

  const seenNoteIds = new Set<string>()
  const links: string[] = []
  sources.forEach((source, index) => {
    const noteId = String(source?.noteId || '').trim()
    // 同一篇笔记被检索命中多次时只列一次；编号仍按原下标走，保证与 `[Sn]` 对得上。
    if (!noteId || seenNoteIds.has(noteId)) return
    seenNoteIds.add(noteId)
    links.push(`${index + 1}. [${escapeLinkText(source.title)}](${LOCAL_NOTE_ORIGIN}/${encodeURIComponent(noteId)})`)
  })

  // 没有来源就只落地正文：空荡荡一个「参考来源」小标题比没有更糟。
  if (!links.length) return body
  // 用分隔线而不是 `##` 标题：来源不该进大纲，去抢正文的层级。
  return `${body}\n\n---\n\n**参考来源**\n\n${links.join('\n')}`
}
