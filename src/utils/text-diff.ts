/**
 * 同步冲突对比用的文本差异计算（纯函数，不碰 DOM / Vue）。
 *
 * 为什么不用富文本做差异：Markdown 的「行」在 Crepe 里会被合并与重排
 * （`1.a\n2.b` 是同一段落里的软换行、列表会被拆成一堆 `<li>`），源码行号与渲染块
 * 之间没有稳定的一一对应，硬做映射必然错位。所以冲突对比走**文本级 diff**：
 * 两侧按行严格对齐后，差异就落在「哪一行、哪几个字」上，既准确又能直接照搬。
 *
 * 输出结构是**行对齐**的（`DiffRow[]`）：每行同时给出左侧与右侧的格子，
 * 只有一侧存在的行另一侧为 `null`（渲染成填充行），因此两侧行号天然对齐，
 * 滚动也天然同步 —— 不需要监听 scroll、不需要防回环。
 */

/** 单侧某一行的差异归属。 */
export type DiffLineStatus = 'same' | 'added' | 'removed'

/** 行内片段：`changed` 为真表示这段是本次改动出来的字。 */
export interface DiffSegment {
  text: string
  changed: boolean
}

/** 行对齐后的一侧格子。 */
export interface DiffCell {
  /** 原文行号（1 起）。填充行为 `null`。 */
  lineNo: number | null
  text: string
  status: DiffLineStatus
  /** 行内字符级片段；未细分时为 `null`，表示整行按变更处理。 */
  segments: DiffSegment[] | null
}

/** 对齐后的一行：左右各一个格子（可能有一侧为空）。 */
export interface DiffRow {
  left: DiffCell | null
  right: DiffCell | null
  /** 该行属于第几处差异（0 起）；未变更的行以及两侧一致的行是 `null`。 */
  hunkIndex: number | null
}

export interface TextDiffResult {
  rows: DiffRow[]
  /** 差异处数（连续差异行算作一处，不是差异行数）。 */
  hunkCount: number
  /** 差异行数（左右合计）。 */
  changedLineCount: number
  /** 每处差异的起始行下标，供「上一处 / 下一处」跳转。 */
  hunkStartIndexes: number[]
}

/**
 * LCS 动态规划允许的最大格子数。
 *
 * 超长文档（比如几千行）做全表 DP 会占几十 MB 内存并卡住渲染线程；超过阈值就退化为
 * 「整块替换」，视觉上仍然是清晰的差异，只是不再逐行对齐。
 */
const MAX_LCS_CELLS = 4_000_000

/** 行内字符级比对的最大格子数（按码点计，300×300 已足够覆盖现实中的一行）。 */
const MAX_INLINE_LCS_CELLS = 120_000

/**
 * 行内细分的最低相似度。
 *
 * 两行几乎不相干时，把零星几个相同字符挑出来标绿反而更难读；此时返回 `null`，
 * 让整行按「已变更」着色。
 */
const INLINE_SIMILARITY_FLOOR = 0.34

interface DiffOp {
  type: DiffLineStatus
  /** 左侧行下标；`added` 为 -1。 */
  leftIndex: number
  /** 右侧行下标；`removed` 为 -1。 */
  rightIndex: number
}

/**
 * 把正文切成用于比对的物理行。
 *
 * 统一换行符后按 `\n` 切分；末尾的换行不额外产生一行 —— 否则一份正常结尾的 Markdown
 * 会白白多出一行空行、两侧每次都显示一处假差异。
 *
 * :param text: 原始正文。
 * :return: 行数组（空正文返回空数组）。
 */
export function splitDiffLines(text: string): string[] {
  const normalized = String(text ?? '').replace(/\r\n?/g, '\n')
  if (!normalized) return []
  const lines = normalized.split('\n')
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop()
  return lines
}

/**
 * 计算两段文本的行对齐差异。
 *
 * :param leftText: 左侧正文（冲突副本，本地那份）。
 * :param rightText: 右侧正文（云端那份）。
 * :return: 行对齐结果与差异统计。
 */
