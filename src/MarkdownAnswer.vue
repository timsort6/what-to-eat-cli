<script setup lang="ts">
import { onBeforeUnmount, ref, watch } from 'vue'
import { exceedsMarkdownLimit, renderMarkdown } from './markdown'
import { createThrottle } from './markdownThrottle'

// text 为完整累计正文；streaming 为 true 时节流渲染，false（完成/取消/失败）时立即刷新。
const props = defineProps<{ text: string; streaming: boolean }>()
const emit = defineEmits<{ failed: [reason: string] }>()

const html = ref('')
const failure = ref('')
const body = ref<HTMLElement | null>(null)
// 同一文本会话（直到文本重置）只通知一次失败，避免流式超限期间每个节流窗口重复 emit。
let reported = false

function render(): void {
  try {
    // 每次都整体重新解析并消毒累计文本，绝不拼接已消毒片段。
    html.value = renderMarkdown(props.text)
    failure.value = ''
  } catch {
    html.value = ''
    failure.value = exceedsMarkdownLimit(props.text)
      ? '回答内容超过 64000 字符上限，无法安全显示，本次回答未完成。'
      : '回答渲染失败，本次回答未完成。'
    if (!reported) emit('failed', failure.value)
    reported = true
  }
}

const throttle = createThrottle(render, 50)
let seen = ''

watch(() => [props.text, props.streaming] as const, ([text, streaming]) => {
  // 文本不是上一段的延续（重置/新一轮）：丢弃旧的待渲染并开始新的失败通知会话。
  if (!text.startsWith(seen)) {
    throttle.cancel()
    reported = false
  }
  if (!streaming) throttle.flush()
  else throttle.push()
  seen = text
}, { immediate: true })

// 局部横向滚动区域需可键盘聚焦；在 DOM 上设置属性，不改动消毒后的 HTML 字符串。
watch(html, () => {
  body.value?.querySelectorAll('pre, table').forEach((element) => element.setAttribute('tabindex', '0'))
}, { flush: 'post', immediate: true })

onBeforeUnmount(() => throttle.cancel())
</script>

<template>
  <div class="markdown-answer" :aria-busy="streaming">
    <p v-if="failure" class="message error-message" role="alert">{{ failure }}</p>
    <div v-else ref="body" class="markdown-body" v-html="html"></div>
  </div>
</template>

<style>
.markdown-answer { min-width: 0; max-width: 100%; }
.markdown-body { min-width: 0; color: var(--text-primary); font-size: var(--text-base); line-height: 1.8; overflow-wrap: anywhere; }
.markdown-body > :first-child { margin-top: 0; }
.markdown-body > :last-child { margin-bottom: 0; }
.markdown-body :is(p, ul, ol, blockquote, pre, table, hr) { margin: 0 0 var(--space-3); }
.markdown-body :is(h1, h2, h3, h4, h5, h6) { margin: var(--space-5) 0 var(--space-2); font-weight: 700; line-height: 1.4; }
.markdown-body h1 { font-size: var(--text-heading); }
.markdown-body h2 { font-size: 1.25rem; }
.markdown-body h3 { font-size: 1.125rem; }
.markdown-body :is(h4, h5, h6) { font-size: var(--text-base); }
.markdown-body :is(ul, ol) { padding-left: var(--space-6); }
.markdown-body li + li { margin-top: var(--space-1); }
.markdown-body li > :is(ul, ol) { margin: var(--space-1) 0 0; }
.markdown-body blockquote { padding: var(--space-2) var(--space-4); border-radius: var(--radius-sm); color: var(--text-secondary); background: var(--surface-elevated); }
.markdown-body hr { border: 0; border-top: 1px solid var(--border-default); }
.markdown-body code { padding: 0 var(--space-1); border-radius: 4px; background: var(--border-subtle); font-family: ui-monospace, Consolas, monospace; font-size: .875em; }
.markdown-body pre { max-width: 100%; overflow-x: auto; padding: var(--space-3) var(--space-4); border: 1px solid var(--border-subtle); border-radius: var(--radius-sm); background: var(--surface-elevated); line-height: 1.6; }
.markdown-body pre code { padding: 0; background: none; white-space: pre; overflow-wrap: normal; }
/* display:block 让表格在自身盒内横向滚动，不撑宽页面。 */
.markdown-body table { display: block; max-width: 100%; overflow-x: auto; border-collapse: collapse; font-size: var(--text-sm); }
.markdown-body :is(th, td) { min-width: 6em; padding: var(--space-2) var(--space-3); border: 1px solid var(--border-default); text-align: left; vertical-align: top; overflow-wrap: normal; }
.markdown-body th { background: var(--surface-elevated); font-weight: 600; }
.markdown-body a { color: var(--accent-primary); text-decoration: underline; text-underline-offset: 2px; overflow-wrap: anywhere; }
.markdown-body a:hover { color: var(--accent-hover); }
.markdown-body :is(a, pre, table):focus-visible { outline: 3px solid var(--focus); outline-offset: 2px; }
</style>
