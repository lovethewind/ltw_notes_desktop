const fs = require('node:fs')
const path = require('node:path')

const DEFAULT_BASE_URL = 'https://api.openai.com/v1'
const MAX_SOURCE_COUNT = 8
const MAX_SOURCE_CHARACTERS = 4000
/**
 * 「当前笔记」范围只看一篇，可以给足预算。
 *
 * 单篇 4000 字时，长笔记的「总结全文」实际只看了开头 —— 这是用户能直接感知的失真，
 * 所以这里单独放宽，并在来源上带 `truncated` 让界面说明「只取了前 N 字」。
 */
const MAX_SINGLE_NOTE_CHARACTERS = 16000
/**
 * 选区问 AI 时最多送多少字。
 *
 * 选区通常就是一两段，但用户也可能 Cmd+A 全选：这里给一个比单篇笔记更高、
 * 又不至于把资料预算吃光的档位，超出部分标 `truncated` 让界面说明。
 */
const MAX_SELECTION_CHARACTERS = 8000
/** 选区在来源列表里的标题：一眼能看出这一段不是整篇笔记。 */
const SELECTION_SOURCE_TITLE = '选中片段'
const MAX_CONTEXT_CHARACTERS = 24000
/** 追问最多带几轮上文；再早的对话对当前问题几乎没有信息量，只会挤占资料预算。 */
const MAX_HISTORY_TURNS = 6
/** 历史问答的字符预算，独立于笔记资料预算，避免多轮把上下文挤爆。 */
const MAX_HISTORY_CHARACTERS = 6000
const SYSTEM_PROMPT = '你是心悦笔记助手。只能依据提供的笔记资料和此前的对话回答；'
  + '结论后使用 [S1] 形式标注来源编号。资料不足时明确说明，不得编造。'
  + '如果用户在做追问，请结合上文直接继续回答，不要重复已说过的内容。'
const SEARCH_STOP_WORDS = [
  '帮我', '请', '查找', '找出', '搜索', '分析', '总结', '归纳', '比较', '所有', '全部',
  '关于', '相关', '哪些', '什么', '一下', '笔记', '内容', '问题', '是否', '怎么', '如何', '的',
  '并且', '以及', '和', '与'
]

/** 将 OpenAI 兼容地址规范化为不带结尾斜杠的 HTTP(S) URL。 */
function normalizeBaseUrl(value) {
  const rawValue = String(value || DEFAULT_BASE_URL).trim()
  let parsedUrl
  try {
    parsedUrl = new URL(rawValue)
  } catch {
    throw new Error('AI 接口地址无效')
  }
  if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
    throw new Error('AI 接口只支持 HTTP 或 HTTPS 地址')
  }
  return parsedUrl.toString().replace(/\/$/, '')
}

/** 从自然语言问题中提取适合现有 FTS 接口的少量主题词。 */
function extractSearchTerms(question) {
  let normalized = String(question || '')
  for (const stopWord of SEARCH_STOP_WORDS) {
    normalized = normalized.replaceAll(stopWord, ' ')
  }
  const terms = normalized
    .split(/[\s,，。！？!?；;：:、（）()【】\[\]"'“”‘’]+/)
    .map((term) => term.trim())
    .filter((term) => term.length >= 2 && term.length <= 32)
  return [...new Set(terms)].slice(0, 6)
}

/** 清理不能发送给模型的附件、图片、Base64 和外部地址。 */
function sanitizeNoteContent(content) {
  return String(content || '')
    .replace(/!\[[^\]]*\]\([^)]*\)/gi, '[图片已省略]')
    .replace(/data:[a-z0-9.+/-]+;base64,[a-z0-9+/=\r\n]+/gi, '[内嵌资源已省略]')
    .replace(/\[([^\]]+)\]\(https?:\/\/[^)]+\)/gi, '$1')
    .replace(/https?:\/\/[^\s)>]+/gi, '[链接已省略]')
    .replace(/(?:xinyue-asset|xinyue-notes):\/\/[^\s)>]+/gi, '[本地地址已省略]')
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/**
 * 历史回答里的 `[S1]` 指的是那一轮自己的来源编号，混进新请求会让模型误引当前资料。
 *
 * :param text: 模型上一轮的回答原文。
 * :return: 去掉引用标记后的纯文本。
 */
