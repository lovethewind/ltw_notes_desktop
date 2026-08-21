const test = require("node:test")
const assert = require("node:assert/strict")
const { readFileSync } = require("node:fs")
const { resolve } = require("node:path")
const { createQuitSaveCoordinator } = require("../electron/quit-save-coordinator.cjs")

function createBeforeQuitEvent() {
  return {
    prevented: false,
    preventDefault() {
      this.prevented = true
    }
  }
}

function createHarness() {
  const requests = []
  const failures = []
  const timers = []
  let quitCount = 0
  const coordinator = createQuitSaveCoordinator({
    requestSave: (requestId) => requests.push(requestId),
    quit: () => { quitCount += 1 },
    onFailure: (message) => failures.push(message),
    setTimer: (callback) => {
      timers.push(callback)
      return timers.length
    },
    clearTimer: () => {}
  })
  return {
    coordinator,
    requests,
    failures,
    timers,
    getQuitCount: () => quitCount
  }
}

test("退出时先阻止关闭并请求渲染进程保存", () => {
  const harness = createHarness()
  const event = createBeforeQuitEvent()

  assert.equal(harness.coordinator.requestQuit(event), false)
  assert.equal(event.prevented, true)
  assert.equal(harness.requests.length, 1)
  assert.equal(harness.coordinator.isWaiting(), true)
})

test("等待保存期间重复退出不会重复发送保存请求", () => {
  const harness = createHarness()
  harness.coordinator.requestQuit(createBeforeQuitEvent())
  harness.coordinator.requestQuit(createBeforeQuitEvent())

  assert.equal(harness.requests.length, 1)
})

test("保存成功后重新触发退出，并允许下一次 before-quit 通过", () => {
  const harness = createHarness()
  const event = createBeforeQuitEvent()
  harness.coordinator.requestQuit(event)

  assert.equal(harness.coordinator.complete(harness.requests[0], { ok: true }), true)
  assert.equal(harness.getQuitCount(), 1)
  assert.equal(harness.coordinator.requestQuit(createBeforeQuitEvent()), true)
})

test("保存失败会取消退出并显示原因", () => {
  const harness = createHarness()
  harness.coordinator.requestQuit(createBeforeQuitEvent())

  assert.equal(harness.coordinator.complete(harness.requests[0], { ok: false, message: "磁盘写入失败" }), true)
  assert.equal(harness.getQuitCount(), 0)
  assert.deepEqual(harness.failures, ["磁盘写入失败"])
  assert.equal(harness.coordinator.isWaiting(), false)
})

test("等待保存超时会取消退出", () => {
  const harness = createHarness()
  harness.coordinator.requestQuit(createBeforeQuitEvent())
  harness.timers[0]()

  assert.equal(harness.getQuitCount(), 0)
  assert.match(harness.failures[0], /超时/)
})

test("主进程退出和红色关窗都接入保存握手", () => {
  const root = resolve(__dirname, "..")
  const mainSource = readFileSync(resolve(root, "electron/main.cjs"), "utf8")
  const ipcSource = readFileSync(resolve(root, "electron/ipc-handlers.cjs"), "utf8")
  const preloadSource = readFileSync(resolve(root, "electron/preload.cjs"), "utf8")
  const appSource = readFileSync(resolve(root, "src/App.vue"), "utf8")

  assert.match(mainSource, /createQuitSaveCoordinator/)
  assert.match(ipcSource, /app:before-quit-save-result[\s\S]*?completeQuitSave/)
  assert.match(mainSource, /app\.on\("before-quit", \(event\)/)
  assert.match(mainSource, /canRequestRendererSave[\s\S]*?quitSaveCoordinator\.requestQuit\(event\)/)
  assert.match(mainSource, /browserWindow\.on\("close", \(event\)[\s\S]*?quitSaveCoordinator\.requestQuit\(event\)/)
  assert.match(mainSource, /closeMainWindowAfterSave[\s\S]*?mainWindow\.close\(\)/)
  assert.match(preloadSource, /onBeforeQuitSave[\s\S]*?app:before-quit-save/)
  assert.match(preloadSource, /completeBeforeQuitSave[\s\S]*?app:before-quit-save-result/)
  assert.match(appSource, /async function saveBeforeQuit/)
  assert.match(appSource, /onBeforeQuitSave[\s\S]*?saveBeforeQuit[\s\S]*?completeBeforeQuitSave/)
})
