<script setup lang="ts">
import { Icon } from '@iconify/vue'
import DOMPurify from 'dompurify'
import { marked } from 'marked'
import { computed, ref, watch } from 'vue'
import type {
  AiAssistantAnswer,
  AiAssistantScope,
  AiAssistantSettings
} from '../types'

const props = defineProps<{
  visible: boolean
  currentNoteId: string | null
  currentFolderId: string | null
  currentNoteTitle: string
}>()

const emit = defineEmits<{
  close: []
  openSource: [noteId: string]
}>()

const scope = ref<AiAssistantScope>('current')
const question = ref('')
const loading = ref(false)
const settingsLoading = ref(false)
const settingsOpen = ref(false)
const error = ref('')
const answer = ref<AiAssistantAnswer | null>(null)
const settings = ref<AiAssistantSettings>({ baseUrl: 'https://api.openai.com/v1', model: '', hasApiKey: false })
const settingsDraft = ref({ baseUrl: 'https://api.openai.com/v1', model: '', apiKey: '' })

const scopeOptions: Array<{ value: AiAssistantScope, label: string, icon: string }> = [
  { value: 'current', label: '当前笔记', icon: 'tabler:file-text' },
  { value: 'folder', label: '当前文件夹', icon: 'tabler:folder' },
  { value: 'all', label: '全部笔记', icon: 'tabler:notes' }
]

const canAsk = computed(() => (
  Boolean(question.value.trim())
  && Boolean(settings.value.model)
  && settings.value.hasApiKey
  && !loading.value
  && (scope.value !== 'current' || Boolean(props.currentNoteId))
))

/** 模型输出属于不可信内容，Markdown 转换后必须净化再进入 DOM。 */
const renderedAnswer = computed(() => (
  answer.value
    ? DOMPurify.sanitize(marked.parse(answer.value.answer, { async: false }))
    : ''
))

/** 打开面板时读取不含密钥明文的本机设置。 */
async function loadSettings(): Promise<void> {
  settingsLoading.value = true
  error.value = ''
  try {
    const saved = await window.notesDesktop.getAiAssistantSettings()
    settings.value = saved
    settingsDraft.value = { baseUrl: saved.baseUrl, model: saved.model, apiKey: '' }
    settingsOpen.value = !saved.model || !saved.hasApiKey
  } catch (loadError) {
    error.value = loadError instanceof Error ? loadError.message : 'AI 设置读取失败'
    settingsOpen.value = true
  } finally {
    settingsLoading.value = false
  }
}

async function saveSettings(): Promise<void> {
  settingsLoading.value = true
  error.value = ''
  try {
    // Vue ref 中的对象是响应式 Proxy，Electron IPC 无法结构化克隆，必须先提取为普通对象。
    settings.value = await window.notesDesktop.saveAiAssistantSettings({
      baseUrl: settingsDraft.value.baseUrl,
      model: settingsDraft.value.model,
      apiKey: settingsDraft.value.apiKey
    })
    settingsDraft.value.apiKey = ''
    settingsOpen.value = false
  } catch (saveError) {
    error.value = saveError instanceof Error ? saveError.message : 'AI 设置保存失败'
  } finally {
    settingsLoading.value = false
  }
}

/** 只把当前选择范围交给主进程，正文召回和字符预算由主进程统一控制。 */
async function ask(): Promise<void> {
  if (!canAsk.value) return
  loading.value = true
  error.value = ''
  answer.value = null
  try {
    answer.value = await window.notesDesktop.askAiAssistant({
      question: question.value.trim(),
      scope: scope.value,
      noteId: props.currentNoteId,
      folderId: props.currentFolderId
    })
  } catch (askError) {
    error.value = askError instanceof Error ? askError.message : 'AI 分析失败'
  } finally {
    loading.value = false
  }
}

function handleQuestionKeydown(event: KeyboardEvent): void {
  if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
    event.preventDefault()
    void ask()
  }
}

watch(() => props.visible, (visible) => {
  if (!visible) return
  // 全局入口在空工作区同样可用，此时使用全库范围避免落在不可用的“当前笔记”。
  scope.value = props.currentNoteId ? 'current' : 'all'
  void loadSettings()
}, { immediate: true })
</script>

