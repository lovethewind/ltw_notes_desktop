/**
 * 大纲跳转落点的端到端回归。
 *
 * 这里必须用真窗口量几何，字符串单测看不出「跳过去还离顶部老远」：
 *
 * 1. **编辑态**：滚动容器顶部压着 Crepe 的 sticky 顶栏（`.milkdown-top-bar`），
 *    落点必须是「顶栏高 + 呼吸位」—— 顶栏高度是实时量的，写死就会在窄窗口 / 换主题后错位。
 * 2. **预览态**：预览层的滚动容器上方**没有任何遮挡**，早前却沿用了编辑态的 78px 常量，
 *    白白空出 78px（用户报的就是这个）。这里把两套口径分别钉住。
 * 3. **高亮不能错位**：落点收到 14px 后，旧的高亮阈值 86 会把紧邻的下一个标题也算进来，
 *    跳转过去高亮却停在下一节 —— 一并断言。
 *
 * 无头 `--disable-gpu` 下 `scrollTo({ behavior: 'smooth' })` 推进不稳（同 note-preview 的既有
 * flaky）。这里让 `prefers-reduced-motion` 生效：动画时长被压成 0，量到的是**最终落点**而不是
 * 动画中间态 —— 测的是落点，不是动画，所以不损失覆盖。
 */

const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')

const { _electron: electron } = require('playwright')

const projectRoot = path.resolve(__dirname, '../..')
const extraLaunchArgs = (process.env.XINYUE_E2E_ELECTRON_ARGS || '').split(/\s+/).filter(Boolean)

/** 跳转落点上方保留的呼吸位；与 `MarkdownVisualEditor.vue` 的 `OUTLINE_SCROLL_GAP` 对齐。 */
const EXPECTED_GAP = 14
/** 几何量测的允许误差。 */
const TOLERANCE = 2

const OUTLINE_LABEL = '章节 5'

async function launchApplication(userDataPath) {
  const electronApplication = await electron.launch({
    args: [...extraLaunchArgs, projectRoot],
    cwd: projectRoot,
    env: { ...process.env, NODE_ENV: 'test', XINYUE_NOTES_E2E_USER_DATA: userDataPath }
  })
  const page = await electronApplication.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  await page.waitForFunction(() => Boolean(window.notesDesktop))
  await page.emulateMedia({ reducedMotion: 'reduce' })
  return { electronApplication, page }
}

/** 等某个滚动容器的 scrollTop 收敛（连续三次采样一致）。 */
async function settleScroll(page, containerSelector) {
  await page.waitForTimeout(300)
  let last = null
  let same = 0
  for (let i = 0; i < 40; i += 1) {
    await page.waitForTimeout(120)
    const now = await page.evaluate((selector) => {
      const node = document.querySelector(selector)
      return node ? Math.round(node.scrollTop) : null
    }, containerSelector)
    if (now !== null && now === last) {
      same += 1
      if (same >= 3) break
    } else {
      same = 0
    }
    last = now
  }
}

/** 点大纲项并等滚动停稳。 */
async function clickOutline(page, label) {
  await page.locator('.markdown-outline-item').filter({ hasText: label }).first().click()
}

/** 当前高亮的大纲项文字。 */
function activeOutlineText(page) {
  return page.locator('.markdown-outline-item.is-active').first().innerText()
}

