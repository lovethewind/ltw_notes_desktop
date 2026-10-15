const assert = require("node:assert/strict")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const test = require("node:test")
const Database = require("better-sqlite3")
const { openNotesDatabase } = require("../electron/database.cjs")
const { fillEmbedServerIdsInContent, rewriteLocalNoteLinksInContent } = require("../electron/local-note-links.cjs")

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
  // 重新打开面板要清掉上一次的预览，避免残留的确认区（两条清理入口都要清）。
  assert.match(
    app,
    /linkRewritePreview\.value = null\s*\n\s*embedFillPreview\.value = null\s*\n\s*markdownImportTargetVisible\.value = false/
  )
})

// ── 存量嵌入卡补跨端标识（data-xynote-embed-server） ────────────────────────────
// 契约与设计见 docs/specs/2026-10-12-note-embed-web-render.md。

test("回填嵌入卡：目标已同步时补上跨端标识，且不动本机 ID", () => {
  const source = '开头\n\n<div data-xynote-embed="note:note-a" title="接口文档"></div>\n\n结尾'
  const result = fillEmbedServerIdsInContent(source, { resolveTarget: resolverFrom({ "note-a": "101" }) })

  assert.equal(result.total, 1)
  assert.equal(result.changed, 1)
  assert.deepEqual(result.changedTargets, ["note-a"])
  // 本机 ID 原样保留（桌面端解析键），其余属性顺序不变，新属性紧跟其后。
  assert.match(
    result.content,
    /<div data-xynote-embed="note:note-a" data-xynote-embed-server="101" title="接口文档"><\/div>/
  )
})

test("回填嵌入卡：已带跨端标识的卡片原样跳过（幂等）", () => {
  const source = '<div data-xynote-embed="note:note-a" data-xynote-embed-server="101"></div>'
  const first = fillEmbedServerIdsInContent(source, { resolveTarget: resolverFrom({ "note-a": "101" }) })

  assert.equal(first.changed, 0)
  assert.equal(first.alreadyFilled, 1)
  // 幂等的判据是「再跑一次什么都不变」，不是「只跳过同值」。
  assert.equal(first.content, source)
})

test("回填嵌入卡：目标未同步 / 已删除时原样保留并分类计数", () => {
  const source = [
    '<div data-xynote-embed="note:unsynced"></div>',
    '<div data-xynote-embed="note:gone"></div>'
  ].join("\n\n")
  const result = fillEmbedServerIdsInContent(source, {
    resolveTarget: resolverFrom({ unsynced: null })
  })

  assert.equal(result.total, 2)
  assert.equal(result.changed, 0)
  assert.equal(result.unsynced, 1)
  assert.equal(result.missing, 1)
  assert.equal(result.content, source)
})

test("回填嵌入卡：围栏代码块内的示例原样跳过", () => {
  const source = [
    "```html",
    '<div data-xynote-embed="note:note-a"></div>',
    "```",
    "",
    '<div data-xynote-embed="note:note-a"></div>'
  ].join("\n")
  const result = fillEmbedServerIdsInContent(source, { resolveTarget: resolverFrom({ "note-a": "101" }) })

  // 代码块内那份不算命中，只有正文里那份被补。
  assert.equal(result.total, 1)
  assert.equal(result.changed, 1)
  assert.equal((result.content.match(/data-xynote-embed-server/g) || []).length, 1)
  assert.match(result.content, /```html\n<div data-xynote-embed="note:note-a"><\/div>\n```/)
})

test("回填嵌入卡：没有可补的卡片时正文逐字节一致", () => {
  const source = "纯正文，没有嵌入卡。\n\n第二段。"
  const result = fillEmbedServerIdsInContent(source, { resolveTarget: () => ({ id: "x", serverId: "1" }) })

  assert.equal(result.content, source)
  assert.equal(result.total, 0)
  assert.equal(result.changed, 0)
})

