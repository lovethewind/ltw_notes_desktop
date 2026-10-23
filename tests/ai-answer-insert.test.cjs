const test = require('node:test')
const assert = require('node:assert/strict')
const { pathToFileURL } = require('node:url')
const { resolve } = require('node:path')

const projectRoot = resolve(__dirname, '..')

/**
 * AI 回答落地成笔记 Markdown 的真实行为测试。
 *
 * 这里是「落地」环节唯一的纯逻辑：正文怎么收尾、来源怎么附、标题怎么取。
 * 一旦拼错，用户拿到的是**已经写进笔记库的内容** —— 比界面上显示错更难发现，
 * 也更难回收（尤其是「存为新笔记」会直接多出一篇）。所以按真数据断言输出结构。
 */
let answerModule

test.before(async () => {
  answerModule = await import(pathToFileURL(resolve(projectRoot, 'src/utils/ai-answer-insert.ts')).href)
})

test('正文与来源之间用分隔线隔开，来源按 [S1] 的原始编号排列', () => {
  const markdown = answerModule.buildAiAnswerNoteMarkdown('结论是 A。\n\n理由是 B。', [
    { noteId: 'note-1', title: '架构评审' },
    { noteId: 'note-2', title: '周报' }
  ])
  assert.equal(
    markdown,
    [
      '结论是 A。',
      '',
      '理由是 B。',
      '',
      '---',
      '',
      '**参考来源**',
      '',
      '1. [架构评审](https://xinyue-note.local/note-1)',
      '2. [周报](https://xinyue-note.local/note-2)'
    ].join('\n')
  )
  // 来源用 `---` 而不是 `##` 标题：它不该进大纲跟正文抢层级。
  assert.ok(!markdown.includes('## 参考来源'))
})

test('没有来源时只落地正文，不留一个空壳小标题', () => {
  const markdown = answerModule.buildAiAnswerNoteMarkdown('全库都没相关笔记，下面是通用建议。', [])
  assert.equal(markdown, '全库都没相关笔记，下面是通用建议。')
  assert.ok(!markdown.includes('参考来源'))
})

test('正文为空（或只有流式终止标记）时不落地', () => {
  assert.equal(answerModule.buildAiAnswerNoteMarkdown('', [{ noteId: 'a', title: 'A' }]), '')
  assert.equal(answerModule.buildAiAnswerNoteMarkdown('   \n  ', []), '')
  assert.equal(answerModule.buildAiAnswerNoteMarkdown('[DONE]', []), '')
})

test('正文中残留的 [DONE] 会被剥掉', () => {
  assert.equal(answerModule.buildAiAnswerNoteMarkdown('最终答案。\n\n[DONE]', []), '最终答案。')
})

test('同一篇笔记被命中两次只列一次，编号仍与正文里的 [Sn] 对齐', () => {
  const markdown = answerModule.buildAiAnswerNoteMarkdown('见 [S1] 与 [S3]。', [
    { noteId: 'note-1', title: '第一篇' },
    { noteId: 'note-1', title: '第一篇（重复命中）' },
    { noteId: 'note-3', title: '第三篇' }
  ])
  // 第二条被跳过，但第三条仍编号 3 —— 否则正文里的 [S3] 会指到第 2 条上。
  assert.match(markdown, /^1\. \[第一篇\]/m)
  assert.ok(!markdown.includes('重复命中'))
  assert.match(markdown, /^3\. \[第三篇\]/m)
})

test('标题里的方括号会被转义，不会提前闭合链接语法', () => {
  const markdown = answerModule.buildAiAnswerNoteMarkdown('正文', [
    { noteId: 'note-9', title: '[草稿] 想法' }
  ])
  assert.match(markdown, /\[\\\[草稿\\\] 想法\]\(https:\/\/xinyue-note\.local\/note-9\)/)
})

test('缺 noteId 的来源直接跳过，不生成空链接', () => {
  const markdown = answerModule.buildAiAnswerNoteMarkdown('正文', [
    { noteId: '', title: '没 ID' },
    { noteId: 'note-2', title: '有 ID' }
  ])
  assert.ok(!markdown.includes('没 ID'))
  assert.match(markdown, /\[有 ID\]\(https:\/\/xinyue-note\.local\/note-2\)/)
})

test('新笔记标题取问题前 30 字，压平空白', () => {
  assert.equal(answerModule.deriveAiAnswerNoteTitle('怎么  优化\n这条 SQL？'), '怎么 优化 这条 SQL？')
  assert.equal(
    answerModule.deriveAiAnswerNoteTitle('一'.repeat(50)),
    '一'.repeat(30)
  )
  // 空问题退回固定标题，不能生成一篇无标题笔记。
  assert.equal(answerModule.deriveAiAnswerNoteTitle('   '), 'AI 回答')
  assert.equal(answerModule.deriveAiAnswerNoteTitle(''), 'AI 回答')
})

test('标题按码点截断，emoji 不会被切成半个代理对', () => {
  const title = answerModule.deriveAiAnswerNoteTitle('🎉'.repeat(40))
  assert.equal(title, '🎉'.repeat(30))
  assert.equal(Array.from(title).length, 30)
})
