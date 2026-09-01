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

test('局部关系图谱展示邻接笔记并可跳转', { timeout: 90_000 }, async () => {
  const userDataPath = await fs.mkdtemp(path.join(os.tmpdir(), 'xinyue-notes-graph-'))
  let application
  try {
    application = await launchApplication(userDataPath)
    const { page } = application
    await page.evaluate(async () => {
      const center = await window.notesDesktop.createNote(null)
      const neighbor = await window.notesDesktop.createNote(null)
      await window.notesDesktop.updateNote(neighbor.id, { title: '图谱邻居' })
      await window.notesDesktop.updateNote(center.id, {
        title: '图谱中心',
        content: `link [邻居](https://xinyue-note.local/${neighbor.id})`
      })
    })
    await page.reload()
    await expandUnclassified(page)
    await page.waitForSelector('.navigation-panel .sidebar-note-main')

    await page.locator('.navigation-panel .sidebar-note-main').filter({ hasText: '图谱中心' }).first().click()
    await page.waitForSelector('.milkdown-editor-root .ProseMirror')

    // 打开侧栏并展开关系图谱。
    const graphToggle = page.locator('.markdown-backlinks-section__toggle').filter({ hasText: '关系图谱' })
    await graphToggle.click()
    await page.waitForSelector('.note-graph__canvas')
    await page.waitForFunction(() => document.querySelectorAll('.note-graph__node').length >= 2, { timeout: 10_000 })

    const nodeLabels = await page.locator('.note-graph__node-label').allTextContents()
    assert.ok(nodeLabels.some((label) => label.includes('图谱邻居')), `图谱应包含邻居节点，实际 ${nodeLabels.join(',')}`)

    // 点击邻居节点应跳转到该笔记。
    await page.locator('.note-graph__node').filter({ has: page.locator('text=图谱邻居') }).first().click()
    await page.waitForFunction((title) => {
      const input = document.querySelector('.editor-title-row .title-input')
      return input instanceof HTMLInputElement && input.value === title
    }, '图谱邻居', { timeout: 10_000 })
  } finally {
    if (application?.electronApplication) await application.electronApplication.close().catch(() => {})
    await fs.rm(userDataPath, { recursive: true, force: true })
  }
})
