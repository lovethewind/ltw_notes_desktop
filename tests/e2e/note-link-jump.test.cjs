const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')

const { _electron: electron } = require('playwright')

const projectRoot = path.resolve(__dirname, '../..')

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

async function expandUnclassified(page) {
  const button = page.getByRole('button', { name: /未分类/ }).first()
  if (await button.getAttribute('aria-expanded') === 'false') await button.click()
}

test('Cmd+点击 xinyue-note.local 笔记链接跳到目标笔记', { timeout: 90_000 }, async () => {
  const userDataPath = await fs.mkdtemp(path.join(os.tmpdir(), 'xinyue-notes-link-jump-'))
  let application
  try {
    application = await launchApplication(userDataPath)
    const { page } = application
    await page.evaluate(async () => {
      const source = await window.notesDesktop.createNote(null)
      const target = await window.notesDesktop.createNote(null)
      await window.notesDesktop.updateNote(target.id, { title: '跳转目标笔记', content: '目标正文' })
      await window.notesDesktop.updateNote(source.id, {
        title: '源笔记',
        content: `跳转 [跳转目标笔记](https://xinyue-note.local/${target.id})`
      })
    })
    await page.reload()
    await expandUnclassified(page)
    await page.waitForSelector('.navigation-panel .sidebar-note-main')

    await page.locator('.navigation-panel .sidebar-note-main').filter({ hasText: '源笔记' }).first().click()
    await page.waitForSelector('.milkdown-editor-root .ProseMirror')

    // Milkdown 必须保留 https 内部链接，不能被 sanitize 洗成空 href。
    const anchor = page.locator('.milkdown-editor-root .ProseMirror a').first()
    await anchor.waitFor()
    const resolvedHref = await anchor.getAttribute('href')
    assert.ok(resolvedHref.includes('xinyue-note.local'), '锚点 href 未被清洗为空')

    // Cmd+点击应切换到目标笔记。
    await anchor.click({ modifiers: ['Meta'] })
    await page.waitForFunction((title) => {
      const input = document.querySelector('.editor-title-row .title-input')
      return input instanceof HTMLInputElement && input.value === title
    }, '跳转目标笔记', { timeout: 10_000 })
    const activeTabText = await page.locator('.note-tab.active .note-tab-main').textContent()
    assert.ok(activeTabText.includes('跳转目标笔记'), 'Cmd+点击后激活笔记切到目标')
  } finally {
    if (application?.electronApplication) await application.electronApplication.close().catch(() => {})
    await fs.rm(userDataPath, { recursive: true, force: true })
  }
})
