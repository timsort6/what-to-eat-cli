import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  DEFAULT_PREFERENCES, normalizeRecommendationRequest, parsePreferences,
  parsePreferenceChanges, parseSelection, parseRecommendationDecision, selectRecommendationOption,
} from '../.test-dist/recommendation.js'

test('旧请求省略条件时保留5000米和10家，显式旧值原样映射', () => {
  assert.deepEqual(normalizeRecommendationRequest({}).preferences, { ...DEFAULT_PREFERENCES, radius_meters: 5000, target_count: 10 })
  assert.deepEqual(normalizeRecommendationRequest({ radius: 1234, limit: 2 }).preferences, { ...DEFAULT_PREFERENCES, radius_meters: 1234, target_count: 2 })
})

test('新条件默认3公里3家，完整条件不会丢失价格、品类或false', () => {
  assert.deepEqual(normalizeRecommendationRequest({ preferences: {} }).preferences, DEFAULT_PREFERENCES)
  const preferences = { target_count: 5, radius_meters: 4000, meal_style: 'quick', max_price_cny: 100, allow_unknown_price: false, food_requirement: ' 四川火锅 ' }
  const result = normalizeRecommendationRequest({ radius: 4000, limit: 5, preferences })
  assert.deepEqual(result.preferences, preferences)
})

test('条件边界允许协商后的2家、精确4公里及整元上下限', () => {
  for (const changes of [{ target_count: 2, radius_meters: 4000 }, { target_count: 1, radius_meters: 100, max_price_cny: 1 }, { target_count: 10, radius_meters: 50000, max_price_cny: 10000 }, { food_requirement: '锅'.repeat(100) }]) {
    assert.deepEqual(parsePreferenceChanges(changes), changes)
  }
})

test('省略与显式清空价格及品类保持不同含义', () => {
  assert.deepEqual(parsePreferenceChanges({}), {})
  assert.deepEqual(parsePreferenceChanges({ max_price_cny: null, food_requirement: null }), { max_price_cny: null, food_requirement: null })
})

test('新旧字段冲突、未知枚举、非有限值、负数和超限均拒绝', () => {
  for (const input of [
    { radius: 2000, preferences: { radius_meters: 4000 } }, { limit: 5, preferences: { target_count: 3 } },
    { radius: -1 }, { radius: 0 }, { radius: 50001 }, { radius: NaN }, { limit: Infinity }, { limit: 11 },
    ...[0, -1, 11, 1.5, NaN].map((target_count) => ({ preferences: { target_count } })),
    ...[0, -100, 50, 1234, 50100, NaN, Infinity].map((radius_meters) => ({ preferences: { radius_meters } })),
    ...[0, -1, 10001, 0.5, NaN, Infinity].map((max_price_cny) => ({ preferences: { max_price_cny } })),
    { preferences: { meal_style: 'fast' } }, { preferences: { allow_unknown_price: null } },
    { preferences: { target_count: null } }, { preferences: { target_count: undefined } },
    { preferences: { food_requirement: '锅'.repeat(101) } }, { preferences: { address_id: 2 } },
    { preferences: null }, { preferences: [] }, { selection: '好的' },
  ]) assert.throws(() => normalizeRecommendationRequest(input), undefined, JSON.stringify(input))
})

test('明确点选提交完整新条件与准确差异，不修改旧状态', () => {
  const previous = { ...DEFAULT_PREFERENCES, radius_meters: 2000, max_price_cny: 50, food_requirement: '四川火锅' }
  const changes = { radius_meters: 4000, max_price_cny: null }
  const option = { option_id: 'expand', label: '扩大范围', observed_ids: [], reason_codes: ['outside_radius'], changes }
  const result = selectRecommendationOption('expand', { preferences: previous, options: [option] }, previous)
  assert.deepEqual(result, { preferences: { ...previous, ...changes }, selection: { option_id: 'expand', previous_preferences: previous, changes } })
  assert.deepEqual(normalizeRecommendationRequest(result), result)
  assert.equal(previous.radius_meters, 2000)
})

