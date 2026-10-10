/**
 * 预览图片交互的纯逻辑。
 *
 * 与 `markdown-preview.ts` / `preview-sanitize.ts` 一样：两处预览（笔记预览、本地文件预览）
 * 共用同一份规则，不各写一遍。这里只放不依赖 Vue、不依赖 DOM 状态的计算，
 * 单测可以在 node 里直接跑（缩放数学是这块最容易算错的地方）。
 */

/** 全屏查看器里的一张图片。 */
export interface PreviewImageItem {
  /** 可直接交给 `img.src` 的地址。 */
  src: string
  /** 替代文本，可能为空。 */
  alt: string
}

/** 缩放上下限：下限防止缩成看不见，上限留够看像素细节的余量。 */
export const PREVIEW_IMAGE_MIN_SCALE = 0.1
export const PREVIEW_IMAGE_MAX_SCALE = 8

/** 单次滚轮/按钮缩放的步进比例。 */
export const PREVIEW_IMAGE_ZOOM_STEP = 1.25

/** 把缩放值钳进合法区间；非有限值按 1 处理（防止 NaN 传进来把整层 transform 弄没）。 */
export function clampPreviewImageScale(scale: number): number {
  if (!Number.isFinite(scale)) return 1
  return Math.min(PREVIEW_IMAGE_MAX_SCALE, Math.max(PREVIEW_IMAGE_MIN_SCALE, scale))
}

/**
 * 计算「适应窗口」的初始缩放。
 *
 * **不放大**：小图（例如 1×1 的示意图）按 100% 开场，需要更大再滚轮。否则一张 16px 的图标
 * 会被拉满整个屏幕，像素糊成一片，反而看不出是什么。
 *
 * :param naturalWidth: 图片自然宽度（`img.naturalWidth`）。
 * :param naturalHeight: 图片自然高度。
 * :param boxWidth: 可用区域宽度。
 * :param boxHeight: 可用区域高度。
 * :return: 初始缩放值；尺寸取不到时按 1 处理。
 */
export function computePreviewImageFitScale(
  naturalWidth: number,
  naturalHeight: number,
  boxWidth: number,
  boxHeight: number
): number {
  if (!(naturalWidth > 0) || !(naturalHeight > 0) || !(boxWidth > 0) || !(boxHeight > 0)) return 1
  return clampPreviewImageScale(Math.min(1, boxWidth / naturalWidth, boxHeight / naturalHeight))
}

/**
 * 以某个点为锚缩放（滚轮用）。
 *
 * 图片的 transform 是 `translate(offsetX, offsetY) scale(scale)`、`transform-origin: center`，
 * 于是「图片上的某个点」落在容器坐标 `P` 上时满足：
 *     `P - center = offset + q * scale`（`q` 是该点在图片上的原始坐标）
 * 要让 `q` 在缩放后仍停在同一个 `P` 上：
 *     `offset' = (P - center) - ((P - center) - offset) * (scale' / scale)`
 * 不这么做的话，缩放永远是绕图片中心，光标下的内容会跑掉。
 *
 * :param input.scale: 当前缩放。
 * :param input.offsetX: 当前水平位移。
 * :param input.offsetY: 当前垂直位移。
 * :param input.nextScale: 目标缩放（调用方已钳制）。
 * :param input.pointX: 锚点相对容器中心的水平坐标。
 * :param input.pointY: 锚点相对容器中心的垂直坐标。
 * :return: 新的缩放与位移。
 */
export function zoomPreviewImageAtPoint(input: {
  scale: number
  offsetX: number
  offsetY: number
  nextScale: number
  pointX: number
  pointY: number
}): { scale: number, offsetX: number, offsetY: number } {
  const { offsetX, offsetY, nextScale, pointX, pointY } = input
  const scale = clampPreviewImageScale(input.scale)
  const ratio = clampPreviewImageScale(nextScale) / scale
  return {
    scale: clampPreviewImageScale(nextScale),
    offsetX: pointX - (pointX - offsetX) * ratio,
    offsetY: pointY - (pointY - offsetY) * ratio
  }
}

/** 是否是网络图片（只有这类才有「在浏览器打开」的意义）。 */
export function isRemoteImageSource(src: string): boolean {
  return /^https?:\/\//i.test(String(src || '').trim())
}

/**
 * 从事件目标里解析出真正的图片元素。
 *
 * 两处预览的正文是 `v-html` 出来的死 HTML，`target` 直接就是 `<img>`；但编辑器里的图片块是
 * `.milkdown-image-block > .image-wrapper > img`，而 **wrapper 盖在 img 之上**（命中链里它拦截
 * 指针事件），所以 `event.target` 往往是 wrapper 而不是 img。
 *
 * wrapper 里还住着 Crepe 自己的图注按钮与缩放手柄，它们各有职责，不能被当成「点了图片」。
 *
 * ⚠️ 右键菜单的「是否图片」判定必须与这里共用，否则两个 `contextmenu` 监听器（挂在同一元素上，
 * `stopPropagation` 挡不住兄弟监听器）口径不一致时会同时弹两个菜单。
 *
 * :param target: 事件目标。
 * :return: 命中的 `<img>`；没命中返回 null。
 */
export function resolvePreviewImageElement(target: EventTarget | null): HTMLImageElement | null {
  if (!(target instanceof Element)) return null
  const direct = target.closest('img')
  if (direct) return direct
  const wrapper = target.closest('.image-wrapper')
  if (!wrapper) return null
  if (target.closest('.operation') || target.closest('.image-resize-handle')) return null
  return wrapper.querySelector('img')
}

/**
 * 收集预览正文里的图片清单（全屏查看器要按 DOM 顺序左右切换）。
 *
 * :param root: 预览正文容器；未渲染时传 null。
 * :return: 图片清单，跳过取不到地址的项。
 */
export function collectPreviewImageItems(root: ParentNode | null): PreviewImageItem[] {
  if (!root) return []
  return Array.from(root.querySelectorAll('img'))
    .map((image) => ({
      src: image.currentSrc || image.src || image.getAttribute('src') || '',
      alt: (image.getAttribute('alt') || '').trim()
    }))
    .filter((item) => Boolean(item.src))
}
