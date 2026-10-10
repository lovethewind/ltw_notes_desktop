/**
 * 链接编辑浮层的纯逻辑（定位计算）。
 *
 * 和 `preview-image-tools.ts` 一样：这里只放不依赖 Vue、不依赖真实 DOM 的数学，
 * 单测可以在 node 里用真行为断言（几何是最容易改坏、也最难在 e2e 里穷举的部分）。
 */

/** 链接在视口中的包围盒，来自 `view.coordsAtPos()`（client 坐标，与 `position: fixed` 直接对齐）。 */
export interface LinkEditAnchor {
  left: number
  right: number
  top: number
  bottom: number
}

/** 浮层可用的视口尺寸。 */
export interface LinkEditViewport {
  width: number
  height: number
}

/** 浮层理想宽度（与参考图的比例一致）。窄窗口下会被压缩，不会横向溢出。 */
export const LINK_EDIT_POPOVER_WIDTH = 352
/** 浮层与链接之间的间距。 */
export const LINK_EDIT_POPOVER_GAP = 10
/** 浮层与视口边缘的最小留白。 */
export const LINK_EDIT_POPOVER_MARGIN = 12
/** 宽度下限：再窄就没法把「标题 / 地址」两行摆开了，宁可溢出也要能读。 */
export const LINK_EDIT_POPOVER_MIN_WIDTH = 240

/** 浮层的最终摆放位置。 */
export interface LinkEditPopoverPlacement {
  /** `position: fixed` 用的 left（px，已取整）。 */
  left: number
  /** `position: fixed` 用的 top（px，已取整）。 */
  top: number
  /** 实际宽度（px，已取整）。 */
  width: number
  /** 摆在链接上方还是下方；窗口太矮时两侧都放不下会退化成下方并夹到视口内。 */
  placement: 'above' | 'below'
}

/**
 * 计算链接编辑浮层的屏幕位置。
 *
 * 规则：
 * 1. 宽度取「理想宽度」与「视口宽度 - 两侧留白」的较小值（但不小于下限），保证不横向溢出；
 * 2. 左边缘默认与链接左对齐，再夹进视口 —— 链接贴着编辑区右缘时浮层不会被推出屏幕；
 * 3. 垂直优先摆在链接**上方**（不遮住刚点的那条链接），上方放不下就翻到下方；
 * 4. 上下都放不下（窗口极矮）时仍放下方，但把 top 夹进视口内。
 *
 * :param anchor: 链接的视口包围盒。
 * :param viewport: 视口尺寸（通常 `window.innerWidth/Height`）。
 * :param height: 浮层实测高度（渲染后量）。
 * :return: 浮层的 left / top / width 与摆放方向。
 */
export function computeLinkEditPopoverPosition(
  anchor: LinkEditAnchor,
  viewport: LinkEditViewport,
  height: number
): LinkEditPopoverPlacement {
  const width = Math.round(Math.max(
    LINK_EDIT_POPOVER_MIN_WIDTH,
    Math.min(LINK_EDIT_POPOVER_WIDTH, viewport.width - LINK_EDIT_POPOVER_MARGIN * 2)
  ))
  // 可用高度：浮层再高也不该顶到视口外。
  const boxHeight = Math.max(0, Math.min(height, viewport.height - LINK_EDIT_POPOVER_MARGIN * 2))
  const maxLeft = Math.max(
    LINK_EDIT_POPOVER_MARGIN,
    viewport.width - width - LINK_EDIT_POPOVER_MARGIN
  )
  const left = Math.min(Math.max(LINK_EDIT_POPOVER_MARGIN, anchor.left), maxLeft)

  const above = anchor.top - boxHeight - LINK_EDIT_POPOVER_GAP
  const below = anchor.bottom + LINK_EDIT_POPOVER_GAP
  const placement: 'above' | 'below' = above >= LINK_EDIT_POPOVER_MARGIN ? 'above' : 'below'
  const maxTop = Math.max(
    LINK_EDIT_POPOVER_MARGIN,
    viewport.height - boxHeight - LINK_EDIT_POPOVER_MARGIN
  )
  const top = placement === 'above' ? above : Math.min(below, maxTop)

  return {
    left: Math.round(left),
    top: Math.round(Math.max(LINK_EDIT_POPOVER_MARGIN, top)),
    width,
    placement
  }
}
