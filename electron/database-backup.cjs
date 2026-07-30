const fs = require("node:fs")
const path = require("node:path")
const { randomBytes } = require("node:crypto")
const { isScheduledBackupDue } = require("./database-backup-settings.cjs")

const BACKUP_DIRECTORY_NAME = "backups"
const BACKUP_REASON_PATTERN = "(daily|manual|before-import|pre-restore)"
const LEGACY_BACKUP_FILE_PATTERN = new RegExp(`^backup-(.+)-${BACKUP_REASON_PATTERN}\\.sqlite3$`)
const COMPLETE_BACKUP_DIRECTORY_PATTERN = new RegExp(`^backup-(.+)-${BACKUP_REASON_PATTERN}\\.xynotes-snapshot$`)
const DEFAULT_MAX_BACKUPS = 10

/**
 * 判断两个时间是否处于本地时区的同一天。
 *
 * @param {Date} left 左侧时间。
 * @param {Date} right 右侧时间。
 * @returns {boolean} 是否为同一天。
 */
function isSameLocalDay(left, right) {
  return (
    left.getFullYear() === right.getFullYear()
    && left.getMonth() === right.getMonth()
    && left.getDate() === right.getDate()
  )
}

/**
 * 生成可用于文件名的时间戳。
 *
 * @param {Date} date 备份时间。
 * @returns {string} 文件名时间戳。
 */
function formatBackupTimestamp(date) {
  return date.toISOString().replace(/[:.]/g, "-")
}

/**
 * 递归统计目录中的文件数量和总大小。
 *
 * @param {string} directoryPath 待统计目录。
 * @returns {Promise<{ count: number, size: number }>} 文件数量和总字节数。
 */
async function inspectDirectory(directoryPath) {
  let entries
  try {
    entries = await fs.promises.readdir(directoryPath, { withFileTypes: true })
  } catch (error) {
    if (error?.code === "ENOENT") return { count: 0, size: 0 }
    throw error
  }
  const summaries = await Promise.all(entries.map(async (entry) => {
    const entryPath = path.join(directoryPath, entry.name)
    if (entry.isDirectory()) return inspectDirectory(entryPath)
    if (!entry.isFile()) return { count: 0, size: 0 }
    const stats = await fs.promises.stat(entryPath)
    return { count: 1, size: stats.size }
  }))
  return summaries.reduce((total, current) => ({
    count: total.count + current.count,
    size: total.size + current.size
  }), { count: 0, size: 0 })
}

/**
 * 从备份名称中读取备份原因。
 *
 * @param {string} backupId 备份文件或目录名称。
 * @returns {string | null} 备份原因，不符合格式时返回 null。
 */
function getBackupReason(backupId) {
  return backupId.match(COMPLETE_BACKUP_DIRECTORY_PATTERN)?.[2]
    || backupId.match(LEGACY_BACKUP_FILE_PATTERN)?.[2]
    || null
}

/**
 * 创建指定用户档案的完整备份管理器。
 *
 * @param {{
 *   profilePath: string,
 *   backupDatabase: (targetPath: string) => Promise<unknown>,
 *   maxBackups?: number,
 *   getSettings?: () => { schedule: "daily" | "weekly" | "off", retention: number },
 *   now?: () => Date
 * }} options 管理器参数。
 * @returns {{
 *   createBackup: (reason: string) => Promise<Record<string, any>>,
 *   ensureDailyBackup: () => Promise<Record<string, any>>,
 *   getBackupDirectory: () => string,
 *   listBackups: () => Promise<Array<Record<string, any>>>,
 *   resolveBackupPath: (backupId: string) => Promise<string>
 * }} 备份管理器。
 */
