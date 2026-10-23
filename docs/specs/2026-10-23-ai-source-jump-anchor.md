# AI 回答的来源跳到命中处（2026-10-23）

## 问题

点回答里的 `[S1]` 或「参考 N 篇笔记」里的某一条，只是把整篇笔记打开，光标和滚动都停在笔记顶部。
长笔记等于没用：用户还得自己在正文里搜一遍刚才那条引用说的是哪一段。

## 为什么不能直接拿现有字段定位

来源对象里看起来最像「命中片段」的是 `excerpt`，但它是**笔记正文的前 180 字**
（`ai-assistant.cjs` `buildContext` → `cleaned.slice(0, limit)` 再 `slice(0, 180)`），
跟检索命中位置无关。拿它当锚点只会滚到顶部，等于什么都没做。

真正知道「为什么召回了这篇」的只有检索环节：`collectCandidates` 里逐个 term 调
`searchNotes`，那个 term 就是命中词。所以要定位，必须让后端把 term 带出来。

## 方案

1. 后端在收集候选时记下命中词（`appendCandidate(..., matchedTerm)`），随来源下发 `matchTerm`。
   - 只在**正文里确实出现**该词时才记：FTS 也会命中标题和标签，那种情况下正文里根本没有，
     记了前端也是白找一趟。
   - 「当前笔记」档位没有检索词（整篇直接送给模型），`matchTerm` 为 `null`，不定位。
2. 落库时把 `matchTerm` 一起存（`normalizeAiSources`），恢复历史后点来源仍能定位。
3. 前端：`openSource` 事件从「只传 noteId」改成传 `{ noteId, matchTerm }`；
   App 打开笔记后调编辑器的 `scrollToText(matchTerm)`。
4. 两个编辑器各加一个 `scrollToText(keyword)`：**只滚不选**。

## 关键取舍

- **为什么不复用 `findText`**：它会 `setSelection` 选中命中文本。跳过去是为了看，
  留一个选中段会让用户下一次输入直接把它覆盖掉 —— 这是数据事故，不是功能差异。
  `scrollToText` 复用同一套 `collectDocumentMatches` / `scrollMatchIntoView`，只是不动选区。
- **不在 `findText` 里加参数**：查找栏依赖「选中 + 高亮」这套语义（替换、⌘G 循环都靠它），
  给它加开关会让两件事纠缠。两个方法各管一件事更清楚。
- **定位失败不报错**：词可能已被改掉、命中来自标题，或者文本被加粗拆成两个节点
  （匹配口径本来就是「只在同一文本节点内」）。找不到就停在原位置，不弹提示。
- **预览态**：`scrollToText` 自带「先回编辑态再滚」，与 `findText` 同处置；富文本版切换后
  等一帧再量坐标，否则容器还没尺寸、`scrollTo` 落空。
- **不引入更长锚点**：`createNoteSearchExcerpt` 那种「命中词前后几十字」的上下文跨节点概率高，
  按现有匹配口径必然找不到。短词命中率高得多。

## 改动清单

| 文件 | 改动 |
| --- | --- |
| `electron/ai-assistant.cjs` | `appendCandidate` 记 `matchedTerm`（校验正文含词）；`buildContext` 下发 `matchTerm` |
| `electron/database.cjs` | `normalizeAiSources` 存取 `matchTerm`（上限 64 字） |
| `src/types.ts` | `AiAssistantSource.matchTerm` |
| `src/components/AiAssistantPanel.vue` | `openSource` 事件带对象；新增 `openSource(source)` 统一两处调用 |
| `src/App.vue` | `openAiAssistantSource(payload)`：打开后 `scrollToText`；ref 类型补方法 |
| `src/components/MarkdownVisualEditor.vue` | 新增 `scrollToText`（只滚不选，预览态先回编辑态）+ `defineExpose` |
| `src/components/MarkdownSourceEditor.vue` | 同上（CodeMirror 版：光标落到命中处、`scrollIntoView`） |

## 验证

- 单测 **561/561**：新增「来源带上命中词 / 只在标题命中时为 null」行为测试；新增接线守卫
  （面板事件带词、App 调 `scrollToText`、两个编辑器都 expose、富文本版不许出现 `setSelection`）；
  `ai-conversation` 的 sources 深比较补 `matchTerm`。
- AI e2e **10/10**：用例 ② 的「引用目标」笔记撑到 120 段、命中词只放末尾，点 `[S1]` 后断言
  `.milkdown-editor-scroll` 的 `scrollTop > 200`（真的滚下去了）且 `window.getSelection()` 为空（没选中）。
- 回归：外部文件 e2e 13/13、查找替换 e2e 2/2。
