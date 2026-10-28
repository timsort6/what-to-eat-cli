import { test } from 'node:test'
import assert from 'node:assert/strict'

const rec = await import('../.test-dist/recommendation.js')
const { readSSE } = await import('../.test-dist/sse.js')
const { DEFAULT_PREFERENCE_FORM, DEFAULT_PREFERENCES, preferencesFromForm, describePreferences, parseRecommendationDecision, normalizeRecommendationRequest } = rec

const original = { ...DEFAULT_PREFERENCES, target_count: 1, radius_meters: 2000, max_price_cny: 50, food_requirement: '四川火锅' }
const originalForm = { ...DEFAULT_PREFERENCE_FORM, target_count: 1, radius: '2000', price: '50', food_requirement: '四川火锅' }
const evidence = (state, fields) => ({ state, fields: state === 'unknown' ? [] : fields })
const assessment = (id, range, food, price) => ({ candidate_id: id, range: evidence(range, ['location']), food: evidence(food, ['tag']), price: evidence(price, ['business.cost']) })
const needsChoice = () => ({
  status: 'needs_choice', selected_ids: [], reason_codes: ['outside_radius', 'food_mismatch'],
  assessments: [assessment('poi:FAR', 'unsatisfied', 'satisfied', 'unknown'), assessment('poi:NEAR', 'satisfied', 'unsatisfied', 'satisfied')],
  options: [
    { option_id: 'wider', label: '保留四川火锅，扩大到4公里', observed_ids: ['poi:FAR'], reason_codes: ['outside_radius'], changes: { radius_meters: 4000 } },
    { option_id: 'swap', label: '保持2公里，改吃冒菜', observed_ids: ['poi:NEAR'], reason_codes: ['food_mismatch'], changes: { food_requirement: '冒菜' } },
    { option_id: 'two', label: '只要2家', observed_ids: [], reason_codes: [], changes: { target_count: 2 } },
  ],
  candidates: [
    { candidate_id: 'poi:FAR', name: '远处川锅', address: '二号路', distance_meters: 3600 },
    { candidate_id: 'poi:NEAR', name: '近处冒菜', address: '', distance_meters: null },
  ],
})
const pending = (decision = parseRecommendationDecision(JSON.stringify(needsChoice()))) => ({ preferences: original, options: decision.options })

test('decision 解析替代候选白名单字段，并拒绝越权或未引用的候选', () => {
  const decision = parseRecommendationDecision(JSON.stringify(needsChoice()))
  assert.deepEqual(decision.candidates, needsChoice().candidates)
  for (const mutate of [
    (d) => { d.candidates[0].tel = '010' }, (d) => { delete d.candidates[0].distance_meters }, (d) => { d.candidates[0].distance_meters = -1 },
    (d) => { d.candidates[0].distance_meters = 1.5 }, (d) => { d.candidates[0].name = ' ' }, (d) => { d.candidates[0].address = null },
    (d) => { d.candidates[0].candidate_id = 'poi:OTHER' }, (d) => { d.candidates.push(d.candidates[0]) },
    (d) => { d.candidates = Array(31).fill(d.candidates[0]) }, (d) => { d.candidates[0].name = '店'.repeat(1025) },
  ]) {
    const value = needsChoice()
    mutate(value)
    assert.throws(() => parseRecommendationDecision(JSON.stringify(value)), undefined, JSON.stringify(value.candidates))
  }
  const ready = { status: 'ready', selected_ids: ['poi:NEAR'], reason_codes: [], options: [], assessments: [assessment('poi:NEAR', 'satisfied', 'satisfied', 'unknown')] }
  assert.deepEqual(parseRecommendationDecision(JSON.stringify({ ...ready, candidates: [] })).candidates, [])
  assert.throws(() => parseRecommendationDecision(JSON.stringify({ ...ready, candidates: [needsChoice().candidates[1]] })))
})

test('点选扩大到4km：选单切到自定义4000米、摘要同步，请求含完整新条件与精确selection', () => {
  const { form, request } = rec.applyNegotiationOption('wider', pending(), originalForm)
  assert.deepEqual(form, { ...originalForm, radius: 'custom', custom_radius: '4000' })
  const synced = preferencesFromForm(form)
  assert.deepEqual(synced.preferences, { ...original, radius_meters: 4000 })
  assert.match(describePreferences(synced.preferences), /4 公里内/)
  assert.deepEqual(request, { preferences: { ...original, radius_meters: 4000 }, selection: { option_id: 'wider', previous_preferences: original, changes: { radius_meters: 4000 } } })
  assert.deepEqual(normalizeRecommendationRequest(request), request)
})

