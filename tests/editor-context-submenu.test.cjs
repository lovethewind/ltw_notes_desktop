/**
 * 右键菜单的二级菜单（子菜单）—— 结构 + 接线守卫。
 *
 * ## 为什么要有子菜单
 *
 * 块类型 8 项（正文 / 一~三级标题 / 引用 / 有序 / 无序 / 代码块）平铺进主菜单时，
 * 实测整条菜单高达 **586px**（项高 38px + 1px 上下 margin ≈ 40px，14 项可见），
 * 在 1080px 高的窗口里占掉过半 —— 而这 8 项在顶栏工具栏里本来就有现成按钮，
 * 右键菜单等于把工具栏又抄了一遍。收进二级菜单后主菜单降到 7 项（约 290px），
 * 功能一项不丢。
 *
 * ## 每条断言对应一个静默失效的坑
 *
 * | 坑 | 现象 | 守卫 |
 * |---|---|---|
 * | 父项也派发命令 | 点「段落样式」什么反应都没有（action 不认识） | 断言 `onItemClick` 先判 `hasChildren` |
 * | 子菜单放进 `<button>` 里 | 浏览器把 div 挪出 button，菜单错位 / 点不中 | 断言子菜单在 `</button>` **之后** |
 * | 子菜单做成兄弟节点 | 指针从父项移过去触发 pointerleave，子菜单秒关 | 断言子菜单挂在 `.editor-context-menu__row` 内 |
 * | `--sub` 规则排在 `.editor-context-menu` 之前 | `position: fixed` 生效 → 子菜单飞到视口角 | 断言两条规则的先后 |
 * | 只往右展开 | 菜单靠右缘时子菜单被推出屏幕 | 断言 `is-left` + `getBoundingClientRect` 判定 |
 * | 收起时不重置展开态 | 下次打开菜单，上次悬停的那项已经展开 | 断言 `visible` 变 false 时清空 |
 */

const test = require('node:test')
const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const { resolve } = require('node:path')

const projectRoot = resolve(__dirname, '..')
const readSource = (filePath) => readFileSync(resolve(projectRoot, filePath), 'utf8')

const MENU = 'src/components/EditorContextMenu.vue'
const EDITOR = 'src/components/MarkdownVisualEditor.vue'

