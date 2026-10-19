const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')

const { _electron: electron } = require('playwright')

const projectRoot = path.resolve(__dirname, '../..')

/** 使用隔离数据目录启动真实 Electron 主进程与渲染窗口。 */
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

/**
 * 让系统文件对话框在无人值守环境里返回固定路径。
 *
 * 原生对话框无法被自动化驱动，但它在链路里只承担「选一个路径」这一步；
 * 覆盖它之后，菜单/快捷键 → 主进程读盘 → IPC → 渲染层建标签的其余环节仍是真实实现。
 */
async function stubFileDialogs(application, { openPath, savePath } = {}) {
  await application.electronApplication.evaluate(({ dialog }, paths) => {
    dialog.showOpenDialog = async () => (paths.openPath
      ? { canceled: false, filePaths: [paths.openPath] }
      : { canceled: true, filePaths: [] })
    dialog.showSaveDialog = async () => (paths.savePath
      ? { canceled: false, filePath: paths.savePath }
      : { canceled: true, filePath: undefined })
  }, { openPath, savePath })
}

function fileTab(page, fileName) {
  return page.locator('.note-tab.file-tab').filter({ hasText: fileName }).first()
}

function sidebarNote(page, title) {
  return page.locator('.navigation-panel .sidebar-note-main').filter({ hasText: title }).first()
}

/** 测试需要访问未分类笔记时显式展开，避免依赖产品默认展开状态。 */
async function expandUnclassified(page) {
  const button = page.getByRole('button', { name: /未分类/ }).first()
  if (await button.getAttribute('aria-expanded') === 'false') await button.click()
}

/** 笔记标签用富文本编辑器。 */
function noteEditor(page) {
  return page.locator('.milkdown-editor-root .ProseMirror')
}

/** 外部文件标签用源码编辑器（CodeMirror），按 Markdown 原文编辑。 */
function fileEditor(page) {
  return page.locator('.markdown-source-editor .cm-content')
}

function saveStatus(page) {
  return page.locator('.editor-meta .editor-save-status')
}

/**
 * 读取源码编辑器里的完整正文。
 *
 * 不能直接读 `.cm-content` 的 textContent：CodeMirror 把每行渲染成独立的 `.cm-line`，
 * 节点之间没有换行符，读出来所有行会粘成一坨。这里按行拼接还原。
 */
function readFileEditorText(page) {
  return page.evaluate(() => Array
    .from(document.querySelectorAll('.markdown-source-editor .cm-line'))
    .map((line) => line.textContent)
    .join('\n'))
}

