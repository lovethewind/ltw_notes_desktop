const { createHash } = require("node:crypto")

function getSha256(data) {
  return createHash("sha256").update(data).digest("hex")
}

/**
 * 顺序检查并修复附件；单项失败只进入结果，不中断其余附件。
 *
 * @param {Array<Record<string, any>>} assets 待检查附件。
 * @param {{
 *   readLocal: (asset: Record<string, any>) => Promise<Buffer | null>,
 *   download: (asset: Record<string, any>) => Promise<Buffer>,
 *   writeLocal: (asset: Record<string, any>, data: Buffer) => Promise<void>,
 *   upload: (asset: Record<string, any>) => Promise<void>
 * }} handlers 文件和网络处理函数。
 * @returns {Promise<Record<string, any>>} 完整性检查与修复统计。
 */
async function executeAttachmentIntegrityRepair(assets, handlers) {
  const candidates = Array.isArray(assets) ? assets : []
  const result = {
    candidateCount: candidates.length,
    healthyCount: 0,
    repairedCount: 0,
    downloadedCount: 0,
    uploadedCount: 0,
    failedCount: 0,
    failures: []
  }

  for (const asset of candidates) {
    let issue = "missing"
    try {
      const localBody = await handlers.readLocal(asset)
      if (localBody) issue = getSha256(localBody) === asset.sha256 ? "healthy" : "corrupt"

      if (issue === "healthy") {
        if (asset.remoteUrl) {
          result.healthyCount += 1
          continue
        }
        issue = "upload"
        await handlers.upload(asset)
        result.uploadedCount += 1
        result.repairedCount += 1
        continue
      }

      if (!asset.remoteUrl) {
        throw new Error(issue === "corrupt"
          ? "本地文件哈希不一致且没有云端副本"
          : "本地文件缺失且没有云端副本")
      }
      const remoteBody = await handlers.download(asset)
      if (!Buffer.isBuffer(remoteBody) || !remoteBody.length) throw new Error("云端附件内容为空")
      if (getSha256(remoteBody) !== asset.sha256) throw new Error("云端附件与记录的 SHA-256 哈希不一致")
      await handlers.writeLocal(asset, remoteBody)
      result.downloadedCount += 1
      result.repairedCount += 1
    } catch (error) {
      result.failures.push({
        assetId: String(asset?.id || ""),
        fileName: String(asset?.fileName || "未知附件"),
        issue,
        message: error instanceof Error ? error.message : String(error || "修复失败")
      })
    }
  }
  result.failedCount = result.failures.length
  return result
}

module.exports = { executeAttachmentIntegrityRepair }
