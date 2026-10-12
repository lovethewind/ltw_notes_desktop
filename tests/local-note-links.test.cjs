const assert = require("node:assert/strict")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const test = require("node:test")
const Database = require("better-sqlite3")
const { openNotesDatabase } = require("../electron/database.cjs")
const { rewriteLocalNoteLinksInContent } = require("../electron/local-note-links.cjs")

const WEB_BASE = "https://lovethewind.cn"

/**
 * 构造一个按 ID 表查目标的解析器：表里没有的 ID 视为「笔记已不存在」，
 * 值为 null 表示「笔记存在但未同步到云端」。
 *
 * :param {Record<string, string | null>} table 目标表。
 * :return {(noteId: string) => { id: string, serverId: string | null } | null} 解析器。
 */
function resolverFrom(table) {
  return (targetId) =>
    Object.hasOwn(table, targetId) ? { id: targetId, serverId: table[targetId] } : null
}

/**
 * 在隔离临时目录中打开真实笔记库，并把「写 server_id」「清空关系表」的能力交给测试。
 *
 * server_id 只能由同步结果写入，仓库层没有公开入口，所以这里用第二个连接直接落库
 * （sqlite 允许多连接，写完即关，不与仓库连接抢锁）。
 *
 * :param {(repository: any, helpers: { setServerId: (noteId: string, serverId: string) => void, clearNoteLinks: () => void }) => void} run 测试逻辑。
 * :return: 无返回值。
 */
function withRepository(run) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "ltw-local-note-links-"))
  const repository = openNotesDatabase(directory)
  /** 用第二个连接执行一次性的库内改写。 */
  const withConnection = (statement) => {
    const connection = new Database(path.join(directory, "notes.sqlite3"))
    try {
      statement(connection)
    } finally {
      connection.close()
    }
  }
  const helpers = {
    setServerId(noteId, serverId) {
      withConnection((connection) => {
        connection.prepare("UPDATE notes SET server_id = ? WHERE id = ?").run(serverId, noteId)
      })
    },
    clearNoteLinks() {
      withConnection((connection) => {
        connection.prepare("DELETE FROM note_links").run()
      })
    }
  }
  try {
    run(repository, helpers)
  } finally {
    repository.close()
    fs.rmSync(directory, { recursive: true, force: true })
  }
}

// ---------------------------------------------------------------------------
// 纯函数：改写口径
// ---------------------------------------------------------------------------

test("目标已同步时把本机地址改写成网页地址", () => {
  const outcome = rewriteLocalNoteLinksInContent("见 [接口文档](https://xinyue-note.local/note-a)", {
    resolveTarget: resolverFrom({ "note-a": "9001" }),
    webBaseUrl: WEB_BASE
  })

  assert.equal(outcome.changed, 1)
  assert.equal(outcome.total, 1)
  assert.equal(outcome.content, "见 [接口文档](https://lovethewind.cn/notes/9001)")
  assert.deepEqual(outcome.changedTargets, ["note-a"])
})

test("围栏代码块内的本机地址原样跳过", () => {
  const source = [
    "普通段落 [A](https://xinyue-note.local/note-a)",
    "",
    "```md",
    "[示例](https://xinyue-note.local/note-b)",
    "```",
    "",
    "~~~",
    "https://xinyue-note.local/note-c",
    "~~~"
  ].join("\n")

  const outcome = rewriteLocalNoteLinksInContent(source, {
    resolveTarget: resolverFrom({ "note-a": "1", "note-b": "2", "note-c": "3" }),
    webBaseUrl: WEB_BASE
  })

  // 只有代码块外的那一条计入，代码块里的两条既不替换也不计数。
  assert.equal(outcome.total, 1)
  assert.equal(outcome.changed, 1)
  assert.equal(outcome.content.includes("https://xinyue-note.local/note-b"), true)
  assert.equal(outcome.content.includes("https://xinyue-note.local/note-c"), true)
  assert.equal(outcome.content.includes("https://lovethewind.cn/notes/1"), true)
})

