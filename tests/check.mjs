import { execFileSync } from 'node:child_process'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { build } from 'vite'

execFileSync(process.execPath, [
  'node_modules/typescript/bin/tsc', 'src/protocol.ts', 'src/sse.ts', 'src/coordinates.ts', 'src/recommendation.ts', 'src/locationSearch.ts', 'src/markdownThrottle.ts', 'src/mapLinks.ts',
  '--target', 'ES2022', '--module', 'ESNext', '--moduleResolution', 'Bundler',
  '--strict', '--noUncheckedIndexedAccess', '--exactOptionalPropertyTypes',
  '--skipLibCheck', '--outDir', '.test-dist', '--noEmitOnError',
], { stdio: 'inherit' })
const { readSSE, createSSEParser } = await import('../.test-dist/sse.js')
const { ApiError, validLocation, parseAddresses, parseLocationCandidates, buildChatMessages, commitChatTurn, isCurrentGeneration } = await import('../.test-dist/protocol.js')
const { wgs84ToGcj02 } = await import('../.test-dist/coordinates.js')
const { createLocationSearch } = await import('../.test-dist/locationSearch.js')
await import('./recommendation.mjs')
await import('./markdown-answer.mjs')
await import('./task7.mjs')
await import('./task11-sse.mjs')
await import('./task12-negotiation.mjs')
await import('./task13-cards.mjs')
await import('./task16-interpretation.mjs')
await import('./task17-clear-food.mjs')

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
const done = 'event: done\ndata: {"answer_text":"热汤 面", "places":[]}\n\n'

test('逐字节读取时保留中文、空格与 CRLF 事件边界', async () => {
  const text = ': 心跳\r\nevent: delta\r\ndata: {"text":"热汤 "}\r\n\r\nevent: delta\r\ndata: {"text":"面"}\r\n\r\n' + done
  const events = []
  await readSSE(byteStream(text), (event) => events.push(event))
  assert.deepEqual(events, [
    { kind: 'delta', text: '热汤 ' }, { kind: 'delta', text: '面' },
    { kind: 'done', data: { answer_text: '热汤 面', places: [] } },
  ])
})

test('跨 chunk 的单 CR 换行与多 data 行组成一个事件', () => {
  const events = []
  const parser = createSSEParser((event) => events.push(event))
  parser.feed('event: delta\rdata: {"text":\rdata: "汤"}\r')
  parser.feed('\r')
  parser.feed(done)
  parser.finish()
  assert.equal(events[0].text, '汤')
})

test('未知事件和注释不会阻断后续 done', async () => {
  const events = []
  await readSSE(byteStream(': 注释\n\nevent: metadata\ndata: non-json\n\n' + done, 1000), (event) => events.push(event))
  assert.equal(events.length, 1)
  assert.equal(events[0].kind, 'done')
})

test('收到 error 后立即释放仍保持连接的流', async () => {
  let cancelled = false
  const stream = new ReadableStream({
    start(controller) { controller.enqueue(new TextEncoder().encode('event: error\ndata: {"message":"失败"}\n\n')) },
    cancel() { cancelled = true },
  })
  const events = []
  await readSSE(stream, (event) => events.push(event))
  assert.deepEqual(events, [{ kind: 'error', message: '失败' }])
  assert.equal(cancelled, true)
})

test('只有 delta 然后 EOF 必须报中断且保留已收到的内容', async () => {
  const events = []
  await assert.rejects(readSSE(byteStream('event: delta\ndata: {"text":"部分内容"}\n\n'), (event) => events.push(event)))
  assert.deepEqual(events, [{ kind: 'delta', text: '部分内容' }])
})

test('完全空的 HTTP 响应不能当作推荐完成', async () => {
  await assert.rejects(readSSE(byteStream(''), () => {}))
})

test('没有空行提交的尾部事件不能当作 done', async () => {
  await assert.rejects(readSSE(byteStream('event: done\ndata: {"answer_text":"汤","places":[]}'), () => {}))
})

