<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { listAddresses } from './api'
import { wgs84ToGcj02 } from './coordinates'
import { ApiError, messageFrom, validLocation } from './protocol'
import type { Address, LocationChoice } from './protocol'

const props = defineProps<{ signal: AbortSignal }>()
const emit = defineEmits<{ select: [location: LocationChoice | null]; expired: [] }>()
const addresses = ref<readonly Address[]>([])
const selection = ref<LocationChoice | null>(null)
const loading = ref(false)
const locating = ref(false)
const error = ref('')
const geoError = ref('')
let locationAttempt = 0
const currentLocation = computed(() => selection.value?.kind === 'coordinates' ? selection.value.location : '')

async function load(): Promise<void> {
  if (loading.value) return
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
  locationAttempt++
  locating.value = false
  selection.value = { kind: 'address', address }
  geoError.value = ''
  emit('select', selection.value)
}

function locate(): void {
  if (locating.value) return
  const attempt = ++locationAttempt
  geoError.value = ''
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
</script>

<template>
  <aside class="sidebar" aria-label="推荐位置">
    <div class="section-heading"><div><p class="eyebrow">第一步</p><h2>你在哪里？</h2></div><span class="step-number">01</span></div>
    <button class="location-button" type="button" :disabled="locating" @click="locate">{{ locating ? '正在获取位置…' : '获取当前位置' }}</button>
    <p v-if="currentLocation" class="location-confirm" role="status">已使用当前位置<br /><small>{{ currentLocation }}</small></p>
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
    <div v-else class="empty-state"><p>还没有保存的地址</p><small>请获取当前位置，或先在已有客户端保存地址后刷新。</small><button type="button" class="button button-quiet" @click="load">刷新地址簿</button></div>
    <p class="sidebar-footer">选择的位置仅用于推荐</p>
  </aside>
</template>
