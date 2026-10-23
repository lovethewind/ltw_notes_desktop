/**
 * AI 对话历史的落库行为。
 *
 * 只测数据库层：会话怎么建、轮次怎么排、上限怎么裁。
 * 界面恢复（气泡还原、`[S1]` chip）在 e2e 里验。
 */
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const Database = require('better-sqlite3')
const { openNotesDatabase } = require('../electron/database.cjs')

/** 在隔离临时目录中执行数据库测试；`directory` 用于需要直连库文件的白盒用例。 */
function withRepository(run) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ltw-notes-ai-conversation-'))
  const repository = openNotesDatabase(directory)
  try {
    run(repository, directory)
  } finally {
    repository.close()
    fs.rmSync(directory, { recursive: true, force: true })
  }
}

/**
 * 等到下一个毫秒再继续。
 *
 * `updated_at` 只有毫秒精度，同一毫秒内的两次写入会打平、排序退化成 rowid；
 * 这里等一下，让「后来的会话排前面」这个断言测的是真正的时间语义。
 */
function tick() {
  const until = Date.now() + 2
  while (Date.now() < until) { /* 空转 */ }
}

test('追加第一轮时按需建会话，标题取问题前 30 字', () => {
  withRepository((repository) => {
    assert.deepEqual(repository.listAiConversations(), [])

    const saved = repository.appendAiConversationTurn({
      question: '线程池和每请求一线程该怎么选',
      answer: 'IO 密集用线程池。[S1]',
      sources: [{ id: 'S1', noteId: 'note-1', title: '并发方案', excerpt: '线程池适合 IO 密集任务。' }]
    })
    assert.ok(saved?.conversationId)
    assert.ok(saved?.turnId)

    const list = repository.listAiConversations()
    assert.equal(list.length, 1)
    assert.equal(list[0].id, saved.conversationId)
    assert.equal(list[0].title, '线程池和每请求一线程该怎么选')
    assert.equal(list[0].turnCount, 1)
  })
})

test('超长问题压成一行并把标题截断', () => {
  withRepository((repository) => {
    const question = `第一行问题\n\n${'很长的补充说明'.repeat(10)}`
    const saved = repository.appendAiConversationTurn({ question, answer: '答。' })
    const [item] = repository.listAiConversations()
    assert.equal(item.id, saved.conversationId)
    assert.equal(item.title.length, 31)
    assert.ok(item.title.endsWith('…'))
    // 换行不能带进标题，否则列表里会撑成两行。
    assert.ok(!item.title.includes('\n'))
  })
})

test('同一会话里的轮次按追加顺序读回，来源与漏标标记一起保留', () => {
  withRepository((repository) => {
    const first = repository.appendAiConversationTurn({
      question: '第一个问题',
      answer: '第一段回答。[S1]',
      sources: [{ id: 'S1', noteId: 'note-1', title: '并发方案', excerpt: '片段一' }]
    })
    repository.appendAiConversationTurn({
      conversationId: first.conversationId,
      question: '那第二条呢',
      answer: '第二段回答。',
      citationMissing: true
    })

    const conversation = repository.getAiConversation(first.conversationId)
    assert.equal(conversation.turns.length, 2)
    assert.deepEqual(conversation.turns.map((turn) => turn.question), ['第一个问题', '那第二条呢'])
    assert.deepEqual(conversation.turns[0].sources, [
      { id: 'S1', noteId: 'note-1', title: '并发方案', excerpt: '片段一', truncated: false }
    ])
    assert.equal(conversation.turns[0].citationMissing, false)
    // 漏标来源的那条要能区分出来，恢复后仍要提示「本条未标注来源」。
    assert.equal(conversation.turns[1].citationMissing, true)
    assert.deepEqual(conversation.turns[1].sources, [])
  })
})

test('问题或回答为空时不落库，避免历史里出现空壳会话', () => {
  withRepository((repository) => {
    assert.equal(repository.appendAiConversationTurn({ question: '   ', answer: '答。' }), null)
    assert.equal(repository.appendAiConversationTurn({ question: '问？', answer: '  ' }), null)
    assert.deepEqual(repository.listAiConversations(), [])
  })
})

