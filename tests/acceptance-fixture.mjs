import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { extname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { guardedBrowserArgs, startNetworkGuard } from './browser-network-guard.mjs'

// 任务14本地受控夹具：地址簿/地点搜索/SSE 推荐全部由本进程应答，浏览器经共享拒绝代理启动（外部请求只计数并 403）。
// 与 task7/12/13 夹具同构，但合并为一次连贯旅程所需的全部端点；/agent/chat 挂起，由测试逐事件推送。
export const searchCandidate = { id: 'B000A1', name: '测试公园', city: '北京', address: '东门', location: '116.400000,39.900000' }

export const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
export async function until(check, message, timeout = 8000) {
  for (const deadline = Date.now() + timeout; !check();) {
    assert.ok(Date.now() < deadline, message)
    await pause(20)
  }
}

export async function openAcceptanceFixture(dist) {
  assert.ok(existsSync(join(dist, 'index.html')), `构建产物缺失：${dist}，请先 vite build`)
  const { TASK6_BROWSER_LOADER: loader, TASK6_BROWSER_PATH: browserPath } = process.env
  assert.ok(loader && browserPath, '请指定 TASK6_BROWSER_LOADER 与 TASK6_BROWSER_PATH（任务自有 Edge 与 browser 技能 loader）')
  const { loadOmowright } = await import(pathToFileURL(loader).href)
  const { omowright } = await loadOmowright()
  const profile = mkdtempSync(join(tmpdir(), 'task14-accept-profile-'))
  const posts = [], postPlan = [], chats = [], searches = [], strays = []
  let addresses = [], nextId = 1
  const server = createServer(async (request, response) => {
    const url = new URL(request.url, 'http://fixture')
    const json = (status, body) => response.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body))
    if (url.pathname.startsWith('/api/')) {
      const chunks = []
      for await (const chunk of request) chunks.push(chunk)
      const body = Buffer.concat(chunks).toString()
      if (url.pathname.endsWith('/me')) return json(200, { code: 200, data: { id: 1, username: '本地测试' } })
      if (url.pathname.endsWith('/locations/search')) { searches.push(url.search); return json(200, { code: 200, data: { items: [searchCandidate] } }) }
      if (url.pathname.endsWith('/addresses') && request.method === 'GET') return json(200, { code: 200, data: { total: addresses.length, items: addresses } })
      if (url.pathname.endsWith('/addresses') && request.method === 'POST') {
        const input = JSON.parse(body)
        posts.push(input)
        if (postPlan.shift() === 500) return json(500, { code: 500, message: '服务器内部错误' })
        // 与后端规则一致：首个地址自动默认，勾选默认时清除其他默认。
        const makeDefault = addresses.length === 0 || input.is_default === true
        if (makeDefault) addresses = addresses.map(item => ({ ...item, is_default: false }))
        const created = { id: nextId++, label: input.label.trim(), is_default: makeDefault, location: input.location, longitude: 0, latitude: 0,
          ...(input.name ? { name: input.name } : {}), ...(input.address ? { address: input.address } : {}) }
        addresses = [...addresses, created]
        return json(200, { code: 200, data: created })
      }
      if (url.pathname.endsWith('/agent/chat')) {
        response.on('error', () => {})
        const chat = { body: JSON.parse(body), response, writes: [], closed: false }
        response.on('close', () => { chat.closed = true })
        response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
        response.flushHeaders()
        chats.push(chat)
        return
      }
      return json(404, { code: 404, message: 'not found' })
    }
    if (url.pathname === '/favicon.ico') { response.writeHead(204).end(); return }
    const path = join(dist, url.pathname === '/' ? 'index.html' : url.pathname)
    try {
      let body = readFileSync(path)
      if (url.pathname === '/') body = Buffer.from(body.toString().replace('<head>', '<head><script>sessionStorage.setItem("food-agent-token","local-fixture")</script>'))
      response.writeHead(200, { 'content-type': ({ '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css' })[extname(path)] ?? 'application/octet-stream' }).end(body)
    } catch (failure) {
      if (failure.code !== 'ENOENT') throw failure
      // 非 API 且非构建产物的请求（如恶意 Markdown 的 /track）记为本地越界资源请求。
      strays.push(`${request.method} ${url.pathname}`)
      response.writeHead(404).end()
    }
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const guard = await startNetworkGuard('task14-acceptance')
  let browser
  const cleanup = { browserClosed: false, browserProcessExited: null, serverClosed: false, networkGuard: null, profileRemoved: false }
  async function close() {
    try { await browser?.close(); cleanup.browserClosed = true } catch (failure) { cleanup.browserError = String(failure) }
    if (cleanup.browserPid) {
      for (let i = 0; i < 50 && cleanup.browserProcessExited !== true; i++) {
        try { process.kill(cleanup.browserPid, 0); cleanup.browserProcessExited = false; await pause(100) } catch { cleanup.browserProcessExited = true }
      }
    }
    for (const chat of chats) chat.response.destroy()
    server.closeAllConnections()
    await new Promise(resolve => server.close(resolve)); cleanup.serverClosed = true
    try { cleanup.networkGuard = await guard.close() } catch (failure) { cleanup.networkGuard = { ...guard.report(), error: String(failure) } }
    rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
    cleanup.profileRemoved = !existsSync(profile)
    return cleanup
  }
  try {
    browser = await omowright.connectPipe({ browserPath, storageRoot: profile, browserArgs: guardedBrowserArgs(guard, profile) })
    cleanup.browserPid = browser.browserProcess.pid
    const page = await browser.newTab()
    const sid = await page.resolveSessionId()
    // 新标签页只记录首个 https 目标 URL（链接本身），截获后由 nextOpened 立即关闭。
    const opened = []
    const record = ({ targetInfo }) => {
      if (targetInfo.type === 'page' && targetInfo.url.startsWith('https://') && !opened.some(item => item.targetId === targetInfo.targetId)) opened.push({ targetId: targetInfo.targetId, url: targetInfo.url })
    }
    page.cdp.on('Target.targetCreated', record)
    page.cdp.on('Target.targetInfoChanged', record)
    await page.cdp.send('Target.setDiscoverTargets', { discover: true })
    const wait = (condition, arg = null) => page.evaluate(([source, value]) => new Promise((resolve, reject) => {
      const matches = new Function('arg', `return (${source})(arg)`)
      const deadline = performance.now() + 8000
      const check = () => matches(value) ? resolve(true) : performance.now() > deadline ? reject(new Error(`状态等待超时：${source}`)) : requestAnimationFrame(check)
      check()
    }), [condition.toString(), arg])
    const click = async selector => {
      const box = await page.evaluate(selector => {
        const node = document.querySelector(selector)
        node.scrollIntoView({ block: 'center' })
        const rect = node.getBoundingClientRect()
        return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 }
      }, selector)
      for (const type of ['mousePressed', 'mouseReleased']) await page.cdp.send('Input.dispatchMouseEvent', { type, ...box, button: 'left', buttons: type === 'mousePressed' ? 1 : 0, clickCount: 1 }, sid)
    }
    async function nextOpened(before) {
      await until(() => opened.length > before, '应打开新的高德标签页')
      await pause(100)
      const target = opened.at(-1)
      await page.cdp.send('Target.closeTarget', { targetId: target.targetId }).catch(() => {})
      return target.url
    }
    return { page, omowright, guard, posts, postPlan, chats, searches, strays, opened, cleanup, wait, click, nextOpened, close,
      origin: `http://127.0.0.1:${server.address().port}` }
  } catch (failure) { await close(); throw failure }
}