test("未闭合的围栏按代码块处理，宁可少改", () => {
  const source = ["正文 [A](https://xinyue-note.local/note-a)", "", "```", "[B](https://xinyue-note.local/note-b)"].join("\n")

  const outcome = rewriteLocalNoteLinksInContent(source, {
    resolveTarget: resolverFrom({ "note-a": "1", "note-b": "2" }),
    webBaseUrl: WEB_BASE
  })

  assert.equal(outcome.total, 1)
  assert.equal(outcome.changed, 1)
  assert.equal(outcome.content.includes("https://xinyue-note.local/note-b"), true)
})

test("旧格式 xinyue-notes://note/{id} 一并转换", () => {
  const outcome = rewriteLocalNoteLinksInContent("老链接 [A](xinyue-notes://note/note-a)", {
    resolveTarget: resolverFrom({ "note-a": "9001" }),
    webBaseUrl: WEB_BASE
  })

  assert.equal(outcome.changed, 1)
  assert.equal(outcome.content, "老链接 [A](https://lovethewind.cn/notes/9001)")
})

test("目标笔记已不存在时保持原样并计入 missing", () => {
  const source = "[A](https://xinyue-note.local/gone)"
  const outcome = rewriteLocalNoteLinksInContent(source, {
    resolveTarget: resolverFrom({}),
    webBaseUrl: WEB_BASE
  })

  assert.equal(outcome.changed, 0)
  assert.equal(outcome.missing, 1)
  assert.equal(outcome.content, source)
})

test("目标未同步到云端时保持原样并计入 unsynced", () => {
  const source = "[A](https://xinyue-note.local/note-a)"
  const outcome = rewriteLocalNoteLinksInContent(source, {
    resolveTarget: resolverFrom({ "note-a": null }),
    webBaseUrl: WEB_BASE
  })

  assert.equal(outcome.changed, 0)
  assert.equal(outcome.unsynced, 1)
  assert.equal(outcome.content, source)
})

test("未配置网页地址时不改写任何链接", () => {
  const source = "[A](https://xinyue-note.local/note-a)"
  const outcome = rewriteLocalNoteLinksInContent(source, {
    resolveTarget: resolverFrom({ "note-a": "9001" }),
    webBaseUrl: ""
  })

  assert.equal(outcome.changed, 0)
  assert.equal(outcome.noWebBase, 1)
  assert.equal(outcome.content, source)
})

test("没有本机地址时原样返回且不重建正文", () => {
  const source = "# 标题\n\n只有普通链接 [站外](https://example.com/a)\n"
  const outcome = rewriteLocalNoteLinksInContent(source, {
    resolveTarget: resolverFrom({}),
    webBaseUrl: WEB_BASE
  })

  assert.equal(outcome.total, 0)
  assert.equal(outcome.changed, 0)
  assert.equal(outcome.content, source)
})

test("同一篇里的多条链接与重复目标分别计数", () => {
  const outcome = rewriteLocalNoteLinksInContent(
    "[A](https://xinyue-note.local/note-a) 和 [B](https://xinyue-note.local/note-b) 以及 [A2](https://xinyue-note.local/note-a)",
    { resolveTarget: resolverFrom({ "note-a": "1", "note-b": "2" }), webBaseUrl: WEB_BASE }
  )

  assert.equal(outcome.total, 3)
  assert.equal(outcome.changed, 3)
  // 去重后的目标集合只有两个。
  assert.deepEqual(outcome.changedTargets.sort(), ["note-a", "note-b"])
  assert.equal(outcome.content, "[A](https://lovethewind.cn/notes/1) 和 [B](https://lovethewind.cn/notes/2) 以及 [A2](https://lovethewind.cn/notes/1)")
})

test("地址里的 ID 会先解码再解析目标", () => {
  const outcome = rewriteLocalNoteLinksInContent("[A](https://xinyue-note.local/note%2Da)", {
    resolveTarget: resolverFrom({ "note-a": "9001" }),
    webBaseUrl: WEB_BASE
  })

  assert.equal(outcome.changed, 1)
  assert.equal(outcome.content, "[A](https://lovethewind.cn/notes/9001)")
})

test("嵌入卡片里的本地 ID 不被动到", () => {
  const source = '<div data-xynote-embed="note:note-a" title="接口文档"></div>'
  const outcome = rewriteLocalNoteLinksInContent(source, {
    resolveTarget: resolverFrom({ "note-a": "9001" }),
    webBaseUrl: WEB_BASE
  })

  assert.equal(outcome.changed, 0)
  assert.equal(outcome.content, source)
})

