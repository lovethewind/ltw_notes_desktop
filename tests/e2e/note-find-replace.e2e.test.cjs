/**
 * 笔记内查找替换的端到端用例。
 *
 * 两个编辑器是两套完全不同的实现（ProseMirror 事务 / CodeMirror changes），
 * 只靠静态守卫证明不了「点替换真的改到了字」，所以两条链路都起真应用跑一遍：
 * 富文本一条验证「单次替换跳下一个 + 全部替换 + 落库 + 一次撤销」，
 * 外部文件一条验证「改完写回磁盘」。
 */
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')

const { _electron: electron } = require('playwright')

const projectRoot = path.resolve(__dirname, '../..')

// 受限沙箱（如无 GUI 权限的容器）里 Chromium 子进程无法初始化自身 sandbox。
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

/** 建一篇笔记并设成当前标签。 */
async function seedNote(page, { title, content }) {
  const noteId = await page.evaluate(async (item) => {
    const note = await window.notesDesktop.createNote(null)
    await window.notesDesktop.updateNote(note.id, { title: item.title, content: item.content })
    await window.notesDesktop.saveWorkspaceSession({
      tabs: [{ noteId: note.id, isPinned: false }],
      activeNoteId: note.id
    })
    return note.id
  }, { title, content })
  await page.reload()
  await page.locator('.milkdown-editor-root .ProseMirror').waitFor()
  return noteId
}

/**
 * 让系统文件对话框返回固定路径（原生对话框无法自动驱动）。
 *
 * 覆盖的只是「选路径」这一步；读盘、建标签、写回磁盘仍是真实主进程实现。
 */
async function stubOpenDialog(application, openPath) {
  await application.electronApplication.evaluate(({ dialog }, filePath) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [filePath] })
  }, openPath)
}

function editorBody(page) {
  return page.locator('.milkdown-editor-root .ProseMirror')
}

const findBar = (page) => page.locator('.note-find-bar')
const findInput = (page) => findBar(page).locator('input[placeholder="在当前笔记中查找"]')
const replaceInput = (page) => findBar(page).locator('input[placeholder="替换为"]')
const findCounter = (page) => findBar(page).locator('.note-find-row > span').first()

/** 打开查找并等计数器稳定，避免读到上一帧的 0/0。 */
async function openFind(page, keyword) {
  await editorBody(page).click()
  await page.keyboard.press('Meta+f')
  await findInput(page).waitFor()
  await findInput(page).fill(keyword)
  await page.waitForFunction(() => {
    const counter = document.querySelector('.note-find-bar .note-find-row > span')
    return Boolean(counter && counter.textContent && counter.textContent !== '0/0')
  })
}

/**
 * 轮询数据库直到正文满足条件。
 *
 * 不用 `waitForFunction` 做异步查库：它拿到的是 Promise 对象本身（truthy），
 * 会在正文还没落库时就放行。
 */
async function waitForSavedContent(page, noteId, predicate, timeout = 10_000) {
  const deadline = Date.now() + timeout
  let last = ''
  while (Date.now() < deadline) {
    last = await page.evaluate(
      (id) => window.notesDesktop.getNote(id).then((note) => String(note?.content || '')),
      noteId
    )
    if (predicate(last)) return last
    await page.waitForTimeout(150)
  }
  throw new Error(`等待笔记落库超时，最后一次内容：${JSON.stringify(last.slice(0, 300))}`)
}

