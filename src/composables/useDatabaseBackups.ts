import { reactive, ref, type Ref } from 'vue'
import type { DatabaseBackup, DatabaseBackupSettings } from '../types'

interface DatabaseBackupDependencies {
  dataTransferVisible: Ref<boolean>
  flushSave: () => Promise<void>
  refreshWorkspace: () => Promise<void>
  requestConfirmation: (title: string, message: string, confirmLabel: string) => Promise<boolean>
}

/** 管理当前数据档案的自动备份策略、列表、创建与恢复。 */
export function useDatabaseBackups(dependencies: DatabaseBackupDependencies) {
  const databaseBackupVisible = ref(false)
  const databaseBackupBusy = ref(false)
  const databaseBackupMessage = ref('')
  const databaseBackups = ref<DatabaseBackup[]>([])
  const databaseBackupSettings = reactive<DatabaseBackupSettings>({ schedule: 'daily', retention: 10 })

  function formatDatabaseBackupTime(value: string): string {
    return new Intl.DateTimeFormat('zh-CN', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit'
    }).format(new Date(value))
  }

  function formatDatabaseBackupSize(size: number): string {
    if (size < 1024 * 1024) return `${Math.max(1, Math.round(size / 1024))} KB`
    return `${(size / 1024 / 1024).toFixed(1)} MB`
  }

  function getDatabaseBackupReasonLabel(reason: DatabaseBackup['reason']): string {
    return {
      daily: '每日自动',
      manual: '手动创建',
      'before-import': '导入前保护',
      'pre-restore': '恢复前保护'
    }[reason]
  }

  async function loadDatabaseBackups(): Promise<void> {
    const [backups, settings] = await Promise.all([
      window.notesDesktop.listDatabaseBackups(),
      window.notesDesktop.getDatabaseBackupSettings()
    ])
    databaseBackups.value = backups
    Object.assign(databaseBackupSettings, settings)
  }

  async function saveDatabaseBackupPolicy(): Promise<void> {
    databaseBackupBusy.value = true
    try {
      const settings = await window.notesDesktop.saveDatabaseBackupSettings({
        schedule: databaseBackupSettings.schedule,
        retention: databaseBackupSettings.retention
      })
      Object.assign(databaseBackupSettings, settings)
      await loadDatabaseBackups()
      databaseBackupMessage.value = '自动备份策略已保存'
    } catch (error) {
      databaseBackupMessage.value = error instanceof Error ? error.message : '备份策略保存失败'
    } finally {
      databaseBackupBusy.value = false
    }
  }

  async function openDatabaseBackupManager(): Promise<void> {
    dependencies.dataTransferVisible.value = false
    databaseBackupVisible.value = true
    databaseBackupBusy.value = true
    databaseBackupMessage.value = ''
    try {
      await loadDatabaseBackups()
    } catch (error) {
      databaseBackupMessage.value = error instanceof Error ? error.message : '备份列表加载失败'
    } finally {
      databaseBackupBusy.value = false
    }
  }

  async function createDatabaseBackup(): Promise<void> {
    if (databaseBackupBusy.value) return
    databaseBackupBusy.value = true
    databaseBackupMessage.value = ''
    try {
      await dependencies.flushSave()
      await window.notesDesktop.createDatabaseBackup()
      await loadDatabaseBackups()
      databaseBackupMessage.value = '当前数据库和附件已安全备份'
    } catch (error) {
      databaseBackupMessage.value = error instanceof Error ? error.message : '完整备份失败'
    } finally {
      databaseBackupBusy.value = false
    }
  }

  async function restoreDatabaseBackup(backup: DatabaseBackup): Promise<void> {
    const confirmed = await dependencies.requestConfirmation(
      '恢复完整备份？',
      `将恢复到 ${formatDatabaseBackupTime(backup.createdAt)} 的状态。当前数据库和附件会先自动创建一份“恢复前保护”快照。`,
      '确认恢复'
    )
    if (!confirmed) return
    databaseBackupBusy.value = true
    databaseBackupMessage.value = ''
    try {
      await dependencies.flushSave()
      const result = await window.notesDesktop.restoreDatabaseBackup(backup.id)
      await dependencies.refreshWorkspace()
      await loadDatabaseBackups()
      databaseBackupMessage.value = `${result.message}，恢复前状态也已保留`
    } catch (error) {
      databaseBackupMessage.value = error instanceof Error ? error.message : '完整备份恢复失败'
    } finally {
      databaseBackupBusy.value = false
    }
  }

  async function openDatabaseBackupDirectory(): Promise<void> {
    try {
      await window.notesDesktop.openDatabaseBackupDirectory()
    } catch (error) {
      databaseBackupMessage.value = error instanceof Error ? error.message : '无法打开备份目录'
    }
  }

  return {
    databaseBackupVisible,
    databaseBackupBusy,
    databaseBackupMessage,
    databaseBackups,
    databaseBackupSettings,
    formatDatabaseBackupTime,
    formatDatabaseBackupSize,
    getDatabaseBackupReasonLabel,
    loadDatabaseBackups,
    saveDatabaseBackupPolicy,
    openDatabaseBackupManager,
    createDatabaseBackup,
    restoreDatabaseBackup,
    openDatabaseBackupDirectory
  }
}
