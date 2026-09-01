const assert = require("node:assert/strict")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const test = require("node:test")
const { openNotesDatabase } = require("../electron/database.cjs")

/**
 * 在隔离临时目录中执行数据库测试。
 *
 * :param {(repository: ReturnType<typeof openNotesDatabase>) => void} run 测试逻辑。
 * :return: 无返回值。
 */
function withRepository(run) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "ltw-notes-database-"))
  const repository = openNotesDatabase(directory)
  try {
    run(repository)
  } finally {
    repository.close()
    fs.rmSync(directory, { recursive: true, force: true })
  }
}

test("文件夹删除和恢复会作用于整棵子树及其中笔记", () => {
  withRepository((repository) => {
    const root = repository.createFolder("根目录")
    const child = repository.createFolder("子目录", root.id)
    const rootNote = repository.createNote(root.id)
    const childNote = repository.createNote(child.id)

    assert.equal(repository.setFolderDeleted(root.id, true), true)
    let workspace = repository.listWorkspace()
    const deletedFolders = workspace.folders.filter((folder) => folder.isDeleted)
    assert.deepEqual(deletedFolders.map((folder) => folder.id).sort(), [child.id, root.id].sort())
    assert.ok(deletedFolders.every((folder) => folder.deletedRootId === root.id))
    assert.ok(
      workspace.notes
        .filter((note) => [rootNote.id, childNote.id].includes(note.id))
        .every((note) => note.isDeleted && note.deletedByFolderId === root.id)
    )

    assert.equal(repository.restoreFolder(root.id), true)
    workspace = repository.listWorkspace()
    assert.ok(workspace.folders.every((folder) => !folder.isDeleted))
    assert.ok(
      workspace.notes
        .filter((note) => [rootNote.id, childNote.id].includes(note.id))
        .every((note) => !note.isDeleted && note.deletedByFolderId === null)
    )
  })
})

test("彻底删除回收站文件夹会删除整棵子树及随文件夹删除的笔记", () => {
  withRepository((repository) => {
    const root = repository.createFolder("根目录")
    const child = repository.createFolder("子目录", root.id)
    const childNote = repository.createNote(child.id)
    const independentlyDeletedNote = repository.createNote(child.id)
    repository.setNoteDeleted(independentlyDeletedNote.id, true)

    repository.setFolderDeleted(root.id, true)
    assert.equal(repository.deleteFolderPermanently(root.id), true)

    const workspace = repository.listWorkspace()
    assert.equal(workspace.folders.length, 0)
    assert.equal(workspace.notes.some((note) => note.id === childNote.id), false)
    const retainedNote = workspace.notes.find((note) => note.id === independentlyDeletedNote.id)
    assert.equal(retainedNote?.isDeleted, true)
    assert.equal(retainedNote?.folderId, null)
    assert.equal(retainedNote?.deletedByFolderId, null)
  })
})

test("清空回收站会同时彻底删除文件夹删除批次和独立删除的笔记", () => {
  withRepository((repository) => {
    const root = repository.createFolder("根目录")
    const child = repository.createFolder("子目录", root.id)
    repository.createNote(child.id)
    const standaloneNote = repository.createNote()

    repository.setFolderDeleted(root.id)
    repository.setNoteDeleted(standaloneNote.id, true)

    assert.equal(repository.emptyTrash(), 4)
    const workspace = repository.listWorkspace()
    assert.equal(workspace.folders.length, 0)
    assert.equal(workspace.notes.length, 0)
  })
})

test("可以移动文件夹并按目标位置重排同级文件夹", () => {
  withRepository((repository) => {
    const first = repository.createFolder("第一个")
    const second = repository.createFolder("第二个")
    const parent = repository.createFolder("父目录")

    repository.moveFolder(second.id, parent.id, null)
    repository.moveFolder(first.id, parent.id, second.id)

    const children = repository.listWorkspace().folders.filter((folder) => folder.parentId === parent.id)
    assert.deepEqual(children.map((folder) => folder.id), [first.id, second.id])
    assert.deepEqual(children.map((folder) => folder.sortOrder), [0, 1])
  })
})

test("移动文件夹会拒绝形成父子循环", () => {
  withRepository((repository) => {
    const root = repository.createFolder("根目录")
    const child = repository.createFolder("子目录", root.id)

    assert.throws(() => repository.moveFolder(root.id, child.id, null), /不能移动到自身或子文件夹/)
    assert.equal(repository.listWorkspace().folders.find((folder) => folder.id === root.id)?.parentId, null)
  })
})

test("快速记录一次写入标题、正文和目标文件夹", () => {
  withRepository((repository) => {
    const folder = repository.createFolder("收件箱")
    const note = repository.createQuickNote({
      title: "临时想法",
      content: "稍后整理这条内容",
      folderId: folder.id
    })

    assert.equal(note.title, "临时想法")
    assert.equal(note.content, "稍后整理这条内容")
    assert.equal(note.folderId, folder.id)
    const generatedTitleNote = repository.createQuickNote({
      title: "",
      content: "这是一段用于自动生成标题的正文内容，超过三十个字符后不应继续进入标题方便列表查找"
    })
    assert.equal(generatedTitleNote.title, "这是一段用于自动生成标题的正文内容，超过三十个字符后不应继续")
    assert.throws(() => repository.createQuickNote({ title: "", content: "" }), /内容不能为空/)
  })
})