test('传入不存在的会话 ID 时另起一条，而不是把轮次挂到空处', () => {
  withRepository((repository) => {
    const saved = repository.appendAiConversationTurn({
      conversationId: 'does-not-exist',
      question: '问？',
      answer: '答。'
    })
    assert.ok(saved.conversationId)
    assert.notEqual(saved.conversationId, 'does-not-exist')
    assert.equal(repository.getAiConversation('does-not-exist'), null)
    assert.equal(repository.listAiConversations().length, 1)
  })
})

test('会话按最近更新排序，最新的一条在最前', () => {
  withRepository((repository) => {
    const older = repository.appendAiConversationTurn({ question: '早一点的问题', answer: '答。' })
    tick()
    const newer = repository.appendAiConversationTurn({ question: '后来的问题', answer: '答。' })
    tick()
    // 给旧会话再追加一轮，它应当重新排到最前。
    repository.appendAiConversationTurn({
      conversationId: older.conversationId,
      question: '继续追问',
      answer: '答。'
    })

    const list = repository.listAiConversations()
    assert.equal(list.length, 2)
    assert.equal(list[0].id, older.conversationId)
    assert.equal(list[0].turnCount, 2)
    assert.equal(list[1].id, newer.conversationId)
  })
})

test('删除会话会连带删掉它的轮次', () => {
  withRepository((repository) => {
    const saved = repository.appendAiConversationTurn({ question: '问？', answer: '答。' })
    assert.equal(repository.deleteAiConversation(saved.conversationId), true)
    assert.equal(repository.getAiConversation(saved.conversationId), null)
    assert.deepEqual(repository.listAiConversations(), [])
    // 删过的 ID 再删一次不算成功，避免界面误报「已删除」。
    assert.equal(repository.deleteAiConversation(saved.conversationId), false)
  })
})

test('清空历史返回删除条数并把话题全部清掉', () => {
  withRepository((repository) => {
    repository.appendAiConversationTurn({ question: '问题一', answer: '答。' })
    repository.appendAiConversationTurn({ question: '问题二', answer: '答。' })
    assert.equal(repository.clearAiConversations(), 2)
    assert.deepEqual(repository.listAiConversations(), [])
    // 清空后再问，历史能正常重新长出来。
    repository.appendAiConversationTurn({ question: '问题三', answer: '答。' })
    assert.equal(repository.listAiConversations().length, 1)
  })
})

test('会话超过 50 条时只留最近的 50 条', () => {
  withRepository((repository) => {
    const ids = []
    for (let index = 0; index < 55; index += 1) {
      const saved = repository.appendAiConversationTurn({
        question: `第 ${index} 个问题`,
        answer: `第 ${index} 个回答`
      })
      ids.push(saved.conversationId)
      // 同毫秒内按 updated_at 排序会打平，靠 id 兜底；这里只需要条数正确。
    }
    const list = repository.listAiConversations()
    assert.equal(list.length, 50)
    // 最新的那条一定还在，最早建的五条被裁掉。
    assert.ok(list.some((item) => item.id === ids[ids.length - 1]))
    assert.ok(!list.some((item) => item.id === ids[0]))
  })
})

test('保留策略写死为 50 条 / 30 天，裁剪只在新建会话时发生', () => {
  const source = fs.readFileSync(
    path.join(__dirname, '../electron/database.cjs'),
    'utf8'
  )
  assert.match(source, /const AI_CONVERSATION_LIMIT = 50/)
  assert.match(source, /const AI_CONVERSATION_MAX_AGE_DAYS = 30/)
  // 30 天靠 updated_at 比较，不能写成 created_at（继续追问的旧会话不该被清掉）。
  assert.match(source, /DELETE FROM ai_conversations WHERE updated_at < \?/)
  // 置顶的会话必须从时间线清理里豁免，否则「钉住」是假的。
  assert.match(source, /DELETE FROM ai_conversations WHERE updated_at < \? AND pinned = 0/)
  // 裁剪必须挂在「新建会话」分支里，否则每追加一轮都扫全表。
  assert.match(source, /pruneAiConversations\(\)[\s\S]{0,80}?const position/)
})