/** 等待正文写回磁盘。写盘发生在渲染层异步链路之后，只能轮询文件内容而不是等元素。 */
async function waitForFileContent(filePath, expected, timeout = 10_000) {
  const deadline = Date.now() + timeout
  let latest = ''
  while (Date.now() < deadline) {
    latest = await fs.readFile(filePath, 'utf8')
    if (latest.includes(expected)) return latest
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  assert.fail(`文件未写回期望内容，当前内容：${JSON.stringify(latest)}`)
}

/** 打开临时 Markdown 文件并等待编辑区就绪。 */
async function openMarkdownFile(page, filePath) {
  await page.keyboard.press('Meta+Shift+o')
  const fileName = path.basename(filePath)
  await fileTab(page, fileName).waitFor()
  await fileEditor(page).waitFor()
  // 外部文件必须落在源码编辑器上：富文本编辑器的 AST 往返会重排格式。
  assert.equal(await page.locator('.milkdown-editor-root .ProseMirror').count(), 0)
  assert.equal(await page.getByLabel('笔记标题').count(), 0)
  return fileName
}

/** 用键盘替换整篇正文，并等到状态徽标变成「未保存」。 */
async function replaceEditorContent(page, text) {
  await fileEditor(page).click()
  await page.keyboard.press('Meta+A')
  await page.keyboard.type(text)
  await page.waitForFunction(() => {
    const badge = document.querySelector('.editor-meta .editor-save-status')
    return badge?.textContent?.trim() === '未保存'
  })
}

test('通过菜单快捷键打开外部 Markdown 文件，编辑后写回磁盘', { timeout: 60_000 }, async () => {
  const userDataPath = await fs.mkdtemp(path.join(os.tmpdir(), 'xinyue-notes-file-e2e-'))
  const fileDir = await fs.mkdtemp(path.join(os.tmpdir(), 'xinyue-notes-md-e2e-'))
  const filePath = path.join(fileDir, '外部文件.md')
  let application

  try {
    await fs.writeFile(filePath, '# 打开测试\n\n第一段正文\n', 'utf8')
    application = await launchApplication(userDataPath)
    await stubFileDialogs(application, { openPath: filePath })

    const fileName = await openMarkdownFile(application.page, filePath)
    assert.equal(await application.page.locator('.note-tab.file-tab').count(), 1)
    // 外部文件必须明确标注不同步，避免用户误以为它进了笔记库或会上云。
    assert.match(await application.page.locator('.file-properties-row .file-origin').innerText(), /外部文件 · 仅本地修改不同步/)
    assert.equal(await application.page.locator('.file-properties-row .file-path').innerText(), filePath)
    assert.equal(await saveStatus(application.page).innerText(), '已保存')

    await replaceEditorContent(application.page, '写回磁盘的新正文')

    await application.page.keyboard.press('Meta+s')
    await application.page.waitForFunction(() => {
      const badge = document.querySelector('.editor-meta .editor-save-status')
      return Boolean(badge?.textContent?.includes('已保存'))
    })

    const saved = await waitForFileContent(filePath, '写回磁盘的新正文')
    assert.doesNotMatch(saved, /第一段正文/)
    assert.equal(await fileTab(application.page, fileName).count(), 1)
  } finally {
    if (application) await application.electronApplication.close().catch(() => {})
    await fs.rm(userDataPath, { recursive: true, force: true })
    await fs.rm(fileDir, { recursive: true, force: true })
  }
})

test('关闭有未保存修改的文件标签先弹确认，取消后标签保留', { timeout: 60_000 }, async () => {
  const userDataPath = await fs.mkdtemp(path.join(os.tmpdir(), 'xinyue-notes-file-close-e2e-'))
  const fileDir = await fs.mkdtemp(path.join(os.tmpdir(), 'xinyue-notes-md-close-e2e-'))
  const filePath = path.join(fileDir, '待关闭.md')
  let application

  try {
    await fs.writeFile(filePath, '关闭前正文\n', 'utf8')
    application = await launchApplication(userDataPath)
    await stubFileDialogs(application, { openPath: filePath })
    await openMarkdownFile(application.page, filePath)
    await replaceEditorContent(application.page, '尚未写回的修改')

    const closeButton = application.page.getByRole('button', { name: '关闭 待关闭.md' })
    await closeButton.click()

    const dialog = application.page.getByRole('alertdialog')
    await dialog.waitFor()
    assert.equal(await dialog.locator('#confirmation-dialog-title').innerText(), '放弃未保存的修改？')
    assert.match(await dialog.innerText(), /待关闭\.md/)

    await dialog.getByRole('button', { name: '取消' }).click()
    await dialog.waitFor({ state: 'detached' })
    assert.equal(await application.page.locator('.note-tab.file-tab').count(), 1)
    assert.match(await fileEditor(application.page).innerText(), /尚未写回的修改/)

    await closeButton.click()
    await application.page.getByRole('alertdialog').getByRole('button', { name: '放弃修改' }).click()
    await application.page.waitForFunction(() => !document.querySelector('.note-tab.file-tab'))
    assert.equal(await application.page.locator('.note-tab').count(), 0)
    await application.page.locator('.editor-empty').waitFor()
    // 放弃修改留在内存里也不该落盘：磁盘上仍是原始正文。
    assert.equal(await fs.readFile(filePath, 'utf8'), '关闭前正文\n')
  } finally {
    if (application) await application.electronApplication.close().catch(() => {})
    await fs.rm(userDataPath, { recursive: true, force: true })
    await fs.rm(fileDir, { recursive: true, force: true })
  }
})

test('重复打开同一路径只切换标签，不覆盖未保存的修改', { timeout: 60_000 }, async () => {
  const userDataPath = await fs.mkdtemp(path.join(os.tmpdir(), 'xinyue-notes-file-reopen-e2e-'))
  const fileDir = await fs.mkdtemp(path.join(os.tmpdir(), 'xinyue-notes-md-reopen-e2e-'))
  const filePath = path.join(fileDir, '重复打开.md')
  let application

  try {
    await fs.writeFile(filePath, '磁盘上的旧正文\n', 'utf8')
    application = await launchApplication(userDataPath)
    await stubFileDialogs(application, { openPath: filePath })
    await openMarkdownFile(application.page, filePath)
    await replaceEditorContent(application.page, '尚未保存的新正文')

    await application.page.keyboard.press('Meta+Shift+o')
    await application.page.waitForTimeout(300)

    assert.equal(await application.page.locator('.note-tab.file-tab').count(), 1)
    assert.match(await fileEditor(application.page).innerText(), /尚未保存的新正文/)
    assert.equal(await saveStatus(application.page).innerText(), '未保存')
  } finally {
    if (application) await application.electronApplication.close().catch(() => {})
    await fs.rm(userDataPath, { recursive: true, force: true })
    await fs.rm(fileDir, { recursive: true, force: true })
  }
})

test('另存为把正文写到新路径，原文件保持不变', { timeout: 60_000 }, async () => {
  const userDataPath = await fs.mkdtemp(path.join(os.tmpdir(), 'xinyue-notes-file-saveas-e2e-'))
  const fileDir = await fs.mkdtemp(path.join(os.tmpdir(), 'xinyue-notes-md-saveas-e2e-'))
  const filePath = path.join(fileDir, '原文件.md')
  const savedPath = path.join(fileDir, '另存副本.md')
  let application

  try {
    await fs.writeFile(filePath, '原文件正文\n', 'utf8')
    application = await launchApplication(userDataPath)
    await stubFileDialogs(application, { openPath: filePath, savePath: savedPath })
    await openMarkdownFile(application.page, filePath)
    await replaceEditorContent(application.page, '另存出来的正文')

    await application.page.getByRole('button', { name: '另存为' }).click()

    await fileTab(application.page, '另存副本.md').waitFor()
    await waitForFileContent(savedPath, '另存出来的正文')
    assert.equal(await application.page.locator('.note-tab.file-tab').count(), 1)
    assert.equal(await application.page.locator('.file-properties-row .file-path').innerText(), savedPath)
    assert.match(await saveStatus(application.page).innerText(), /^已保存/)
    // 另存为是「复制一份」，原文件不该被顺带写回。
    assert.equal(await fs.readFile(filePath, 'utf8'), '原文件正文\n')
  } finally {
    if (application) await application.electronApplication.close().catch(() => {})
    await fs.rm(userDataPath, { recursive: true, force: true })
    await fs.rm(fileDir, { recursive: true, force: true })
  }
})

test('打开非 Markdown 文件时给出错误提示且不建立标签', { timeout: 60_000 }, async () => {
  const userDataPath = await fs.mkdtemp(path.join(os.tmpdir(), 'xinyue-notes-file-invalid-e2e-'))
  const fileDir = await fs.mkdtemp(path.join(os.tmpdir(), 'xinyue-notes-md-invalid-e2e-'))
  const filePath = path.join(fileDir, '不支持.json')
  let application

  try {
    await fs.writeFile(filePath, '{"a":1}', 'utf8')
    application = await launchApplication(userDataPath)
    await stubFileDialogs(application, { openPath: filePath })

    await application.page.keyboard.press('Meta+Shift+o')
    const banner = application.page.locator('.error-banner')
    await banner.waitFor()
    assert.match(await banner.innerText(), /只支持打开 Markdown 或纯文本文件/)
    assert.equal(await application.page.locator('.note-tab.file-tab').count(), 0)
    await application.page.locator('.editor-empty').waitFor()
  } finally {
    if (application) await application.electronApplication.close().catch(() => {})
    await fs.rm(userDataPath, { recursive: true, force: true })
    await fs.rm(fileDir, { recursive: true, force: true })
  }
})

test('自动同步刷新不会顶掉正在编辑的外部文件标签', { timeout: 60_000 }, async () => {
  const userDataPath = await fs.mkdtemp(path.join(os.tmpdir(), 'xinyue-notes-file-sync-e2e-'))
  const fileDir = await fs.mkdtemp(path.join(os.tmpdir(), 'xinyue-notes-md-sync-e2e-'))
  const filePath = path.join(fileDir, '同步期间的文件.md')
  const noteTabElement = (page) => page.locator('.note-tab:not(.file-tab)').first()
  let application

  try {
    await fs.writeFile(filePath, '文件原始正文\n', 'utf8')
    application = await launchApplication(userDataPath)
    const noteId = await application.page.evaluate(async () => {
      const note = await window.notesDesktop.createNote(null)
      await window.notesDesktop.updateNote(note.id, { title: '同步笔记', content: '同步前的正文' })
      return note.id
    })
    await application.page.reload()
    await application.page.waitForFunction(() => Boolean(window.notesDesktop))
    await expandUnclassified(application.page)
    await sidebarNote(application.page, '同步笔记').click()
    await application.page.waitForFunction(() => (
      document.querySelector('.milkdown-editor-root .ProseMirror')?.textContent?.includes('同步前的正文')
    ))
    assert.equal(await noteEditor(application.page).count(), 1)

    await stubFileDialogs(application, { openPath: filePath })
    await openMarkdownFile(application.page, filePath)
    const fileTabElement = application.page.locator('.note-tab.file-tab').first()
    assert.equal(await fileTabElement.evaluate((element) => element.classList.contains('active')), true)

    // 模拟自动同步拉下该笔记的新内容：直接改库后广播 workspace:changed，
    // 这正是主进程同步完成后渲染层收到的通知，会让草稿与笔记快照不再一致。
    await application.page.evaluate(async (id) => {
      await window.notesDesktop.updateNote(id, { content: '同步下来的新正文' })
    }, noteId)
    await application.electronApplication.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]?.webContents.send('workspace:changed')
    })
    await application.page.waitForTimeout(800)

    // 修复前这里会走 loadNoteIntoDraft 并清空 activeFilePath，编辑区被笔记顶掉。
    assert.equal(await fileTabElement.evaluate((element) => element.classList.contains('active')), true)
    assert.match(await fileEditor(application.page).innerText(), /文件原始正文/)
    assert.equal(await noteTabElement(application.page).evaluate((element) => element.classList.contains('active')), false)
    assert.equal(await application.page.getByLabel('笔记标题').count(), 0)

    // 切回笔记标签仍要看到同步下来的新内容，证明同步结果没有丢。
    await application.page.locator('.note-tab:not(.file-tab) .note-tab-main').first().click()
    await application.page.waitForFunction(() => (
      document.querySelector('.milkdown-editor-root .ProseMirror')?.textContent?.includes('同步下来的新正文')
    ))
    assert.equal(await noteEditor(application.page).count(), 1)
    assert.equal(await application.page.getByLabel('笔记标题').inputValue(), '同步笔记')
  } finally {
    if (application) await application.electronApplication.close().catch(() => {})
    await fs.rm(userDataPath, { recursive: true, force: true })
    await fs.rm(fileDir, { recursive: true, force: true })
  }
})

