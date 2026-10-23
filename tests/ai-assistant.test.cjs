const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')

const {
  createAiAssistant,
  extractSearchTerms,
  sanitizeNoteContent
} = require('../electron/ai-assistant.cjs')

test('AI 检索词会去掉问句噪音并保留主题词', () => {
  assert.deepEqual(
    extractSearchTerms('帮我查找并分析所有关于 Python 并发的记录'),
    ['Python', '并发', '记录']
  )
})

test('发送给模型前会移除 Base64、图片和外部地址', () => {
  const sanitized = sanitizeNoteContent([
    '# 标题',
    '正文内容',
    '![截图](data:image/png;base64,AAAA)',
    '![远程图片](https://example.com/a.png)',
    '[附件](https://example.com/a.pdf "attachment|application/pdf|12")',
    '[本地附件](xinyue-asset://local/asset-id)'
  ].join('\n'))

  assert.match(sanitized, /标题/)
  assert.match(sanitized, /正文内容/)
  assert.doesNotMatch(sanitized, /base64|AAAA|https?:\/\//)
  assert.doesNotMatch(sanitized, /xinyue-asset:/)
})

test('AI 设置加密保存且不会向渲染层返回明文密钥', async (context) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'xinyue-ai-settings-'))
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const settingsPath = path.join(directory, 'ai-settings.json')
  const assistant = createAiAssistant({
    settingsPath,
    encryptSecret: (value) => `encrypted:${Buffer.from(value).toString('base64')}`,
    decryptSecret: (value) => Buffer.from(value.slice('encrypted:'.length), 'base64').toString(),
    repository: {},
    request: async () => { throw new Error('不应发起请求') }
  })

  const saved = await assistant.saveSettings({
    baseUrl: 'https://api.example.com/v1/',
    model: 'demo-model',
    apiKey: 'top-secret'
  })

  assert.deepEqual(saved, {
    baseUrl: 'https://api.example.com/v1',
    model: 'demo-model',
    hasApiKey: true
  })
  assert.doesNotMatch(fs.readFileSync(settingsPath, 'utf8'), /top-secret/)
  assert.deepEqual(await assistant.getSettings(), saved)
  assert.equal('apiKey' in saved, false)
})

test('AI 问答限制上下文并返回可定位来源', async (context) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'xinyue-ai-ask-'))
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  let requestBody = null
  const notes = [
    {
      id: 'note-1', folderId: 'folder-1', title: 'Python 并发', content: '线程池适合 IO 密集任务。'.repeat(400), isDeleted: false
    },
    {
      id: 'note-2', folderId: 'folder-2', title: '无关笔记', content: '不应进入当前文件夹范围', isDeleted: false
    }
  ]
  const assistant = createAiAssistant({
    settingsPath: path.join(directory, 'ai-settings.json'),
    encryptSecret: (value) => `encrypted:${value}`,
    decryptSecret: (value) => value.slice('encrypted:'.length),
    repository: {
      searchNotes: (_keyword, options) => notes.filter((note) => (
        !options.folderIds?.length || options.folderIds.includes(note.folderId)
      )),
      getNoteForEditing: (noteId) => notes.find((note) => note.id === noteId) || null,
      listWorkspace: () => ({ notes, folders: [], tags: [], pendingCount: 0 })
    },
    request: async (_url, options) => {
      requestBody = JSON.parse(options.body)
      return {
        ok: true,
        status: 200,
        json: async () => ({ choices: [{ message: { content: '线程池适合 IO 密集任务。[S1]' } }] })
      }
    }
  })
  await assistant.saveSettings({ baseUrl: 'https://api.example.com/v1', model: 'demo', apiKey: 'secret' })

  const result = await assistant.ask({
    question: '分析 Python 并发',
    scope: 'folder',
    folderId: 'folder-1'
  })

  assert.equal(result.answer, '线程池适合 IO 密集任务。[S1]')
  assert.deepEqual(result.sources.map((source) => source.noteId), ['note-1'])
  assert.equal(requestBody.model, 'demo')
  assert.match(requestBody.messages[1].content, /\[S1\] Python 并发/)
  assert.doesNotMatch(requestBody.messages[1].content, /无关笔记/)
  assert.ok(requestBody.messages[1].content.length < 7000)
})

test('FTS 没有召回时不会把最近笔记作为无关上下文发送', async (context) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'xinyue-ai-empty-'))
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  let requested = false
  const assistant = createAiAssistant({
    settingsPath: path.join(directory, 'ai-settings.json'),
    encryptSecret: (value) => `encrypted:${value}`,
    decryptSecret: (value) => value.slice('encrypted:'.length),
    repository: {
      searchNotes: () => [],
      getNoteForEditing: () => null
    },
    request: async () => {
      requested = true
      throw new Error('不应发起请求')
    }
  })
  await assistant.saveSettings({ baseUrl: 'https://api.example.com/v1', model: 'demo', apiKey: 'secret' })

  await assert.rejects(
    assistant.ask({ question: '完全不存在的主题', scope: 'all' }),
    /没有可供分析的文本笔记/
  )
  assert.equal(requested, false)
})

