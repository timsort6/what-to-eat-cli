import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ApiError } from '../.test-dist/protocol.js'
import { parseLocationSearchInput } from '../.test-dist/locationSearch.js'

export function registerSearchErrorRegressions(searchFixture) {
  test('地点输入去空白且按字符校验，超限不静默截断', () => {
    const input = { query: ' 公园 ', city: ' 北京 ' }
    assert.deepEqual(parseLocationSearchInput(input), { query: '公园', city: '北京' })
    assert.equal(parseLocationSearchInput({ query: '𠮷'.repeat(80), city: '' }).query.length, 160)
    for (const query of ['', ' ', '文'.repeat(81)]) assert.throws(() => parseLocationSearchInput({ query, city: '' }))
    assert.throws(() => parseLocationSearchInput({ query: '公园', city: '城'.repeat(101) }))
  })
  for (const failure of [new TypeError('Failed to fetch'), new TypeError('NetworkError'), new ApiError('上游暂不可用', 502), new ApiError('超时', 504)]) test(`请求失败提供恢复说明但不误标有效字段：${failure.message}`, async t => {
    const f = searchFixture(t)
    f.picker.update({ query: '公园', city: '北京' }); t.mock.timers.tick(300)
    f.calls[0].reject(failure); await Promise.resolve()
    assert.deepEqual(f.state().invalidFields, [])
    assert.doesNotMatch(f.state().error, /Failed to fetch|NetworkError/)
    assert.match(f.state().error, /网络|上游|超时/)
    assert.match(f.state().error, /重试|重新搜索/)
  })

  for (const field of ['query', 'city']) test(`超限只标记对应字段并说明限制：${field}`, t => {
    const f = searchFixture(t)
    const input = { query: '公园', city: '北京', [field]: '文'.repeat(field === 'query' ? 81 : 101) }
    f.picker.update(input)
    assert.deepEqual(f.state().invalidFields, [field])
    assert.match(f.state().error, field === 'query' ? /搜索地点.*80/ : /城市.*100/)
    assert.equal(f.calls.length, 0)
  })
  test('尚未输入关键词时城市超限也只标记城市', t => {
    const f = searchFixture(t)
    f.picker.update({ query: '', city: '城'.repeat(101) })
    assert.deepEqual(f.state().invalidFields, ['city'])
    assert.match(f.state().error, /城市.*100/)
    assert.equal(f.calls.length, 0)
  })
}