<template>
  <Transition name="ai-panel">
    <aside v-if="visible" class="ai-assistant-panel" aria-label="AI 笔记助手">
      <header>
        <div>
          <span class="ai-assistant-icon"><Icon icon="tabler:sparkles" /></span>
          <span><strong>AI 笔记助手</strong><small>基于本地笔记回答</small></span>
        </div>
        <button type="button" aria-label="关闭 AI 助手" @click="emit('close')">
          <Icon icon="tabler:x" />
        </button>
      </header>

      <div class="ai-assistant-scroll">
        <section class="ai-scope-section">
          <span class="ai-section-label">分析范围</span>
          <div class="ai-scope-options">
            <button
              v-for="option in scopeOptions"
              :key="option.value"
              type="button"
              :class="{ active: scope === option.value }"
              :aria-pressed="scope === option.value"
              :disabled="option.value === 'current' && !currentNoteId"
              @click="scope = option.value"
            >
              <Icon :icon="option.icon" /><span>{{ option.label }}</span>
            </button>
          </div>
          <p v-if="scope === 'current'" class="ai-scope-hint">
            {{ currentNoteTitle || '尚未打开笔记' }}
          </p>
          <p v-else class="ai-scope-hint">只发送检索命中的有限文本片段，不发送附件和图片。</p>
        </section>

        <section class="ai-question-section">
          <label for="ai-assistant-question">你想从笔记中了解什么？</label>
          <textarea
            id="ai-assistant-question"
            v-model="question"
            rows="4"
            placeholder="例如：总结这些笔记中关于并发处理的方案和注意事项"
            @keydown="handleQuestionKeydown"
          />
          <button class="ai-primary-action" type="button" :disabled="!canAsk" @click="ask">
            <Icon :icon="loading ? 'tabler:loader-2' : 'tabler:sparkles'" :class="{ spinning: loading }" />
            {{ loading ? '正在查找并分析…' : '查找并分析' }}
            <kbd>⌘ Enter</kbd>
          </button>
        </section>

        <p v-if="error" class="ai-assistant-error"><Icon icon="tabler:alert-circle" />{{ error }}</p>

        <section v-if="answer" class="ai-answer-section">
          <div class="ai-answer-heading"><Icon icon="tabler:message-circle-2" /><strong>回答</strong></div>
          <div class="ai-answer-text" v-html="renderedAnswer"></div>
          <div v-if="answer.sources.length" class="ai-source-list">
            <span class="ai-section-label">参考笔记</span>
            <button
              v-for="source in answer.sources"
              :key="source.id"
              type="button"
              @click="emit('openSource', source.noteId)"
            >
              <span class="ai-source-id">{{ source.id }}</span>
              <span><strong>{{ source.title }}</strong><small>{{ source.excerpt }}</small></span>
              <Icon icon="tabler:arrow-up-right" />
            </button>
          </div>
        </section>

        <section class="ai-settings-section">
          <button class="ai-settings-toggle" type="button" @click="settingsOpen = !settingsOpen">
            <span><Icon icon="tabler:settings" /><strong>模型设置</strong></span>
            <span class="ai-settings-state">
              {{ settings.hasApiKey && settings.model ? settings.model : '未配置' }}
              <Icon :icon="settingsOpen ? 'tabler:chevron-up' : 'tabler:chevron-down'" />
            </span>
          </button>
          <form v-if="settingsOpen" class="ai-settings-form" @submit.prevent="saveSettings">
            <label>接口地址<input v-model="settingsDraft.baseUrl" type="url" required placeholder="https://api.openai.com/v1" /></label>
            <label>模型名称<input v-model="settingsDraft.model" required placeholder="填写兼容接口支持的模型" /></label>
            <label>
              API Key
              <input
                v-model="settingsDraft.apiKey"
                type="password"
                :required="!settings.hasApiKey"
                :placeholder="settings.hasApiKey ? '已安全保存，留空表示不修改' : '输入 API Key'"
              />
            </label>
            <p><Icon icon="tabler:shield-lock" />密钥由系统安全存储加密，仅保存在本机。</p>
            <button type="submit" :disabled="settingsLoading">
              {{ settingsLoading ? '保存中…' : '保存设置' }}
            </button>
          </form>
        </section>
      </div>
    </aside>
  </Transition>
</template>

