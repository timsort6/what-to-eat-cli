<script setup lang="ts">
import { computed, nextTick, onUnmounted, ref, watch } from 'vue'
import { streamChat } from './api'
import { ApiError, buildChatMessages, isCurrentGeneration, messageFrom, validLocation } from './protocol'
import type { ChatDone, ChatEvent, ChatRequest, LocationChoice, Place } from './protocol'
import MarkdownAnswer from './MarkdownAnswer.vue'
import NegotiationPanel from './NegotiationPanel.vue'
import PlaceCard from './PlaceCard.vue'
import PreferencesPanel from './PreferencesPanel.vue'
import {
  DEFAULT_PREFERENCE_FORM, adoptPreferences, applyNegotiationOption, commitPreferenceTurn, describeLocation, describePreferences, interpretationNote,
  isNegotiationCurrent, locationKey, preferencesFromForm, shortfallNote,
} from './recommendation'
import type { Negotiation, PreferenceForm, PreferenceTurn, Preferences, RecommendationSelection } from './recommendation'

const props = defineProps<{ location: LocationChoice | null; signal: AbortSignal }>()
const emit = defineEmits<{ expired: [] }>()
const query = ref('')
const queryInput = ref<HTMLTextAreaElement | null>(null)
const answer = ref('')
const places = ref<readonly Place[]>([])
const busy = ref(false)
const error = ref('')
const status = ref('')
const usedLocation = ref('')
const history = ref<readonly PreferenceTurn[]>([])
const preferenceForm = ref<PreferenceForm>(DEFAULT_PREFERENCE_FORM)
const usedPreferences = ref<Preferences | null>(null)
// 待选方案：decision 事件到达即展示但禁用，完整成功 done 后才启用；任何失效条件都清空且不可恢复。
const negotiation = ref<Negotiation | null>(null)
const negotiationEnabled = ref(false)
const renderFailed = ref(false)
const preferenceResult = computed(() => preferencesFromForm(preferenceForm.value))
const preferenceErrors = computed(() => preferenceResult.value.ok ? {} : preferenceResult.value.errors)
const preferenceSummary = computed(() => preferenceResult.value.ok ? describePreferences(preferenceResult.value.preferences) : '条件有误，修正后才能提交')
let currentGeneration = 0
let activeController: AbortController | null = null

type ActiveRequest = Readonly<{ generation: number; controller: AbortController }>

function isActive(request: ActiveRequest): boolean {
  return activeController === request.controller
    && isCurrentGeneration(request.generation, currentGeneration, request.controller.signal)
    && !props.signal.aborted
}

function dropNegotiation(): void {
  negotiation.value = null
  negotiationEnabled.value = false
}

function invalidateRequest(): void {
  currentGeneration++
  activeController?.abort()
  activeController = null
  busy.value = false
  dropNegotiation()
}

function handleParentAbort(): void {
  invalidateRequest()
}

props.signal.addEventListener('abort', handleParentAbort)
onUnmounted(() => {
  props.signal.removeEventListener('abort', handleParentAbort)
  invalidateRequest()
})

const locationLabel = computed(() => describeLocation(props.location))
// 本轮结果的确定性说明：原话品类来源、ready 时的数量缺口；新请求或新对话即清空。
const resultNotes = ref<readonly string[]>([])
// 摘要按“ · ”分段整体换行（同 PreferencesPanel），避免“人均不/限”式拆词。
const usedSummaryParts = computed(() => usedPreferences.value ? describePreferences(usedPreferences.value).split(' · ') : [])
const hasLocation = computed(() => {
  if (!props.location) return false
  return validLocation(props.location.kind === 'address' ? props.location.address.location : props.location.location)
})

watch(() => locationKey(props.location), (key) => {
  if (negotiation.value && negotiation.value.locationKey !== key) {
    dropNegotiation()
    status.value = '位置已变更，旧方案已失效；请重新提交需求'
  }
})
watch(preferenceResult, (result) => {
  const current = negotiation.value
  if (current && !isNegotiationCurrent(current, { generation: current.generation, locationKey: current.locationKey, preferences: result.ok ? result.preferences : null })) {
    dropNegotiation()
    status.value = '推荐条件已修改，旧方案已失效'
  }
})
const optionAvailability = computed(() => {
  const current = negotiation.value
  if (!current) return {}
  return Object.fromEntries(current.decision.options.map((option) => {
    try {
      applyNegotiationOption(option.option_id, { preferences: current.preferences, options: current.decision.options }, preferenceForm.value)
      return [option.option_id, true]
    } catch {
      return [option.option_id, false]
    }
  }))
})