function createDatabaseBackupManager({
  profilePath,
  backupDatabase,
  maxBackups = DEFAULT_MAX_BACKUPS,
  getSettings = () => ({ schedule: "daily", retention: maxBackups }),
  now = () => new Date()
}) {
  const backupDirectory = path.join(profilePath, BACKUP_DIRECTORY_NAME)

  /**
   * 查询备份并按时间从新到旧排序。
   *
   * @returns {Promise<Array<Record<string, any>>>} 备份摘要列表。
   */
  async function listBackups() {
    let entries
    try {
      entries = await fs.promises.readdir(backupDirectory, { withFileTypes: true })
    } catch (error) {
      if (error?.code === "ENOENT") return []
      throw error
    }
    const backups = await Promise.all(entries
      .filter((entry) => (
        (entry.isDirectory() && COMPLETE_BACKUP_DIRECTORY_PATTERN.test(entry.name))
        || (entry.isFile() && LEGACY_BACKUP_FILE_PATTERN.test(entry.name))
      ))
      .map(async (entry) => {
        const backupPath = path.join(backupDirectory, entry.name)
        const stats = await fs.promises.stat(backupPath)
        const summary = entry.isDirectory()
          ? await inspectDirectory(backupPath)
          : { count: 1, size: stats.size }
        let manifest = null
        if (entry.isDirectory()) {
          try {
            manifest = JSON.parse(await fs.promises.readFile(
              path.join(backupPath, "manifest.json"),
              "utf8"
            ))
          } catch {
            manifest = null
          }
        }
        return {
          id: entry.name,
          createdAt: stats.mtime.toISOString(),
          reason: getBackupReason(entry.name) || "manual",
          size: summary.size,
          kind: entry.isDirectory() ? "complete" : "database",
          assetCount: Number(manifest?.assetCount || 0)
        }
      }))
    return backups.sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt))
  }

  /**
   * 清理超过保留数量的旧备份。
   *
   * @returns {Promise<void>} 清理完成后的 Promise。
   */
  async function pruneBackups() {
    const backups = await listBackups()
    const retention = getSettings().retention
    await Promise.all(backups.slice(retention).map((backup) => (
      fs.promises.rm(path.join(backupDirectory, backup.id), { recursive: true, force: true })
    )))
  }

  /**
   * 创建一份包含数据库和附件的完整快照。
   *
   * @param {string} reason 备份原因。
   * @returns {Promise<Record<string, any>>} 新备份摘要。
   */
  async function createBackup(reason) {
    if (!["daily", "manual", "before-import", "pre-restore"].includes(reason)) {
      throw new Error("备份原因无效")
    }
    const createdAt = now()
    const backupId = `backup-${formatBackupTimestamp(createdAt)}-${reason}.xynotes-snapshot`
    const targetPath = path.join(backupDirectory, backupId)
    const temporaryPath = path.join(
      backupDirectory,
      `.creating-${randomBytes(8).toString("hex")}.xynotes-snapshot`
    )
    await fs.promises.mkdir(backupDirectory, { recursive: true })
    await fs.promises.mkdir(temporaryPath, { recursive: true })
    try {
      await backupDatabase(path.join(temporaryPath, "notes.sqlite3"))
      const sourceAssetsPath = path.join(profilePath, "assets")
      const targetAssetsPath = path.join(temporaryPath, "assets")
      if (fs.existsSync(sourceAssetsPath)) {
        await fs.promises.cp(sourceAssetsPath, targetAssetsPath, { recursive: true })
      }
      const assets = await inspectDirectory(targetAssetsPath)
      await fs.promises.writeFile(path.join(temporaryPath, "manifest.json"), JSON.stringify({
        version: 1,
        createdAt: createdAt.toISOString(),
        reason,
        assetCount: assets.count,
        assetSize: assets.size
      }, null, 2))
      await fs.promises.rename(temporaryPath, targetPath)
    } catch (error) {
      await fs.promises.rm(temporaryPath, { recursive: true, force: true })
      throw error
    }
    await fs.promises.utimes(targetPath, createdAt, createdAt)
    await pruneBackups()
    const summary = await inspectDirectory(targetPath)
    const manifest = JSON.parse(await fs.promises.readFile(path.join(targetPath, "manifest.json"), "utf8"))
    return {
      id: backupId,
      createdAt: createdAt.toISOString(),
      reason,
      size: summary.size,
      kind: "complete",
      assetCount: manifest.assetCount
    }
  }

  /**
   * 根据当前策略创建到期的计划快照。
   *
   * @returns {Promise<Record<string, any>>} 是否创建及对应备份信息。
   */
  async function ensureDailyBackup() {
    const currentTime = now()
    const settings = getSettings()
    const existing = (await listBackups()).find((backup) => (
      backup.reason === "daily"
    ))
    if (!isScheduledBackupDue(
      settings.schedule,
      existing ? new Date(existing.createdAt) : null,
      currentTime
    )) {
      return { created: false, backup: existing || null }
    }
    const backup = await createBackup("daily")
    return { created: true, backup }
  }

  /**
   * 安全解析备份 ID 对应的绝对路径。
   *
   * @param {string} backupId 备份文件 ID。
   * @returns {Promise<string>} 已确认存在的备份路径。
   */
  async function resolveBackupPath(backupId) {
    const normalizedId = String(backupId || "")
    if (path.basename(normalizedId) !== normalizedId || !getBackupReason(normalizedId)) {
      throw new Error("备份文件不存在")
    }
    const backupPath = path.join(backupDirectory, normalizedId)
    try {
      const stats = await fs.promises.stat(backupPath)
      const validType = LEGACY_BACKUP_FILE_PATTERN.test(normalizedId)
        ? stats.isFile()
        : stats.isDirectory()
      if (!validType) throw new Error("备份文件不存在")
    } catch {
      throw new Error("备份文件不存在")
    }
    return backupPath
  }

  return {
    createBackup,
    ensureDailyBackup,
    getBackupDirectory: () => backupDirectory,
    listBackups,
    resolveBackupPath
  }
}

/**
 * 获取快照中的数据库文件路径。
 *
 * @param {string} snapshotPath 快照文件或目录路径。
 * @returns {string} SQLite 文件路径。
 */
