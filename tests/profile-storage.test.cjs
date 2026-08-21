const assert = require("node:assert/strict")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const test = require("node:test")
const {
  getProfileDataPath,
  migrateAccountProfile,
  migrateDomainProfile,
  shouldConfirmLocalProfileTransfer
} = require("../electron/profile-storage.cjs")

/**
 * 在隔离临时目录中执行档案路径测试。
 *
 * :param {(directory: string) => void} run 测试逻辑。
 * :returns {void}
 */
function withTemporaryDirectory(run) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "ltw-notes-profile-"))
  try {
    run(directory)
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
}

test("不同后端域名或不同用户使用不同且稳定的本地数据档案", () => {
  const root = "/tmp/心悦笔记"
  const firstPath = getProfileDataPath(root, "https://notes-a.example.com", "1001")
  const repeatedPath = getProfileDataPath(root, "https://notes-a.example.com", "1001")
  const secondUserPath = getProfileDataPath(root, "https://notes-a.example.com", "1002")
  const secondDomainPath = getProfileDataPath(root, "https://notes-b.example.com", "1001")
  const localPath = getProfileDataPath(root, "https://notes-a.example.com", "")

  assert.equal(firstPath, repeatedPath)
  assert.notEqual(firstPath, secondUserPath)
  assert.notEqual(firstPath, secondDomainPath)
  assert.notEqual(firstPath, localPath)
  assert.equal(path.basename(localPath), "local")
})

test("旧的域名单层档案会迁移到指定用户且不会覆盖已有档案", () => {
  withTemporaryDirectory((directory) => {
    const userDataPath = path.join(directory, "心悦笔记")
    const backendUrl = "https://notes.example.com"
    const domainProfilePath = path.dirname(getProfileDataPath(userDataPath, backendUrl, "1001"))
    fs.mkdirSync(path.join(domainProfilePath, "assets"), { recursive: true })
    fs.writeFileSync(path.join(domainProfilePath, "notes.sqlite3"), "domain-database")
    fs.writeFileSync(path.join(domainProfilePath, "assets", "image.png"), "image")

    assert.equal(migrateDomainProfile(userDataPath, backendUrl, "1001"), true)
    const userProfilePath = getProfileDataPath(userDataPath, backendUrl, "1001")
    assert.equal(fs.readFileSync(path.join(userProfilePath, "notes.sqlite3"), "utf8"), "domain-database")
    assert.equal(fs.readFileSync(path.join(userProfilePath, "assets", "image.png"), "utf8"), "image")

    fs.writeFileSync(path.join(userProfilePath, "notes.sqlite3"), "current")
    assert.equal(migrateDomainProfile(userDataPath, backendUrl, "1001"), false)
    assert.equal(fs.readFileSync(path.join(userProfilePath, "notes.sqlite3"), "utf8"), "current")
  })
})

test("未登录档案只会在目标用户档案为空时迁移", () => {
  withTemporaryDirectory((directory) => {
    const userDataPath = path.join(directory, "心悦笔记")
    const backendUrl = "https://notes.example.com"
    const localProfilePath = getProfileDataPath(userDataPath, backendUrl, "")
    fs.mkdirSync(localProfilePath, { recursive: true })
    fs.writeFileSync(path.join(localProfilePath, "notes.sqlite3"), "local")

    assert.equal(migrateAccountProfile(userDataPath, backendUrl, "", "1001"), true)
    const userProfilePath = getProfileDataPath(userDataPath, backendUrl, "1001")
    assert.equal(fs.readFileSync(path.join(userProfilePath, "notes.sqlite3"), "utf8"), "local")

    fs.writeFileSync(path.join(userProfilePath, "notes.sqlite3"), "user")
    assert.equal(migrateAccountProfile(userDataPath, backendUrl, "", "1001"), false)
    assert.equal(fs.readFileSync(path.join(userProfilePath, "notes.sqlite3"), "utf8"), "user")
  })
})

test("仅在 local 有内容且目标用户档案已存在时要求确认", () => {
  const baseInput = {
    currentBackendUrl: "https://notes.example.com",
    nextBackendUrl: "https://notes.example.com",
    currentAccountId: "",
    nextAccountId: "1001",
    hasLocalContent: true,
    targetProfileExists: true
  }

  assert.equal(shouldConfirmLocalProfileTransfer(baseInput), true)
  assert.equal(shouldConfirmLocalProfileTransfer({ ...baseInput, currentAccountId: "1000" }), false)
  assert.equal(shouldConfirmLocalProfileTransfer({
    ...baseInput,
    nextBackendUrl: "https://other.example.com"
  }), false)
  assert.equal(shouldConfirmLocalProfileTransfer({ ...baseInput, hasLocalContent: false }), false)
  assert.equal(shouldConfirmLocalProfileTransfer({ ...baseInput, targetProfileExists: false }), false)
})