test('只改一个字符也原样写回：表格里的 <br> 与 * 不丢失、不转义', { timeout: 60_000 }, async () => {
  const userDataPath = await fs.mkdtemp(path.join(os.tmpdir(), 'xinyue-notes-file-fidelity-e2e-'))
  const fileDir = await fs.mkdtemp(path.join(os.tmpdir(), 'xinyue-notes-md-fidelity-e2e-'))
  const filePath = path.join(fileDir, '表格保真.md')
  // 这几处写法富文本编辑器都表达不了：单元格里的 `###` 会被当成标题、`<br>` 会被整篇抹掉、
  // 行内 `*` 会被序列化成 `\*` —— 也就是用户报的「只改一个字，整篇表格被重排」。
  const original = [
    '# 表格保真',
    '',
    '| 字段 | 说明 |',
    '| --- | --- |',
    '| 换行 | 单元格内保留 <br> 才算原文 |',
    '| 标记 | 单个星号 * 原样保留 |',
    ''
  ].join('\n')
  let application

  try {
    await fs.writeFile(filePath, original, 'utf8')
    application = await launchApplication(userDataPath)
    await stubFileDialogs(application, { openPath: filePath })
    await openMarkdownFile(application.page, filePath)

    // 光标落到正文末尾后只补一个字符：改动最小，最能暴露「保存即重排全文」。
    await fileEditor(application.page).click()
    await application.page.keyboard.press('Meta+End')
    await application.page.keyboard.type('Z')
    await application.page.waitForFunction(() => (
      document.querySelector('.editor-meta .editor-save-status')?.textContent?.trim() === '未保存'
    ))

    await application.page.keyboard.press('Meta+s')
    await application.page.waitForFunction(() => (
      document.querySelector('.editor-meta .editor-save-status')?.textContent?.includes('已保存')
    ))

    const saved = await waitForFileContent(filePath, 'Z')
    // 逐字节相等：除多出来的那个字符，原文一个字都不许变。
    assert.equal(saved, `${original}Z`)
    assert.match(saved, /单元格内保留 <br> 才算原文/)
    assert.match(saved, /单个星号 \* 原样保留/)
    assert.doesNotMatch(saved, /\\\*/)
    assert.equal((saved.match(/<br>/g) ?? []).length, 1)
  } finally {
    if (application) await application.electronApplication.close().catch(() => {})
    await fs.rm(userDataPath, { recursive: true, force: true })
    await fs.rm(fileDir, { recursive: true, force: true })
  }
})