test('模型请求中的笔记资料连同标题和分隔符不超过总预算', async (context) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'xinyue-ai-budget-'))
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  let requestBody = null
  const notes = Array.from({ length: 8 }, (_, index) => ({
    id: `note-${index}`,
    folderId: null,
    title: `超长标题-${index}-${'标题'.repeat(120)}`,
    content: '正文'.repeat(3000),
    isDeleted: false
  }))
  const assistant = createAiAssistant({
    settingsPath: path.join(directory, 'ai-settings.json'),
    encryptSecret: (value) => `encrypted:${value}`,
    decryptSecret: (value) => value.slice('encrypted:'.length),
    repository: {
      searchNotes: () => notes,
      getNoteForEditing: (noteId) => notes.find((note) => note.id === noteId)
    },
    request: async (_url, options) => {
      requestBody = JSON.parse(options.body)
      return {
        ok: true,
        status: 200,
        json: async () => ({ choices: [{ message: { content: '结论。[S1]' } }] })
      }
    }
  })
  await assistant.saveSettings({ baseUrl: 'https://api.example.com/v1', model: 'demo', apiKey: 'secret' })
  await assistant.ask({ question: '超长主题分析', scope: 'all' })

  const noteContext = requestBody.messages[1].content.split('笔记资料：\n')[1]
  assert.ok(noteContext.length <= 24000)
})

test('模型漏标来源时仍给答案，并标记 citationMissing', async (context) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'xinyue-ai-citation-'))
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const note = { id: 'note-1', title: '来源', content: '可验证内容', isDeleted: false }
  const assistant = createAiAssistant({
    settingsPath: path.join(directory, 'ai-settings.json'),
    encryptSecret: (value) => `encrypted:${value}`,
    decryptSecret: (value) => value.slice('encrypted:'.length),
    repository: { getNoteForEditing: () => note },
    request: async () => ({
      ok: true,
      status: 200,
      json: async () => ({ choices: [{ message: { content: '没有引用的回答' } }] })
    })
  })
  await assistant.saveSettings({ baseUrl: 'https://api.example.com/v1', model: 'demo', apiKey: 'secret' })

  // 用户已经等了几十秒，模型偶尔漏标不该整轮丢弃：照常给答案 + 标记，
  // 来源退回本次检索到的笔记，让界面能提示「未标注来源」。
  const result = await assistant.ask({ question: '分析来源', scope: 'current', noteId: note.id })
  assert.equal(result.answer, '没有引用的回答')
  assert.equal(result.citationMissing, true)
  assert.deepEqual(result.sources.map((source) => source.noteId), ['note-1'])
})

test('追问把最近几轮问答拼进 messages，并剥掉历史里的引用标记', async (context) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'xinyue-ai-history-'))
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const requestedBodies = []
  const note = { id: 'note-1', title: '并发', content: '线程池适合 IO 密集任务。', isDeleted: false }
  const assistant = createAiAssistant({
    settingsPath: path.join(directory, 'ai-settings.json'),
    encryptSecret: (value) => `encrypted:${value}`,
    decryptSecret: (value) => value.slice('encrypted:'.length),
    repository: { getNoteForEditing: () => note },
    request: async (_url, options) => {
      requestedBodies.push(JSON.parse(options.body))
      return {
        ok: true,
        status: 200,
        json: async () => ({ choices: [{ message: { content: '回答。[S1]' } }] })
      }
    }
  })
  await assistant.saveSettings({ baseUrl: 'https://api.example.com/v1', model: 'demo', apiKey: 'secret' })

  await assistant.ask({
    question: '那第二条呢',
    scope: 'current',
    noteId: note.id,
    history: [
      { question: '第一个问题', answer: '线程池适合 IO 密集任务。[S1]' },
      { question: '第二个问题', answer: '第二个回答' }
    ]
  })

  const messages = requestedBodies[0].messages
  assert.deepEqual(messages.map((message) => message.role), ['system', 'user', 'assistant', 'user', 'assistant', 'user'])
  assert.equal(messages[1].content, '第一个问题')
  // 历史里的 [S1] 指向的是上一轮自己的来源编号，带进来会让模型误引当前资料。
  assert.equal(messages[2].content, '线程池适合 IO 密集任务。')
  assert.equal(messages[3].content, '第二个问题')
  assert.match(messages[5].content, /问题：那第二条呢/)
})

