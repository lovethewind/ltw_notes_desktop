/**
 * 创建当前档案的备份状态跟踪器。
 *
 * @param {(status: Record<string, string>) => void} notify 状态变化通知函数。
 * @returns {{
 *   getStatus: () => Record<string, string>,
 *   recordSuccess: (backup: Record<string, any>) => Record<string, string>,
 *   recordFailure: (error: unknown, automatic?: boolean) => Record<string, string>,
 *   reset: () => Record<string, string>
 * }} 备份状态跟踪器。
 */
function createDatabaseBackupStatusTracker(notify) {
  let status = {
    state: "idle",
    message: "尚未创建备份",
    lastSuccessAt: "",
    reason: ""
  }

  /**
   * 发布一份不可被外部修改的状态副本。
   *
   * @param {Record<string, string>} nextStatus 新状态。
   * @returns {Record<string, string>} 已发布状态。
   */
  function publish(nextStatus) {
    status = { ...nextStatus }
    notify({ ...status })
    return { ...status }
  }

  /**
   * 记录一次成功备份。
   *
   * @param {Record<string, any>} backup 备份摘要。
   * @returns {Record<string, string>} 最新状态。
   */
  function recordSuccess(backup) {
    const assetCount = Number(backup?.assetCount || 0)
    return publish({
      state: "success",
      message: `数据库和 ${assetCount} 个附件已备份`,
      lastSuccessAt: String(backup?.createdAt || ""),
      reason: String(backup?.reason || "")
    })
  }

  /**
   * 记录一次备份失败。
   *
   * @param {unknown} error 备份异常。
   * @param {boolean} automatic 是否为后台自动备份。
   * @returns {Record<string, string>} 最新状态。
   */
  function recordFailure(error, automatic = false) {
    const detail = error instanceof Error ? error.message : "未知错误"
    return publish({
      ...status,
      state: "error",
      message: `${automatic ? "自动" : ""}备份失败：${detail}`
    })
  }

  /**
   * 重置为尚未备份状态。
   *
   * @returns {Record<string, string>} 重置后的状态。
   */
  function reset() {
    return publish({
      state: "idle",
      message: "尚未创建备份",
      lastSuccessAt: "",
      reason: ""
    })
  }

  return {
    getStatus: () => ({ ...status }),
    recordSuccess,
    recordFailure,
    reset
  }
}

module.exports = {
  createDatabaseBackupStatusTracker
}
