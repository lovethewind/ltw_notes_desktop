const assert = require("node:assert/strict")
const { createHash } = require("node:crypto")
const test = require("node:test")
const {
  executeAttachmentIntegrityRepair
} = require("../electron/attachment-integrity.cjs")

function body(value) {
  return Buffer.from(value)
}

function asset(id, content, overrides = {}) {
  return {
    id,
    fileName: `${id}.png`,
    mimeType: "image/png",
    sha256: createHash("sha256").update(content).digest("hex"),
    remoteUrl: `https://cdn.example.com/${id}.png`,
    ...overrides
  }
}

test("附件完整性修复会校验哈希、重下缺失文件并重传待上传附件", async () => {
  const healthyBody = body("healthy")
  const missingBody = body("missing")
  const corruptExpectedBody = body("corrupt-expected")
  const pendingBody = body("pending")
  const wrongRemoteExpectedBody = body("wrong-remote-expected")
  const assets = [
    asset("healthy", healthyBody),
    asset("missing", missingBody),
    asset("corrupt", corruptExpectedBody),
    asset("pending", pendingBody, { remoteUrl: null }),
    asset("pending-missing", body("pending-missing"), { remoteUrl: null }),
    asset("wrong-remote", wrongRemoteExpectedBody)
  ]
  const localBodies = new Map([
    ["healthy", healthyBody],
    ["corrupt", body("damaged")],
    ["pending", pendingBody]
  ])
  const remoteBodies = new Map([
    ["missing", missingBody],
    ["corrupt", corruptExpectedBody],
    ["wrong-remote", body("unexpected-remote-body")]
  ])
  const writes = []
  const uploads = []

  const result = await executeAttachmentIntegrityRepair(assets, {
    readLocal: async (current) => localBodies.get(current.id) || null,
    download: async (current) => remoteBodies.get(current.id),
    writeLocal: async (current, data) => {
      writes.push(current.id)
      localBodies.set(current.id, data)
    },
    upload: async (current) => uploads.push(current.id)
  })

  assert.deepEqual(writes, ["missing", "corrupt"])
  assert.deepEqual(uploads, ["pending"])
  assert.deepEqual({
    candidateCount: result.candidateCount,
    healthyCount: result.healthyCount,
    repairedCount: result.repairedCount,
    downloadedCount: result.downloadedCount,
    uploadedCount: result.uploadedCount,
    failedCount: result.failedCount
  }, {
    candidateCount: 6,
    healthyCount: 1,
    repairedCount: 3,
    downloadedCount: 2,
    uploadedCount: 1,
    failedCount: 2
  })
  assert.deepEqual(result.failures.map((failure) => [failure.assetId, failure.issue]), [
    ["pending-missing", "missing"],
    ["wrong-remote", "missing"]
  ])
  assert.match(result.failures[1].message, /哈希不一致/)
})

test("单个附件读取或下载失败不会阻断后续附件", async () => {
  const firstBody = body("first")
  const secondBody = body("second")
  const result = await executeAttachmentIntegrityRepair([
    asset("first", firstBody),
    asset("second", secondBody)
  ], {
    readLocal: async (current) => {
      if (current.id === "first") throw new Error("无法读取")
      return secondBody
    },
    download: async () => null,
    writeLocal: async () => {},
    upload: async () => {}
  })

  assert.equal(result.failedCount, 1)
  assert.equal(result.healthyCount, 1)
  assert.equal(result.failures[0].assetId, "first")
})