test("工作区只返回摘要并按需读取完整正文", () => {
  withRepository((repository) => {
    const note = repository.createNote()
    const fullContent = `开头摘要 ${"正文内容".repeat(500)} 末尾标记`
    repository.updateNote(note.id, {
      title: "按需加载测试",
      content: fullContent,
      tagNames: ["性能"]
    })

    const summary = repository.listWorkspace().notes.find((item) => item.id === note.id)
    assert.equal(summary.contentLoaded, false)
    assert.ok(summary.content.length < fullContent.length)
    assert.match(summary.content, /开头摘要/)

    const detail = repository.getNoteForEditing(note.id)
    assert.equal(detail.contentLoaded, true)
    assert.equal(detail.content, fullContent)
    assert.deepEqual(detail.tags.map((tag) => tag.name), ["性能"])
  })
})

test("SQLite 全文搜索命中摘要之外的正文并跟随更新", () => {
  withRepository((repository) => {
    const folder = repository.createFolder("项目资料")
    const note = repository.createNote(folder.id)
    repository.updateNote(note.id, {
      title: "普通标题",
      content: `${"前置内容".repeat(400)} 深处唯一关键词银河引擎`,
      tagNames: ["架构"]
    })

    const contentResults = repository.searchNotes("银河引擎")
    assert.deepEqual(contentResults.map((item) => item.id), [note.id])
    assert.equal(contentResults[0].contentLoaded, false)
    assert.match(contentResults[0].content, /银河引擎/)

    assert.equal(repository.searchNotes("架构").length, 0)
    assert.deepEqual(
      repository.searchNotes("架构", { includeMetadata: true }).map((item) => item.id),
      [note.id]
    )
    assert.deepEqual(
      repository.searchNotes("项目资料", { includeMetadata: true }).map((item) => item.id),
      [note.id]
    )

    repository.updateNote(note.id, { content: "关键词已经替换为星河驱动" })
    assert.equal(repository.searchNotes("银河引擎").length, 0)
    assert.deepEqual(repository.searchNotes("星河驱动").map((item) => item.id), [note.id])
  })
})

test("高级搜索可以组合文件夹、标签、更新时间和置顶条件", () => {
  withRepository((repository) => {
    const work = repository.createFolder("工作")
    const project = repository.createFolder("项目", work.id)
    const other = repository.createFolder("其他")
    const pinned = repository.createNote(work.id)
    const child = repository.createNote(project.id)
    const outside = repository.createNote(other.id)

    const pinnedUpdated = repository.updateNote(pinned.id, {
      title: "季度计划置顶",
      content: "季度计划正文",
      tagNames: ["重要"],
      isPinned: true
    })
    repository.updateNote(child.id, {
      title: "季度计划子项目",
      content: "季度计划正文",
      tagNames: ["重要"]
    })
    repository.updateNote(outside.id, {
      title: "季度计划其他",
      content: "季度计划正文",
      tagNames: ["普通"],
      isPinned: true
    })

    assert.deepEqual(
      repository.searchNotes("季度计划", {
        folderIds: [work.id, project.id],
        tagIds: [pinnedUpdated.tags[0].id],
        pinnedOnly: true
      }).map((note) => note.id),
      [pinned.id]
    )
    assert.deepEqual(
      new Set(repository.searchNotes("", { tagIds: [pinnedUpdated.tags[0].id] }).map((note) => note.id)),
      new Set([pinned.id, child.id])
    )
    assert.equal(repository.searchNotes("", { updatedAfter: "2999-01-01T00:00:00.000Z" }).length, 0)
  })
})

test("高级搜索在超过候选上限时仍先应用结构化筛选", () => {
  withRepository((repository) => {
    const targetFolder = repository.createFolder("目标目录")
    const noiseFolder = repository.createFolder("其他目录")
    const target = repository.createNote(targetFolder.id)
    repository.updateNote(target.id, { title: "不能被截断的目标" })
    for (let index = 0; index < 1000; index += 1) {
      const noise = repository.createNote(noiseFolder.id)
      repository.updateNote(noise.id, { title: `置顶干扰 ${index}`, isPinned: true })
    }

    assert.deepEqual(
      repository.searchNotes("", { folderIds: [targetFolder.id], limit: 10 }).map((note) => note.id),
      [target.id]
    )
  })
})

test("复制笔记默认保留原位置并支持选择目标文件夹", () => {
  withRepository((repository) => {
    const sourceFolder = repository.createFolder("原文件夹")
    const targetFolder = repository.createFolder("目标文件夹")
    const source = repository.createNote(sourceFolder.id)
    repository.updateNote(source.id, {
      title: "项目记录",
      content: "包含附件与普通 Markdown 的正文",
      tagNames: ["工作", "重要"]
    })

    const sameFolderCopy = repository.duplicateNote(source.id)
    assert.notEqual(sameFolderCopy.id, source.id)
    assert.equal(sameFolderCopy.title, "项目记录 副本")
    assert.equal(sameFolderCopy.content, "包含附件与普通 Markdown 的正文")
    assert.equal(sameFolderCopy.folderId, sourceFolder.id)
    assert.equal(sameFolderCopy.isPinned, false)
    assert.deepEqual(sameFolderCopy.tags.map((tag) => tag.name).sort(), ["工作", "重要"].sort())
    assert.deepEqual(repository.listNoteHistory(sameFolderCopy.id), [])

    const targetFolderCopy = repository.duplicateNote(source.id, targetFolder.id, "项目记录模板")
    assert.equal(targetFolderCopy.folderId, targetFolder.id)
    assert.equal(targetFolderCopy.title, "项目记录模板")
    repository.updateNote(targetFolderCopy.id, { content: "副本独立修改" })
    assert.equal(
      repository.getNoteForEditing(source.id)?.content,
      "包含附件与普通 Markdown 的正文"
    )
  })
})

