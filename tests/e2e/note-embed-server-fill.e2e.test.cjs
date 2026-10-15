/**
 * 「嵌入卡片补线上标识」端到端回归。
 *
 * 单测覆盖了回填规则本身（幂等、围栏保护、missing / unsynced 分类、逐字节不动），
 * 这里要证明的是单测证明不了的三件事：
 *
 * 1. **渠道真的通**：preload 通道名、ipc-handlers 注册名与 main 实现三处必须一致 ——
 *   源码正则守卫全绿也拦不住「点下去静默失败」。
 * 2. **正向路径真的会写库**：单测只能对着纯函数断言，这里要看到属性真的落进
 *    `notes.content`，且**本机 ID 原样保留**（桌面端的解析键不能动）。
 * 3. **未同步 / 目标不存在的卡片一张都不许改**：这是批量改写用户正文的功能，
 *    误改的代价远大于漏改。
 *
 * 另有一组**编辑态往返**（第二组用例）：新属性必须能从正文读进编辑器、再原样写回。
 * 只要往返丢属性，用户在桌面端随手改一个字就会把网页端的卡片打回占位 —— 这是本功能
 * 最要命的回归，而定位于「源码正则」的单测完全拦不住。
 *
 * 正向路径需要 `server_id`，而它只能由同步结果写入、仓库层没有公开入口 ——
 * 所以这里用第二个 sqlite 连接直接落库（与 tests/local-note-links.test.cjs 同法）。
 * e2e 用户数据目录由 `XINYUE_NOTES_E2E_USER_DATA` 决定，库在其下的**档案子目录**里。
 */

const assert = require('node:assert/strict')
const fsSync = require('node:fs')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const Database = require('better-sqlite3')

const { _electron: electron } = require('playwright')

const projectRoot = path.resolve(__dirname, '../..')
const extraLaunchArgs = (process.env.XINYUE_E2E_ELECTRON_ARGS || '').split(/\s+/).filter(Boolean)

/**
 * 诊断落盘。
 *
 * ⚠️ 不能用 `console.log`：`node --test` 的 stdout 被重定向时是**块缓冲**，
 * 一旦用例尾部悬挂（Electron 没关掉），缓冲区永远不会 flush，失败详情就全丢了。
 * 同步写文件不受缓冲影响。
 */
const DIAG_PATH = '/tmp/e2e-note-embed-server-fill-diag.txt'
function diag(label, value) {
  fsSync.appendFileSync(DIAG_PATH, `${label} = ${JSON.stringify(value)}\n`)
}

async function launchApplication(userDataPath) {
  const electronApplication = await electron.launch({
    args: [...extraLaunchArgs, projectRoot],
    cwd: projectRoot,
    env: { ...process.env, NODE_ENV: 'test', XINYUE_NOTES_E2E_USER_DATA: userDataPath }
  })
  const page = await electronApplication.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  await page.waitForFunction(() => Boolean(window.notesDesktop))
  return { electronApplication, page }
}

/**
 * 在用户数据目录下递归找出所有 `notes.sqlite3`。
 *
 * ⚠️ 库**不在** userData 根目录：主进程按「后端地址 + 账号」分档案，
 * `openBackendRepository` 会把库建在 profile 子目录里（见 electron/main.cjs）。
 * 所以只能扫，不能按固定路径拼。
 *
 * :param {string} directory 起始目录。
 * @returns {string[]} 找到的数据库文件绝对路径。
 */
