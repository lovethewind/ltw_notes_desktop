const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const http = require('node:http')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')

const { _electron: electron } = require('playwright')

const projectRoot = path.resolve(__dirname, '../..')

/** 后台启动隔离的真实 Electron 应用，避免测试读写用户笔记和 AI 设置。 */
// 受限沙箱（如无 GUI 权限的容器）里 Chromium 子进程无法初始化自身 sandbox，主进程会以
// "GPU process isn't usable" 崩溃退出。需要时用该环境变量注入 --no-sandbox / --disable-gpu
// 一类的开关；不设置时行为与原来完全一致。
const extraLaunchArgs = (process.env.XINYUE_E2E_ELECTRON_ARGS || '').split(/\s+/).filter(Boolean)

async function launchApplication(userDataPath) {
  const electronApplication = await electron.launch({
    args: [...extraLaunchArgs, projectRoot],
    cwd: projectRoot,
    env: {
      ...process.env,
      NODE_ENV: 'test',
      XINYUE_NOTES_E2E_USER_DATA: userDataPath
    }
  })
  try {
    const page = await electronApplication.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    await page.waitForFunction(() => Boolean(window.notesDesktop))
    return { electronApplication, page }
  } catch (error) {
    await electronApplication.close().catch(() => {})
    throw error
  }
}

/**
 * 建笔记并把第一篇设为当前标签。
 *
 * 只把第一篇放进标签栏，其余留在库里 —— 这样「点来源跳到笔记」才是真的打开，
 * 而不是切到一个早就存在的标签。
 */
async function seedNotes(page, notes) {
  await page.evaluate(async (items) => {
    const created = []
    for (const item of items) {
      const note = await window.notesDesktop.createNote(null)
      await window.notesDesktop.updateNote(note.id, { title: item.title, content: item.content })
      created.push(note.id)
    }
    await window.notesDesktop.saveWorkspaceSession({
      tabs: [{ noteId: created[0], isPinned: false }],
      activeNoteId: created[0]
    })
  }, notes)
  await page.reload()
}

/** 未配置时设置面板会自动展开；已配置时从顶栏齿轮打开。 */
async function openAiSettings(panel) {
  if (await panel.getByLabel('接口地址').count() === 0) {
    await panel.getByRole('button', { name: '模型设置' }).click()
  }
}

async function saveAiSettings(panel, { baseUrl, model }) {
  await openAiSettings(panel)
  if (baseUrl) await panel.getByLabel('接口地址').fill(baseUrl)
  await panel.getByLabel('模型名称').fill(model)
  await panel.getByLabel('API Key').fill('test-key')
  await panel.getByRole('button', { name: '保存设置' }).click()
  await panel.getByLabel('接口地址').waitFor({ state: 'detached' })
}

/**
 * 启动一个 OpenAI 兼容的 mock 服务。
 *
 * 请求带 `stream: true` 时按 SSE 逐块吐字（每块 4 个字符、间隔 80ms），
 * 这样「先出现用户消息」「边写边显示」都能在测试里观察到，而不是一次性返回。
 */
