/**
 * 「本机笔记地址转线上地址」端到端回归。
 *
 * 单测已经覆盖改写规则本身（围栏保护、missing / unsynced 分类、关系表不漂），
 * 这里要证明的是另外两件单测证明不了的事：
 *
 * 1. **渠道真的通**：preload 的通道名、ipc-handlers 的注册名与 main 的实现，
 *    三处只要有一处拼错，源码正则守卫照样全绿，但按钮点下去只会静默失败。
 * 2. **没有 serverId 时一条都不许改**：这是批量改写用户正文的功能，
 *    误改的代价远大于漏改 —— 必须证明「未同步的目标原地不动」在真应用里成立。
 *
 * 未登录的 e2e 环境恰好是这条红线的天然试验场：库里的笔记全都没有 serverId。
 */

const assert = require('node:assert/strict')
const fsSync = require('node:fs')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const { randomUUID } = require('node:crypto')

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
const DIAG_PATH = '/tmp/e2e-local-note-links-diag.txt'
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

test('本机地址转换：渠道通，且未同步的目标一条都不改', { timeout: 120000 }, async () => {
  fsSync.writeFileSync(DIAG_PATH, '')
  const userDataPath = await fs.mkdtemp(path.join(os.tmpdir(), 'xinyue-e2e-local-links-'))
  let application
  try {
    diag('step', 'launch')
    const launched = await launchApplication(userDataPath)
    application = launched.electronApplication
    const page = launched.page
    diag('step', 'launched')

    const seeded = await page.evaluate(async () => {
      const ghostId = '00000000-0000-4000-8000-000000000000'
      const target = await window.notesDesktop.createNote(null)
      const source = await window.notesDesktop.createNote(null)
      const content = [
        `见 [已不存在的目标](https://xinyue-note.local/${ghostId})`,
        `与 [尚未同步的目标](https://xinyue-note.local/${target.id})`
      ].join('\n\n')
      const updated = await window.notesDesktop.updateNote(source.id, { title: '索引', content })
      return { sourceId: source.id, targetId: target.id, content: updated?.content ?? content }
    })
    diag('step', 'seeded')
    diag('seeded', seeded)

    // ① 预览：渠道通 + 分类正确。库里的笔记全都没有 serverId，所以可转条数必须是 0。
    const preview = await page.evaluate(() => window.notesDesktop.previewLocalNoteLinkRewrite())
    diag('step', 'previewed')
    diag('preview', preview)
    assert.equal(typeof preview.scannedNotes, 'number')
    assert.equal(preview.scannedNotes >= 2, true)
    assert.equal(preview.linkedNotes, 1)
    assert.equal(preview.totalLinks, 2)
    assert.equal(preview.convertibleNotes, 0)
    assert.equal(preview.convertibleLinks, 0)
    assert.equal(preview.missingLinks, 1)
    assert.equal(preview.unsyncedLinks, 1)

    // ② 执行：不报错、不改任何正文。
    const result = await page.evaluate(() => window.notesDesktop.rewriteLocalNoteLinks())
    diag('step', 'rewritten')
    diag('result', result)
    assert.equal(result.canceled, false)
    assert.equal(result.noteCount, 0)
    assert.equal(result.linkCount, 0)
    assert.match(result.message, /没有需要转换的本机笔记地址/)

    const stored = await page.evaluate((noteId) => window.notesDesktop.getNote(noteId), seeded.sourceId)
    diag('stored', { content: stored?.content, title: stored?.title })
    assert.equal(stored.content, seeded.content, '未同步的目标笔记地址一条都不许改')

    // ③ 空库/无关库上再跑一次也必须安全（幂等，不抛错）。
    const again = await page.evaluate(() => window.notesDesktop.previewLocalNoteLinkRewrite())
    diag('again', again.convertibleLinks)
    assert.equal(again.convertibleLinks, 0)
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
      // 子进程活着会让 `node --test` 永不退出（本轮为此白等过两个 4 分钟）。
      await Promise.race([
        application.close().catch(() => {}),
        new Promise((resolve) => setTimeout(resolve, 10000))
      ])
      if (child && child.exitCode === null && !child.killed) child.kill('SIGKILL')
    }
    await fs.rm(userDataPath, { recursive: true, force: true }).catch(() => {})
  }
})
