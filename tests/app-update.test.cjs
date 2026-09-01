const test = require("node:test")
const assert = require("node:assert/strict")
const { existsSync, readFileSync, unlinkSync } = require("node:fs")
const { tmpdir } = require("node:os")
const { join, resolve } = require("node:path")
const {
  checkForUpdates,
  compareVersions,
  selectMacDownloadUrl,
  resolveDownloadFileName,
  downloadReleaseAsset
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

test("从更新地址解析出安全的 DMG 文件名", () => {
  const encoded = encodeURIComponent("心悦笔记-0.7.0-arm64.dmg")
  const url = `https://github.com/lovethewind/ltw_notes_desktop/releases/download/v0.7.0/${encoded}`

  assert.equal(resolveDownloadFileName(url), "心悦笔记-0.7.0-arm64.dmg")
  assert.equal(
    resolveDownloadFileName("https://example.com/not-a-dmg.zip", { fallbackName: "fallback.dmg" }),
    "fallback.dmg"
  )
})

test("流式下载安装包并按进度回调写盘", async () => {
  const chunks = [Buffer.from("hello "), Buffer.from("world")]
  const total = 11
  let chunkIndex = 0
  const request = async () => ({
    ok: true,
    headers: { get: (name) => (name === "content-length" ? String(total) : null) },
    body: {
      getReader: () => ({
        read: async () => {
          if (chunkIndex < chunks.length) return { value: chunks[chunkIndex++], done: false }
          return { value: undefined, done: true }
        }
      })
    }
  })
  const savePath = join(tmpdir(), `xinyue-notes-test-${Date.now()}.dmg`)
  const progress = []

  const result = await downloadReleaseAsset({
    downloadUrl: "https://github.com/lovethewind/ltw_notes_desktop/releases/download/v0.7.0/x.dmg",
    request,
    savePath,
    onProgress: (state) => progress.push(state)
  })

  assert.equal(result.filePath, savePath)
  assert.equal(result.total, total)
  assert.equal(readFileSync(savePath, "utf8"), "hello world")
  assert.ok(progress.length >= 1)
  assert.deepEqual(progress[progress.length - 1], { received: total, total })
  unlinkSync(savePath)
})

test("下载失败时清理残留文件", async () => {
  const chunks = [Buffer.from("partial")]
  let chunkIndex = 0
  const request = async () => ({
    ok: true,
    headers: { get: () => null },
    body: {
      getReader: () => ({
        read: async () => {
          if (chunkIndex < chunks.length) return { value: chunks[chunkIndex++], done: false }
          throw new Error("网络中断")
        }
      })
    }
  })
  const savePath = join(tmpdir(), `xinyue-notes-test-${Date.now()}.dmg`)

  await assert.rejects(
    () => downloadReleaseAsset({
      downloadUrl: "https://github.com/lovethewind/ltw_notes_desktop/releases/download/v0.7.0/x.dmg",
      request,
      savePath
    }),
    /网络中断/
  )
  assert.equal(existsSync(savePath), false)
})

test("延迟检查更新前会确认主窗口仍然存活", () => {
  const mainSource = readFileSync(resolve(__dirname, "../electron/main.cjs"), "utf8")

  assert.match(
    mainSource,
    /setTimeout\(\(\) => \{[\s\S]*?!browserWindow\.isDestroyed\(\)[\s\S]*?!browserWindow\.webContents\.isDestroyed\(\)[\s\S]*?app-update:check-request/
  )
})
