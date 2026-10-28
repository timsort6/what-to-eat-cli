<script setup lang="ts">
import { computed, nextTick, onMounted, ref, shallowRef } from 'vue'
import { createAddress } from './api'
import { ApiError, addressLabelError, addressLabelMax, buildCreateAddressRequest, messageFrom, savableChoice } from './protocol'
import type { Address, LocationChoice, SavableChoice } from './protocol'

const props = defineProps<{ signal: AbortSignal; choice: LocationChoice | null }>()
const emit = defineEmits<{ saved: [address: Address, from: SavableChoice]; cancel: []; expired: [] }>()
const label = ref('')
const isDefault = ref(false)
const saving = ref(false)
const labelError = ref('')
const saveError = ref<string[]>([])
const saveAlert = ref<HTMLParagraphElement | null>(null)
const submitted = shallowRef<SavableChoice | null>(null)
const labelInput = ref<HTMLInputElement | null>(null)
const saveButton = ref<HTMLButtonElement | null>(null)
// 保存期间显示已提交的地点快照，避免切换位置后误以为新地点正在保存。
const place = computed(() => saving.value ? submitted.value : savableChoice(props.choice) ? props.choice : null)

async function save(): Promise<void> {
  if (saving.value) return
  const from = props.choice
  if (!savableChoice(from)) return
  labelError.value = addressLabelError(label.value)
  saveError.value = []
  if (labelError.value) {
    labelInput.value?.focus()
    return
  }
  const payload = buildCreateAddressRequest(label.value, from, isDefault.value)
  submitted.value = from
  saving.value = true
  try {
    const address = await createAddress(payload, props.signal)
    if (!props.signal.aborted) emit('saved', address, from)
  } catch (failure) {
    if (props.signal.aborted) return
    if (failure instanceof ApiError && failure.status === 401) {
      emit('expired')
      return
    }
    // 按短语分段（.keep-together），窄侧栏中整段换行而不是把“表/单”拆开。
    saveError.value = failure instanceof TypeError
      ? ['网络连接失败，地址未保存。', '请检查网络后', '点击“保存地址”重试。']
      : [`地址未保存：${messageFrom(failure, '请求失败')}。`, '表单已保留，', '可点击“保存地址”重试。']
    saving.value = false
    await nextTick()
    // 侧栏可内滚动：先把按钮上方的提示滚进可视区，再聚焦按钮（两者相邻，同屏可见）。
    saveAlert.value?.scrollIntoView({ block: 'nearest' })
    saveButton.value?.focus()
  } finally {
    saving.value = false
  }
}

function cancel(): void {
  if (!saving.value) emit('cancel')
}

onMounted(() => labelInput.value?.focus())
</script>

<template>
  <form class="address-create" aria-labelledby="address-create-title" :aria-busy="saving" novalidate @submit.prevent="save" @keydown.esc.prevent.stop="cancel">
    <h3 id="address-create-title">保存为地址</h3>
    <label class="field"><span>地址标签</span>
      <input ref="labelInput" v-model="label" :maxlength="addressLabelMax" autocomplete="off" placeholder="例如：家、公司" :disabled="saving" :aria-invalid="Boolean(labelError)" :aria-describedby="labelError ? 'address-create-label-error' : undefined" @input="labelError = ''" />
    </label>
    <p v-if="labelError" id="address-create-label-error" class="message error-message" role="alert">{{ labelError }}</p>
    <div class="field">
      <span id="address-create-place-title">已确认地点</span>
      <div v-if="place" class="address-create-place" role="group" aria-labelledby="address-create-place-title">
        <strong>{{ place.name || '当前位置（仅坐标）' }}</strong>
        <small>{{ place.address || (place.name ? '暂无详细地址' : '未解析门牌地址，将按坐标保存') }}</small>
        <small>坐标 {{ place.location }}</small>
      </div>
      <p v-else id="address-create-place-note" class="form-note">
        {{ choice?.kind === 'address' ? `当前使用的是已保存地址「${choice.address.label}」，无需重复保存。` : '尚未确认地点。' }}请先获取当前位置，或在下方搜索并点“使用此地点”。
      </p>
    </div>
    <label class="address-create-default">
      <input v-model="isDefault" type="checkbox" :disabled="saving" aria-describedby="address-create-default-hint" />
      <span>设为默认地址</span>
    </label>
    <p id="address-create-default-hint" class="form-note">首个地址会由服务器自动设为默认。</p>
    <p v-if="saveError.length" ref="saveAlert" class="message error-message" role="alert"><span v-for="(part, i) in saveError" :key="i" class="keep-together">{{ part }}</span></p>
    <div class="address-create-actions">
      <button ref="saveButton" class="button button-primary" type="submit" :disabled="saving || !place" :aria-describedby="place ? undefined : 'address-create-place-note'">{{ saving ? '正在保存…' : '保存地址' }}</button>
      <button class="button button-quiet" type="button" :disabled="saving" @click="cancel">取消</button>
    </div>
  </form>
</template>

<style scoped>
.address-create { display: grid; gap: var(--space-3); margin-top: var(--space-3); padding: var(--space-4); border: 1px solid var(--border-default); border-radius: var(--radius-sm); background: var(--surface-secondary); }
.address-create h3 { margin: 0; font-size: var(--text-base); line-height: 1.4; }
.address-create-place { display: grid; gap: var(--space-1); min-width: 0; padding: var(--space-3); border-radius: var(--radius-sm); background: var(--border-subtle); }
.address-create-place strong { font-size: var(--text-sm); }
.address-create-place small { color: var(--text-secondary); font-size: var(--text-sm); }
.address-create-default { display: flex; align-items: center; gap: var(--space-3); min-height: 44px; font-size: var(--text-sm); font-weight: 600; cursor: pointer; }
.address-create-default input { flex: none; width: 20px; height: 20px; margin: 0; padding: 0; accent-color: var(--accent-primary); }
.address-create-actions { display: flex; flex-wrap: wrap; gap: var(--space-2); }
.address-create-actions .button-primary { flex: 1 1 auto; }
</style>