test('非法 JSON 和非法最终结构会报错', async () => {
  await assert.rejects(readSSE(byteStream('event: delta\ndata: broken\n\n'), () => {}))
  await assert.rejects(readSSE(byteStream('event: done\ndata: {"places":[]}\n\n'), () => {}))
})

test('done 空内容是有效的终止事件，由页面显示空结果', async () => {
  const events = []
  await readSSE(byteStream('event: done\ndata: {"answer_text":"","places":[]}\n\n'), (event) => events.push(event))
  assert.deepEqual(events, [{ kind: 'done', data: { answer_text: '', places: [] } }])
})

test('网络流异常必须传播', async () => {
  const stream = new ReadableStream({ start(controller) { controller.error(new TypeError('network')) } })
  await assert.rejects(readSSE(stream, () => {}), TypeError)
})

test('坐标只接受完整、有限、范围内的经纬度，包括零点', () => {
  assert.equal(validLocation('0,0'), true)
  assert.equal(validLocation('-180,90'), true)
  for (const input of ['', ',30', '120,', '181,30', '120,91', 'NaN,1', 'Infinity,1', '120,30,0']) {
    assert.equal(validLocation(input), false, input)
  }
})

test('中国境内 WGS84 坐标转换为六位 GCJ02，境外坐标保持原样', () => {
  assert.equal(wgs84ToGcj02(116.397, 39.908), '116.403243,39.909403')
  assert.equal(wgs84ToGcj02(-73.9857, 40.7484), '-73.9857,40.7484')
})

test('地址列表使用实际 envelope 的 items 结构，格式错误不能显示为空列表', () => {
  const data = { total: 1, items: [{ id: 7, label: '公司', is_default: true, location: '116.4,39.9', formatted_address: '测试地址' }] }
  assert.deepEqual(parseAddresses(data), [{ id: 7, label: '公司', is_default: true, location: '116.4,39.9', description: '测试地址' }])
  assert.throws(() => parseAddresses({ items: 'invalid' }))
  const base = { id: 8, label: '测试公园', is_default: false, location: '116.4,39.9' }
  const described = (fields) => parseAddresses({ items: [{ ...base, ...fields }] })[0].description
  assert.equal(described({ name: '测试公园', address: '东门' }), '测试公园 · 东门')
  assert.equal(described({ name: '测试公园', formatted_address: '北京市测试路1号', address: '东门' }), '测试公园 · 北京市测试路1号')
  assert.equal(described({ name: '东门', address: '东门' }), '东门')
  assert.equal(described({ name: ' ', address: '东门' }), '东门')
  assert.equal(described({ name: '测试公园' }), '测试公园')
  assert.equal(described({}), '116.4,39.9')
})

test('成功轮次会按 user/assistant 顺序进入下一轮请求', () => {
  const first = commitChatTurn([], { user: '面馆两公里', assistant: '附近有一家面馆', completed: true })
  assert.deepEqual(buildChatMessages(first, '清淡些，距离不变'), [
    { role: 'user', content: '面馆两公里' },
    { role: 'assistant', content: '附近有一家面馆' },
    { role: 'user', content: '清淡些，距离不变' },
  ])
})

test('未完成轮次不会进入历史', () => {
  const history = [{ user: '面馆两公里', assistant: '附近有一家面馆' }]
  assert.deepEqual(commitChatTurn(history, { user: '清淡些', assistant: '部分回答', completed: false }), history)
})

test('取消或重置后的旧代际不能通过流信号继续更新状态', () => {
  const controller = new AbortController()
  assert.equal(isCurrentGeneration(1, 1, controller.signal), true)
  controller.abort()
  assert.equal(isCurrentGeneration(1, 1, controller.signal), false)
  assert.equal(isCurrentGeneration(1, 2, new AbortController().signal), false)
})

