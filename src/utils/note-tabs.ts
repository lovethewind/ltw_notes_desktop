export interface NoteTabsState {
  noteIds: string[]
  activeNoteId: string | null
}

export interface PartitionedNoteTabs {
  visibleNoteIds: string[]
  overflowNoteIds: string[]
}

/**
 * 在当前标签中打开笔记，已打开的笔记直接切换。
 *
 * :param state: 当前标签状态。
 * :param noteId: 待打开的笔记 ID。
 * :return: 更新后的标签状态。
 */
export function activateNoteInCurrentTab(state: NoteTabsState, noteId: string): NoteTabsState {
  if (state.noteIds.includes(noteId)) {
    return { noteIds: [...state.noteIds], activeNoteId: noteId }
  }
  const activeIndex = state.activeNoteId ? state.noteIds.indexOf(state.activeNoteId) : -1
  if (activeIndex < 0) {
    return { noteIds: [...state.noteIds, noteId], activeNoteId: noteId }
  }
  const noteIds = [...state.noteIds]
  noteIds[activeIndex] = noteId
  return { noteIds, activeNoteId: noteId }
}

/**
 * 在新标签中打开笔记，已打开的笔记直接切换。
 *
 * :param state: 当前标签状态。
 * :param noteId: 待打开的笔记 ID。
 * :return: 更新后的标签状态。
 */
export function activateNoteInNewTab(state: NoteTabsState, noteId: string): NoteTabsState {
  const noteIds = state.noteIds.includes(noteId) ? [...state.noteIds] : [...state.noteIds, noteId]
  return { noteIds, activeNoteId: noteId }
}

/**
 * 关闭指定标签，关闭当前标签时优先选择其右侧相邻标签。
 *
 * :param state: 当前标签状态。
 * :param noteId: 待关闭的笔记 ID。
 * :return: 更新后的标签状态。
 */
export function closeNoteTab(state: NoteTabsState, noteId: string): NoteTabsState {
  const closingIndex = state.noteIds.indexOf(noteId)
  if (closingIndex < 0) return { noteIds: [...state.noteIds], activeNoteId: state.activeNoteId }
  const noteIds = state.noteIds.filter((id) => id !== noteId)
  if (state.activeNoteId !== noteId) return { noteIds, activeNoteId: state.activeNoteId }
  return { noteIds, activeNoteId: noteIds[closingIndex] ?? noteIds.at(-1) ?? null }
}

/**
 * 移除已不存在或已删除笔记对应的标签。
 *
 * :param state: 当前标签状态。
 * :param availableNoteIds: 当前仍可打开的笔记 ID。
 * :return: 更新后的标签状态。
 */
export function reconcileNoteTabs(
  state: NoteTabsState,
  availableNoteIds: string[],
): NoteTabsState {
  const availableIdSet = new Set(availableNoteIds)
  const noteIds = state.noteIds.filter((id) => availableIdSet.has(id))
  const activeNoteId = state.activeNoteId && availableIdSet.has(state.activeNoteId)
    ? state.activeNoteId
    : noteIds[0] ?? null
  return { noteIds, activeNoteId }
}

/**
 * 只保留指定标签并关闭其他标签。
 *
 * :param state: 当前标签状态。
 * :param noteId: 需要保留的笔记 ID。
 * :return: 更新后的标签状态。
 */
export function closeOtherNoteTabs(state: NoteTabsState, noteId: string): NoteTabsState {
  if (!state.noteIds.includes(noteId)) return { noteIds: [...state.noteIds], activeNoteId: state.activeNoteId }
  return { noteIds: [noteId], activeNoteId: noteId }
}

/**
 * 关闭指定标签右侧的所有标签。
 *
 * :param state: 当前标签状态。
 * :param noteId: 边界标签对应的笔记 ID。
 * :return: 更新后的标签状态。
 */
export function closeNoteTabsToRight(state: NoteTabsState, noteId: string): NoteTabsState {
  const noteIndex = state.noteIds.indexOf(noteId)
  if (noteIndex < 0) return { noteIds: [...state.noteIds], activeNoteId: state.activeNoteId }
  const noteIds = state.noteIds.slice(0, noteIndex + 1)
  const activeNoteId = state.activeNoteId && noteIds.includes(state.activeNoteId) ? state.activeNoteId : noteId
  return { noteIds, activeNoteId }
}

/**
 * 按可用数量拆分可见标签与溢出标签，并优先保证当前标签可见。
 *
 * :param noteIds: 全部标签对应的笔记 ID。
 * :param activeNoteId: 当前标签对应的笔记 ID。
 * :param maxVisible: 最多可见的标签数量。
 * :return: 可见和溢出的标签 ID。
 */
export function partitionNoteTabs(
  noteIds: string[],
  activeNoteId: string | null,
  maxVisible: number,
): PartitionedNoteTabs {
  const visibleCount = Math.max(1, maxVisible)
  if (noteIds.length <= visibleCount) {
    return { visibleNoteIds: [...noteIds], overflowNoteIds: [] }
  }
  const activeIndex = activeNoteId ? noteIds.indexOf(activeNoteId) : 0
  const startIndex = Math.min(
    Math.max(0, activeIndex - visibleCount + 1),
    noteIds.length - visibleCount,
  )
  const visibleNoteIds = noteIds.slice(startIndex, startIndex + visibleCount)
  const visibleIdSet = new Set(visibleNoteIds)
  return {
    visibleNoteIds,
    overflowNoteIds: noteIds.filter((noteId) => !visibleIdSet.has(noteId)),
  }
}