export function diffTextLines(leftText: string, rightText: string): TextDiffResult {
  const left = splitDiffLines(leftText)
  const right = splitDiffLines(rightText)
  const rows = pairRows(buildLineOps(left, right), left, right)
  const stats = summarize(rows)
  // 差异归属回写到行上：界面靠它给「当前跳转到的那一处」加强调，不必再自行推算范围。
  stats.hunkStartIndexes.forEach((startIndex, hunkIndex) => {
    for (let index = startIndex; index < rows.length; index++) {
      if (!isChangedRow(rows[index])) break
      rows[index].hunkIndex = hunkIndex
    }
  })
  return { rows, ...stats }
}

/** 该行是否属于差异（任一侧非 `same`；某侧为空说明另一侧独有，同样是差异）。 */
function isChangedRow(row: DiffRow): boolean {
  return row.left?.status !== 'same' || row.right?.status !== 'same'
}

/**
 * 把两段文本各自切成「变更 / 未变更」的字符片段。
 *
 * 先剥掉公共前后缀再对中间做 LCS：直接跑 LCS 会为了凑最长公共子序列而挑走中间的字符，
 * 看起来像是「到处都在改」；剥完前后缀后，改动会自然地收拢成中间那一小段。
 *
 * :param leftChars: 左侧字符（按码点切分）。
 * :param rightChars: 右侧字符。
 * :return: 两侧的变更标志；任一侧为空或超出阈值时返回 `null`。
 */
function inlineChangeFlags(leftChars: string[], rightChars: string[]): { left: boolean[], right: boolean[] } | null {
  if (!leftChars.length || !rightChars.length) return null

  let prefix = 0
  while (
    prefix < leftChars.length
    && prefix < rightChars.length
    && leftChars[prefix] === rightChars[prefix]
  ) prefix++

  let suffix = 0
  while (
    suffix < leftChars.length - prefix
    && suffix < rightChars.length - prefix
    && leftChars[leftChars.length - 1 - suffix] === rightChars[rightChars.length - 1 - suffix]
  ) suffix++

  const leftMiddle = leftChars.slice(prefix, leftChars.length - suffix)
  const rightMiddle = rightChars.slice(prefix, rightChars.length - suffix)
  if (!leftMiddle.length && !rightMiddle.length) return null

  const leftFlags = new Array<boolean>(leftChars.length).fill(false)
  const rightFlags = new Array<boolean>(rightChars.length).fill(false)

  const canRunLcs = (leftMiddle.length + 1) * (rightMiddle.length + 1) <= MAX_INLINE_LCS_CELLS
  let matched = 0
  if (canRunLcs) {
    const pairs = charLcsPairs(leftMiddle, rightMiddle)
    matched = pairs.length
    const leftKeep = new Set(pairs.map((pair) => pair[0]))
    const rightKeep = new Set(pairs.map((pair) => pair[1]))
    for (let index = prefix; index < leftChars.length - suffix; index++) {
      leftFlags[index] = !leftKeep.has(index - prefix)
    }
    for (let index = prefix; index < rightChars.length - suffix; index++) {
      rightFlags[index] = !rightKeep.has(index - prefix)
    }
  } else {
    // 超长行：不细分，整段中间区域按变更处理。
    for (let index = prefix; index < leftChars.length - suffix; index++) leftFlags[index] = true
    for (let index = prefix; index < rightChars.length - suffix; index++) rightFlags[index] = true
  }

  // ⚠️ 相似度必须把剥掉的前后缀算进去：末尾追加两个字（`…仓库禁启用` → `…仓库禁启用状态`）
  //    意味着公共段全部落在 prefix 里，只统计中段 LCS 会得到 0，低于阈值而被误判成
  //    「两行毫不相干」——那正是最常见的改动形态（追加 / 删除尾巴）。
  const similarity = (prefix + suffix + matched) / Math.max(leftChars.length, rightChars.length)
  if (canRunLcs && similarity < INLINE_SIMILARITY_FLOOR) return null
  return { left: leftFlags, right: rightFlags }
}

/**
 * 行内字符级 LCS，返回两侧保留下来的字符下标对。
 *
 * :param left: 左侧字符数组。
 * :param right: 右侧字符数组。
 * :return: `[左侧下标, 右侧下标]` 升序数组。
 */
