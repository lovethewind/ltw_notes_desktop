const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')

const { _electron: electron } = require('playwright')

const projectRoot = path.resolve(__dirname, '../..')

/** 使用隔离数据目录启动真实 Electron 主进程与渲染窗口。 */
async function launchApplication(userDataPath) {
  const electronApplication = await electron.launch({
    args: [projectRoot],
    cwd: projectRoot,
    env: {
      ...process.env,
      NODE_ENV: 'test',
      XINYUE_NOTES_E2E_USER_DATA: userDataPath
    }
  })
  const page = await electronApplication.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  await page.waitForFunction(() => Boolean(window.notesDesktop))
  return { electronApplication, page }
}

/** 通过应用公开的预加载接口准备最小数据，交互断言仍全部走真实界面。 */
async function seedNotes(page) {
  await page.evaluate(async () => {
    for (const title of ['固定页', '保留前页', '当前页']) {
      const note = await window.notesDesktop.createNote(null)
      await window.notesDesktop.updateNote(note.id, { title, content: `${title}正文` })
    }
  })
  await page.reload()
  await expandUnclassified(page)
  await page.waitForSelector('.navigation-panel .sidebar-note-main')
}

function sidebarNote(page, title) {
  return page.locator('.navigation-panel .sidebar-note-main').filter({ hasText: title }).first()
}

function noteTab(page, title) {
  return page.locator('.note-tab').filter({ hasText: title }).first()
}

function sidebarFolder(page, name) {
  return page.locator('.tree-folder-resource > button').filter({ hasText: name }).first()
}

/** 测试需要访问未分类笔记时显式展开，避免依赖产品默认展开状态。 */
async function expandUnclassified(page) {
  const button = page.getByRole('button', { name: /未分类/ }).first()
  if (await button.getAttribute('aria-expanded') === 'false') await button.click()
}

async function openSidebarNoteInNewTab(page, title) {
  await sidebarNote(page, title).click({ button: 'right' })
  await page.getByRole('menuitem', { name: '在新标签页打开' }).click()
  await noteTab(page, title).waitFor()
}

test('固定标签在关闭其他标签后保留，并在重启后恢复', { timeout: 60_000 }, async () => {
  const userDataPath = await fs.mkdtemp(path.join(os.tmpdir(), 'xinyue-notes-e2e-'))
  let application

  try {
    application = await launchApplication(userDataPath)
    await seedNotes(application.page)

    await sidebarNote(application.page, '固定页').click()
    await openSidebarNoteInNewTab(application.page, '保留前页')
    await openSidebarNoteInNewTab(application.page, '当前页')

    await noteTab(application.page, '固定页').click({ button: 'right' })
    await application.page.getByRole('menuitem', { name: '固定标签' }).click()
    await noteTab(application.page, '固定页').waitFor()

    await noteTab(application.page, '当前页').click({ button: 'right' })
    await application.page.getByRole('menuitem', { name: '关闭其他标签' }).click()

    assert.equal(await application.page.locator('.note-tab').count(), 2)
    await noteTab(application.page, '固定页').waitFor()
    await noteTab(application.page, '当前页').waitFor()
    assert.equal(await noteTab(application.page, '固定页').evaluate((element) => element.classList.contains('pinned')), true)
    assert.equal(await application.page.getByLabel('笔记标题').inputValue(), '当前页')

    // 会话状态采用短防抖写入，等待落库后关闭并复用同一测试目录重启。
    await application.page.waitForTimeout(500)
    await application.electronApplication.close()
    application = await launchApplication(userDataPath)

    assert.equal(await application.page.locator('.note-tab').count(), 2)
    await noteTab(application.page, '固定页').waitFor()
    await noteTab(application.page, '当前页').waitFor()
    assert.equal(await noteTab(application.page, '固定页').evaluate((element) => element.classList.contains('pinned')), true)
    assert.equal(await application.page.getByLabel('笔记标题').inputValue(), '当前页')
  } finally {
    if (application) await application.electronApplication.close().catch(() => {})
    await fs.rm(userDataPath, { recursive: true, force: true })
  }
})

