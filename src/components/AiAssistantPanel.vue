<script setup lang="ts">
import { Icon } from '@iconify/vue'
import DOMPurify from 'dompurify'
import { marked } from 'marked'
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type {
  AiAssistantScope,
  AiAssistantSettings,
  AiAssistantSource,
  AiAssistantTurn,
  AiConversationSummary
} from '../types'

/** 面板里的一轮对话；比 IPC 返回多存渲染好的 HTML、来源与流式状态。 */
interface ChatTurn {
  id: number
  /** 流式增量按它匹配，避免把旧请求的片段塞进新气泡。 */
  requestId: string
  question: string
  answer: string
  html: string
  sources: AiAssistantSource[]
  citationMissing: boolean
  status: 'pending' | 'streaming' | 'done' | 'error'
  error: string
  /** 用户中途点了「停止生成」：保留半截内容，但不落库。 */
  stopped: boolean
  /** 这一轮在库里的 ID；空表示还没落库（停止的半截、落库失败）。 */
  dbTurnId: string
}

const props = defineProps<{
  visible: boolean
  currentNoteId: string | null
  currentFolderId: string | null
  currentNoteTitle: string
  /** 正文里选中的片段（从选中气泡「问 AI」带进来）；空串表示没有选区。 */
  selectionText: string
}>()

const emit = defineEmits<{
  close: []
  openSource: [noteId: string]
  clearSelection: []
}>()

/** 追问时最多回传几轮 —— 与主进程 `MAX_HISTORY_TURNS` 对齐。 */
const HISTORY_TURNS = 6
/** 等待回答时的阶段文案，避免整段时间只有转圈。 */
const LOADING_STAGES = ['正在检索相关笔记…', '正在阅读命中片段…', '正在整理回答…']
const SUGGESTIONS = [
  '用三句话总结这篇笔记',
  '列出还没解决的问题',
  '把关键结论整理成清单'
]

const scope = ref<AiAssistantScope>('current')
const question = ref('')
const loading = ref(false)
const settingsLoading = ref(false)
const settingsOpen = ref(false)
const error = ref('')
const turns = ref<ChatTurn[]>([])
/**
 * 当前对话在库里对应的会话 ID。
 *
 * 空表示「还没落库」：点「＋」不会立刻建会话，等第一轮答完才写库，
 * 免得历史列表里堆一堆没问过话的空会话。
 */
const conversationId = ref<string | null>(null)
const historyOpen = ref(false)
const historyLoading = ref(false)
const historyError = ref('')
const historyItems = ref<AiConversationSummary[]>([])
/** 历史搜索词；走后端匹配（标题 + 任意一轮提问），不是本地过滤。 */
const historySearch = ref('')
/** 正在行内改名的会话 ID；空表示没有在进行改名。 */
const renamingId = ref<string | null>(null)
const renameDraft = ref('')
let renameInputEl: HTMLInputElement | null = null
/** 「清空全部历史」的两段确认：第一次点击只是把按钮换成确认态。 */
const confirmClearHistory = ref(false)
const copiedTurnId = ref<number | null>(null)
const loadingStage = ref(LOADING_STAGES[0])
const settings = ref<AiAssistantSettings>({ baseUrl: 'https://api.openai.com/v1', model: '', hasApiKey: false })
const settingsDraft = ref({ baseUrl: 'https://api.openai.com/v1', model: '', apiKey: '' })
const transcriptEl = ref<HTMLElement | null>(null)
const inputEl = ref<HTMLTextAreaElement | null>(null)
let turnSeed = 0
let stageTimer: ReturnType<typeof setInterval> | undefined
let copyTimer: ReturnType<typeof setTimeout> | undefined
let renderTimer: ReturnType<typeof setTimeout> | undefined
let searchTimer: ReturnType<typeof setTimeout> | undefined
let unsubscribeDelta: (() => void) | null = null
/**
 * 用户主动「停止」过的 requestId。
 *
 * 主进程 abort 后那个 promise 也会 reject，靠这个集合把「用户停的」和「真的出错」分开：
 * 前者保留半截回答、不弹错、不落库，后者才走错误态。
 */
const stoppedRequests = new Set<string>()

const scopeOptions: Array<{ value: AiAssistantScope, label: string, icon: string }> = [
  { value: 'current', label: '当前笔记', icon: 'tabler:file-text' },
  { value: 'folder', label: '当前文件夹', icon: 'tabler:folder' },
  { value: 'all', label: '全部笔记', icon: 'tabler:notes' }
]

const canAsk = computed(() => (
  Boolean(question.value.trim())
  && Boolean(settings.value.model)
  && settings.value.hasApiKey
  && !loading.value
  && (scope.value !== 'current' || Boolean(props.currentNoteId))
))

const scopeHint = computed(() => {
  if (scope.value === 'current') return props.currentNoteTitle || '尚未打开笔记'
  if (scope.value === 'folder') return '只在这个文件夹里找'
  return '在整个笔记库里找'
})

/** 「选中片段」chip 的预览：只露开头，完整内容随提问一起送给模型。 */
const selectionPreview = computed(() => {
  const text = props.selectionText.replace(/\s+/g, ' ').trim()
  return text.length > 48 ? `${text.slice(0, 48)}…` : text
})

/**
 * 模型输出属于不可信内容，Markdown 转换后必须净化再进入 DOM。
 *
 * `[S1]` 的锚点不在这里替换：先渲染再改文本节点，代码块里的字面量才不会被误伤，
 * 也不会因为 marked 把整行当 HTML block 而漏掉标记（见 `decorateCitations`）。
 */
function renderAnswer(answer: string): string {
  return DOMPurify.sanitize(marked.parse(answer, { async: false }))
}

/**
 * 把正文里的 `[S1]` 换成可点的来源 chip。
 *
 * 走 TreeWalker 而不是正则替换 HTML：`<pre>` / `<code>` 里的 `[S1]` 是示意的字面量，
 * 改掉会让人以为代码被篡改；同时能避开已经被包进 `<a>` 的文本。
 */
function decorateCitations(root: HTMLElement | null, sources: AiAssistantSource[]): void {
  if (!root || !sources.length) return
  const known = new Set(sources.map((source) => source.id))
  const targets: Text[] = []
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  while (walker.nextNode()) {
    const node = walker.currentNode as Text
    if (node.parentElement?.closest('pre, code, a')) continue
    if (/\[S\d+\]/i.test(node.nodeValue || '')) targets.push(node)
  }
  targets.forEach((node) => {
    const text = node.nodeValue || ''
    const fragment = document.createDocumentFragment()
    let cursor = 0
    for (const match of text.matchAll(/\[S(\d+)\]/gi)) {
      const sourceId = `S${Number(match[1])}`
      if (!known.has(sourceId)) continue
      const index = match.index ?? 0
      if (index > cursor) fragment.append(text.slice(cursor, index))
      const chip = document.createElement('a')
      chip.setAttribute('href', `#ai-source-${sourceId}`)
      chip.className = 'ai-cite'
      chip.dataset.sourceId = sourceId
      chip.textContent = sourceId
      fragment.append(chip)
      cursor = index + match[0].length
    }
    // 一条都没命中就保留原文本节点，别把节点白白拆碎。
    if (!cursor) return
    if (cursor < text.length) fragment.append(text.slice(cursor))
    node.parentNode?.replaceChild(fragment, node)
  })
}

/** 等 DOM 落位后再给这一轮回答挂上引用 chip。 */
async function decorateTurn(turnId: number, sources: AiAssistantSource[]): Promise<void> {
  await nextTick()
  const root = transcriptEl.value?.querySelector<HTMLElement>(`.ai-answer-text[data-turn-id="${turnId}"]`)
  decorateCitations(root || null, sources)
}

/** 新气泡进 DOM 后再滚到底，否则拿到的还是旧高度。 */
function scrollToBottom(): void {
  void nextTick(() => {
    const element = transcriptEl.value
    if (element) element.scrollTop = element.scrollHeight
  })
}