test('富文本：单次替换跳下一个，全部替换后落库且可一次撤销', { timeout: 120_000 }, async () => {
  const userDataPath = await fs.mkdtemp(path.join(os.tmpdir(), 'xinyue-find-replace-'))
  let application
  try {
    application = await launchApplication(userDataPath)
    const { page } = application
    const noteId = await seedNote(page, {
      title: '并发方案',
      content: '# 并发\n\n线程池适合 IO 密集任务。\n\n线程池不适合 CPU 密集任务。\n'
    })

    await openFind(page, '线程池')
    assert.equal(await findCounter(page).innerText(), '1/2')

    // 展开替换行：默认收起，点图标才出现替换输入框。
    assert.equal(await replaceInput(page).count(), 0)
    await findBar(page).getByRole('button', { name: '展开替换' }).click()
    await replaceInput(page).waitFor()
    await replaceInput(page).fill('连接池')

    // 全部替换：两处一起改，计数器归零。
    await findBar(page).getByRole('button', { name: '全部' }).click()
    await page.waitForFunction(() => {
      const body = document.querySelector('.milkdown-editor-root .ProseMirror')
      return Boolean(body && !body.textContent.includes('线程池'))
    })
    assert.equal(await findCounter(page).innerText(), '0/0')
    const afterAll = await editorBody(page).innerText()
    assert.equal((afterAll.match(/连接池/g) || []).length, 2)

    // 两处必须在**同一个事务**里：一次撤销就该整体退回。
    // 分成两次撤销的话，这里会看到「1 处线程池 + 1 处连接池」的中间态。
    await editorBody(page).click()
    await page.keyboard.press('Meta+z')
    await page.waitForFunction(() => {
      const body = document.querySelector('.milkdown-editor-root .ProseMirror')
      if (!body) return false
      const text = body.textContent
      return (text.match(/线程池/g) || []).length === 2 && !text.includes('连接池')
    })

    // 单次替换：只改当前那一处，光标跳到剩下的那一处。
    // 关键词本来就是「线程池」，fill 同值不会触发 input，先清空再填。
    await findInput(page).fill('')
    await findInput(page).fill('线程池')
    await page.waitForFunction(() => {
      const counter = document.querySelector('.note-find-bar .note-find-row > span')
      return Boolean(counter && counter.textContent === '1/2')
    })
    await findBar(page).getByRole('button', { name: '替换', exact: true }).click()
    await page.waitForFunction(() => {
      const body = document.querySelector('.milkdown-editor-root .ProseMirror')
      return Boolean(body && body.textContent.includes('连接池适合 IO 密集任务'))
    })
    assert.equal(await findCounter(page).innerText(), '1/1')
    const afterSingle = await editorBody(page).innerText()
    assert.match(afterSingle, /连接池适合 IO 密集任务/)
    assert.match(afterSingle, /线程池不适合 CPU 密集任务/)

    // 剩下的那一处也换掉，然后确认真的写进库了（自动保存有 1.5s 防抖）。
    await findBar(page).getByRole('button', { name: '全部' }).click()
    await page.waitForFunction(() => {
      const body = document.querySelector('.milkdown-editor-root .ProseMirror')
      return Boolean(body && !body.textContent.includes('线程池'))
    })
    assert.equal(await findCounter(page).innerText(), '0/0')
    const saved = await waitForSavedContent(
      page,
      noteId,
      (content) => content.includes('连接池适合 IO 密集任务') && !content.includes('线程池')
    )
    assert.equal((saved.match(/连接池/g) || []).length, 2)
  } finally {
    if (application) await application.electronApplication.close().catch(() => {})
    await fs.rm(userDataPath, { recursive: true, force: true })
  }
})

test('外部文件：替换后写回磁盘，未匹配时不改动原文', { timeout: 120_000 }, async () => {
  const userDataPath = await fs.mkdtemp(path.join(os.tmpdir(), 'xinyue-find-replace-file-'))
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'xinyue-find-replace-md-'))
  const filePath = path.join(workspace, '待办.md')
  await fs.writeFile(filePath, '# 待办\n\n- TODO 写周报\n- TODO 回邮件\n', 'utf8')
  let application
  try {
    application = await launchApplication(userDataPath)
    const { page } = application
    await stubOpenDialog(application, filePath)
    await page.keyboard.press('Meta+Shift+o')
    await page.locator('.markdown-source-editor .cm-content').waitFor()

    // ⌘⌥F 直接带着替换行打开，不用再点一次图标。
    await page.locator('.markdown-source-editor .cm-content').click()
    await page.keyboard.press('Meta+Alt+f')
    await findInput(page).waitFor()
    await replaceInput(page).waitFor()
    await findInput(page).fill('TODO')
    await page.waitForFunction(() => {
      const counter = document.querySelector('.note-find-bar .note-find-row > span')
      return Boolean(counter && counter.textContent === '1/2')
    })

    await replaceInput(page).fill('待办')
    await findBar(page).getByRole('button', { name: '全部' }).click()
    assert.equal(await findCounter(page).innerText(), '0/0')

    // 外部文件是手写回盘的，替换本身不落盘，⌘S 才写。
    await page.locator('.markdown-source-editor .cm-content').click()
    await page.keyboard.press('Meta+s')
    const deadline = Date.now() + 10_000
    let written = ''
    while (Date.now() < deadline) {
      written = await fs.readFile(filePath, 'utf8')
      if (written.includes('待办 写周报')) break
      await page.waitForTimeout(150)
    }
    assert.match(written, /- 待办 写周报/)
    assert.match(written, /- 待办 回邮件/)
    assert.doesNotMatch(written, /TODO/)
    // 保真：标题与空行原样保留，替换不会顺手重排文件。
    assert.match(written, /^# 待办\n\n/)
  } finally {
    if (application) await application.electronApplication.close().catch(() => {})
    await fs.rm(userDataPath, { recursive: true, force: true })
    await fs.rm(workspace, { recursive: true, force: true })
  }
})
