const assert = require("node:assert/strict")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const test = require("node:test")
const {
  isScheduledBackupDue,
  loadBackupSettings,
  normalizeBackupSettings,
  saveBackupSettings
} = require("../electron/database-backup-settings.cjs")

test("备份策略使用兼容默认值并限制保留数量", () => {
  assert.deepEqual(normalizeBackupSettings({}), { schedule: "daily", retention: 10 })
  assert.deepEqual(normalizeBackupSettings({ schedule: "weekly", retention: 99 }), {
    schedule: "weekly",
    retention: 50
  })
})

test("每日、每周和关闭策略正确判断是否到期", () => {
  const now = new Date("2026-07-29T12:00:00.000Z")
  assert.equal(isScheduledBackupDue("daily", new Date("2026-07-28T11:59:59.000Z"), now), true)
  assert.equal(isScheduledBackupDue("weekly", new Date("2026-07-23T12:00:00.000Z"), now), false)
  assert.equal(isScheduledBackupDue("off", null, now), false)
})

test("备份策略按档案目录持久化", async (context) => {
  const profilePath = await fs.promises.mkdtemp(path.join(os.tmpdir(), "xinyue-backup-settings-"))
  context.after(() => fs.rmSync(profilePath, { recursive: true, force: true }))
  await saveBackupSettings(profilePath, { schedule: "weekly", retention: 6 })
  assert.deepEqual(loadBackupSettings(profilePath), { schedule: "weekly", retention: 6 })
})
