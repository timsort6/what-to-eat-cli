<script setup lang="ts">
import { computed, reactive } from 'vue'
import { MEAL_STYLE_LABELS, PRICE_OPTIONS, RADIUS_OPTIONS, TARGET_COUNT_OPTIONS } from './recommendation'
import type { MealStyle, PreferenceForm, PreferenceFormErrors } from './recommendation'

const props = defineProps<{ disabled: boolean; errors: PreferenceFormErrors; summary: string }>()
const form = defineModel<PreferenceForm>({ required: true })
const mealStyles = Object.keys(MEAL_STYLE_LABELS) as MealStyle[]
// 自定义字段失焦后才显示错误，避免刚选“自定义”、尚未输入就弹 alert；无效时提交按钮仍由父组件禁用。
const touched = reactive({ radius: false, price: false })
const radiusError = computed(() => touched.radius ? props.errors.radius : undefined)
const priceError = computed(() => touched.price ? props.errors.price : undefined)
// 摘要按“ · ”分段，每段连同其后的分隔点整体换行，避免“人均不/限”式拆词。
const summaryParts = computed(() => props.summary.split(' · '))

function set<K extends keyof PreferenceForm>(key: K, value: PreferenceForm[K]): void {
  form.value = { ...form.value, [key]: value }
}
function value(event: Event): string {
  return (event.target as HTMLInputElement | HTMLSelectElement).value
}
</script>

<template>
  <fieldset class="preferences" :disabled="disabled">
    <legend>推荐条件</legend>
    <div class="preference-grid">
      <label class="field"><span>推荐数量</span>
        <select :value="form.target_count" :aria-invalid="Boolean(errors.count)" @change="set('target_count', Number(value($event)))">
          <option v-for="count in TARGET_COUNT_OPTIONS" :key="count" :value="count">{{ count }} 家</option>
        </select>
      </label>
      <label class="field"><span>搜索范围（直线半径）</span>
        <select :value="form.radius" @change="set('radius', value($event)); touched.radius = false">
          <option v-for="meters in RADIUS_OPTIONS" :key="meters" :value="String(meters)">{{ meters / 1000 }} 公里</option>
          <option value="custom">自定义</option>
        </select>
      </label>
      <label v-if="form.radius === 'custom'" class="field"><span>自定义半径（米，100–50000，步长 100）</span>
        <input :value="form.custom_radius" type="number" inputmode="numeric" min="100" max="50000" step="100" placeholder="例如 4000"
          :aria-invalid="Boolean(radiusError)" :aria-describedby="radiusError ? 'radius-error' : undefined" @input="set('custom_radius', value($event))" @blur="touched.radius = true">
      </label>
      <label class="field"><span>用餐安排</span>
        <select :value="form.meal_style" @change="set('meal_style', value($event) as MealStyle)">
          <option v-for="style in mealStyles" :key="style" :value="style">{{ MEAL_STYLE_LABELS[style] }}</option>
        </select>
      </label>
      <label class="field"><span>人均上限</span>
        <select :value="form.price" @change="set('price', value($event)); touched.price = false">
          <option value="none">不限</option>
          <option v-for="price in PRICE_OPTIONS" :key="price" :value="String(price)">{{ price }} 元</option>
          <option value="custom">自定义</option>
        </select>
      </label>
      <label v-if="form.price === 'custom'" class="field"><span>自定义人均上限（元，1–10000 整数）</span>
        <input :value="form.custom_price" type="number" inputmode="numeric" min="1" max="10000" step="1" placeholder="例如 80"
          :aria-invalid="Boolean(priceError)" :aria-describedby="priceError ? 'price-error' : undefined" @input="set('custom_price', value($event))" @blur="touched.price = true">
      </label>
    </div>
    <p v-if="errors.count" class="field-error" role="alert">{{ errors.count }}</p>
    <p v-if="radiusError" id="radius-error" class="field-error" role="alert">{{ radiusError }}</p>
    <p v-if="priceError" id="price-error" class="field-error" role="alert">{{ priceError }}</p>
    <!-- 不设 aria-live：逐键输入时不打断读屏；控件自身会播报所选值。 -->
    <p class="hint preference-summary"><strong>当前条件：</strong><template v-for="(part, index) in summaryParts" :key="index">{{ index ? ' ' : '' }}<span class="keep-together">{{ part }}{{ index < summaryParts.length - 1 ? ' ·' : '' }}</span></template></p>
    <!-- 品类只能由对话采纳或协商写入，这里提供唯一的手动清除入口；修改后旧协商方案由 ChatPanel 现有规则失效。 -->
    <p v-if="form.food_requirement !== null" class="hint preference-food"><span>品类：{{ form.food_requirement }}</span><button class="text-button" type="button" :disabled="disabled" @click="set('food_requirement', null)">清除品类</button></p>
  </fieldset>
</template>

<style scoped>
.preferences { display: grid; gap: var(--space-3); min-width: 0; margin: 0; padding: 0; border: 0; }
.preferences legend { padding: 0; margin-bottom: var(--space-2); font-size: var(--text-sm); font-weight: 600; }
.preference-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(12rem, 100%), 1fr)); align-items: end; gap: var(--space-3); }
select { min-width: 0; width: 100%; min-height: 44px; border: 1px solid var(--border-default); border-radius: var(--radius-sm); color: var(--text-primary); background: var(--surface-elevated); padding: var(--space-2) var(--space-3); font: inherit; }
select:hover:not(:disabled) { border-color: var(--text-secondary); }
input { min-height: 44px; padding: var(--space-2) var(--space-3); }
select:disabled, input:disabled { color: var(--text-secondary); }
[aria-invalid="true"] { border-color: var(--status-error); }
.field-error { margin: 0; color: var(--status-error); font-size: var(--text-sm); }
.preference-summary { overflow-wrap: anywhere; }
.preference-food { display: flex; flex-wrap: wrap; align-items: center; gap: var(--space-2); margin: 0; overflow-wrap: anywhere; }
</style>