test("批量更新笔记在单个事务中移动、调整标签和置顶", () => {
  withRepository((repository) => {
    const sourceFolder = repository.createFolder("来源")
    const targetFolder = repository.createFolder("目标")
    const first = repository.createNote(sourceFolder.id)
    const second = repository.createNote(sourceFolder.id)
    repository.updateNote(first.id, { tagNames: ["保留", "移除"] })
    repository.updateNote(second.id, { tagNames: ["保留"] })

    const updated = repository.bulkUpdateNotes([first.id, second.id], {
      folderId: targetFolder.id,
      isPinned: true,
      addTagNames: ["新增"],
      removeTagNames: ["移除"]
    })

    assert.equal(updated.length, 2)
    assert.ok(updated.every((note) => note.folderId === targetFolder.id && note.isPinned))
    assert.deepEqual(updated[0].tags.map((tag) => tag.name).sort(), ["保留", "新增"].sort())
    assert.deepEqual(updated[1].tags.map((tag) => tag.name).sort(), ["保留", "新增"].sort())
    const batch = repository.getSyncBatch()
    assert.ok([first.id, second.id].every((id) => batch.notes.some((note) => note.clientId === id)))
  })
})

test("批量更新遇到不存在的笔记时整体回滚", () => {
  withRepository((repository) => {
    const note = repository.createNote()

    assert.throws(
      () => repository.bulkUpdateNotes([note.id, "missing-note"], { isPinned: true }),
      /笔记不存在/
    )
    assert.equal(repository.listWorkspace().notes.find((item) => item.id === note.id)?.isPinned, false)
  })
})

test("批量更新可以统一移入和移出回收站", () => {
  withRepository((repository) => {
    const first = repository.createNote()
    const second = repository.createNote()

    assert.ok(repository.bulkUpdateNotes([first.id, second.id], { isDeleted: true }).every((note) => note.isDeleted))
    assert.ok(repository.bulkUpdateNotes([first.id, second.id], { isDeleted: false }).every((note) => !note.isDeleted))
  })
})

test("批量恢复随文件夹删除的笔记时放入未分类", () => {
  withRepository((repository) => {
    const folder = repository.createFolder("待删除目录")
    const note = repository.createNote(folder.id)
    repository.setFolderDeleted(folder.id)

    const [restored] = repository.bulkUpdateNotes([note.id], { isDeleted: false })

    assert.equal(restored.isDeleted, false)
    assert.equal(restored.folderId, null)
    assert.equal(restored.deletedByFolderId, null)
  })
})

test("批量永久删除回收站笔记在同一事务内完成", () => {
  withRepository((repository) => {
    const first = repository.createNote()
    const second = repository.createNote()
    repository.bulkUpdateNotes([first.id, second.id], { isDeleted: true })

    const result = repository.bulkUpdateNotes([first.id, second.id], { permanentlyDelete: true })

    assert.deepEqual(result, [])
    assert.ok([first.id, second.id].every((id) => !repository.listWorkspace().notes.some((note) => note.id === id)))
    assert.ok([first.id, second.id].every((id) => repository.getSyncBatch().tombstones.some((item) => item.clientId === id)))
  })
})

test("本地编辑产生的历史版本会进入同步批次", () => {
  withRepository((repository) => {
    const note = repository.createNote()

    repository.updateNote(note.id, { content: "同步后的正文" })

    const batch = repository.getSyncBatch()
    assert.equal(batch.histories.length, 1)
    assert.equal(batch.histories[0].noteClientId, note.id)
    assert.equal(batch.histories[0].content, "")
  })
})

test("本地图片引用会在同步批次中转换为云端地址", () => {
  withRepository((repository) => {
    const note = repository.createNote()
    const asset = repository.createImageAsset({
      fileName: "截图.png",
      mimeType: "image/png",
      byteSize: 128,
      sha256: "asset-sha256",
      localPath: "/tmp/asset-sha256.png"
    })
    repository.updateNote(note.id, {
      content: `图片之前\n\n![截图](${asset.localUrl})\n\n图片之后`
    })

    const uploadedAsset = repository.markImageAssetUploaded(
      asset.id,
      "https://cdn.example.com/asset-sha256.png",
      "123"
    )

    const syncedNote = repository.getSyncBatch().notes.find((item) => item.clientId === note.id)
    assert.equal(uploadedAsset.serverSourceId, "123")
    assert.equal(
      syncedNote?.content,
      "图片之前\n\n![截图](https://cdn.example.com/asset-sha256.png)\n\n图片之后"
    )
  })
})

test("通用附件复用资源表并在同步时转换为云端地址", () => {
  withRepository((repository) => {
    const note = repository.createNote()
    const asset = repository.createAsset({
      fileName: "需求.pdf",
      mimeType: "application/pdf",
      byteSize: 1024,
      sha256: "attachment-sha256",
      localPath: "/tmp/attachment-sha256.pdf"
    })
    repository.updateNote(note.id, {
      content: `[需求.pdf](https://xinyue-asset.local/${asset.id})`
    })
    repository.markAssetUploaded(asset.id, "https://cdn.example.com/attachment-sha256.pdf")

    const syncedNote = repository.getSyncBatch().notes.find((item) => item.clientId === note.id)
    assert.equal(syncedNote?.content, "[需求.pdf](https://cdn.example.com/attachment-sha256.pdf)")
    repository.updateNote(note.id, {
      content: "[需求.pdf](https://cdn.example.com/attachment-sha256.pdf)"
    })
    assert.equal(
      repository.getNoteForEditing(note.id)?.content,
      "[需求.pdf](https://cdn.example.com/attachment-sha256.pdf)"
    )
    assert.equal(repository.getAsset(asset.id)?.mimeType, "application/pdf")
  })
})