test('空会话启动保持空白和折叠，会话恢复只展开活动笔记路径', { timeout: 60_000 }, async () => {
  const userDataPath = await fs.mkdtemp(path.join(os.tmpdir(), 'xinyue-notes-startup-e2e-'))
  let application

  try {
    application = await launchApplication(userDataPath)
    const seeded = await application.page.evaluate(async () => {
      const parent = await window.notesDesktop.createFolder('启动父目录', null)
      const child = await window.notesDesktop.createFolder('启动子目录', parent.id)
      const note = await window.notesDesktop.createNote(child.id)
      await window.notesDesktop.updateNote(note.id, { title: '启动恢复笔记', content: '启动恢复正文' })
      return { noteId: note.id }
    })
    await application.page.reload()

    await application.page.locator('.editor-empty').waitFor({ timeout: 3_000 })
    assert.equal(await application.page.locator('.note-tab').count(), 0)
    assert.equal(await sidebarFolder(application.page, '启动父目录').getAttribute('aria-expanded'), 'false')

    // 自动同步完成后主进程会发送同一通知；空标签会话不应因此兜底打开第一篇笔记。
    await application.electronApplication.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]?.webContents.send('workspace:changed')
    })
    await application.page.waitForTimeout(200)
    assert.equal(await application.page.locator('.note-tab').count(), 0)
    await application.page.locator('.editor-empty').waitFor()
    await application.page.waitForTimeout(350)

    await application.page.evaluate(async ({ noteId }) => {
      await window.notesDesktop.saveWorkspaceSession({
        tabs: [{ noteId, isPinned: false }],
        activeNoteId: noteId
      })
    }, seeded)
    await application.page.reload()

    assert.equal(await application.page.getByLabel('笔记标题').inputValue(), '启动恢复笔记')
    assert.equal(await sidebarFolder(application.page, '启动父目录').getAttribute('aria-expanded'), 'true')
    assert.equal(await sidebarFolder(application.page, '启动子目录').getAttribute('aria-expanded'), 'true')
  } finally {
    if (application) await application.electronApplication.close().catch(() => {})
    await fs.rm(userDataPath, { recursive: true, force: true })
  }
})

test('同步删除当前笔记后切换到下一篇可用笔记', { timeout: 60_000 }, async () => {
  const userDataPath = await fs.mkdtemp(path.join(os.tmpdir(), 'xinyue-notes-sync-delete-e2e-'))
  let application

  try {
    application = await launchApplication(userDataPath)
    const deletedNoteId = await application.page.evaluate(async () => {
      const fallback = await window.notesDesktop.createNote(null)
      await window.notesDesktop.updateNote(fallback.id, { title: '同步后的可用笔记', content: '保留正文' })
      const current = await window.notesDesktop.createNote(null)
      await window.notesDesktop.updateNote(current.id, { title: '将被同步删除', content: '删除正文' })
      return current.id
    })
    await application.page.reload()
    await expandUnclassified(application.page)
    await sidebarNote(application.page, '将被同步删除').click()

    await application.page.evaluate(async (noteId) => {
      await window.notesDesktop.setNoteDeleted(noteId, true)
    }, deletedNoteId)
    await application.electronApplication.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]?.webContents.send('workspace:changed')
    })

    await application.page.getByLabel('笔记标题').waitFor()
    assert.equal(await application.page.getByLabel('笔记标题').inputValue(), '同步后的可用笔记')
    assert.equal(await noteTab(application.page, '将被同步删除').count(), 0)
  } finally {
    if (application) await application.electronApplication.close().catch(() => {})
    await fs.rm(userDataPath, { recursive: true, force: true })
  }
})