function stripCitationMarks(text) {
  return String(text || '')
    .replace(/\s*\[S\d+\]\s*/gi, ' ')
    .replace(/[ \t]{2,}/g, ' ')
    .trim()
}

/**
 * 把渲染层传来的历史问答整理成 OpenAI messages 片段。
 *
 * 从最近一轮往前收：先按 `MAX_HISTORY_TURNS` 截断轮数，再按 `MAX_HISTORY_CHARACTERS`
 * 截断字符预算 —— 长回答占满预算时，更早的轮次直接丢弃。
 *
 * :param history: `[{ question, answer }]`，按时间正序。
 * :return: `[{ role, content }]`，可直接展开到 messages 里。
 */
function buildHistoryMessages(history) {
  if (!Array.isArray(history)) return []
  const turns = []
  for (const turn of history) {
    const question = String(turn?.question || '').trim()
    const answer = String(turn?.answer || '').trim()
    if (!question || !answer) continue
    turns.push({ question, answer: stripCitationMarks(answer) })
  }
  const kept = []
  let budget = MAX_HISTORY_CHARACTERS
  for (let index = turns.length - 1; index >= 0; index -= 1) {
    const turn = turns[index]
    const cost = turn.question.length + turn.answer.length
    if (kept.length && budget - cost <= 0) break
    budget -= cost
    kept.unshift(turn)
    if (kept.length >= MAX_HISTORY_TURNS) break
  }
  return kept.flatMap((turn) => [
    { role: 'user', content: turn.question },
    { role: 'assistant', content: turn.answer }
  ])
}

/** 读取本地 AI 设置；损坏配置按未配置处理，避免阻止应用启动。 */
async function readStoredSettings(settingsPath) {
  try {
    return JSON.parse(await fs.promises.readFile(settingsPath, 'utf8'))
  } catch (error) {
    if (error?.code === 'ENOENT' || error instanceof SyntaxError) return {}
    throw error
  }
}

/**
 * 创建 AI 笔记助手。复杂的召回、预算和供应商响应解析隐藏在三个方法后。
 *
 * @param {{
 *   settingsPath: string,
 *   encryptSecret: (value: string) => string,
 *   decryptSecret: (value: string) => string,
 *   repository: Record<string, Function>,
 *   request: (url: string, options: Record<string, any>) => Promise<any>
 * }} dependencies 主进程依赖。
 */
