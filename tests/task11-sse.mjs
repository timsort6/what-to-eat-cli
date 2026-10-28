import { test } from 'node:test'
import assert from 'node:assert/strict'

const { readSSE } = await import('../.test-dist/sse.js')

function byteStream(text, chunkSize = 1) {
  const bytes = new TextEncoder().encode(text)
  let offset = 0
  return new ReadableStream({
    pull(controller) {
      if (offset === bytes.length) return controller.close()
      controller.enqueue(bytes.slice(offset, offset + chunkSize))
      offset = Math.min(bytes.length, offset + chunkSize)
    },
  })
}
const event = (name, data) => `event:${name}\ndata:${typeof data === 'string' ? data : JSON.stringify(data)}\n\n`
const preferences = { target_count: 1, radius_meters: 2000, meal_style: 'any', max_price_cny: 50, allow_unknown_price: true, food_requirement: '四川火锅' }
const assessment = (id, range) => ({ candidate_id: id, range: { state: range, fields: ['location'] }, food: { state: 'satisfied', fields: ['tag'] }, price: { state: 'unknown', fields: [] } })
const ready = { status: 'ready', selected_ids: ['poi:P1'], assessments: [assessment('poi:P1', 'satisfied')], reason_codes: ['unknown_price'], options: [] }
const needsChoice = {
  status: 'needs_choice', selected_ids: [], assessments: [assessment('poi:P2', 'unsatisfied')], reason_codes: ['outside_radius'],
  options: [{ option_id: 'wider', label: '扩大到4公里再查', observed_ids: ['poi:P2'], reason_codes: ['outside_radius'], changes: { radius_meters: 4000 } }],
}
const place = { id: 'P1', candidate_key: 'poi:P1', name: '餐厅', address: '', distance: '12', type: '火锅', evaluation: assessment('poi:P1', 'satisfied') }
const done = (decision, extra = {}) => event('done', {
  answer_text: '推荐 餐厅', places: decision.status === 'ready' ? [place] : [], places_count: decision.status === 'ready' ? 1 : 0,
  location: '0,0', status: decision.status, preferences, decision, ...extra,
})
async function collect(text, chunkSize = 1) {
  const events = []
  await readSSE(byteStream(text, chunkSize), (item) => events.push(item))
  return events
}

const parsedPlace = { id: 'P1', candidate_key: 'poi:P1', name: '餐厅', address: '', location: '', distance: '12', type: '火锅', cost: '', states: { range: 'satisfied', food: 'satisfied', price: 'unknown' } }
for (const [name, decision, places] of [['ready', ready, [parsedPlace]], ['needs_choice', needsChoice, []]]) {
  test(`新版 ${name}：decision→delta→done 逐字节解析，done 带同一快照且旧字段可读`, async () => {
    const events = await collect(event('decision', decision) + event('metadata', 'ignored') + event('delta', { text: '推荐 ' }) + event('delta', { text: '餐厅' }) + done(decision))
    assert.deepEqual(events.map((item) => item.kind), ['decision', 'delta', 'delta', 'done'])
    assert.deepEqual(events[0].decision, decision)
    assert.deepEqual(events[3].data, { answer_text: '推荐 餐厅', places, recommendation: { status: name, preferences, decision } })
  })
}

test('done 中决策字段顺序不同但内容一致视为同一快照', async () => {
  const reordered = { options: [], reason_codes: ['unknown_price'], assessments: ready.assessments, selected_ids: ['poi:P1'], status: 'ready' }
  const events = await collect(event('decision', ready) + event('delta', { text: '汤' }) + done(reordered), 4096)
  assert.equal(events.at(-1).data.recommendation.status, 'ready')
})

test('旧服务端无 decision 且 done 无 status：作为旧版文本结果，不构造推荐决策', async () => {
  const events = await collect(event('delta', { text: '面' }) + event('done', { answer_text: '面', places: [{ id: 'P1', name: '面馆' }], places_count: 1 }))
  assert.deepEqual(events.at(-1), { kind: 'done', data: { answer_text: '面', places: [{ id: 'P1', candidate_key: '', name: '面馆', address: '', location: '', distance: '', type: '', cost: '', states: null }] } })
  assert.equal('recommendation' in events.at(-1).data, false)
})

const rejected = {
  'delta 先于 decision': event('delta', { text: '抢跑' }) + event('decision', ready) + done(ready),
  '重复 decision': event('decision', ready) + event('decision', ready) + event('delta', { text: '汤' }) + done(ready),
  '新版 done 之前没有 decision': event('delta', { text: '汤' }) + done(ready),
  '收到 decision 但 done 为旧版形状': event('decision', ready) + event('delta', { text: '汤' }) + event('done', { answer_text: '汤', places: [place] }),
  'done 决策与事件矛盾': event('decision', ready) + event('delta', { text: '汤' }) + done({ ...ready, reason_codes: [] }),
  'done 状态与决策矛盾': event('decision', ready) + event('delta', { text: '汤' }) + done(ready, { status: 'needs_choice' }),
  'done 只带部分新版字段': event('decision', ready) + event('delta', { text: '汤' }) + event('done', { answer_text: '汤', places: [place], status: 'ready' }),
  'done 条件不完整': event('decision', ready) + event('delta', { text: '汤' }) + done(ready, { preferences: { radius_meters: 2000 } }),
  'ready 卡片不是已选候选': event('decision', ready) + event('delta', { text: '汤' }) + done(ready, { places: [{ ...place, candidate_key: 'poi:P9' }] }),
  'ready 卡片缺失': event('decision', ready) + event('delta', { text: '汤' }) + done(ready, { places: [] }),
  'needs_choice 仍带卡片': event('decision', needsChoice) + event('delta', { text: '汤' }) + done(needsChoice, { places: [place] }),
  'decision 坏 JSON': event('decision', '{"status":') + event('delta', { text: '汤' }) + done(ready),
  'decision 含未知字段': event('decision', { ...ready, raw: 'x' }) + event('delta', { text: '汤' }) + done(ready),
  'decision 选项超过3个': event('decision', { ...needsChoice, options: [1, 2, 3, 4].map((n) => ({ ...needsChoice.options[0], option_id: `o${n}` })) }) + done(needsChoice),
  '决策后断流无 done': event('decision', ready) + event('delta', { text: '部分' }),
}
for (const [name, text] of Object.entries(rejected)) {
  test(`受控失败且不产生成功 done：${name}`, async () => {
    const events = []
    await assert.rejects(readSSE(byteStream(text), (item) => events.push(item)), (error) => error.name === 'ApiError')
    assert.equal(events.some((item) => item.kind === 'done'), false)
  })
}

test('decision 后服务端 error 结束，无成功 done', async () => {
  const events = await collect(event('decision', ready) + event('error', { message: '失败' }) + done(ready))
  assert.deepEqual(events.map((item) => item.kind), ['decision', 'error'])
})

test('取消（流中止）在 decision 之后传播且无 done', async () => {
  const events = []
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(event('decision', ready)))
      controller.error(new DOMException('aborted', 'AbortError'))
    },
  })
  await assert.rejects(readSSE(stream, (item) => events.push(item)), (error) => error.name === 'AbortError')
  assert.equal(events.some((item) => item.kind === 'done'), false)
})
