<script setup lang="ts">
import { computed, ref } from 'vue'
import { streamChat } from './api'
import { ApiError, messageFrom, validLocation } from './protocol'
import type { ChatEvent, ChatRequest, LocationChoice, Place } from './protocol'

const props = defineProps<{ location: LocationChoice | null; signal: AbortSignal }>()
const emit = defineEmits<{ expired: [] }>()
const query = ref('')
const answer = ref('')
const places = ref<readonly Place[]>([])
const busy = ref(false)
const error = ref('')
const status = ref('')
const usedLocation = ref('')

const locationLabel = computed(() => {
  if (!props.location) return '尚未选择位置'
  switch (props.location.kind) {
    case 'address': return props.location.address.description
    case 'coordinates': return `当前位置 · ${props.location.location}`
  }
})
const hasLocation = computed(() => {
  if (!props.location) return false
  return validLocation(props.location.kind === 'address' ? props.location.address.location : props.location.location)
})

function receive(event: ChatEvent): void {
  if (props.signal.aborted) return
  switch (event.kind) {
    case 'delta': answer.value += event.text; return
    case 'done': answer.value = event.data.answer_text; places.value = event.data.places; return
    case 'error': throw new ApiError(event.message)
  }
}

async function ask(): Promise<void> {
  if (busy.value || !props.location || !hasLocation.value || !query.value.trim()) return
  const context = props.location
  const messages = [{ role: 'user', content: query.value.trim() }] as const
  const payload: ChatRequest = context.kind === 'address'
    ? { messages, address_id: context.address.id } : { messages, location: context.location }
  busy.value = true
  error.value = ''
  answer.value = ''
  places.value = []
  status.value = '正在生成推荐…'
  usedLocation.value = locationLabel.value
  try {
    await streamChat(payload, receive, props.signal)
    if (!answer.value.trim() && !places.value.length) status.value = '本次没有返回推荐内容，请调整需求后再试。'
    else status.value = '推荐完成'
  } catch (failure) {
    if (props.signal.aborted) return
    if (failure instanceof ApiError && failure.status === 401) emit('expired')
    else error.value = failure instanceof TypeError ? '网络连接中断，请检查连接后重试；已收到的内容已保留。' : messageFrom(failure)
    status.value = '推荐未完成；可重新提交需求'
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <section class="content-column">
    <div class="content-header"><div><p class="eyebrow accent-text">第二步 · 描述需求</p><h2>今天，想吃点什么？</h2><p class="location-line">{{ locationLabel }}</p></div></div>
    <form class="ask-panel" @submit.prevent="ask">
      <label class="field"><span>你的需求</span><textarea v-model="query" required :disabled="busy" rows="4" maxlength="500" placeholder="比如：想吃点热的，预算 50 元以内，适合一个人…"></textarea></label>
      <div class="ask-actions"><span class="hint">{{ hasLocation ? '根据当前选定位置推荐' : '请先获取当前位置或选择有效的地址簿地址' }}</span><button class="button button-primary" type="submit" :disabled="busy || !hasLocation || !query.trim()">{{ busy ? '寻找中…' : '开始推荐 →' }}</button></div>
    </form>
    <p v-if="error" class="message error-message content-message" role="alert">{{ error }}</p>
    <section class="result-section" aria-label="推荐结果">
      <div class="result-heading"><div><p class="eyebrow">第三步 · 推荐结果</p><h2>附近的回答</h2></div><span v-if="busy" class="streaming-label"><i></i>实时生成中</span></div>
      <p v-if="usedLocation" class="result-status">本次推荐位置：{{ usedLocation }}</p>
      <div v-if="answer || busy" class="answer-block" :aria-busy="busy"><p>{{ answer || '正在等待第一段推荐…' }}<span v-if="busy" class="cursor" aria-hidden="true"></span></p></div>
      <div v-if="places.length" class="places-grid"><article v-for="(place, index) in places" :key="`${place.id}-${index}`" class="place-card"><div class="place-index">{{ String(index + 1).padStart(2, '0') }}</div><div><h3>{{ place.name || '附近好店' }}</h3><p>{{ place.address || '暂无详细地址' }}</p><small v-if="place.distance">距离 {{ place.distance }} 米{{ place.type ? ` · ${place.type}` : '' }}</small></div></article></div>
      <div v-if="!answer && !places.length && !busy" class="result-empty"><p>{{ error ? '请检查错误提示后重新提交' : '提交需求后，这里会逐步显示推荐' }}</p></div>
      <p v-if="status" class="result-status" role="status">{{ status }}</p>
    </section>
  </section>
</template>
