const assert = require("node:assert/strict")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const test = require("node:test")
const {
  createDatabaseBackupManager,
  restoreDatabaseFile,
  restoreProfileSnapshot
} = require("../electron/database-backup.cjs")
const { openNotesDatabase } = require("../electron/database.cjs")

/**
 * 创建测试用备份管理器。
 *
 * @param {string} profilePath 测试档案目录。
 * @param {Date[]} dates 每次创建备份使用的时间。
 * @param {number} maxBackups 最大保留数量。
 * @returns {ReturnType<typeof createDatabaseBackupManager>} 备份管理器。
 */
function createTestManager(profilePath, dates, maxBackups = 10) {
  let index = 0
  return createDatabaseBackupManager({
    profilePath,
    maxBackups,
    now: () => dates[Math.min(index++, dates.length - 1)],
    backupDatabase: async (targetPath) => {
      await fs.promises.writeFile(targetPath, `snapshot-${index}`)
    }
  })
}

test("每日自动备份当天只创建一次", async (context) => {
  const profilePath = await fs.promises.mkdtemp(path.join(os.tmpdir(), "xinyue-backup-"))
  context.after(() => fs.rmSync(profilePath, { recursive: true, force: true }))
  const manager = createTestManager(profilePath, [
    new Date("2026-07-29T01:00:00.000Z"),
    new Date("2026-07-29T09:00:00.000Z")
  ])

  const first = await manager.ensureDailyBackup()
  const second = await manager.ensureDailyBackup()

  assert.equal(first.created, true)
  assert.equal(second.created, false)
  assert.equal((await manager.listBackups()).length, 1)
})

test("自动清理超出保留数量的旧备份", async (context) => {
  const profilePath = await fs.promises.mkdtemp(path.join(os.tmpdir(), "xinyue-backup-"))
  context.after(() => fs.rmSync(profilePath, { recursive: true, force: true }))
  const dates = Array.from({ length: 12 }, (_, index) => (
    new Date(Date.UTC(2026, 6, 1 + index, 8, 0, 0))
  ))
  const manager = createTestManager(profilePath, dates, 10)

  for (let index = 0; index < dates.length; index += 1) {
    await manager.createBackup("manual")
  }

  const backups = await manager.listBackups()
  assert.equal(backups.length, 10)
  assert.equal(backups.at(-1).createdAt, dates[2].toISOString())
})

test("备份列表包含原因、大小并拒绝目录穿越", async (context) => {
  const profilePath = await fs.promises.mkdtemp(path.join(os.tmpdir(), "xinyue-backup-"))
  context.after(() => fs.rmSync(profilePath, { recursive: true, force: true }))
  const manager = createTestManager(profilePath, [new Date("2026-07-29T08:30:00.000Z")])

  const created = await manager.createBackup("before-import")
  const backups = await manager.listBackups()

  assert.equal(backups[0].id, created.id)
  assert.equal(backups[0].reason, "before-import")
  assert.ok(backups[0].size > 0)
  await assert.rejects(() => manager.resolveBackupPath("../notes.sqlite3"), /备份文件不存在/)
})

test("SQLite 在线备份包含创建完成的笔记", async (context) => {
  const profilePath = await fs.promises.mkdtemp(path.join(os.tmpdir(), "xinyue-database-"))
  context.after(() => fs.rmSync(profilePath, { recursive: true, force: true }))
  const repository = openNotesDatabase(profilePath)
  context.after(() => repository.close())
  const note = repository.createNote(null)
  repository.updateNote(note.id, { title: "备份中的笔记", content: "可恢复正文" })
  const manager = createDatabaseBackupManager({
    profilePath,
    backupDatabase: (targetPath) => repository.backupTo(targetPath),
    now: () => new Date("2026-07-29T10:00:00.000Z")
  })

  const backup = await manager.createBackup("manual")
  const restorePath = await fs.promises.mkdtemp(path.join(os.tmpdir(), "xinyue-restore-"))
  context.after(() => fs.rmSync(restorePath, { recursive: true, force: true }))
  const snapshotPath = await manager.resolveBackupPath(backup.id)
  await fs.promises.copyFile(
    path.join(snapshotPath, "notes.sqlite3"),
    path.join(restorePath, "notes.sqlite3")
  )
  const restoredRepository = openNotesDatabase(restorePath)
  context.after(() => restoredRepository.close())

  const restoredNote = restoredRepository.listWorkspace().notes.find((item) => item.id === note.id)
  assert.equal(restoredNote.title, "备份中的笔记")
  assert.equal(restoredNote.content, "可恢复正文")
})