/** 输入框随内容长高，超过 160px 交给它自己滚。 */
function autoGrow(): void {
  const element = inputEl.value
  if (!element) return
  element.style.height = 'auto'
  element.style.height = `${Math.min(160, element.scrollHeight)}px`
}

/** 打开面板时读取不含密钥明文的本机设置。 */
async function loadSettings(): Promise<void> {
  settingsLoading.value = true
  error.value = ''
  try {
    const saved = await window.notesDesktop.getAiAssistantSettings()
    settings.value = saved
    settingsDraft.value = { baseUrl: saved.baseUrl, model: saved.model, apiKey: '' }
    // 没配置过就直接把设置推到面前，省掉「先找设置在哪」这一步。
    settingsOpen.value = !saved.model || !saved.hasApiKey
  } catch (loadError) {
    error.value = loadError instanceof Error ? loadError.message : 'AI 设置读取失败'
    settingsOpen.value = true
  } finally {
    settingsLoading.value = false
  }
}

async function saveSettings(): Promise<void> {
  settingsLoading.value = true
  error.value = ''
  try {
    // Vue ref 中的对象是响应式 Proxy，Electron IPC 无法结构化克隆，必须先提取为普通对象。
    settings.value = await window.notesDesktop.saveAiAssistantSettings({
      baseUrl: settingsDraft.value.baseUrl,
      model: settingsDraft.value.model,
      apiKey: settingsDraft.value.apiKey
    })
    settingsDraft.value.apiKey = ''
    settingsOpen.value = false
    await nextTick()
    inputEl.value?.focus()
  } catch (saveError) {
    error.value = saveError instanceof Error ? saveError.message : 'AI 设置保存失败'
  } finally {
    settingsLoading.value = false
  }
}

function startLoadingStages(): void {
  let index = 0
  loadingStage.value = LOADING_STAGES[0]
  stageTimer = setInterval(() => {
    index = Math.min(index + 1, LOADING_STAGES.length - 1)
    loadingStage.value = LOADING_STAGES[index]
  }, 1600)
}

function stopLoadingStages(): void {
  if (stageTimer) clearInterval(stageTimer)
  stageTimer = undefined
}

/**
 * 流式增量：先追加文本，渲染按 60ms 节流。
 *
 * 每个 chunk 都跑一遍 Markdown 解析 + 清洗太重，节流后仍然「像在打字」。
 */
function handleDelta(payload: { requestId?: string, delta?: string }): void {
  const requestId = String(payload?.requestId || '')
  const delta = String(payload?.delta || '')
  if (!requestId || !delta) return
  const turn = turns.value.find((item) => item.requestId === requestId)
  if (!turn) return
  if (turn.status === 'pending') {
    turn.status = 'streaming'
    // 第一个字节到了，阶段文案就该让位给真实内容。
    stopLoadingStages()
  }
  turn.answer += delta
  if (renderTimer) return
  renderTimer = setTimeout(() => {
    renderTimer = undefined
    const target = turns.value.find((item) => item.id === turn.id)
    if (!target || target.status === 'done' || target.status === 'error') return
    target.html = renderAnswer(target.answer)
    scrollToBottom()
  }, 60)
}

/** 只把当前选择范围与最近几轮交给主进程，正文召回和字符预算由主进程统一控制。 */
async function ask(): Promise<void> {
  if (!canAsk.value) return
  const questionText = question.value.trim()
  error.value = ''
  question.value = ''
  await nextTick()
  autoGrow()

  // 先把用户自己的问题钉进会话：请求还没回来，也该看得到发出去的是什么。
  turnSeed += 1
  const turn: ChatTurn = {
    id: turnSeed,
    requestId: createRequestId(),
    question: questionText,
    answer: '',
    html: '',
    sources: [],
    citationMissing: false,
    status: 'pending',
    error: '',
    stopped: false,
    dbTurnId: ''
  }
  // 只有已经答完的轮次才进历史，半截的流式回答没有参考价值。
  const history = buildHistory()
  turns.value.push(turn)
  await runTurn(turn, history)
}

/** 每轮的请求标识：既用来匹配流式增量，也用来中止。 */
function createRequestId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

/** 已答完的轮次按时间正序回传；主进程还会再截一次 6 轮 / 6000 字。 */
function buildHistory(excludeTurnId?: number): AiAssistantTurn[] {
  return turns.value
    // 被用户停掉的半截不算「答完」：拿它当上下文只会把模型带偏。
    .filter((item) => item.status === 'done' && !item.stopped && item.id !== excludeTurnId)
    .slice(-HISTORY_TURNS)
    .map((item) => ({ question: item.question, answer: item.answer }))
}

/**
 * 真跑一轮请求：提问与重新生成共用。
 *
 * 分工：这里只管「发出去、把增量画出来、收尾落库」，
 * 气泡是先建好还是原地复用，由调用方决定。
 */
async function runTurn(turn: ChatTurn, history: AiAssistantTurn[]): Promise<void> {
  loading.value = true
  error.value = ''
  startLoadingStages()
  scrollToBottom()

  try {
    const result = await window.notesDesktop.askAiAssistantStream({
      question: turn.question,
      scope: scope.value,
      noteId: props.currentNoteId,
      folderId: props.currentFolderId,
      // 选区作为最高优先级资料（主进程编成 S1），和召回结果一起送过去。
      selection: props.selectionText || undefined,
      history,
      requestId: turn.requestId
    })
    const target = turns.value.find((item) => item.id === turn.id)
    if (!target) return
    // 以最终结果为准：服务端可能多给一小段，流式期间也会因为节流落后。
    target.answer = result.answer
    target.html = renderAnswer(result.answer)
    target.sources = result.sources
    target.citationMissing = Boolean(result.citationMissing)
    target.status = 'done'
    scrollToBottom()
    void decorateTurn(target.id, target.sources)
    await persistTurn(target)
  } catch (askError) {
    const target = turns.value.find((item) => item.id === turn.id)
    if (stoppedRequests.has(turn.requestId)) {
      // 用户自己停的：保留已经长出来的半截，标一下就好，不弹错也不落库。
      if (target) {
        stopLoadingStages()
        target.status = 'done'
        target.stopped = true
        target.html = renderAnswer(target.answer)
        scrollToBottom()
      }
      return
    }
    const message = askError instanceof Error ? askError.message : 'AI 分析失败'
    if (target) {
      target.status = 'error'
      target.error = message
    }
    // 失败时把问题放回输入框，用户改一改就能重发。
    question.value = turn.question
    await nextTick()
    autoGrow()
    scrollToBottom()
  } finally {
    stoppedRequests.delete(turn.requestId)
    stopLoadingStages()
    loading.value = false
  }
}

/**
 * 停止生成：中止主进程那条连接。
 *
 * 只是本地丢掉增量的话，请求仍在后台跑完，白烧一次 token。
 */
async function stopGenerating(): Promise<void> {
  const active = [...turns.value].reverse().find((item) => (
    item.status === 'pending' || item.status === 'streaming'
  ))
  if (!active) return
  stoppedRequests.add(active.requestId)
  try {
    await window.notesDesktop.abortAiAssistantStream(active.requestId)
  } catch {
    // 主进程那边可能已经收尾（请求刚好跑完），这里不必打扰用户。
  }
}

/**
 * 重新生成：用同一问题重答这一轮。
 *
 * 只对最后一轮开放 —— 中间轮次重答会和后面的追问互相矛盾，
 * 要换方向应该直接提新问题。
 */
async function regenerateTurn(turn: ChatTurn): Promise<void> {
  if (loading.value) return
  const target = turns.value[turns.value.length - 1]
  if (!target || target.id !== turn.id) return
  const history = buildHistory(turn.id)
  turn.requestId = createRequestId()
  turn.answer = ''
  turn.html = ''
  turn.sources = []
  turn.citationMissing = false
  turn.status = 'pending'
  turn.error = ''
  turn.stopped = false
  await runTurn(turn, history)
}

