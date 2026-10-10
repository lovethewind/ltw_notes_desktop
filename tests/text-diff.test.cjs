const test = require('node:test')
const assert = require('node:assert/strict')
const { pathToFileURL } = require('node:url')
const { resolve } = require('node:path')

const projectRoot = resolve(__dirname, '..')

/**
 * 冲突对比差异算法的真实行为测试。
 *
 * 与「源码正则匹配」那类单测不同，这里直接调用模块、断言输出的行对齐结构：
 * 差异算法一旦错位（少一行、行号串位、把相同行标成变更），冲突对比界面就会给出
 * 误导性的结论 —— 用户据此决定「保留哪一份」，代价是真丢内容，所以必须用真数据守住。
 */
let diffModule

test.before(async () => {
  diffModule = await import(pathToFileURL(resolve(projectRoot, 'src/utils/text-diff.ts')).href)
})

/** 取某行某一侧的纯文本（用于快速比对）。 */
function textAt(result, index, side) {
  return result.rows[index][side]?.text ?? null
}

/** 取某行某一侧的状态。 */
function statusAt(result, index, side) {
  return result.rows[index][side]?.status ?? null
}

test('两侧完全一致时没有差异', () => {
  const result = diffModule.diffTextLines('# 日报\n\n第一条\n第二条', '# 日报\n\n第一条\n第二条')
  assert.equal(result.rows.length, 4)
  assert.equal(result.hunkCount, 0)
  assert.equal(result.changedLineCount, 0)
  assert.deepEqual(result.hunkStartIndexes, [])
  assert.ok(result.rows.every((row) => row.left.status === 'same' && row.right.status === 'same'))
  // 行号必须从 1 起、逐行递增。
  assert.deepEqual(result.rows.map((row) => row.left.lineNo), [1, 2, 3, 4])
})

test('末尾换行与 CRLF 不算差异', () => {
  const trailing = diffModule.diffTextLines('甲\n乙\n', '甲\n乙')
  assert.equal(trailing.hunkCount, 0, '末尾换行不该产生一行假差异')

  const crlf = diffModule.diffTextLines('甲\r\n乙\r\n', '甲\n乙')
  assert.equal(crlf.hunkCount, 0, 'CRLF 与 LF 应视为相同内容')
  assert.equal(crlf.rows.length, 2)
})

test('左侧独有的一行：左侧标 removed、右侧留空占位', () => {
  const result = diffModule.diffTextLines('甲\n只有左边有\n乙', '甲\n乙')
  assert.equal(result.hunkCount, 1)
  assert.equal(result.changedLineCount, 1)
  assert.equal(result.rows.length, 3)
  assert.equal(statusAt(result, 1, 'left'), 'removed')
  assert.equal(textAt(result, 1, 'left'), '只有左边有')
  assert.equal(result.rows[1].right, null, '右侧应留空占位以保证行对齐')
  // 关键：留空之后第二行仍然左右对齐，行号没有串位。
  assert.equal(textAt(result, 2, 'left'), '乙')
  assert.equal(textAt(result, 2, 'right'), '乙')
  assert.equal(result.rows[2].left.lineNo, 3)
  assert.equal(result.rows[2].right.lineNo, 2)
})

test('右侧独有的一行：右侧标 added、左侧留空占位', () => {
  const result = diffModule.diffTextLines('甲\n乙', '甲\n只有右边有\n乙')
  assert.equal(result.hunkCount, 1)
  assert.equal(result.rows.length, 3)
  assert.equal(result.rows[1].left, null)
  assert.equal(statusAt(result, 1, 'right'), 'added')
  assert.equal(textAt(result, 1, 'right'), '只有右边有')
  assert.equal(result.rows[2].left.lineNo, 2)
  assert.equal(result.rows[2].right.lineNo, 3)
})

test('同一位置的改写会并排成一行，并给出行内变更片段', () => {
  const result = diffModule.diffTextLines('1.#91757 仓库禁启用', '1.#91757 仓库禁启用状态')
  assert.equal(result.rows.length, 1)
  const row = result.rows[0]
  assert.equal(row.left.status, 'removed')
  assert.equal(row.right.status, 'added')
  assert.ok(row.left.segments, '相似行应做行内细分')

  // 只有追加的「状态」两字属于变更，前面完全相同的一段必须保持未变更。
  const leftChanged = row.left.segments.filter((segment) => segment.changed).map((segment) => segment.text).join('')
  const rightChanged = row.right.segments.filter((segment) => segment.changed).map((segment) => segment.text).join('')
  assert.equal(leftChanged, '')
  assert.equal(rightChanged, '状态')
  // 片段拼接必须无损还原原文。
  assert.equal(row.left.segments.map((segment) => segment.text).join(''), '1.#91757 仓库禁启用')
  assert.equal(row.right.segments.map((segment) => segment.text).join(''), '1.#91757 仓库禁启用状态')
})

test('改动落在行中间时只标中间那段', () => {
  const result = diffModule.diffTextLines('前置内容【旧版】后置内容', '前置内容【新版】后置内容')
  const row = result.rows[0]
  const changedTexts = row.left.segments.filter((segment) => segment.changed).map((segment) => segment.text)
  assert.deepEqual(changedTexts, ['旧'])
  assert.deepEqual(
    row.right.segments.filter((segment) => segment.changed).map((segment) => segment.text),
    ['新']
  )
})

