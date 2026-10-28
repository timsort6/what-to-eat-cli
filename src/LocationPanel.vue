<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref } from 'vue'
import AddressCreate from './AddressCreate.vue'
import LocationSearch from './LocationSearch.vue'
import { listAddresses } from './api'
import { wgs84ToGcj02 } from './coordinates'
import { ApiError, messageFrom, validLocation } from './protocol'
import type { Address, LocationChoice, SavableChoice } from './protocol'

const props = defineProps<{ signal: AbortSignal }>()
const emit = defineEmits<{ select: [location: LocationChoice | null]; expired: [] }>()
const addresses = ref<readonly Address[]>([])
const selection = ref<LocationChoice | null>(null)
const loading = ref(false)
const locating = ref(false)
const error = ref('')
const geoError = ref('')
let locationAttempt = 0
const searchReset = ref(0)
const currentLocation = computed(() => selection.value?.kind === 'coordinates' ? selection.value.location : '')
const currentName = computed(() => selection.value?.kind === 'coordinates' ? selection.value.name : '')
const currentAddress = computed(() => selection.value?.kind === 'coordinates' ? selection.value.address : '')

const creating = ref(false)
const saveNotice = ref('')
const createEntry = ref<HTMLButtonElement | null>(null)

function stopLocating(): void {
  locationAttempt++
  locating.value = false
  saveNotice.value = ''
}

function openCreate(): void {
  saveNotice.value = ''
  creating.value = true
}

async function closeCreate(): Promise<void> {
  creating.value = false
  await nextTick()
  createEntry.value?.focus()
}

async function saved(address: Address, from: SavableChoice): Promise<void> {
  creating.value = false
  // 在途刷新可能早于写库读出旧列表，等它结束后再刷新一次，确保列表含新地址。
  await loadTask
  await load()
  if (props.signal.aborted) return
  // 保存或刷新期间若已切换位置，只刷新地址簿，不把旧请求结果当作当前选择。
  const current = selection.value === from
  if (current) choose(addresses.value.find((item) => item.id === address.id) ?? address)
  saveNotice.value = current ? `已保存为地址「${address.label}」并选中` : `已保存地址「${address.label}」，当前位置已切换，选择保持不变`
  await nextTick()
  createEntry.value?.focus()
}

function chooseSearch(choice: Extract<LocationChoice, { kind: 'coordinates' }>): void {
  stopLocating()
  selection.value = choice
  geoError.value = ''
  emit('select', choice)
}

let loadTask: Promise<void> | null = null

// 已有刷新在途时复用同一次请求。
function load(): Promise<void> {
  loadTask ??= readAddresses().finally(() => { loadTask = null })
  return loadTask
}

async function readAddresses(): Promise<void> {
  error.value = ''
  loading.value = true
  try {
    const data = await listAddresses(props.signal)
    if (props.signal.aborted) return
    addresses.value = data
    if (!selection.value && locationAttempt === 0) {
      const valid = data.filter((item) => validLocation(item.location))
      const chosen = valid.find((item) => item.is_default) ?? valid[0]
      if (chosen) choose(chosen)
    }
  } catch (failure) {
    if (props.signal.aborted) return
    if (failure instanceof ApiError && failure.status === 401) emit('expired')
    else error.value = messageFrom(failure, '地址簿加载失败，请重试或获取当前位置')
  } finally {
    loading.value = false
  }
}

function choose(address: Address): void {
  if (!validLocation(address.location)) return
  stopLocating()
  searchReset.value++
  selection.value = { kind: 'address', address }
  geoError.value = ''
  emit('select', selection.value)
}

