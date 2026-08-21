const test = require("node:test")
const assert = require("node:assert/strict")
const { readFileSync } = require("node:fs")
const { resolve } = require("node:path")
const {
  checkForUpdates,
  compareVersions,
  selectMacDownloadUrl
} = require("../electron/app-update.cjs")

test("版本比较支持 v 前缀和不同长度的语义版本", () => {
  assert.equal(compareVersions("v0.2.0", "0.1.0"), 1)
  assert.equal(compareVersions("1.0", "1.0.0"), 0)
  assert.equal(compareVersions("1.2.0", "1.10.0"), -1)
})

test("更新包优先选择当前架构的 DMG", () => {
  const release = {
    html_url: "https://github.com/lovethewind/ltw_notes_desktop/releases/tag/v0.2.0",
    assets: [
      { name: "心悦笔记-0.2.0-x64.dmg", browser_download_url: "https://example.com/x64.dmg" },
      { name: "心悦笔记-0.2.0-arm64.dmg", browser_download_url: "https://example.com/arm64.dmg" }
    ]
  }

  assert.equal(selectMacDownloadUrl(release, "arm64"), "https://example.com/arm64.dmg")
  assert.equal(selectMacDownloadUrl(release, "x64"), "https://example.com/x64.dmg")
})

test("检查更新返回可供界面展示的稳定结果", async () => {
  const request = async () => ({
    ok: true,
    json: async () => ({
      tag_name: "v0.2.0",
      name: "心悦笔记 0.2.0",
      body: "新增版本检查。",
      html_url: "https://github.com/lovethewind/ltw_notes_desktop/releases/tag/v0.2.0",
      draft: false,
      prerelease: false,
      assets: []
    })
  })

  const result = await checkForUpdates({
    currentVersion: "0.1.0",
    architecture: "arm64",
    request
  })

  assert.deepEqual(result, {
    status: "available",
    currentVersion: "0.1.0",
    latestVersion: "0.2.0",
    title: "心悦笔记 0.2.0",
    releaseNotes: "新增版本检查。",
    downloadUrl: "https://github.com/lovethewind/ltw_notes_desktop/releases/tag/v0.2.0"
  })
})

test("已是最新版时不返回下载地址", async () => {
  const request = async () => ({
    ok: true,
    json: async () => ({
      tag_name: "v0.1.0",
      html_url: "https://example.com/release",
      draft: false,
      prerelease: false,
      assets: []
    })
  })

  const result = await checkForUpdates({
    currentVersion: "0.1.0",
    architecture: "arm64",
    request
  })

  assert.equal(result.status, "latest")
  assert.equal(result.downloadUrl, "")
})

test("仓库尚无正式 Release 时返回未发布状态", async () => {
  const request = async () => ({
    ok: false,
    status: 404
  })

  const result = await checkForUpdates({
    currentVersion: "0.1.0",
    architecture: "arm64",
    request
  })

  assert.deepEqual(result, {
    status: "unpublished",
    currentVersion: "0.1.0",
    latestVersion: "",
    title: "暂无发布版本",
    releaseNotes: "",
    downloadUrl: ""
  })
})

test("延迟检查更新前会确认主窗口仍然存活", () => {
  const mainSource = readFileSync(resolve(__dirname, "../electron/main.cjs"), "utf8")

  assert.match(
    mainSource,
    /setTimeout\(\(\) => \{[\s\S]*?!browserWindow\.isDestroyed\(\)[\s\S]*?!browserWindow\.webContents\.isDestroyed\(\)[\s\S]*?app-update:check-request/
  )
})
