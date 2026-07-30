<script setup lang="ts">
import { computed } from 'vue'
import { formatNoteSearchExcerpt } from '../utils/note-workspace'

const props = defineProps<{ content: string, keyword: string }>()

/**
 * 将摘要拆分为普通文本与搜索命中片段。
 *
 * :param text: 待拆分摘要。
 * :param keyword: 原始搜索词。
 * :return: 可安全渲染的文本片段。
 */
function splitSearchText(text: string, keyword: string): Array<{ text: string, matched: boolean }> {
  const normalizedKeyword = keyword.trim()
  if (!normalizedKeyword) return [{ text, matched: false }]
  const parts: Array<{ text: string, matched: boolean }> = []
  const lowerText = text.toLocaleLowerCase()
  const lowerKeyword = normalizedKeyword.toLocaleLowerCase()
  let start = 0
  let index = lowerText.indexOf(lowerKeyword)
  while (index >= 0) {
    if (index > start) parts.push({ text: text.slice(start, index), matched: false })
    parts.push({ text: text.slice(index, index + normalizedKeyword.length), matched: true })
    start = index + normalizedKeyword.length
    index = lowerText.indexOf(lowerKeyword, start)
  }
  if (start < text.length) parts.push({ text: text.slice(start), matched: false })
  return parts.length ? parts : [{ text, matched: false }]
}

const parts = computed(() => splitSearchText(
  formatNoteSearchExcerpt({ content: props.content }, props.keyword),
  props.keyword
))
</script>

<template>
  <span class="search-excerpt">
    <template v-for="(part, index) in parts" :key="index">
      <mark v-if="part.matched">{{ part.text }}</mark>
      <template v-else>{{ part.text }}</template>
    </template>
  </span>
</template>