test('历史只保留最近 6 轮，更早的轮次直接丢弃', async (context) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'xinyue-ai-history-cap-'))
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  let requestBody = null
  const note = { id: 'note-1', title: '并发', content: '线程池。', isDeleted: false }
  const assistant = createAiAssistant({
    settingsPath: path.join(directory, 'ai-settings.json'),
    encryptSecret: (value) => `encrypted:${value}`,
    decryptSecret: (value) => value.slice('encrypted:'.length),
    repository: { getNoteForEditing: () => note },
    request: async (_url, options) => {
      requestBody = JSON.parse(options.body)
      return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: '回答。[S1]' } }] }) }
    }
  })
  await assistant.saveSettings({ baseUrl: 'https://api.example.com/v1', model: 'demo', apiKey: 'secret' })

  const history = Array.from({ length: 8 }, (_, index) => ({
    question: `问题 ${index + 1}`,
    answer: `回答 ${index + 1}`
  }))
  await assistant.ask({ question: '继续', scope: 'current', noteId: note.id, history })

  const questions = requestBody.messages
    .filter((message) => message.role === 'user')
    .map((message) => message.content)
  // 6 轮历史 + 当前问题 = 7 条 user，最早的「问题 1」「问题 2」应被丢掉。
  assert.equal(questions.length, 7)
  assert.equal(questions[0], '问题 3')
  assert.equal(questions.at(-1).includes('问题：继续'), true)
})

/** 造一个 SSE 响应对象；`chunks` 会按顺序 enqueue，用来验证跨 chunk 的半帧。 */
function createSseResponse(chunks) {
  const encoder = new TextEncoder()
  return {
    ok: true,
    status: 200,
    headers: {
      get: (name) => (String(name).toLowerCase() === 'content-type' ? 'text/event-stream' : null)
    },
    body: new ReadableStream({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(encoder.encode(chunk))
        controller.close()
      }
    })
  }
}

test('流式回答按 SSE 增量回调，被拆开的半帧也能拼回来', async (context) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'xinyue-ai-stream-'))
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const note = { id: 'note-1', title: '并发', content: '线程池适合 IO 密集任务。', isDeleted: false }
  const deltas = []
  const assistant = createAiAssistant({
    settingsPath: path.join(directory, 'ai-settings.json'),
    encryptSecret: (value) => `encrypted:${value}`,
    decryptSecret: (value) => value.slice('encrypted:'.length),
    repository: { getNoteForEditing: () => note },
    request: async () => createSseResponse([
      'data: {"choices":[{"delta":{"content":"线程"}}]}\n\n',
      // 同一帧被切进两个 chunk（切点落在中文串中间）：不能当成坏帧丢掉。
      'data: {"choices":[{"delta":{"content":"池适',
      '合 IO 密集任务"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"。[S1]"}}]}\n\n',
      'data: [DONE]\n\n'
    ])
  })
  await assistant.saveSettings({ baseUrl: 'https://api.example.com/v1', model: 'demo', apiKey: 'secret' })

  const result = await assistant.askStream(
    { question: '并发', scope: 'current', noteId: note.id },
    (delta) => deltas.push(delta)
  )

  assert.deepEqual(deltas, ['线程', '池适合 IO 密集任务', '。[S1]'])
  assert.equal(result.answer, '线程池适合 IO 密集任务。[S1]')
  assert.deepEqual(result.sources.map((source) => source.noteId), ['note-1'])
})

test('接口不支持流式时退回整段回答，仍会回调一次 onDelta', async (context) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'xinyue-ai-stream-fallback-'))
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const note = { id: 'note-1', title: '并发', content: '线程池。', isDeleted: false }
  const deltas = []
  const assistant = createAiAssistant({
    settingsPath: path.join(directory, 'ai-settings.json'),
    encryptSecret: (value) => `encrypted:${value}`,
    decryptSecret: (value) => value.slice('encrypted:'.length),
    repository: { getNoteForEditing: () => note },
    request: async () => ({
      ok: true,
      status: 200,
      headers: { get: () => 'application/json' },
      json: async () => ({ choices: [{ message: { content: '整段回答。[S1]' } }] })
    })
  })
  await assistant.saveSettings({ baseUrl: 'https://api.example.com/v1', model: 'demo', apiKey: 'secret' })

  const result = await assistant.askStream(
    { question: '并发', scope: 'current', noteId: note.id },
    (delta) => deltas.push(delta)
  )

  assert.deepEqual(deltas, ['整段回答。[S1]'])
  assert.equal(result.answer, '整段回答。[S1]')
})

