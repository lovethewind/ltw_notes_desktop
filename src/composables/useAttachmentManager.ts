import { computed, ref } from 'vue'
import type {
  AttachmentInventory,
  AttachmentInventoryItem,
  AttachmentNoteReference,
  SyncStatus
} from '../types'

interface AttachmentManagerDependencies {
  flushSave: () => Promise<void>
  requestConfirmation: (title: string, message: string, confirmLabel: string) => Promise<boolean>
  locateReference: (reference: AttachmentNoteReference) => Promise<boolean>
  isSyncConfigured: () => boolean
  syncAttachments: () => Promise<SyncStatus>
}

const EMPTY_INVENTORY: AttachmentInventory = {
  items: [],
  totalCount: 0,
  localBytes: 0,
  uploadedCount: 0,
  pendingCount: 0,
  missingCount: 0,
  corruptCount: 0,
  orphanCount: 0,
  managedCount: 0,
  externalCacheCount: 0
}

/** 管理附件清单、筛选、完整性修复与孤立资源清理。 */
export function useAttachmentManager(dependencies: AttachmentManagerDependencies) {
  const attachmentManagerVisible = ref(false)
  const attachmentManagerLoading = ref(false)
  const attachmentOperationId = ref('')
  const attachmentManagerMessage = ref('')
  const attachmentSearchKeyword = ref('')
  const attachmentKindFilter = ref<'all' | 'image' | 'document' | 'other'>('all')
  const attachmentStateFilter = ref<'all' | 'uploaded' | 'pending' | 'missing' | 'corrupt' | 'orphan'>('all')
  const attachmentSourceFilter = ref<'all' | 'managed' | 'external-cache'>('all')
  const attachmentKindOptions: Array<{ value: 'all' | 'image' | 'document' | 'other', label: string }> = [
    { value: 'all', label: '全部' },
    { value: 'image', label: '图片' },
    { value: 'document', label: '文档' },
    { value: 'other', label: '其他' }
  ]
  const attachmentInventory = ref<AttachmentInventory>({ ...EMPTY_INVENTORY, items: [] })

  const filteredAttachments = computed(() => {
    const keyword = attachmentSearchKeyword.value.trim().toLocaleLowerCase()
    return attachmentInventory.value.items.filter((asset) => {
      if (attachmentKindFilter.value !== 'all' && asset.kind !== attachmentKindFilter.value) return false
      if (attachmentSourceFilter.value !== 'all' && asset.sourceKind !== attachmentSourceFilter.value) return false
      if (attachmentStateFilter.value === 'orphan' && !asset.isOrphan) return false
      if (
        attachmentStateFilter.value !== 'all'
        && attachmentStateFilter.value !== 'orphan'
        && asset.state !== attachmentStateFilter.value
      ) return false
      if (!keyword) return true
      return [
        asset.fileName,
        asset.mimeType,
        asset.sourceHost,
        ...asset.noteReferences.map((note) => note.title)
      ].some((value) => value.toLocaleLowerCase().includes(keyword))
    })
  })

  function formatAttachmentSize(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`
    if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`
  }

  function getAttachmentKindIcon(asset: AttachmentInventoryItem): string {
    if (asset.kind === 'image') return 'tabler:photo'
    if (asset.kind === 'document') return 'tabler:file-text'
    return 'tabler:file'
  }

  function getAttachmentStateLabel(asset: AttachmentInventoryItem): string {
    if (asset.state === 'missing') return '文件缺失'
    if (asset.state === 'corrupt') return '校验异常'
    if (asset.state === 'pending') return '待上传'
    return '已上传'
  }

  function getAttachmentSourceLabel(asset: AttachmentInventoryItem): string {
    if (asset.sourceKind === 'external-cache') {
      return asset.sourceHost ? `外链缓存 · ${asset.sourceHost}` : '外链缓存'
    }
    if (!asset.remoteUrl) return '本地附件'
    return asset.sourceHost ? `笔记附件 · ${asset.sourceHost}` : '笔记附件'
  }

  async function loadAttachmentInventory(showLoading = true): Promise<void> {
    if (showLoading) attachmentManagerLoading.value = true
    try {
      attachmentInventory.value = await window.notesDesktop.listAttachmentInventory()
    } finally {
      if (showLoading) attachmentManagerLoading.value = false
    }
  }

  async function openAttachmentManager(): Promise<void> {
    attachmentManagerVisible.value = true
    attachmentManagerMessage.value = ''
    attachmentSearchKeyword.value = ''
    attachmentKindFilter.value = 'all'
    attachmentStateFilter.value = 'all'
    attachmentSourceFilter.value = 'all'
    try {
      await dependencies.flushSave()
      await loadAttachmentInventory()
    } catch (error) {
      attachmentManagerMessage.value = error instanceof Error ? error.message : '附件清单加载失败'
      attachmentManagerLoading.value = false
    }
  }

  function closeAttachmentManager(): void {
    if (attachmentOperationId.value) return
    attachmentManagerVisible.value = false
    attachmentManagerMessage.value = ''
  }

  async function openManagedAttachment(asset: AttachmentInventoryItem): Promise<void> {
    attachmentOperationId.value = asset.id
    attachmentManagerMessage.value = ''
    try {
      await window.notesDesktop.openAttachment(asset.id)
    } catch (error) {
      attachmentManagerMessage.value = error instanceof Error ? error.message : '附件打开失败'
    } finally {
      attachmentOperationId.value = ''
    }
  }

  async function revealManagedAttachment(asset: AttachmentInventoryItem): Promise<void> {
    attachmentOperationId.value = asset.id
    attachmentManagerMessage.value = ''
    try {
      await window.notesDesktop.revealAttachment(asset.id)
    } catch (error) {
      attachmentManagerMessage.value = error instanceof Error ? error.message : '无法打开附件所在目录'
    } finally {
      attachmentOperationId.value = ''
    }
  }

  async function locateAttachmentReference(reference: AttachmentNoteReference): Promise<void> {
    if (!await dependencies.locateReference(reference)) {
      attachmentManagerMessage.value = '引用笔记已不存在'
      return
    }
    attachmentManagerVisible.value = false
  }

  async function retryManagedAttachmentUpload(asset: AttachmentInventoryItem): Promise<void> {
    if (!dependencies.isSyncConfigured()) {
      attachmentManagerMessage.value = '请先在同步中心连接云端账号'
      return
    }
    if (!asset.localExists) {
      attachmentManagerMessage.value = '本地文件缺失，无法重新上传'
      return
    }
    attachmentOperationId.value = asset.id
    attachmentManagerMessage.value = '正在重新上传并同步…'
    try {
      const status = await dependencies.syncAttachments()
      if (status.state === 'error') throw new Error(status.message || '附件上传失败')
      await loadAttachmentInventory(false)
      const updated = attachmentInventory.value.items.find((item) => item.id === asset.id)
      attachmentManagerMessage.value = updated?.state === 'uploaded'
        ? `“${asset.fileName}”已上传`
        : status.message || '同步已完成'
    } catch (error) {
      attachmentManagerMessage.value = error instanceof Error ? error.message : '附件上传失败'
    } finally {
      attachmentOperationId.value = ''
    }
  }

  async function repairAttachmentIntegrity(): Promise<void> {
    attachmentOperationId.value = '__repair_attachment_integrity__'
    attachmentManagerMessage.value = '正在校验附件并修复可恢复项目…'
    try {
      const result = await window.notesDesktop.repairAttachmentIntegrity()
      await loadAttachmentInventory(false)
      if (!result.candidateCount) {
        attachmentManagerMessage.value = '当前没有需要检查的附件'
        return
      }
      if (result.failedCount) {
        const examples = result.failures.slice(0, 3).map((failure) => `“${failure.fileName}”`).join('、')
        attachmentManagerMessage.value = `已检查 ${result.candidateCount} 个附件，修复 ${result.repairedCount} 个，${result.failedCount} 个未能修复：${examples}`
        return
      }
      attachmentManagerMessage.value = result.repairedCount
        ? `检查完成：${result.healthyCount} 个正常，修复 ${result.repairedCount} 个（重下 ${result.downloadedCount}、上传 ${result.uploadedCount}）`
        : `检查完成，${result.healthyCount} 个附件全部正常`
    } catch (error) {
      attachmentManagerMessage.value = error instanceof Error ? error.message : '附件完整性检查失败'
    } finally {
      attachmentOperationId.value = ''
    }
  }

  async function cleanOrphanAttachment(asset: AttachmentInventoryItem): Promise<void> {
    await dependencies.flushSave()
    await loadAttachmentInventory(false)
    const current = attachmentInventory.value.items.find((item) => item.id === asset.id)
    if (!current?.isOrphan) {
      attachmentManagerMessage.value = '附件已有笔记引用，已取消清理'
      return
    }
    const confirmed = await dependencies.requestConfirmation(
      '清理这个附件？',
      `“${current.fileName}”未被当前笔记或历史版本引用。本地文件将移入废纸篓，已上传的云端文件不会被删除。`,
      '清理附件'
    )
    if (!confirmed) return
    attachmentOperationId.value = current.id
    attachmentManagerMessage.value = ''
    try {
      const result = await window.notesDesktop.deleteOrphanAttachment(current.id)
      await loadAttachmentInventory(false)
      attachmentManagerMessage.value = result.removedLocalFile
        ? `“${current.fileName}”已移入废纸篓`
        : `“${current.fileName}”的无效记录已清理`
    } catch (error) {
      attachmentManagerMessage.value = error instanceof Error ? error.message : '附件清理失败'
    } finally {
      attachmentOperationId.value = ''
    }
  }

  async function cleanAllOrphanAttachments(): Promise<void> {
    await dependencies.flushSave()
    await loadAttachmentInventory(false)
    const candidates = attachmentInventory.value.items.filter((asset) => asset.isOrphan)
    if (!candidates.length) {
      attachmentManagerMessage.value = '当前没有可清理的孤立附件'
      return
    }
    const localBytes = candidates.reduce((total, asset) => total + asset.localBytes, 0)
    const confirmed = await dependencies.requestConfirmation(
      `一键清理 ${candidates.length} 个孤立附件？`,
      `这些附件未被当前笔记或历史版本引用，共占用 ${formatAttachmentSize(localBytes)}。本地文件将移入废纸篓，已上传的云端文件不会被删除。`,
      '一键清理'
    )
    if (!confirmed) return
    attachmentOperationId.value = '__all_orphan_attachments__'
    attachmentManagerMessage.value = '正在清理孤立附件…'
    try {
      const result = await window.notesDesktop.deleteAllOrphanAttachments(candidates.map((asset) => asset.id))
      await loadAttachmentInventory(false)
      attachmentManagerMessage.value = result.failedCount
        ? `已清理 ${result.removedCount} 个附件，${result.failedCount} 个未能清理，可再次尝试`
        : `已清理 ${result.removedCount} 个孤立附件，其中 ${result.removedLocalFileCount} 个本地文件已移入废纸篓`
    } catch (error) {
      attachmentManagerMessage.value = error instanceof Error ? error.message : '孤立附件批量清理失败'
    } finally {
      attachmentOperationId.value = ''
    }
  }

  return {
    attachmentManagerVisible,
    attachmentManagerLoading,
    attachmentOperationId,
    attachmentManagerMessage,
    attachmentSearchKeyword,
    attachmentKindFilter,
    attachmentStateFilter,
    attachmentSourceFilter,
    attachmentKindOptions,
    attachmentInventory,
    filteredAttachments,
    formatAttachmentSize,
    getAttachmentKindIcon,
    getAttachmentStateLabel,
    getAttachmentSourceLabel,
    loadAttachmentInventory,
    openAttachmentManager,
    closeAttachmentManager,
    openManagedAttachment,
    revealManagedAttachment,
    locateAttachmentReference,
    retryManagedAttachmentUpload,
    repairAttachmentIntegrity,
    cleanOrphanAttachment,
    cleanAllOrphanAttachments
  }
}
