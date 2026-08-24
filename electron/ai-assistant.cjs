const fs = require('node:fs')
const path = require('node:path')

const DEFAULT_BASE_URL = 'https://api.openai.com/v1'
const MAX_SOURCE_COUNT = 8
const MAX_SOURCE_CHARACTERS = 4000
const MAX_CONTEXT_CHARACTERS = 24000
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

  /** 构造有字符预算的模型上下文及结构化来源。 */
  function buildContext(notes) {
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
      const excerpt = cleaned.slice(0, Math.min(MAX_SOURCE_CHARACTERS, availableContentCharacters))
      sources.push({
        id: sourceId,
        noteId: note.id,
        title,
        excerpt: excerpt.slice(0, 180)
      })
      const section = `${sectionPrefix}${excerpt}`
      sections.push(section)
      remainingCharacters -= separator.length + section.length
    }
    return { sources, text: sections.join('\n\n---\n\n') }
  }

  async function ask(input) {
    const question = String(input?.question || '').trim()
    const scope = String(input?.scope || '')
    if (!question) throw new Error('请输入要查找或分析的问题')
    if (!['current', 'folder', 'all'].includes(scope)) throw new Error('AI 查询范围无效')
    const settings = await getPrivateSettings()
    if (!settings.model || !settings.apiKey) throw new Error('请先配置 AI 接口、模型和 API Key')
    const candidates = await collectCandidates({ ...input, question, scope })
    const context = buildContext(candidates)
    if (!context.sources.length) throw new Error('当前范围没有可供分析的文本笔记')

    const endpoint = `${settings.baseUrl}/chat/completions`
    const response = await request(endpoint, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${settings.apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: settings.model,
        temperature: 0.2,
        messages: [
          {
            role: 'system',
            content: '你是心悦笔记助手。只能依据提供的笔记回答；结论后使用 [S1] 形式标注来源。资料不足时明确说明，不得编造。'
          },
          {
            role: 'user',
            content: `问题：${question}\n\n笔记资料：\n${context.text}`
          }
        ]
      })
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
    const citedSourceIds = new Set(
      [...answer.matchAll(/\[S(\d+)\]/gi)].map((match) => `S${Number(match[1])}`)
    )
    const citedSources = context.sources.filter((source) => citedSourceIds.has(source.id))
    if (!citedSources.length) throw new Error('AI 回答未提供有效来源引用，请重试')
    return {
      answer,
      sources: citedSources
    }
  }

  return { ask, getSettings, saveSettings }
}

module.exports = {
  createAiAssistant,
  extractSearchTerms,
  normalizeBaseUrl,
  sanitizeNoteContent
}