test('流式接口返回 HTTP 错误时把服务端说明抛给界面', async (context) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'xinyue-ai-stream-error-'))
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const note = { id: 'note-1', title: '并发', content: '线程池。', isDeleted: false }
  const assistant = createAiAssistant({
    settingsPath: path.join(directory, 'ai-settings.json'),
    encryptSecret: (value) => `encrypted:${value}`,
    decryptSecret: (value) => value.slice('encrypted:'.length),
    repository: { getNoteForEditing: () => note },
    request: async () => ({
      ok: false,
      status: 401,
      headers: { get: () => 'application/json' },
      json: async () => ({ error: { message: 'Invalid API key' } })
    })
  })
  await assistant.saveSettings({ baseUrl: 'https://api.example.com/v1', model: 'demo', apiKey: 'secret' })

  await assert.rejects(
    assistant.askStream({ question: '并发', scope: 'current', noteId: note.id }, () => {}),
    /Invalid API key/
  )
})

test('AI 助手通过独立 IPC 和懒加载面板接入工作区', () => {
  const projectRoot = path.resolve(__dirname, '..')
  const ipcSource = fs.readFileSync(path.join(projectRoot, 'electron/ipc-handlers.cjs'), 'utf8')
  const preloadSource = fs.readFileSync(path.join(projectRoot, 'electron/preload.cjs'), 'utf8')
  const appSource = fs.readFileSync(path.join(projectRoot, 'src/App.vue'), 'utf8')
  const panelSource = fs.readFileSync(path.join(projectRoot, 'src/components/AiAssistantPanel.vue'), 'utf8')

  assert.match(ipcSource, /ai-assistant:settings:get/)
  assert.match(ipcSource, /ai-assistant:settings:save/)
  assert.match(ipcSource, /ai-assistant:ask/)
  // 流式通道：主进程按 requestId 回推增量，渲染层不直接接触 ipcRenderer。
  assert.match(ipcSource, /ai-assistant:ask-stream/)
  assert.match(ipcSource, /ai-assistant:delta/)
  assert.match(preloadSource, /getAiAssistantSettings/)
  assert.match(preloadSource, /askAiAssistant/)
  assert.match(preloadSource, /onAiAssistantDelta/)
  assert.match(appSource, /defineAsyncComponent\(\(\) => import\('\.\/components\/AiAssistantPanel\.vue'\)\)/)
  assert.match(appSource, /@open-source="openAiAssistantSource"/)
  assert.match(panelSource, /askAiAssistantStream/)
  // 先把自己的消息钉进会话，再等回答。
  assert.match(panelSource, /turns\.value\.push\(turn\)/)
  const titlebarSource = appSource.slice(appSource.indexOf('<header class="titlebar">'), appSource.indexOf('</header>'))
  const editorMetaSource = appSource.slice(appSource.indexOf('<div class="editor-meta">'), appSource.indexOf('<div class="editor-body">'))
  assert.match(titlebarSource, /aria-label="AI 笔记助手"/)
  assert.doesNotMatch(editorMetaSource, /aria-label="AI 笔记助手"/)
  assert.match(panelSource, /当前笔记/)
  assert.match(panelSource, /当前文件夹/)
  assert.match(panelSource, /全部笔记/)
  assert.match(panelSource, /只发送检索命中的有限文本片段/)
  assert.match(panelSource, /scope\.value = props\.currentNoteId \? 'current' : 'all'/)
  // 追问要把最近几轮带上去；漏标来源时界面要能提示而不是装作没事。
  assert.match(panelSource, /history/)
  assert.match(panelSource, /citationMissing/)
})