function startMockModel(answers) {
  const requests = []
  const server = http.createServer((request, response) => {
    let raw = ''
    request.on('data', (chunk) => { raw += chunk })
    request.on('end', async () => {
      const body = JSON.parse(raw || '{}')
      requests.push(body)
      const answer = answers[Math.min(requests.length - 1, answers.length - 1)]
      if (!body.stream) {
        response.setHeader('content-type', 'application/json')
        response.end(JSON.stringify({ choices: [{ message: { content: answer } }] }))
        return
      }
      response.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive'
      })
      // 客户端「停止生成」会直接掐断连接：不接 error 事件会让测试进程吃到 EPIPE。
      response.on('error', () => {})
      for (const chunk of answer.match(/[\s\S]{1,4}/g) || []) {
        if (response.destroyed) return
        response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: chunk } }] })}\n\n`)
        await new Promise((resolve) => setTimeout(resolve, 80))
      }
      response.write('data: [DONE]\n\n')
      response.end()
    })
  })
  return {
    requests,
    listen: async () => {
      await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
      return server.address().port
    },
    close: () => new Promise((resolve) => {
      server.closeAllConnections?.()
      server.close(resolve)
    })
  }
}

test('AI 面板是对话式布局：空态引导、底部输入框、范围切换与模型设置', { timeout: 60_000 }, async () => {
  const userDataPath = await fs.mkdtemp(path.join(os.tmpdir(), 'xinyue-notes-ai-e2e-'))
  let application

  try {
    application = await launchApplication(userDataPath)
    await seedNotes(application.page, [{ title: '并发方案', content: '线程池适合 IO 密集任务。' }])

    await application.page.getByRole('button', { name: 'AI 笔记助手' }).click()
    const panel = application.page.getByRole('complementary', { name: 'AI 笔记助手' })
    await panel.waitFor()
    // 空态：先告诉用户能问什么，而不是甩一张表单。
    assert.match(await panel.innerText(), /有什么想从笔记里找的/)
    assert.equal(await panel.locator('.ai-suggestions button').count(), 3)
    assert.equal(await panel.getByRole('button', { name: '发送' }).isDisabled(), true)
    // 范围仍是三段，但收成输入框上方的一行 chip。
    assert.match(await panel.innerText(), /当前笔记/)
    assert.match(await panel.innerText(), /当前文件夹/)
    assert.match(await panel.innerText(), /全部笔记/)
    assert.equal(await panel.getByRole('button', { name: '当前笔记' }).getAttribute('aria-pressed'), 'true')
    assert.equal(await panel.getByText('并发方案').count(), 1)
    // 隐私口径必须写在输入框旁边。
    assert.match(await panel.innerText(), /只发送检索命中的有限文本片段/)

    await saveAiSettings(panel, { model: 'test-model' })
    await panel.getByText('test-model').first().waitFor()
    assert.equal(await panel.getByText(/An object could not be cloned/).count(), 0)

    await panel.getByRole('button', { name: '关闭 AI 助手' }).click()
    await panel.waitFor({ state: 'detached' })
  } finally {
    if (application) await application.electronApplication.close().catch(() => {})
    await fs.rm(userDataPath, { recursive: true, force: true })
  }
})

test('AI 回答按 Markdown 渲染、清理不安全 HTML，[S1] 可直接跳到来源笔记', { timeout: 60_000 }, async () => {
  const userDataPath = await fs.mkdtemp(path.join(os.tmpdir(), 'xinyue-notes-ai-markdown-e2e-'))
  const model = startMockModel(['**关键结论**\n\n- 第一项\n- 第二项\n\n<script>window.__unsafeAi = true</script> [S1]'])
  const port = await model.listen()
  let application

  try {
    application = await launchApplication(userDataPath)
    await seedNotes(application.page, [
      { title: 'Markdown 来源', content: '用于生成回答的正文。' },
      { title: '引用目标', content: '引用目标笔记里有并发方案。' }
    ])
    await application.page.getByRole('button', { name: 'AI 笔记助手' }).click()
    const panel = application.page.getByRole('complementary', { name: 'AI 笔记助手' })
    await saveAiSettings(panel, { baseUrl: `http://127.0.0.1:${port}`, model: 'markdown-test' })

    // 换成全库范围，让召回落到没有打开的那篇笔记上 —— 只有这样跳转才可验证。
    await panel.getByRole('button', { name: '全部笔记' }).click()
    await panel.getByLabel('你想从笔记中了解什么？').fill('引用目标')
    await panel.getByRole('button', { name: '发送' }).click()

    // 1) 自己发的内容先出现，不等回答回来。
    const userBubble = panel.locator('.ai-bubble--user').first()
    await userBubble.waitFor({ timeout: 3000 })
    assert.match(await userBubble.innerText(), /引用目标/)

    // 2) 回答是流式长出来的：中途能看到「半截 + 正在写」的状态。
    await panel.waitForFunction(() => {
      const element = document.querySelector('.ai-answer-text.is-streaming')
      return Boolean(element && element.textContent.trim().length > 0)
    }, null, { timeout: 5000 })
    await panel.waitForFunction(
      () => !document.querySelector('.ai-answer-text.is-streaming'),
      null,
      { timeout: 15_000 }
    )

    const renderedAnswer = panel.locator('.ai-answer-text')
    await renderedAnswer.getByText('关键结论').waitFor()
    assert.equal(await renderedAnswer.locator('strong').innerText(), '关键结论')
    assert.equal(await renderedAnswer.locator('li').count(), 2)
    assert.equal(await renderedAnswer.locator('script').count(), 0)
    assert.equal(await application.page.evaluate(() => window.__unsafeAi), undefined)

    // [S1] 在正文里是可点 chip，而不是死文本。
    const citation = renderedAnswer.locator('a[href="#ai-source-S1"]')
    await citation.waitFor()
    assert.equal((await citation.innerText()).trim(), 'S1')
    await citation.click()
    await application.page.waitForFunction(() =>
      document.querySelector('.title-input')?.value === '引用目标')
  } finally {
    if (application) await application.electronApplication.close().catch(() => {})
    await model.close()
    await fs.rm(userDataPath, { recursive: true, force: true })
  }
})

test('AI 追问会把上一轮问答带给模型，界面上保留两轮气泡', { timeout: 60_000 }, async () => {
  const userDataPath = await fs.mkdtemp(path.join(os.tmpdir(), 'xinyue-notes-ai-history-e2e-'))
  const model = startMockModel(['线程池适合 IO 密集任务。[S1]', '第二条是事件循环。[S1]'])
  const port = await model.listen()
  let application

  try {
    application = await launchApplication(userDataPath)
    await seedNotes(application.page, [{ title: '并发方案', content: '线程池适合 IO 密集任务。' }])
    await application.page.getByRole('button', { name: 'AI 笔记助手' }).click()
    const panel = application.page.getByRole('complementary', { name: 'AI 笔记助手' })
    await saveAiSettings(panel, { baseUrl: `http://127.0.0.1:${port}`, model: 'history-test' })

    const input = panel.getByLabel('你想从笔记中了解什么？')
    await input.fill('第一个问题：并发方案是什么')
    await panel.getByRole('button', { name: '发送' }).click()
    // 第一轮必须写完再追问，否则历史里拿不到已完成的回答。
    await panel.waitForFunction(() => (
      document.querySelectorAll('.ai-answer-text').length === 1
      && !document.querySelector('.ai-answer-text.is-streaming')
    ), null, { timeout: 15_000 })

    await input.fill('那第二条呢')
    await panel.getByRole('button', { name: '发送' }).click()
    await panel.waitForFunction(() => (
      document.querySelectorAll('.ai-answer-text').length === 2
      && !document.querySelector('.ai-answer-text.is-streaming')
    ), null, { timeout: 15_000 })

    // 第二次请求必须带上第一轮的问答，否则「那第二条呢」根本无从理解。
    const secondRequest = model.requests[1]
    const roles = secondRequest.messages.map((message) => message.role)
    assert.deepEqual(roles, ['system', 'user', 'assistant', 'user'])
    assert.match(secondRequest.messages[1].content, /第一个问题/)
    // 历史回答里的引用标记要剥掉，避免模型把上一轮的编号当成当前资料。
    assert.doesNotMatch(secondRequest.messages[2].content, /\[S1\]/)
    assert.match(secondRequest.messages[3].content, /问题：那第二条呢/)

    assert.equal(await panel.locator('.ai-bubble--user').count(), 2)
    assert.match(await panel.locator('.ai-bubble--user').nth(1).innerText(), /那第二条呢/)
  } finally {
    if (application) await application.electronApplication.close().catch(() => {})
    await model.close()
    await fs.rm(userDataPath, { recursive: true, force: true })
  }
})

