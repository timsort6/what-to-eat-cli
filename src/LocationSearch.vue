<script setup lang="ts">
import { onUnmounted, ref, shallowRef, watch } from 'vue'
import { searchLocations } from './api'
import { createLocationSearch } from './locationSearch'
import type { SearchState } from './locationSearch'
import type { LocationChoice } from './protocol'

const props = defineProps<{ signal: AbortSignal; resetKey: number }>()
const emit = defineEmits<{ select: [choice: Extract<LocationChoice, { kind: 'coordinates' }>]; editing: []; expired: [] }>()
const query = ref('')
const city = ref('')
const input = ref<HTMLInputElement | null>(null)
const results = ref<HTMLDivElement | null>(null)
const status = ref<HTMLParagraphElement | null>(null)
const state = shallowRef<SearchState>({ phase: 'idle', items: [], selected: null, error: '', invalidFields: [] })
const search = createLocationSearch({ search: searchLocations, changed: (next) => { state.value = next },
  confirmed: (choice) => { emit('select', choice); input.value?.focus() }, expired: () => emit('expired') }, props.signal)

function update(): void {
  emit('editing')
  search.update({ query: query.value, city: city.value })
}

function retry(): void {
  input.value?.focus()
  update()
}

function cancel(clear = false): void {
  if (clear) query.value = ''
  search.cancel()
  input.value?.focus()
}

function focusResult(index: number): void {
  const buttons = results.value?.querySelectorAll('button')
  if (buttons?.length) buttons[(index + buttons.length) % buttons.length]?.focus()
}

function navigate(event: KeyboardEvent, index: number): void {
  if (event.isComposing) return
  switch (event.key) {
    case 'ArrowDown': event.preventDefault(); focusResult(index + 1); break
    case 'ArrowUp': event.preventDefault(); focusResult(index - 1); break
    case 'Home': event.preventDefault(); focusResult(0); break
    case 'End': event.preventDefault(); focusResult(-1); break
  }
}

watch(() => props.resetKey, () => search.cancel(), { flush: 'sync' })
// 侧栏可内滚动：出错时把提示滚进可视区，焦点仍留在输入框（两者同屏可见）。
watch(() => state.value.error, error => { if (error) status.value?.scrollIntoView({ block: 'nearest' }) }, { flush: 'post' })
onUnmounted(search.dispose)
</script>

<template>
  <section class="location-search" aria-label="搜索地点" @keydown.esc.prevent.stop="cancel()">
    <label class="field"><span>搜索地点</span><input ref="input" v-model="query" type="search" autocomplete="off" placeholder="地点名或详细地址" aria-describedby="location-search-status" :aria-invalid="state.invalidFields.includes('query')" @input="update" @keydown.down.prevent="focusResult(0)" @keydown.up.prevent="focusResult(-1)" /></label>
    <label class="field"><span>城市（选填）</span><input v-model="city" autocomplete="address-level2" placeholder="例如：北京" :aria-invalid="state.invalidFields.includes('city')" aria-describedby="location-search-status" @input="update" /></label>
    <div class="search-actions">
      <button class="button button-quiet" type="button" :disabled="!query && !state.error" @click="cancel(true)">清空搜索</button>
      <button class="button button-quiet" type="button" :disabled="state.phase !== 'error' || state.invalidFields.length > 0" @click="retry">重新搜索</button>
    </div>
    <button class="button button-primary wide-button" type="button" :disabled="!state.selected" @click="search.confirm">使用此地点</button>
    <div :aria-busy="state.phase === 'loading' || state.phase === 'waiting'">
      <p id="location-search-status" ref="status" class="message" :class="{ 'error-message': state.error }" :role="state.error ? 'alert' : 'status'">
        {{ state.error || (state.phase === 'loading' || state.phase === 'waiting' ? '正在搜索，候选将在下方显示…' : state.phase === 'empty' ? '本次检索未找到，请换个关键词或城市' : state.items.length ? '选择下方候选后，使用上方按钮确认地点' : '输入地点名或地址，下方将显示候选') }}
      </p>
      <div v-if="state.items.length" ref="results" class="address-list" role="group" aria-label="地点候选">
        <button v-for="(candidate, index) in state.items" :key="`${candidate.id}-${index}`" class="address-row" :class="{ selected: state.selected === candidate }" :aria-pressed="state.selected === candidate" type="button" @click="search.select(index)" @keydown="navigate($event, index)">
          <span class="address-copy"><strong>{{ candidate.name }}</strong><small>{{ candidate.city || '城市未提供' }}</small><small>{{ candidate.address || '暂无详细地址' }}</small></span>
          <span v-if="state.selected === candidate" class="checkmark" aria-label="已选择">✓</span>
        </button>
      </div>
    </div>
  </section>
</template>

<style scoped>
.location-search { --search-primary: var(--text-base); --search-secondary: var(--text-sm); display: grid; gap: var(--space-3); margin-top: var(--space-6); }
.search-actions { display: flex; justify-content: space-between; gap: var(--space-2); }
.location-search .field > span, .location-search .message, .address-copy small { font-size: var(--search-secondary); }
.location-search input, .location-search .button, .address-copy strong { font-size: var(--search-primary); }
.location-search input { border-color: var(--text-secondary); }
.location-search input:hover:not(:disabled) { border-color: var(--text-primary); }
.address-list { gap: var(--space-2); }
.address-copy { user-select: text; }
.message { min-block-size: calc(3lh + var(--space-6)); }
</style>