test('历史对话：IPC、preload、类型与面板四处接线一致', () => {
  const projectRoot = path.resolve(__dirname, '..')
  const read = (relativePath) => fs.readFileSync(path.join(projectRoot, relativePath), 'utf8')
  const ipcSource = read('electron/ipc-handlers.cjs')
  const preloadSource = read('electron/preload.cjs')
  const mainSource = read('electron/main.cjs')
  const typesSource = read('src/types.ts')
  const panelSource = read('src/components/AiAssistantPanel.vue')

  // 通道名两侧必须逐字一致，改名只改一处就会静默失效。
  for (const channel of ['list', 'get', 'append-turn', 'replace-turn', 'rename', 'pin', 'delete', 'clear']) {
    assert.match(ipcSource, new RegExp(`ai-conversation:${channel}`))
  }
  for (const method of [
    'listAiConversations',
    'getAiConversation',
    'appendAiConversationTurn',
    'deleteAiConversation',
    'clearAiConversations'
  ]) {
    assert.match(preloadSource, new RegExp(method))
    assert.match(typesSource, new RegExp(method))
  }
  // 会话读写走 repository 的现取调用，切换档案后才会落到新库。
  assert.match(mainSource, /aiConversation: \{/)
  assert.match(mainSource, /list: \(options\) => repository\.listAiConversations\(options \|\| \{\}\)/)
  // 改名与置顶：通道 → 域方法 → 仓库方法，三段都要在。
  assert.match(mainSource, /rename: \(conversationId, title\) => repository\.renameAiConversation/)
  assert.match(mainSource, /setPinned: \(conversationId, pinned\) => repository\.setAiConversationPinned/)
  assert.match(preloadSource, /renameAiConversation/)
  assert.match(preloadSource, /setAiConversationPinned/)
  assert.match(typesSource, /renameAiConversation/)
  assert.match(typesSource, /setAiConversationPinned/)
  // 置顶要能影响排序与清理，两个字段都得从库里读出来。
  assert.match(typesSource, /pinned: boolean/)
  assert.match(panelSource, /listAiConversations\(\{ keyword: keyword \|\| undefined \}\)/)
  assert.match(panelSource, /@input="scheduleSearch"/)

  // 会话归属笔记：面板把当前笔记带进落库，类型里必须能读回标题；
  // 续接只在空白会话上发生，否则会打断正在进行的对话或吞掉刚选中的片段。
  assert.match(panelSource, /noteId: props\.currentNoteId/)
  assert.match(typesSource, /noteId: string \| null/)
  assert.match(typesSource, /noteTitle: string \| null/)
  assert.match(panelSource, /async function tryResumeConversation/)
  assert.match(panelSource, /if \(conversationId\.value \|\| turns\.value\.length \|\| loading\.value\) return/)
  assert.match(panelSource, /if \(props\.selectionText\) return/)
  // 历史项从 button 换成了带 role 的 div，键盘入口不能丢。
  assert.match(panelSource, /class="ai-history-item"\s+role="button"/)
  assert.match(panelSource, /@keydown\.enter\.prevent="openConversation\(item\)"/)

  // 「＋」不再是破坏性清空：旧对话上一轮答完就落库了，这里只负责开一条新的。
  assert.match(panelSource, /function startNewConversation/)
  assert.doesNotMatch(panelSource, /function resetConversation/)
  // 答完才落库，并把真实会话 ID 回填给后续轮次。
  // 答完才落库；重新生成走的是改写原来那一行（见 `persistTurn` 里的 dbTurnId 分支）。
  assert.match(panelSource, /await persistTurn\(target\)/)
  assert.match(panelSource, /if \(turn\.dbTurnId\) \{/)
  assert.match(panelSource, /if \(saved\?\.conversationId\) conversationId\.value = saved\.conversationId/)
  // 恢复出来的轮次不参与流式匹配，requestId 必须留空。
  assert.match(panelSource, /requestId: ''/)
  // sources 要逐字段复制：Vue 的响应式 Proxy 过不了 IPC 的结构化克隆。
  assert.match(panelSource, /noteId: source\.noteId/)
  // 流式进行中不允许开新对话，否则这一轮还没落库就被清掉了。
  assert.match(panelSource, /:disabled="loading"/)
  // 历史删了进不了回收站，清空必须两段确认，不能一次点击全清。
  assert.match(panelSource, /if \(!confirmClearHistory\.value\) \{/)

  // 设置与历史是同一块覆盖层上的两块，必须互斥：只切 settingsOpen 不关历史时，
  // 设置会整块躲在历史页后面（层级更低），看着像点了没反应。
  assert.match(panelSource, /function toggleSettings\(\)/)
  assert.match(panelSource, /if \(next\) historyOpen\.value = false/)
  assert.match(panelSource, /@click="toggleSettings"/)
  assert.doesNotMatch(panelSource, /@click="settingsOpen = !settingsOpen"/)
  // 交叉淡出时新开的那块要在上面。
  const settingsZ = Number(panelSource.match(/\.ai-settings-sheet \{[^}]*z-index: (\d+)/)[1])
  const historyZ = Number(panelSource.match(/\.ai-history-sheet \{[^}]*z-index: (\d+)/)[1])
  assert.ok(settingsZ > historyZ, `设置覆盖层层级应高于历史：${settingsZ} vs ${historyZ}`)
})


test('停止生成会中止主进程那条请求，重复中止只返回 false', async (context) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'xinyue-ai-abort-'))
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const note = { id: 'note-1', title: '并发', content: '线程池适合 IO 密集任务。', isDeleted: false }
  let signalRequestStarted
  const requestStarted = new Promise((resolve) => { signalRequestStarted = resolve })
  const assistant = createAiAssistant({
    settingsPath: path.join(directory, 'ai-settings.json'),
    encryptSecret: (value) => `encrypted:${value}`,
    decryptSecret: (value) => value.slice('encrypted:'.length),
    repository: { getNoteForEditing: () => note },
    // 永不返回：只认 signal，模拟「模型还在慢慢吐字」。
    request: (_url, options) => new Promise((_resolve, reject) => {
      const abort = () => reject(Object.assign(new Error('The operation was aborted.'), { name: 'AbortError' }))
      if (options.signal?.aborted) {
        abort()
        return
      }
      options.signal?.addEventListener('abort', abort, { once: true })
      signalRequestStarted()
    })
  })
  await assistant.saveSettings({ baseUrl: 'https://api.example.com/v1', model: 'demo', apiKey: 'secret' })

  const pending = assistant.askStream(
    { question: '并发', scope: 'current', noteId: note.id, requestId: 'req-1' },
    () => assert.fail('停止之后不该再回调增量')
  )
  // 先挂一个处理函数，避免拒绝比断言先到导致 unhandled rejection 告警。
  pending.catch(() => {})
  await requestStarted

  assert.equal(assistant.abortStream('req-1'), true)
  await assert.rejects(pending, (error) => error.name === 'AbortError')
  // 已经摘掉了：再停一次只是「没这条」，不能抛错。
  assert.equal(assistant.abortStream('req-1'), false)
})

