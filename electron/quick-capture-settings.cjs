const fs = require('node:fs')
const path = require('node:path')

const DEFAULT_QUICK_CAPTURE_SHORTCUT = 'CommandOrControl+Shift+Space'
const QUICK_CAPTURE_SETTINGS_FILE_NAME = 'quick-capture-settings.json'

function normalizeQuickCaptureSettings(input = {}) {
  const shortcut = typeof input.shortcut === 'string' && input.shortcut.trim()
    ? input.shortcut.trim().slice(0, 100)
    : DEFAULT_QUICK_CAPTURE_SHORTCUT
  const folderId = typeof input.folderId === 'string' && input.folderId.trim()
    ? input.folderId.trim()
    : null
  return { shortcut, folderId }
}

function loadQuickCaptureSettings(userDataPath) {
  try {
    return normalizeQuickCaptureSettings(JSON.parse(
      fs.readFileSync(path.join(userDataPath, QUICK_CAPTURE_SETTINGS_FILE_NAME), 'utf8')
    ))
  } catch {
    return normalizeQuickCaptureSettings()
  }
}

async function saveQuickCaptureSettings(userDataPath, input) {
  const settings = normalizeQuickCaptureSettings(input)
  await fs.promises.mkdir(userDataPath, { recursive: true })
  await fs.promises.writeFile(
    path.join(userDataPath, QUICK_CAPTURE_SETTINGS_FILE_NAME),
    `${JSON.stringify(settings, null, 2)}\n`,
    'utf8'
  )
  return settings
}

module.exports = {
  DEFAULT_QUICK_CAPTURE_SHORTCUT,
  loadQuickCaptureSettings,
  normalizeQuickCaptureSettings,
  saveQuickCaptureSettings
}
