import { execFileSync } from 'node:child_process'
import { test } from 'node:test'
import assert from 'node:assert/strict'

execFileSync(process.execPath, [
  'node_modules/typescript/bin/tsc', 'src/protocol.ts', 'src/sse.ts', 'src/coordinates.ts',
  '--target', 'ES2022', '--module', 'ESNext', '--moduleResolution', 'Bundler',
  '--strict', '--noUncheckedIndexedAccess', '--exactOptionalPropertyTypes',
  '--skipLibCheck', '--outDir', '.test-dist', '--noEmitOnError',
], { stdio: 'inherit' })
const { readSSE, createSSEParser } = await import('../.test-dist/sse.js')
const { validLocation, parseAddresses } = await import('../.test-dist/protocol.js')
const { wgs84ToGcj02 } = await import('../.test-dist/coordinates.js')

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
})