test('好的、拒绝及不存在的选项不能自动接受，过期条件也拒绝', () => {
  const pending = { preferences: DEFAULT_PREFERENCES, options: [{ option_id: 'expand', label: '扩大范围', observed_ids: [], reason_codes: [], changes: { radius_meters: 4000 } }] }
  for (const reply of ['好的', '拒绝', '', 'missing']) assert.throws(() => selectRecommendationOption(reply, pending, DEFAULT_PREFERENCES))
  assert.throws(() => selectRecommendationOption('expand', pending, { ...DEFAULT_PREFERENCES, target_count: 5 }))
  assert.deepEqual(normalizeRecommendationRequest({ preferences: DEFAULT_PREFERENCES, messages: [{ role: 'assistant', content: '扩大到4公里改吃冒菜' }, { role: 'user', content: '好的' }] }), { preferences: DEFAULT_PREFERENCES })
})

test('空差异、伪造差异、缺失旧条件和越权字段均拒绝', () => {
  for (const selection of [
    '好的', { option_id: 'expand', previous_preferences: DEFAULT_PREFERENCES, changes: {} },
    { option_id: 'expand', previous_preferences: DEFAULT_PREFERENCES, changes: { radius_meters: 4000 } },
    { option_id: 'expand', previous_preferences: {}, changes: { radius_meters: 4000 } },
    { option_id: 'expand', previous_preferences: DEFAULT_PREFERENCES, changes: { user_id: 2 } },
    { option_id: 'expand', previous_preferences: DEFAULT_PREFERENCES, changes: { radius_meters: 4000 }, candidate_ids: ['old'] },
  ]) assert.throws(() => parseSelection(selection, DEFAULT_PREFERENCES))
  assert.throws(() => parsePreferences({ ...DEFAULT_PREFERENCES, allow_unknown_price: undefined }))
})

const ready = () => ({ status: 'ready', selected_ids: ['p1'], reason_codes: [], options: [], assessments: [{
  candidate_id: 'p1', range: { state: 'satisfied', fields: ['location'] },
  food: { state: 'unknown', fields: [] }, price: { state: 'unknown', fields: [] },
}] })

test('三态解析保留未知事实，协商状态不产生最终推荐卡片', () => {
  const decision = ready()
  assert.deepEqual(parseRecommendationDecision(JSON.stringify(decision)), decision)
  const choice = { status: 'needs_choice', selected_ids: [], assessments: [], reason_codes: ['no_candidates'], options: [{
    option_id: 'expand', label: '扩大到4公里后重新查找', observed_ids: [], reason_codes: ['outside_radius'], changes: { radius_meters: 4000 },
  }] }
  assert.deepEqual(parseRecommendationDecision(JSON.stringify(choice)), choice)
})

test('决策拒绝未知枚举、越权证据、重复ID、超量和状态矛盾', () => {
  for (const mutate of [
    (d) => { d.status = 'accepted' }, (d) => { d.selected_ids = ['unknown'] }, (d) => { d.selected_ids = ['p1', 'p1'] },
    (d) => { d.selected_ids = Array(11).fill('p1') }, (d) => { d.assessments.push(d.assessments[0]) },
    (d) => { d.assessments = Array(226).fill(d.assessments[0]) }, (d) => { d.options = Array(4).fill({}) },
    (d) => { d.assessments[0].food.state = 'likely' }, (d) => { d.assessments[0].food.state = 'satisfied' },
    (d) => { d.assessments[0].range.fields = ['raw.secret'] }, (d) => { d.assessments[0].range.fields = ['location', 'location'] },
    (d) => { d.reason_codes = ['invented'] }, (d) => { d.reason_codes = ['no_candidates', 'no_candidates'] },
    (d) => { d.status = 'needs_choice' }, (d) => { d.selected_ids = [] }, (d) => { d.tool = 'arbitrary' },
  ]) {
    const decision = ready()
    mutate(decision)
    assert.throws(() => parseRecommendationDecision(JSON.stringify(decision)))
  }
})

test('畸形、尾随JSON和超过64KiB的决策失败关闭', () => {
  for (const raw of ['null', '[]', '{', JSON.stringify(ready()) + '{}', ' '.repeat(64 * 1024) + JSON.stringify(ready())]) {
    assert.throws(() => parseRecommendationDecision(raw))
  }
})