test("附件清单统计当前笔记与历史引用并只允许清理孤立资源", () => {
  withRepository((repository) => {
    const currentNote = repository.createNote()
    const historyNote = repository.createNote()
    const currentAsset = repository.createAsset({
      fileName: "当前图片.png",
      mimeType: "image/png",
      byteSize: 128,
      sha256: "inventory-current-asset",
      localPath: "/tmp/inventory-current-asset.png"
    })
    const historyAsset = repository.createAsset({
      fileName: "历史附件.pdf",
      mimeType: "application/pdf",
      byteSize: 1024,
      sha256: "inventory-history-asset",
      localPath: "/tmp/inventory-history-asset.pdf"
    })
    const orphanAsset = repository.createAsset({
      fileName: "孤立附件.zip",
      mimeType: "application/zip",
      byteSize: 2048,
      sha256: "inventory-orphan-asset",
      localPath: "/tmp/inventory-orphan-asset.zip"
    })
    repository.updateNote(currentNote.id, {
      content: `![当前图片](${currentAsset.localUrl})`
    })
    repository.applySyncResult({
      snapshot: {
        folders: [],
        tags: [],
        notes: [
          {
            clientId: currentNote.id,
            serverId: "current-note-server",
            folderClientId: null,
            title: currentNote.title,
            content: `![当前图片](${currentAsset.localUrl})`,
            isPinned: false,
            isDeleted: false,
            deletedTime: null,
            deletedByFolderClientId: null,
            tagClientIds: [],
            createdAt: currentNote.createdAt,
            updatedAt: currentNote.updatedAt
          },
          {
            clientId: historyNote.id,
            serverId: "history-note-server",
            folderClientId: null,
            title: historyNote.title,
            content: "当前正文不再引用附件",
            isPinned: false,
            isDeleted: false,
            deletedTime: null,
            deletedByFolderClientId: null,
            tagClientIds: [],
            createdAt: historyNote.createdAt,
            updatedAt: historyNote.updatedAt
          }
        ],
        histories: [{
          clientId: "history-with-asset",
          noteClientId: historyNote.id,
          title: "历史附件版本",
          content: `[历史附件.pdf](https://xinyue-asset.local/${historyAsset.id})`,
          folderClientId: null,
          tagNames: [],
          createdAt: "2026-08-12T00:00:00.000Z"
        }]
      },
      mappings: [],
      conflictClientIds: []
    })

    const inventory = repository.listAttachmentInventory()
    const currentItem = inventory.find((item) => item.id === currentAsset.id)
    const historyItem = inventory.find((item) => item.id === historyAsset.id)
    const orphanItem = inventory.find((item) => item.id === orphanAsset.id)
    assert.deepEqual(currentItem.noteReferences.map((note) => note.id), [currentNote.id])
    assert.equal(currentItem.referenceCount, 1)
    assert.equal(currentItem.isOrphan, false)
    assert.equal(historyItem.noteReferences.length, 0)
    assert.equal(historyItem.historyReferenceCount, 1)
    assert.equal(historyItem.isOrphan, false)
    assert.equal(orphanItem.referenceCount, 0)
    assert.equal(orphanItem.isOrphan, true)
    assert.throws(() => repository.deleteOrphanAsset(currentAsset.id), /仍被笔记引用/)
    assert.equal(repository.deleteOrphanAsset(orphanAsset.id).id, orphanAsset.id)
    assert.equal(repository.getAsset(orphanAsset.id), null)
  })
})

test("扫描普通 Markdown 附件引用时不会因反斜杠发生正则回溯", () => {
  withRepository((repository) => {
    const note = repository.createNote()
    repository.updateNote(note.id, {
      content: `[[${"\\".repeat(20_000)}普通笔记内容`
    })

    const startedAt = performance.now()
    assert.deepEqual(repository.listRemoteAttachmentReferencesToCache(), [])
    assert.ok(performance.now() - startedAt < 250)
  })
})

test("任意 HTTP(S) 站点资源都会进入离线缓存候选", () => {
  withRepository((repository) => {
    const note = repository.createNote()
    repository.updateNote(note.id, {
      content: [
        "![外链图片](https://images.example.net/archive/photo.png)",
        "[外链附件](https://files.other.org/report.pdf \"attachment|application%2Fpdf|2048\")"
      ].join("\n\n")
    })

    assert.deepEqual(
      repository.listRemoteImageUrlsToCache(),
      ["https://images.example.net/archive/photo.png"]
    )
    assert.deepEqual(
      repository.listRemoteAttachmentReferencesToCache(),
      [{
        url: "https://files.other.org/report.pdf",
        fileName: "外链附件",
        mimeType: "application/pdf",
        byteSize: 2048
      }]
    )
  })
})

test("云端图片地址会在已有本地缓存时恢复为离线引用", () => {
  withRepository((repository) => {
    const note = repository.createNote()
    repository.applySyncResult({
      snapshot: {
        folders: [],
        tags: [],
        notes: [{
          clientId: note.id,
          serverId: "1",
          folderClientId: null,
          title: note.title,
          content: "正文\n\n![截图](https://cdn.example.com/cached-asset.png)",
          isPinned: false,
          isDeleted: false,
          deletedTime: null,
          deletedByFolderClientId: null,
          tagClientIds: [],
          createdAt: note.createdAt,
          updatedAt: note.updatedAt
        }],
        histories: []
      }
    })
    const asset = repository.createImageAsset({
      fileName: "截图.png",
      mimeType: "image/png",
      byteSize: 128,
      sha256: "cached-asset",
      localPath: "/tmp/cached-asset.png"
    })
    repository.markImageAssetUploaded(asset.id, "https://cdn.example.com/cached-asset.png")

    assert.equal(
      repository.getNoteForEditing(note.id)?.content,
      `正文\n\n![截图](${asset.localUrl})`
    )
  })
})

