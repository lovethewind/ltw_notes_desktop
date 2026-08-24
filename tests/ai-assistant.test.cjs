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

test('模型未返回有效来源编号时拒绝展示无依据回答', async (context) => {
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

  await assert.rejects(
    assistant.ask({ question: '分析来源', scope: 'current', noteId: note.id }),
    /未提供有效来源引用/
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
  assert.match(preloadSource, /getAiAssistantSettings/)
  assert.match(preloadSource, /askAiAssistant/)
  assert.match(appSource, /defineAsyncComponent\(\(\) => import\('\.\/components\/AiAssistantPanel\.vue'\)\)/)
  assert.match(appSource, /@open-source="openAiAssistantSource"/)
  const titlebarSource = appSource.slice(appSource.indexOf('<header class="titlebar">'), appSource.indexOf('</header>'))
  const editorMetaSource = appSource.slice(appSource.indexOf('<div class="editor-meta">'), appSource.indexOf('<div class="editor-body">'))
  assert.match(titlebarSource, /aria-label="AI 笔记助手"/)
  assert.doesNotMatch(editorMetaSource, /aria-label="AI 笔记助手"/)
  assert.match(panelSource, /当前笔记/)
  assert.match(panelSource, /当前文件夹/)
  assert.match(panelSource, /全部笔记/)
  assert.match(panelSource, /只发送检索命中的有限文本片段/)
  assert.match(panelSource, /scope\.value = props\.currentNoteId \? 'current' : 'all'/)
})
