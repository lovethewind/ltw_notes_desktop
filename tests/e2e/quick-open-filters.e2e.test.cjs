const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')

const { _electron: electron } = require('playwright')

const projectRoot = path.resolve(__dirname, '../..')

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
  const page = await electronApplication.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  await page.waitForFunction(() => Boolean(window.notesDesktop))
  return { electronApplication, page }
}

test('快速打开可以组合文件夹、标签和置顶筛选', { timeout: 60_000 }, async () => {
  const userDataPath = await fs.mkdtemp(path.join(os.tmpdir(), 'xinyue-notes-search-e2e-'))
  let application

  try {
    application = await launchApplication(userDataPath)
    await application.page.evaluate(async () => {
      const work = await window.notesDesktop.createFolder('工作', null)
      const other = await window.notesDesktop.createFolder('其他', null)
      const fixtures = [
        { folderId: work.id, title: '目标笔记', tagNames: ['重要'], isPinned: true },
        { folderId: work.id, title: '同目录普通笔记', tagNames: ['普通'], isPinned: false },
        { folderId: other.id, title: '其他目录重要笔记', tagNames: ['重要'], isPinned: true }
      ]
      for (const fixture of fixtures) {
        const note = await window.notesDesktop.createNote(fixture.folderId)
        await window.notesDesktop.updateNote(note.id, {
          title: fixture.title,
          content: `${fixture.title}正文`,
          tagNames: fixture.tagNames,
          isPinned: fixture.isPinned
        })
      }
    })
    await application.page.reload()
    await application.page.keyboard.press('Meta+O')

    await application.page.getByRole('button', { name: '显示高级搜索筛选' }).click()
    assert.equal(await application.page.locator('.quick-open-filters select').count(), 0)

    await application.page.getByRole('button', { name: /不限时间/ }).click()
    const timePicker = application.page.getByRole('menu', { name: '筛选更新时间' })
    assert.equal(
      await timePicker.getByRole('menuitem', { name: '不限时间' }).evaluate((element) => getComputedStyle(element).fontSize),
      '11px'
    )
    await timePicker.getByRole('menuitem', { name: '不限时间' }).click()

    await application.page.getByRole('button', { name: /全部文件夹/ }).click()
    const folderPicker = application.page.getByRole('listbox', { name: '选择文件夹' })
    await folderPicker.getByRole('option', { name: '工作' }).click()

    await application.page.getByRole('button', { name: /全部标签/ }).click()
    const tagPicker = application.page.getByRole('listbox', { name: '筛选标签' })
    await tagPicker.getByRole('option', { name: '重要' }).click()
    await application.page.getByRole('button', { name: '仅显示置顶笔记' }).click()

    const results = application.page.locator('.quick-open-results > button')
    await application.page.waitForFunction(() => (
      document.querySelectorAll('.quick-open-results > button').length === 1
    ))
    await results.filter({ hasText: '目标笔记' }).waitFor()
    assert.equal(await results.count(), 1)
    assert.match(await results.first().innerText(), /目标笔记/)

    const clearFolderFilter = application.page.getByRole('button', { name: '清除文件夹筛选' })
    assert.equal(await clearFolderFilter.count(), 1)
    await clearFolderFilter.click()
    await application.page.waitForFunction(() => (
      document.querySelectorAll('.quick-open-results > button').length === 2
    ))
    await application.page.getByRole('button', { name: /全部文件夹/ }).waitFor()
    assert.equal(await application.page.getByRole('listbox', { name: '选择文件夹' }).count(), 0)
  } finally {
    if (application) await application.electronApplication.close().catch(() => {})
    await fs.rm(userDataPath, { recursive: true, force: true })
  }
})

test('快速打开可以单独删除或清空最近搜索', { timeout: 60_000 }, async () => {
  const userDataPath = await fs.mkdtemp(path.join(os.tmpdir(), 'xinyue-notes-history-e2e-'))
  let application

  try {
    application = await launchApplication(userDataPath)
    await application.page.evaluate(() => {
      window.localStorage.setItem('notes-quick-open-history', JSON.stringify(['admin', 'Django']))
    })
    await application.page.reload()
    await application.page.keyboard.press('Meta+O')

    await application.page.getByRole('button', { name: '删除最近搜索 admin' }).click()
    assert.deepEqual(
      await application.page.evaluate(() => JSON.parse(window.localStorage.getItem('notes-quick-open-history') || '[]')),
      ['Django']
    )
    assert.equal(await application.page.getByRole('button', { name: '使用最近搜索 admin' }).count(), 0)

    await application.page.getByRole('button', { name: '清空最近搜索' }).click()
    assert.deepEqual(
      await application.page.evaluate(() => JSON.parse(window.localStorage.getItem('notes-quick-open-history') || '[]')),
      []
    )
    assert.equal(await application.page.locator('.quick-open-history').count(), 0)
  } finally {
    if (application) await application.electronApplication.close().catch(() => {})
    await fs.rm(userDataPath, { recursive: true, force: true })
  }
})