test("回填嵌入卡：只带跨端标识的卡片（网页端插入）原样跳过", () => {
  // 这类卡片没有 data-xynote-embed：回填以本机 ID 为锚点，既不该改动它，也不该计入统计。
  const source = '<div data-xynote-embed-server="2081338921611808768" title="接口文档"></div>'
  const result = fillEmbedServerIdsInContent(source, { resolveTarget: () => ({ id: "x", serverId: "101" }) })

  assert.equal(result.total, 0)
  assert.equal(result.changed, 0)
  assert.equal(result.content, source)
})

test("回填嵌入卡：多张卡片按目标去重，单引号写法同样识别", () => {
  const source = [
    "<div data-xynote-embed='note:note-a'></div>",
    '<div data-xynote-embed="note:note-b" title="B"></div>',
    '<div data-xynote-embed="note:note-a"></div>'
  ].join("\n\n")
  const result = fillEmbedServerIdsInContent(source, {
    resolveTarget: resolverFrom({ "note-a": "101", "note-b": "202" })
  })

  assert.equal(result.total, 3)
  assert.equal(result.changed, 3)
  assert.deepEqual(result.changedTargets.sort(), ["note-a", "note-b"])
  assert.match(result.content, /data-xynote-embed='note:note-a' data-xynote-embed-server='101'/)
  assert.match(result.content, /data-xynote-embed="note:note-b" data-xynote-embed-server="202" title="B"/)
})

