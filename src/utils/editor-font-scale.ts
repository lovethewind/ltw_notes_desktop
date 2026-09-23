/**
 * 编辑器正文显示字号的档位逻辑。
 *
 * ## 为什么单独成模块
 *
 * markdown **没有行内字号语法** —— 想给某段文字单独设字号，只能把
 * `<span style="font-size:18px">` 写进正文，那会污染源码、影响 Web 端 `ltw_front_v3`
 * 渲染与 Markdown 导出，且在未来 round-trip 中反复出问题。
 *
 * 所以字号只做「**显示缩放**」：调的是 CSS 变量 `--markdown-body-font-size`，
 * 正文源码一个字符都不动。这里只管档位换算与边界，DOM 与 localStorage 由组件负责。
 *
 * ## 为什么抽出来
 *
 * 档位计算是纯逻辑（边界、恢复、越界回落），按项目既有约定
 * （见 `src/utils/markdown-preview.ts` 与 `tests/markdown-preview-render.test.cjs`），
 * 这类逻辑要用**真实行为断言**守住，而不是对 `.vue` 源码做正则匹配。
 */

/**
 * 可选字号档位（px）。
 *
 * 下限 13 保证再小也还能读，上限 20 避免正文比标题还大；
 * 默认档 15 对齐钉钉正文观感（Crepe 原始默认是 16）。
 */
export const FONT_SCALE_STEPS = [13, 14, 15, 16, 17, 18, 20] as const

/** 默认档位下标，指向 15px。 */
export const DEFAULT_FONT_SCALE_INDEX = 2

/** localStorage 键名。 */
export const FONT_SCALE_STORAGE_KEY = 'notes-editor-font-size'

/** 按档位取字号；越界一律回落到默认档，避免脏数据把界面顶到极端值。 */
export function fontSizeAt(index: number): number {
  if (!Number.isInteger(index) || index < 0 || index >= FONT_SCALE_STEPS.length) {
    return FONT_SCALE_STEPS[DEFAULT_FONT_SCALE_INDEX]
  }
  return FONT_SCALE_STEPS[index]
}

/** 档位是否还能朝 `delta` 方向移动（-1 缩小 / +1 放大）。 */
export function canChangeFontSize(index: number, delta: number): boolean {
  const next = index + delta
  return Number.isInteger(next) && next >= 0 && next < FONT_SCALE_STEPS.length
}

/**
 * 计算新档位。
 *
 * :param index: 当前档位下标。
 * :param delta: -1 缩小 / +1 放大。
 * :return: 新档位下标；到边界时返回原值（调用方据此判断"未移动"）。
 */
export function nextFontScaleIndex(index: number, delta: number): number {
  return canChangeFontSize(index, delta) ? index + delta : index
}

/**
 * 解析 localStorage 里存的值。
 *
 * 非数字、越界、负数一律回落到默认档 —— 历史脏数据不该让字号失控。
 *
 * :param stored: localStorage 取到的原始字符串（可能为 null）。
 * :return: 可用的档位下标。
 */
export function parseStoredFontScale(stored: string | null): number {
  if (stored === null || stored === '') return DEFAULT_FONT_SCALE_INDEX
  const parsed = Number(stored)
  if (!Number.isInteger(parsed) || parsed < 0 || parsed >= FONT_SCALE_STEPS.length) {
    return DEFAULT_FONT_SCALE_INDEX
  }
  return parsed
}
