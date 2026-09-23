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
 * 取值对齐钉钉文档的字号下拉（9/10/11/12/14/16/18/20/22），
 * 但**额外补一个 15** —— 它是本项目正文的既有基准（Crepe 原始默认是 16），
 * 标题与表格字号都以它为基准 `calc` 等比换算，少了 15 会让默认档无处安放。
 */
export const FONT_SCALE_STEPS = [9, 10, 11, 12, 14, 15, 16, 18, 20, 22] as const

/** 默认档位下标，指向 15px。 */
export const DEFAULT_FONT_SCALE_INDEX = 5

/** localStorage 键名。 */
export const FONT_SCALE_STORAGE_KEY = 'notes-editor-font-size'

/** 按档位取字号；越界一律回落到默认档，避免脏数据把界面顶到极端值。 */
export function fontSizeAt(index: number): number {
  if (!Number.isInteger(index) || index < 0 || index >= FONT_SCALE_STEPS.length) {
    return FONT_SCALE_STEPS[DEFAULT_FONT_SCALE_INDEX]
  }
  return FONT_SCALE_STEPS[index]
}

/**
 * 按字号反查档位下标（下拉选中态用）。
 *
 * 字号不在档位表里时回落到默认档 —— 历史上存过 13px/17px 这类旧档位的用户
 * 不该看到「一个都没选中」的下拉。
 *
 * :param size: 字号（px）。
 * :return: 档位下标。
 */
export function indexOfFontSize(size: number): number {
  const index = FONT_SCALE_STEPS.indexOf(size as (typeof FONT_SCALE_STEPS)[number])
  return index === -1 ? DEFAULT_FONT_SCALE_INDEX : index
}

/**
 * 解析 localStorage 里存的值。
 *
 * ⚠️ **存的是字号（px）而不是档位下标**。存下标会在调整档位列表时静默串档：
 * 旧列表里下标 2 是 15px，换成新列表后同一个 2 就变成了 11px —— 用户没动设置，
 * 字号却自己变了。存字号则天然自解释，列表怎么改都不影响已存的值。
 *
 * 认不出的值（旧版下标、脏数据、负数）一律回落到默认档。
 *
 * :param stored: localStorage 取到的原始字符串（可能为 null）。
 * :return: 可用的档位下标。
 */
export function parseStoredFontScale(stored: string | null): number {
  if (stored === null || stored === '') return DEFAULT_FONT_SCALE_INDEX
  const parsed = Number(stored)
  if (!Number.isFinite(parsed)) return DEFAULT_FONT_SCALE_INDEX
  return indexOfFontSize(parsed)
}