test("完整快照同时保存数据库和附件目录", async (context) => {
  const profilePath = await fs.promises.mkdtemp(path.join(os.tmpdir(), "xinyue-complete-backup-"))
  context.after(() => fs.rmSync(profilePath, { recursive: true, force: true }))
  const assetsPath = path.join(profilePath, "assets", "ab")
  await fs.promises.mkdir(assetsPath, { recursive: true })
  await fs.promises.writeFile(path.join(assetsPath, "image.png"), "image-body")
  const manager = createTestManager(profilePath, [new Date("2026-07-29T10:30:00.000Z")])

  const backup = await manager.createBackup("manual")
  const snapshotPath = await manager.resolveBackupPath(backup.id)

  assert.equal(backup.kind, "complete")
  assert.equal(backup.assetCount, 1)
  assert.equal(await fs.promises.readFile(path.join(snapshotPath, "assets", "ab", "image.png"), "utf8"), "image-body")
  assert.equal(
    JSON.parse(await fs.promises.readFile(path.join(snapshotPath, "manifest.json"), "utf8")).assetCount,
    1
  )
})

test("完整快照恢复数据库和附件，并替换恢复后不存在的旧附件", async (context) => {
  const profilePath = await fs.promises.mkdtemp(path.join(os.tmpdir(), "xinyue-profile-restore-"))
  context.after(() => fs.rmSync(profilePath, { recursive: true, force: true }))
  const sourcePath = path.join(profilePath, "snapshot")
  const safetyPath = path.join(profilePath, "safety")
  await fs.promises.mkdir(path.join(sourcePath, "assets"), { recursive: true })
  await fs.promises.mkdir(path.join(safetyPath, "assets"), { recursive: true })
  await fs.promises.writeFile(path.join(sourcePath, "notes.sqlite3"), "restored-db")
  await fs.promises.writeFile(path.join(sourcePath, "assets", "restored.png"), "restored-asset")
  await fs.promises.writeFile(path.join(safetyPath, "notes.sqlite3"), "current-db")
  await fs.promises.writeFile(path.join(safetyPath, "assets", "current.png"), "current-asset")
  await fs.promises.writeFile(path.join(profilePath, "notes.sqlite3"), "current-db")
  await fs.promises.mkdir(path.join(profilePath, "assets"), { recursive: true })
  await fs.promises.writeFile(path.join(profilePath, "assets", "obsolete.png"), "obsolete")

  await restoreProfileSnapshot({
    sourcePath,
    safetyBackupPath: safetyPath,
    profilePath,
    closeDatabase: () => undefined,
    openDatabase: () => fs.readFileSync(path.join(profilePath, "notes.sqlite3"), "utf8"),
    validateDatabase: () => undefined
  })

  assert.equal(await fs.promises.readFile(path.join(profilePath, "notes.sqlite3"), "utf8"), "restored-db")
  assert.equal(await fs.promises.readFile(path.join(profilePath, "assets", "restored.png"), "utf8"), "restored-asset")
  assert.equal(fs.existsSync(path.join(profilePath, "assets", "obsolete.png")), false)
})

