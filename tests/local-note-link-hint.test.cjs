const assert = require("node:assert/strict")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const test = require("node:test")
const Database = require("better-sqlite3")
const { openNotesDatabase } = require("../electron/database.cjs")

const WEB_BASE = "https://lovethewind.cn"

/**
 * 在隔离临时目录中打开真实笔记库，并把「写 server_id」的能力交给测试。
 *
 * server_id 只能由同步结果写入，仓库层没有公开入口，所以这里用第二个连接直接落库
 * （sqlite 允许多连接，写完即关，不与仓库连接抢锁）。
 *
 * :param {(repository: any, helpers: { setServerId: (noteId: string, serverId: string) => void }) => void} run 测试逻辑。
 * :return: 无返回值。
 */
function withRepository(run) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "ltw-note-link-hint-"))
  const repository = openNotesDatabase(directory)
  const helpers = {
    setServerId(noteId, serverId) {
      const connection = new Database(path.join(directory, "notes.sqlite3"))
      try {
        connection.prepare("UPDATE notes SET server_id = ? WHERE id = ?").run(serverId, noteId)
      } finally {
        connection.close()
      }
    }
  }
  try {
    run(repository, helpers)
  } finally {
    repository.close()
    fs.rmSync(directory, { recursive: true, force: true })
  }
}

/**
 * 造一篇「引用了本机地址」的笔记。
 *
 * :param {any} repository 仓库对象。
 * :param {string[]} targetIds 被引用的本机笔记 ID。
 * :return {Record<string, any>} 新建的引用方笔记。
 */
function createNoteLinkingTo(repository, targetIds) {
  const source = repository.createNote(null)
  const content = targetIds.map((id) => `见 [目标](https://xinyue-note.local/${id})`).join("\n\n")
  repository.updateNote(source.id, { content })
  return repository.getNote(source.id)
}

// ---------------------------------------------------------------------------
// previewLocalNoteLinkHint：同步完成后的提示范围
// ---------------------------------------------------------------------------

test("库里根本没有本机地址时不出声", () => {
  withRepository((repository) => {
    const note = repository.createNote(null)
    repository.updateNote(note.id, { content: "普通正文，[外链](https://example.com/a)" })

    assert.equal(repository.previewLocalNoteLinkHint(WEB_BASE), null)
  })
})

test("有本机地址但目标还没同步：转不了，也不出声", () => {
  withRepository((repository) => {
    const target = repository.createNote(null)
    createNoteLinkingTo(repository, [target.id])

    assert.equal(repository.previewLocalNoteLinkHint(WEB_BASE), null)
    // 同口径的凭据：这条确实是「目标未同步」而不是「根本没识别到」。
    assert.equal(repository.previewLocalNoteLinkRewrite(WEB_BASE).unsyncedLinks, 1)
  })
})

test("目标同步上来之后给出可转范围", () => {
  withRepository((repository, helpers) => {
    const target = repository.createNote(null)
    createNoteLinkingTo(repository, [target.id])
    helpers.setServerId(target.id, "9001")

    assert.deepEqual(repository.previewLocalNoteLinkHint(WEB_BASE), {
      convertibleNotes: 1,
      convertibleLinks: 1,
      unsyncedLinks: 0,
      missingLinks: 0
    })
  })
})

test("提示里的条数与「本机地址转为线上地址」的预览完全一致", () => {
  withRepository((repository, helpers) => {
    const synced = repository.createNote(null)
    const unsynced = repository.createNote(null)
    createNoteLinkingTo(repository, [synced.id, synced.id, unsynced.id, "不存在的笔记"])
    helpers.setServerId(synced.id, "9001")

    const hint = repository.previewLocalNoteLinkHint(WEB_BASE)
    const preview = repository.previewLocalNoteLinkRewrite(WEB_BASE)

    assert.equal(hint.convertibleNotes, preview.convertibleNotes)
    assert.equal(hint.convertibleLinks, preview.convertibleLinks)
    assert.equal(hint.unsyncedLinks, preview.unsyncedLinks)
    assert.equal(hint.missingLinks, preview.missingLinks)
    // 同一目标被引用两次要算两条。
    assert.equal(hint.convertibleLinks, 2)
    assert.equal(hint.missingLinks, 1)
  })
})

test("没配置网页地址时不出声（此时一条也转不了）", () => {
  withRepository((repository, helpers) => {
    const target = repository.createNote(null)
    createNoteLinkingTo(repository, [target.id])
    helpers.setServerId(target.id, "9001")

    assert.equal(repository.previewLocalNoteLinkHint(""), null)
    assert.equal(repository.previewLocalNoteLinkHint(undefined), null)
  })
})

test("围栏代码块里的本机地址不算进来（提示数与改写口径同源）", () => {
  withRepository((repository, helpers) => {
    const target = repository.createNote(null)
    helpers.setServerId(target.id, "9001")
    const source = repository.createNote(null)
    repository.updateNote(source.id, {
      content: ["```md", `[示例](https://xinyue-note.local/${target.id})`, "```"].join("\n")
    })

    // SQL 的 LIKE 会捞到这篇（正文里确实有那个字符串），但改写口径把它当代码块跳过 → 一条都不算。
    assert.equal(repository.previewLocalNoteLinkHint(WEB_BASE), null)
  })
})

// ---------------------------------------------------------------------------
// applySyncResult：本轮新拿到 serverId 的笔记
// ---------------------------------------------------------------------------

/**
 * 造一份最小的同步结果载荷。
 *
 * :param {Array<{ entityType?: string, clientId: string, serverId: string }>} mappings 映射表。
 * :return {Record<string, any>} 同步结果。
 */