function findNoteDatabases(directory) {
  const found = []
  const walk = (current) => {
    let entries = []
    try {
      entries = fsSync.readdirSync(current, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (entry.name === 'notes.sqlite3') found.push(full)
    }
  }
  walk(directory)
  return found
}

/**
 * 用第二个连接把笔记标记成「已同步到云端」。
 *
 * 与 `tests/local-note-links.test.cjs` 的 helper 同法：sqlite 允许多连接，
 * 写完即关，不与应用本身的连接抢锁。
 *
 * :param {string} userDataPath e2e 用户数据目录。
 * :param {string} noteId 目标笔记 ID。
 * :param {string} serverId 云端主键。
 * @returns {number} 实际被更新的行数（0 表示没在任何一个档案库里命中）。
 */
function markNoteSynced(userDataPath, noteId, serverId) {
  let updated = 0
  for (const databasePath of findNoteDatabases(userDataPath)) {
    const connection = new Database(databasePath, { readonly: false })
    try {
      const result = connection
        .prepare('UPDATE notes SET server_id = ? WHERE id = ?')
        .run(serverId, noteId)
      updated += result.changes
    } catch {
      // 该档案库里没有 notes 表（例如扫描到的空文件）——换个库继续。
    } finally {
      connection.close()
    }
  }
  return updated
}

test('嵌入卡片补线上标识：渠道通，补上有序，未同步与失联的卡片一张都不改', { timeout: 120000 }, async () => {
  fsSync.writeFileSync(DIAG_PATH, '')
  const userDataPath = await fs.mkdtemp(path.join(os.tmpdir(), 'xinyue-e2e-embed-fill-'))
  let application
  try {
    diag('step', 'launch')
    const launched = await launchApplication(userDataPath)
    application = launched.electronApplication
    const page = launched.page
    diag('step', 'launched')

    // 目标（会被标记成已同步）、失联目标（不存在），以及引用它们的来源笔记。
    const seeded = await page.evaluate(async () => {
      const ghostId = '00000000-0000-4000-8000-000000000000'
      const target = await window.notesDesktop.createNote(null)
      const source = await window.notesDesktop.createNote(null)
      const content = [
        `<div data-xynote-embed="note:${target.id}" title="接口文档"></div>`,
        `<div data-xynote-embed="note:${ghostId}" title="已删除的笔记"></div>`
      ].join('\n\n')
      const updated = await window.notesDesktop.updateNote(source.id, { title: '索引', content })
      return { sourceId: source.id, targetId: target.id, ghostId, content: updated?.content ?? content }
    })
    diag('step', 'seeded')
    diag('seeded', seeded)

    // ① 先跑一次「全都没同步」的预览：这一档是红线 —— 可补必须是 0。
    const beforeSync = await page.evaluate(() => window.notesDesktop.previewEmbedServerIdFill())
    diag('preview.beforeSync', beforeSync)
    assert.equal(typeof beforeSync.scannedNotes, 'number')
    assert.equal(beforeSync.totalEmbeds, 2)
    assert.equal(beforeSync.fillableEmbeds, 0)
    assert.equal(beforeSync.unsyncedEmbeds, 1)
    assert.equal(beforeSync.missingEmbeds, 1)

    // ② 放开目标：把它标记为已同步，再从渲染层走一遍真实渠道。
    const synced = markNoteSynced(userDataPath, seeded.targetId, '9001')
    diag('step', 'marked-synced')
    diag('markedRows', synced)
    assert.equal(synced, 1, '必须先真的把目标标记为已同步，否则下面的正向断言没有意义')

    const preview = await page.evaluate(() => window.notesDesktop.previewEmbedServerIdFill())
    diag('preview', preview)
    assert.equal(preview.fillableEmbeds, 1)
    assert.equal(preview.convertibleNotes, 1)
    assert.equal(preview.unsyncedEmbeds, 0)
    assert.equal(preview.missingEmbeds, 1)

    // ③ 执行：真的落库，且本机 ID 原样。
    const result = await page.evaluate(() => window.notesDesktop.fillEmbedServerIds())
    diag('step', 'filled')
    diag('result', result)
    assert.equal(result.canceled, false)
    assert.equal(result.noteCount, 1)
    assert.equal(result.embedCount, 1)
    assert.match(result.message, /已为 1 篇笔记中的 1 张嵌入卡片补上线上标识/)

    const stored = await page.evaluate((noteId) => window.notesDesktop.getNote(noteId), seeded.sourceId)
    diag('stored', { content: stored?.content })
    // 新属性补上了，且紧跟在本机 ID 之后。
    assert.match(
      stored.content,
      new RegExp(
        `<div data-xynote-embed="note:${seeded.targetId}" data-xynote-embed-server="9001" title="接口文档"></div>`
      )
    )
    // 失联的那张卡原样不动（本机 ID 保留、不加属性）。
    assert.match(
      stored.content,
      new RegExp(`<div data-xynote-embed="note:${seeded.ghostId}" title="已删除的笔记"></div>`)
    )

    // ④ 幂等：再跑一次没有任何可补的，正文逐字节不变。
    const again = await page.evaluate(() => window.notesDesktop.previewEmbedServerIdFill())
    diag('again', again)
    assert.equal(again.fillableEmbeds, 0)
    assert.equal(again.alreadyFilledEmbeds, 1)
    const second = await page.evaluate(() => window.notesDesktop.fillEmbedServerIds())
    assert.equal(second.noteCount, 0)
    const storedAgain = await page.evaluate((noteId) => window.notesDesktop.getNote(noteId), seeded.sourceId)
    assert.equal(storedAgain.content, stored.content, '幂等：重复回填不许再动正文')
    diag('step', 'done')
  } catch (error) {
    diag('ERROR', {
      name: error?.name,
      message: error?.message,
      expected: error?.expected,
      actual: error?.actual,
      stack: String(error?.stack || '').split('\n').slice(0, 6).join(' | ')
    })
    throw error
  } finally {
    if (application) {
      // 🔴 必须**先**取子进程句柄：`close()` 之后连接就断了，再调 `process()` 会抛
      // `Cannot read properties of undefined (reading '_object')`。
      let child = null
      try {
        child = application.process()
      } catch {
        child = null
      }
      // ⚠️ close() 在应用状态异常时可能长时间不返回。加时限 + 强杀兜底 ——
      // 子进程活着会让 `node --test` 永不退出。
      await Promise.race([
        application.close().catch(() => {}),
        new Promise((resolve) => setTimeout(resolve, 10000))
      ])
      if (child && child.exitCode === null && !child.killed) child.kill('SIGKILL')
    }
    await fs.rm(userDataPath, { recursive: true, force: true }).catch(() => {})
  }
})

/**
 * 在侧栏点开指定标题的笔记，并等编辑器就绪。
 *
 * :param {import('playwright').Page} page 渲染层页面。
 * :param {string} title 笔记标题。
 * @return {Promise<void>}
 */
async function openNoteByTitle(page, title) {
  const unclassified = page.getByRole('button', { name: /未分类/ }).first()
  if ((await unclassified.getAttribute('aria-expanded')) === 'false') await unclassified.click()
  await page.waitForSelector('.navigation-panel .sidebar-note-main')
  await page.locator('.navigation-panel .sidebar-note-main').filter({ hasText: title }).first().click()
  await page.locator('.milkdown-editor-root .ProseMirror').waitFor()
  await page.waitForTimeout(900)
}

test('嵌入卡片编辑态往返：渲染成卡片而不是源码文本，改别处再保存也不丢标识与标题快照', { timeout: 120000 }, async () => {
  fsSync.writeFileSync(DIAG_PATH, '')
  const userDataPath = await fs.mkdtemp(path.join(os.tmpdir(), 'xinyue-e2e-embed-roundtrip-'))
  let application
  try {
    diag('step', 'launch')
    const launched = await launchApplication(userDataPath)
    application = launched.electronApplication
    const page = launched.page
    diag('step', 'launched')

    // 直接以「已补好标识」的形态落库：模拟回填之后、或新插入的卡片。
    const seeded = await page.evaluate(async () => {
      const target = await window.notesDesktop.createNote(null)
      const source = await window.notesDesktop.createNote(null)
      const content = [
        '索引',
        '',
        `<div data-xynote-embed="note:${target.id}" data-xynote-embed-server="9001" title="接口文档"></div>`,
        '',
        '末尾段落。',
        ''
      ].join('\n')
      const updated = await window.notesDesktop.updateNote(source.id, { title: '往返测试', content })
      return { sourceId: source.id, targetId: target.id, content: updated?.content ?? content }
    })
    diag('step', 'seeded')
    diag('seeded', seeded)

    await page.reload()
    await page.waitForFunction(() => Boolean(window.notesDesktop))
    await openNoteByTitle(page, '往返测试')
    diag('step', 'opened')

    // ① 卡片必须渲染成卡片：源码文本不该出现在编辑器里。
    const cardCount = await page.locator('.milkdown-editor-root .ProseMirror .note-embed-card').count()
    diag('cardCount', cardCount)
    assert.equal(cardCount, 1, '嵌入卡应渲染成卡片节点')

    const editorText = await page.locator('.milkdown-editor-root .ProseMirror').innerText()
    diag('editorText', editorText)
    assert.equal(
      editorText.includes('data-xynote-embed'),
      false,
      '嵌入卡不该以 html 源码文本形式出现'
    )

    // ② 在别处改一个字并等自动保存真的落库。
    await page.locator('.milkdown-editor-root .ProseMirror p').last().click()
    await page.keyboard.type('（已改）')
    diag('step', 'typed')

    let stored = null
    for (let attempt = 0; attempt < 40; attempt += 1) {
      stored = await page.evaluate((noteId) => window.notesDesktop.getNote(noteId), seeded.sourceId)
      if (stored?.content?.includes('（已改）')) break
      await page.waitForTimeout(250)
    }
    diag('stored', { content: stored?.content })
    assert.ok(stored?.content?.includes('（已改）'), '自动保存应把改动写回正文')

    // ③ 三个属性必须原样写回：本机 ID、跨端标识、标题快照一个都不能丢，顺序也不漂
    //    （顺序漂了两端的解析口径就得各写一份）。
    //    🔴 `title` 是 10-13 修的既有缺口：transformer 早先只从 html 取 noteId、后来加了
    //       serverId，**从未取过 title** → 编辑一次就把 `title="..."` 从正文里抹掉。
    //       桌面端卡片靠目标笔记实时取标题、看不出异常；受损的是网页端取数失败时的兜底标题。
    assert.match(
      stored.content,
      new RegExp(
        `<div data-xynote-embed="note:${seeded.targetId}" data-xynote-embed-server="9001" title="接口文档"></div>`
      ),
      '编辑往返后本机 ID、跨端标识与标题快照都必须原样保留'
    )
    // 原文的其余部分不该被顺手改写。
    assert.ok(stored.content.startsWith('索引'), '卡片前的段落应保持原样')
    diag('step', 'done')
  } catch (error) {
    diag('ERROR', {
      name: error?.name,
      message: error?.message,
      expected: error?.expected,
      actual: error?.actual,
      stack: String(error?.stack || '').split('\n').slice(0, 6).join(' | ')
    })
    throw error
  } finally {
    if (application) {
      let child = null
      try {
        child = application.process()
      } catch {
        child = null
      }
      await Promise.race([
        application.close().catch(() => {}),
        new Promise((resolve) => setTimeout(resolve, 10000))
      ])
      if (child && child.exitCode === null && !child.killed) child.kill('SIGKILL')
    }
    await fs.rm(userDataPath, { recursive: true, force: true }).catch(() => {})
  }
})

/**
 * 第三组用例：**网页端插入的卡片**（只有 `data-xynote-embed-server`）在桌面端的编辑态表现。
 *
 * 为什么要单独一组：上面那组往返用例用的是**两个属性都在**的形态，而线上真实存在的
 * 「网页端插入 → 同步下来」的卡片**只有跨端标识**（用户库里那篇「无标题笔记 副本」就是它）。
 * 这一形态同时踩两个坑：
 *   ① 解析层若只认 `data-xynote-embed`，卡片会退化成 html 源码文本（比「显示不存在」更糟）；
 *   ② 取数若只按本机 id 查，卡片会显示「此笔记不存在」。
 * 两者都不是源码正则守卫能拦住的，必须走真实链路。
 */
test('只有跨端标识的卡片（网页端插入）也渲染成卡片，且往返不补出 note: 空值', { timeout: 120000 }, async () => {
  fsSync.writeFileSync(DIAG_PATH, '')
  const userDataPath = await fs.mkdtemp(path.join(os.tmpdir(), 'xinyue-e2e-embed-server-only-'))
  let application
  try {
    diag('step', 'launch')
    const launched = await launchApplication(userDataPath)
    application = launched.electronApplication
    const page = launched.page
    diag('step', 'launched')

    // 网页端没有本机 uuid，插入时**只**写 data-xynote-embed-server —— 逐字节复刻线上形态。
    const seeded = await page.evaluate(async () => {
      const target = await window.notesDesktop.createNote(null)
      const source = await window.notesDesktop.createNote(null)
      const content = [
        '索引',
        '',
        '<div data-xynote-embed-server="55501" title="接口文档"></div>',
        '',
        '末尾段落。',
        ''
      ].join('\n')
      const updated = await window.notesDesktop.updateNote(source.id, { title: '纯跨端卡片', content })
      return { sourceId: source.id, targetId: target.id, content: updated?.content ?? content }
    })
    diag('step', 'seeded')
    diag('seeded', seeded)

    // 目标笔记带上 server_id：卡片取数靠 `getNote` 的 server_id 回落命中。
    const synced = markNoteSynced(userDataPath, seeded.targetId, '55501')
    diag('markedRows', synced)
    assert.equal(synced, 1, '必须真的把目标标记为已同步，否则下面的正向断言没有意义')

    await page.reload()
    await page.waitForFunction(() => Boolean(window.notesDesktop))
    await openNoteByTitle(page, '纯跨端卡片')
    diag('step', 'opened')

    // ① 必须渲染成卡片，而不是一段 html 源码文本。
    const cardCount = await page.locator('.milkdown-editor-root .ProseMirror .note-embed-card').count()
    diag('cardCount', cardCount)
    assert.equal(cardCount, 1, '只有跨端标识的卡片也必须渲染成卡片节点')

    const editorText = await page.locator('.milkdown-editor-root .ProseMirror').innerText()
    diag('editorText', editorText)
    assert.equal(
      editorText.includes('data-xynote-embed'),
      false,
      '卡片不该退化成 html 源码文本'
    )

    // ② 取数必须走 server_id 回落：不能是「此笔记不存在」。
    const cardText = await page
      .locator('.milkdown-editor-root .ProseMirror .note-embed-card')
      .first()
      .innerText()
    diag('cardText', cardText)
    assert.equal(cardText.includes('此笔记不存在'), false, 'server_id 回落没生效')

    // ③ 改一个字并保存：形态必须原样 —— **不许**补出 `data-xynote-embed="note:"` 空值。
    await page.locator('.milkdown-editor-root .ProseMirror p').last().click()
    await page.keyboard.type('（已改）')
    diag('step', 'typed')

    let stored = null
    for (let attempt = 0; attempt < 40; attempt += 1) {
      stored = await page.evaluate((noteId) => window.notesDesktop.getNote(noteId), seeded.sourceId)
      if (stored?.content?.includes('（已改）')) break
      await page.waitForTimeout(250)
    }
    diag('stored', { content: stored?.content })
    assert.ok(stored?.content?.includes('（已改）'), '自动保存应把改动写回正文')
    assert.match(
      stored.content,
      /<div data-xynote-embed-server="55501" title="接口文档"><\/div>/,
      '往返后跨端标识与标题快照必须原样保留'
    )
    assert.equal(
      stored.content.includes('data-xynote-embed='),
      false,
      '不许给网页端插入的卡片补出 data-xynote-embed 空值'
    )
    diag('step', 'done')
  } catch (error) {
    diag('ERROR', {
      name: error?.name,
      message: error?.message,
      expected: error?.expected,
      actual: error?.actual,
      stack: String(error?.stack || '').split('\n').slice(0, 6).join(' | ')
    })
    throw error
  } finally {
    if (application) {
      let child = null
      try {
        child = application.process()
      } catch {
        child = null
      }
      await Promise.race([
        application.close().catch(() => {}),
        new Promise((resolve) => setTimeout(resolve, 10000))
      ])
      if (child && child.exitCode === null && !child.killed) child.kill('SIGKILL')
    }
    await fs.rm(userDataPath, { recursive: true, force: true }).catch(() => {})
  }
})