test('接受替代品类时显式写入具体品类并同步摘要，其他字段不变', () => {
  const { form, request } = rec.applyNegotiationOption('swap', pending(), originalForm)
  assert.deepEqual(form, { ...originalForm, food_requirement: '冒菜' })
  assert.equal(request.preferences.radius_meters, 2000)
  assert.match(describePreferences(request.preferences), /品类：冒菜/)
  assert.deepEqual(rec.describeChanges(original, { food_requirement: '冒菜' }), [{ field: '品类', before: '四川火锅', after: '冒菜' }])
})

test('选单无法精确表示的差异（2家）、预设与自定义价格的映射', () => {
  assert.throws(() => rec.applyNegotiationOption('two', pending(), originalForm))
  assert.deepEqual(rec.formWithChanges(originalForm, { max_price_cny: null }), { ...originalForm, price: 'none', custom_price: '' })
  assert.deepEqual(rec.formWithChanges(originalForm, { max_price_cny: 80, radius_meters: 5000 }), { ...originalForm, price: 'custom', custom_price: '80', radius: '5000', custom_radius: '' })
})

test('“好的”等歧义文字、拒绝、未知方案或条件已改动都不会套用任何方案', () => {
  for (const reply of ['好的', '行', '可以', 'ok', '拒绝', '不要', '', 'wider ']) assert.throws(() => rec.applyNegotiationOption(reply, pending(), originalForm), undefined, reply)
  assert.throws(() => rec.applyNegotiationOption('wider', pending(), { ...originalForm, radius: '3000' }))
  assert.throws(() => rec.applyNegotiationOption('wider', pending(), { ...originalForm, radius: 'custom', custom_radius: '' }))
})

test('方案失效规则：代际（取消/新请求/新对话/退出）、位置或条件变化后不可恢复', () => {
  const decision = parseRecommendationDecision(JSON.stringify(needsChoice()))
  const address = { kind: 'address', address: { id: 7, label: '家', is_default: true, location: '116.4,39.9', description: '家' } }
  const key = rec.locationKey(address)
  assert.equal(key, rec.locationKey({ ...address }))
  assert.notEqual(key, rec.locationKey({ kind: 'coordinates', location: '116.4,39.9' }))
  assert.notEqual(key, rec.locationKey({ ...address, address: { ...address.address, id: 8 } }))
  assert.equal(rec.locationKey(null), '')
  const negotiation = { generation: 3, locationKey: key, preferences: original, decision }
  const now = { generation: 3, locationKey: key, preferences: original }
  assert.equal(rec.isNegotiationCurrent(negotiation, now), true)
  for (const changed of [{ generation: 4 }, { locationKey: 'coordinates:116.4,39.9' }, { preferences: { ...original, radius_meters: 3000 } }, { preferences: null }]) {
    assert.equal(rec.isNegotiationCurrent(negotiation, { ...now, ...changed }), false, JSON.stringify(changed))
  }
})

test('替代候选偏离项依据原条件三态标出，未知仅标待核实', () => {
  const [far, near] = parseRecommendationDecision(JSON.stringify(needsChoice())).assessments
  assert.deepEqual(rec.candidateNotes(far, original), [{ kind: 'deviation', text: '超出原搜索范围' }, { kind: 'unknown', text: '价格待核实' }])
  assert.deepEqual(rec.candidateNotes(near, original), [{ kind: 'deviation', text: '品类与原要求不符' }])
  assert.deepEqual(rec.candidateNotes(far, { ...original, max_price_cny: null }), [{ kind: 'deviation', text: '超出原搜索范围' }])
  assert.deepEqual(rec.candidateNotes(undefined, original), [{ kind: 'unknown', text: '评估信息缺失' }])
})

test('带候选的 needs_choice 流：decision 与 done 同一快照才算成功', async () => {
  const decision = needsChoice()
  const event = (name, data) => `event:${name}\ndata:${JSON.stringify(data)}\n\n`
  const done = (d) => event('done', { answer_text: '请选择', places: [], places_count: 0, status: 'needs_choice', preferences: original, decision: d })
  const stream = (text) => new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode(text)); controller.close() } })
  const events = []
  await readSSE(stream(event('decision', decision) + event('delta', { text: '请选择' }) + done(decision)), (item) => events.push(item))
  assert.deepEqual(events.at(-1).data.recommendation.decision.candidates, decision.candidates)
  const tampered = { ...decision, candidates: [{ ...decision.candidates[0], name: '被篡改' }, decision.candidates[1]] }
  await assert.rejects(readSSE(stream(event('decision', decision) + event('delta', { text: '请选择' }) + done(tampered)), () => {}))
})