function askSuggestion(text: string): void {
  question.value = text
  void ask()
}

/** 只有最后一轮能重新生成：中间轮次重答会和后面的追问互相矛盾。 */
function isLastTurn(turn: ChatTurn): boolean {
  return turns.value.length > 0 && turns.value[turns.value.length - 1].id === turn.id
}

/** 长笔记没被整篇送进去时说清楚，避免把「没看全」误当成「笔记里没有」。 */
function truncatedHint(turn: ChatTurn): string {
  const limited = turn.sources.filter((source) => source.truncated)
  if (!limited.length) return ''
  if (limited.length === 1) return `「${limited[0].title}」较长，只把前面一段送给了模型，回答可能有遗漏。`
  return `有 ${limited.length} 篇笔记较长，只把各自前面一段送给了模型，回答可能有遗漏。`
}

/** 回答正文里的 `[S1]` 锚点：跳转交给外部（会切到那篇笔记）。 */
function handleAnswerClick(event: MouseEvent, turn: ChatTurn): void {
  const target = event.target as HTMLElement | null
  const anchor = target?.closest<HTMLAnchorElement>('a[href^="#ai-source-"]')
  if (!anchor) return
  event.preventDefault()
  const sourceId = anchor.getAttribute('href')?.replace('#ai-source-', '') || ''
  const source = turn.sources.find((item) => item.id === sourceId)
  if (source) emit('openSource', source.noteId)
}

async function copyTurn(turn: ChatTurn): Promise<void> {
  try {
    await navigator.clipboard.writeText(turn.answer)
    copiedTurnId.value = turn.id
    if (copyTimer) clearTimeout(copyTimer)
    copyTimer = setTimeout(() => { copiedTurnId.value = null }, 1200)
  } catch {
    error.value = '复制失败，请手动选择文本'
  }
}

/**
 * 「＋」= 新开一条对话，而不是把旧对话删掉。
 *
 * 旧对话在上一轮答完时就落库了，所以这里清空界面不会丢东西；
 * 反而要注意：如果当前这条还没落库（第一轮没答完），清了就是真没了。
 */
function startNewConversation(): void {
  turns.value = []
  conversationId.value = null
  error.value = ''
  question.value = ''
  historyOpen.value = false
  cancelRename()
  // 选区 chip 属于「就这段提问」的那次上下文，新对话不该继承它。
  if (props.selectionText) emit('clearSelection')
  void nextTick(() => {
    autoGrow()
    inputEl.value?.focus()
  })
}

/**
 * 把答完的一轮写进本机历史。
 *
 * 失败不打扰用户：回答已经拿到了，落库失败只影响「以后能不能在历史里找回这一轮」。
 * 注意必须逐字段复制 sources —— Vue 的响应式 Proxy 过不了 IPC 的结构化克隆。
 */
async function persistTurn(turn: ChatTurn): Promise<void> {
  // sources 逐字段复制：Vue 的响应式 Proxy 过不了 IPC 的结构化克隆。
  const sources = turn.sources.map((source) => ({
    id: source.id,
    noteId: source.noteId,
    title: source.title,
    excerpt: source.excerpt,
    truncated: Boolean(source.truncated)
  }))
  try {
    // 重新生成的轮次已经有行：原地改写，别在历史里多出一条一样的提问。
    if (turn.dbTurnId) {
      await window.notesDesktop.replaceAiConversationTurn({
        turnId: turn.dbTurnId,
        answer: turn.answer,
        sources,
        citationMissing: turn.citationMissing
      })
      return
    }
    const saved = await window.notesDesktop.appendAiConversationTurn({
      conversationId: conversationId.value,
      question: turn.question,
      answer: turn.answer,
      sources,
      citationMissing: turn.citationMissing
    })
    if (saved?.conversationId) conversationId.value = saved.conversationId
    if (saved?.turnId) turn.dbTurnId = saved.turnId
  } catch {
    // 静默：历史写入是附属动作，不该在已经给出回答之后再弹一次错。
  }
}

/** 历史列表里的时间：近期用相对时间，更早的用月日。 */
function formatHistoryTime(iso: string): string {
  const time = new Date(iso).getTime()
  if (!Number.isFinite(time)) return ''
  const minute = 60 * 1000
  const diff = Date.now() - time
  if (diff < minute) return '刚刚'
  if (diff < 60 * minute) return `${Math.floor(diff / minute)} 分钟前`
  if (diff < 24 * 60 * minute) return `${Math.floor(diff / (60 * minute))} 小时前`
  if (diff < 7 * 24 * 60 * minute) return `${Math.floor(diff / (24 * 60 * minute))} 天前`
  const date = new Date(time)
  return `${date.getMonth() + 1} 月 ${date.getDate()} 日`
}

async function toggleHistory(): Promise<void> {
  if (historyOpen.value) {
    historyOpen.value = false
    cancelRename()
    return
  }
  settingsOpen.value = false
  confirmClearHistory.value = false
  // 先清搜索再开门：反过来的话 watch 视角上算是「打开时改词」，会多查一次。
  if (searchTimer) {
    clearTimeout(searchTimer)
    searchTimer = undefined
  }
  historySearch.value = ''
  historyOpen.value = true
  await loadHistory()
}

/**
 * 设置与历史占同一块覆盖层，必须互斥。
 *
 * 只切 settingsOpen 不关历史时，历史覆盖层的层级更高，设置会整块躲在历史页后面，
 * 看着像「点了没反应」。
 */
function toggleSettings(): void {
  const next = !settingsOpen.value
  if (next) historyOpen.value = false
  settingsOpen.value = next
}

async function loadHistory(): Promise<void> {
  historyLoading.value = true
  historyError.value = ''
  try {
    historyItems.value = await window.notesDesktop.listAiConversations(historySearch.value.trim() || undefined)
  } catch (loadError) {
    historyItems.value = []
    historyError.value = loadError instanceof Error ? loadError.message : '历史对话读取失败'
  } finally {
    historyLoading.value = false
  }
}

/**
 * 搜索输入防抖。
 *
 * 挂在 `@input` 上而不是 watch `historySearch`：打开/关闭历史时会程序化清空搜索词，
 * 用 watch 会连带触发一次多余查询，列表会白闪一下「读取中…」。
 */
function scheduleSearch(): void {
  if (searchTimer) clearTimeout(searchTimer)
  searchTimer = setTimeout(() => {
    searchTimer = undefined
    void loadHistory()
  }, 220)
}

function clearHistorySearch(): void {
  if (!historySearch.value) return
  historySearch.value = ''
  scheduleSearch()
}

/** 行内改名输入框的 ref；改名行只有一个，用函数 ref 直取元素。 */
function setRenameInput(element: Element | { $el?: Element } | null): void {
  renameInputEl = (element as HTMLInputElement | null) || null
}

/** 进入行内改名：光标进输入框并全选，省一次手动清空。 */
async function startRename(item: AiConversationSummary): Promise<void> {
  renamingId.value = item.id
  renameDraft.value = item.title
  await nextTick()
  renameInputEl?.focus()
  renameInputEl?.select()
}

function cancelRename(): void {
  // 先清 ID 再失焦：否则 blur 会把已经取消的草稿又提交回去。
  renamingId.value = null
  renameDraft.value = ''
}

/** 提交改名；空标题等于取消。 */
async function commitRename(item: AiConversationSummary): Promise<void> {
  if (renamingId.value !== item.id) return
  const nextTitle = renameDraft.value.replace(/\s+/g, ' ').trim()
  renamingId.value = null
  renameDraft.value = ''
  if (!nextTitle || nextTitle === item.title) return
  try {
    await window.notesDesktop.renameAiConversation(item.id, nextTitle)
    await loadHistory()
  } catch (renameError) {
    historyError.value = renameError instanceof Error ? renameError.message : '改名失败'
  }
}