test('复制粘贴到外部文件不产生转义，⌘C/⌘V 与落盘都逐字节保真', { timeout: 60_000 }, async () => {
  const userDataPath = await fs.mkdtemp(path.join(os.tmpdir(), 'xinyue-notes-file-paste-e2e-'))
  const fileDir = await fs.mkdtemp(path.join(os.tmpdir(), 'xinyue-notes-md-paste-e2e-'))
  const filePath = path.join(fileDir, '粘贴保真.md')
  // 富文本编辑器在这份内容上会把 `*` 转义成 `\*`（笔记栏粘贴实测 2 处），源码编辑器必须原样收下。
  const original = [
    '| 字段 | 说明 | 备注 |',
    '| --- | --- | --- |',
    '| 换行 | 单元格内保留 <br> 才算原文 |  |',
    '| 标记 | 单个星号 * 原样保留 | 2 * 3 = 6 |',
    ''
  ].join('\n')
  let application

  try {
    await fs.writeFile(filePath, '占位正文\n', 'utf8')
    application = await launchApplication(userDataPath)
    await stubFileDialogs(application, { openPath: filePath })
    await openMarkdownFile(application.page, filePath)

    // A. 标签内自复制自粘贴：整篇 ⌘A → ⌘C → ⌘V 后内容不该有任何变化。
    await fileEditor(application.page).click()
    await application.page.keyboard.press('Meta+a')
    await application.page.keyboard.press('Meta+c')
    await application.page.keyboard.press('Meta+v')
    await application.page.waitForTimeout(400)
    assert.equal(await readFileEditorText(application.page), '占位正文\n')

    // B. 把外部来源的 Markdown 源码写进系统剪贴板后粘贴（真实 ⌘V 链路）。
    await application.page.keyboard.press('Meta+a')
    await application.page.keyboard.press('Backspace')
    await application.electronApplication.evaluate(({ clipboard }, value) => {
      clipboard.writeText(value)
    }, original)
    await application.page.keyboard.press('Meta+v')
    await application.page.waitForTimeout(400)

    const pasted = await readFileEditorText(application.page)
    assert.equal(pasted, original)
    assert.doesNotMatch(pasted, /\\\*/, '粘贴不该把 * 转义成 \\*')

    // C. 落盘后仍与源码逐字节一致。
    await application.page.keyboard.press('Meta+s')
    await application.page.waitForFunction(() => (
      document.querySelector('.editor-meta .editor-save-status')?.textContent?.includes('已保存')
    ))
    const saved = await waitForFileContent(filePath, '单元格内保留')
    assert.equal(saved, original)
    assert.equal((saved.match(/<br>/g) ?? []).length, 1)
    assert.equal((saved.match(/^\|/gm) ?? []).length, 4)
  } finally {
    if (application) await application.electronApplication.close().catch(() => {})
    await fs.rm(userDataPath, { recursive: true, force: true })
    await fs.rm(fileDir, { recursive: true, force: true })
  }
})

