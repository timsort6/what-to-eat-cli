<script setup lang="ts">
import { computed } from 'vue'
import { amapLink } from './mapLinks'
import { priceLabel, type Place } from './protocol'
import type { Preferences } from './recommendation'

// 已接受推荐卡片：有可信高德目的地时整卡为单一外链（卡内无其他交互），否则为不可聚焦的 article。
// 未知字段只标“待核实/未知”，不填猜测值，也不打“符合”标签。
const props = defineProps<{ place: Place; index: number; preferences: Preferences | null }>()

const link = computed(() => amapLink(props.place))
const linkAttrs = computed(() => link.value ? { href: link.value.href, target: '_blank', rel: 'noopener noreferrer' } : {})
// 目的地文案与分类按短语分段（.keep-together），整段换行而不是从“（新/窗口打开）”中间拆开。
const destination = computed(() => {
  if (!link.value) return ['无法定位，', '暂无可用高德链接']
  return [link.value.kind === 'detail' ? '在高德地图查看商家详情' : '在高德地图查看位置', '（新窗口打开）']
})
// 高德 type 原文形如“餐饮服务;中餐厅;火锅店”，多组以“|”分隔；拆开、去空白、去重后以“ · ”连接。
const categories = computed(() => [...new Set(props.place.type.split(/[;|]/).map((part) => part.trim()).filter(Boolean))])
const distance = computed(() => {
  const meters = Number(props.place.distance)
  return props.place.distance.trim() === '' || !Number.isFinite(meters) || meters < 0 ? '距离未知' : `直线约 ${Math.round(meters).toLocaleString('zh-CN')} 米`
})
// protocol.parsePlace 只为人民币人均（含缺币种/口径的高德参考人均）保留 cost，其余为空。
const price = computed(() => priceLabel(props.place.cost))
const foodUnknown = computed(() => props.preferences?.food_requirement != null && props.place.states?.food !== 'satisfied')
const mealIntent = computed(() => props.preferences !== null && props.preferences.meal_style !== 'any')
</script>

<template>
  <component :is="link ? 'a' : 'article'" class="place-card" :class="{ 'place-card-link': link }" v-bind="linkAttrs">
    <div class="place-index" aria-hidden="true">{{ String(index + 1).padStart(2, '0') }}</div>
    <div class="place-body">
      <h3>{{ place.name || '商家名称未提供' }}</h3>
      <p>{{ place.address || '暂无详细地址' }}</p>
      <ul class="place-facts">
        <li>{{ distance }}</li>
        <li v-if="categories.length">来源分类：<template v-for="(part, i) in categories" :key="i">{{ i ? ' ' : '' }}<span class="keep-together">{{ part }}{{ i < categories.length - 1 ? ' ·' : '' }}</span></template></li>
        <li v-if="foodUnknown">细分品类待核实</li>
        <li>{{ price }}</li>
        <li v-if="mealIntent">用餐/出餐耗时未知</li>
      </ul>
      <span class="place-destination"><span v-for="(part, i) in destination" :key="i" class="keep-together">{{ part }}</span></span>
    </div>
  </component>
</template>

<style scoped>
.place-card-link { color: inherit; text-decoration: none; }
.place-card-link:hover { border-color: var(--text-secondary); background: var(--surface-elevated); }
.place-card-link:focus-visible { outline: 3px solid var(--focus); outline-offset: 3px; }
.place-body { min-width: 0; overflow-wrap: anywhere; }
.place-facts { display: flex; flex-wrap: wrap; gap: var(--space-1) var(--space-3); margin: var(--space-2) 0 0; padding: 0; list-style: none; color: var(--text-secondary); font-size: var(--text-sm); }
.place-destination { display: block; margin-top: var(--space-2); color: var(--text-secondary); font-size: var(--text-sm); }
.place-card-link .place-destination { color: var(--accent-primary); font-weight: 600; }
/* 下划线不会传递进 inline-block 分段，需加在分段自身上。 */
.place-card-link .place-destination > span { text-decoration: underline; text-underline-offset: 2px; }
</style>