test('「当前笔记」范围把单篇预算放宽到 16000 字，超出才标 truncated', async (context) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'xinyue-ai-budget-'))
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const shortNote = '字'.repeat(10000)
  const longNote = '字'.repeat(20000)
  let content = shortNote
  let captured = ''
  const assistant = createAiAssistant({
    settingsPath: path.join(directory, 'ai-settings.json'),
    encryptSecret: (value) => `encrypted:${value}`,
    decryptSecret: (value) => value.slice('encrypted:'.length),
    repository: {
      getNoteForEditing: () => ({ id: 'note-1', title: '长笔记', content, isDeleted: false })
    },
    request: async (_url, options) => {
      captured = JSON.parse(options.body).messages.at(-1).content
      return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: '答[S1]' } }] }) }
    }
  })
  await assistant.saveSettings({ baseUrl: 'https://api.example.com/v1', model: 'demo', apiKey: 'secret' })

  // 一万字：旧口径（每篇 4000）会砍掉大半，现在必须整篇进去。
  const full = await assistant.ask({ question: '总结', scope: 'current', noteId: 'note-1' })
  assert.equal(full.sources[0].truncated, false)
  assert.ok(captured.includes(shortNote))

  // 两万字：超出 16000 才截断，并且要如实标记。
  content = longNote
  const cut = await assistant.ask({ question: '总结', scope: 'current', noteId: 'note-1' })
  assert.equal(cut.sources[0].truncated, true)
  assert.ok(captured.includes(shortNote))
  assert.equal(captured.includes(longNote), false)
})

test('停止生成 / 重新生成的通道与界面接线都在', () => {
  const projectRoot = path.resolve(__dirname, '..')
  const read = (relative) => fs.readFileSync(path.join(projectRoot, relative), 'utf8')
  const mainSource = read('electron/main.cjs')
  const ipcSource = read('electron/ipc-handlers.cjs')
  const preloadSource = read('electron/preload.cjs')
  const typesSource = read('src/types.ts')
  const panelSource = read('src/components/AiAssistantPanel.vue')
  const assistantSource = read('electron/ai-assistant.cjs')

  // 主进程：abort 要真的把 signal 交给 fetch，不能只丢增量。
  assert.match(assistantSource, /const activeStreams = new Map\(\)/)
  assert.match(assistantSource, /controller\.abort\(\)/)
  assert.match(assistantSource, /signal\s*\n?\s*\}\)/)
  assert.match(ipcSource, /ai-assistant:abort/)
  assert.match(preloadSource, /abortAiAssistantStream/)
  assert.match(typesSource, /abortAiAssistantStream\(requestId: string\)/)

  // 界面：停止时把 requestId 记进集合，才能和真错误分开。
  assert.match(panelSource, /const stoppedRequests = new Set/)
  assert.match(panelSource, /async function stopGenerating/)
  assert.match(panelSource, /stoppedRequests\.has\(turn\.requestId\)/)
  assert.match(panelSource, /target\.stopped = true/)

  // 重新生成：只对最后一轮开放，并改写库里原来那一行。
  assert.match(panelSource, /async function regenerateTurn/)
  assert.match(panelSource, /function isLastTurn/)
  assert.match(panelSource, /isLastTurn\(turn\) && !loading/)
  assert.match(panelSource, /replaceAiConversationTurn/)
  assert.match(mainSource, /replaceTurn: \(input\) => repository\.replaceAiConversationTurn\(input\)/)
  assert.match(ipcSource, /ai-conversation:replace-turn/)
})

