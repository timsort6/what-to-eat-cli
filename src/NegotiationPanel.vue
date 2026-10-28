<script setup lang="ts">
import { computed } from 'vue'
import { REASON_LABELS, candidateNotes, describeChanges, describePreferences } from './recommendation'
import type { NeedsChoiceDecision, Preferences } from './recommendation'

// 方案只在 enabled（完整成功 done 且未过期）时可操作；available 标出选单能否精确表示该方案。
const props = defineProps<{ decision: NeedsChoiceDecision; preferences: Preferences; enabled: boolean; available: Readonly<Record<string, boolean>> }>()
const emit = defineEmits<{ choose: [optionID: string]; keep: [] }>()

const reasons = computed(() => props.decision.reason_codes.map((code) => REASON_LABELS[code]))
const originalParts = computed(() => describePreferences(props.preferences).split(' · '))
const options = computed(() => props.decision.options.map((option, index) => {
  const changes = describeChanges(props.preferences, option.changes)
  const changeText = changes.map((change) => `${change.field}从${change.before}改为${change.after}`).join('，')
  return {
    option, changes, id: `negotiation-option-${index}`,
    name: `选择方案：${option.label}（${changeText}）`,
    candidates: option.observed_ids.map((id) => {
      const shown = props.decision.candidates?.find((candidate) => candidate.candidate_id === id)
      const assessment = props.decision.assessments.find((item) => item.candidate_id === id)
      return { id, shown, notes: candidateNotes(assessment, props.preferences) }
    }),
  }
}))

function distance(meters: number | null): string {
  return meters === null ? '距离未知' : `直线约 ${meters.toLocaleString('zh-CN')} 米`
}
</script>

<template>
  <section class="negotiation" aria-labelledby="negotiation-title">
    <h3 id="negotiation-title">需要你选择下一步</h3>
    <ul v-if="reasons.length" class="negotiation-reasons"><li v-for="reason in reasons" :key="reason">{{ reason }}</li></ul>
    <p class="hint">原条件：<template v-for="(part, index) in originalParts" :key="index">{{ index ? ' ' : '' }}<span class="keep-together">{{ part }}{{ index < originalParts.length - 1 ? ' ·' : '' }}</span></template></p>
    <p v-if="!enabled" class="hint" role="status">完整结果返回后才能选择方案。</p>
    <ol class="negotiation-options">
      <li v-for="item in options" :key="item.option.option_id" class="negotiation-option">
        <h4 :id="`${item.id}-title`">{{ item.option.label }}</h4>
        <ul :id="`${item.id}-changes`" class="negotiation-changes" aria-label="条件变化">
          <li v-for="change in item.changes" :key="change.field"><span>{{ change.field }}</span>{{ change.before }} → <strong>{{ change.after }}</strong></li>
        </ul>
        <template v-if="item.candidates.length">
          <p class="hint">本次已观察到的替代候选（仅供参考，尚未推荐；选择后会重新检索）：</p>
          <ul class="negotiation-candidates">
            <li v-for="candidate in item.candidates" :key="candidate.id">
              <strong>{{ candidate.shown?.name ?? '候选详情未提供' }}</strong>
              <span v-if="candidate.shown">{{ candidate.shown.address || '暂无详细地址' }} · {{ distance(candidate.shown.distance_meters) }}</span>
              <span v-for="note in candidate.notes" :key="note.text" class="candidate-note">{{ note.kind === 'deviation' ? '偏离' : '待核实' }}：{{ note.text }}</span>
            </li>
          </ul>
        </template>
        <p v-else class="hint">本次未观察到符合此方案的店铺；选择后会按新条件重新检索，不保证一定有结果。</p>
        <p v-if="!available[item.option.option_id]" :id="`${item.id}-blocked`" class="hint">该方案的条件无法在推荐条件选单中精确表示，暂不可选；可继续用文字描述。</p>
        <button class="button button-primary" type="button" :aria-label="item.name" :aria-describedby="`${item.id}-changes`"
          :disabled="!enabled || !available[item.option.option_id]" @click="emit('choose', item.option.option_id)">选择此方案</button>
      </li>
    </ol>
    <div class="negotiation-actions">
      <button class="button button-quiet" type="button" :disabled="!enabled" @click="emit('keep')">保持原条件，继续描述</button>
      <span class="hint">不会扩大范围或改变条件；可在上方用文字补充需求。</span>
    </div>
  </section>
</template>

<style scoped>
.negotiation { display: grid; gap: var(--space-3); min-width: 0; margin-top: var(--space-5); padding: var(--space-5); border: 1px solid var(--border-default); border-radius: var(--radius-sm); background: var(--surface-secondary); }
.negotiation h3 { margin: 0; font-size: var(--text-base); line-height: 1.4; }
.negotiation h4 { margin: 0; font-size: var(--text-base); line-height: 1.5; overflow-wrap: anywhere; }
.negotiation-reasons { margin: 0; padding-left: var(--space-5); font-size: var(--text-sm); }
.negotiation-options { display: grid; gap: var(--space-3); margin: 0; padding: 0; list-style: none; }
.negotiation-option { display: grid; gap: var(--space-2); min-width: 0; padding: var(--space-4); border-radius: var(--radius-sm); background: var(--surface-elevated); }
.negotiation-changes, .negotiation-candidates { display: grid; gap: var(--space-1); margin: 0; padding: 0; list-style: none; font-size: var(--text-sm); }
.negotiation-changes span { margin-right: var(--space-2); color: var(--text-secondary); }
.negotiation-candidates li { display: grid; gap: 2px; min-width: 0; padding: var(--space-2) 0; border-top: 1px solid var(--border-subtle); overflow-wrap: anywhere; }
.negotiation-candidates span { color: var(--text-secondary); }
.candidate-note { font-size: var(--text-xs); }
.negotiation .button { justify-self: start; max-width: 100%; white-space: normal; }
.negotiation-actions { display: flex; flex-wrap: wrap; align-items: center; gap: var(--space-3); }
@media (max-width: 520px) {
  .negotiation { padding: var(--space-4); }
  .negotiation .button { justify-self: stretch; width: 100%; }
}
</style>