function receive(event: ChatEvent, request: ActiveRequest, key: string, onDone: (data: ChatDone) => void): void {
  if (!isActive(request)) return
  switch (event.kind) {
    case 'decision':
      // 位置在 decision 到达前已切换：方案按旧位置生成，不再建立（done 时提示失效）。
      if (event.decision.status === 'needs_choice' && usedPreferences.value && key === locationKey(props.location)) {
        negotiation.value = { generation: request.generation, locationKey: key, preferences: usedPreferences.value, decision: event.decision }
      }
      return
    case 'delta': answer.value += event.text; return
    case 'done':
      answer.value = event.data.answer_text
      places.value = event.data.places
      onDone(event.data)
      return
    case 'error': throw new ApiError(event.message)
  }
}

async function run(userMessage: string, preferences: Preferences, selection?: RecommendationSelection): Promise<boolean> {
  if (busy.value || !props.location || !hasLocation.value) return false
  const context = props.location
  const key = locationKey(context)
  const request: ActiveRequest = { generation: ++currentGeneration, controller: new AbortController() }
  activeController = request.controller
  dropNegotiation()
  const completion: { data: ChatDone | null } = { data: null }
  const messages = buildChatMessages(history.value, userMessage)
  const base: ChatRequest = { messages, preferences, ...(selection ? { selection } : {}) }
  const payload: ChatRequest = context.kind === 'address' ? { ...base, address_id: context.address.id } : { ...base, location: context.location }
  busy.value = true
  error.value = ''
  answer.value = ''
  places.value = []
  resultNotes.value = []
  renderFailed.value = false
  status.value = '正在生成推荐…'
  usedLocation.value = locationLabel.value
  usedPreferences.value = preferences
  try {
    await streamChat(payload, (event) => receive(event, request, key, (data) => { completion.data = data }), request.controller.signal)
    if (!isActive(request)) return false
    const completed = completion.data
    if (!completed) throw new ApiError('推荐未完整结束，请重试')
    // 等正文按完成态刷新后再判定：渲染失败不能当作完成轮次。
    busy.value = false
    await nextTick()
    if (!isActive(request)) return false
    if (renderFailed.value) {
      dropNegotiation()
      status.value = '回答未能安全显示，本轮未加入对话记录；可重新提交需求'
      return false
    }
    const recommendation = completed.recommendation
    const adopted = adoptPreferences(preferences, recommendation?.preferences)
    history.value = commitPreferenceTurn(history.value, { user: userMessage, assistant: completed.answer_text, completed: true }, adopted)
    resultNotes.value = [interpretationNote(recommendation?.decision), shortfallNote(recommendation?.status, completed.places.length, adopted.target_count)].filter(Boolean)
    if (adopted !== preferences) {
      // 原话品类被采纳：方案、本次条件与选单同步为同一完整条件，避免条件监听误判“已修改”，下一轮 previous_preferences 即此值。
      if (negotiation.value?.generation === request.generation) negotiation.value = { ...negotiation.value, preferences: adopted }
      usedPreferences.value = adopted
      preferenceForm.value = { ...preferenceForm.value, food_requirement: adopted.food_requirement }
    }
    // 旧服务端无 recommendation：按旧版文本结果显示，不虚构可点击方案。
    if (completed.recommendation?.status === 'needs_choice' && negotiation.value?.generation === request.generation && key === locationKey(props.location)) {
      negotiationEnabled.value = true
      status.value = '需要你选择一个方案，或保持原条件继续描述'
    } else if (completed.recommendation?.status === 'needs_choice') {
      dropNegotiation()
      status.value = '位置或条件已在生成期间变化，本次方案已失效；请重新提交需求'
    } else {
      dropNegotiation()
      status.value = !completed.answer_text.trim() && !completed.places.length
        ? '本次没有返回推荐内容，请调整需求后再试。' : '推荐完成'
    }
    return true
  } catch (failure) {
    if (!isActive(request)) return false
    dropNegotiation()
    if (failure instanceof ApiError && failure.status === 401) {
      emit('expired')
      return false
    }
    error.value = failure instanceof TypeError ? '网络连接中断，请检查连接后重试；已收到的内容已保留。' : messageFrom(failure)
    status.value = '推荐未完成；可重新提交需求'
    return false
  } finally {
    if (isActive(request)) {
      activeController = null
      busy.value = false
    }
  }
}

async function ask(): Promise<void> {
  const checked = preferenceResult.value
  if (busy.value || !query.value.trim() || !checked.ok) return
  // 自由文本（含“好的”等）只按当前选单条件提交，从不附带或推断方案选择。
  if (await run(query.value.trim(), checked.preferences)) query.value = ''
}