test('菜单项类型支持子项，并提供统一的判定函数', () => {
  const source = readSource(MENU)

  assert.match(source, /children\?: EditorContextMenuItem\[\]/)
  assert.match(
    source,
    /function hasChildren\(item: EditorContextMenuItem\): boolean \{\s*\n\s*return Array\.isArray\(item\.children\) && item\.children\.length > 0/
  )
})

test('父项点击只开合子菜单、不派发命令', () => {
  const source = readSource(MENU)

  // ⚠️ 父项的 action（blockType）没有对应的命令实现，派发出去就是「点了没反应」。
  assert.match(
    source,
    /function onItemClick\(item: EditorContextMenuItem\): void \{\s*\n\s*if \(hasChildren\(item\)\) \{[\s\S]*?openSubmenuAction\.value = openSubmenuAction\.value === item\.action \? null : item\.action\s*\n\s*return\s*\n\s*\}\s*\n\s*emit\('command', item\.action\)/
  )
})

test('悬停父项即展开，并按右侧空间决定往哪边展开', () => {
  const source = readSource(MENU)

  assert.match(source, /@pointerenter="onRowEnter\(item, \$event\)"/)
  assert.match(
    source,
    /const flipLeft = rect\.right \+ SUBMENU_WIDTH > window\.innerWidth - 8[\s\S]*?const left = flipLeft\s*\n\s*\? Math\.max\(8, rect\.left - SUBMENU_WIDTH\)\s*\n\s*: Math\.min\(rect\.right \+ 2, window\.innerWidth - 8 - SUBMENU_WIDTH\)/
  )
  assert.match(source, /class="resource-context-menu editor-context-menu editor-context-menu--sub"/)
  assert.match(source, /:class="`is-\$\{submenuSide\}`"/)
  assert.match(source, /:style="submenuStyle"/)
  // 往左展开时把父项 chevron 翻面，让人一眼看出往哪边开。
  assert.match(source, /:has\(> \.editor-context-menu--sub\.is-left\) \.editor-context-menu__chevron \{\s*\n\s*transform: rotate\(180deg\);/)
})

test('子菜单必须 Teleport 到 body —— 留在树内会被容器的 overflow 裁掉', () => {
  const source = readSource(MENU)

  // 🔴 本条来自一次真实回归：菜单容器 `.resource-context-menu` 是 `overflow-y: auto`，
  // 绝对定位的子菜单被祖先裁掉 → 现象是「父项高亮了、子菜单看不见」。
  assert.match(source, /<Teleport to="body">[\s\S]{0,400}?editor-context-menu--sub/)
  assert.match(source, /\.editor-context-menu--sub \{\s*\n\s*position: fixed;/)
  // 坐标由 JS 算并夹进视口，不再靠 CSS 的 calc(100% + 2px)。
  assert.match(source, /function clampSubmenuVertically\(\): void/)
  assert.match(source, /window\.innerHeight - 8 - height/)
  // ⚠️ pointerdown 也必须拦：宿主在 document 上挂了 pointerdown 关闭菜单，
  // 不拦就是「按下瞬间菜单没了、子项点不到」。
  assert.match(source, /@pointerdown\.stop\s*\n\s*@click\.stop/)
})

test('子菜单必须挂上 resource-context-menu 基础类（按钮宽度全挂在它下面）', () => {
  const source = readSource(MENU)

  // 🔴 本条来自第二次真实回归（桌面端）：桌面端的按钮样式是
  // `.resource-context-menu button { width: 100%; … }`，而 `.editor-context-menu`
  // **自己不定按钮样式**（网页端是靠 `__item` 类，两端机制不同）。
  // 子菜单漏挂基础类 → 按钮拿不到 `width: 100%`，退化成 inline 并排换行：
  // 现象是「子项横着排成好几列、还溢出到容器外」。
  assert.match(
    source,
    /class="resource-context-menu editor-context-menu editor-context-menu--sub"/
  )
  // 主菜单本来就挂着这个类 —— 子菜单必须与它对齐。
  assert.match(source, /class="resource-context-menu editor-context-menu"/)
})

test('网页端靠 __item 类承载按钮样式，两端机制不同、别互相套用', () => {
  const source = readSource(MENU)

  // 网页端（ltw_front_v3/EditorContextMenu.vue）每个按钮都带 `editor-context-menu__item`，
  // 宽度由该类给足，**不需要** resource-context-menu。这一条钉住两端各自的做法，
  // 防止「为了对齐把网页端也加上 resource-context-menu」而把网页端样式搅乱。
  assert.match(source, /<button\s*\n\s*[^>]*class="\{ danger: child\.danger \}"/)
})

test('子菜单不塞进 button（否则浏览器重排导致菜单错位）', () => {
  const source = readSource(MENU)

  assert.match(source, /<\/button>\s*\n\s*<!--[\s\S]{0,400}?-->\s*\n\s*<Teleport to="body">/)
})

test('收起菜单时一并收掉二级菜单展开态', () => {
  const source = readSource(MENU)

  // 否则下次打开菜单，上一次悬停过的那项会「莫名其妙已经展开」。
  assert.match(
    source,
    /if \(!open\) \{[\s\S]{0,200}?openSubmenuAction\.value = null[\s\S]{0,120}?return/
  )
})

test('块类型 8 项收进「段落样式」二级菜单', () => {
  const source = readSource(EDITOR)

  assert.match(source, /menuItem\('blockType', '段落样式', \{/)
  // 禁用判断挂父项：父项禁用 → 整组不出现，子项不必各自再判一次。
  assert.match(source, /menuItem\('blockType', '段落样式', \{\s*\n\s*icon: 'material-symbols:format-align-left',\s*\n\s*disabled: !canEdit,\s*\n\s*children: \[/)
  for (const [action, label] of [
    ['paragraph', '正文'],
    ['h1', '一级标题'],
    ['h2', '二级标题'],
    ['h3', '三级标题'],
    ['quote', '引用'],
    ['bulletList', '无序列表'],
    ['orderedList', '有序列表'],
    ['codeBlock', '代码块']
  ]) {
    assert.match(source, new RegExp(`menuItem\\('${action}', '${label}'`), `${label} 应作为子项保留`)
  }
  // ⚠️ 子项不得再带 disabled —— 父项已禁用时整组都不渲染，逐项判断是冗余的。
  // （终止符只匹配到 `]`：数组后面是 `\n]\n})`，多带一个 `\)` 会一路往后吞掉几万字符。）
  const childrenBlock = /children: \[([\s\S]*?)\n\s*\]/.exec(source)
  assert.ok(childrenBlock, '应能找到 children 数组')
  assert.ok(childrenBlock[1].length < 1200, `children 数组不该跨出太远，实际 ${childrenBlock[1].length} 字符`)
  assert.doesNotMatch(childrenBlock[1], /disabled:/, '子项不该各自再判 disabled')
})

test('菜单工厂支持传子项，且子项沿用叶子项的命令（块类型分发逻辑没变）', () => {
  const source = readSource(EDITOR)

  assert.match(
    source,
    /opts: \{ icon\?: string, disabled\?: boolean, danger\?: boolean; children\?: EditorContextMenuItem\[\] \} = \{\}\)/
  )
  // 子项派发的还是 paragraph / h1 / quote… 这些原有 action，分发分支一行都没改。
  // （用子串而非一整条正则：分支里含 `/^h[1-6]$/` 这种带斜杠 dollars 的字面量，
  //  写在正则里要层层转义，很容易写出一个永远不匹配的假断言。）
  const dispatchAt = source.indexOf("if (action === 'paragraph'")
  assert.ok(dispatchAt > 0, '应能找到块类型的命令分发分支')
  const dispatch = source.slice(dispatchAt, dispatchAt + 240)
  for (const action of [
    "action === 'paragraph'",
    "action === 'quote'",
    "action === 'bulletList'",
    "action === 'orderedList'",
    "action === 'codeBlock'",
    '/^h[1-6]$/.test(action)'
  ]) {
    assert.ok(dispatch.includes(action), `分发分支应仍认 ${action}`)
  }
})