/** 顶部栏的两个模式按钮：索引 0 是源码，1 是预览。 */
function modeButton(page, index) {
  return page.locator('.markdown-source-editor__mode-button').nth(index)
}

test('外部文件默认源码模式，切到预览渲染表格，来回切换不改动文件', { timeout: 60_000 }, async () => {
  const userDataPath = await fs.mkdtemp(path.join(os.tmpdir(), 'xinyue-notes-file-preview-e2e-'))
  const fileDir = await fs.mkdtemp(path.join(os.tmpdir(), 'xinyue-notes-md-preview-e2e-'))
  const filePath = path.join(fileDir, '预览切换.md')
  const original = [
    '# 预览切换',
    '',
    '| 字段 | 说明 |',
    '| --- | --- |',
    '| 换行 | 单元格内保留 <br> 才算原文 |',
    '| 标记 | 单个星号 * 原样保留 |',
    '',
    '正文段落，带 `行内码` 与 **加粗**。',
    ''
  ].join('\n')
  let application

  try {
    await fs.writeFile(filePath, original, 'utf8')
    application = await launchApplication(userDataPath)
    await stubFileDialogs(application, { openPath: filePath })
    await openMarkdownFile(application.page, filePath)

    // 默认必须落在源码模式：用户第一眼看到的就是会被写回磁盘的那份内容。
    assert.equal(await modeButton(application.page, 0).getAttribute('aria-pressed'), 'true')
    assert.equal(await modeButton(application.page, 1).getAttribute('aria-pressed'), 'false')
    assert.equal(await application.page.locator('.markdown-source-editor__preview').count(), 0)
    assert.equal(await readFileEditorText(application.page), original)

    // 切到预览：表格要真的渲染成 table，而不是把竖线当普通文字排一行。
    await modeButton(application.page, 1).click()
    const preview = application.page.locator('.markdown-source-editor__preview')
    await preview.locator('table').waitFor()
    assert.deepEqual(await preview.locator('th').allInnerTexts(), ['字段', '说明'])
    assert.equal(await preview.locator('tbody tr').count(), 2)
    // 单元格里的 <br> 是原文的一部分，预览必须照实渲染而不是吃掉它。
    assert.match(await preview.locator('tbody tr').first().innerHTML(), /<br>/)
    assert.match(await preview.innerText(), /单个星号 \* 原样保留/)
    // 源码编辑器只是被收起，不能卸载：卸载会连光标、选区与撤销栈一起丢。
    assert.equal(await application.page.locator('.markdown-source-editor .cm-content').count(), 1)

    // 切回源码：正文一个字都没变，磁盘也始终没被碰过。
    await modeButton(application.page, 0).click()
    await application.page.locator('.markdown-source-editor .cm-content').waitFor()
    assert.equal(await application.page.locator('.markdown-source-editor__preview').count(), 0)
    assert.equal(await readFileEditorText(application.page), original)
    assert.equal(await fs.readFile(filePath, 'utf8'), original)
    assert.equal(await saveStatus(application.page).innerText(), '已保存')
  } finally {
    if (application) await application.electronApplication.close().catch(() => {})
    await fs.rm(userDataPath, { recursive: true, force: true })
    await fs.rm(fileDir, { recursive: true, force: true })
  }
})

