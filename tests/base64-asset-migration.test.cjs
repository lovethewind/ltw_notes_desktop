const assert = require("node:assert/strict")
const { createHash } = require("node:crypto")
const { existsSync, mkdtempSync, readFileSync } = require("node:fs")
const { tmpdir } = require("node:os")
const path = require("node:path")
const test = require("node:test")
const Database = require("better-sqlite3")
const {
  collectEmbeddedBase64Images,
  replaceEmbeddedBase64Images
} = require("../electron/base64-asset-migration.cjs")
const { migrateDatabase } = require("../scripts/migrate-base64-assets.cjs")

test("扫描正文中的Base64图片并按原始二进制计算哈希", () => {
  const body = Buffer.from("original-image")
  const source = `data:image/png;charset=utf-8;base64,${body.toString("base64")}`
  const images = collectEmbeddedBase64Images(`前文 ![图](${source}) 后文`)

  assert.equal(images.length, 1)
  assert.equal(images[0].mimeType, "image/png")
  assert.equal(images[0].sha256, createHash("sha256").update(body).digest("hex"))
  assert.deepEqual(images[0].data, body)
})

test("迁移会复用同一图片并保持无法解析的内容不变", () => {
  const body = Buffer.from("same-image")
  const source = `data:image/jpeg;base64,${body.toString("base64")}`
  let resolveCount = 0
  const result = replaceEmbeddedBase64Images(
    `![一](${source})\n<img src="${source}">\ndata:image/png;base64,`,
    (image) => {
      resolveCount += 1
      return `xinyue-asset://local/${image.sha256}`
    }
  )

  assert.equal(resolveCount, 1)
  assert.equal(result.replacedCount, 2)
  assert.equal(result.uniqueImageCount, 1)
  assert.equal(result.content.match(/xinyue-asset:\/\/local\//g).length, 2)
  assert.match(result.content, /data:image\/png;base64,$/)
})

test("解析器拒绝伪造或空的Base64图片内容", () => {
  assert.deepEqual(collectEmbeddedBase64Images("data:image/png;base64,===="), [])
  assert.deepEqual(collectEmbeddedBase64Images("data:text/plain;base64,YQ=="), [])
})

test("数据库迁移默认只预览，应用时备份数据库并恢复附件引用", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "xinyue-base64-migration-"))
  const databasePath = path.join(directory, "notes.sqlite3")
  const database = new Database(databasePath)
  database.exec(`
    CREATE TABLE notes(id TEXT PRIMARY KEY, title TEXT, content TEXT, updated_at TEXT, dirty INTEGER);
    CREATE TABLE note_history(id TEXT PRIMARY KEY, note_id TEXT, content TEXT, dirty INTEGER);
    CREATE TABLE note_assets(
      id TEXT PRIMARY KEY, file_name TEXT, mime_type TEXT, byte_size INTEGER,
      sha256 TEXT UNIQUE, local_path TEXT, remote_url TEXT, server_source_id TEXT,
      created_at TEXT, updated_at TEXT
    );
    CREATE TABLE outbox(
      id INTEGER PRIMARY KEY AUTOINCREMENT, entity_type TEXT, entity_id TEXT,
      operation TEXT, payload TEXT, created_at TEXT, attempt_count INTEGER DEFAULT 0
    );
  `)
  const knownBody = Buffer.from("known-body")
  const newBody = Buffer.from("new-body")
  const knownHash = createHash("sha256").update(knownBody).digest("hex")
  const knownPath = path.join(directory, "assets", knownHash.slice(0, 2), `${knownHash}.png`)
  database.prepare(`
    INSERT INTO note_assets VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run("known-asset", "known.png", "image/png", knownBody.length, knownHash, knownPath,
    "https://cdn.example.com/known.png", null, "2026-08-13T00:00:00.000Z", "2026-08-13T00:00:00.000Z")
  database.prepare("INSERT INTO notes VALUES (?, ?, ?, ?, ?)").run(
    "note-1",
    "测试",
    `![已知](data:image/png;base64,${knownBody.toString("base64")})\n![新增](data:image/webp;base64,${newBody.toString("base64")})`,
    "2026-08-13T00:00:00.000Z",
    0
  )
  database.prepare("INSERT INTO note_history VALUES (?, ?, ?, ?)").run(
    "history-1",
    "note-1",
    `![历史](data:image/png;base64,${knownBody.toString("base64")})`,
    0
  )
  database.close()

  const preview = await migrateDatabase(databasePath, { apply: false })
  assert.equal(preview.base64Occurrences, 3)
  assert.equal(preview.matchedAssets, 1)
  assert.equal(preview.matchedRemoteAssets, 1)
  assert.equal(preview.newAssets, 1)
  const unchanged = new Database(databasePath, { readonly: true })
  assert.match(unchanged.prepare("SELECT content FROM notes").pluck().get(), /base64/)
  unchanged.close()

  const applied = await migrateDatabase(databasePath, { apply: true })
  assert.ok(existsSync(applied.backupPath))
  const migrated = new Database(databasePath, { readonly: true })
  const note = migrated.prepare("SELECT content, dirty FROM notes").get()
  assert.doesNotMatch(note.content, /base64/)
  assert.equal(note.dirty, 1)
  assert.match(note.content, /xinyue-asset:\/\/local\/known-asset/)
  assert.equal(migrated.prepare("SELECT count(*) FROM note_assets").pluck().get(), 2)
  assert.equal(migrated.prepare("SELECT count(*) FROM outbox WHERE entity_type = 'note'").pluck().get(), 1)
  assert.equal(migrated.prepare("SELECT dirty FROM note_history").pluck().get(), 1)
  const assets = migrated.prepare("SELECT sha256, local_path FROM note_assets").all()
  migrated.close()
  for (const asset of assets) {
    assert.deepEqual(createHash("sha256").update(readFileSync(asset.local_path)).digest("hex"), asset.sha256)
  }
})