function getSnapshotDatabasePath(snapshotPath) {
  return fs.statSync(snapshotPath).isDirectory()
    ? path.join(snapshotPath, "notes.sqlite3")
    : snapshotPath
}

/**
 * 用完整快照替换当前数据库和附件，失败时使用安全快照回滚。
 *
 * @param {{
 *   sourcePath: string,
 *   safetyBackupPath: string,
 *   profilePath: string,
 *   closeDatabase: () => void,
 *   openDatabase: () => unknown,
 *   validateDatabase: (databasePath: string) => void
 * }} options 恢复参数。
 * @returns {Promise<unknown>} 重新打开后的数据库仓储。
 */
async function restoreProfileSnapshot({
  sourcePath,
  safetyBackupPath,
  profilePath,
  closeDatabase,
  openDatabase,
  validateDatabase
}) {
  const databasePath = path.join(profilePath, "notes.sqlite3")
  const assetsPath = path.join(profilePath, "assets")
  const temporaryRoot = path.join(profilePath, `.restore-${randomBytes(8).toString("hex")}`)
  const stagedDatabasePath = path.join(temporaryRoot, "notes.sqlite3")
  const stagedAssetsPath = path.join(temporaryRoot, "assets")
  const sourceIsComplete = fs.statSync(sourcePath).isDirectory()

  await fs.promises.mkdir(temporaryRoot, { recursive: true })
  await fs.promises.copyFile(getSnapshotDatabasePath(sourcePath), stagedDatabasePath)
  if (sourceIsComplete && fs.existsSync(path.join(sourcePath, "assets"))) {
    await fs.promises.cp(path.join(sourcePath, "assets"), stagedAssetsPath, { recursive: true })
  }
  validateDatabase(stagedDatabasePath)
  closeDatabase()

  /**
   * 应用一份已验证快照。
   *
   * @param {string} databaseSourcePath 数据库来源路径。
   * @param {string | null} assetsSourcePath 附件来源目录；null 表示保留现有附件。
   * @returns {Promise<void>} 应用完成后的 Promise。
   */
  async function applySnapshot(databaseSourcePath, assetsSourcePath) {
    await Promise.all([
      fs.promises.rm(`${databasePath}-wal`, { force: true }),
      fs.promises.rm(`${databasePath}-shm`, { force: true })
    ])
    await fs.promises.copyFile(databaseSourcePath, databasePath)
    if (assetsSourcePath !== null) {
      await fs.promises.rm(assetsPath, { recursive: true, force: true })
      if (fs.existsSync(assetsSourcePath)) {
        await fs.promises.cp(assetsSourcePath, assetsPath, { recursive: true })
      }
    }
  }

  try {
    await applySnapshot(stagedDatabasePath, sourceIsComplete ? stagedAssetsPath : null)
    return openDatabase()
  } catch (error) {
    try {
      closeDatabase()
      const safetyIsComplete = fs.statSync(safetyBackupPath).isDirectory()
      await applySnapshot(
        getSnapshotDatabasePath(safetyBackupPath),
        safetyIsComplete ? path.join(safetyBackupPath, "assets") : null
      )
      openDatabase()
    } catch (rollbackError) {
      throw new Error(`完整备份恢复失败，自动回滚也失败：${rollbackError.message}`)
    }
    throw error
  } finally {
    await fs.promises.rm(temporaryRoot, { recursive: true, force: true })
  }
}

/**
 * 用备份文件原子替换当前数据库，打开失败时使用安全快照回滚。
 *
 * @param {{
 *   sourcePath: string,
 *   safetyBackupPath: string,
 *   databasePath: string,
 *   closeDatabase: () => void,
 *   openDatabase: () => unknown,
 *   validateDatabase: (databasePath: string) => void
 * }} options 恢复参数。
 * @returns {Promise<unknown>} 重新打开后的数据库仓储。
 */
async function restoreDatabaseFile({
  sourcePath,
  safetyBackupPath,
  databasePath,
  closeDatabase,
  openDatabase,
  validateDatabase
}) {
  const temporaryPath = path.join(
    path.dirname(databasePath),
    `.restore-${randomBytes(8).toString("hex")}.sqlite3`
  )
  await fs.promises.copyFile(sourcePath, temporaryPath)
  validateDatabase(temporaryPath)
  closeDatabase()
  try {
    await Promise.all([
      fs.promises.rm(`${databasePath}-wal`, { force: true }),
      fs.promises.rm(`${databasePath}-shm`, { force: true })
    ])
    await fs.promises.rename(temporaryPath, databasePath)
    return openDatabase()
  } catch (error) {
    try {
      await fs.promises.copyFile(safetyBackupPath, databasePath)
      openDatabase()
    } catch (rollbackError) {
      throw new Error(`数据库恢复失败，自动回滚也失败：${rollbackError.message}`)
    }
    throw error
  } finally {
    await fs.promises.rm(temporaryPath, { force: true })
  }
}

module.exports = {
  createDatabaseBackupManager,
  restoreDatabaseFile,
  restoreProfileSnapshot
}