test('预览模式：单元格里的块级写法渲染成真标题真列表，纯文本单元格不被误判', { timeout: 60_000 }, async () => {
  const userDataPath = await fs.mkdtemp(path.join(os.tmpdir(), 'xinyue-notes-file-cell-e2e-'))
  const fileDir = await fs.mkdtemp(path.join(os.tmpdir(), 'xinyue-notes-md-cell-e2e-'))
  const filePath = path.join(fileDir, '单元格块级.md')
  // 用户按钉钉文档的习惯写：单元格里用 `###` / `1.` / `*` 组织内容，用 <br> 分行。
  const original = [
    '| 原型 | 需求描述 |',
    '| --- | --- |',
    '| 图 | ### 大货订单<br>1. 数据<br>* 数据来源：获取领猫SCM<br>* 数据维度：一对一 |',
    '| 状态 | 1. 未开始 |',
    '| 备注 | * 号仓说明 |',
    ''
  ].join('\n')
  let application

  try {
    await fs.writeFile(filePath, original, 'utf8')
    application = await launchApplication(userDataPath)
    await stubFileDialogs(application, { openPath: filePath })
    await openMarkdownFile(application.page, filePath)

    await modeButton(application.page, 1).click()
    const preview = application.page.locator('.markdown-source-editor__preview')
    await preview.locator('table').waitFor()
    assert.equal(await preview.locator('tbody tr').count(), 3)

    // 第一行右格：块级语法复活成真元素。
    const richCell = preview.locator('tbody tr').nth(0).locator('td').nth(1)
    assert.equal(await richCell.locator('h3').innerText(), '大货订单')
    assert.equal(await richCell.locator('ol li').innerText(), '数据')
    assert.deepEqual(
      await richCell.locator('ul li').allInnerTexts(),
      ['数据来源：获取领猫SCM', '数据维度：一对一']
    )

    // 后两格以列表符号开头，但作者本意是纯文本，不能被渲染成列表。
    const statusCell = preview.locator('tbody tr').nth(1).locator('td').nth(1)
    assert.equal(await statusCell.innerText(), '1. 未开始')
    assert.equal(await statusCell.locator('ol, ul').count(), 0)
    const noteCell = preview.locator('tbody tr').nth(2).locator('td').nth(1)
    assert.equal(await noteCell.innerText(), '* 号仓说明')
    assert.equal(await noteCell.locator('ol, ul').count(), 0)

    // 整个表格结构完好，且磁盘未被改动。
    assert.equal(await preview.locator('table').count(), 1)
    assert.equal(await fs.readFile(filePath, 'utf8'), original)
  } finally {
    if (application) await application.electronApplication.close().catch(() => {})
    await fs.rm(userDataPath, { recursive: true, force: true })
    await fs.rm(fileDir, { recursive: true, force: true })
  }
})