test("迁移数据目录后会更新图片资源的本地路径", () => {
  withRepository((repository) => {
    const previousDirectory = "/tmp/心悦离线笔记/assets"
    const currentDirectory = "/tmp/心悦笔记/profiles/domain/assets"
    const asset = repository.createImageAsset({
      fileName: "截图.png",
      mimeType: "image/png",
      byteSize: 128,
      sha256: "relocated-asset",
      localPath: `${previousDirectory}/ab/relocated-asset.png`
    })

    assert.equal(repository.relocateImageAssetPaths(previousDirectory, currentDirectory), 1)
    assert.equal(
      repository.getImageAsset(asset.id)?.localPath,
      `${currentDirectory}/ab/relocated-asset.png`
    )
  })
})

test("相同笔记内容重复保存不会改变更新时间", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "ltw-notes-database-"))
  const repository = openNotesDatabase(directory)
  try {
    const created = repository.createNote()
    await new Promise((resolve) => setTimeout(resolve, 10))
    const saved = repository.updateNote(created.id, {
      title: created.title,
      content: created.content,
      folderId: created.folderId,
      isPinned: created.isPinned,
      tagNames: created.tags.map((tag) => tag.name)
    })

    assert.equal(saved.updatedAt, created.updatedAt)
  } finally {
    repository.close()
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

function createNoteConflict(repository) {
  const created = repository.createNote()
  const local = repository.updateNote(created.id, {
    title: "本地方案",
    content: "本地修改后的正文",
    tagNames: ["本地标签"]
  })
  const batch = repository.getSyncBatch()
  repository.applySyncResult({
    snapshot: {
      folders: [],
      tags: [],
      notes: [{
        clientId: local.id,
        serverId: "note-server-1",
        folderClientId: null,
        title: "云端方案",
        content: "云端修改后的正文",
        isPinned: false,
        isDeleted: false,
        deletedTime: null,
        deletedByFolderClientId: null,
        tagClientIds: [],
        createdAt: local.createdAt,
        updatedAt: "2026-08-12T12:00:00.000Z"
      }],
      histories: []
    },
    mappings: [{ entityType: "note", clientId: local.id, serverId: "note-server-1", updatedAt: "2026-08-12T12:00:00.000Z" }],
    conflictClientIds: [local.id]
  }, batch.outboxIds)
  return repository.listNoteConflicts()[0]
}

test("同步冲突副本保留原笔记关联并可采用本地版本", () => {
  withRepository((repository) => {
    const pair = createNoteConflict(repository)
    assert.equal(pair.original.content, "云端修改后的正文")
    assert.equal(pair.conflict.content, "本地修改后的正文")
    assert.equal(pair.conflict.conflictSourceId, pair.original.id)

    const result = repository.resolveNoteConflict(pair.conflict.id, "local")
    assert.equal(result.note.id, pair.original.id)
    assert.equal(result.note.title, "本地方案")
    assert.equal(result.note.content, "本地修改后的正文")
    assert.deepEqual(result.note.tags.map((tag) => tag.name), ["本地标签"])
    assert.deepEqual(repository.listNoteConflicts(), [])
    assert.equal(repository.listWorkspace().notes.some((note) => note.id === pair.conflict.id), false)
  })
})

test("同步冲突可以采用云端版本或将两份都保留", () => {
  withRepository((repository) => {
    let pair = createNoteConflict(repository)
    let result = repository.resolveNoteConflict(pair.conflict.id, "remote")
    assert.equal(result.note.content, "云端修改后的正文")
    assert.equal(repository.listWorkspace().notes.length, 1)
    assert.deepEqual(repository.listNoteConflicts(), [])
    const localHistory = repository.listNoteHistory(result.note.id)
      .find((history) => history.title === "本地方案")
    assert.ok(localHistory)
    assert.equal(
      repository.getNoteHistory(result.note.id, localHistory.id).content,
      "本地修改后的正文"
    )

    repository.updateNote(result.note.id, { content: "第二次本地修改" })
    const batch = repository.getSyncBatch()
    repository.applySyncResult({
      snapshot: {
        folders: [], tags: [], histories: [],
        notes: [{
          clientId: result.note.id, serverId: "note-server-1", folderClientId: null,
          title: "第二次云端修改", content: "第二次云端正文", isPinned: false,
          isDeleted: false, deletedTime: null, deletedByFolderClientId: null,
          tagClientIds: [], createdAt: result.note.createdAt, updatedAt: "2026-08-12T13:00:00.000Z"
        }]
      },
      mappings: [],
      conflictClientIds: [result.note.id]
    }, batch.outboxIds)
    pair = repository.listNoteConflicts()[0]
    result = repository.resolveNoteConflict(pair.conflict.id, "both")

    assert.equal(result.note.id, pair.conflict.id)
    assert.equal(result.note.conflictSourceId, null)
    assert.equal(repository.listWorkspace().notes.length, 2)
    assert.deepEqual(repository.listNoteConflicts(), [])
  })
})

test("云端历史快照会落入本地并且每篇笔记只保留最新50条", () => {
  withRepository((repository) => {
    const note = repository.createNote()
    const histories = Array.from({ length: 55 }, (_, index) => ({
      clientId: `history-${index}`,
      noteClientId: note.id,
      title: `版本 ${index}`,
      content: `正文 ${index}`,
      folderClientId: null,
      tagNames: [],
      createdAt: new Date(Date.UTC(2026, 0, 1, 0, index)).toISOString()
    }))

    repository.applySyncResult({
      snapshot: {
        folders: [],
        tags: [],
        notes: [{
          clientId: note.id,
          serverId: "1",
          folderClientId: null,
          title: note.title,
          content: note.content,
          isPinned: false,
          isDeleted: false,
          deletedTime: null,
          deletedByFolderClientId: null,
          tagClientIds: [],
          createdAt: note.createdAt,
          updatedAt: note.updatedAt
        }],
        histories
      },
      mappings: [],
      conflictClientIds: []
    })

    const localHistories = repository.listNoteHistory(note.id)
    assert.equal(localHistories.length, 50)
    assert.equal(localHistories[0].id, "history-54")
    assert.equal(localHistories.at(-1).id, "history-5")
  })
})

test("删除已同步历史版本会生成历史删除墓碑", () => {
  withRepository((repository) => {
    const note = repository.createNote()
    repository.applySyncResult({
      snapshot: {
        folders: [],
        tags: [],
        notes: [{
          clientId: note.id,
          serverId: "1",
          folderClientId: null,
          title: note.title,
          content: note.content,
          isPinned: false,
          isDeleted: false,
          deletedTime: null,
          deletedByFolderClientId: null,
          tagClientIds: [],
          createdAt: note.createdAt,
          updatedAt: note.updatedAt
        }],
        histories: [{
          clientId: "history-1",
          noteClientId: note.id,
          title: "历史版本",
          content: "历史正文",
          folderClientId: null,
          tagNames: [],
          createdAt: "2026-01-01T00:00:00.000Z"
        }]
      },
      mappings: [],
      conflictClientIds: []
    })

    assert.equal(repository.deleteNoteHistory(note.id, "history-1"), true)
    assert.deepEqual(
      repository.getSyncBatch().tombstones.filter((item) => item.entityType === "history"),
      [{ entityType: "history", clientId: "history-1", serverId: null }]
    )
  })
})

test("同步期间清空回收站不会被旧云端快照恢复", () => {
  withRepository((repository) => {
    const note = repository.createNote()
    const initialBatch = repository.getSyncBatch()
    const remoteNote = {
      clientId: note.id,
      serverId: "1",
      folderClientId: null,
      title: note.title,
      content: note.content,
      isPinned: false,
      isDeleted: true,
      deletedTime: "2026-08-02T00:00:00.000Z",
      deletedByFolderClientId: null,
      tagClientIds: [],
      createdAt: note.createdAt,
      updatedAt: "2026-08-02T00:00:00.000Z"
    }
    repository.applySyncResult({
      snapshot: { folders: [], tags: [], notes: [remoteNote] },
      mappings: [{ entityType: "note", clientId: note.id, serverId: "1" }]
    }, initialBatch.outboxIds)
    repository.setNoteDeleted(note.id, true)
    const deletingBatch = repository.getSyncBatch()
    repository.applySyncResult({ snapshot: { folders: [], tags: [], notes: [remoteNote] } }, deletingBatch.outboxIds)

    const staleBatch = repository.getSyncBatch()
    assert.deepEqual(staleBatch.tombstones, [])
    repository.emptyTrash()
    repository.applySyncResult({ snapshot: { folders: [], tags: [], notes: [remoteNote] } }, staleBatch.outboxIds)

    assert.equal(repository.listWorkspace().notes.some((item) => item.id === note.id), false)
    assert.deepEqual(
      repository.getSyncBatch().tombstones.filter((item) => item.entityType === "note"),
      [{ entityType: "note", clientId: note.id, serverId: "1" }]
    )
  })
})

test("同步期间移动文件夹不会被旧云端快照还原", () => {
  withRepository((repository) => {
    const oldParent = repository.createFolder("原父目录")
    const newParent = repository.createFolder("新父目录")
    const child = repository.createFolder("待移动目录", oldParent.id)
    const initialBatch = repository.getSyncBatch()
    const remoteFolders = [oldParent, newParent, child].map((folder, index) => ({
      clientId: folder.id,
      serverId: String(index + 1),
      parentClientId: folder.parentId,
      name: folder.name,
      sortOrder: folder.sortOrder,
      isDeleted: false,
      deletedTime: null,
      deletedRootClientId: null,
      createdAt: folder.createdAt,
      updatedAt: folder.updatedAt
    }))
    repository.applySyncResult({
      snapshot: { folders: remoteFolders, tags: [], notes: [] },
      mappings: remoteFolders.map((folder) => ({
        entityType: "folder",
        clientId: folder.clientId,
        serverId: folder.serverId
      }))
    }, initialBatch.outboxIds)

    const staleBatch = repository.getSyncBatch()
    repository.moveFolder(child.id, newParent.id)
    repository.applySyncResult({
      snapshot: { folders: remoteFolders, tags: [], notes: [] }
    }, staleBatch.outboxIds)

    const movedFolder = repository.listWorkspace().folders.find((folder) => folder.id === child.id)
    assert.equal(movedFolder?.parentId, newParent.id)
    assert.equal(
      repository.getSyncBatch().folders.find((folder) => folder.clientId === child.id)?.parentClientId,
      newParent.id
    )
  })
})

test("云端已删除的历史版本会从桌面缓存移除", () => {
  withRepository((repository) => {
    const note = repository.createNote()
    const remoteNote = {
      clientId: note.id,
      serverId: "1",
      folderClientId: null,
      title: note.title,
      content: note.content,
      isPinned: false,
      isDeleted: false,
      deletedTime: null,
      deletedByFolderClientId: null,
      tagClientIds: [],
      createdAt: note.createdAt,
      updatedAt: note.updatedAt
    }
    repository.applySyncResult({
      snapshot: {
        folders: [],
        tags: [],
        notes: [remoteNote],
        histories: [{
          clientId: "history-1",
          noteClientId: note.id,
          title: "历史版本",
          content: "历史正文",
          folderClientId: null,
          tagNames: [],
          createdAt: "2026-01-01T00:00:00.000Z"
        }]
      }
    })
    assert.equal(repository.listNoteHistory(note.id).length, 1)

    repository.applySyncResult({
      snapshot: { folders: [], tags: [], notes: [remoteNote], histories: [] }
    })

    assert.equal(repository.listNoteHistory(note.id).length, 0)
  })
})

test("旧服务端未返回历史字段时会保留待上传的本地历史", () => {
  withRepository((repository) => {
    const note = repository.createNote()
    repository.updateNote(note.id, { content: "本地新正文" })

    repository.applySyncResult({
      snapshot: {
        folders: [],
        tags: [],
        notes: [{
          clientId: note.id,
          serverId: "1",
          folderClientId: null,
          title: note.title,
          content: "本地新正文",
          isPinned: false,
          isDeleted: false,
          deletedTime: null,
          deletedByFolderClientId: null,
          tagClientIds: [],
          createdAt: note.createdAt,
          updatedAt: new Date().toISOString()
        }]
      }
    })

    assert.equal(repository.getSyncBatch().histories.length, 1)
  })
})

test("历史列表摘要会移除HTML标签并保留可读间隔", () => {
  withRepository((repository) => {
    const note = repository.createNote()
    repository.updateNote(note.id, {
      content: "第一行<br /><strong>第二行</strong><script>不应显示</script>"
    })
    const initialHistory = repository.listNoteHistory(note.id)[0]

    repository.restoreNoteHistory(note.id, initialHistory.id)

    const historySummary = repository.listNoteHistory(note.id)
      .find((history) => history.contentPreview === "第一行 第二行")
    assert.ok(historySummary)
    const htmlHistory = repository.getNoteHistory(note.id, historySummary.id)
    assert.equal(htmlHistory?.contentPreview, "第一行 第二行")
  })
})

test("历史列表只返回短摘要并按需读取完整正文", () => {
  withRepository((repository) => {
    const note = repository.createNote()
    const largeContent = `历史开头 ${"x".repeat(2_000_000)}`
    repository.applySyncResult({
      snapshot: {
        folders: [],
        tags: [],
        notes: [{
          clientId: note.id,
          serverId: "1",
          folderClientId: null,
          title: note.title,
          content: "当前正文",
          isPinned: false,
          isDeleted: false,
          deletedTime: null,
          deletedByFolderClientId: null,
          tagClientIds: [],
          createdAt: note.createdAt,
          updatedAt: note.updatedAt
        }],
        histories: [{
          clientId: "large-history",
          noteClientId: note.id,
          title: "大正文历史",
          content: largeContent,
          folderClientId: null,
          tagNames: [],
          createdAt: "2026-08-02T00:00:00.000Z"
        }]
      }
    })

    const summary = repository.listNoteHistory(note.id)
      .find((history) => history.contentPreview.startsWith("历史开头"))
    assert.ok(summary)
    assert.equal(summary.content, "")
    assert.ok(summary.contentPreview.length <= 120)

    const detail = repository.getNoteHistory(note.id, summary.id)
    assert.equal(detail?.content, largeContent)
  })
})

test("完整备份导入会生成独立目录并保留标签和历史版本", () => {
  withRepository((repository) => {
    const folder = repository.createFolder("原目录")
    const note = repository.createNote(folder.id)
    repository.createImageAsset({
      fileName: "备份图片.png",
      mimeType: "image/png",
      byteSize: 128,
      sha256: "backup-image",
      localPath: "/tmp/backup-image.png"
    })
    repository.updateNote(note.id, {
      title: "备份笔记",
      content: "第一版",
      tagNames: ["备份"]
    })
    const backup = repository.exportBackup()

    assert.equal(backup.version, 2)
    assert.equal(backup.assets.length, 1)
    assert.equal(backup.assets[0].sha256, "backup-image")

    const result = repository.importBackup(backup)

    assert.equal(result.importedNotes, 1)
    const workspace = repository.listWorkspace()
    const importedRoot = workspace.folders.find((item) => item.name.startsWith("导入备份 "))
    const importedFolder = workspace.folders.find(
      (item) => item.parentId === importedRoot?.id && item.name === "原目录"
    )
    const importedNote = workspace.notes.find(
      (item) => item.folderId === importedFolder?.id && item.title === "备份笔记"
    )
    assert.deepEqual(importedNote?.tags.map((tag) => tag.name), ["备份"])
    assert.ok(repository.listNoteHistory(importedNote.id).length >= 1)
  })
})

test("批量Markdown导入会进入指定文件夹并自动创建标签", () => {
  withRepository((repository) => {
    const folder = repository.createFolder("收集箱")

    const result = repository.importMarkdownDocuments([
      { title: "第一篇", content: "正文一", tagNames: ["导入"] },
      { title: "第二篇", content: "正文二", tagNames: [] }
    ], folder.id)

    assert.equal(result.importedNotes, 2)
    const notes = repository.listWorkspace().notes.filter((note) => note.folderId === folder.id)
    assert.deepEqual(notes.map((note) => note.title).sort(), ["第一篇", "第二篇"])
    assert.deepEqual(notes.find((note) => note.title === "第一篇")?.tags.map((tag) => tag.name), ["导入"])
  })
})

test("Markdown目录导入会创建来源根目录并保留子目录层级", () => {
  withRepository((repository) => {
    const targetFolder = repository.createFolder("导入目标")

    const result = repository.importMarkdownDocuments([
      { title: "根笔记", content: "根正文", tagNames: [], folderPath: [] },
      { title: "接口", content: "接口正文", tagNames: ["后端"], folderPath: ["开发", "后端"] }
    ], targetFolder.id, "资料库")

    const workspace = repository.listWorkspace()
    const importedRoot = workspace.folders.find(
      (folder) => folder.parentId === targetFolder.id && folder.name === "资料库"
    )
    const developmentFolder = workspace.folders.find(
      (folder) => folder.parentId === importedRoot?.id && folder.name === "开发"
    )
    const backendFolder = workspace.folders.find(
      (folder) => folder.parentId === developmentFolder?.id && folder.name === "后端"
    )

    assert.equal(result.rootFolderId, importedRoot?.id)
    assert.equal(result.importedFolders, 3)
    assert.equal(
      workspace.notes.find((note) => note.title === "根笔记")?.folderId,
      importedRoot?.id
    )
    assert.equal(
      workspace.notes.find((note) => note.title === "接口")?.folderId,
      backendFolder?.id
    )
  })
})

test("Markdown目录导入到根目录时会合并同名文件夹及子目录", () => {
  withRepository((repository) => {
    const existingRoot = repository.createFolder("资料库")
    const existingChild = repository.createFolder("开发", existingRoot.id)
    const existingNote = repository.createNote(existingRoot.id)
    repository.updateNote(existingNote.id, { title: "原有笔记" })

    const result = repository.importMarkdownDocuments([
      { title: "新增笔记", content: "新增正文", tagNames: [], folderPath: [] },
      { title: "接口笔记", content: "接口正文", tagNames: [], folderPath: ["开发"] }
    ], null, "资料库")

    const workspace = repository.listWorkspace()
    assert.equal(
      workspace.folders.filter((folder) => folder.parentId === null && folder.name === "资料库").length,
      1
    )
    assert.equal(result.rootFolderId, existingRoot.id)
    assert.equal(result.importedFolders, 0)
    assert.equal(
      workspace.notes.find((note) => note.title === "新增笔记")?.folderId,
      existingRoot.id
    )
    assert.equal(
      workspace.notes.find((note) => note.title === "接口笔记")?.folderId,
      existingChild.id
    )
  })
})

test("笔记正文保存会按UTF-8字节数限制为15MiB", () => {
  withRepository((repository) => {
    const note = repository.createNote(null)
    const maximumContent = "a".repeat(15 * 1024 * 1024)

    assert.equal(repository.updateNote(note.id, { content: maximumContent })?.content.length, maximumContent.length)
    assert.throws(
      () => repository.updateNote(note.id, { content: `${maximumContent}a` }),
      /15 MiB/
    )
  })
})

test("反向链接识别桌面内部链接的旧版与新版格式", () => {
  withRepository((repository) => {
    const source = repository.createNote(null)
    const target = repository.createNote(null)

    // 新版 https://xinyue-note.local/{noteId}
    repository.updateNote(source.id, { content: `新格式 [目标](https://xinyue-note.local/${target.id})` })
    assert.ok(repository.getBacklinks(target.id).some((item) => item.id === source.id))

    // 旧版 xinyue-notes://note/{noteId} 仍应兼容
    repository.updateNote(source.id, { content: `旧格式 [目标](xinyue-notes://note/${target.id})` })
    assert.ok(repository.getBacklinks(target.id).some((item) => item.id === source.id))
  })
})

test("局部图谱按中心笔记双向展开并防环", () => {
  withRepository((repository) => {
    const center = repository.createNote(null)
    const outA = repository.createNote(null)
    const inB = repository.createNote(null)

    // 出链：center -> outA；入链：inB -> center；三笔记联成一环。
    repository.updateNote(center.id, { content: `link [outA](https://xinyue-note.local/${outA.id})` })
    repository.updateNote(inB.id, { content: `link [center](https://xinyue-note.local/${center.id})` })
    // 引用的笔记需要有标题才会被索引为 reach，但链接本身已写入 note_links。
    repository.updateNote(outA.id, { title: "出链目标" })
    repository.updateNote(inB.id, { title: "入链来源" })
    repository.updateNote(center.id, { title: "中心" })

    const graph = repository.getNoteGraph(center.id, 2)
    const ids = graph.nodes.map((node) => node.id)
    assert.ok(graph.nodes.length >= 3, `应包含中心与至少两个邻居，实际 ${ids.join(",")}`)
    assert.ok(ids.includes(center.id), "应包含中心节点")
    assert.ok(ids.includes(outA.id), "应包含出链节点")
    assert.ok(ids.includes(inB.id), "应包含入链节点")

    // 中心 depth=0，邻居 depth=1。
    const centerNode = graph.nodes.find((node) => node.id === center.id)
    const neighbor = graph.nodes.find((node) => node.id === outA.id)
    assert.equal(centerNode?.depth, 0)
    assert.equal(neighbor?.depth, 1)

    // links 应覆盖 center->outA 与 inB->center 两条边，且无自环。
    const pairSet = graph.links.map((edge) => `${edge.source}->${edge.target}`)
    assert.ok(pairSet.includes(`${center.id}->${outA.id}`))
    assert.ok(pairSet.includes(`${inB.id}->${center.id}`))
    assert.ok(graph.links.every((edge) => edge.source !== edge.target))
  })
})

test("局部图谱排除已删除笔记与自环，空引用返回空集", () => {
  withRepository((repository) => {
    const center = repository.createNote(null)
    const deleted = repository.createNote(null)
    repository.updateNote(deleted.id, { title: "将被删除" })
    repository.updateNote(center.id, {
      title: "中心",
      content: `[del](https://xinyue-note.local/${deleted.id})`
    })
    repository.setNoteDeleted(deleted.id, true)

    const graph = repository.getNoteGraph(center.id, 2)
    const ids = graph.nodes.map((node) => node.id)
    assert.ok(ids.includes(center.id), "中心节点始终保留")
    assert.ok(!ids.includes(deleted.id), "已删除笔记不应出现在图谱中")
    assert.ok(graph.links.every((edge) => edge.source !== edge.target), "不应存在自环边")

    const lonely = repository.createNote(null)
    repository.updateNote(lonely.id, { title: "孤立" })
    const empty = repository.getNoteGraph(lonely.id, 2)
    assert.equal(empty.nodes.length, 1)
    assert.equal(empty.nodes[0].id, lonely.id)
    assert.equal(empty.links.length, 0)
  })
})