// SSE 推送：每次 write 都是独立的 HTTP 分块，并记录写出时刻供“决策先于正文/首块早于末块”断言。
export function send(chat, name, data) {
  chat.writes.push({ name, at: Date.now() })
  try { chat.response.write(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`) } catch { /* 已取消的连接写入失败即丢弃 */ }
}
export function done(chat, decision, answer, places = [], preferences = chat.body.preferences) {
  send(chat, 'done', { answer_text: answer, places, places_count: places.length, location: '116.4,39.9', status: decision.status, preferences, decision })
  chat.response.end()
}
export function respond(chat, decision, answer, places = [], preferences = chat.body.preferences) {
  send(chat, 'decision', decision)
  send(chat, 'delta', { text: answer })
  done(chat, decision, answer, places, preferences)
}

// 任务16受控“服务端”：只按请求体判定，语义与 Go 后端一致（agentchat/food_interpretation_test.go）——
// 品类为空时从最新用户原话理解“四川火锅”并写入 done.preferences；2km 内只有冒菜/贵州锅 → needs_choice；半径覆盖 3.95km 川锅 → ready。
const fev = (state, fields) => ({ state, fields: state === 'unknown' ? [] : fields })
const fassess = (id, range, food) => ({ candidate_id: id, range: fev(range, ['location']), food: fev(food, ['tag']), price: fev('unknown') })
function hotpotPlace(id, name, n, meters) {
  return { id, candidate_key: `poi:${id}`, name, address: `${n} 号路`, location: `116.40${n},39.90${n}`, distance: String(meters), type: '餐饮服务;中餐厅;火锅店', evaluation: fassess(`poi:${id}`, 'satisfied', 'satisfied') }
}
export function sichuanHotpotReply(chat) {
  const { preferences, messages } = chat.body
  const latest = messages.at(-1)?.content ?? ''
  const interpreted = preferences.food_requirement === null && latest.includes('四川火锅')
  const food = interpreted ? '四川火锅' : preferences.food_requirement
  assert.equal(food, '四川火锅', '该夹具只应答四川火锅需求')
  const effective = { ...preferences, food_requirement: food }
  if (preferences.radius_meters < 3950) {
    const decision = {
      status: 'needs_choice', selected_ids: [], reason_codes: ['preferences_conflict'],
      assessments: [fassess('poi:MAOCAI', 'satisfied', 'unsatisfied'), fassess('poi:GUIZHOU', 'satisfied', 'unsatisfied'), fassess('poi:FAR', 'unsatisfied', 'satisfied')],
      options: [
        { option_id: 'wider', label: '保留四川火锅，扩大到4公里', observed_ids: ['poi:FAR'], reason_codes: ['outside_radius'], changes: { radius_meters: 4000 } },
        { option_id: 'swap', label: '保持2公里，改吃冒菜', observed_ids: ['poi:MAOCAI'], reason_codes: ['food_mismatch'], changes: { food_requirement: '冒菜' } },
        // 真实后端只公开方案引用的候选（publicDecision），故贵州锅须经方案引用才会出现在 candidates。
        { option_id: 'guizhou', label: '保持2公里，改吃贵州酸汤锅', observed_ids: ['poi:GUIZHOU'], reason_codes: ['food_mismatch'], changes: { food_requirement: '贵州酸汤锅' } },
      ],
      candidates: [
        { candidate_id: 'poi:MAOCAI', name: '巷口冒菜', address: '一号路', distance_meters: 900 },
        { candidate_id: 'poi:GUIZHOU', name: '贵州酸汤锅', address: '三号路', distance_meters: 1500 },
        { candidate_id: 'poi:FAR', name: '远处川锅', address: '二号路', distance_meters: 3950 },
      ],
      ...(interpreted ? { food_interpretation: { requirement: '四川火锅', quote: '四川火锅', ambiguous: false } } : {}),
    }
    respond(chat, decision, '**2 公里内**只有巷口冒菜和贵州酸汤锅，没有四川火锅。请选择。', [], effective)
    return decision
  }
  const places = [hotpotPlace('B0FAR0001', '远处川锅', 1, 3950), hotpotPlace('B0FAR0002', '川味火锅二店', 2, 3700), hotpotPlace('B0FAR0003', '老码头火锅', 3, 3600)]
    .slice(0, preferences.target_count)
  const decision = { status: 'ready', selected_ids: places.map(item => item.candidate_key), reason_codes: ['unknown_price'], options: [], candidates: [], assessments: places.map(item => item.evaluation) }
  respond(chat, decision, '## 4 公里内的四川火锅\n\n' + places.map(item => `- **${item.name}**`).join('\n'), places, effective)
  return decision
}
