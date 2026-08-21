const path = require('node:path')

const E2E_USER_DATA_ENV_NAME = 'XINYUE_NOTES_E2E_USER_DATA'
const E2E_SHOW_WINDOW_ENV_NAME = 'XINYUE_NOTES_E2E_SHOW_WINDOW'

/**
 * 判断当前进程是否为显式隔离的端到端测试运行态。
 * 两个条件缺一不可，避免生产进程因单个环境变量误跳过系统集成能力。
 *
 * @param {NodeJS.ProcessEnv | Record<string, string | undefined>} env 当前进程环境变量。
 * @returns {boolean} 是否处于隔离的端到端测试运行态。
 */
function isE2ERuntime(env = process.env) {
  return env.NODE_ENV === 'test' && Boolean(String(env[E2E_USER_DATA_ENV_NAME] || '').trim())
}

/**
 * 判断主窗口是否应该显示。E2E 默认后台运行，排查界面问题时可显式开启窗口。
 *
 * @param {NodeJS.ProcessEnv | Record<string, string | undefined>} env 当前进程环境变量。
 * @returns {boolean} 是否显示主窗口。
 */
function shouldShowMainWindow(env = process.env) {
  return !isE2ERuntime(env) || env[E2E_SHOW_WINDOW_ENV_NAME] === '1'
}

/**
 * 解析应用数据目录。只有测试进程可以覆盖目录，避免测试触碰真实笔记，
 * 同时防止生产启动被普通环境变量重定向到意外位置。
 *
 * @param {string} appDataPath Electron 提供的系统应用数据根目录。
 * @param {NodeJS.ProcessEnv | Record<string, string | undefined>} env 当前进程环境变量。
 * @returns {string} 心悦笔记应使用的绝对数据目录。
 */
function resolveUserDataPath(appDataPath, env = process.env) {
  const e2ePath = String(env[E2E_USER_DATA_ENV_NAME] || '').trim()
  if (isE2ERuntime(env)) return path.resolve(e2ePath)
  return path.join(appDataPath, '心悦笔记')
}

module.exports = {
  E2E_SHOW_WINDOW_ENV_NAME,
  E2E_USER_DATA_ENV_NAME,
  isE2ERuntime,
  resolveUserDataPath,
  shouldShowMainWindow
}
