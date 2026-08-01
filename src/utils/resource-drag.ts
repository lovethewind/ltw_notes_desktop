interface FolderRelation {
  id: string
  parentId: string | null
}

/**
 * 收集文件夹拖拽时不可作为目标的自身及全部后代 ID。
 */
export function collectBlockedFolderDropIds(
  draggedFolderId: string | null,
  folders: FolderRelation[]
): Set<string> {
  if (!draggedFolderId) return new Set()
  const blockedIds = new Set([draggedFolderId])
  let changed = true
  while (changed) {
    changed = false
    for (const folder of folders) {
      if (blockedIds.has(folder.id) || !folder.parentId || !blockedIds.has(folder.parentId)) continue
      blockedIds.add(folder.id)
      changed = true
    }
  }
  return blockedIds
}

/**
 * 根据拖拽指针到滚动容器边缘的距离计算每帧滚动量。
 */
export function getDragAutoScrollDelta(
  pointerY: number,
  containerTop: number,
  containerBottom: number,
  edgeDistance = 40,
  maxDelta = 16
): number {
  if (pointerY < containerTop + edgeDistance) {
    const intensity = Math.min(1, (containerTop + edgeDistance - pointerY) / edgeDistance)
    return -Math.max(1, Math.round(maxDelta * intensity))
  }
  if (pointerY > containerBottom - edgeDistance) {
    const intensity = Math.min(1, (pointerY - containerBottom + edgeDistance) / edgeDistance)
    return Math.max(1, Math.round(maxDelta * intensity))
  }
  return 0
}