/** 置顶 / 取消置顶。 */
async function togglePin(item: AiConversationSummary): Promise<void> {
  try {
    await window.notesDesktop.setAiConversationPinned(item.id, !item.pinned)
    await loadHistory()
  } catch (pinError) {
    historyError.value = pinError instanceof Error ? pinError.message : '置顶失败'
  }
}

/** 打开一条历史对话：把落库的轮次还原成界面气泡。 */
async function openConversation(item: AiConversationSummary): Promise<void> {
  if (loading.value) return
  cancelRename()
  historyLoading.value = true
  historyError.value = ''
  try {
    const conversation = await window.notesDesktop.getAiConversation(item.id)
    if (!conversation) {
      historyError.value = '这条对话已经不在了'
      await loadHistory()
      return
    }
    turnSeed = 0
    turns.value = conversation.turns.map((entry) => {
      turnSeed += 1
      return {
        id: turnSeed,
        // 恢复的轮次不参与流式匹配，留空即可。
        requestId: '',
        question: entry.question,
        answer: entry.answer,
        html: renderAnswer(entry.answer),
        sources: entry.sources,
        citationMissing: entry.citationMissing,
        status: 'done' as const,
        error: '',
        stopped: false,
        // 恢复出来的轮次带着库里的行 ID：重新生成时直接改写这一行。
        dbTurnId: entry.id
      }
    })
    conversationId.value = conversation.id
    historyOpen.value = false
    error.value = ''
    // 恢复出来的是另一条上下文，别让当前选区 chip 挂在新对话上。
    if (props.selectionText) emit('clearSelection')
    scrollToBottom()
    // 等正文进 DOM 再补 [S1] chip，否则 TreeWalker 找不到节点。
    for (const turn of turns.value) await decorateTurn(turn.id, turn.sources)
  } catch (openError) {
    historyError.value = openError instanceof Error ? openError.message : '这条对话打开失败'
  } finally {
    historyLoading.value = false
  }
}

async function removeConversation(item: AiConversationSummary): Promise<void> {
  try {
    await window.notesDesktop.deleteAiConversation(item.id)
    // 删的正好是当前这条，界面也要跟着让位。
    if (conversationId.value === item.id) {
      turns.value = []
      conversationId.value = null
    }
    await loadHistory()
  } catch (removeError) {
    historyError.value = removeError instanceof Error ? removeError.message : '删除失败'
  }
}

/**
 * 清空全部历史（两段确认）。
 *
 * 历史删掉进不了回收站，恢复不了，所以不让一次点击就全清；
 * 第一次点只把按钮切成确认态，再点一次才真的删。
 */
async function clearHistory(): Promise<void> {
  if (!confirmClearHistory.value) {
    confirmClearHistory.value = true
    return
  }
  try {
    await window.notesDesktop.clearAiConversations()
    historyItems.value = []
    confirmClearHistory.value = false
    // 界面上的当前对话留着，但脱离历史：再追问会另起一条新记录。
    conversationId.value = null
  } catch (clearError) {
    historyError.value = clearError instanceof Error ? clearError.message : '清空失败'
  }
}


function handleQuestionKeydown(event: KeyboardEvent): void {
  if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
    event.preventDefault()
    void ask()
  }
}

watch(() => props.visible, (visible) => {
  if (!visible) {
    stopLoadingStages()
    // 面板是常驻组件，收起时要把覆盖层也关掉，否则下次打开直接盖在对话上。
    historyOpen.value = false
    cancelRename()
    return
  }
  // 全局入口在空工作区同样可用，此时使用全库范围避免落在不可用的“当前笔记”。
  scope.value = props.currentNoteId ? 'current' : 'all'
  void loadSettings().then(() => {
    inputEl.value?.focus()
  })
}, { immediate: true })

onMounted(() => {
  unsubscribeDelta = window.notesDesktop.onAiAssistantDelta(handleDelta)
})

onBeforeUnmount(() => {
  stopLoadingStages()
  if (copyTimer) clearTimeout(copyTimer)
  if (renderTimer) clearTimeout(renderTimer)
  if (searchTimer) clearTimeout(searchTimer)
  unsubscribeDelta?.()
  unsubscribeDelta = null
})
</script>

