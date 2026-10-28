import { test } from 'node:test'
import assert from 'node:assert/strict'

const { createThrottle } = await import('../.test-dist/markdownThrottle.js')

function fixture(t) {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const runs = []
  let now = 0
  const throttle = createThrottle(() => runs.push(now), 50)
  const advance = (ms) => { for (let i = 0; i < ms; i++) { now++; t.mock.timers.tick(1) } }
  return { throttle, runs, advance, at: () => now }
}

test('流式节流：首段立即渲染，每50ms窗口最多一次，尾部内容不丢', t => {
  const f = fixture(t)
  for (let i = 0; i < 100; i++) { f.throttle.push(); f.advance(3) }
  f.advance(200)
  assert.equal(f.runs[0], 0)
  for (let i = 1; i < f.runs.length; i++) assert.ok(f.runs[i] - f.runs[i - 1] >= 50, JSON.stringify(f.runs))
  assert.ok(f.runs.length <= Math.ceil(300 / 50) + 1, JSON.stringify(f.runs))
  assert.ok(f.runs.at(-1) >= 297, '最后一次推送之后必须有一次尾部渲染')
})

test('done 立即刷新且清除冷却期内的待渲染', t => {
  const f = fixture(t)
  f.throttle.push(); f.advance(10); f.throttle.push()
  f.throttle.flush()
  assert.deepEqual(f.runs, [0, 10])
  f.advance(500)
  assert.deepEqual(f.runs, [0, 10], 'flush 之后不能有迟到渲染')
})

test('取消/重置/卸载清除待执行定时器，不产生迟到渲染', t => {
  const f = fixture(t)
  f.throttle.push(); f.advance(5); f.throttle.push()
  f.throttle.cancel()
  f.advance(500)
  assert.deepEqual(f.runs, [0])
  f.throttle.push()
  assert.deepEqual(f.runs, [0, 505], '取消后新一轮首段立即渲染')
})
