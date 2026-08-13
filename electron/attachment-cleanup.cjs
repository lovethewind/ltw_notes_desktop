/**
 * 逐个清理一批孤立附件，并保留单项失败结果供界面重试。
 *
 * @param {Array<{ id: string, fileName?: string }>} candidates 用户已确认的候选附件。
 * @param {(assetId: string) => Promise<{ assetId: string, removedLocalFile: boolean }>} removeAttachment 单附件安全清理函数。
 * @returns {Promise<Record<string, any>>} 批量清理统计。
 */
async function cleanAllOrphanAttachments(candidates, removeAttachment) {
  const attachments = Array.isArray(candidates) ? candidates : []
  let removedCount = 0
  let removedLocalFileCount = 0
  const failures = []

  for (const candidate of attachments) {
    const assetId = String(candidate?.id || "")
    try {
      const result = await removeAttachment(assetId)
      removedCount += 1
      if (result?.removedLocalFile) removedLocalFileCount += 1
    } catch (error) {
      failures.push({
        assetId,
        fileName: String(candidate?.fileName || "未知附件"),
        message: error instanceof Error ? error.message : String(error || "附件清理失败")
      })
    }
  }

  return {
    candidateCount: attachments.length,
    removedCount,
    removedLocalFileCount,
    failedCount: failures.length,
    failures
  }
}

module.exports = { cleanAllOrphanAttachments }