test('源码模式：表格行内 Shift+Enter 插入 <br>，表格外仍是普通换行', { timeout: 60_000 }, async () => {
  const userDataPath = await fs.mkdtemp(path.join(os.tmpdir(), 'xinyue-notes-file-br-e2e-'))
  const fileDir = await fs.mkdtemp(path.join(os.tmpdir(), 'xinyue-notes-md-br-e2e-'))
  const filePath = path.join(fileDir, '硬换行.md')
  let application

  try {
    await fs.writeFile(filePath, '| a | b |\n| --- | --- |\n| 一格 | 二格 |\n', 'utf8')
    application = await launchApplication(userDataPath)
    await stubFileDialogs(application, { openPath: filePath })
    await openMarkdownFile(application.page, filePath)

    // 点表格正文那一行让光标落在行内（不能按 Meta+End：文件以换行结尾，光标会跑到最后的空行）。
    await application.page
      .locator('.markdown-source-editor .cm-line')
      .filter({ hasText: '一格' })
      .first()
      .click()
    await application.page.keyboard.press('Shift+Enter')
    await application.page.waitForTimeout(200)

    const afterTable = await readFileEditorText(application.page)
    const tableLines = afterTable.split('\n')
    // 三行表格结构不变，<br> 插在光标处而不是把行拆开。
    assert.equal(tableLines[0], '| a | b |')
    assert.equal(tableLines[1], '| --- | --- |')
    assert.match(tableLines[2], /^| 一格 | 二格 |<br>$/, `表格行内应插入 <br>，实际：${JSON.stringify(tableLines[2])}`)

    // 表格外的普通段落：Shift+Enter 保持默认换行，不该插 <br>。
    await application.page.keyboard.press('Meta+End')
    await application.page.keyboard.type('段落行')
    await application.page.keyboard.press('Shift+Enter')
    await application.page.waitForTimeout(200)

    const afterParagraph = await readFileEditorText(application.page)
    assert.match(afterParagraph, /段落行\n/, '表格外 Shift+Enter 应保持普通换行')
    assert.doesNotMatch(afterParagraph, /段落行<br>/, '表格外不该插入 <br>')
  } finally {
    if (application) await application.electronApplication.close().catch(() => {})
    await fs.rm(userDataPath, { recursive: true, force: true })
    await fs.rm(fileDir, { recursive: true, force: true })
  }
})

test('预览模式下查找自动切回源码并高亮匹配项', { timeout: 60_000 }, async () => {
  const userDataPath = await fs.mkdtemp(path.join(os.tmpdir(), 'xinyue-notes-file-preview-find-e2e-'))
  const fileDir = await fs.mkdtemp(path.join(os.tmpdir(), 'xinyue-notes-md-preview-find-e2e-'))
  const filePath = path.join(fileDir, '预览查找.md')
  let application

  try {
    await fs.writeFile(filePath, '# 预览查找\n\n预览里的关键词\n', 'utf8')
    application = await launchApplication(userDataPath)
    await stubFileDialogs(application, { openPath: filePath })
    await openMarkdownFile(application.page, filePath)

    await modeButton(application.page, 1).click()
    await application.page.locator('.markdown-source-editor__preview').waitFor()

    // 预览里 CodeMirror 是隐藏的，高亮看不见 —— 查找必须先带用户回到源码模式。
    await application.page.keyboard.press('Meta+f')
    const findBar = application.page.locator('.note-find-bar')
    await findBar.waitFor()
    await findBar.locator('input').fill('关键词')

    await application.page.waitForFunction(() => Boolean(document.querySelector('.cm-source-find-active')))
    assert.equal(await modeButton(application.page, 0).getAttribute('aria-pressed'), 'true')
    assert.equal(await application.page.locator('.markdown-source-editor__preview').count(), 0)
    assert.match(await findBar.innerText(), /1\/1/)
    // 切回源码后正文仍然完好。
    assert.equal(await readFileEditorText(application.page), '# 预览查找\n\n预览里的关键词\n')
  } finally {
    if (application) await application.electronApplication.close().catch(() => {})
    await fs.rm(userDataPath, { recursive: true, force: true })
    await fs.rm(fileDir, { recursive: true, force: true })
  }
})

