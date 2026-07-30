const fs = require("node:fs")
const path = require("node:path")

const DEFAULT_BACKUP_SETTINGS = Object.freeze({ schedule: "daily", retention: 10 })

/**
 * 校验并规范化备份策略。
 *
 * @param {Record<string, any>} input 原始配置。
 * @returns {{ schedule: "daily" | "weekly" | "off", retention: number }} 规范配置。
 */
function normalizeBackupSettings(input = {}) {
  const schedule = ["daily", "weekly", "off"].includes(input.schedule)
    ? input.schedule
    : DEFAULT_BACKUP_SETTINGS.schedule
  const retention = Math.min(50, Math.max(1, Math.round(Number(input.retention) || 10)))
  return { schedule, retention }
}

/**
 * 读取指定档案的备份策略。
 *
 * @param {string} profilePath 档案目录。
 * @returns {{ schedule: "daily" | "weekly" | "off", retention: number }} 备份策略。
 */
function loadBackupSettings(profilePath) {
  try {
    return normalizeBackupSettings(JSON.parse(
      fs.readFileSync(path.join(profilePath, "backup-settings.json"), "utf8")
    ))
  } catch {
    return { ...DEFAULT_BACKUP_SETTINGS }
  }
}

/**
 * 保存指定档案的备份策略。
 *
 * @param {string} profilePath 档案目录。
 * @param {Record<string, any>} input 原始配置。
 * @returns {Promise<{ schedule: "daily" | "weekly" | "off", retention: number }>} 已保存配置。
 */
async function saveBackupSettings(profilePath, input) {
  const settings = normalizeBackupSettings(input)
  await fs.promises.mkdir(profilePath, { recursive: true })
  await fs.promises.writeFile(
    path.join(profilePath, "backup-settings.json"),
    `${JSON.stringify(settings, null, 2)}\n`,
    "utf8"
  )
  return settings
}

/**
 * 判断是否需要创建计划备份。
 *
 * @param {"daily" | "weekly" | "off"} schedule 备份周期。
 * @param {Date | null} lastBackupAt 最近计划备份时间。
 * @param {Date} currentTime 当前时间。
 * @returns {boolean} 是否到期。
 */
function isScheduledBackupDue(schedule, lastBackupAt, currentTime) {
  if (schedule === "off") return false
  if (!lastBackupAt) return true
  const elapsed = currentTime.getTime() - lastBackupAt.getTime()
  return elapsed >= (schedule === "weekly" ? 7 : 1) * 24 * 60 * 60 * 1000
}

module.exports = {
  DEFAULT_BACKUP_SETTINGS,
  isScheduledBackupDue,
  loadBackupSettings,
  normalizeBackupSettings,
  saveBackupSettings
}
