const assert = require("node:assert/strict")
const test = require("node:test")
const {
  createDatabaseBackupStatusTracker
} = require("../electron/database-backup-status.cjs")

test("备份成功后记录最近时间、原因和附件数量", () => {
  const changes = []
  const tracker = createDatabaseBackupStatusTracker((status) => changes.push(status))

  const status = tracker.recordSuccess({
    createdAt: "2026-07-29T12:00:00.000Z",
    reason: "daily",
    kind: "complete",
    assetCount: 3
  })

  assert.deepEqual(status, {
    state: "success",
    message: "数据库和 3 个附件已备份",
    lastSuccessAt: "2026-07-29T12:00:00.000Z",
    reason: "daily"
  })
  assert.deepEqual(changes, [status])
})

test("备份失败保留最近成功时间并发布错误", () => {
  const tracker = createDatabaseBackupStatusTracker(() => undefined)
  tracker.recordSuccess({
    createdAt: "2026-07-29T12:00:00.000Z",
    reason: "manual",
    kind: "complete",
    assetCount: 0
  })

  const status = tracker.recordFailure(new Error("磁盘空间不足"), true)

  assert.equal(status.state, "error")
  assert.equal(status.message, "自动备份失败：磁盘空间不足")
  assert.equal(status.lastSuccessAt, "2026-07-29T12:00:00.000Z")
})

test("切换档案时重置备份状态", () => {
  const tracker = createDatabaseBackupStatusTracker(() => undefined)
  tracker.recordFailure(new Error("失败"))

  assert.deepEqual(tracker.reset(), {
    state: "idle",
    message: "尚未创建备份",
    lastSuccessAt: "",
    reason: ""
  })
})