test('大纲跳转落点：编辑态贴顶栏下沿、预览态贴容器顶，且高亮不错位', { timeout: 120_000 }, async () => {
  const userDataPath = await fs.mkdtemp(path.join(os.tmpdir(), 'xinyue-outline-jump-e2e-'))
  const lines = ['# 探针笔记', '']
  for (let i = 1; i <= 8; i += 1) {
    lines.push(`## 章节 ${i}`, '')
    for (let j = 0; j < 14; j += 1) lines.push(`第 ${i}-${j} 段正文，用于撑开滚动高度。`, '')
  }
  const content = lines.join('\n')

  const { electronApplication, page } = await launchApplication(userDataPath)
  try {
    await page.evaluate(
      async ({ title, body }) => {
        const note = await window.notesDesktop.createNote(null)
        await window.notesDesktop.updateNote(note.id, { title, content: body })
      },
      { title: '大纲跳转探针', body: content }
    )
    await page.reload()
    const expand = page.getByRole('button', { name: /未分类/ }).first()
    if ((await expand.getAttribute('aria-expanded')) === 'false') await expand.click()
    await page.waitForSelector('.navigation-panel .sidebar-note-main')
    await page.locator('.navigation-panel .sidebar-note-main').filter({ hasText: '大纲跳转探针' }).first().click()
    await page.locator('.milkdown-editor-root .ProseMirror').waitFor()
    await page.waitForTimeout(600)

    // ——— 编辑态：落点 = Crepe sticky 顶栏高 + 呼吸位 ———
    await clickOutline(page, OUTLINE_LABEL)
    await settleScroll(page, '.milkdown-editor-scroll')
    const editor = await page.evaluate((text) => {
      const container = document.querySelector('.milkdown-editor-scroll')
      const topBar = document.querySelector('.milkdown-top-bar')
      const heading = Array.from(document.querySelectorAll('.ProseMirror h2'))
        .find((node) => node.textContent.includes(text))
      return {
        offset: Math.round(heading.getBoundingClientRect().top - container.getBoundingClientRect().top),
        inset: topBar ? Math.round(topBar.getBoundingClientRect().height) : 0,
        scrollTop: Math.round(container.scrollTop)
      }
    }, OUTLINE_LABEL)
    assert.ok(editor.scrollTop > 0, `编辑态应真的滚动了，实际 scrollTop=${editor.scrollTop}`)
    assert.ok(editor.inset > 0, `编辑态应量到 Crepe 顶栏高度，实际 ${editor.inset}px`)
    assert.ok(
      Math.abs(editor.offset - (editor.inset + EXPECTED_GAP)) <= TOLERANCE,
      `编辑态落点应为 顶栏(${editor.inset}) + 呼吸位(${EXPECTED_GAP})，实际 ${editor.offset}px`
    )

    // ——— 预览态：预览层上方无遮挡，落点只剩呼吸位 ———
    await page.locator('.markdown-note-mode-bar__mode-button').filter({ hasText: '预览' }).click()
    await page.waitForSelector('.markdown-note-preview__body')
    await page.waitForTimeout(400)
    await clickOutline(page, OUTLINE_LABEL)
    await settleScroll(page, '.markdown-note-preview__body')
    const preview = await page.evaluate((text) => {
      const container = document.querySelector('.markdown-note-preview__body')
      const heading = Array.from(document.querySelectorAll('.markdown-note-preview__doc h2'))
        .find((node) => node.textContent.includes(text))
      return {
        offset: Math.round(heading.getBoundingClientRect().top - container.getBoundingClientRect().top),
        scrollTop: Math.round(container.scrollTop)
      }
    }, OUTLINE_LABEL)
    assert.ok(preview.scrollTop > 0, `预览态应真的滚动了，实际 scrollTop=${preview.scrollTop}`)
    assert.ok(
      Math.abs(preview.offset - EXPECTED_GAP) <= TOLERANCE,
      `预览态落点应为呼吸位 ${EXPECTED_GAP}px（预览层上方没有遮挡），实际 ${preview.offset}px`
    )

    // ——— 高亮必须停在跳转目标上（旧阈值 86 会让紧邻的下一个标题顶替）———
    assert.equal(
      (await activeOutlineText(page)).trim(),
      OUTLINE_LABEL,
      '跳转后高亮应停在目标标题上，不能被下一个标题顶替'
    )
  } finally {
    await electronApplication.close().catch(() => {})
    await fs.rm(userDataPath, { recursive: true, force: true })
  }
})
