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

async function expandUnclassified(page) {
  const button = page.getByRole('button', { name: /未分类/ }).first()
  if (await button.getAttribute('aria-expanded') === 'false') await button.click()
}

// 将光标移到编辑器末尾并让正文滚动到底，使光标贴近视口底部。
// 注意：ProseMirror 的选区不会跟随 Meta/Control+End 移动，需用 DOM Range
// 算出行尾坐标，再通过鼠标点击让编辑器真实同步选区。
async function moveCaretToDocEnd(page) {
  await page.locator('.milkdown-editor-root .ProseMirror').click()
  await page.evaluate(() => {
    const scroller = document.querySelector('.milkdown-editor-scroll')
    if (scroller) scroller.scrollTop = scroller.scrollHeight
  })
  const caret = await page.evaluate(() => {
    const pm = document.querySelector('.milkdown-editor-root .ProseMirror')
    const walker = document.createTreeWalker(pm, NodeFilter.SHOW_TEXT)
    let last = null
    while (walker.nextNode()) last = walker.currentNode
    const range = document.createRange()
    range.setStart(last, last.textContent.length)
    range.collapse(true)
    const r = range.getBoundingClientRect()
    return { x: r.left, y: r.top }
  })
  await page.mouse.click(caret.x + 2, caret.y)
}

test('[[ 补全浮层在光标贴近窗口底部时不被裁切', { timeout: 90_000 }, async () => {
  const userDataPath = await fs.mkdtemp(path.join(os.tmpdir(), 'xinyue-notes-suggest-'))
  let application
  try {
    application = await launchApplication(userDataPath)
    const { page } = application
    await page.evaluate(async () => {
      const note = await window.notesDesktop.createNote(null)
      const lines = Array.from({ length: 80 }, (_, i) => `第 ${i + 1} 行用于撑开正文空间`)
      await window.notesDesktop.updateNote(note.id, { title: '补全底部测试', content: lines.join('\n') })
    })
    await page.reload()
    await expandUnclassified(page)
    await page.waitForSelector('.navigation-panel .sidebar-note-main')
    await page.locator('.navigation-panel .sidebar-note-main').filter({ hasText: '补全底部测试' }).first().click()
    await page.waitForSelector('.milkdown-editor-root .ProseMirror')

    await moveCaretToDocEnd(page)
    // 触发补全不能只用 insertText，它不更新 ProseMirror 内部状态；
    // 且 handleSuggestInput 读到的是"键入前"文本，所以需输入三个字符 `[[ `，
    // 第三次键击时 doc 以 `[[` 结尾才会打开浮层。
    await page.keyboard.type('[[ ')

    const popover = page.locator('.link-suggest')
    await popover.waitFor({ state: 'visible' })

    // 候选笔记是异步加载的，等它出现并让浮层重新定位后再校验一次。
    await page.waitForFunction(() => document.querySelectorAll('.link-suggest__item').length > 0)
    await page.waitForTimeout(80)

    const box = await popover.boundingBox()
    assert.ok(box, '补全浮层应已渲染')
    const viewport = await page.evaluate(() => ({ w: window.innerWidth, h: window.innerHeight }))
    assert.ok(box.x >= -1, `浮层左缘应在视口内，x=${box.x}`)
    assert.ok(box.y >= -1, `浮层顶缘应在视口内，y=${box.y}`)
    assert.ok(
      box.y + box.height <= viewport.h + 1,
      `浮层底缘应在视口内，top=${box.y} height=${box.height} innerHeight=${viewport.h}`
    )
  } finally {
    if (application?.electronApplication) await application.electronApplication.close().catch(() => {})
    await fs.rm(userDataPath, { recursive: true, force: true })
  }
})
