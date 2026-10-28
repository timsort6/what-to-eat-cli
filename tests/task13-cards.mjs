import { test } from 'node:test'
import assert from 'node:assert/strict'

const { amapLink } = await import('../.test-dist/mapLinks.js')
const protocol = await import('../.test-dist/protocol.js')
const { parseChatEvent } = protocol

const ORIGIN = 'https://uri.amap.com'
const location = '116.397,39.908'

test('真实 POI ID 优先生成固定域名商家详情链接，去空白后才校验', () => {
  assert.deepEqual(amapLink({ id: 'B000A7BD6C', name: '面馆', location }), { kind: 'detail', href: `${ORIGIN}/poidetail?poiid=B000A7BD6C&callnative=0` })
  assert.deepEqual(amapLink({ id: '  B0FFG1  ', name: '面馆', location: '' }), { kind: 'detail', href: `${ORIGIN}/poidetail?poiid=B0FFG1&callnative=0` })
  const longest = 'a'.repeat(64)
  assert.equal(amapLink({ id: longest, name: '', location: '' })?.href, `${ORIGIN}/poidetail?poiid=${longest}&callnative=0`)
})

const notIDs = ['poi:B0FFG1', 'synthetic:0f3a', 'a'.repeat(65), '', '   ', 'B0 FF', 'Ｂ０ＦＦ', '餐厅1', 'B0FF\u200b', 'B0FF&x=1', 'B0FF#x', '../B0',
  'https://evil.example/poidetail?poiid=1', 'javascript:alert(1)', '//evil.example', 'B0FF%26x']
for (const id of notIDs) test(`非 POI ID 不能生成详情链接：${JSON.stringify(id).slice(0, 40)}`, () => {
  const withCoordinates = amapLink({ id, name: '面馆', location })
  assert.equal(withCoordinates?.kind, 'position', '有合法坐标时只能退回位置标注')
  assert.equal(new URL(withCoordinates.href).pathname, '/marker')
  assert.equal(new URL(withCoordinates.href).searchParams.get('poiid'), null)
  assert.equal(amapLink({ id, name: '面馆', location: '' }), null, '无坐标时不得猜测商家页')
})

test('无可用 ID 的合法 GCJ-02 坐标生成 marker，经度在前且参数逐个编码', () => {
  const name = '张&李#店 中文?x=1/../@evil.example'
  const link = amapLink({ id: '', name, location })
  assert.equal(link?.kind, 'position')
  const url = new URL(link.href)
  assert.equal(url.origin, ORIGIN)
  assert.equal(url.pathname, '/marker')
  assert.equal(url.hash, '')
  assert.deepEqual([...url.searchParams.keys()], ['position', 'name', 'coordinate', 'callnative'], '名称中的 & 不能注入额外参数')
  assert.equal(url.searchParams.get('position'), '116.397,39.908')
  assert.equal(url.searchParams.get('name'), name)
  assert.equal(url.searchParams.get('coordinate'), 'gaode')
  assert.equal(url.searchParams.get('callnative'), '0')
  assert.ok(link.href.startsWith(`${ORIGIN}/marker?position=116.397,39.908&name=`), link.href)
  assert.equal(new URL(amapLink({ id: '', name: '  ', location: '-0.5,0' }).href).searchParams.get('name'), '推荐地点')
})

test('marker 坐标沿用已校验的原字符串，极小值不变成指数写法', () => {
  for (const location of ['0.0000001,-0.0000005', '116.400000,39.900000', '-0,0']) {
    const link = amapLink({ id: '', name: '点', location })
    assert.ok(link.href.startsWith(`${ORIGIN}/marker?position=${location}&`), link.href)
    assert.equal(new URL(link.href).searchParams.get('position'), location)
  }
})

for (const bad of ['NaN,39.9', '116.4,NaN', 'Infinity,39.9', '181,30', '-180.0001,30', '116.4,91', '116.4,-90.5', '39.908,116.397', '', '116.4', '116.4,39.9,1',
  ' , ', '0x10,20', '1e2,20', '116.4;39.9', '116.4, 39.9extra']) test(`非法或颠倒坐标不生成链接：${JSON.stringify(bad)}`, () => {
  assert.equal(amapLink({ id: 'poi:X', name: '面馆', location: bad }), null)
})

