/**
 * 协调应用退出前的渲染进程保存握手。
 *
 * @param {{
 *   requestSave: (requestId: number) => void,
 *   quit: () => void,
 *   onFailure: (message: string) => void,
 *   timeoutMs?: number,
 *   setTimer?: (callback: () => void, delay: number) => any,
 *   clearTimer?: (timer: any) => void
 * }} options 协调器依赖。
 * @returns {{
 *   requestQuit: (event: { preventDefault: () => void }) => boolean,
 *   complete: (requestId: number, result: { ok?: boolean, message?: string }) => boolean,
 *   isWaiting: () => boolean,
 *   dispose: () => void
 * }} 退出保存协调器。
 */
function createQuitSaveCoordinator(options) {
  const timeoutMs = options.timeoutMs ?? 10_000
  const setTimer = options.setTimer ?? setTimeout
  const clearTimer = options.clearTimer ?? clearTimeout
  let state = "idle"
  let nextRequestId = 1
  let activeRequestId = 0
  let timeoutTimer = null

  function clearPendingTimer() {
    if (timeoutTimer !== null) clearTimer(timeoutTimer)
    timeoutTimer = null
  }

  function fail(message) {
    clearPendingTimer()
    state = "idle"
    activeRequestId = 0
    options.onFailure(message)
  }

  function requestQuit(event) {
    if (state === "ready") return true
    event.preventDefault()
    if (state === "waiting") return false

    state = "waiting"
    activeRequestId = nextRequestId
    nextRequestId += 1
    try {
      options.requestSave(activeRequestId)
      timeoutTimer = setTimer(() => {
        if (state === "waiting") fail("退出前保存超时，请检查磁盘状态后重试")
      }, timeoutMs)
    } catch (error) {
      fail(error instanceof Error ? error.message : "无法请求保存当前笔记")
    }
    return false
  }

  function complete(requestId, result) {
    if (state !== "waiting" || requestId !== activeRequestId) return false
    clearPendingTimer()
    if (!result?.ok) {
      fail(String(result?.message || "退出前保存失败"))
      return true
    }
    state = "ready"
    activeRequestId = 0
    options.quit()
    return true
  }

  function dispose() {
    clearPendingTimer()
    state = "idle"
    activeRequestId = 0
  }

  return {
    requestQuit,
    complete,
    isWaiting: () => state === "waiting",
    dispose
  }
}

module.exports = {
  createQuitSaveCoordinator
}