function syncResultWith(mappings) {
  return { snapshot: { folders: [], tags: [], notes: [] }, mappings, conflictClientIds: [] }
}

test("本轮首次拿到 serverId 的笔记会被认出来", () => {
  withRepository((repository) => {
    const first = repository.createNote(null)
    const second = repository.createNote(null)

    const applied = repository.applySyncResult(
      syncResultWith([
        { entityType: "note", clientId: first.id, serverId: "9001" },
        { entityType: "note", clientId: second.id, serverId: "9002" }
      ]),
      []
    )

    assert.deepEqual(applied.newlySyncedNoteIds.sort(), [first.id, second.id].sort())
    assert.equal(repository.getNote(first.id).serverId, "9001")
  })
})

test("已经有 serverId 的笔记再次出现在映射里不算「新同步」", () => {
  withRepository((repository, helpers) => {
    const already = repository.createNote(null)
    const fresh = repository.createNote(null)
    helpers.setServerId(already.id, "8001")

    const applied = repository.applySyncResult(
      syncResultWith([
        { entityType: "note", clientId: already.id, serverId: "8001" },
        { entityType: "note", clientId: fresh.id, serverId: "9002" }
      ]),
      []
    )

    // 只有真正从「没有」变成「有」的才算 —— 否则每次同步都会去扫一遍全库。
    assert.deepEqual(applied.newlySyncedNoteIds, [fresh.id])
  })
})

test("文件夹 / 标签的映射不算进笔记清单，空 serverId 也不算", () => {
  withRepository((repository) => {
    const folder = repository.createFolder("资料")
    const note = repository.createNote(null)

    const applied = repository.applySyncResult(
      syncResultWith([
        { entityType: "folder", clientId: folder.id, serverId: "7001" },
        { entityType: "note", clientId: note.id, serverId: "" }
      ]),
      []
    )

    assert.deepEqual(applied.newlySyncedNoteIds, [])
  })
})

test("没有 mappings 时返回空清单，不炸", () => {
  withRepository((repository) => {
    const applied = repository.applySyncResult({ snapshot: { folders: [], tags: [], notes: [] } }, [])
    assert.deepEqual(applied.newlySyncedNoteIds, [])
  })
})

// ---------------------------------------------------------------------------
// 接线守卫：真行为在真库与网络上，这里钉住最容易被重构丢掉的几处粘合
// ---------------------------------------------------------------------------

const projectRoot = path.resolve(__dirname, "..")
const readSource = (filePath) => fs.readFileSync(path.resolve(projectRoot, filePath), "utf8")

test("同步链路只在「本轮有新笔记拿到 serverId」时才去算提示", () => {
  const main = readSource("electron/main.cjs")
  const start = main.indexOf("async function performSync()")
  const end = main.indexOf("function scheduleSync()")
  assert.ok(start >= 0 && end > start, "没定位到 performSync 函数体")
  const performSyncBody = main.slice(start, end)

  assert.match(performSyncBody, /if \(applied\.newlySyncedNoteIds\?\.length\) \{/)
  assert.match(performSyncBody, /const localLinkHint = repository\.previewLocalNoteLinkHint\(syncSettings\.webUrl\)/)
  assert.match(performSyncBody, /if \(localLinkHint\) lastResult\.localLinkHint = localLinkHint/)
  // ⚠️ 反面：同步路径**绝不**自动改写正文 —— 改成自动的会反复 dirty + 入队（同步环），
  // 也与 docs/specs/2026-09-05-note-link-online-url.md 的「存量不清扫、不迁移」冲突。
  assert.doesNotMatch(performSyncBody, /rewriteLocalNoteLinks/)
})

test("「去转换」落回数据管理里既有的二次确认，不另起一套 UI", () => {
  const app = readSource("src/App.vue")
  const start = app.indexOf("async function openLocalLinkRewriteFromSync()")
  assert.ok(start >= 0, "没找到 openLocalLinkRewriteFromSync")
  const body = app.slice(start, app.indexOf("const linkRewriteSkippedSummary"))

  // 顺序要紧：openDataTransfer() 会把 linkRewritePreview 重置成 null，预览必须排在它后面。
  assert.match(body, /syncDialogVisible\.value = false/)
  assert.match(body, /openDataTransfer\(\)[\s\S]*?await previewLocalNoteLinkRewrite\(\)/)
  // 反面：这里只负责把人带过去，改写动作必须由用户在确认块里点。
  assert.doesNotMatch(body, /rewriteLocalNoteLinks/)
})

test("同步完成面板渲染提示，并带上「去转换」按钮", () => {
  const app = readSource("src/App.vue")

  assert.match(app, /v-if="syncStatus\.lastResult\.localLinkHint" class="sync-result-local-links"/)
  assert.match(app, /@click="openLocalLinkRewriteFromSync"/)
  assert.match(app, /syncStatus\.lastResult\.localLinkHint\.convertibleLinks/)
  // 目标未同步的那部分要单独说一句，否则用户会以为「怎么没转干净」。
  assert.match(app, /syncStatus\.lastResult\.localLinkHint\.unsyncedLinks/)
})

test("提示块有样式，且同步结果的类型定义跟着走", () => {
  const style = readSource("src/style.css")
  const types = readSource("src/types.ts")

  assert.match(style, /\.sync-result-local-links \{/)
  assert.match(style, /\.sync-result-local-links button \{/)
  assert.match(types, /export interface SyncLocalLinkHint \{/)
  assert.match(types, /localLinkHint\?: SyncLocalLinkHint \| null/)
})