test('没有打开笔记时顶部 AI 入口仍可用并默认全部笔记', { timeout: 60_000 }, async () => {
  const userDataPath = await fs.mkdtemp(path.join(os.tmpdir(), 'xinyue-notes-ai-empty-e2e-'))
  let application

  try {
    application = await launchApplication(userDataPath)
    const aiButton = application.page.locator('.titlebar').getByRole('button', { name: 'AI 笔记助手' })
    await aiButton.click()
    const panel = application.page.getByRole('complementary', { name: 'AI 笔记助手' })
    await panel.waitFor()
    assert.equal(await panel.getByRole('button', { name: '全部笔记' }).getAttribute('aria-pressed'), 'true')
    assert.equal(await application.page.locator('.editor-meta').count(), 0)
  } finally {
    if (application) await application.electronApplication.close().catch(() => {})
    await fs.rm(userDataPath, { recursive: true, force: true })
  }
})

test('答完的对话进历史：新对话不删旧记录，重启后还能找回', { timeout: 120_000 }, async () => {
  const userDataPath = await fs.mkdtemp(path.join(os.tmpdir(), 'xinyue-notes-ai-history-store-e2e-'))
  const model = startMockModel(['线程池适合 IO 密集任务。[S1]'])
  const port = await model.listen()
  let application

  try {
    application = await launchApplication(userDataPath)
    await seedNotes(application.page, [{ title: '并发方案', content: '线程池适合 IO 密集任务。' }])
    await application.page.getByRole('button', { name: 'AI 笔记助手' }).click()
    let panel = application.page.getByRole('complementary', { name: 'AI 笔记助手' })
    await saveAiSettings(panel, { baseUrl: `http://127.0.0.1:${port}`, model: 'history-store' })

    await panel.getByLabel('你想从笔记中了解什么？').fill('线程池适合什么任务')
    await panel.getByRole('button', { name: '发送' }).click()
    await panel.waitForFunction(() => (
      document.querySelectorAll('.ai-answer-text').length === 1
      && !document.querySelector('.ai-answer-text.is-streaming')
    ), null, { timeout: 15_000 })

    // 「＋」现在是「新开一条」，不是「删掉当前这条」。
    await panel.getByRole('button', { name: '新对话' }).click()
    await panel.waitForFunction(() => (
      document.querySelectorAll('.ai-bubble--user').length === 0
    ), null, { timeout: 5000 })

    await panel.getByRole('button', { name: '历史对话' }).click()
    const sheet = panel.getByRole('region', { name: '历史对话' })
    await sheet.waitFor()
    const items = sheet.locator('.ai-history-item')
    await items.first().waitFor({ timeout: 5000 })
    assert.equal(await items.count(), 1)
    // 标题取第一句问题，副标带「N 轮」。
    assert.match(await items.first().innerText(), /线程池适合什么任务/)
    assert.match(await items.first().innerText(), /1 轮/)

    // 历史页里点设置：设置必须浮到前面，而不是整块躲在历史页后面。
    await panel.getByRole('button', { name: '模型设置' }).click()
    const settingsSheet = panel.locator('.ai-settings-sheet')
    await settingsSheet.waitFor({ timeout: 5000 })
    await sheet.waitFor({ state: 'detached' })
    // 命中测试：面板中间那一点必须落在设置表单里，才算真的在前台。
    assert.equal(
      await application.page.evaluate(() => {
        const box = document.querySelector('.ai-settings-sheet').getBoundingClientRect()
        const hit = document.elementFromPoint(box.x + box.width / 2, box.y + 120)
        return Boolean(hit && hit.closest('.ai-settings-sheet'))
      }),
      true
    )
    // 页脚按钮压到 30px / 12px：再大就比输入框还抢眼了。
    const settingsFoot = await settingsSheet.locator('.ai-settings-foot button').first().evaluate((el) => {
      const box = el.getBoundingClientRect()
      return { height: Math.round(box.height), fontSize: getComputedStyle(el).fontSize }
    })
    assert.ok(settingsFoot.height <= 30, `设置页脚按钮应压到 30px：${settingsFoot.height}`)
    assert.equal(settingsFoot.fontSize, '12px')

    // 关掉设置，回到历史继续验证恢复。
    await panel.getByRole('button', { name: '模型设置' }).click()
    await settingsSheet.waitFor({ state: 'detached' })
    await panel.getByRole('button', { name: '历史对话' }).click()
    await sheet.locator('.ai-history-item').first().waitFor({ timeout: 5000 })
    const historyFoot = await sheet.locator('.ai-history-foot button').first().evaluate((el) => {
      const box = el.getBoundingClientRect()
      return { height: Math.round(box.height), fontSize: getComputedStyle(el).fontSize }
    })
    assert.ok(historyFoot.height <= 30, `历史页脚按钮应压到 30px：${historyFoot.height}`)
    assert.equal(historyFoot.fontSize, '12px')

    // 点开恢复：气泡、来源、`[S1]` chip 都要回来。
    await items.first().click()
    await sheet.waitFor({ state: 'detached' })
    await panel.locator('.ai-bubble--user').first().waitFor({ timeout: 5000 })
    assert.match(await panel.locator('.ai-bubble--user').first().innerText(), /线程池适合什么任务/)
    await panel.locator('a[href="#ai-source-S1"]').first().waitFor({ timeout: 5000 })
    assert.equal(await panel.getByText('并发方案').count() > 0, true)

    // 关掉应用重开：历史必须还在（这正是「退出就没了」的反例）。
    await application.electronApplication.close()
    application = null
    application = await launchApplication(userDataPath)
    await application.page.getByRole('button', { name: 'AI 笔记助手' }).click()
    panel = application.page.getByRole('complementary', { name: 'AI 笔记助手' })
    await panel.getByRole('button', { name: '历史对话' }).click()
    const restoredSheet = panel.getByRole('region', { name: '历史对话' })
    await restoredSheet.locator('.ai-history-item').first().waitFor({ timeout: 5000 })
    assert.equal(await restoredSheet.locator('.ai-history-item').count(), 1)

    // 删掉之后列表干净，且当前对话一起让位。
    const restoredItem = restoredSheet.locator('.ai-history-item').first()
    await restoredItem.click()
    await panel.locator('.ai-bubble--user').first().waitFor({ timeout: 5000 })
    await panel.getByRole('button', { name: '历史对话' }).click()
    const deleteSheet = panel.getByRole('region', { name: '历史对话' })
    await deleteSheet.locator('.ai-history-item').first().waitFor()
    await deleteSheet.locator('li').first().hover()
    await deleteSheet.getByRole('button', { name: /删除对话/ }).first().click()
    await deleteSheet.locator('.ai-history-empty').waitFor({ timeout: 5000 })

    // 清空要两段确认：第一次点击只换按钮文案，数据还在。
    await panel.getByRole('button', { name: '历史对话' }).click()
    await deleteSheet.waitFor({ state: 'detached' })
    await panel.getByLabel('你想从笔记中了解什么？').fill('再问一句留个历史')
    await panel.getByRole('button', { name: '发送' }).click()
    await panel.waitForFunction(() => (
      document.querySelectorAll('.ai-answer-text').length === 1
      && !document.querySelector('.ai-answer-text.is-streaming')
    ), null, { timeout: 15_000 })

    await panel.getByRole('button', { name: '历史对话' }).click()
    const clearSheet = panel.getByRole('region', { name: '历史对话' })
    await clearSheet.locator('.ai-history-item').first().waitFor({ timeout: 5000 })
    await clearSheet.getByRole('button', { name: '清空全部历史' }).click()
    assert.equal(await clearSheet.locator('.ai-history-item').count(), 1)
    await clearSheet.getByRole('button', { name: '再点一次确认清空' }).click()
    await clearSheet.locator('.ai-history-empty').waitFor({ timeout: 5000 })
  } finally {
    if (application) await application.electronApplication.close().catch(() => {})
    await model.close()
    await fs.rm(userDataPath, { recursive: true, force: true })
  }
})


