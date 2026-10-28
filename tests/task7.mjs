import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { build } from 'vite'
import { addressLabelError, buildCreateAddressRequest, parseAddress, savableChoice } from '../.test-dist/protocol.js'

const searched = { kind: 'coordinates', location: '116.4,39.9', name: ' 测试公园 ', address: '东门', source: 'search' }
const located = { kind: 'coordinates', location: '116.403243,39.909403' }

test('新增地址请求体只含已确认地点的真实字段，定位坐标不编造门牌', () => {
  assert.deepEqual(buildCreateAddressRequest(' 家 ', searched, false), { label: '家', location: '116.4,39.9', is_default: false, name: '测试公园', address: '东门' })
  assert.deepEqual(buildCreateAddressRequest('公司', located, true), { label: '公司', location: '116.403243,39.909403', is_default: true })
})

test('未确认有效地点或标签非法时不能构造保存请求', () => {
  const saved = { kind: 'address', address: { id: 1, label: '家', is_default: true, location: '116.4,39.9', description: '' } }
  for (const choice of [null, saved, { kind: 'coordinates', location: '181,39' }]) {
    assert.equal(savableChoice(choice), false)
    assert.throws(() => buildCreateAddressRequest('家', choice, false))
  }
  assert.match(addressLabelError('  '), /地址标签/)
  assert.equal(addressLabelError('𠮷'.repeat(64)), '')
  assert.match(addressLabelError('文'.repeat(65)), /64/)
  assert.throws(() => buildCreateAddressRequest(' ', searched, false))
})

test('创建响应在边界解析，格式异常失败关闭', () => {
  assert.deepEqual(parseAddress({ id: 9, label: '家', is_default: true, location: '116.4,39.9', name: '测试公园' }),
    { id: 9, label: '家', is_default: true, location: '116.4,39.9', description: '测试公园' })
  for (const bad of [null, { id: '9', label: '家', is_default: true, location: '1,1' }, { id: 9, label: '家', location: '1,1' }]) assert.throws(() => parseAddress(bad))
})

test('createAddress 使用认证 POST 一次，透传服务器默认规则并区分 401/500', async t => {
  const requests = []
  const replies = [
    [200, { code: 200, data: { id: 5, label: '家', is_default: true, location: '116.4,39.9', address: '东门' } }],
    [500, { code: 500, message: '服务器内部错误' }],
    [401, { code: 401, message: '登录已过期' }],
    [200, { code: 200, data: { id: 'bad' } }],
  ]
  const server = createServer(async (request, response) => {
    const chunks = []
    for await (const chunk of request) chunks.push(chunk)
    requests.push({ path: request.url, method: request.method, token: request.headers.authorization, type: request.headers['content-type'], body: JSON.parse(Buffer.concat(chunks).toString()) })
    const [status, body] = replies.shift()
    response.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(body))
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise(resolve => server.close(resolve)))
  const bundle = await build({ configFile: false, logLevel: 'silent', define: { 'import.meta.env.VITE_API_BASE_URL': JSON.stringify(`http://127.0.0.1:${server.address().port}`) },
    build: { write: false, minify: false, lib: { entry: 'src/api.ts', formats: ['es'] } } })
  const output = Array.isArray(bundle) ? bundle[0] : bundle
  const api = await import(`data:text/javascript;base64,${Buffer.from(output.output[0].code).toString('base64')}`)
  Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, value: { getItem: () => 'fixture-token' } })
  t.after(() => { delete globalThis.sessionStorage })
  const signal = new AbortController().signal
  const body = buildCreateAddressRequest('家', searched, false)
  const created = await api.createAddress(body, signal)
  assert.deepEqual(created, { id: 5, label: '家', is_default: true, location: '116.4,39.9', description: '东门' })
  await assert.rejects(api.createAddress(body, signal), error => error.status === 500 && /服务器内部错误/.test(error.message))
  await assert.rejects(api.createAddress(body, signal), error => error.status === 401)
  await assert.rejects(api.createAddress(body, signal), /地址格式异常/)
  assert.deepEqual(requests[0], { path: '/api/v1/addresses', method: 'POST', token: 'Bearer fixture-token', type: 'application/json',
    body: { label: '家', location: '116.4,39.9', is_default: false, name: '测试公园', address: '东门' } })
  assert.equal(requests.length, 4)
})