test('选区问 AI：选中的那段编成 S1 排在最前，召回结果跟在后面', async (context) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'xinyue-ai-selection-'))
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const note = {
    id: 'note-1',
    folderId: 'folder-1',
    title: 'Python 并发',
    content: '# 并发\n\n线程池适合 IO 密集任务。\n\n每请求一线程会线性吃内存。',
    isDeleted: false
  }
  let prompt = ''
  const assistant = createAiAssistant({
    settingsPath: path.join(directory, 'ai-settings.json'),
    encryptSecret: (value) => `encrypted:${value}`,
    decryptSecret: (value) => value.slice('encrypted:'.length),
    repository: {
      getNoteForEditing: (noteId) => (noteId === note.id ? note : null),
      searchNotes: () => [{ id: note.id, folderId: 'folder-1', title: note.title }]
    },
    request: async (_url, options) => {
      prompt = JSON.parse(options.body).messages.at(-1).content
      return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: '这段在说线程池。[S1]' } }] }) }
    }
  })
  await assistant.saveSettings({ baseUrl: 'https://api.example.com/v1', model: 'demo', apiKey: 'secret' })

  const result = await assistant.ask({
    question: '这段在说什么',
    scope: 'current',
    noteId: note.id,
    selection: '每请求一线程会线性吃内存。'
  })

  // S1 必须是选区本身，标题一眼能看出这不是整篇笔记。
  assert.equal(result.sources[0].id, 'S1')
  assert.equal(result.sources[0].title, '选中片段')
  // noteId 保留下来，点 [S1] 才能跳回当前这篇。
  assert.equal(result.sources[0].noteId, note.id)
  assert.equal(result.sources[0].truncated, false)
  // 选区那段必须排在整篇笔记前面（资料以 `[S1] 选中片段` 开头）。
  assert.ok(prompt.includes('[S1] 选中片段\n每请求一线程会线性吃内存。'))
  assert.ok(
    prompt.indexOf('[S1] 选中片段') < prompt.indexOf('[S2] Python 并发'),
    '选区应当排在召回结果前面'
  )
  // 召回结果（整篇笔记）跟着排在后面，给「这段和别处矛盾吗」这类问题留资料。
  assert.match(prompt, /\[S2\] Python 并发/)
})

test('选区本身也吃字符预算：超长只送前 8000 字并标 truncated', async (context) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'xinyue-ai-selection-budget-'))
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const assistant = createAiAssistant({
    settingsPath: path.join(directory, 'ai-settings.json'),
    encryptSecret: (value) => `encrypted:${value}`,
    decryptSecret: (value) => value.slice('encrypted:'.length),
    repository: { getNoteForEditing: () => null, searchNotes: () => [] },
    request: async () => ({ ok: true, status: 200, json: async () => ({ choices: [{ message: { content: '答。[S1]' } }] }) })
  })
  await assistant.saveSettings({ baseUrl: 'https://api.example.com/v1', model: 'demo', apiKey: 'secret' })

  // 全选一篇超长笔记也走这条路：选区再多，也不能把整个资料预算吃光。
  const result = await assistant.ask({ question: '总结', scope: 'all', selection: '字'.repeat(9000) })
  assert.equal(result.sources.length, 1)
  assert.equal(result.sources[0].truncated, true)
  assert.equal(result.sources[0].excerpt.length, 180)
})