test('历史支持搜索、改名和置顶', { timeout: 120_000 }, async () => {
  const userDataPath = await fs.mkdtemp(path.join(os.tmpdir(), 'xinyue-notes-ai-history-ops-e2e-'))
  const model = startMockModel(['线程池适合 IO 密集任务。[S1]', '第二个话题的回答。'])
  const port = await model.listen()
  let application

  try {
    application = await launchApplication(userDataPath)
    const page = application.page
    await seedNotes(page, [{ title: '并发方案', content: '线程池适合 IO 密集任务。' }])
    await page.getByRole('button', { name: 'AI 笔记助手' }).click()
    const panel = page.getByRole('complementary', { name: 'AI 笔记助手' })
    await saveAiSettings(panel, { baseUrl: `http://127.0.0.1:${port}`, model: 'history-ops' })

    // 造两条历史：话题不同，后面才好判断排序到底是按时间还是按置顶。
    const ask = async (text, expectedAnswers) => {
      await panel.getByLabel('你想从笔记中了解什么？').fill(text)
      await panel.getByRole('button', { name: '发送' }).click()
      await page.waitForFunction((expected) => (
        document.querySelectorAll('.ai-answer-text').length === expected
        && !document.querySelector('.ai-answer-text.is-streaming')
      ), expectedAnswers, { timeout: 15_000 })
    }
    await ask('线程池适合什么任务', 1)
    await panel.getByRole('button', { name: '新对话' }).click()
    await page.waitForFunction(() => (
      document.querySelectorAll('.ai-bubble--user').length === 0
    ), null, { timeout: 5000 })
    await ask('另一个话题怎么理解', 1)

    await panel.getByRole('button', { name: '历史对话' }).click()
    const sheet = panel.getByRole('region', { name: '历史对话' })
    await sheet.locator('.ai-history-item').first().waitFor({ timeout: 5000 })
    assert.equal(await sheet.locator('.ai-history-item').count(), 2)

    // 搜索：关键词只出现在标题里，另一条被滤掉。
    await sheet.getByLabel('搜索历史对话').fill('线程池')
    await page.waitForFunction(() => (
      document.querySelectorAll('.ai-history-item').length === 1
    ), null, { timeout: 5000 })
    assert.match(await sheet.locator('.ai-history-item').first().innerText(), /线程池/)

    // 搜不到时给空态文案，而不是一片空白。
    await sheet.getByLabel('搜索历史对话').fill('搜不到的词')
    await sheet.locator('.ai-history-empty').waitFor({ timeout: 5000 })
    // 清除按钮把词清空，列表回到两条。
    await sheet.getByRole('button', { name: '清除搜索' }).click()
    await page.waitForFunction(() => (
      document.querySelectorAll('.ai-history-item').length === 2
    ), null, { timeout: 5000 })

    // 改名：悬停出按钮 → 行内输入 → 回车提交。
    const threadItem = sheet.locator('li', { hasText: '线程池' })
    await threadItem.hover()
    await threadItem.getByRole('button', { name: /重命名/ }).click()
    const renameInput = sheet.getByLabel('对话标题')
    await renameInput.waitFor({ timeout: 5000 })
    await renameInput.fill('改名后的线程池')
    await renameInput.press('Enter')
    await sheet.locator('.ai-history-item', { hasText: '改名后的线程池' }).waitFor({ timeout: 5000 })

    // 置顶：把不是最新的那条钉到最前。
    const renamedItem = sheet.locator('li', { hasText: '改名后的线程池' })
    await renamedItem.hover()
    await renamedItem.getByRole('button', { name: /^置顶：/ }).click()
    await page.waitForFunction(() => Boolean(document.querySelector('li.is-pinned')), null, { timeout: 5000 })
    assert.equal(await sheet.locator('li.is-pinned').count(), 1)
    assert.match(await sheet.locator('.ai-history-item').first().innerText(), /改名后的线程池/)

    // 取消置顶回到时间序：最新的那条（另一个话题）重新排第一。
    await sheet.locator('li.is-pinned').first().hover()
    await sheet.getByRole('button', { name: /^取消置顶：/ }).click()
    await page.waitForFunction(() => (
      document.querySelectorAll('li.is-pinned').length === 0
    ), null, { timeout: 5000 })
    assert.match(await sheet.locator('.ai-history-item').first().innerText(), /另一个话题/)
  } finally {
    if (application) await application.electronApplication.close().catch(() => {})
    await model.close()
    await fs.rm(userDataPath, { recursive: true, force: true })
  }
})