test('会话表不生成 outbox 记录：历史不参与同步', () => {
  const source = fs.readFileSync(
    path.join(__dirname, '../electron/database.cjs'),
    'utf8'
  )
  const start = source.indexOf('function listAiConversations')
  const end = source.indexOf('function clearAiConversations')
  assert.ok(start > 0 && end > start)
  const section = source.slice(start, end)
  assert.ok(!section.includes('outbox'))
  assert.ok(!section.includes('dirty'))
})

test('重新生成改写原来那一轮，不会在历史里多出一条同样的提问', () => {
  withRepository((repository) => {
    const saved = repository.appendAiConversationTurn({ question: '线程池怎么配', answer: '旧答案' })
    const replaced = repository.replaceAiConversationTurn({
      turnId: saved.turnId,
      answer: '新答案',
      sources: [{ id: 'S1', noteId: 'note-1', title: '并发方案', excerpt: '线程池…', truncated: true }]
    })

    assert.equal(replaced, true)
    const conversation = repository.getAiConversation(saved.conversationId)
    assert.equal(conversation.turns.length, 1)
    assert.equal(conversation.turns[0].question, '线程池怎么配')
    assert.equal(conversation.turns[0].answer, '新答案')
    // truncated 要跟着存：长笔记的提示在恢复历史后也得在。
    assert.equal(conversation.turns[0].sources[0].truncated, true)
  })
})

test('重写不存在的轮次或空答案一律返回 false', () => {
  withRepository((repository) => {
    const saved = repository.appendAiConversationTurn({ question: '问', answer: '答' })
    assert.equal(repository.replaceAiConversationTurn({ turnId: 'missing', answer: '答' }), false)
    assert.equal(repository.replaceAiConversationTurn({ turnId: saved.turnId, answer: '   ' }), false)
    assert.equal(repository.replaceAiConversationTurn({ turnId: '', answer: '答' }), false)
  })
})

test('改名只动标题，不把旧对话顶到列表最前', () => {
  withRepository((repository) => {
    const older = repository.appendAiConversationTurn({ question: '早一点的问题', answer: '答。' })
    tick()
    const newer = repository.appendAiConversationTurn({ question: '后来的问题', answer: '答。' })
    tick()
    assert.equal(repository.listAiConversations()[0].id, newer.conversationId)

    // 换行与多余空格要压平：列表项是单行标题。
    assert.equal(repository.renameAiConversation(older.conversationId, '  改名后 \n 的标题  '), true)
    const list = repository.listAiConversations()
    // 改名不该刷新 updated_at，否则刚整理好的顺序会被一次改名打乱。
    assert.equal(list[0].id, newer.conversationId)
    assert.equal(list[1].title, '改名后 的标题')
    assert.equal(repository.getAiConversation(older.conversationId).title, '改名后 的标题')
  })
})

test('改名拒绝空标题与不存在的会话', () => {
  withRepository((repository) => {
    const saved = repository.appendAiConversationTurn({ question: '问？', answer: '答。' })
    assert.equal(repository.renameAiConversation(saved.conversationId, '   '), false)
    assert.equal(repository.renameAiConversation('missing', '新名字'), false)
    assert.equal(repository.renameAiConversation('', '新名字'), false)
    // 拒绝之后原标题不能被改坏。
    assert.equal(repository.listAiConversations()[0].title, '问？')
  })
})

test('置顶的会话排在最前，取消置顶后回到时间序', () => {
  withRepository((repository) => {
    const older = repository.appendAiConversationTurn({ question: '早一点的问题', answer: '答。' })
    tick()
    const newer = repository.appendAiConversationTurn({ question: '后来的问题', answer: '答。' })
    assert.equal(repository.listAiConversations()[0].id, newer.conversationId)

    assert.equal(repository.setAiConversationPinned(older.conversationId, true), true)
    let list = repository.listAiConversations()
    assert.equal(list[0].id, older.conversationId)
    assert.equal(list[0].pinned, true)
    assert.equal(list[1].pinned, false)
    // 完整会话读回来也要带 pinned，界面靠它决定图钉的高亮。
    assert.equal(repository.getAiConversation(older.conversationId).pinned, true)

    assert.equal(repository.setAiConversationPinned(older.conversationId, false), true)
    list = repository.listAiConversations()
    assert.equal(list[0].id, newer.conversationId)
    assert.equal(list[0].pinned, false)
  })
})

