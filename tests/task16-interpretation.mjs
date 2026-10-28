import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  DEFAULT_PREFERENCES, adoptPreferences, describeLocation, describePreferences, interpretationNote, parseRecommendationDecision, shortfallNote,
} from '../.test-dist/recommendation.js'

// 任务16：决策可选携带原话品类理解与文字/控件冲突；前端严格解析并同步被采纳的品类。
const ev = (state, fields) => ({ state, fields: state === 'unknown' ? [] : fields })
const base = {
  status: 'needs_choice', selected_ids: [], reason_codes: ['preferences_conflict'],
  assessments: [{ candidate_id: 'poi:FAR', range: ev('unsatisfied', ['location']), food: ev('satisfied', ['tag']), price: ev('unknown') }],
  options: [{ option_id: 'wider', label: '扩大到4公里', observed_ids: ['poi:FAR'], reason_codes: ['outside_radius'], changes: { radius_meters: 4000 } }],
  candidates: [{ candidate_id: 'poi:FAR', name: '远处川锅', address: '二号路', distance_meters: 3950 }],
}
const interpretation = { requirement: '四川火锅', quote: '四川火锅', ambiguous: false }
const conflict = { field: 'radius_meters', quote: '5公里', proposed: { radius_meters: 5000 } }

test('决策接受有界的品类理解与冲突说明，旧决策不受影响', () => {
  assert.deepEqual(parseRecommendationDecision(JSON.stringify(base)), base)
  const parsed = parseRecommendationDecision(JSON.stringify({ ...base, food_interpretation: interpretation, conflict }))
  assert.deepEqual(parsed.food_interpretation, interpretation)
  assert.deepEqual(parsed.conflict, conflict)
})

test('品类理解与冲突的未知字段、越界、类型错误与多字段 proposed 均拒绝', () => {
  for (const extra of [
    { food_interpretation: { ...interpretation, source: 'x' } }, { food_interpretation: { requirement: '四川火锅', quote: '四川火锅' } },
    { food_interpretation: { ...interpretation, requirement: '锅'.repeat(101) } }, { food_interpretation: { ...interpretation, quote: ' ' } },
    { food_interpretation: { ...interpretation, ambiguous: 'no' } }, { food_interpretation: null },
    { conflict: { ...conflict, field: 'location' } }, { conflict: { ...conflict, proposed: { radius_meters: 5000, target_count: 5 } } },
    { conflict: { ...conflict, proposed: { target_count: 5 } } }, { conflict: { ...conflict, proposed: { radius_meters: 5050 } } },
    { conflict: { ...conflict, why: 'x' } },
  ]) assert.throws(() => parseRecommendationDecision(JSON.stringify({ ...base, ...extra })), JSON.stringify(extra))
})

test('仅当提交品类为空且 done 带品类时采纳，其余字段以提交为准', () => {
  const submitted = { ...DEFAULT_PREFERENCES, radius_meters: 2000 }
  const adopted = adoptPreferences(submitted, { ...submitted, food_requirement: '四川火锅' })
  assert.deepEqual(adopted, { ...submitted, food_requirement: '四川火锅' })
  assert.match(describePreferences(adopted), /品类：四川火锅/)
  assert.equal(adoptPreferences(submitted, submitted), submitted)
  assert.equal(adoptPreferences(submitted, undefined), submitted)
  const explicit = { ...submitted, food_requirement: '冒菜' }
  assert.equal(adoptPreferences(explicit, { ...explicit, food_requirement: '四川火锅' }), explicit)
})

test('来源说明与数量缺口是确定性文案', () => {
  assert.equal(interpretationNote({ ...base, food_interpretation: interpretation }), '品类“四川火锅”据你的原话“四川火锅”理解')
  assert.match(interpretationNote({ ...base, food_interpretation: { ...interpretation, ambiguous: true } }), /不够明确/)
  assert.equal(interpretationNote(base), '')
  assert.equal(shortfallNote('ready', 2, 5), '找到 2 家（期望 5 家）')
  assert.equal(shortfallNote('ready', 3, 3), '')
  assert.equal(shortfallNote('needs_choice', 0, 3), '')
  assert.equal(shortfallNote(undefined, 1, 3), '')
})

test('已确认搜索地点显示名称 · 地址，其余坐标保持原样', () => {
  assert.equal(describeLocation({ kind: 'coordinates', location: '116.4,39.9', name: '测试公园', address: '东门', source: 'search' }), '测试公园 · 东门')
  assert.equal(describeLocation({ kind: 'coordinates', location: '116.4,39.9', name: '测试公园', address: '', source: 'search' }), '测试公园')
  assert.equal(describeLocation({ kind: 'coordinates', location: '116.4,39.9' }), '当前位置 · 116.4,39.9')
  assert.equal(describeLocation(null), '尚未选择位置')
})