test("改写不会吞掉正文尾部的换行", () => {
  const outcome = rewriteLocalNoteLinksInContent("[A](https://xinyue-note.local/note-a)\n\n", {
    resolveTarget: resolverFrom({ "note-a": "9001" }),
    webBaseUrl: WEB_BASE
  })

  assert.equal(outcome.content, "[A](https://lovethewind.cn/notes/9001)\n\n")
})

// ---------------------------------------------------------------------------
// 仓库层：预览、执行与关系表
// ---------------------------------------------------------------------------

test("仓库层改写本机地址，并且关系表不漂", () => {
  withRepository((repository, helpers) => {
    const folder = repository.createFolder("工作")
    const target = repository.createNote(folder.id)
    const source = repository.createNote(folder.id)
    repository.updateNote(target.id, { title: "接口文档", content: "# 接口文档" })
    repository.updateNote(source.id, { title: "索引", content: "见 [接口文档](https://xinyue-note.local/" + target.id + ")" })
    helpers.setServerId(target.id, "9001")

    // 前提：改写前这条引用关系已在 note_links 里。
    assert.equal(
      repository.getBacklinks(target.id).some((note) => note.id === source.id),
      true
    )

    // 故意把关系表清空，模拟「正文已变、关系陈旧」这一既有风险场景：
    // 改写走 updateNote 就必须顺带把关系修回来（note_links 硬规则第 2 条），
    // 否则「关系」面板与图谱会一直缺这条边。
    helpers.clearNoteLinks()
    assert.equal(repository.getBacklinks(target.id).length, 0)

    const preview = repository.previewLocalNoteLinkRewrite(WEB_BASE)
    assert.equal(preview.convertibleNotes, 1)
    assert.equal(preview.convertibleLinks, 1)
    assert.equal(preview.totalLinks, 1)
    assert.equal(preview.missingLinks, 0)
    assert.equal(preview.unsyncedLinks, 0)
    assert.equal(preview.samples[0].noteId, source.id)

    const result = repository.rewriteLocalNoteLinks(WEB_BASE)
    assert.equal(result.noteCount, 1)
    assert.equal(result.linkCount, 1)
    assert.equal(repository.getNote(source.id).content, "见 [接口文档](https://lovethewind.cn/notes/9001)")

    // 🔴 改成网页地址后，解析规则要能认回同一篇本地笔记，否则「关系」面板与图谱会丢边。
    assert.equal(
      repository.getBacklinks(target.id).some((note) => note.id === source.id),
      true
    )

    // 幂等：再跑一次没有任何可改的。
    assert.equal(repository.rewriteLocalNoteLinks(WEB_BASE).noteCount, 0)
    assert.equal(repository.previewLocalNoteLinkRewrite(WEB_BASE).convertibleLinks, 0)
  })
})

test("目标未同步时预览只报 unsynced，执行不动正文", () => {
  withRepository((repository) => {
    const folder = repository.createFolder("工作")
    const target = repository.createNote(folder.id)
    const source = repository.createNote(folder.id)
    const original = "见 [接口文档](https://xinyue-note.local/" + target.id + ")"
    repository.updateNote(source.id, { content: original })

    const preview = repository.previewLocalNoteLinkRewrite(WEB_BASE)
    assert.equal(preview.convertibleLinks, 0)
    assert.equal(preview.unsyncedLinks, 1)

    assert.equal(repository.rewriteLocalNoteLinks(WEB_BASE).noteCount, 0)
    assert.equal(repository.getNote(source.id).content, original)
  })
})

test("目标已不存在时预览只报 missing，执行不动正文", () => {
  withRepository((repository) => {
    const folder = repository.createFolder("工作")
    const source = repository.createNote(folder.id)
    const original = "见 [幽灵](https://xinyue-note.local/00000000-0000-4000-8000-000000000000)"
    repository.updateNote(source.id, { content: original })

    const preview = repository.previewLocalNoteLinkRewrite(WEB_BASE)
    assert.equal(preview.convertibleLinks, 0)
    assert.equal(preview.missingLinks, 1)

    assert.equal(repository.rewriteLocalNoteLinks(WEB_BASE).noteCount, 0)
    assert.equal(repository.getNote(source.id).content, original)
  })
})