test('置顶不存在的会话返回 false', () => {
  withRepository((repository) => {
    assert.equal(repository.setAiConversationPinned('missing', true), false)
    assert.equal(repository.setAiConversationPinned('', true), false)
  })
})

test('搜索命中标题或任意一轮的提问，通配字符按字面处理', () => {
  withRepository((repository) => {
    const first = repository.appendAiConversationTurn({ question: '线程池怎么配', answer: '答。' })
    // 关键词只出现在第二轮提问里：标题只截了第一个问题，靠标题搜不到。
    repository.appendAiConversationTurn({
      conversationId: first.conversationId,
      question: '那 100% 命中率的情况呢',
      answer: '答。'
    })
    const other = repository.appendAiConversationTurn({ question: '完全无关的话题', answer: '答。' })

    const idsOf = (keyword) => repository.listAiConversations({ keyword }).map((item) => item.id)
    assert.deepEqual(idsOf('线程'), [first.conversationId])
    assert.deepEqual(idsOf('命中率'), [first.conversationId])
    // `%` 和 `_` 必须转义成字面量，否则会变成通配符匹配到别的行。
    assert.deepEqual(idsOf('100%'), [first.conversationId])
    assert.deepEqual(idsOf('线_池'), [])
    // 空白关键词等于不过滤，两条都在。
    assert.deepEqual(idsOf('   ').sort(), [first.conversationId, other.conversationId].sort())
    assert.deepEqual(idsOf('搜不到的词'), [])
    // 搜索只过滤，不改条数与顺序。
    assert.equal(repository.listAiConversations({}).length, 2)
  })
})

test('会话记下归属笔记，标题以 notes 表为准而非存快照', () => {
  withRepository((repository) => {
    const note = repository.createNote(null)
    repository.updateNote(note.id, { title: '并发方案' })
    repository.appendAiConversationTurn({
      question: '线程池怎么配',
      answer: '答。',
      noteId: note.id
    })

    const [item] = repository.listAiConversations({})
    assert.equal(item.noteId, note.id)
    assert.equal(item.noteTitle, '并发方案')

    // 笔记改名后历史里跟着变：存快照的话这里会停在旧名字。
    repository.updateNote(note.id, { title: '并发方案（改）' })
    assert.equal(repository.listAiConversations({})[0].noteTitle, '并发方案（改）')
  })
})

test('追问不改变会话归属：中途切到别的笔记，仍记在开始时那篇', () => {
  withRepository((repository) => {
    const first = repository.createNote(null)
    const second = repository.createNote(null)
    const saved = repository.appendAiConversationTurn({
      question: '第一问',
      answer: '答。',
      noteId: first.id
    })
    // 已有 conversationId 时 noteId 必须被忽略，否则一条对话的归属会随追问漂移。
    repository.appendAiConversationTurn({
      conversationId: saved.conversationId,
      question: '切到另一篇之后接着问',
      answer: '答。',
      noteId: second.id
    })

    const list = repository.listAiConversations({})
    assert.equal(list.length, 1)
    assert.equal(list[0].noteId, first.id)
  })
})

test('按 noteId 过滤只留归属该笔记的会话，不带归属的老会话不混进来', () => {
  withRepository((repository) => {
    const first = repository.createNote(null)
    const second = repository.createNote(null)
    repository.appendAiConversationTurn({ question: '问一', answer: '答。', noteId: first.id })
    tick()
    repository.appendAiConversationTurn({ question: '问二', answer: '答。', noteId: second.id })
    tick()
    // 没有选区、也没有打开笔记时问的：归属为空，任何按笔记过滤都查不到它。
    repository.appendAiConversationTurn({ question: '问三', answer: '答。' })

    const scoped = repository.listAiConversations({ noteId: first.id })
    assert.equal(scoped.length, 1)
    assert.equal(scoped[0].noteId, first.id)
    assert.equal(repository.listAiConversations({ noteId: 'missing-note' }).length, 0)
    assert.equal(repository.listAiConversations({}).length, 3)
  })
})