const candidate = { id: '', name: '公园', address: '东门', city: '北京', location: '116.4,39.9' }
function searchFixture(t) {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const parent = new AbortController()
  const calls = [], states = [], confirmed = [], expired = []
  const picker = createLocationSearch({
    search: (input, signal) => new Promise((resolve, reject) => calls.push({ input, signal, resolve, reject })),
    changed: state => states.push(state), confirmed: choice => confirmed.push(choice), expired: () => expired.push(true),
  }, parent.signal)
  t.after(() => picker.dispose())
  return { picker, parent, calls, states, confirmed, expired, state: () => states.at(-1) }
}

test('地点映射保留GCJ02与空POI标识，非法坐标和超量失败关闭', () => {
  const input = { items: [candidate] }
  assert.deepEqual(parseLocationCandidates(input), [candidate])
  assert.deepEqual(parseLocationCandidates({ items: [] }), [])
  for (const items of [null, Array(11).fill(candidate), [{ ...candidate, location: '181,39' }], [{ ...candidate, name: '' }], [{ ...candidate, city: null }]]) {
    assert.throws(() => parseLocationCandidates({ items }))
  }
})

test('快速输入仅在最后输入300ms后查询且不确认任何位置', t => {
  const f = searchFixture(t)
  f.picker.update({ query: '公', city: '' }); t.mock.timers.tick(299)
  assert.equal(f.calls.length, 0)
  f.picker.update({ query: ' 公园 ', city: ' 北京 ' }); t.mock.timers.tick(299)
  assert.equal(f.calls.length, 0)
  t.mock.timers.tick(1)
  assert.deepEqual(f.calls.map(call => call.input), [{ query: '公园', city: '北京' }])
  assert.deepEqual(f.confirmed, [])
})

for (const action of ['新查询', '清空', '取消模式', '会话中止', '销毁']) test(`${action}使旧请求及其迟到成功和401失效`, async t => {
  const f = searchFixture(t)
  f.picker.update({ query: '旧', city: '' }); t.mock.timers.tick(300)
  f.picker.update({ query: '新', city: '' }); t.mock.timers.tick(300)
  if (action === '清空') f.picker.update({ query: '', city: '' })
  if (action === '取消模式') f.picker.cancel()
  if (action === '会话中止') f.parent.abort()
  if (action === '销毁') f.picker.dispose()
  f.calls[0].reject(new ApiError('过期', 401))
  f.calls[1].resolve([candidate]); await Promise.resolve()
  assert.equal(f.calls[0].signal.aborted, true)
  assert.deepEqual(f.state().items, action === '新查询' ? [candidate] : [])
  assert.deepEqual(f.expired, [])
})

test('已取消的迟到成功不能覆盖后发响应', async t => {
  const f = searchFixture(t)
  f.picker.update({ query: '旧', city: '' }); t.mock.timers.tick(300)
  f.picker.update({ query: '新', city: '' }); t.mock.timers.tick(300)
  const newer = { ...candidate, name: '新公园' }
  f.calls[1].resolve([newer]); await Promise.resolve()
  f.calls[0].resolve([candidate]); await Promise.resolve()
  assert.deepEqual(f.state().items, [newer])
})

test('输入与候选点选均不提交，只有显式确认才发兼容坐标且不重复转换', async t => {
  const f = searchFixture(t)
  f.picker.update({ query: '116.4,39.9', city: '' }); f.picker.confirm()
  t.mock.timers.tick(300); f.calls[0].resolve([candidate]); await Promise.resolve()
  f.picker.select(0)
  assert.deepEqual(f.confirmed, [])
  f.picker.confirm(); f.picker.confirm()
  assert.deepEqual(f.confirmed, [{ kind: 'coordinates', location: '116.4,39.9', name: '公园', address: '东门', source: 'search' }])
  assert.equal(f.confirmed[0].kind === 'coordinates' ? f.confirmed[0].location : null, '116.4,39.9')
  assert.equal(f.calls.length, 1)
})