function charLcsPairs(left: string[], right: string[]): Array<[number, number]> {
  const width = right.length + 1
  const table = new Uint32Array((left.length + 1) * width)
  for (let i = left.length - 1; i >= 0; i--) {
    for (let j = right.length - 1; j >= 0; j--) {
      table[i * width + j] = left[i] === right[j]
        ? table[(i + 1) * width + (j + 1)] + 1
        : Math.max(table[(i + 1) * width + j], table[i * width + (j + 1)])
    }
  }
  const pairs: Array<[number, number]> = []
  let i = 0
  let j = 0
  while (i < left.length && j < right.length) {
    if (left[i] === right[j]) {
      pairs.push([i, j])
      i++
      j++
    } else if (table[(i + 1) * width + j] >= table[i * width + (j + 1)]) {
      i++
    } else {
      j++
    }
  }
  return pairs
}

/**
 * 按标志位把字符切成片段（相邻同标志的字符合并，避免逐字一个标签）。
 *
 * :param chars: 字符数组。
 * :param flags: 与字符一一对应的变更标志。
 * :return: 片段数组。
 */
function toSegments(chars: string[], flags: boolean[]): DiffSegment[] {
  const segments: DiffSegment[] = []
  chars.forEach((char, index) => {
    const changed = flags[index]
    const last = segments[segments.length - 1]
    if (last && last.changed === changed) last.text += char
    else segments.push({ text: char, changed })
  })
  return segments
}

/**
 * 为并排的一对「仅左侧有 / 仅右侧有」的行生成行内片段。
 *
 * :param leftText: 左行文本。
 * :param rightText: 右行文本。
 * :return: 两侧片段；不宜细分时返回 `null`。
 */
function inlineSegments(leftText: string, rightText: string): { left: DiffSegment[], right: DiffSegment[] } | null {
  const leftChars = Array.from(leftText)
  const rightChars = Array.from(rightText)
  const flags = inlineChangeFlags(leftChars, rightChars)
  if (!flags) return null
  return { left: toSegments(leftChars, flags.left), right: toSegments(rightChars, flags.right) }
}

/**
 * 对两段行做 LCS 并输出操作序列（含公共前后缀剥离）。
 *
 * :param left: 左侧行数组。
 * :param right: 右侧行数组。
 * :return: 按先后顺序排列的操作序列。
 */
function buildLineOps(left: string[], right: string[]): DiffOp[] {
  let prefix = 0
  while (prefix < left.length && prefix < right.length && left[prefix] === right[prefix]) prefix++

  let leftEnd = left.length
  let rightEnd = right.length
  while (leftEnd > prefix && rightEnd > prefix && left[leftEnd - 1] === right[rightEnd - 1]) {
    leftEnd--
    rightEnd--
  }

  const ops: DiffOp[] = []
  for (let index = 0; index < prefix; index++) {
    ops.push({ type: 'same', leftIndex: index, rightIndex: index })
  }

  const leftMiddle = left.slice(prefix, leftEnd)
  const rightMiddle = right.slice(prefix, rightEnd)
  const canRunLcs = (leftMiddle.length + 1) * (rightMiddle.length + 1) <= MAX_LCS_CELLS
  if (canRunLcs) {
    ops.push(...lineLcsOps(leftMiddle, rightMiddle, prefix))
  } else {
    leftMiddle.forEach((_, index) => ops.push({ type: 'removed', leftIndex: prefix + index, rightIndex: -1 }))
    rightMiddle.forEach((_, index) => ops.push({ type: 'added', leftIndex: -1, rightIndex: prefix + index }))
  }

  for (let index = leftEnd; index < left.length; index++) {
    ops.push({ type: 'same', leftIndex: index, rightIndex: rightEnd + (index - leftEnd) })
  }
  return ops
}

/**
 * 对剥掉公共前后缀后的中间块做 LCS。
 *
 * 行先映射成整数 id 再比较：几千行 × 几千行的 DP 里，字符串比较是主要开销，
 * 换成整数后同样是 O(n·m) 的循环，实测快一个量级。
 *
 * :param left: 左侧中间块。
 * :param right: 右侧中间块。
 * :param offset: 中间块在原文中的起始行下标。
 * :return: 操作序列。
 */