test('生成中可以停下来：保留半截、不落库；停完还能重新生成', { timeout: 120_000 }, async () => {
  const userDataPath = await fs.mkdtemp(path.join(os.tmpdir(), 'xinyue-notes-ai-stop-e2e-'))
  // 第一段特意长一点，停下来时才有「半截」可看。
  const longAnswer = '第一段很长的回答。[S1]'.repeat(12)
  const firstAnswer = '这一版先这样。[S1]'
  const secondAnswer = '换一版说法。[S1]'
  const model = startMockModel([longAnswer, firstAnswer, secondAnswer])
  let application

  try {
    const port = await model.listen()
    application = await launchApplication(userDataPath)
    await seedNotes(application.page, [{ title: '并发方案', content: '线程池适合 IO 密集任务。' }])

    await application.page.getByRole('button', { name: 'AI 笔记助手' }).click()
    const panel = application.page.getByRole('complementary', { name: 'AI 笔记助手' })
    await panel.waitFor()
    await saveAiSettings(panel, { baseUrl: `http://127.0.0.1:${port}`, model: 'test-model' })

    // ① 生成中能停：发送按钮变成「停止生成」。
    await panel.getByLabel('你想从笔记中了解什么？').fill('线程池适合什么任务')
    await panel.getByRole('button', { name: '发送' }).click()
    await panel.waitForFunction(() => {
      const element = document.querySelector('.ai-answer-text.is-streaming')
      return Boolean(element && element.textContent.trim().length > 10)
    }, null, { timeout: 15_000 })
    await panel.getByRole('button', { name: '停止生成' }).click()
    await panel.locator('.ai-turn-stopped').waitFor({ timeout: 10_000 })
    // 半截留着、光标收掉，且不能当成出错。
    assert.ok((await panel.locator('.ai-answer-text').last().innerText()).trim().length > 0)
    assert.equal(await panel.locator('.ai-answer-text.is-streaming').count(), 0)
    assert.equal(await panel.locator('.ai-turn-error').count(), 0)
    await panel.getByRole('button', { name: '发送' }).waitFor()
    assert.equal(await panel.locator('.ai-send--stop').count(), 0)

    // 停下的那一轮不进历史：下次打开历史应该是空的。
    await panel.getByRole('button', { name: '历史对话' }).click()
    const sheet = panel.getByRole('region', { name: '历史对话' })
    await sheet.locator('.ai-history-empty').waitFor({ timeout: 5000 })
    await panel.getByRole('button', { name: '历史对话' }).click()
    await sheet.waitFor({ state: 'detached' })

    // ② 正常答完一轮，再重新生成：气泡不增多，历史也只有 1 轮。
    await panel.getByLabel('你想从笔记中了解什么？').fill('那核心线程数配多少')
    await panel.getByRole('button', { name: '发送' }).click()
    await panel.waitForFunction(() => (
      document.querySelectorAll('.ai-answer-text').length === 2
      && !document.querySelector('.ai-answer-text.is-streaming')
    ), null, { timeout: 15_000 })
    assert.match(await panel.locator('.ai-answer-text').last().innerText(), /这一版先这样/)

    await panel.getByRole('button', { name: '重新生成' }).click()
    await panel.waitForFunction(() => {
      const elements = [...document.querySelectorAll('.ai-answer-text')]
      const last = elements[elements.length - 1]
      return Boolean(last && last.textContent.includes('换一版说法'))
    }, null, { timeout: 15_000 })
    // 重新生成不是重发问题：提问气泡仍是两个。
    assert.equal(await panel.locator('.ai-bubble--user').count(), 2)

    await panel.getByRole('button', { name: '历史对话' }).click()
    await sheet.locator('.ai-history-item').first().waitFor({ timeout: 5000 })
    // 改写原轮次而不是追加：1 条会话、1 轮。
    assert.equal(await sheet.locator('.ai-history-item').count(), 1)
    assert.match(await sheet.locator('.ai-history-item').first().innerText(), /1 轮/)
  } finally {
    if (application) await application.electronApplication.close().catch(() => {})
    await model.close()
    await fs.rm(userDataPath, { recursive: true, force: true })
  }
})