<template>
  <Transition name="ai-panel">
    <aside v-if="visible" class="ai-assistant-panel" aria-label="AI 笔记助手">
      <header class="ai-header">
        <div class="ai-brand">
          <span class="ai-assistant-icon"><Icon icon="tabler:sparkles" /></span>
          <span class="ai-brand-text">
            <strong>AI 笔记助手</strong>
            <small>{{ settings.model || '基于本地笔记回答' }}</small>
          </span>
        </div>
        <div class="ai-header-actions">
          <button
            type="button"
            aria-label="历史对话"
            title="历史对话"
            :class="{ active: historyOpen }"
            @click="toggleHistory"
          >
            <Icon icon="tabler:history" />
          </button>
          <button
            v-if="turns.length"
            type="button"
            aria-label="新对话"
            title="新对话"
            :disabled="loading"
            @click="startNewConversation"
          >
            <Icon icon="tabler:plus" />
          </button>
          <button
            type="button"
            aria-label="模型设置"
            title="模型设置"
            :class="{ active: settingsOpen }"
            @click="toggleSettings"
          >
            <Icon icon="tabler:settings" />
          </button>
          <button type="button" aria-label="关闭 AI 助手" @click="emit('close')">
            <Icon icon="tabler:x" />
          </button>
        </div>
      </header>

      <!-- 设置收成覆盖层：它是一次性配置，不该长期占着对话区。 -->
      <Transition name="ai-sheet">
        <form v-if="settingsOpen" class="ai-settings-sheet" @submit.prevent="saveSettings">
          <div class="ai-settings-head">
            <strong>模型设置</strong>
            <small>兼容 OpenAI 接口</small>
          </div>
          <label>接口地址<input v-model="settingsDraft.baseUrl" type="url" required placeholder="https://api.openai.com/v1" /></label>
          <label>模型名称<input v-model="settingsDraft.model" required placeholder="填写兼容接口支持的模型" /></label>
          <label>
            API Key
            <input
              v-model="settingsDraft.apiKey"
              type="password"
              :required="!settings.hasApiKey"
              :placeholder="settings.hasApiKey ? '已安全保存，留空表示不修改' : '输入 API Key'"
            />
          </label>
          <p class="ai-settings-note"><Icon icon="tabler:shield-lock" />密钥由系统安全存储加密，仅保存在本机。</p>
          <div class="ai-settings-foot">
            <button type="button" class="ai-ghost" @click="settingsOpen = false">取消</button>
            <button type="submit" class="ai-solid" :disabled="settingsLoading">
              {{ settingsLoading ? '保存中…' : '保存设置' }}
            </button>
          </div>
        </form>
      </Transition>

      <!-- 历史对话：和设置一样是覆盖层，不占对话区，窄面板也不用重排布局。 -->
      <Transition name="ai-sheet">
        <section
          v-if="historyOpen"
          class="ai-history-sheet"
          role="region"
          aria-label="历史对话"
        >
          <div class="ai-settings-head">
            <strong>历史对话</strong>
            <small>只保存在本机</small>
          </div>
          <div class="ai-history-search">
            <Icon icon="tabler:search" />
            <input
              v-model="historySearch"
              class="ai-history-search-input"
              type="search"
              placeholder="搜索标题或提问内容"
              aria-label="搜索历史对话"
              @input="scheduleSearch"
            />
            <button
              v-if="historySearch"
              type="button"
              class="ai-history-search-clear"
              aria-label="清除搜索"
              title="清除搜索"
              @click="clearHistorySearch"
            >
              <Icon icon="tabler:x" />
            </button>
          </div>
          <p v-if="historyLoading && !historyItems.length" class="ai-history-empty">读取中…</p>
          <p v-else-if="historyError" class="ai-history-error">{{ historyError }}</p>
          <p v-else-if="historySearch.trim() && !historyItems.length" class="ai-history-empty">
            没有匹配的对话，换个词试试。
          </p>
          <p v-else-if="!historyItems.length" class="ai-history-empty">
            还没有历史对话。答完一轮后会自动保存，下次可以从这里找回来。
          </p>
          <ul v-else class="ai-history-list">
            <li v-for="item in historyItems" :key="item.id" :class="{ 'is-pinned': item.pinned }">
              <!-- 改名走行内输入：历史列表本来就是一列标题，弹窗太重。 -->
              <input
                v-if="renamingId === item.id"
                :ref="setRenameInput"
                v-model="renameDraft"
                class="ai-history-rename"
                maxlength="80"
                aria-label="对话标题"
                @keydown.enter.prevent="commitRename(item)"
                @keydown.esc.prevent="cancelRename"
                @blur="commitRename(item)"
              />
              <template v-else>
                <button type="button" class="ai-history-item" @click="openConversation(item)">
                  <span class="ai-history-title">
                    <Icon v-if="item.pinned" icon="tabler:pin" class="ai-history-pin" />
                    {{ item.title }}
                  </span>
                  <small>{{ formatHistoryTime(item.updatedAt) }} · {{ item.turnCount }} 轮</small>
                </button>
                <div class="ai-history-actions">
                  <button
                    type="button"
                    class="ai-history-action"
                    :class="{ active: item.pinned }"
                    :aria-label="item.pinned ? `取消置顶：${item.title}` : `置顶：${item.title}`"
                    :title="item.pinned ? '取消置顶' : '置顶'"
                    @click.stop="togglePin(item)"
                  >
                    <Icon icon="tabler:pin" />
                  </button>
                  <button
                    type="button"
                    class="ai-history-action"
                    :aria-label="`重命名：${item.title}`"
                    title="重命名"
                    @click.stop="startRename(item)"
                  >
                    <Icon icon="tabler:pencil" />
                  </button>
                  <button
                    type="button"
                    class="ai-history-action danger"
                    :aria-label="`删除对话：${item.title}`"
                    title="删除这条对话"
                    @click.stop="removeConversation(item)"
                  >
                    <Icon icon="tabler:trash" />
                  </button>
                </div>
              </template>
            </li>
          </ul>
          <div v-if="historyItems.length && !historySearch.trim()" class="ai-history-foot">
            <button
              type="button"
              class="ai-ghost"
              :class="{ danger: confirmClearHistory }"
              @click="clearHistory"
            >
              {{ confirmClearHistory ? '再点一次确认清空' : '清空全部历史' }}
            </button>
          </div>
          <p class="ai-settings-note">
            <Icon icon="tabler:shield-lock" />对话只写入本机数据库，不参与同步；最多保留 50 条或 30 天。
          </p>
        </section>
      </Transition>

      <div ref="transcriptEl" class="ai-transcript">
        <div v-if="!turns.length && !loading" class="ai-empty">
          <span class="ai-empty-icon"><Icon icon="tabler:sparkles" /></span>
          <h3>有什么想从笔记里找的？</h3>
          <p>只读检索命中的片段，不会上传整个笔记库。</p>
          <div class="ai-suggestions">
            <button
              v-for="item in SUGGESTIONS"
              :key="item"
              type="button"
              :disabled="scope === 'current' && !currentNoteId"
              @click="askSuggestion(item)"
            >
              {{ item }}
            </button>
          </div>
        </div>

        <article v-for="turn in turns" :key="turn.id" class="ai-turn">
          <p class="ai-bubble ai-bubble--user">{{ turn.question }}</p>
          <div class="ai-bubble ai-bubble--assistant">
            <div class="ai-bubble-head">
              <span class="ai-avatar"><Icon icon="tabler:sparkles" /></span>
              <span class="ai-bubble-model">{{ settings.model || 'AI' }}</span>
              <button
                v-if="turn.status === 'done' && isLastTurn(turn) && !loading"
                type="button"
                class="ai-copy"
                aria-label="重新生成"
                title="重新生成"
                @click="regenerateTurn(turn)"
              >
                <Icon icon="tabler:refresh" />
              </button>
              <button
                v-if="turn.status === 'done'"
                type="button"
                class="ai-copy"
                :aria-label="copiedTurnId === turn.id ? '已复制' : '复制回答'"
                :title="copiedTurnId === turn.id ? '已复制' : '复制回答'"
                @click="copyTurn(turn)"
              >
                <Icon :icon="copiedTurnId === turn.id ? 'tabler:check' : 'tabler:copy'" />
              </button>
            </div>
            <!-- 首字节还没到：三点 + 阶段文案占住这一轮的位置。 -->
            <div v-if="turn.status === 'pending'" class="ai-loading">
              <span class="ai-typing" aria-hidden="true"><i></i><i></i><i></i></span>
              <span class="ai-loading-text">{{ loadingStage }}</span>
            </div>
            <template v-else>
              <!-- 正文来自模型，`renderAnswer` 已做 Markdown 转换 + DOMPurify 清洗。 -->
              <div
                class="ai-answer-text"
                :class="{ 'is-streaming': turn.status === 'streaming' }"
                :data-turn-id="turn.id"
                @click="handleAnswerClick($event, turn)"
                v-html="turn.html"
              ></div>
              <p v-if="turn.status === 'error'" class="ai-turn-error">
                <Icon icon="tabler:alert-circle" />{{ turn.error }}
              </p>
              <p v-if="turn.stopped" class="ai-turn-stopped">
                <Icon icon="tabler:player-stop" />已停止生成，这一轮不会存进历史。
              </p>
              <p v-if="turn.status === 'done' && !turn.stopped && truncatedHint(turn)" class="ai-citation-hint">
                <Icon icon="tabler:info-circle" />{{ truncatedHint(turn) }}
              </p>
              <p v-if="turn.status === 'done' && turn.citationMissing" class="ai-citation-hint">
                <Icon icon="tabler:info-circle" />本条回答没有标注来源，下面是这次检索到的笔记。
              </p>
              <details v-if="turn.status === 'done' && turn.sources.length" class="ai-sources">
                <summary>参考 {{ turn.sources.length }} 篇笔记</summary>
                <button
                  v-for="source in turn.sources"
                  :key="`${turn.id}-${source.id}`"
                  type="button"
                  @click="emit('openSource', source.noteId)"
                >
                  <span class="ai-source-id">{{ source.id }}</span>
                  <span class="ai-source-text"><strong>{{ source.title }}</strong><small>{{ source.excerpt }}</small></span>
                  <Icon icon="tabler:arrow-up-right" />
                </button>
              </details>
            </template>
          </div>
        </article>

        <p v-if="error" class="ai-error"><Icon icon="tabler:alert-circle" />{{ error }}</p>
      </div>

      <footer class="ai-composer">
        <div class="ai-scope-row">
          <div class="ai-scope-chips" role="group" aria-label="分析范围">
            <button
              v-for="option in scopeOptions"
              :key="option.value"
              type="button"
              :class="{ active: scope === option.value }"
              :aria-pressed="scope === option.value"
              :disabled="option.value === 'current' && !currentNoteId"
              @click="scope = option.value"
            >
              <Icon :icon="option.icon" /><span>{{ option.label }}</span>
            </button>
          </div>
          <span class="ai-scope-hint" :title="scopeHint">{{ scopeHint }}</span>
        </div>
        <!-- 选区 chip：从正文气泡「问 AI」带进来，提问时作为 S1 资料直接送模型。 -->
        <div v-if="selectionText" class="ai-selection-chip">
          <Icon icon="tabler:quote" />
          <span class="ai-selection-label">选中片段 · {{ selectionText.length }} 字</span>
          <span class="ai-selection-preview" :title="selectionText">{{ selectionPreview }}</span>
          <button
            type="button"
            class="ai-selection-remove"
            aria-label="移除选中片段"
            title="不针对这段，改为检索笔记"
            @click="emit('clearSelection')"
          >
            <Icon icon="tabler:x" />
          </button>
        </div>
        <div class="ai-composer-box">
          <textarea
            id="ai-assistant-question"
            ref="inputEl"
            v-model="question"
            rows="1"
            aria-label="你想从笔记中了解什么？"
            placeholder="问点什么，比如：总结这篇笔记的关键结论"
            @input="autoGrow"
            @keydown="handleQuestionKeydown"
          />
          <button
            v-if="loading"
            type="button"
            class="ai-send ai-send--stop"
            aria-label="停止生成"
            title="停止生成"
            @click="stopGenerating"
          >
            <Icon icon="tabler:player-stop" />
          </button>
          <button
            v-else
            type="button"
            class="ai-send"
            aria-label="发送"
            title="发送（⌘ Enter）"
            :disabled="!canAsk"
            @click="ask"
          >
            <Icon icon="tabler:arrow-up" />
          </button>
        </div>
        <p class="ai-composer-note">只发送检索命中的有限文本片段，不发送附件和图片。</p>
      </footer>
    </aside>
  </Transition>
