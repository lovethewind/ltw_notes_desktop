/**
 * 打开外部 Markdown 文件的渲染层事件桥。
 *
 * 与「打开笔记」事件（note-open-events.ts）同构：让任意深度的入口
 * （拖拽落点、未来的文件关联/二次启动等）不必持有 App.vue 的函数引用。
 *
 * 注意：这里只承载「已在磁盘上、按路径打开」的场景。
 * 从系统文件选择器打开走 IPC，不经过本事件。
 */

/** 请求把指定路径的外部 Markdown 文件作为文件标签打开。 */
export const OPEN_LOCAL_FILE_EVENT = 'xynote:open-local-file'

export interface OpenLocalFileEventDetail {
  /** 外部文件的绝对路径。 */
  filePath: string
}

/**
 * 派发「打开外部文件」事件。
 *
 * @param filePath 外部 Markdown 文件的绝对路径。
 * @returns 无返回值。
 */
export function dispatchOpenLocalFile(filePath: string): void {
  if (!filePath) return
  window.dispatchEvent(new CustomEvent<OpenLocalFileEventDetail>(OPEN_LOCAL_FILE_EVENT, {
    detail: { filePath }
  }))
}