test('本地文件的大纲：源码模式点标题定位光标，预览模式切章节，全程不改动文件', { timeout: 60_000 }, async () => {
  const userDataPath = await fs.mkdtemp(path.join(os.tmpdir(), 'xinyue-notes-file-outline-e2e-'))
  const fileDir = await fs.mkdtemp(path.join(os.tmpdir(), 'xinyue-notes-md-outline-e2e-'))
  const filePath = path.join(fileDir, '大纲测试.md')
  // 章节之间塞足够多的正文，让「跳到第三章」是一次真实的滚动而不是原地不动。
  const filler = (label) => Array.from({ length: 24 }, (_, index) => `${label}第 ${index + 1} 行正文`).join('\n\n')
  const original = [
    '# 第一章 开篇',
    '',
    filler('甲'),
    '',
    '## 第二章 展开',
    '',
    filler('乙'),
    '',
    '### 第三章 收尾',
    ''
  ].join('\n')
  let application

  try {
    await fs.writeFile(filePath, original, 'utf8')
    application = await launchApplication(userDataPath)
    await stubFileDialogs(application, { openPath: filePath })
    const { page } = application
    await openMarkdownFile(page, filePath)

    // 侧栏默认展开（偏好键与笔记共用，隔离数据目录里取的是默认值）。
    const items = page.locator('.markdown-source-editor .markdown-outline-item')
    await items.first().waitFor()
    // 几何尺寸要按「图标按钮 + 整列侧栏」来：两者曾经共用一个类名，按钮被撑成
    // 270px 宽的浅蓝条、侧栏被压成 26×26 的小方块，内容全被裁掉。
    const toggleBox = await page.locator('.markdown-source-editor__outline-toggle').boundingBox()
    assert.ok(toggleBox && toggleBox.width <= 40, `大纲开关应是窄图标按钮，实际宽 ${toggleBox?.width}`)
    const panelBox = await page.locator('aside.markdown-outline').boundingBox()
    assert.ok(
      panelBox && panelBox.width >= 200 && panelBox.height >= 200,
      `大纲侧栏应占满一列，实际 ${panelBox?.width}×${panelBox?.height}`
    )
    assert.deepEqual(
      (await items.allInnerTexts()).map((text) => text.trim()),
      ['第一章 开篇', '第二章 展开', '第三章 收尾']
    )
    // 层级要传下去：缩进靠 --outline-level，丢了三级标题会和一级一样平。
    assert.match(await items.nth(2).getAttribute('style'), /--outline-level:\s*3/)

    // 源码模式：点最后一项，光标必须真的落到那一行 —— 滚动位置与光标位置要一致。
    await items.nth(2).click()
    await page.waitForFunction(() =>
      document.querySelector('.markdown-source-editor .cm-activeLine')?.textContent?.trim() === '### 第三章 收尾')

    // 预览模式：同一份正文渲染出的标题也要能被大纲找到；点击只切高亮，不碰编辑区。
    await modeButton(page, 1).click()
    await page.locator('.markdown-source-editor__preview h3').waitFor()
    await page.locator('.markdown-source-editor .markdown-outline-item').first().click()
    await page.waitForFunction(() =>
      document.querySelector('.markdown-source-editor .markdown-outline-item.is-active')?.textContent?.trim() === '第一章 开篇')

    // 大纲与复制都是只读能力：翻遍章节也不能改动文件。
    // ⚠️ 这里断言磁盘而不是 `readFileEditorText`：CodeMirror 只渲染视口内的行，
    // 长文档读不全 —— 短文档才适合按 `.cm-line` 拼回全文。
    await modeButton(page, 0).click()
    await page.locator('.markdown-source-editor .cm-content').waitFor()
    assert.equal(await fs.readFile(filePath, 'utf8'), original)
    assert.equal(await saveStatus(page).innerText(), '已保存')
  } finally {
    if (application) await application.electronApplication.close().catch(() => {})
    await fs.rm(userDataPath, { recursive: true, force: true })
    await fs.rm(fileDir, { recursive: true, force: true })
  }
})
