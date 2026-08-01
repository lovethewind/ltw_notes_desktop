export type JsonCodeFormatResult =
  | { ok: true, code: string }
  | { ok: false, code: "", message: string }

/**
 * 将标准 JSON 文本格式化为两个空格缩进。
 *
 * :param code: JSON 原文。
 * :return: 格式化结果。
 */
export function formatJsonCode(code: string): JsonCodeFormatResult