function lineLcsOps(left: string[], right: string[], offset: number): DiffOp[] {
  const ids = new Map<string, number>()
  const idOf = (line: string): number => {
    const existing = ids.get(line)
    if (existing !== undefined) return existing
    const next = ids.size
    ids.set(line, next)
    return next
  }
  const leftIds = left.map(idOf)
  const rightIds = right.map(idOf)

  const width = right.length + 1
  const table = new Uint32Array((left.length + 1) * width)
  for (let i = left.length - 1; i >= 0; i--) {
    for (let j = right.length - 1; j >= 0; j--) {
      table[i * width + j] = leftIds[i] === rightIds[j]
        ? table[(i + 1) * width + (j + 1)] + 1
        : Math.max(table[(i + 1) * width + j], table[i * width + (j + 1)])
    }
  }

  const ops: DiffOp[] = []
  let i = 0
  let j = 0
  while (i < left.length && j < right.length) {
    if (leftIds[i] === rightIds[j]) {
      ops.push({ type: 'same', leftIndex: offset + i, rightIndex: offset + j })
      i++
      j++
    } else if (table[(i + 1) * width + j] >= table[i * width + (j + 1)]) {
      ops.push({ type: 'removed', leftIndex: offset + i, rightIndex: -1 })
      i++
    } else {
      ops.push({ type: 'added', leftIndex: -1, rightIndex: offset + j })
      j++
    }
  }
  while (i < left.length) {
    ops.push({ type: 'removed', leftIndex: offset + i, rightIndex: -1 })
    i++
  }
  while (j < right.length) {
    ops.push({ type: 'added', leftIndex: -1, rightIndex: offset + j })
    j++
  }
  return ops
}

/**
 * 把操作序列折成行对齐结构。
 *
 * 变更段里左右各自的行按**出现顺序**一一并排（GitHub split diff 的做法）：这样两侧
 * 行号保持单调，一眼就能看出「这个位置左边多了一条、右边删了一条」；多出来的一侧
 * 补 `null` 占位，保证后续行仍然左右对齐。
 *
 * :param ops: 操作序列。
 * :param left: 左侧行数组。
 * :param right: 右侧行数组。
 * :return: 行对齐数组。
 */
function pairRows(ops: DiffOp[], left: string[], right: string[]): DiffRow[] {
  const rows: DiffRow[] = []
  let cursor = 0
  while (cursor < ops.length) {
    const op = ops[cursor]
    if (op.type === 'same') {
      rows.push({
        left: { lineNo: op.leftIndex + 1, text: left[op.leftIndex], status: 'same', segments: null },
        right: { lineNo: op.rightIndex + 1, text: right[op.rightIndex], status: 'same', segments: null },
        hunkIndex: null
      })
      cursor++
      continue
    }

    const removed: number[] = []
    const added: number[] = []
    while (cursor < ops.length && ops[cursor].type !== 'same') {
      const current = ops[cursor]
      if (current.type === 'removed') removed.push(current.leftIndex)
      else added.push(current.rightIndex)
      cursor++
    }

    const paired = Math.min(removed.length, added.length)
    for (let index = 0; index < paired; index++) {
      const leftText = left[removed[index]]
      const rightText = right[added[index]]
      const segments = inlineSegments(leftText, rightText)
      rows.push({
        left: { lineNo: removed[index] + 1, text: leftText, status: 'removed', segments: segments?.left ?? null },
        right: { lineNo: added[index] + 1, text: rightText, status: 'added', segments: segments?.right ?? null },
        hunkIndex: null
      })
    }
    for (let index = paired; index < removed.length; index++) {
      rows.push({
        left: { lineNo: removed[index] + 1, text: left[removed[index]], status: 'removed', segments: null },
        right: null,
        hunkIndex: null
      })
    }
    for (let index = paired; index < added.length; index++) {
      rows.push({
        left: null,
        right: { lineNo: added[index] + 1, text: right[added[index]], status: 'added', segments: null },
        hunkIndex: null
      })
    }
  }
  return rows
}

/**
 * 统计差异处数与差异行数，并记录每处差异的起始行下标。
 *
 * :param rows: 行对齐数组。
 * :return: 统计结果。
 */
function summarize(rows: DiffRow[]): Omit<TextDiffResult, 'rows'> {
  let hunkCount = 0
  let changedLineCount = 0
  const hunkStartIndexes: number[] = []
  let insideHunk = false

  rows.forEach((row, index) => {
    if (!isChangedRow(row)) {
      insideHunk = false
      return
    }
    changedLineCount++
    if (!insideHunk) {
      insideHunk = true
      hunkCount++
      hunkStartIndexes.push(index)
    }
  })

  return { hunkCount, changedLineCount, hunkStartIndexes }
}