test('选中正文可以直接「问 AI」：片段带进面板并作为 S1 资料发送', { timeout: 120_000 }, async () => {
  const userDataPath = await fs.mkdtemp(path.join(os.tmpdir(), 'xinyue-notes-ai-selection-e2e-'))
  const model = startMockModel(['这段在讲线程池的线程数配置。[S1]'])
  const port = await model.listen()
  let application

  try {
    application = await launchApplication(userDataPath)
    const page = application.page
    await seedNotes(page, [
      { title: '并发方案', content: '线程池适合 IO 密集任务，核心线程数按 CPU 核数配置。' }
    ])

    // 先把模型配置好：后面从气泡进来时面板不该再被设置表单挡住。
    await page.getByRole('button', { name: 'AI 笔记助手' }).click()
    const panel = page.getByRole('complementary', { name: 'AI 笔记助手' })
    await panel.waitFor()
    await saveAiSettings(panel, { baseUrl: `http://127.0.0.1:${port}`, model: 'test-model' })
    await panel.getByRole('button', { name: '关闭 AI 助手' }).click()
    await panel.waitFor({ state: 'detached' })

    // 打开笔记，敲一段有辨识度的正文，再用方向键选中它。
    // ⚠️ 不能用 Meta+A：那是 ProseMirror 的 AllSelection，Crepe 气泡只认 TextSelection
    // （实测全选后 `[data-show]` 一直不出现，看着像按钮没接上）。
    const selectionText = '线程池适合 IO 密集任务，核心线程数按 CPU 核数配置。'
    const editor = page.locator('.milkdown-editor-root .ProseMirror').first()
    await editor.click()
    await page.keyboard.press('Meta+A')
    await page.keyboard.press('Backspace')
    await page.keyboard.type(selectionText)
    await page.waitForTimeout(400)
    for (let index = 0; index < selectionText.length; index += 1) {
      await page.keyboard.press('Shift+ArrowLeft')
    }
    await page.waitForSelector('.milkdown-toolbar[data-show="true"]', { timeout: 10_000 })

    // 气泡里的「问 AI」：Crepe 不给按钮自定义属性，只能靠图标里的标记 span 定位。
    await page.locator('.milkdown-toolbar .toolbar-item:has(.xynote-ask-ai-trigger)').click()

    await panel.waitFor({ timeout: 10_000 })
    const chip = panel.locator('.ai-selection-chip')
    await chip.waitFor({ timeout: 5000 })
    const chipText = await chip.innerText()
    assert.match(chipText, /选中片段/)
    assert.match(chipText, /线程池适合 IO 密集任务/)
    // 设置表单不该在从气泡进来时又弹出来（此时模型已配好）。
    assert.equal(await panel.getByLabel('接口地址').count(), 0)

    await panel.getByLabel('你想从笔记中了解什么？').fill('这段在说什么')
    await panel.getByRole('button', { name: '发送' }).click()
    await page.waitForFunction(() => (
      document.querySelectorAll('.ai-answer-text').length === 1
      && !document.querySelector('.ai-answer-text.is-streaming')
    ), null, { timeout: 20_000 })

    // 选区必须真的进了请求体，而且排成 S1。
    const prompt = model.requests.at(-1)?.messages?.at(-1)?.content || ''
    assert.match(prompt, /\[S1\] 选中片段/)
    assert.match(prompt, /线程池适合 IO 密集任务/)

    // chip 可移除：之后提问回到按范围召回。
    await panel.getByRole('button', { name: '移除选中片段' }).click()
    await chip.waitFor({ state: 'detached', timeout: 5000 })
  } finally {
    if (application) await application.electronApplication.close().catch(() => {})
    await model.close()
    await fs.rm(userDataPath, { recursive: true, force: true })
  }
})