test('选区问 AI 的接线：气泡按钮 → 编辑器事件 → 面板 chip → 请求参数', () => {
  const projectRoot = path.resolve(__dirname, '..')
  const read = (relative) => fs.readFileSync(path.join(projectRoot, relative), 'utf8')
  const editorSource = read('src/components/MarkdownVisualEditor.vue')
  const appSource = read('src/App.vue')
  const panelSource = read('src/components/AiAssistantPanel.vue')
  const typesSource = read('src/types.ts')
  const assistantSource = read('electron/ai-assistant.cjs')

  // 气泡按钮：挂进功能组，锚点 span 必须存在（CSS 与 e2e 都靠它定位）。
  assert.match(editorSource, /xynote-ask-ai-trigger/)
  assert.match(editorSource, /builder\.getGroup\('function'\)\.addItem\('xynote-ask-ai'/)
  assert.match(editorSource, /onRun: \(runCtx\) => askSelectionWithAi\(runCtx\.get\(editorViewCtx\)\)/)
  // 选区必须从 ProseMirror state 读，不能用 window.getSelection()（气泡是 body 上的 portal）。
  assert.match(editorSource, /view\.state\.doc\.textBetween\(from, to/)
  assert.doesNotMatch(editorSource, /function askSelectionWithAi[\s\S]{0,600}window\.getSelection/)
  assert.match(editorSource, /\(event: 'ask-ai', text: string\): void/)

  // 上层：接住事件 → 存片段 → 开面板。
  assert.match(appSource, /@ask-ai="askAiWithSelection"/)
  assert.match(appSource, /const aiSelectionText = ref\(''\)/)
  assert.match(appSource, /:selection-text="aiSelectionText"/)
  assert.match(appSource, /@clear-selection="clearAiSelection"/)

  // 面板：chip 能显示能移除，提问时把片段带上。
  assert.match(panelSource, /selectionText: string/)
  assert.match(panelSource, /class="ai-selection-chip"/)
  assert.match(panelSource, /selection: props\.selectionText \|\| undefined/)
  assert.match(typesSource, /selection\?: string/)

  // 主进程：选区必须是第一条来源，并走独立预算。
  assert.match(assistantSource, /const SELECTION_SOURCE_TITLE = '选中片段'/)
  assert.match(assistantSource, /isSelection: true/)
  assert.match(assistantSource, /note\.isSelection \? MAX_SELECTION_CHARACTERS : perNoteLimit/)
})

test('回答落地的接线：面板按钮 → 事件 → App 调编辑器插入 / 建新笔记', () => {
  const projectRoot = path.resolve(__dirname, '..')
  const read = (relative) => fs.readFileSync(path.join(projectRoot, relative), 'utf8')
  const panelSource = read('src/components/AiAssistantPanel.vue')
  const visualEditor = read('src/components/MarkdownVisualEditor.vue')
  const sourceEditor = read('src/components/MarkdownSourceEditor.vue')
  const appSource = read('src/App.vue')

  // 面板：两个动作按钮必须挂在同一组里（单按钮各写 margin-left:auto 会把它们推散）。
  assert.match(panelSource, /class="ai-bubble-actions"/)
  assert.match(panelSource, /@click="insertTurnIntoNote\(turn\)"/)
  assert.match(panelSource, /@click="saveTurnAsNote\(turn\)"/)
  assert.match(panelSource, /insertAnswer: \[payload: \{ markdown: string \}\]/)
  assert.match(panelSource, /saveAnswerAsNote: \[payload: \{ markdown: string, title: string \}\]/)
  // 没有可插入目标时必须真的置灰，而不是点了没反应。
  assert.match(panelSource, /:disabled="!canInsertAnswer \|\| transferringTurnId === turn\.id"/)
  assert.match(panelSource, /buildAiAnswerNoteMarkdown\(turn\.answer, turn\.sources\)/)

  // 正文编辑器：必须走 Markdown 解析，不能退化成纯文本插入（否则列表/代码块会变成一坨字）。
  assert.match(visualEditor, /defineExpose\(\{[^}]*insertMarkdown[^}]*\}\)/)
  assert.match(visualEditor, /function insertMarkdown[\s\S]{0,900}?markdownToSlice\(text\)\(context\)/)
  assert.match(visualEditor, /replaceSelection\(markdownToSlice\(text\)\(context\)\)/)
  // 光标停在段落中间要先断开，否则插入的整块内容会黏在前半句后面。
  assert.match(visualEditor, /\$from\.parent\.isTextblock && \$from\.parentOffset > 0/)
  assert.match(visualEditor, /transaction = transaction\.split\(from\)/)
  // 预览层盖在编辑器上：插入前得先回编辑态，否则插进去了看不见。
  assert.match(visualEditor, /function insertMarkdown[\s\S]{0,600}?if \(previewMode\.value\) togglePreview\(\)/)

  // 外部文件：保真优先，只做 CodeMirror 文本插入，不做任何自动排版。
  assert.match(sourceEditor, /defineExpose\(\{[^}]*insertMarkdown[^}]*\}\)/)
  assert.match(sourceEditor, /changes: \{ from: position, insert: text \}/)
  assert.match(sourceEditor, /function insertMarkdown[\s\S]{0,800}?if \(mode\.value === 'preview'\) switchMode\('source'\)/)

  // 上层：接线到两个真实动作，插入目标按「编辑器在不在」判断而不是按笔记 ID。
  assert.match(appSource, /@insert-answer="insertAiAnswerIntoNote"/)
  assert.match(appSource, /@save-answer-as-note="saveAiAnswerAsNote"/)
  assert.match(appSource, /:can-insert-answer="Boolean\(activeNote \|\| activeFileDoc\)"/)
  assert.match(appSource, /insertMarkdown: \(markdown: string\) => Promise<\{ ok: boolean, message: string \}> \| \{ ok: boolean, message: string \}/)
  // 存为新笔记：createNote 只能给文件夹，标题与正文必须再 updateNote 一次。
  assert.match(appSource, /async function saveAiAnswerAsNote[\s\S]{0,700}?updateNote\(created\.id, \{[\s\S]{0,120}?content: payload\.markdown/)
})
