/**
 * 渲染进程内的「打开笔记」跨组件事件（window CustomEvent 总线）。
 *
 * 用途：编辑器深处的节点视图（如 NoteEmbedCard）无法直接拿到 App.vue 的标签状态函数，
 * 但同一渲染进程内 App.vue 始终在挂载态。此处用命名的 window CustomEvent 桥接，
 * 让深居编辑器内的卡片请求「在新标签页打开某笔记」，由 App.vue 统一路由到
 * `openNoteInNewTab`。事件名集中于此，避免两处魔法字符串漂移。
 */

/** 在 App.vue 挂载后监听、由 NoteEmbedCard 等发起的「打开笔记」事件名。 */
export const OPEN_NOTE_EVENT = 'xynote:open-note'

/** 事件 payload：noteId 为目标笔记 ID；newTab 决定新标签页还是原地切换。 */
export interface OpenNoteEventDetail {
  noteId: string
  newTab: boolean
}

/**
 * 派发「打开笔记」事件。
 *
 * :param noteId: 目标笔记 ID。
 * :param newTab: 为 true 时在新标签页打开，否则原地切换当前视图。
 * :return: 无返回值。
 */
export function dispatchOpenNote(noteId: string, newTab: boolean): void {
  window.dispatchEvent(new CustomEvent<OpenNoteEventDetail>(OPEN_NOTE_EVENT, {
    detail: { noteId, newTab }
  }))
}

/**
 * 嵌入卡片右键菜单事件名：由 NoteEmbedCard 的 nodeView（编辑器深处）发起，
 * 交由 MarkdownVisualEditor 复用正文右键菜单组件弹出卡片专属操作项。
 */
export const EMBED_CARD_MENU_EVENT = 'xynote:embed-card-menu'

/** 事件 payload：卡片目标笔记信息 + 节点位置（供「转换为链接 / 删除卡片」定位）+ 鼠标坐标。 */
export interface EmbedCardMenuEventDetail {
  noteId: string
  title: string | null
  /** 卡片节点在文档中的位置（ProseMirror NodeView getPos()），-1 表示不可用。 */
  pos: number
  x: number
  y: number
  /** 目标笔记是否可正常打开；不存在/已删除为 false（禁用打开类菜单项）。 */
  available: boolean
}

/**
 * 派发「嵌入卡片右键菜单」事件。
 *
 * :param detail: 卡片目标信息与鼠标坐标。
 * :return: 无返回值。
 */
export function dispatchEmbedCardMenu(detail: EmbedCardMenuEventDetail): void {
  window.dispatchEvent(new CustomEvent<EmbedCardMenuEventDetail>(EMBED_CARD_MENU_EVENT, { detail }))
}
