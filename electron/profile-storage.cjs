const { createHash } = require("node:crypto")
const fs = require("node:fs")
const path = require("node:path")

const DATABASE_FILE_NAMES = [
  "notes.sqlite3",
  "notes.sqlite3-wal",
  "notes.sqlite3-shm"
]

/**
 * 根据后端地址生成稳定且不暴露域名的档案标识。
 *
 * @param {string} backendUrl 已规范化的后端地址。
 * @returns {string} 域名档案标识。
 */
function getProfileId(backendUrl) {
  return createHash("sha256").update(String(backendUrl)).digest("hex").slice(0, 24)
}

/**
 * 根据用户 ID 生成稳定且不暴露原始 ID 的档案标识。
 *
 * @param {string} accountId 服务端用户唯一 ID，空字符串表示未登录用户。
 * @returns {string} 用户档案标识。
 */
function getAccountProfileId(accountId) {
  if (!accountId) return "local"
  return createHash("sha256").update(`user:${accountId}`).digest("hex").slice(0, 24)
}

/**
 * 获取后端域名和用户对应的本地数据目录。
 *
 * @param {string} userDataPath 应用用户数据根目录。
 * @param {string} backendUrl 已规范化的后端地址。
 * @param {string} accountId 服务端用户唯一 ID，空字符串表示未登录用户。
 * @returns {string} 用户档案数据目录。
 */
function getProfileDataPath(userDataPath, backendUrl, accountId) {
  return path.join(
    userDataPath,
    "profiles",
    getProfileId(backendUrl),
    getAccountProfileId(accountId)
  )
}

/**
 * 将一个旧档案复制到目标档案，目标数据库存在时保持不变。
 *
 * @param {string} sourcePath 源档案目录。
 * @param {string} targetPath 目标档案目录。
 * @returns {boolean} 是否完成了档案复制。
 */
function copyProfile(sourcePath, targetPath) {
  const sourceDatabasePath = path.join(sourcePath, DATABASE_FILE_NAMES[0])
  const targetDatabasePath = path.join(targetPath, DATABASE_FILE_NAMES[0])
  if (!fs.existsSync(sourceDatabasePath) || fs.existsSync(targetDatabasePath)) return false

  fs.mkdirSync(targetPath, { recursive: true })
  for (const fileName of DATABASE_FILE_NAMES) {
    const sourceFilePath = path.join(sourcePath, fileName)
    if (fs.existsSync(sourceFilePath)) {
      fs.copyFileSync(sourceFilePath, path.join(targetPath, fileName), fs.constants.COPYFILE_EXCL)
    }
  }

  const sourceAssetsPath = path.join(sourcePath, "assets")
  const targetAssetsPath = path.join(targetPath, "assets")
  if (fs.existsSync(sourceAssetsPath)) {
    fs.cpSync(sourceAssetsPath, targetAssetsPath, {
      recursive: true,
      errorOnExist: false,
      force: false
    })
  }
  return true
}

/**
 * 将旧的域名单层档案复制到用户档案。
 *
 * @param {string} userDataPath 应用用户数据根目录。
 * @param {string} backendUrl 已规范化的后端地址。
 * @param {string} accountId 服务端用户唯一 ID，空字符串表示未登录用户。
 * @returns {boolean} 是否完成了档案迁移。
 */
function migrateDomainProfile(userDataPath, backendUrl, accountId) {
  const domainProfilePath = path.join(userDataPath, "profiles", getProfileId(backendUrl))
  return copyProfile(
    domainProfilePath,
    getProfileDataPath(userDataPath, backendUrl, accountId)
  )
}

/**
 * 在同一后端域名下将一个账号档案复制到另一个账号档案。
 *
 * @param {string} userDataPath 应用用户数据根目录。
 * @param {string} backendUrl 已规范化的后端地址。
 * @param {string} sourceAccountId 源服务端用户 ID，空字符串表示未登录用户。
 * @param {string} targetAccountId 目标服务端用户 ID。
 * @returns {boolean} 是否完成了档案迁移。
 */
function migrateAccountProfile(userDataPath, backendUrl, sourceAccountId, targetAccountId) {
  return copyProfile(
    getProfileDataPath(userDataPath, backendUrl, sourceAccountId),
    getProfileDataPath(userDataPath, backendUrl, targetAccountId)
  )
}

/**
 * 判断登录切换前是否需要询问 local 数据处理方式。
 *
 * @param {{
 *   currentBackendUrl: string,
 *   nextBackendUrl: string,
 *   currentAccountId: string,
 *   nextAccountId: string,
 *   hasLocalContent: boolean,
 *   targetProfileExists: boolean
 * }} input 档案切换状态。
 * @returns {boolean} 是否需要用户确认。
 */
function shouldConfirmLocalProfileTransfer(input) {
  return (
    input.currentBackendUrl === input.nextBackendUrl
    && !input.currentAccountId
    && Boolean(input.nextAccountId)
    && input.hasLocalContent
    && input.targetProfileExists
  )
}

module.exports = {
  getProfileDataPath,
  migrateAccountProfile,
  migrateDomainProfile,
  shouldConfirmLocalProfileTransfer
}