test("桌面端契约：插入与序列化都带上跨端标识，且解析不依赖它", () => {
  const root = path.resolve(__dirname, "..")
  const embed = fs.readFileSync(path.join(root, "src/editor/xynote-embed.ts"), "utf8")

  // 契约常量与序列化产出点。
  assert.match(embed, /export const EMBED_SERVER_TAG = 'data-xynote-embed-server'/)
  assert.match(embed, /export function parseEmbedServerId\(/)
  assert.match(embed, /const serverAttr = serverId \? ` \$\{EMBED_SERVER_TAG\}="\$\{serverId\}"` : ''/)
  // parseDOM / mdast 往返都要读回，否则重建一次卡片属性就丢。
  assert.match(embed, /serverId: el\.getAttribute\(EMBED_SERVER_TAG\)/)
  assert.match(embed, /serverId: \{ default: null as string \| null \}/)
  assert.match(embed, /embedNode\.serverId = parseEmbedServerId\(raw\)/)
  // 右键菜单需要把 serverId 带给渲染层（复制嵌入引用要用）。
  assert.match(embed, /serverIdChanged/)
})

test("桌面端契约：transformer 必须把 title 也解析出来，否则编辑一次就抹掉", () => {
  const root = path.resolve(__dirname, "..")
  const embed = fs.readFileSync(path.join(root, "src/editor/xynote-embed.ts"), "utf8")

  // 解析函数存在，且属性前要求空白边界（避免命中名字里带 title 的其它属性）。
  assert.match(embed, /export function parseEmbedTitle\(/)
  assert.match(embed, /\(\?:\^\|\\s\)title=/)
  // 两处 transformer 分支都要取值。少任何一处，用户编辑一次正文保存，
  // `title="..."` 就被整条抹掉 —— 桌面端卡片实时查库看不出异常，
  // 受损的是网页端取数失败时的兜底标题（曾因此显示成「未命名笔记」）。
  assert.match(embed, /node\.title = parseEmbedTitle\(raw\)/)
  assert.match(embed, /embedNode\.title = parseEmbedTitle\(raw\)/)
  // 序列化侧按 title 有无决定是否输出，与解析侧对称：缺一即把属性写没。
  assert.match(embed, /const attr = title \? ` title="\$\{title\}"` : ''/)
})

test("桌面端契约：插入路径真的用上选择器给的 serverId，复制引用也带属性", () => {
  const app = fs.readFileSync(
    path.resolve(__dirname, "..", "src/components/MarkdownVisualEditor.vue"),
    "utf8"
  )
  const events = fs.readFileSync(
    path.resolve(__dirname, "..", "src/utils/note-open-events.ts"),
    "utf8"
  )

  // 曾经是被丢弃的 `_serverId`：改回真实参数名并落进节点属性。
  assert.match(app, /async function insertNoteEmbed\(noteId: string, serverId: string \| null, title: string\)/)
  assert.doesNotMatch(app, /_serverId: string \| null/)
  assert.match(app, /attrs: \{ noteId, title: title \|\| null, serverId: serverId \|\| null \}/)
  // 卡片右键「复制嵌入引用」与插入同源。
  assert.match(app, /const serverAttr = target\.serverId \? ` data-xynote-embed-server="\$\{target\.serverId\}"` : ''/)
  assert.match(app, /serverId: detail\.serverId \?\? null/)
  // 事件载荷类型必须带上该字段，否则渲染层拿不到。
  assert.match(events, /serverId: string \| null/)
})

// ---------------------------------------------------------------------------
// 仓库层：回填嵌入卡的预览与执行
// ---------------------------------------------------------------------------

test("仓库层回填嵌入卡：补标识并落库，嵌入关系不漂", () => {
  withRepository((repository, helpers) => {
    const folder = repository.createFolder("工作")
    const target = repository.createNote(folder.id)
    const source = repository.createNote(folder.id)
    repository.updateNote(target.id, { title: "接口文档", content: "# 接口文档" })
    repository.updateNote(source.id, {
      title: "索引",
      content: `索引\n\n<div data-xynote-embed="note:${target.id}" title="接口文档"></div>\n`
    })
    helpers.setServerId(target.id, "9001")

    // 前提：嵌入本身就是一条引用关系（resolveNoteLinkTargetIds 认嵌入卡）。
    assert.equal(
      repository.getBacklinks(target.id).some((note) => note.id === source.id),
      true
    )

    // 故意清空关系表，模拟「正文已变、关系陈旧」：执行走 updateNote 就必须把关系修回来。
    helpers.clearNoteLinks()
    assert.equal(repository.getBacklinks(target.id).length, 0)

    const preview = repository.previewEmbedServerIdFill()
    assert.equal(preview.convertibleNotes, 1)
    assert.equal(preview.fillableEmbeds, 1)
    assert.equal(preview.totalEmbeds, 1)
    assert.equal(preview.unsyncedEmbeds, 0)
    assert.equal(preview.missingEmbeds, 0)
    assert.equal(preview.samples[0].noteId, source.id)

    const result = repository.fillEmbedServerIds()
    assert.equal(result.noteCount, 1)
    assert.equal(result.embedCount, 1)
    assert.match(
      repository.getNote(source.id).content,
      new RegExp(
        `<div data-xynote-embed="note:${target.id}" data-xynote-embed-server="9001" title="接口文档"></div>`
      )
    )
    // 补的是新属性、本机 ID 原样，所以这条引用关系必须还在。
    assert.equal(
      repository.getBacklinks(target.id).some((note) => note.id === source.id),
      true
    )

    // 幂等：再跑一次没有任何可补的，且已被识别成「已带标识」。
    assert.equal(repository.fillEmbedServerIds().noteCount, 0)
    const again = repository.previewEmbedServerIdFill()
    assert.equal(again.fillableEmbeds, 0)
    assert.equal(again.alreadyFilledEmbeds, 1)
  })
})

test("仓库层回填嵌入卡：目标未同步只报 unsynced，执行不动正文", () => {
  withRepository((repository) => {
    const folder = repository.createFolder("工作")
    const target = repository.createNote(folder.id)
    const source = repository.createNote(folder.id)
    const original = `<div data-xynote-embed="note:${target.id}"></div>`
    repository.updateNote(source.id, { content: original })

    const preview = repository.previewEmbedServerIdFill()
    assert.equal(preview.fillableEmbeds, 0)
    assert.equal(preview.unsyncedEmbeds, 1)

    assert.equal(repository.fillEmbedServerIds().noteCount, 0)
    assert.equal(repository.getNote(source.id).content, original)
  })
})

test("仓库层回填嵌入卡：全库无嵌入卡时逐字节不动", () => {
  withRepository((repository) => {
    const folder = repository.createFolder("工作")
    const note = repository.createNote(folder.id)
    const original = "# 只有普通正文\n\n没有卡片。\n"
    repository.updateNote(note.id, { content: original })

    assert.equal(repository.previewEmbedServerIdFill().totalEmbeds, 0)
    assert.equal(repository.fillEmbedServerIds().noteCount, 0)
    assert.equal(repository.getNote(note.id).content, original)
  })
})

// ---------------------------------------------------------------------------
// 接线守卫：回填入口的 IPC / preload / types / UI 四处必须齐全
// ---------------------------------------------------------------------------

test("嵌入卡回填的接线四件套齐全", () => {
  const root = path.resolve(__dirname, "..")
  const preload = fs.readFileSync(path.resolve(root, "electron/preload.cjs"), "utf8")
  const handlers = fs.readFileSync(path.resolve(root, "electron/ipc-handlers.cjs"), "utf8")
  const main = fs.readFileSync(path.resolve(root, "electron/main.cjs"), "utf8")
  const types = fs.readFileSync(path.resolve(root, "src/types.ts"), "utf8")
  const app = fs.readFileSync(path.resolve(root, "src/App.vue"), "utf8")

  // 通道名三处必须一致：preload 发、handlers 收，拼错就静默失效。
  assert.match(preload, /"data:preview-embed-server-id-fill"/)
  assert.match(preload, /"data:fill-embed-server-ids"/)
  assert.match(handlers, /"data:preview-embed-server-id-fill"/)
  assert.match(handlers, /"data:fill-embed-server-ids"/)

  // 主进程必须真的调到仓库层；正文变了要推云端。
  assert.match(main, /return repository\.previewEmbedServerIdFill\(\)/)
  assert.match(main, /const result = repository\.fillEmbedServerIds\(\)\s*\n\s*if \(result\.noteCount > 0\) scheduleSync\(\)/)

  assert.match(types, /previewEmbedServerIdFill\(\): Promise<EmbedServerIdFillPreview>/)
  assert.match(types, /fillEmbedServerIds\(\): Promise<EmbedServerIdFillResult>/)

  // 渲染层必须真的调到新 IPC，否则 UI 是死的。
  assert.match(app, /window\.notesDesktop\.previewEmbedServerIdFill\(\)/)
  assert.match(app, /window\.notesDesktop\.fillEmbedServerIds\(\)/)
})

test("嵌入卡回填入口先预览再确认，正文改动后刷新工作区", () => {
  const app = fs.readFileSync(path.resolve(__dirname, "..", "src/App.vue"), "utf8")

  // 按钮存在且被忙碌态挡住。
  assert.match(app, /class="embed-server-fill-action"[^>]*:disabled="dataTransferBusy"/)
  // 预览结果非空才显示确认区，且没有可补卡片时确认按钮不可点。
  assert.match(app, /v-if="embedFillPreview" class="link-rewrite-confirm"/)
  assert.match(app, /:disabled="dataTransferBusy \|\| !embedFillPreview\.fillableEmbeds"/)
  // 执行走 runDataTransfer 并带 refreshAfter，否则正文换了列表与关系面板还是旧的。
  assert.match(app, /await runDataTransfer\(\(\) => window\.notesDesktop\.fillEmbedServerIds\(\), true\)/)
  // 重新打开面板要清掉上一次的预览，避免残留的确认区。
  assert.match(app, /embedFillPreview\.value = null\s*\n\s*markdownImportTargetVisible\.value = false/)
})