function createAiAssistant({ settingsPath, encryptSecret, decryptSecret, repository, request }) {
  /**
   * 正在进行的流式请求：`requestId → AbortController`。
   *
   * 界面上「停止生成」要真的掐掉连接，不是丢掉增量继续在后台跑完。
   */
  const activeStreams = new Map()

  async function getPrivateSettings() {
    const stored = await readStoredSettings(settingsPath)
    let apiKey = ''
    if (stored.encryptedApiKey) {
      try {
        apiKey = decryptSecret(String(stored.encryptedApiKey))
      } catch {
        apiKey = ''
      }
    }
    return {
      baseUrl: normalizeBaseUrl(stored.baseUrl || DEFAULT_BASE_URL),
      model: String(stored.model || '').trim(),
      apiKey
    }
  }

  async function getSettings() {
    const settings = await getPrivateSettings()
    return {
      baseUrl: settings.baseUrl,
      model: settings.model,
      hasApiKey: Boolean(settings.apiKey)
    }
  }

  async function saveSettings(input) {
    const existing = await getPrivateSettings()
    const baseUrl = normalizeBaseUrl(input?.baseUrl)
    const model = String(input?.model || '').trim()
    const apiKey = String(input?.apiKey || '').trim() || existing.apiKey
    if (!model) throw new Error('请填写模型名称')
    if (!apiKey) throw new Error('请填写 API Key')
    await fs.promises.mkdir(path.dirname(settingsPath), { recursive: true })
    await fs.promises.writeFile(settingsPath, `${JSON.stringify({
      baseUrl,
      model,
      encryptedApiKey: encryptSecret(apiKey)
    }, null, 2)}\n`, 'utf8')
    return { baseUrl, model, hasApiKey: true }
  }

  function appendCandidate(target, seenIds, note) {
    if (!note || note.isDeleted || seenIds.has(note.id) || target.length >= MAX_SOURCE_COUNT) return
    seenIds.add(note.id)
    target.push(note)
  }

  /** 按范围召回候选；FTS 无结果时不发送无关笔记。 */
  async function collectCandidates(input) {
    const candidates = []
    const seenIds = new Set()
    if (input.scope === 'current') {
      appendCandidate(candidates, seenIds, repository.getNoteForEditing(input.noteId))
      return candidates
    }

    const filterByFolder = input.scope === 'folder'
    const folderId = String(input.folderId || '').trim() || null
    const folderIds = filterByFolder && folderId ? [folderId] : []
    const terms = extractSearchTerms(input.question)
    for (const term of terms) {
      const matches = repository.searchNotes(term, {
        folderIds,
        includeMetadata: true,
        limit: filterByFolder && !folderId ? 40 : MAX_SOURCE_COUNT
      })
      for (const match of matches) {
        if (filterByFolder && (match.folderId || null) !== folderId) continue
        appendCandidate(candidates, seenIds, repository.getNoteForEditing(match.id) || match)
      }
      if (candidates.length >= MAX_SOURCE_COUNT) break
    }

    return candidates
  }

  /**
   * 构造有字符预算的模型上下文及结构化来源。
   *
   * @param {any[]} notes 按相关度排好的候选笔记（选区那条排在最前，带 `isSelection`）。
   * @param {number} [perNoteLimit] 单篇最多送多少字；不同范围档位不同。
   */
  function buildContext(notes, perNoteLimit = MAX_SOURCE_CHARACTERS) {
    const sources = []
    const sections = []
    let remainingCharacters = MAX_CONTEXT_CHARACTERS
    for (const note of notes) {
      if (remainingCharacters <= 0) break
      const cleaned = sanitizeNoteContent(note.content)
      if (!cleaned) continue
      const sourceId = `S${sources.length + 1}`
      const title = String(note.title || '无标题笔记')
      const separator = sections.length ? '\n\n---\n\n' : ''
      const sectionPrefix = `[${sourceId}] ${title}\n`
      const availableContentCharacters = remainingCharacters - separator.length - sectionPrefix.length
      if (availableContentCharacters <= 0) break
      // 选区是用户亲手框出来的，优先级高于批量召回：给它单独的档位，
      // 不跟着 folder / all 的 4000 字一起被截。
      const sourceLimit = note.isSelection ? MAX_SELECTION_CHARACTERS : perNoteLimit
      const limit = Math.min(sourceLimit, availableContentCharacters)
      const excerpt = cleaned.slice(0, limit)
      sources.push({
        id: sourceId,
        noteId: note.id,
        title,
        excerpt: excerpt.slice(0, 180),
        // 界面据此提示「这篇太长，只取了前 N 字」，别让人以为模型看全了。
        truncated: cleaned.length > excerpt.length
      })
      const section = `${sectionPrefix}${excerpt}`
      sections.push(section)
      remainingCharacters -= separator.length + section.length
    }
    return { sources, text: sections.join('\n\n---\n\n') }
  }

  /**
   * 校验入参、准备上下文与 messages —— 流式与非流式共用。
   *
   * @param {Record<string, any>} input 渲染层传来的提问参数。
   * @return {Promise<{ settings: any, messages: any[], context: { sources: any[], text: string } }>}
   */
  async function prepareConversation(input) {
    const question = String(input?.question || '').trim()
    const scope = String(input?.scope || '')
    if (!question) throw new Error('请输入要查找或分析的问题')
    if (!['current', 'folder', 'all'].includes(scope)) throw new Error('AI 查询范围无效')
    const settings = await getPrivateSettings()
    if (!settings.model || !settings.apiKey) throw new Error('请先配置 AI 接口、模型和 API Key')
    const history = Array.isArray(input?.history) ? input.history : []
    const historyMessages = buildHistoryMessages(history)
    // 追问常是「那第二条呢」这种没有主题词的说法，检索时并上上一轮问题再走 FTS，
    // 否则范围一大就召不回同一批笔记。
    const lastQuestion = [...history]
      .reverse()
      .map((turn) => String(turn?.question || '').trim())
      .find(Boolean)
    const searchQuestion = lastQuestion ? `${lastQuestion} ${question}` : question
    const candidates = await collectCandidates({ ...input, question: searchQuestion, scope })
    // 选区当 S1：用户框出来的那一段就是最相关的资料，不必指望 FTS 命中。
    // 召回结果照旧保留（可能还有别的笔记要对照），只是排在选区后面。
    const selection = String(input?.selection || '').trim()
    const notes = selection
      ? [{
          id: String(input?.noteId || ''),
          title: SELECTION_SOURCE_TITLE,
          content: selection,
          isSelection: true
        }, ...candidates]
      : candidates
    // 「当前笔记」只有一篇，把预算给足；多篇召回仍按每篇 4000 字控制总量。
    const context = buildContext(
      notes,
      scope === 'current' ? MAX_SINGLE_NOTE_CHARACTERS : MAX_SOURCE_CHARACTERS
    )
    if (!context.sources.length) throw new Error('当前范围没有可供分析的文本笔记')
    return {
      settings,
      context,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        ...historyMessages,
        {
          role: 'user',
          content: `问题：${question}\n\n笔记资料：\n${context.text}`
        }
      ]
    }
  }

  /**
   * 把模型回答整理成「正文 + 有效来源」。
   *
   * 模型偶尔漏标引用：以前整轮丢弃（用户白等一次），现在照常给答案，
   * 来源退回本次检索到的笔记，由界面提示「未标注来源」。
   */
  function finalizeAnswer(answer, context) {
    const citedSourceIds = new Set(
      [...answer.matchAll(/\[S(\d+)\]/gi)].map((match) => `S${Number(match[1])}`)
    )
    const citedSources = context.sources.filter((source) => citedSourceIds.has(source.id))
    if (!citedSources.length) {
      return { answer, sources: context.sources, citationMissing: true }
    }
    return { answer, sources: citedSources }
  }

  function createRequestBody(settings, messages, stream) {
    return JSON.stringify({
      model: settings.model,
      temperature: 0.2,
      ...(stream ? { stream: true } : {}),
      messages
    })
  }

  function createHeaders(settings) {
    return {
      Authorization: `Bearer ${settings.apiKey}`,
      'Content-Type': 'application/json'
    }
  }

  async function ask(input) {
    const { settings, messages, context } = await prepareConversation(input)
    const response = await request(`${settings.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: createHeaders(settings),
      body: createRequestBody(settings, messages, false)
    })
    let body
    try {
      body = await response.json()
    } catch {
      throw new Error(`AI 接口返回了无法识别的数据（HTTP ${response.status || '未知'}）`)
    }
    if (!response.ok) {
      throw new Error(body?.error?.message || body?.message || `AI 接口返回 HTTP ${response.status}`)
    }
    const answer = String(body?.choices?.[0]?.message?.content || '').trim()
    if (!answer) throw new Error('AI 接口没有返回回答内容')
    return finalizeAnswer(answer, context)
  }

  /**
   * 流式问答：边读边把增量交给 `onDelta`，返回值与非流式完全一致。
   *
   * 兼容两类服务：标准 SSE（`text/event-stream`）逐帧取 `choices[0].delta.content`；
   * 不支持流式的服务（直接回整段 JSON）会在读完后退化成一次性 `onDelta`。
   *
   * `input.requestId` 存在时会登记到 `activeStreams`，供 `abortStream` 掐断连接。
   *
   * @param {Record<string, any>} input 渲染层传来的提问参数。
   * @param {(delta: string) => void} [onDelta] 每收到一段增量时回调。
   */
  async function askStream(input, onDelta) {
    const requestId = String(input?.requestId || '')
    const controller = new AbortController()
    if (requestId) activeStreams.set(requestId, controller)
    try {
      return await consumeStream(input, onDelta, controller.signal)
    } finally {
      // 只清自己那一条：期间可能已经被 abortStream 摘掉，或被同 ID 的新请求覆盖。
      if (requestId && activeStreams.get(requestId) === controller) activeStreams.delete(requestId)
    }
  }

  /**
   * 用户点了「停止生成」：中止对应请求。
   *
   * @param {string} requestId 渲染层生成的那次请求标识。
   * @returns {boolean} 真的停掉了一条在跑的请求。
   */
  function abortStream(requestId) {
    const key = String(requestId || '')
    const controller = activeStreams.get(key)
    if (!controller) return false
    activeStreams.delete(key)
    controller.abort()
    return true
  }

  async function consumeStream(input, onDelta, signal) {
    const { settings, messages, context } = await prepareConversation(input)
    const response = await request(`${settings.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: createHeaders(settings),
      body: createRequestBody(settings, messages, true),
      signal
    })
    if (!response.ok) {
      let detail = ''
      try {
        const body = await response.json()
        detail = body?.error?.message || body?.message || ''
      } catch {
        detail = ''
      }
      throw new Error(detail || `AI 接口返回 HTTP ${response.status}`)
    }

    const contentType = String(response.headers?.get?.('content-type') || '')
    const canStream = Boolean(response.body) && contentType.includes('text/event-stream')
    if (!canStream) {
      // 接口不接受 stream，或代理把 SSE 改成了普通 JSON：退回整段回答。
      const body = await response.json()
      const answer = String(body?.choices?.[0]?.message?.content || '').trim()
      if (!answer) throw new Error('AI 接口没有返回回答内容')
      if (onDelta) onDelta(answer)
      return finalizeAnswer(answer, context)
    }

    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    let answer = ''
    let dataLines = []

    // SSE 一帧 = 若干 data: 行 + 一个空行；[DONE] 只是终止标记，不是错误。
    const flushDataLines = () => {
      if (!dataLines.length) return
      const payload = dataLines.join('\n')
      dataLines = []
      if (payload.trim() === '[DONE]') return
      let parsed
      try {
        parsed = JSON.parse(payload)
      } catch {
        return
      }
      const delta = parsed?.choices?.[0]?.delta?.content
      if (typeof delta !== 'string' || !delta) return
      answer += delta
      if (onDelta) onDelta(delta)
    }

    const consumeLine = (line) => {
      if (line === '') {
        flushDataLines()
        return
      }
      if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart())
      // event: / id: / retry: 与注释行与本场景无关，直接忽略。
    }

    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      let newlineIndex
      while ((newlineIndex = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newlineIndex).replace(/\r$/, '')
        buffer = buffer.slice(newlineIndex + 1)
        consumeLine(line)
      }
    }
    if (buffer.trim()) consumeLine(buffer.replace(/\r$/, ''))
    flushDataLines()

    const finalAnswer = answer.trim()
    if (!finalAnswer) throw new Error('AI 接口没有返回回答内容')
    return finalizeAnswer(finalAnswer, context)
  }

  return { ask, askStream, abortStream, getSettings, saveSettings }
}

module.exports = {
  createAiAssistant,
  extractSearchTerms,
  normalizeBaseUrl,
  sanitizeNoteContent
}