</template>

<style scoped>
.ai-assistant-panel { position: absolute; z-index: 90; inset: 0 0 0 auto; display: flex; width: min(var(--overlay-side-panel-width), calc(100% - 24px)); flex-direction: column; border-left: 1px solid var(--line); background: color-mix(in srgb, var(--surface-solid) 97%, transparent); box-shadow: -18px 0 50px rgba(28,51,82,.16); color: var(--ink); backdrop-filter: blur(24px); }

/* 顶栏：品牌 + 三个图标动作，比原来的「标题 + 关闭」更像个应用面板。 */
.ai-header { display: flex; min-height: 64px; align-items: center; justify-content: space-between; gap: 10px; border-bottom: 1px solid var(--line); padding: 12px 12px 12px 16px; }
.ai-brand { display: flex; min-width: 0; align-items: center; gap: 10px; }
.ai-assistant-icon { display: grid; width: 36px; height: 36px; flex: none; place-items: center; border-radius: 11px; background: linear-gradient(135deg, rgba(50,170,167,.18), rgba(47,128,237,.2)); color: var(--blue); }
.ai-assistant-icon svg { width: 20px; height: 20px; }
.ai-brand-text { display: grid; min-width: 0; gap: 2px; }
.ai-brand-text strong { font-size: var(--overlay-menu-font-size); }
.ai-brand-text small { overflow: hidden; color: var(--muted); font-size: var(--overlay-option-font-size); text-overflow: ellipsis; white-space: nowrap; }
.ai-header-actions { display: flex; flex: none; align-items: center; gap: 4px; }
.ai-header-actions button { display: grid; width: 30px; height: 30px; place-items: center; border: 0; border-radius: 8px; background: transparent; color: var(--muted); cursor: pointer; }
.ai-header-actions button:hover { background: rgba(47,128,237,.1); color: var(--blue); }
.ai-header-actions button.active { background: rgba(47,128,237,.13); color: var(--blue); }
/* 回答还在流式时不允许中途开新对话：那会把还没落库的这一轮直接丢掉。 */
.ai-header-actions button:disabled { cursor: default; opacity: .4; }
.ai-header-actions button:disabled:hover { background: transparent; color: var(--muted); }

/* 对话流：整块唯一滚动容器，新消息进来自动贴底。 */
.ai-transcript { display: flex; min-height: 0; flex: 1; flex-direction: column; gap: 14px; overflow-y: auto; padding: 18px 14px 10px; }

.ai-empty { display: grid; flex: 1; align-content: center; justify-items: center; gap: 8px; padding: 0 10px 30px; text-align: center; }
.ai-empty-icon { display: grid; width: 52px; height: 52px; margin-bottom: 4px; place-items: center; border-radius: 16px; background: linear-gradient(135deg, rgba(50,170,167,.18), rgba(47,128,237,.22)); color: var(--blue); }
.ai-empty-icon svg { width: 26px; height: 26px; }
.ai-empty h3 { margin: 0; font-size: 17px; }
.ai-empty p { margin: 0; color: var(--muted); font-size: var(--overlay-option-font-size); line-height: 1.6; }
.ai-suggestions { display: grid; width: 100%; gap: 7px; margin-top: 14px; }
.ai-suggestions button { border: 1px solid var(--line); border-radius: 11px; padding: 10px 12px; background: var(--panel); color: var(--ink); cursor: pointer; font-size: var(--overlay-option-font-size); text-align: left; }
.ai-suggestions button:hover { border-color: rgba(47,128,237,.4); background: rgba(47,128,237,.07); color: var(--blue); }
.ai-suggestions button:disabled { cursor: default; opacity: .45; }
.ai-suggestions button:disabled:hover { border-color: var(--line); background: var(--panel); color: var(--ink); }