test('协商选项的重复ID、未知观察及空差异也失败关闭', () => {
  for (const mutate of [
    (d) => { d.options[0].changes = {} }, (d) => { d.options.push(d.options[0]) },
    (d) => { d.options[0].observed_ids = ['missing'] }, (d) => { d.options[0].observed_ids = ['p1', 'p1'] },
    (d) => { d.assessments[0].price.fields = null },
  ]) {
    const decision = { ...ready(), status: 'needs_choice', selected_ids: [], options: [{ option_id: 'expand', label: '扩大到4公里', observed_ids: [], reason_codes: ['outside_radius'], changes: { radius_meters: 4000 } }] }
    mutate(decision)
    assert.throws(() => parseRecommendationDecision(JSON.stringify(decision)))
  }
})

const { DEFAULT_PREFERENCE_FORM, preferencesFromForm, describePreferences, commitPreferenceTurn } = await import('../.test-dist/recommendation.js')
const form = (changes) => preferencesFromForm({ ...DEFAULT_PREFERENCE_FORM, ...changes })
const keys = ['allow_unknown_price', 'food_requirement', 'max_price_cny', 'meal_style', 'radius_meters', 'target_count']

test('控件默认值形成完整请求条件：3家、3公里、不限、价格不限且允许未知价格', () => {
  const result = form({})
  assert.deepEqual(result, { ok: true, preferences: DEFAULT_PREFERENCES })
  assert.deepEqual(Object.keys(result.preferences).sort(), keys)
  assert.deepEqual(normalizeRecommendationRequest({ preferences: result.preferences }).preferences, DEFAULT_PREFERENCES)
})

test('四档数量、自定义4公里、预算不限/自定义与三种用餐安排均提交完整条件', () => {
  for (const target_count of [1, 3, 5, 10]) assert.equal(form({ target_count }).preferences.target_count, target_count)
  assert.equal(form({ radius: 'custom', custom_radius: '4000' }).preferences.radius_meters, 4000)
  assert.equal(form({ radius: '2000' }).preferences.radius_meters, 2000)
  assert.equal(form({ price: 'none', custom_price: '80' }).preferences.max_price_cny, null)
  assert.equal(form({ price: 'custom', custom_price: ' 80 ' }).preferences.max_price_cny, 80)
  for (const meal_style of ['quick', 'regular', 'leisure']) {
    const { preferences } = form({ meal_style })
    assert.deepEqual(preferences, { ...DEFAULT_PREFERENCES, meal_style })
    assert.deepEqual(parsePreferences(preferences), preferences)
  }
  const fast = form({ target_count: 3, radius: '2000', price: '50', meal_style: 'quick' })
  assert.deepEqual(fast.preferences, { target_count: 3, radius_meters: 2000, meal_style: 'quick', max_price_cny: 50, allow_unknown_price: true, food_requirement: null })
  assert.equal(describePreferences(fast.preferences), '3 家 · 2 公里内 · 用餐安排：快速用餐（约30分钟） · 人均 50 元以内 · 价格未知也展示（待核实）')
})

test('负数、小数、超额与越界的自定义值及非法店数被拒绝并给出对应字段错误', () => {
  for (const custom_radius of ['', '-100', '4000.5', '1e3', '50', '4050', '50100', 'abc']) {
    const result = form({ radius: 'custom', custom_radius })
    assert.equal(result.ok, false, custom_radius)
    assert.ok(result.errors.radius && !result.errors.price, custom_radius)
  }
  for (const custom_price of ['', '0', '-1', '12.5', '10001', '9999999']) {
    const result = form({ price: 'custom', custom_price })
    assert.equal(result.ok, false, custom_price)
    assert.ok(result.errors.price && !result.errors.radius, custom_price)
  }
  for (const target_count of [0, -1, 2, 1.5, 11, NaN]) assert.ok(form({ target_count }).errors.count, String(target_count))
})

test('每轮历史保存独立的冻结条件快照，后续编辑不改写旧轮次', () => {
  const draft = { user: '想吃面', assistant: '附近有面馆', completed: true }
  const live = { ...form({ radius: '2000' }).preferences }
  const first = commitPreferenceTurn([], draft, live)
  live.radius_meters = 9000
  const second = commitPreferenceTurn(first, { ...draft, user: '换成米线' }, form({ target_count: 5 }).preferences)
  assert.equal(first[0].preferences.radius_meters, 2000)
  assert.equal(second[0].preferences, first[0].preferences)
  assert.equal(second[1].preferences.target_count, 5)
  assert.throws(() => { second[0].preferences.target_count = 10 })
  assert.equal(commitPreferenceTurn(second, { ...draft, completed: false }, DEFAULT_PREFERENCES), second)
})