test('回答可以插入当前笔记，也能直接存成新笔记', { timeout: 90_000 }, async () => {
  const userDataPath = await fs.mkdtemp(path.join(os.tmpdir(), 'xinyue-notes-ai-land-e2e-'))
  const model = startMockModel(['线程池适合 IO 密集任务，阻塞操作要拆开。[S1]'])
  const port = await model.listen()
  let application

  try {
    application = await launchApplication(userDataPath)
    const page = application.page
    // 自己建笔记是为了留住 id：最后要直接查库确认「插入」真的写进了正文。
    const noteId = await page.evaluate(async () => {
      const note = await window.notesDesktop.createNote(null)
      await window.notesDesktop.updateNote(note.id, {
        title: '并发方案',
        content: '并发方案的原始正文。'
      })
      await window.notesDesktop.saveWorkspaceSession({
        tabs: [{ noteId: note.id, isPinned: false }],
        activeNoteId: note.id
      })
      return note.id
    })
    await page.reload()
    await page.locator('.milkdown-editor-root .ProseMirror').waitFor()

    await page.getByRole('button', { name: 'AI 笔记助手' }).click()
    const panel = page.getByRole('complementary', { name: 'AI 笔记助手' })
    await saveAiSettings(panel, { baseUrl: `http://127.0.0.1:${port}`, model: 'land-test' })

    await panel.getByLabel('你想从笔记中了解什么？').fill('并发方案怎么讲')
    await panel.getByRole('button', { name: '发送' }).click()
    await page.waitForFunction(() => (
      document.querySelectorAll('.ai-answer-text').length === 1
      && !document.querySelector('.ai-answer-text.is-streaming')
    ), null, { timeout: 20_000 })

    // 动作按钮平时隐藏，悬停气泡才浮出（与复制、重新生成同一套）。
    const bubble = panel.locator('.ai-bubble--assistant').first()
    await bubble.hover()
    assert.equal(await panel.getByRole('button', { name: '插入到当前笔记' }).count(), 1)
    assert.equal(await panel.getByRole('button', { name: '存为新笔记' }).count(), 1)

    // 光标落进正文再插入：应变成真正的编辑器节点，而不是一坨纯文本。
    await page.locator('.milkdown-editor-root .ProseMirror').click()
    await panel.getByRole('button', { name: '插入到当前笔记' }).click()
    await page.waitForFunction(() => {
      const body = document.querySelector('.milkdown-editor-root .ProseMirror')
      return Boolean(body && body.textContent.includes('线程池适合 IO 密集任务'))
    }, null, { timeout: 5000 })
    const editorText = await page.locator('.milkdown-editor-root .ProseMirror').innerText()
    assert.match(editorText, /参考来源/)

    // 只断言 DOM 证明不了「真的写进去了」：轮询库里这篇笔记的正文（自动保存防抖 1.5s）。
    // ⚠️ 不要用 `waitForFunction` 的 async 断言：返回的 Promise 本身是 truthy，会立刻「通过」。
    let saved = null
    for (let attempt = 0; attempt < 20; attempt += 1) {
      saved = await page.evaluate((id) => window.notesDesktop.getNote(id), noteId)
      if (String(saved?.content || '').includes('参考来源')) break
      await page.waitForTimeout(300)
    }
    assert.match(String(saved?.content || ''), /线程池适合 IO 密集任务/)
    assert.match(saved.content, /参考来源/)
    assert.match(saved.content, /https:\/\/xinyue-note\.local\//)

    // 存为新笔记：标题取问题前 30 字，建完直接打开。
    await bubble.hover()
    await panel.getByRole('button', { name: '存为新笔记' }).click()
    await page.waitForFunction(
      () => document.querySelector('.title-input')?.value === '并发方案怎么讲',
      null,
      { timeout: 10_000 }
    )
    await page.waitForFunction(() => {
      const body = document.querySelector('.milkdown-editor-root .ProseMirror')
      return Boolean(body && body.textContent.includes('线程池适合 IO 密集任务'))
    }, null, { timeout: 5000 })
  } finally {
    if (application) await application.electronApplication.close().catch(() => {})
    await model.close()
    await fs.rm(userDataPath, { recursive: true, force: true })
  }
})

test('会话记得在哪篇笔记下问的：历史标出来源，重开时自动续接', { timeout: 150_000 }, async () => {
  const userDataPath = await fs.mkdtemp(path.join(os.tmpdir(), 'xinyue-notes-ai-scope-e2e-'))
  const model = startMockModel(['线程池适合 IO 密集任务。[S1]', '先灰度再全量。[S1]'])
  const port = await model.listen()
  let application

  try {
    application = await launchApplication(userDataPath)
    let page = application.page
    // 两篇都放上标签栏：后面要靠点标签在两篇之间来回切。
    await page.evaluate(async () => {
      const first = await window.notesDesktop.createNote(null)
      await window.notesDesktop.updateNote(first.id, {
        title: '并发方案',
        content: '线程池适合 IO 密集任务。'
      })
      const second = await window.notesDesktop.createNote(null)
      await window.notesDesktop.updateNote(second.id, {
        title: '部署清单',
        content: '灰度发布跑稳之后再全量。'
      })
      await window.notesDesktop.saveWorkspaceSession({
        tabs: [{ noteId: first.id, isPinned: false }, { noteId: second.id, isPinned: false }],
        activeNoteId: first.id
      })
    })
    await page.reload()
    await page.locator('.milkdown-editor-root .ProseMirror').waitFor()

    await page.getByRole('button', { name: 'AI 笔记助手' }).click()
    let panel = page.getByRole('complementary', { name: 'AI 笔记助手' })
    await panel.waitFor()
    await saveAiSettings(panel, { baseUrl: `http://127.0.0.1:${port}`, model: 'scope-test' })

    // ① 在《并发方案》里问一轮：这条对话归属 A。
    await panel.getByLabel('你想从笔记中了解什么？').fill('线程池适合什么任务')
    await panel.getByRole('button', { name: '发送' }).click()
    await page.waitForFunction(() => (
      document.querySelectorAll('.ai-answer-text').length === 1
      && !document.querySelector('.ai-answer-text.is-streaming')
    ), null, { timeout: 20_000 })

    // ② 切到《部署清单》，开新对话再问：新会话归属 B。
    await page.locator('.note-tab-main', { hasText: '部署清单' }).click()
    await page.waitForFunction(() => document.querySelector('.title-input')?.value === '部署清单')
    await panel.getByRole('button', { name: '新对话' }).click()
    await panel.getByLabel('你想从笔记中了解什么？').fill('部署顺序怎么排')
    await panel.getByRole('button', { name: '发送' }).click()
    await page.waitForFunction(() => (
      document.querySelectorAll('.ai-answer-text').length === 1
      && !document.querySelector('.ai-answer-text.is-streaming')
    ), null, { timeout: 20_000 })

    // ③ 历史里两条对话各自标出归属笔记。
    await panel.getByRole('button', { name: '历史对话' }).click()
    const sheet = panel.getByRole('region', { name: '历史对话' })
    await sheet.locator('.ai-history-item').first().waitFor({ timeout: 5000 })
    assert.equal(await sheet.locator('.ai-history-item').count(), 2)
    const sources = await sheet.locator('.ai-history-note').allInnerTexts()
    assert.deepEqual(sources.sort(), ['并发方案', '部署清单'].sort())

    // ④ 点来源标签跳回那篇笔记：历史层收起，标题切过去。
    const threadRow = sheet.locator('li', { hasText: '线程池适合什么任务' })
    await threadRow.locator('.ai-history-note', { hasText: '并发方案' }).click()
    await sheet.waitFor({ state: 'detached', timeout: 5000 })
    await page.waitForFunction(() => document.querySelector('.title-input')?.value === '并发方案')

    // ⑤ 重开应用：内存里的对话没了，打开面板应当把当前笔记上次的对话接回来。
    await application.electronApplication.close()
    application = await launchApplication(userDataPath)
    page = application.page
    const activeTitle = await page.locator('.title-input').inputValue()
    await page.getByRole('button', { name: 'AI 笔记助手' }).click()
    panel = page.getByRole('complementary', { name: 'AI 笔记助手' })
    await panel.waitFor()

    const banner = panel.locator('.ai-resumed')
    await banner.waitFor({ timeout: 10_000 })
    // 横幅必须点名是哪篇笔记的对话，否则用户不知道眼前这些旧内容从哪来。
    assert.match(await banner.innerText(), new RegExp(activeTitle))
    assert.ok(await panel.locator('.ai-bubble--user').count() >= 1, '续接后应该能看到上次的提问')

    // ⑥ 「开始新对话」退回空白，且关掉再打开不会又被自动载回来。
    await panel.getByRole('button', { name: '开始新对话' }).click()
    await banner.waitFor({ state: 'detached', timeout: 5000 })
    assert.equal(await panel.locator('.ai-bubble--user').count(), 0)

    await page.getByRole('button', { name: 'AI 笔记助手' }).click()
    await panel.waitFor({ state: 'detached' })
    await page.getByRole('button', { name: 'AI 笔记助手' }).click()
    panel = page.getByRole('complementary', { name: 'AI 笔记助手' })
    await panel.waitFor()
    await page.waitForTimeout(600)
    assert.equal(await panel.locator('.ai-resumed').count(), 0, '刚开过新对话就不该再自动续接')
    assert.equal(await panel.locator('.ai-bubble--user').count(), 0)

    // ⑦ 换到另一篇笔记：面板还开着、会话是空白的，应当直接接上那一篇自己的对话。
    //    （⑦ 必须切到「另一篇」：重启后的活跃笔记本来就是《并发方案》，点同名标签
    //    不会改变 currentNoteId，跳过标记也就不会清掉。）
    await page.locator('.note-tab-main', { hasText: '部署清单' }).click()
    await page.waitForFunction(() => document.querySelector('.title-input')?.value === '部署清单')
    await panel.locator('.ai-resumed').waitFor({ timeout: 10_000 })
    assert.match(await panel.locator('.ai-resumed').innerText(), /部署清单/)
    assert.match(await panel.locator('.ai-bubble--user').first().innerText(), /部署顺序怎么排/)
  } finally {
    if (application) await application.electronApplication.close().catch(() => {})
    await model.close()
    await fs.rm(userDataPath, { recursive: true, force: true })
  }
})