for (const action of ['修改城市', '清空', 'Escape', '模式切换', '非法坐标']) test(`${action}后不能确认旧候选`, async t => {
  const f = searchFixture(t)
  f.picker.update({ query: '公园', city: '' }); t.mock.timers.tick(300)
  f.calls[0].resolve([{ ...candidate, location: action === '非法坐标' ? 'NaN,39' : candidate.location }]); await Promise.resolve()
  f.picker.select(0)
  if (action === '修改城市') f.picker.update({ query: '公园', city: '上海' })
  if (action === '清空') f.picker.update({ query: '', city: '' })
  if (action === 'Escape' || action === '模式切换') f.picker.cancel()
  f.picker.confirm()
  assert.deepEqual(f.confirmed, [])
})

test('超时主动中止请求且忽略迟到结果', async t => {
  const f = searchFixture(t)
  f.picker.update({ query: '公园', city: '' }); t.mock.timers.tick(300); t.mock.timers.tick(10000)
  assert.equal(f.calls[0].signal.aborted, true)
  f.calls[0].resolve([candidate]); await Promise.resolve()
  assert.equal(f.state().phase, 'error')
  assert.equal(f.state().selected, null)
})

for (const result of [[], new TypeError('离线'), new ApiError('登录过期', 401), new ApiError('超时', 504)]) test(`空、网络失败、401和超时分别处理：${result.status ?? result.name ?? 'empty'}`, async t => {
  const f = searchFixture(t)
  f.picker.update({ query: '公园', city: '' }); t.mock.timers.tick(300)
  if (Array.isArray(result)) f.calls[0].resolve(result)
  else f.calls[0].reject(result)
  await Promise.resolve()
  assert.equal(f.state().phase, Array.isArray(result) ? 'empty' : 'error')
  assert.equal(f.state().selected, null)
  assert.equal(f.expired.length, result.status === 401 ? 1 : 0)
})

const { registerSearchErrorRegressions } = await import('./task6-errors.mjs')
registerSearchErrorRegressions(searchFixture)
if (process.env.TASK6_BROWSER_LOADER) await import('./task6-browser.mjs')

test('搜索API使用认证GET、编码参数及真实items映射，确认前后无地址写入', async t => {
  const requests = []
  const server = createServer((request, response) => {
    requests.push({ url: new URL(request.url, 'http://fixture'), method: request.method, token: request.headers.authorization })
    response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ code: 200, data: { items: [candidate] } }))
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise(resolve => server.close(resolve)))
  const bundle = await build({ configFile: false, logLevel: 'silent', define: { 'import.meta.env.VITE_API_BASE_URL': JSON.stringify(`http://127.0.0.1:${server.address().port}`) },
    build: { write: false, minify: false, lib: { entry: 'src/api.ts', formats: ['es'] } } })
  const output = Array.isArray(bundle) ? bundle[0] : bundle
  const api = await import(`data:text/javascript;base64,${Buffer.from(output.output[0].code).toString('base64')}`)
  Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, value: { getItem: () => 'fixture-token' } })
  t.after(() => { delete globalThis.sessionStorage })
  const results = await api.searchLocations({ query: ' 公园 & 门 ', city: ' 北京 ' }, new AbortController().signal)
  await api.searchLocations({ query: '公园', city: '' }, new AbortController().signal)
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const confirmed = []
  const picker = createLocationSearch({ search: async () => results, changed: () => {}, confirmed: choice => confirmed.push(choice), expired: () => {} }, new AbortController().signal)
  picker.update({ query: '公园', city: '' }); t.mock.timers.tick(300); await Promise.resolve()
  picker.select(0); picker.confirm(); picker.dispose()
  assert.equal(confirmed[0].location, candidate.location)
  assert.deepEqual(results, [candidate])
  assert.deepEqual(requests.map(({ url, method, token }) => [url.pathname, url.searchParams.get('query'), url.searchParams.get('city'), method, token]), [
    ['/api/v1/locations/search', '公园 & 门', '北京', 'GET', 'Bearer fixture-token'],
    ['/api/v1/locations/search', '公园', null, 'GET', 'Bearer fixture-token'],
  ])
})
