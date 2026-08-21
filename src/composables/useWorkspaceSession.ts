import { ref, type Ref } from 'vue'
import type { WorkspaceSession, WorkspaceSessionInput } from '../types'

interface WorkspaceSessionApi {
  saveSession: (input: WorkspaceSessionInput) => Promise<WorkspaceSession>
  saveViewState: (noteId: string, scrollTop: number) => Promise<boolean>
}

const SESSION_SAVE_DELAY_MS = 250
const VIEW_STATE_SAVE_DELAY_MS = 500

/** 管理仅保存在当前设备上的标签页与阅读位置。 */
export function useWorkspaceSession(api: WorkspaceSessionApi) {
  const openNoteIds = ref<string[]>([])
  const activeTabNoteId = ref<string | null>(null)
  const pinnedNoteIds = ref<string[]>([])
  const noteScrollTops = ref<Record<string, number>>({})
  let sessionReady = false
  let sessionSaveTimer: ReturnType<typeof setTimeout> | undefined
  let viewStateSaveTimer: ReturnType<typeof setTimeout> | undefined
  const pendingViewStateNoteIds = new Set<string>()

  /** 从数据库恢复仍然存在的标签与阅读位置。 */
  function restoreWorkspaceSession(session: WorkspaceSession, availableNoteIds: string[]): void {
    const availableIdSet = new Set(availableNoteIds)
    const tabs = session.tabs.filter((tab) => availableIdSet.has(tab.noteId))
    openNoteIds.value = tabs.map((tab) => tab.noteId)
    pinnedNoteIds.value = tabs.filter((tab) => tab.isPinned).map((tab) => tab.noteId)
    activeTabNoteId.value = session.activeNoteId && availableIdSet.has(session.activeNoteId)
      ? session.activeNoteId
      : openNoteIds.value[0] ?? null
    noteScrollTops.value = Object.fromEntries(tabs.map((tab) => [tab.noteId, tab.scrollTop]))
    sessionReady = true
  }

  /** 防抖保存标签顺序、固定状态和当前标签。 */
  function scheduleWorkspaceSessionSave(): void {
    if (!sessionReady) return
    if (sessionSaveTimer) clearTimeout(sessionSaveTimer)
    sessionSaveTimer = setTimeout(() => {
      sessionSaveTimer = undefined
      void saveSessionState().catch(() => undefined)
    }, SESSION_SAVE_DELAY_MS)
  }

  /** 记录阅读位置，并在滚动停止后写入数据库。 */
  function updateNoteScrollPosition(scrollTop: number, documentId: string): void {
    if (!sessionReady || !documentId) return
    noteScrollTops.value = {
      ...noteScrollTops.value,
      [documentId]: Math.max(0, Math.round(scrollTop))
    }
    pendingViewStateNoteIds.add(documentId)
    if (viewStateSaveTimer) clearTimeout(viewStateSaveTimer)
    viewStateSaveTimer = setTimeout(() => {
      viewStateSaveTimer = undefined
      void savePendingViewStates().catch(() => undefined)
    }, VIEW_STATE_SAVE_DELAY_MS)
  }

  async function saveSessionState(): Promise<void> {
    await api.saveSession({
      tabs: openNoteIds.value.map((noteId) => ({
        noteId,
        isPinned: pinnedNoteIds.value.includes(noteId)
      })),
      activeNoteId: activeTabNoteId.value
    })
  }

  async function savePendingViewStates(): Promise<void> {
    const noteIds = [...pendingViewStateNoteIds]
    pendingViewStateNoteIds.clear()
    await Promise.all(noteIds.map((noteId) => (
      api.saveViewState(noteId, noteScrollTops.value[noteId] ?? 0)
    )))
  }

  /** 退出应用前提交全部待保存的本地界面状态。 */
  async function flushWorkspaceSession(): Promise<void> {
    if (!sessionReady) return
    if (sessionSaveTimer) clearTimeout(sessionSaveTimer)
    if (viewStateSaveTimer) clearTimeout(viewStateSaveTimer)
    sessionSaveTimer = undefined
    viewStateSaveTimer = undefined
    await saveSessionState()
    await savePendingViewStates()
  }

  /** 释放防抖计时器；正式退出由 flushWorkspaceSession 负责落盘。 */
  function disposeWorkspaceSession(): void {
    if (sessionSaveTimer) clearTimeout(sessionSaveTimer)
    if (viewStateSaveTimer) clearTimeout(viewStateSaveTimer)
    sessionSaveTimer = undefined
    viewStateSaveTimer = undefined
  }

  return {
    openNoteIds: openNoteIds as Ref<string[]>,
    activeTabNoteId: activeTabNoteId as Ref<string | null>,
    pinnedNoteIds: pinnedNoteIds as Ref<string[]>,
    noteScrollTops: noteScrollTops as Ref<Record<string, number>>,
    restoreWorkspaceSession,
    scheduleWorkspaceSessionSave,
    updateNoteScrollPosition,
    flushWorkspaceSession,
    disposeWorkspaceSession
  }
}
