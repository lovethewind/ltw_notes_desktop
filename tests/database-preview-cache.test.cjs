const assert = require("node:assert/strict")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const test = require("node:test")
const Database = require("better-sqlite3")
const { openNotesDatabase } = require("../electron/database.cjs")

test("本地摘要缓存随正文写入自动更新且不影响完整快照", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "ltw-notes-preview-cache-"))
  const repository = openNotesDatabase(directory)
  const databasePath = path.join(directory, "notes.sqlite3")
  try {
    const note = repository.createNote()
    const originalContent = `摘要开头 ${"完整正文".repeat(500)} 原始结尾`
    repository.updateNote(note.id, { content: originalContent })

    const inspector = new Database(databasePath, { readonly: true })
    const cached = inspector.prepare(
      "SELECT content_prefix AS contentPrefix FROM note_previews WHERE note_id = ?"
    ).get(note.id)
    const previewVersion = inspector.prepare(
      "SELECT value FROM sync_state WHERE key = 'note_preview_version'"
    ).get()?.value
    inspector.close()

    assert.equal(previewVersion, "1")
    assert.ok(cached.contentPrefix.length < originalContent.length)
    assert.match(cached.contentPrefix, /^摘要开头/)
    assert.doesNotMatch(cached.contentPrefix, /原始结尾$/)

    const summary = repository.listWorkspace().notes.find((item) => item.id === note.id)
    assert.equal(summary.contentLoaded, false)
    assert.match(summary.content, /^摘要开头/)

    const full = repository.listFullWorkspace().notes.find((item) => item.id === note.id)
    assert.equal(full.contentLoaded, true)
    assert.equal(full.content, originalContent)
  } finally {
    repository.close()
    fs.rmSync(directory, { recursive: true, force: true })
  }
})