test('两行几乎不相同时不做行内细分（整行变色更好读）', () => {
  const result = diffModule.diffTextLines('完全不同的第一版内容', 'This is a totally different line.')
  const row = result.rows[0]
  assert.equal(row.left.status, 'removed')
  assert.equal(row.left.segments, null, '相似度过低时应放弃细分')
  assert.equal(row.right.segments, null)
})

test('左右变更行数不等时：多出来的一侧各自占一行', () => {
  const result = diffModule.diffTextLines('头\n左一\n左二\n尾', '头\n右一\n尾')
  assert.equal(result.hunkCount, 1)
  // 头、尾 + 并排 1 行 + 左侧多出的 1 行
  assert.equal(result.rows.length, 4)
  assert.equal(textAt(result, 1, 'left'), '左一')
  assert.equal(textAt(result, 1, 'right'), '右一')
  assert.equal(textAt(result, 2, 'left'), '左二')
  assert.equal(result.rows[2].right, null)
  assert.equal(textAt(result, 3, 'left'), '尾')
})

test('相隔的两处差异算两处，且记录起始行下标', () => {
  const result = diffModule.diffTextLines('A\n改我\nB\nC\n再改我', 'A\n改过\nB\nC\n再改过')
  assert.equal(result.hunkCount, 2)
  assert.equal(result.changedLineCount, 2)
  assert.deepEqual(result.hunkStartIndexes, [1, 4])
})

test('重复行不会让对齐错乱', () => {
  const result = diffModule.diffTextLines('重复\n甲\n重复\n乙', '重复\n重复\n乙')
  assert.equal(result.rows.length, 4)
  assert.equal(statusAt(result, 1, 'left'), 'removed')
  assert.equal(textAt(result, 1, 'left'), '甲')
  assert.equal(result.rows[1].right, null)
  assert.equal(textAt(result, 2, 'left'), '重复')
  assert.equal(textAt(result, 2, 'right'), '重复')
})

test('空正文的各种组合都不炸', () => {
  const both = diffModule.diffTextLines('', '')
  assert.deepEqual(both.rows, [])
  assert.equal(both.hunkCount, 0)

  const emptyLeft = diffModule.diffTextLines('', '甲\n乙')
  assert.equal(emptyLeft.rows.length, 2)
  assert.equal(emptyLeft.rows[0].left, null)
  assert.equal(statusAt(emptyLeft, 0, 'right'), 'added')
  assert.equal(emptyLeft.hunkCount, 1)

  const emptyRight = diffModule.diffTextLines('甲\n乙', '')
  assert.equal(emptyRight.rows.length, 2)
  assert.equal(emptyRight.rows[0].right, null)
  assert.equal(statusAt(emptyRight, 0, 'left'), 'removed')
})

test('超长文本走降级分支：不抛错、两侧内容一字不少', () => {
  const size = 2200
  const left = Array.from({ length: size }, (_, index) => `左侧第 ${index} 行`)
  const right = Array.from({ length: size }, (_, index) => `右侧第 ${index} 行`)
  const result = diffModule.diffTextLines(left.join('\n'), right.join('\n'))
  // 超阈值后不再跑全表 DP（会吃掉几十 MB 内存），改为「左侧整段 + 右侧整段」顺序输出；
  // 但无论走哪条分支，两侧的内容都不能少一行 —— 漏行等于让用户在对比里看不到自己写的东西。
  const leftRows = result.rows.filter((row) => row.left)
  const rightRows = result.rows.filter((row) => row.right)
  assert.equal(leftRows.length, size)
  assert.equal(rightRows.length, size)
  assert.equal(leftRows[0].left.text, '左侧第 0 行')
  assert.equal(leftRows[size - 1].left.text, `左侧第 ${size - 1} 行`)
  assert.equal(rightRows[0].right.text, '右侧第 0 行')
  assert.equal(rightRows[size - 1].right.text, `右侧第 ${size - 1} 行`)
  // 行号也要连续，否则界面上的行号会出现空洞。
  assert.deepEqual(leftRows.map((row) => row.left.lineNo), Array.from({ length: size }, (_, index) => index + 1))
})

test('真实冲突样本：能定位到「左边多了一条编号」', () => {
  const shared = [
    '日报',
    '',
    '2026-10-08',
    '',
    '1.#91757 【中山BE-迭代二】仓库禁启用状态也根据领猫更新',
    '2.#91755 【中山BE-迭代二】二次工艺外发单节点数没有统计到外发加工单列表',
    '3.#91763 【中山BE-迭代二】最新裁剪数SS端没显示'
  ]
  const left = [...shared, '4.#91793 【中山BE-迭代三】单价取工序表实际单价实际维护值，不用处理小数位', '', '2026-09-24', '1.#91712 更新生产节点后，发现节点还是有领猫不存在的节点']
  const right = [...shared, '', '2026-09-24', '1.#91712 更新生产节点后，发现节点还是有领猫不存在的节点']

  const result = diffModule.diffTextLines(left.join('\n'), right.join('\n'))
  assert.equal(result.hunkCount, 1, '整体只差一条编号，应只算一处差异')
  const removed = result.rows.filter((row) => row.left && row.right === null)
  assert.equal(removed.length, 1)
  assert.match(removed[0].left.text, /#91793/)
  assert.equal(removed[0].left.lineNo, 8)
  // 两侧共有部分必须逐行对齐，不能因为中间插了一行就整体错位。
  const sharedRow = result.rows.find((row) => row.left?.text === '2026-09-24')
  assert.ok(sharedRow, '共有行应保持对齐')
  assert.equal(sharedRow.left.status, 'same')
  assert.equal(sharedRow.right.status, 'same')
})