test('待保存正文关闭最后标签后立即关窗，重新打开仍保持空白和未分类折叠', { timeout: 60_000 }, async () => {
  const userDataPath = await fs.mkdtemp(path.join(os.tmpdir(), 'xinyue-notes-close-window-e2e-'))
  let application

  try {
    application = await launchApplication(userDataPath)
    await application.page.evaluate(async () => {
      const note = await window.notesDesktop.createNote(null)
      await window.notesDesktop.updateNote(note.id, { title: '不应恢复的笔记', content: '关闭标签后的正文' })
    })
    await application.page.reload()
    await expandUnclassified(application.page)
    await sidebarNote(application.page, '不应恢复的笔记').click()

    // 先确保旧的活动会话已经落库，才能验证最后标签关闭是否覆盖了它。
    await application.page.waitForTimeout(500)
    const editor = application.page.locator('.milkdown-editor-root .ProseMirror')
    await editor.click()
    await application.page.keyboard.press('Meta+End')
    await application.page.keyboard.type('尚未触发自动保存的修改')
    await application.page.getByRole('button', { name: '关闭 不应恢复的笔记' }).click()
    await application.page.close()

    const reopenedWindow = application.electronApplication.waitForEvent('window')
    await application.electronApplication.evaluate(({ app }) => app.emit('activate'))
    application.page = await reopenedWindow
    await application.page.waitForLoadState('domcontentloaded')
    await application.page.waitForFunction(() => Boolean(window.notesDesktop))

    await application.page.locator('.editor-empty').waitFor({ timeout: 3_000 })
    assert.equal(await application.page.locator('.note-tab').count(), 0)
    assert.equal(
      await application.page.getByRole('button', { name: /未分类/ }).first().getAttribute('aria-expanded'),
      'false'
    )
  } finally {
    if (application) await application.electronApplication.close().catch(() => {})
    await fs.rm(userDataPath, { recursive: true, force: true })
  }
})

test('切换笔记后撤销不会恢复上一篇笔记的正文', { timeout: 60_000 }, async () => {
  const userDataPath = await fs.mkdtemp(path.join(os.tmpdir(), 'xinyue-notes-undo-e2e-'))
  let application

  try {
    application = await launchApplication(userDataPath)
    await application.page.evaluate(async () => {
      for (const [title, content] of [['第一篇', '第一篇独有正文'], ['第二篇', '第二篇独有正文']]) {
        const note = await window.notesDesktop.createNote(null)
        await window.notesDesktop.updateNote(note.id, { title, content })
      }
    })
    await application.page.reload()

    await expandUnclassified(application.page)
    await sidebarNote(application.page, '第一篇').click()
    const editor = application.page.locator('.milkdown-editor-root .ProseMirror')
    await editor.waitFor()
    await editor.click()
    await application.page.keyboard.press('Meta+A')
    await application.page.keyboard.type('第一篇修改内容')
    await application.page.waitForFunction(() => (
      document.querySelector('.milkdown-editor-root .ProseMirror')?.textContent?.includes('第一篇修改内容')
    ))

    await sidebarNote(application.page, '第二篇').click()
    await application.page.waitForFunction(() => (
      document.querySelector('.milkdown-editor-root .ProseMirror')?.textContent?.includes('第二篇独有正文')
    ))
    await application.page.locator('.milkdown-editor-root .top-bar-actions [data-label="撤销"]').waitFor()
    const undoButton = application.page.locator('.milkdown-editor-root [data-label="撤销"]')
    const redoButton = application.page.locator('.milkdown-editor-root [data-label="重做"]')
    assert.equal(await redoButton.count(), 1)
    assert.equal(await application.page.locator('.milkdown-editor-root [data-label="加粗"]').count(), 1)
    assert.equal(await undoButton.isDisabled(), true)
    assert.equal(await redoButton.isDisabled(), true)
    await editor.click()
    await application.page.keyboard.press('Meta+Z')

    const contentAfterUndo = await editor.innerText()
    assert.match(contentAfterUndo, /第二篇独有正文/)
    assert.doesNotMatch(contentAfterUndo, /第一篇/)

    await application.page.keyboard.press('Meta+A')
    await application.page.keyboard.type('第二篇临时修改')
    await application.page.waitForFunction(() => (
      !document.querySelector('.milkdown-editor-root [data-label="撤销"]')?.hasAttribute('disabled')
    ))
    assert.equal(await redoButton.isDisabled(), true)
    await application.page.keyboard.press('Meta+Z')
    await application.page.waitForFunction(() => (
      !document.querySelector('.milkdown-editor-root [data-label="重做"]')?.hasAttribute('disabled')
    ))
    assert.equal(await undoButton.isDisabled(), true)
    assert.match(await editor.innerText(), /第二篇独有正文/)
  } finally {
    if (application) await application.electronApplication.close().catch(() => {})
    await fs.rm(userDataPath, { recursive: true, force: true })
  }
})