.ai-turn { display: flex; flex-direction: column; gap: 10px; }
.ai-bubble { max-width: 100%; border-radius: 15px; font-size: var(--overlay-menu-font-size); line-height: 1.7; }
/* 用户消息靠右、实色；助手消息靠左、卡片底，和主流对话界面一致。 */
.ai-bubble--user { align-self: flex-end; max-width: 88%; border-bottom-right-radius: 5px; padding: 9px 13px; background: linear-gradient(135deg, #3a86f0, #2f6fe0); color: #fff; overflow-wrap: anywhere; white-space: pre-wrap; }
.ai-bubble--assistant { align-self: stretch; border: 1px solid var(--line); border-bottom-left-radius: 5px; padding: 11px 13px 12px; background: var(--panel); }

.ai-bubble-head { display: flex; align-items: center; gap: 7px; margin-bottom: 7px; color: var(--muted); font-size: var(--overlay-option-font-size); font-weight: 600; }
.ai-avatar { display: grid; width: 22px; height: 22px; flex: none; place-items: center; border-radius: 7px; background: linear-gradient(135deg, rgba(50,170,167,.2), rgba(47,128,237,.22)); color: var(--blue); }
.ai-avatar svg { width: 14px; height: 14px; }
.ai-bubble-model { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ai-copy { margin-left: auto; display: grid; width: 24px; height: 24px; place-items: center; border: 0; border-radius: 6px; background: transparent; color: var(--muted); cursor: pointer; opacity: 0; transition: opacity .15s ease; }
.ai-bubble--assistant:hover .ai-copy { opacity: 1; }
.ai-copy:hover { background: rgba(47,128,237,.1); color: var(--blue); }

.ai-answer-text { overflow-wrap: anywhere; }
.ai-answer-text :deep(:first-child) { margin-top: 0; }
.ai-answer-text :deep(:last-child) { margin-bottom: 0; }
.ai-answer-text :deep(p) { margin: 0 0 9px; }
.ai-answer-text :deep(h1), .ai-answer-text :deep(h2), .ai-answer-text :deep(h3) { margin: 14px 0 7px; color: var(--ink); font-size: 1.06em; line-height: 1.4; }
.ai-answer-text :deep(ul), .ai-answer-text :deep(ol) { margin: 7px 0 10px; padding-left: 22px; }
.ai-answer-text :deep(li + li) { margin-top: 4px; }
.ai-answer-text :deep(blockquote) { margin: 9px 0; border-left: 3px solid rgba(47,128,237,.35); padding: 2px 0 2px 10px; color: var(--muted); }
.ai-answer-text :deep(code) { border-radius: 5px; padding: 2px 5px; background: var(--surface-solid); color: var(--ink); font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; font-size: .92em; }
.ai-answer-text :deep(pre) { overflow-x: auto; border: 1px solid var(--line); border-radius: 9px; padding: 10px; background: var(--surface-solid); }
.ai-answer-text :deep(pre code) { padding: 0; background: transparent; }
.ai-answer-text :deep(a) { color: var(--blue); text-decoration: underline; text-underline-offset: 2px; }
/* `[S1]` 锚点渲染成来源 chip：可点、压住下划线，和正文链接区分开。 */
.ai-answer-text :deep(a[href^="#ai-source-"]) { display: inline-flex; min-width: 26px; height: 19px; align-items: center; justify-content: center; margin: 0 2px; border-radius: 6px; padding: 0 5px; background: rgba(47,128,237,.12); color: var(--blue); font-size: 11px; font-weight: 800; line-height: 1; text-decoration: none; vertical-align: 1px; }
.ai-answer-text :deep(a[href^="#ai-source-"]:hover) { background: rgba(47,128,237,.22); }

.ai-citation-hint { display: flex; align-items: flex-start; gap: 6px; margin: 10px 0 0; border-radius: 8px; padding: 7px 9px; background: rgba(214,158,46,.12); color: #9a6b12; font-size: var(--overlay-option-font-size); line-height: 1.5; }
:global(html[data-theme="dark"]) .ai-citation-hint { background: rgba(214,158,46,.16); color: #e2b35d; }
.ai-turn-error { display: flex; align-items: flex-start; gap: 6px; margin: 6px 0 0; color: #cb4153; font-size: var(--overlay-option-font-size); line-height: 1.5; }
/* 用户主动停下的那一轮：说清楚「不会再进历史」，免得下次找不到以为丢了。 */
.ai-turn-stopped { display: flex; align-items: center; gap: 6px; margin: 6px 0 0; color: var(--muted); font-size: var(--overlay-option-font-size); line-height: 1.5; }
/* 流式期间末尾挂一个呼吸光标，和常见对话界面的「正在写」一致。 */
.ai-answer-text.is-streaming::after { content: ''; display: inline-block; width: 2px; height: 1em; margin-left: 3px; border-radius: 1px; background: var(--blue); vertical-align: -2px; animation: ai-caret 1s steps(1) infinite; }

/* 来源默认折叠：回答是主角，引用明细按需展开。 */
.ai-sources { margin-top: 11px; border-top: 1px solid var(--line); padding-top: 9px; }
.ai-sources summary { color: var(--muted); cursor: pointer; font-size: var(--overlay-option-font-size); font-weight: 700; list-style: none; }
.ai-sources summary::-webkit-details-marker { display: none; }
.ai-sources summary::before { content: '▸'; display: inline-block; width: 12px; transition: transform .15s ease; }
.ai-sources[open] summary::before { transform: rotate(90deg); }
.ai-sources summary:hover { color: var(--blue); }
.ai-sources > button { display: grid; width: 100%; grid-template-columns: 30px minmax(0,1fr) 16px; align-items: center; gap: 8px; margin-top: 6px; border: 0; border-radius: 9px; padding: 7px 8px; background: var(--surface-solid); color: var(--ink); cursor: pointer; text-align: left; }
.ai-sources > button:hover { background: rgba(47,128,237,.09); }
.ai-source-text { min-width: 0; }
.ai-sources strong, .ai-sources small { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ai-sources strong { font-size: var(--overlay-option-font-size); }
.ai-sources small { margin-top: 2px; color: var(--muted); font-size: var(--overlay-option-font-size); }
.ai-source-id { display: grid; height: 24px; place-items: center; border-radius: 7px; background: rgba(47,128,237,.12); color: var(--blue); font-size: var(--overlay-option-font-size); font-weight: 800; }
.ai-sources > button > svg { color: var(--muted); }

/* 等待态：三点跳动 + 阶段文案，别让用户对着空白等。 */
.ai-loading { display: flex; align-items: center; gap: 8px; }
.ai-typing { display: inline-flex; gap: 3px; }
.ai-typing i { width: 5px; height: 5px; border-radius: 50%; background: var(--blue); opacity: .35; animation: ai-bounce 1.1s infinite ease-in-out; }
.ai-typing i:nth-child(2) { animation-delay: .15s; }
.ai-typing i:nth-child(3) { animation-delay: .3s; }
.ai-loading-text { color: var(--muted); font-size: var(--overlay-option-font-size); }

.ai-error { display: flex; align-items: flex-start; gap: 7px; margin: 0; border-radius: var(--overlay-item-radius); padding: 9px 10px; background: rgba(203,65,83,.11); color: #cb4153; font-size: var(--overlay-menu-font-size); }

/* 底部输入区：固定在面板下沿，范围 chips 压缩成一行。 */
.ai-composer { flex: none; border-top: 1px solid var(--line); padding: 10px 12px 12px; background: color-mix(in srgb, var(--surface-solid) 94%, transparent); }
.ai-scope-row { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; }
.ai-scope-chips { display: inline-flex; flex: none; gap: 2px; border-radius: 9px; padding: 2px; background: rgba(47,128,237,.07); }
.ai-scope-chips button { display: inline-flex; align-items: center; gap: 4px; border: 0; border-radius: 7px; padding: 3px 8px; background: transparent; color: var(--muted); cursor: pointer; font-size: 11px; font-weight: 600; white-space: nowrap; }
.ai-scope-chips button svg { width: 14px; height: 14px; }
.ai-scope-chips button:hover { color: var(--blue); }
.ai-scope-chips button.active { background: var(--surface-solid); color: var(--blue); box-shadow: 0 1px 3px rgba(31,54,84,.12); }
.ai-scope-chips button:disabled { cursor: default; opacity: .4; }
.ai-scope-hint { min-width: 0; flex: 1; overflow: hidden; color: var(--muted); font-size: 11px; text-align: right; text-overflow: ellipsis; white-space: nowrap; }

/* 选区 chip：一行装下「来源 + 字数 + 预览 + 移除」，不换行也不挤掉输入框。 */
.ai-selection-chip { display: flex; align-items: center; gap: 6px; min-width: 0; margin-bottom: 8px; border: 1px solid rgba(47,128,237,.28); border-radius: 9px; padding: 5px 6px 5px 9px; background: rgba(47,128,237,.07); color: var(--blue); font-size: 11px; }
.ai-selection-chip > svg { width: 14px; height: 14px; flex: none; }
.ai-selection-label { flex: none; font-weight: 700; }
.ai-selection-preview { min-width: 0; flex: 1; overflow: hidden; color: var(--muted); text-overflow: ellipsis; white-space: nowrap; }
.ai-selection-remove { display: grid; width: 20px; height: 20px; flex: none; place-items: center; border: 0; border-radius: 6px; background: transparent; color: var(--muted); cursor: pointer; }
.ai-selection-remove svg { width: 14px; height: 14px; }
.ai-selection-remove:hover { background: rgba(47,128,237,.14); color: var(--blue); }

.ai-composer-box { display: flex; align-items: flex-end; gap: 8px; border: 1px solid var(--line); border-radius: 14px; padding: 7px 7px 7px 12px; background: var(--surface-solid); transition: border-color .15s ease, box-shadow .15s ease; }
.ai-composer-box:focus-within { border-color: rgba(47,128,237,.55); box-shadow: 0 0 0 3px rgba(47,128,237,.1); }
.ai-composer-box textarea { min-height: 24px; flex: 1; resize: none; border: 0; outline: 0; padding: 3px 0; background: transparent; color: var(--ink); font: inherit; font-size: var(--overlay-menu-font-size); line-height: 1.6; }
.ai-composer-box textarea::placeholder { color: var(--muted); }
.ai-send { display: grid; width: 30px; height: 30px; flex: none; place-items: center; border: 0; border-radius: 10px; background: linear-gradient(135deg, var(--teal), var(--blue)); color: #fff; cursor: pointer; }
.ai-send:disabled { cursor: default; filter: saturate(.35); opacity: .45; }
/* 生成中同一位置换成「停止」：不再是个转圈的禁用按钮，用户随时能掐断。 */
.ai-send--stop { border: 1px solid var(--line); background: var(--surface-solid); color: var(--muted); }
.ai-send--stop:hover { border-color: rgba(214,69,69,.45); background: rgba(214,69,69,.08); color: #d64545; }
.ai-composer-note { margin: 7px 2px 0; color: var(--muted); font-size: 11px; text-align: center; }

/* 设置覆盖层：从顶栏下方铺满整个面板，配置时不该露出半截对话。
   层级比历史高一层：两者互斥，但交叉淡出时新的那块必须在上面。 */
.ai-settings-sheet { position: absolute; z-index: 7; top: 64px; right: 0; bottom: 0; left: 0; display: grid; align-content: start; gap: 10px; overflow-y: auto; padding: 16px 14px; background: var(--surface-solid); }
.ai-settings-head { display: flex; align-items: baseline; justify-content: space-between; }
.ai-settings-head strong { font-size: var(--overlay-menu-font-size); }
.ai-settings-head small { color: var(--muted); font-size: var(--overlay-option-font-size); }
.ai-settings-sheet label { display: grid; gap: 5px; color: var(--muted); font-size: var(--overlay-option-font-size); }
.ai-settings-sheet input { height: var(--overlay-search-height); border: 1px solid var(--line); border-radius: var(--overlay-item-radius); outline: 0; padding: 0 9px; background: var(--panel); color: var(--ink); }
.ai-settings-sheet input:focus { border-color: rgba(47,128,237,.55); }
.ai-settings-note { display: flex; align-items: center; gap: 5px; margin: 0; color: var(--muted); font-size: var(--overlay-option-font-size); }
/* 覆盖层里的按钮压到 12px / 30px：面板只有 410px 宽，按钮跟着正文字号走会显得笨重。 */
.ai-settings-foot { display: flex; justify-content: flex-end; gap: 8px; }
.ai-settings-foot button { height: 30px; border: 0; border-radius: var(--overlay-item-radius); padding: 0 12px; cursor: pointer; font-size: 12px; font-weight: 700; }
.ai-ghost { background: transparent; color: var(--muted); }
.ai-ghost:hover { background: rgba(47,128,237,.08); color: var(--blue); }
.ai-solid { background: linear-gradient(135deg, var(--teal), var(--blue)); color: #fff; }
.ai-solid:disabled { cursor: default; opacity: .6; }

/* 历史对话覆盖层：与设置共用同一块位置，两者互斥展开。 */
.ai-history-sheet { position: absolute; z-index: 6; top: 64px; right: 0; bottom: 0; left: 0; display: grid; align-content: start; gap: 10px; overflow-y: auto; padding: 16px 14px; background: var(--surface-solid); }
.ai-history-list { display: grid; gap: 2px; margin: 0; padding: 0; list-style: none; }
.ai-history-list li { position: relative; display: flex; min-height: 52px; align-items: center; }

/* 搜索框：和列表同宽，左侧放大镜，右侧清除按钮（原生 x 在 macOS 上太小）。 */
.ai-history-search { display: flex; height: 30px; align-items: center; gap: 6px; border: 1px solid var(--line); border-radius: var(--overlay-item-radius); padding: 0 8px; background: var(--surface-solid); }
.ai-history-search:focus-within { border-color: rgba(47,128,237,.45); }
.ai-history-search > svg { width: 14px; height: 14px; flex: none; color: var(--muted); }
.ai-history-search-input { flex: 1; min-width: 0; border: 0; outline: none; background: transparent; color: var(--ink); font-size: 12px; }
.ai-history-search-input::-webkit-search-cancel-button { display: none; }
.ai-history-search-clear { display: grid; width: 20px; height: 20px; flex: none; place-items: center; border: 0; border-radius: 5px; background: transparent; color: var(--muted); cursor: pointer; }
.ai-history-search-clear svg { width: 13px; height: 13px; }
.ai-history-search-clear:hover { background: rgba(47,128,237,.1); color: var(--blue); }

.ai-history-item { display: grid; flex: 1; min-width: 0; gap: 2px; border: 0; border-radius: var(--overlay-item-radius); padding: 7px 78px 7px 9px; background: transparent; color: var(--ink); text-align: left; cursor: pointer; }
.ai-history-item:hover { background: rgba(47,128,237,.09); }
/* 置顶项给一层淡底：它不按时间排，得让人一眼看出「为什么它在上面」。 */
.ai-history-list li.is-pinned .ai-history-item { background: rgba(47,128,237,.075); }
.ai-history-title { overflow: hidden; font-size: var(--overlay-option-font-size); font-weight: 600; text-overflow: ellipsis; white-space: nowrap; }
.ai-history-pin { width: 12px; height: 12px; margin-right: 3px; color: var(--blue); vertical-align: -1px; }
.ai-history-item small { color: var(--muted); font-size: 11px; }
/* 行内改名：和列表项等高，不撑动布局。 */
.ai-history-rename { flex: 1; min-width: 0; height: 30px; border: 1px solid rgba(47,128,237,.55); border-radius: var(--overlay-item-radius); padding: 0 8px; background: var(--surface-solid); color: var(--ink); font-family: inherit; font-size: var(--overlay-option-font-size); font-weight: 600; outline: none; }
/* 置顶 / 改名 / 删除只在悬停或键盘聚焦时浮出：列表本身是「点一下打开」。 */
.ai-history-actions { position: absolute; right: 4px; display: flex; gap: 1px; opacity: 0; transition: opacity .12s; }
.ai-history-list li:hover .ai-history-actions,
.ai-history-list li:focus-within .ai-history-actions { opacity: 1; }
.ai-history-action { display: grid; width: 24px; height: 24px; place-items: center; border: 0; border-radius: 6px; background: transparent; color: var(--muted); cursor: pointer; }
.ai-history-action svg { width: 15px; height: 15px; }
.ai-history-action:hover { background: rgba(47,128,237,.12); color: var(--blue); }
.ai-history-action.active { color: var(--blue); }
.ai-history-action.danger:hover { background: rgba(214,69,69,.12); color: #d64545; }
.ai-history-empty { margin: 0; color: var(--muted); font-size: var(--overlay-option-font-size); line-height: 1.7; }
.ai-history-error { margin: 0; color: #d64545; font-size: var(--overlay-option-font-size); }
.ai-history-foot { display: flex; justify-content: flex-end; }
.ai-history-foot button { height: 30px; border: 1px solid var(--line); border-radius: var(--overlay-item-radius); padding: 0 12px; background: transparent; color: var(--muted); cursor: pointer; font-size: 12px; font-weight: 700; }
.ai-history-foot button:hover { border-color: rgba(47,128,237,.35); color: var(--blue); }
/* 确认态才用红色：第一次点击前它只是个普通按钮，不该提前染红。 */
.ai-history-foot button.danger { border-color: rgba(214,69,69,.45); color: #d64545; }
.ai-history-foot button.danger:hover { border-color: rgba(214,69,69,.65); background: rgba(214,69,69,.08); color: #d64545; }

.spinning { animation: ai-spin .8s linear infinite; }
@keyframes ai-spin { to { transform: rotate(360deg); } }
@keyframes ai-bounce { 0%, 80%, 100% { opacity: .3; transform: translateY(0); } 40% { opacity: 1; transform: translateY(-3px); } }
@keyframes ai-caret { 50% { opacity: 0; } }

.ai-panel-enter-active, .ai-panel-leave-active { transition: transform .2s ease, opacity .2s ease; }
.ai-panel-enter-from, .ai-panel-leave-to { transform: translateX(24px); opacity: 0; }
.ai-sheet-enter-active, .ai-sheet-leave-active { transition: opacity .16s ease, transform .16s ease; }
.ai-sheet-enter-from, .ai-sheet-leave-to { transform: translateY(-8px); opacity: 0; }
</style>