test("回收站里的笔记不参与扫描", () => {
  withRepository((repository) => {
    const folder = repository.createFolder("工作")
    const target = repository.createNote(folder.id)
    const source = repository.createNote(folder.id)
    repository.updateNote(source.id, { content: "[A](https://xinyue-note.local/" + target.id + ")" })
    repository.setNoteDeleted(source.id, true)

    const preview = repository.previewLocalNoteLinkRewrite(WEB_BASE)
    assert.equal(preview.linkedNotes, 0)
    assert.equal(preview.convertibleLinks, 0)
  })
})

test("仓库导出 getNote（纯净导出的嵌入卡片解析依赖它）", () => {
  withRepository((repository) => {
    const folder = repository.createFolder("工作")
    const note = repository.createNote(folder.id)
    repository.updateNote(note.id, { title: "标题", content: "正文" })

    // main.cjs 的 resolveEmbeddedNote 直接调 repository.getNote，
    // 一旦漏导出，纯净导出遇到嵌入卡片就会抛 TypeError。
    assert.equal(typeof repository.getNote, "function")
    assert.equal(repository.getNote(note.id).title, "标题")
  })
})

// ---------------------------------------------------------------------------
// 接线守卫：IPC / preload / types / UI 四处必须齐全，否则功能是死的
// ---------------------------------------------------------------------------

test("本机地址转换的接线四件套齐全", () => {
  const root = path.resolve(__dirname, "..")
  const preload = fs.readFileSync(path.resolve(root, "electron/preload.cjs"), "utf8")
  const handlers = fs.readFileSync(path.resolve(root, "electron/ipc-handlers.cjs"), "utf8")
  const main = fs.readFileSync(path.resolve(root, "electron/main.cjs"), "utf8")
  const types = fs.readFileSync(path.resolve(root, "src/types.ts"), "utf8")
  const app = fs.readFileSync(path.resolve(root, "src/App.vue"), "utf8")

  // 通道名三处必须一致：preload 发、handlers 收、两边拼错就静默失效。
  assert.match(preload, /"data:preview-local-note-link-rewrite"/)
  assert.match(preload, /"data:rewrite-local-note-links"/)
  assert.match(handlers, /"data:preview-local-note-link-rewrite"/)
  assert.match(handlers, /"data:rewrite-local-note-links"/)

  // 主进程真的把同步域名注进去了（否则转换条件永远不成立）。
  assert.match(main, /repository\.previewLocalNoteLinkRewrite\(syncSettings\.webUrl\)/)
  assert.match(main, /repository\.rewriteLocalNoteLinks\(syncSettings\.webUrl\)/)
  // 正文变了要推云端。
  assert.match(main, /if \(result\.noteCount > 0\) scheduleSync\(\)/)

  assert.match(types, /previewLocalNoteLinkRewrite\(\): Promise<LocalNoteLinkRewritePreview>/)
  assert.match(types, /rewriteLocalNoteLinks\(\): Promise<LocalNoteLinkRewriteResult>/)

  // 渲染层必须真的调到新 IPC，否则 UI 是死的。
  assert.match(app, /window\.notesDesktop\.previewLocalNoteLinkRewrite\(\)/)
  assert.match(app, /window\.notesDesktop\.rewriteLocalNoteLinks\(\)/)
})

test("转换入口先预览再确认，正文改动后刷新工作区", () => {
  const app = fs.readFileSync(path.resolve(__dirname, "..", "src/App.vue"), "utf8")

  // 按钮存在且被忙碌态挡住。
  assert.match(app, /class="local-link-rewrite-action"[^>]*:disabled="dataTransferBusy"/)
  // 预览结果非空才显示确认区，且没有可转链接时确认按钮不可点。
  assert.match(app, /v-if="linkRewritePreview" class="link-rewrite-confirm"/)
  assert.match(app, /:disabled="dataTransferBusy \|\| !linkRewritePreview\.convertibleLinks"/)
  // 执行走 runDataTransfer 并带 refreshAfter，否则正文换了列表与关系面板还是旧的。
  assert.match(app, /await runDataTransfer\(\(\) => window\.notesDesktop\.rewriteLocalNoteLinks\(\), true\)/)
  // 重新打开面板要清掉上一次的预览，避免残留的确认区。
  assert.match(app, /linkRewritePreview\.value = null\s*\n\s*markdownImportTargetVisible\.value = false/)
})