function locate(): void {
  if (locating.value) return
  searchReset.value++
  const attempt = ++locationAttempt
  geoError.value = ''
  saveNotice.value = ''
  if (!window.isSecureContext || !navigator.geolocation) {
    geoError.value = '定位需要 HTTPS 或 localhost。请从下方地址簿选择，或用安全地址重新打开页面。'
    return
  }
  locating.value = true
  navigator.geolocation.getCurrentPosition((position) => {
    if (props.signal.aborted || attempt !== locationAttempt) return
    locating.value = false
    const location = wgs84ToGcj02(position.coords.longitude, position.coords.latitude)
    if (!validLocation(location)) {
      geoError.value = '定位返回了无效坐标，请重试或从下方地址簿选择。'
      return
    }
    selection.value = { kind: 'coordinates', location }
    emit('select', selection.value)
  }, (failure) => {
    if (props.signal.aborted || attempt !== locationAttempt) return
    locating.value = false
    const reason = failure.code === 1 ? '定位权限被拒绝' : failure.code === 3 ? '定位超时' : '暂时无法获取位置'
    geoError.value = `${reason}。可在浏览器站点设置中授权后重试，或从下方地址簿选择。`
  }, { enableHighAccuracy: true, timeout: 10000, maximumAge: 60000 })
}

onMounted(load)
onUnmounted(stopLocating)
</script>

<template>
  <aside class="sidebar" aria-label="推荐位置">
    <div class="section-heading"><div><p class="eyebrow">第一步</p><h2>你在哪里？</h2></div><span class="step-number">01</span></div>
    <button class="location-button" type="button" :disabled="locating" @click="locate">{{ locating ? '正在获取位置…' : '获取当前位置' }}</button>
    <p v-if="currentLocation" class="location-confirm" role="status">{{ currentName ? `已使用：${currentName}` : '已使用当前位置' }}<br /><small v-if="currentAddress">{{ currentAddress }}<br /></small><small>{{ currentLocation }}</small></p>
    <p v-if="geoError" class="message error-message content-message" role="alert">{{ geoError }}</p>
    <div class="divider"><span>或从地址簿选择</span></div>
    <p v-if="loading" class="message" role="status">正在读取地址簿…</p>
    <div v-else-if="error" class="empty-state"><p role="alert">{{ error }}</p><button type="button" class="button button-quiet" @click="load">重新加载地址簿</button></div>
    <div v-else-if="addresses.length" class="address-list">
      <button v-for="address in addresses" :key="address.id" class="address-row" :class="{ selected: selection?.kind === 'address' && selection.address.id === address.id }" :aria-pressed="selection?.kind === 'address' && selection.address.id === address.id" :disabled="!validLocation(address.location)" type="button" @click="choose(address)">
        <span class="address-glyph" aria-hidden="true">位</span>
        <span class="address-copy"><strong>{{ address.label }}{{ address.is_default ? ' · 默认' : '' }}</strong><small>{{ address.description }}</small><small v-if="!validLocation(address.location)">坐标无效，无法用于推荐</small></span>
        <span v-if="selection?.kind === 'address' && selection.address.id === address.id" class="checkmark" aria-label="已选择">✓</span>
      </button>
    </div>
    <div v-else class="empty-state"><p>还没有保存的地址</p><small>获取当前位置或搜索确认地点后，可保存为地址。</small><button v-if="!creating" ref="createEntry" type="button" class="button create-entry" @click="openCreate">＋ 保存为地址</button><button type="button" class="button button-quiet" @click="load">刷新地址簿</button></div>
    <button v-if="!loading && !error && addresses.length && !creating" ref="createEntry" type="button" class="button create-entry" @click="openCreate">＋ 保存为地址</button>
    <AddressCreate v-if="creating" :signal="signal" :choice="selection" @saved="saved" @cancel="closeCreate" @expired="emit('expired')" />
    <p v-if="saveNotice" class="form-note save-notice" role="status">{{ saveNotice }}</p>
    <LocationSearch :signal="signal" :reset-key="searchReset" @editing="stopLocating" @select="chooseSearch" @expired="emit('expired')" />
    <p class="sidebar-footer">选择的位置仅用于推荐</p>
  </aside>
</template>

<style scoped>
.create-entry { margin-top: var(--space-2); border: 1px solid var(--border-default); color: var(--accent-primary); background: var(--surface-secondary); }
.create-entry:hover:not(:disabled) { background: var(--accent-surface); }
.empty-state .create-entry { margin-top: 0; }
.save-notice { margin-top: var(--space-3); color: var(--status-success); }
</style>