<style scoped>
.ai-assistant-panel { position: absolute; z-index: 90; inset: 0 0 0 auto; display: flex; width: min(var(--overlay-side-panel-width), calc(100% - 24px)); flex-direction: column; border-left: 1px solid var(--line); background: color-mix(in srgb, var(--surface-solid) 97%, transparent); box-shadow: -18px 0 50px rgba(28,51,82,.16); color: var(--ink); backdrop-filter: blur(24px); }
.ai-assistant-panel > header { display: flex; min-height: 70px; align-items: center; justify-content: space-between; border-bottom: 1px solid var(--line); padding: 13px 16px; }
.ai-assistant-panel > header > div { display: flex; align-items: center; gap: 10px; }
.ai-assistant-panel > header span span { display: grid; gap: 2px; }
.ai-assistant-panel > header strong { font-size: var(--overlay-menu-font-size); }
.ai-assistant-panel > header small { color: var(--muted); font-size: var(--overlay-option-font-size); }
.ai-assistant-icon { display: grid; width: 38px; height: 38px; place-items: center; border-radius: 12px; background: linear-gradient(135deg, rgba(50,170,167,.16), rgba(47,128,237,.16)); color: var(--blue); }
.ai-assistant-icon svg { width: 21px; height: 21px; }
.ai-assistant-panel > header > button { display: grid; width: 32px; height: 32px; place-items: center; border: 0; border-radius: 9px; background: var(--panel); color: var(--muted); cursor: pointer; }
.ai-assistant-scroll { display: grid; gap: 14px; overflow-y: auto; padding: 16px; }
.ai-assistant-scroll section { border: 1px solid var(--line); border-radius: var(--overlay-surface-radius); background: var(--panel); }
.ai-scope-section, .ai-question-section, .ai-answer-section { padding: 13px; }
.ai-section-label, .ai-question-section > label { display: block; margin-bottom: 9px; color: var(--muted); font-size: var(--overlay-option-font-size); font-weight: 700; }
.ai-scope-options { display: grid; grid-template-columns: repeat(3, 1fr); gap: 6px; }
.ai-scope-options button { display: grid; min-width: 0; min-height: var(--overlay-option-height); place-items: center; gap: 4px; border: 1px solid var(--line); border-radius: var(--overlay-item-radius); padding: 8px 4px; background: var(--surface-solid); color: var(--muted); cursor: pointer; font-size: var(--overlay-option-font-size); }
.ai-scope-options button svg { width: 17px; height: 17px; }
.ai-scope-options button.active { border-color: rgba(47,128,237,.42); background: rgba(47,128,237,.11); color: var(--blue); }
.ai-scope-options button:disabled { cursor: default; opacity: .4; }
.ai-scope-hint { overflow: hidden; margin: 9px 2px 0; color: var(--muted); font-size: var(--overlay-option-font-size); text-overflow: ellipsis; white-space: nowrap; }
.ai-question-section textarea { width: 100%; resize: vertical; border: 1px solid var(--line); border-radius: var(--overlay-item-radius); outline: 0; padding: 10px 11px; background: var(--surface-solid); color: var(--ink); font: inherit; font-size: var(--overlay-menu-font-size); }
.ai-question-section textarea:focus { border-color: rgba(47,128,237,.55); box-shadow: 0 0 0 3px rgba(47,128,237,.1); }
.ai-primary-action { display: flex; width: 100%; height: var(--overlay-menu-item-height); align-items: center; justify-content: center; gap: 7px; margin-top: 9px; border: 0; border-radius: var(--overlay-item-radius); background: linear-gradient(135deg, var(--teal), var(--blue)); color: #fff; cursor: pointer; font-weight: 700; }
.ai-primary-action:disabled { cursor: default; filter: saturate(.4); opacity: .5; }
.ai-primary-action kbd { display: inline-flex; min-height: 26px; align-items: center; margin-left: auto; margin-right: 8px; border: 1px solid rgba(255,255,255,.3); border-radius: 7px; padding: 0 8px; background: rgba(255,255,255,.13); color: rgba(255,255,255,.92); font-family: inherit; font-size: 12px; font-weight: 750; line-height: 1; white-space: nowrap; }
.spinning { animation: ai-spin .8s linear infinite; }
.ai-assistant-error { display: flex; align-items: flex-start; gap: 7px; margin: 0; border-radius: var(--overlay-item-radius); padding: 9px 10px; background: rgba(203,65,83,.11); color: #cb4153; font-size: var(--overlay-menu-font-size); }
.ai-answer-heading { display: flex; align-items: center; gap: 7px; color: var(--blue); }
.ai-answer-text { margin-top: 10px; overflow-wrap: anywhere; font-size: var(--overlay-menu-font-size); line-height: 1.7; }
.ai-answer-text :deep(:first-child) { margin-top: 0; }
.ai-answer-text :deep(:last-child) { margin-bottom: 0; }
.ai-answer-text :deep(p) { margin: 0 0 9px; }
.ai-answer-text :deep(h1), .ai-answer-text :deep(h2), .ai-answer-text :deep(h3) { margin: 14px 0 7px; color: var(--ink); font-size: 1.08em; line-height: 1.4; }
.ai-answer-text :deep(ul), .ai-answer-text :deep(ol) { margin: 7px 0 10px; padding-left: 22px; }
.ai-answer-text :deep(li + li) { margin-top: 4px; }
.ai-answer-text :deep(blockquote) { margin: 9px 0; border-left: 3px solid rgba(47,128,237,.35); padding: 2px 0 2px 10px; color: var(--muted); }
.ai-answer-text :deep(code) { border-radius: 5px; padding: 2px 5px; background: var(--surface-solid); color: var(--ink); font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; font-size: .92em; }
.ai-answer-text :deep(pre) { overflow-x: auto; border: 1px solid var(--line); border-radius: 9px; padding: 10px; background: var(--surface-solid); }
.ai-answer-text :deep(pre code) { padding: 0; background: transparent; }
.ai-answer-text :deep(a) { color: var(--blue); text-decoration: underline; text-underline-offset: 2px; }
.ai-source-list { display: grid; gap: 6px; margin-top: 14px; padding-top: 12px; border-top: 1px solid var(--line); }
.ai-source-list > button { display: grid; grid-template-columns: 30px minmax(0,1fr) 16px; align-items: center; gap: 8px; border: 0; border-radius: 9px; padding: 8px; background: var(--surface-solid); color: var(--ink); text-align: left; cursor: pointer; }
.ai-source-list > button:hover { background: rgba(47,128,237,.09); }
.ai-source-list > button > span:nth-child(2) { min-width: 0; }
.ai-source-list strong, .ai-source-list small { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ai-source-list strong { font-size: var(--overlay-option-font-size); }
.ai-source-list small { margin-top: 2px; color: var(--muted); font-size: var(--overlay-option-font-size); }
.ai-source-id { display: grid; height: 25px; place-items: center; border-radius: 7px; background: rgba(47,128,237,.12); color: var(--blue); font-size: var(--overlay-option-font-size); font-weight: 800; }
.ai-source-list > button > svg { color: var(--muted); }
.ai-settings-section { overflow: hidden; }
.ai-settings-toggle { display: flex; width: 100%; min-height: 46px; align-items: center; justify-content: space-between; border: 0; padding: 0 12px; background: transparent; color: var(--ink); cursor: pointer; }
.ai-settings-toggle > span { display: flex; align-items: center; gap: 7px; }
.ai-settings-toggle svg { color: var(--muted); }
.ai-settings-state { max-width: 180px; color: var(--muted); font-size: var(--overlay-option-font-size); }
.ai-settings-form { display: grid; gap: 10px; border-top: 1px solid var(--line); padding: 12px; }
.ai-settings-form label { display: grid; gap: 5px; color: var(--muted); font-size: var(--overlay-option-font-size); }
.ai-settings-form input { height: var(--overlay-search-height); border: 1px solid var(--line); border-radius: var(--overlay-item-radius); outline: 0; padding: 0 9px; background: var(--surface-solid); color: var(--ink); }
.ai-settings-form input:focus { border-color: rgba(47,128,237,.55); }
.ai-settings-form p { display: flex; align-items: center; gap: 5px; margin: 0; color: var(--muted); font-size: var(--overlay-option-font-size); }
.ai-settings-form button { height: var(--overlay-control-height); border: 0; border-radius: var(--overlay-item-radius); background: rgba(47,128,237,.13); color: var(--blue); cursor: pointer; font-weight: 700; }
.ai-panel-enter-active, .ai-panel-leave-active { transition: transform .2s ease, opacity .2s ease; }
.ai-panel-enter-from, .ai-panel-leave-to { transform: translateX(24px); opacity: 0; }
@keyframes ai-spin { to { transform: rotate(360deg); } }
</style>
