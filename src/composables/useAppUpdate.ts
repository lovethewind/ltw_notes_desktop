import { computed, onBeforeUnmount, ref } from 'vue'
import DOMPurify from 'dompurify'
import { marked } from 'marked'
import type { UpdateCheckResult, UpdateDownloadProgress } from '../types'

/** 管理版本检查弹窗及发布说明渲染。 */
export function useAppUpdate() {
  const updateDialogVisible = ref(false)
  const updateChecking = ref(false)
  const updateError = ref('')
  const updateResult = ref<UpdateCheckResult | null>(null)
  const updateDownloading = ref(false)
  const updateDownloadProgress = ref<UpdateDownloadProgress | null>(null)
  const updateDownloadedPath = ref('')
  const updateDownloadError = ref('')

  const renderedUpdateReleaseNotes = computed<string>(() => {
    const releaseNotes = updateResult.value?.releaseNotes
    if (updateResult.value?.status !== 'available' || !releaseNotes) return ''
    return DOMPurify.sanitize(marked.parse(releaseNotes, { async: false }))
  })

  async function runUpdateCheck(silent = false): Promise<void> {
    if (updateChecking.value) return
    updateChecking.value = true
    updateError.value = ''
    if (!updateDownloading.value) {
      updateDownloadedPath.value = ''
      updateDownloadError.value = ''
      updateDownloadProgress.value = null
    }
    if (!silent) updateDialogVisible.value = true
    try {
      updateResult.value = await window.notesDesktop.checkForUpdates()
      if (updateResult.value.status === 'available') updateDialogVisible.value = true
    } catch (error) {
      updateError.value = error instanceof Error ? error.message : '检查更新失败'
      if (!silent) updateDialogVisible.value = true
    } finally {
      updateChecking.value = false
    }
  }

  async function openUpdateDownload(): Promise<void> {
    if (!updateResult.value?.downloadUrl) return
    try {
      await window.notesDesktop.openUpdateDownload(updateResult.value.downloadUrl)
      updateDialogVisible.value = false
    } catch (error) {
      updateError.value = error instanceof Error ? error.message : '无法打开下载地址'
    }
  }

  const downloadPercent = computed<number | null>(() => {
    const progress = updateDownloadProgress.value
    if (!progress || progress.total <= 0) return null
    return Math.min(100, Math.round((progress.received / progress.total) * 100))
  })

  const downloadSizeLabel = computed<string>(() => {
    const progress = updateDownloadProgress.value
    const toMegabytes = (bytes: number): string => `${(bytes / 1024 / 1024).toFixed(1)} MB`
    if (!progress) return ''
    if (progress.total > 0) {
      return `${toMegabytes(progress.received)} / ${toMegabytes(progress.total)}`
    }
    return `已下载 ${toMegabytes(progress.received)}`
  })

  async function downloadUpdate(): Promise<void> {
    if (!updateResult.value?.downloadUrl || updateDownloading.value) return
    updateDownloading.value = true
    updateDownloadError.value = ''
    updateDownloadProgress.value = null
    updateDownloadedPath.value = ''
    try {
      const result = await window.notesDesktop.downloadUpdate(updateResult.value.downloadUrl)
      updateDownloadedPath.value = result.filePath
      updateDownloadProgress.value = { received: result.total, total: result.total }
    } catch (error) {
      updateDownloadError.value = error instanceof Error ? error.message : '安装包下载失败'
    } finally {
      updateDownloading.value = false
    }
  }

  async function openInstaller(): Promise<void> {
    if (!updateDownloadedPath.value) return
    try {
      await window.notesDesktop.openUpdateInstaller(updateDownloadedPath.value)
    } catch (error) {
      updateDownloadError.value = error instanceof Error ? error.message : '无法打开安装包'
    }
  }

  async function revealInstaller(): Promise<void> {
    if (!updateDownloadedPath.value) return
    try {
      await window.notesDesktop.revealUpdateInstaller(updateDownloadedPath.value)
    } catch (error) {
      updateDownloadError.value = error instanceof Error ? error.message : '无法定位安装包'
    }
  }

  const disposeDownloadProgress = window.notesDesktop.onUpdateDownloadProgress((progress) => {
    updateDownloadProgress.value = progress
  })
  onBeforeUnmount(disposeDownloadProgress)

  return {
    updateDialogVisible,
    updateChecking,
    updateError,
    updateResult,
    renderedUpdateReleaseNotes,
    updateDownloading,
    updateDownloadProgress,
    updateDownloadedPath,
    updateDownloadError,
    downloadPercent,
    downloadSizeLabel,
    runUpdateCheck,
    openUpdateDownload,
    downloadUpdate,
    openInstaller,
    revealInstaller
  }
}