test('不接受模型或原始数据中的 URL 字段，origin 恒定', () => {
  assert.equal(amapLink({ id: '', name: '面馆', location: '', url: 'https://uri.amap.com/poidetail?poiid=EVIL', href: 'javascript:alert(1)' }), null)
  for (const place of [{ id: 'B0', name: '//evil.example', location }, { id: '', name: 'https://evil.example/', location }, { id: '', name: '@evil.example', location: '180,-90' }]) {
    assert.equal(new URL(amapLink(place).href).origin, ORIGIN)
  }
})

const done = (places) => JSON.stringify({ answer_text: '推荐', places })
test('done 卡片保留真实 ID、候选键、坐标与来源三态；未知价格不保留数值', () => {
  const evaluation = (price) => ({ candidate_id: 'poi:P1', range: { state: 'satisfied', fields: ['location'] }, food: { state: 'unknown', fields: [] }, price: { state: price, fields: price === 'unknown' ? [] : ['business.cost'] } })
  const event = parseChatEvent('done', done([
    { id: 'P1', candidate_key: 'poi:P1', name: '面馆', address: '一号路', location, distance: '812.4', type: '餐饮服务;中餐厅', cost: '45', cost_currency: 'CNY', cost_basis: 'per_person', evaluation: evaluation('satisfied'), url: 'https://evil.example' },
    { candidate_key: 'synthetic:ab', name: '小馆', cost: '99', evaluation: evaluation('unknown') },
    { id: 'P3', name: '旧版' },
  ]))
  assert.deepEqual(event.data.places, [
    { id: 'P1', candidate_key: 'poi:P1', name: '面馆', address: '一号路', location, distance: '812.4', type: '餐饮服务;中餐厅', cost: '45', states: { range: 'satisfied', food: 'unknown', price: 'satisfied' } },
    { id: '', candidate_key: 'synthetic:ab', name: '小馆', address: '', location: '', distance: '', type: '', cost: '', states: { range: 'satisfied', food: 'unknown', price: 'unknown' } },
    { id: 'P3', candidate_key: '', name: '旧版', address: '', location: '', distance: '', type: '', cost: '', states: null },
  ])
  // 人民币+人均口径，或缺币种/口径（高德参考人均，后端已按人民币人均比较）保留数值；明确的其他币种/口径即使状态已知也只显示“价格待核实”。
  const priced = (currency, basis) => parseChatEvent('done', done([{ name: '价', cost: '45', cost_currency: currency, cost_basis: basis, evaluation: evaluation('satisfied') }])).data.places[0].cost
  for (const [currency, basis] of [['CNY', 'per_person'], ['RMB', '人均'], ['人民币', 'per_person'], ['cny', 'PER_PERSON'], ['', ''], [undefined, undefined], ['CNY', ''], ['', 'per_person']]) assert.equal(priced(currency, basis), '45', `${currency}/${basis}`)
  for (const [currency, basis] of [['USD', 'per_person'], ['HKD', '人均'], ['CNY', 'total'], ['CNY', 'per_table'], ['CNY ', 'per_person'], ['元', 'per_person']]) assert.equal(priced(currency, basis), '', `${currency}/${basis}`)
  assert.equal(typeof protocol.priceLabel, 'function', '卡片价格文案由 protocol.priceLabel 提供')
  assert.equal(protocol.priceLabel('94.00'), '参考人均 ¥94.00')
  for (const cost of ['', '约30', '30-100']) assert.equal(protocol.priceLabel(cost), '价格待核实', cost)
  for (const broken of [{ evaluation: 'x' }, { evaluation: { range: { state: 'yes' }, food: { state: 'unknown' }, price: { state: 'unknown' } } }, { location: 39.9 }, { candidate_key: 1 }]) {
    assert.throws(() => parseChatEvent('done', done([{ name: '坏', ...broken }])), /推荐店铺/)
  }
})
