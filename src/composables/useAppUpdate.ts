import { computed, ref } from 'vue'
import DOMPurify from 'dompurify'
import { marked } from 'marked'
import type { UpdateCheckResult } from '../types'

/** 管理版本检查弹窗及发布说明渲染。 */
export function useAppUpdate() {
  const updateDialogVisible = ref(false)
  const updateChecking = ref(false)
  const updateError = ref('')
  const updateResult = ref<UpdateCheckResult | null>(null)

  const renderedUpdateReleaseNotes = computed<string>(() => {
    const releaseNotes = updateResult.value?.releaseNotes
    if (updateResult.value?.status !== 'available' || !releaseNotes) return ''
    return DOMPurify.sanitize(marked.parse(releaseNotes, { async: false }))
  })

  async function runUpdateCheck(silent = false): Promise<void> {
    if (updateChecking.value) return
    updateChecking.value = true
    updateError.value = ''
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

  return {
    updateDialogVisible,
    updateChecking,
    updateError,
    updateResult,
    renderedUpdateReleaseNotes,
    runUpdateCheck,
    openUpdateDownload
  }
}