test("完整快照打开失败时数据库和附件一起回滚", async (context) => {
  const profilePath = await fs.promises.mkdtemp(path.join(os.tmpdir(), "xinyue-profile-rollback-"))
  context.after(() => fs.rmSync(profilePath, { recursive: true, force: true }))
  const sourcePath = path.join(profilePath, "snapshot")
  const safetyPath = path.join(profilePath, "safety")
  await fs.promises.mkdir(path.join(sourcePath, "assets"), { recursive: true })
  await fs.promises.mkdir(path.join(safetyPath, "assets"), { recursive: true })
  await fs.promises.writeFile(path.join(sourcePath, "notes.sqlite3"), "broken-db")
  await fs.promises.writeFile(path.join(sourcePath, "assets", "broken.png"), "broken-asset")
  await fs.promises.writeFile(path.join(safetyPath, "notes.sqlite3"), "current-db")
  await fs.promises.writeFile(path.join(safetyPath, "assets", "current.png"), "current-asset")
  await fs.promises.writeFile(path.join(profilePath, "notes.sqlite3"), "current-db")
  await fs.promises.mkdir(path.join(profilePath, "assets"), { recursive: true })
  await fs.promises.writeFile(path.join(profilePath, "assets", "current.png"), "current-asset")
  let openCount = 0

  await assert.rejects(() => restoreProfileSnapshot({
    sourcePath,
    safetyBackupPath: safetyPath,
    profilePath,
    closeDatabase: () => undefined,
    openDatabase: () => {
      openCount += 1
      if (openCount === 1) throw new Error("恢复后的数据库无法打开")
      return true
    },
    validateDatabase: () => undefined
  }), /恢复后的数据库无法打开/)

  assert.equal(await fs.promises.readFile(path.join(profilePath, "notes.sqlite3"), "utf8"), "current-db")
  assert.equal(await fs.promises.readFile(path.join(profilePath, "assets", "current.png"), "utf8"), "current-asset")
  assert.equal(fs.existsSync(path.join(profilePath, "assets", "broken.png")), false)
})

test("恢复数据库文件后重新打开目标快照", async (context) => {
  const profilePath = await fs.promises.mkdtemp(path.join(os.tmpdir(), "xinyue-file-restore-"))
  context.after(() => fs.rmSync(profilePath, { recursive: true, force: true }))
  const databasePath = path.join(profilePath, "notes.sqlite3")
  const sourcePath = path.join(profilePath, "source.sqlite3")
  const safetyBackupPath = path.join(profilePath, "safety.sqlite3")
  await fs.promises.writeFile(databasePath, "current")
  await fs.promises.writeFile(sourcePath, "restored")
  await fs.promises.writeFile(safetyBackupPath, "current")
  let closed = false

  const reopened = await restoreDatabaseFile({
    sourcePath,
    safetyBackupPath,
    databasePath,
    closeDatabase: () => { closed = true },
    openDatabase: () => fs.readFileSync(databasePath, "utf8"),
    validateDatabase: () => undefined
  })

  assert.equal(closed, true)
  assert.equal(reopened, "restored")
  assert.equal(await fs.promises.readFile(databasePath, "utf8"), "restored")
})

test("恢复后的数据库无法打开时自动回滚安全快照", async (context) => {
  const profilePath = await fs.promises.mkdtemp(path.join(os.tmpdir(), "xinyue-file-rollback-"))
  context.after(() => fs.rmSync(profilePath, { recursive: true, force: true }))
  const databasePath = path.join(profilePath, "notes.sqlite3")
  const sourcePath = path.join(profilePath, "source.sqlite3")
  const safetyBackupPath = path.join(profilePath, "safety.sqlite3")
  await fs.promises.writeFile(databasePath, "current")
  await fs.promises.writeFile(sourcePath, "broken")
  await fs.promises.writeFile(safetyBackupPath, "current")
  let openCount = 0

  await assert.rejects(() => restoreDatabaseFile({
    sourcePath,
    safetyBackupPath,
    databasePath,
    closeDatabase: () => undefined,
    openDatabase: () => {
      openCount += 1
      if (openCount === 1) throw new Error("无法打开恢复数据库")
      return fs.readFileSync(databasePath, "utf8")
    },
    validateDatabase: () => undefined
  }), /无法打开恢复数据库/)

  assert.equal(openCount, 2)
  assert.equal(await fs.promises.readFile(databasePath, "utf8"), "current")
})