test('归属笔记被删或进回收站时标题置空，会话本身留着', () => {
  withRepository((repository) => {
    const note = repository.createNote(null)
    repository.appendAiConversationTurn({ question: '问', answer: '答。', noteId: note.id })
    assert.ok(repository.listAiConversations({})[0].noteTitle)

    // 软删除 = 进了回收站：跳过去只会打开回收站条目，按「已删除」处理。
    repository.setNoteDeleted(note.id, true)
    const trashed = repository.listAiConversations({})[0]
    assert.equal(trashed.noteTitle, null)
    // 归属 ID 仍然记着，只是没有可跳的目标，界面据此显示「笔记已删除」。
    assert.equal(trashed.noteId, note.id)

    // 彻底删掉：问过的对话不该被一篇笔记的删除带走。
    repository.deleteNotePermanently(note.id)
    const survivors = repository.listAiConversations({})
    assert.equal(survivors.length, 1)
    assert.equal(survivors[0].noteTitle, null)
    assert.equal(repository.getAiConversation(survivors[0].id).noteTitle, null)
  })
})

test('老库缺 note_id / pinned 列时自动补齐，已有会话照常读得出来', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ltw-notes-ai-legacy-'))
  const legacy = new Database(path.join(directory, 'notes.sqlite3'))
  // 手搓一张「上一版」的表：只有 id / title / 两个时间戳。
  legacy.exec(`
    CREATE TABLE ai_conversations (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL DEFAULT '新对话',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE ai_conversation_turns (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL,
      position INTEGER NOT NULL,
      question TEXT NOT NULL,
      answer TEXT NOT NULL,
      sources_json TEXT NOT NULL DEFAULT '[]',
      citation_missing INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    );
  `)
  const timestamp = '2026-10-01T00:00:00.000Z'
  legacy.prepare(
    'INSERT INTO ai_conversations(id, title, created_at, updated_at) VALUES (?, ?, ?, ?)'
  ).run('legacy-1', '旧对话', timestamp, timestamp)
  legacy.close()

  const repository = openNotesDatabase(directory)
  try {
    const [item] = repository.listAiConversations({})
    assert.equal(item.id, 'legacy-1')
    // 迁移补上的两列：置顶默认 0，归属为空 —— 老会话不会因此从历史里消失。
    assert.equal(item.pinned, false)
    assert.equal(item.noteId, null)
    assert.equal(item.noteTitle, null)
  } finally {
    repository.close()
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

test('置顶的会话不受 30 天清理影响，没置顶的照常被清', () => {
  withRepository((repository, directory) => {
    const pinnedOne = repository.appendAiConversationTurn({ question: '置顶的老对话', answer: '答。' })
    const plainOne = repository.appendAiConversationTurn({ question: '普通的老对话', answer: '答。' })
    repository.setAiConversationPinned(pinnedOne.conversationId, true)

    // 白盒：把两条都改成 40 天前，模拟「放了很久没问」。
    const connection = new Database(path.join(directory, 'notes.sqlite3'))
    connection.pragma('busy_timeout = 2000')
    const old = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000).toISOString()
    connection.prepare('UPDATE ai_conversations SET updated_at = ?').run(old)
    connection.close()

    // 裁剪只在新建会话时发生，所以这里再问一句来触发。
    repository.appendAiConversationTurn({ question: '新问题', answer: '答。' })
    const ids = repository.listAiConversations().map((item) => item.id)
    assert.ok(ids.includes(pinnedOne.conversationId))
    assert.ok(!ids.includes(plainOne.conversationId))
  })
})

test('置顶会话不占普通会话的 50 条名额', () => {
  withRepository((repository) => {
    const pinnedOne = repository.appendAiConversationTurn({ question: '要钉住的问题', answer: '答。' })
    repository.setAiConversationPinned(pinnedOne.conversationId, true)
    for (let index = 0; index < 55; index += 1) {
      repository.appendAiConversationTurn({
        question: `第 ${index} 个问题`,
        answer: `第 ${index} 个回答`
      })
    }
    const list = repository.listAiConversations()
    assert.equal(list.length, 50)
    // 最早建的那条已经被裁掉，但它被钉住了，必须还在，且排在最前。
    assert.equal(list[0].id, pinnedOne.conversationId)
    assert.equal(list[0].pinned, true)
  })
})