async function choose(optionID: string): Promise<void> {
  const current = negotiation.value
  const checked = preferenceResult.value
  if (busy.value || !current || !negotiationEnabled.value || !checked.ok
    || !isNegotiationCurrent(current, { generation: currentGeneration, locationKey: locationKey(props.location), preferences: checked.preferences })) return
  const option = current.decision.options.find((item) => item.option_id === optionID)
  let applied: ReturnType<typeof applyNegotiationOption>
  try {
    applied = applyNegotiationOption(optionID, { preferences: current.preferences, options: current.decision.options }, preferenceForm.value)
  } catch {
    error.value = '该方案无法应用到当前推荐条件，请继续用文字描述需求'
    return
  }
  // 先撤下旧方案再同步选单，避免条件监听误报“已修改”。
  dropNegotiation()
  preferenceForm.value = applied.form
  await run(`我选择方案：${option?.label ?? optionID}`, applied.request.preferences, applied.request.selection)
}

async function keepConditions(): Promise<void> {
  if (!negotiation.value) return
  dropNegotiation()
  status.value = '已保留原条件，未扩大搜索；可继续用文字描述需求'
  await nextTick()
  queryInput.value?.focus()
}

function cancel(): void {
  if (!busy.value) return
  invalidateRequest()
  status.value = '本次推荐已取消，未加入对话记录'
}

function resetConversation(): void {
  invalidateRequest()
  history.value = []
  query.value = ''
  answer.value = ''
  places.value = []
  resultNotes.value = []
  error.value = ''
  status.value = '已开始新对话'
  usedLocation.value = ''
  usedPreferences.value = null
  preferenceForm.value = DEFAULT_PREFERENCE_FORM
}
</script>

<template>
  <section class="content-column">
    <div class="content-header"><div><p class="eyebrow accent-text">第二步 · 描述需求</p><h2>今天，想吃点什么？</h2><p class="location-line">{{ locationLabel }}</p></div><button class="text-button" type="button" @click="resetConversation">新对话</button></div>
    <form class="ask-panel" @submit.prevent="ask">
      <label class="field"><span>你的需求</span><textarea ref="queryInput" v-model="query" required :disabled="busy" rows="4" maxlength="500" placeholder="比如：想吃点热的，预算 50 元以内，适合一个人…"></textarea></label>
      <PreferencesPanel v-model="preferenceForm" :disabled="busy" :errors="preferenceErrors" :summary="preferenceSummary" />
      <div class="ask-actions"><span class="hint">{{ hasLocation ? '根据当前选定位置推荐' : '请先获取当前位置或选择有效的地址簿地址' }}</span><button v-if="busy" class="button button-quiet" type="button" @click="cancel">取消</button><button class="button button-primary" type="submit" :disabled="busy || !hasLocation || !query.trim() || !preferenceResult.ok">{{ busy ? '寻找中…' : '开始推荐 →' }}</button></div>
    </form>
    <p v-if="error" class="message error-message content-message" role="alert">{{ error }}</p>
    <section class="result-section" aria-label="推荐结果">
      <div class="result-heading"><div><p class="eyebrow">第三步 · 推荐结果</p><h2>附近的回答</h2></div><span v-if="busy" class="streaming-label"><i></i>实时生成中</span></div>
      <p v-if="usedLocation" class="result-status">本次推荐位置：{{ usedLocation }}</p>
      <p v-if="usedPreferences" class="result-status">本次提交条件：<template v-for="(part, index) in usedSummaryParts" :key="index">{{ index ? ' ' : '' }}<span class="keep-together">{{ part }}{{ index < usedSummaryParts.length - 1 ? ' ·' : '' }}</span></template></p>
      <p v-for="note in resultNotes" :key="note" class="result-status result-note">{{ note }}</p>
      <div v-if="answer || busy" class="answer-block" :aria-busy="busy">
        <MarkdownAnswer v-if="answer" :text="answer" :streaming="busy" @failed="renderFailed = true" />
        <p v-else>正在等待第一段推荐…</p>
      </div>
      <NegotiationPanel v-if="negotiation" :decision="negotiation.decision" :preferences="negotiation.preferences" :enabled="negotiationEnabled && !busy"
        :available="optionAvailability" @choose="choose" @keep="keepConditions" />
      <div v-if="places.length" class="places-grid"><PlaceCard v-for="(place, index) in places" :key="`${place.candidate_key}-${index}`" :place="place" :index="index" :preferences="usedPreferences" /></div>
      <div v-if="!answer && !places.length && !busy" class="result-empty"><p>{{ error ? '请检查错误提示后重新提交' : '提交需求后，这里会逐步显示推荐' }}</p></div>
      <p v-if="status" class="result-status" role="status">{{ status }}</p>
    </section>
  </section>
</template>
