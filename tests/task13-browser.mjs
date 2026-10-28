import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join, extname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { guardedBrowserArgs, startNetworkGuard } from './browser-network-guard.mjs'
import { installProbes } from './task6-fixture.mjs'

// 任务13本地夹具：/agent/chat 挂起，由测试推送 SSE；除 127.0.0.1 外所有主机名解析失败，新标签页只截获 URL、不访问外网。
const addresses = [
  { id: 1, label: '家', is_default: true, location: '116.400000,39.900000', formatted_address: '家附近路口' },
  { id: 2, label: '公司', is_default: false, location: '116.500000,39.800000', formatted_address: '公司楼下' },
]

async function openFixture() {
  const root = fileURLToPath(new URL('../', import.meta.url))
  const dist = process.env.TASK6_DIST_DIR ?? join(root, 'dist')
  const { TASK6_BROWSER_LOADER: loader, TASK6_BROWSER_PATH: browserPath } = process.env
  assert.ok(loader && browserPath, '请指定任务自有浏览器与 browser 技能 loader')
  const { loadOmowright } = await import(pathToFileURL(loader).href)
  const { omowright } = await loadOmowright()
  const evidenceDir = process.env.TASK13_EVIDENCE_DIR ?? mkdtempSync(join(tmpdir(), 'task13-cards-'))
  const profile = mkdtempSync(join(tmpdir(), 'task13-profile-'))
  const chats = []
  const server = createServer(async (request, response) => {
    const url = new URL(request.url, 'http://fixture')
    const json = (status, body) => response.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body))
    if (url.pathname.startsWith('/api/')) {
      const chunks = []
      for await (const chunk of request) chunks.push(chunk)
      if (url.pathname.endsWith('/me')) return json(200, { code: 200, data: { id: 1, username: '本地测试' } })
      if (url.pathname.endsWith('/addresses')) return json(200, { code: 200, data: { total: addresses.length, items: addresses } })
      if (url.pathname.endsWith('/agent/chat')) {
        response.on('error', () => {})
        response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
        response.flushHeaders()
        chats.push({ body: JSON.parse(Buffer.concat(chunks).toString()), response })
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
      response.writeHead(404).end()
    }
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  // 共享拒绝代理：浏览器的所有外部请求（含系统代理场景）都先到这里被记录并拒绝，回环地址按 Chromium 默认直连。
  const guard = await startNetworkGuard('task13')
  const proxied = guard.refused
  let browser
  const cleanup = { profile, browserArgs: guard.args.slice(0, 2), browserClosed: false, serverClosed: false, profileRemoved: false }
  async function close() {
    await browser?.close(); cleanup.browserClosed = true
    for (const chat of chats) chat.response.destroy()
    server.closeAllConnections()
    await new Promise(resolve => server.close(resolve)); cleanup.serverClosed = true
    cleanup.networkGuard = await guard.close()
    rmSync(profile, { recursive: true, force: true }); cleanup.profileRemoved = true
    writeFileSync(join(evidenceDir, `cleanup-${process.pid}-${Date.now()}.json`), JSON.stringify(cleanup, null, 2))
  }
  try {
    browser = await omowright.connectPipe({ browserPath, storageRoot: profile, browserArgs: guardedBrowserArgs(guard, profile) })
    cleanup.browserPid = browser.browserProcess.pid
    const page = await browser.newTab()
    const sid = await page.resolveSessionId()
    // 浏览器级目标发现：每个新标签页只记录其第一个 https 目标 URL（即链接本身，而非后续重定向/错误页）。
    const opened = []
    const record = ({ targetInfo }) => {
      if (targetInfo.type === 'page' && targetInfo.url.startsWith('https://') && !opened.some(item => item.targetId === targetInfo.targetId)) {
        opened.push({ targetId: targetInfo.targetId, url: targetInfo.url })
      }
    }
    page.cdp.on('Target.targetCreated', record)
    page.cdp.on('Target.targetInfoChanged', record)
    await page.cdp.send('Target.setDiscoverTargets', { discover: true })
    const wait = (condition, arg = null) => page.evaluate(([source, value]) => new Promise((resolve, reject) => {
      const matches = new Function('arg', `return (${source})(arg)`)
      const deadline = performance.now() + 5000
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
    // 等待一个新的外部标签页并立即关闭，返回其完整 URL。
    async function nextOpened(before) {
      await until(() => opened.length > before, '应打开新的高德标签页')
      await pause(100)
      const target = opened.at(-1)
      await page.cdp.send('Target.closeTarget', { targetId: target.targetId }).catch(() => {})
      return target.url
    }
    return { page, omowright, evidenceDir, chats, wait, click, close, opened, nextOpened, proxied, origin: `http://127.0.0.1:${server.address().port}` }
  } catch (failure) { await close(); throw failure }
}

const send = (chat, name, data) => chat.response.write(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`)
function respond(chat, decision, answer, places = []) {
  send(chat, 'decision', decision)
  send(chat, 'delta', { text: answer })
  send(chat, 'done', { answer_text: answer, places, places_count: places.length, location: '116.4,39.9', status: decision.status, preferences: chat.body.preferences, decision })
  chat.response.end()
}
async function until(check, message) {
  for (const deadline = Date.now() + 5000; !check();) {
    assert.ok(Date.now() < deadline, message)
    await new Promise(resolve => setTimeout(resolve, 20))
  }
}
const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
async function submit(f, text) {
  await f.page.fill('.ask-panel textarea', text)
  await f.click('.ask-panel button[type=submit]')
}

const evidence = (state, fields) => ({ state, fields: state === 'unknown' ? [] : fields })
const assessment = (id, price) => ({ candidate_id: id, range: evidence('satisfied', ['location']), food: evidence('unknown', []), price: evidence(price, ['business.cost', 'business.currency', 'business.cost_basis']) })
const keys = ['poi:B0FFH5ZK1A', 'synthetic:4f1a', 'synthetic:9c2b']
const places = [
  // 真实 POI ID；附带的 url 字段与“符合”文字都不得被采用。
  { id: 'B0FFH5ZK1A', candidate_key: keys[0], name: '川味小馆', address: '一号路', location: '116.401,39.901', distance: '812.6', type: '餐饮服务;中餐厅;四川火锅',
    url: 'https://evil.example/phish', evaluation: assessment(keys[0], 'unknown') },
  // 无 ID、合法坐标、名称含 & # 中文；价格来源已知；分类含“|”、空白与重复段。
  { candidate_key: keys[1], name: '无号&小馆#1', address: '二号路', location: '116.402,39.902', distance: '950', type: ' 火锅店|餐饮服务; 火锅店 ;|', cost: '45', cost_currency: 'CNY', cost_basis: 'per_person',
    evaluation: assessment(keys[1], 'satisfied') },
  // 恶意 ID + 非法坐标 + 缺字段：只能非链接。
  { id: 'javascript:alert(1)', candidate_key: keys[2], name: '', address: '', location: 'NaN,39.9', distance: '', evaluation: assessment(keys[2], 'unknown') },
]
const ready = { status: 'ready', selected_ids: keys, reason_codes: ['unknown_price'], options: [], candidates: [], assessments: keys.map((key, index) => assessment(key, index === 1 ? 'satisfied' : 'unknown')) }
const detailURL = 'https://uri.amap.com/poidetail?poiid=B0FFH5ZK1A&callnative=0'
const markerURL = `https://uri.amap.com/marker?position=116.402,39.902&${new URLSearchParams({ name: '无号&小馆#1', coordinate: 'gaode', callnative: '0' })}`

test('task13真实浏览器：高德卡片详情/位置/非链接、键盘与新窗口目标、未知字段、布局', { timeout: 60_000 }, async t => {
  const f = await openFixture()
  t.after(f.close)
  const { page, wait, chats } = f
  const receipt = { evidenceDir: f.evidenceDir, cases: [] }
  const problems = [] // task17 各项先收集，测试末尾统一断言
  await f.omowright.emulate(page, 'desktop-1440')
  await page.goto(f.origin, { waitUntil: 'load' })
  await wait(() => document.querySelector('.location-line')?.textContent.includes('家附近路口'))
  await submit(f, '附近吃什么')
  await until(() => chats.length === 1, '应发出推荐请求')
  respond(chats[0], ready, '## 推荐\n\n- **川味小馆**', places)
  await wait(() => document.querySelectorAll('.place-card').length === 3)

  const cards = await page.evaluate(() => [...document.querySelectorAll('.place-card')].map(node => ({
    tag: node.tagName, href: node.getAttribute('href'), target: node.getAttribute('target'), rel: node.getAttribute('rel'), tabIndex: node.tabIndex,
    nested: node.querySelectorAll('a,button,input,select,textarea,[tabindex],[href]').length, text: node.innerText.replace(/\s+/g, ' '),
    height: node.getBoundingClientRect().height,
  })))
  receipt.cards = cards
  assert.deepEqual(cards.map(card => card.tag), ['A', 'A', 'ARTICLE'])
  assert.equal(cards[0].href, detailURL)
  assert.equal(cards[1].href, markerURL)
  assert.equal(cards[2].href, null)
  for (const card of cards.slice(0, 2)) {
    assert.equal(card.target, '_blank'); assert.equal(card.rel, 'noopener noreferrer'); assert.equal(card.nested, 0, '整卡链接内不得嵌套交互')
    assert.ok(card.height >= 44)
  }
  assert.equal(cards[2].tabIndex, -1, '非链接卡不可聚焦')
  if (!cards[0].text.includes('来源分类：餐饮服务 · 中餐厅 · 四川火锅')) problems.push(`C2 分类应按分号拆分并以 · 连接：${cards[0].text}`)
  if (!/来源分类：火锅店 · 餐饮服务(?! ·)/.test(cards[1].text) || cards[1].text.includes('|')) problems.push(`task18 分类应按 ;| 拆分、去空白、去重：${cards[1].text}`)
  for (const text of ['川味小馆', '一号路', '直线约 813 米', '价格待核实', '在高德地图查看商家详情（新窗口打开）']) assert.ok(cards[0].text.includes(text), text)
  for (const text of ['无号&小馆#1', '参考人均 ¥45', '在高德地图查看位置（新窗口打开）']) assert.ok(cards[1].text.includes(text), text)
  for (const text of ['商家名称未提供', '暂无详细地址', '距离未知', '价格待核实', '无法定位，暂无可用高德链接']) assert.ok(cards[2].text.includes(text), text)
  for (const card of cards) assert.doesNotMatch(card.text, /符合|已满足|0 元|evil/, '未知字段不得造值或打符合标签')
  receipt.cases.push('真实ID→poidetail；无ID坐标→marker（名称&#中文编码）；恶意ID+非法坐标→非链接article；未知价格“价格待核实”，无符合标签，忽略服务端url字段')

  // 键盘：Tab 顺序到达两张链接卡（非链接卡不在其中），焦点可见；Enter 打开详情。
  await page.evaluate(() => document.activeElement?.blur())
  const sequence = []
  for (let step = 0; step < 40; step++) {
    await page.keyboard.press('Tab')
    const focused = await page.evaluate(() => {
      const node = document.activeElement
      return { card: node?.classList.contains('place-card') ?? false, tag: node?.tagName, href: node?.getAttribute('href') ?? null,
        outline: node ? getComputedStyle(node).outlineStyle : '', outlineWidth: node ? getComputedStyle(node).outlineWidth : '' }
    })
    if (focused.card) sequence.push(focused)
    if (sequence.length === 2) break
  }
  receipt.keyboard = sequence
  assert.deepEqual(sequence.map(item => item.href), [detailURL, markerURL])
  for (const item of sequence) { assert.equal(item.outline, 'solid'); assert.equal(item.outlineWidth, '3px') }
  await page.keyboard.press('Shift+Tab')
  assert.equal(await page.evaluate(() => document.activeElement.getAttribute('href')), detailURL)
  let before = f.opened.length
  await page.keyboard.press('Enter')
  assert.equal(await f.nextOpened(before), detailURL, 'Enter 打开的新标签页应为完整详情 URL')
  before = f.opened.length
  await f.click('a.place-card[href^="https://uri.amap.com/marker"]')
  assert.equal(await f.nextOpened(before), markerURL, '点击位置卡打开的新标签页应为完整 marker URL')
  before = f.opened.length
  await f.click('article.place-card')
  await pause(300)
  assert.equal(f.opened.length, before, '非链接卡点击不打开任何页面')
  receipt.opened = f.opened.map(item => item.url)
  receipt.proxiedAndRefused = [...f.proxied]
  assert.ok(f.proxied.includes('CONNECT uri.amap.com:443'), '外部导航只应到达本地拒绝代理')
  receipt.cases.push('键盘Tab只停在两张链接卡、3px实线焦点；Enter打开详情、鼠标打开marker（新标签页URL截获后关闭，外部主机解析被禁用）；非链接卡点击无导航')

  for (const [preset, width] of [['iphone-14', 390], ['desktop-1440', 1440]]) {
    await f.omowright.emulate(page, preset)
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
    const layout = await page.evaluate(() => ({ width: innerWidth, overflow: document.documentElement.scrollWidth > innerWidth,
      cards: [...document.querySelectorAll('.place-card')].map(node => { const rect = node.getBoundingClientRect(); return { right: rect.right, height: rect.height } }) }))
    assert.equal(layout.width, width)
    assert.equal(layout.overflow, false, JSON.stringify(layout))
    for (const card of layout.cards) assert.ok(card.right <= width && card.height >= 44, JSON.stringify(card))
    // task17 C5：目的地短语与分类各段不被拆到两行；C1：手机卡片信息字号 ≥15px。
    await installProbes(page)
    const wraps = await page.evaluate(() => [...document.querySelectorAll('.place-card')].map(card => Object.fromEntries(
      ['在高德地图查看商家详情', '在高德地图查看位置', '（新窗口打开）', '餐饮服务', '中餐厅', '四川火锅', '无法定位，'].map(text => [text, window.__probe.lines(card, text)]).filter(([, lines]) => lines !== -1))))
    const facts = await page.evaluate(() => window.__probe.size('.place-facts'))
    receipt[`wraps${width}`] = { wraps, facts }
    for (const card of wraps) for (const [text, lines] of Object.entries(card)) if (lines !== 1) problems.push(`C5 ${width}：${text} 被拆行 ${JSON.stringify(wraps)}`)
    if (width === 390 && facts < 15) problems.push(`C1 卡片信息字号 ${facts}`)
    await page.evaluate(() => document.querySelector('.places-grid').scrollIntoView({ block: 'start' }))
    writeFileSync(join(f.evidenceDir, `task13-cards-${width}.png`), await page.screenshot({ fullPage: true }))
    receipt[`layout${width}`] = layout
  }
  receipt.cases.push('390/1440 无横向溢出，卡片高度≥44px')
  receipt.problems = problems
  writeFileSync(join(f.evidenceDir, 'task13-browser.json'), JSON.stringify(receipt, null, 2))
  assert.deepEqual(problems, [])
})

test('task12遗留时序：decision 到达前切换地址，方案不建立且 done 后不可选并提示失效', { timeout: 60_000 }, async t => {
  const f = await openFixture()
  t.after(f.close)
  const { page, wait, chats } = f
  await f.omowright.emulate(page, 'desktop-1440')
  await page.goto(f.origin, { waitUntil: 'load' })
  await wait(() => document.querySelector('.location-line')?.textContent.includes('家附近路口'))
  await submit(f, '想吃四川火锅')
  await until(() => chats.length === 1, '应发出推荐请求')
  // 请求进行中、decision 尚未到达时切换到另一个地址。
  await f.click('.address-list:not(.location-search *) .address-row:not(.selected)')
  await wait(() => document.querySelector('.location-line').textContent.includes('公司楼下'))
  const needsChoice = { status: 'needs_choice', selected_ids: [], assessments: [], reason_codes: ['no_candidates'], candidates: [],
    options: [{ option_id: 'wider', label: '扩大到4公里再查', observed_ids: [], reason_codes: [], changes: { radius_meters: 4000 } }] }
  respond(chats[0], needsChoice, '本次未找到，请选择')
  // 等完整 done 处理完（不再显示生成中），再检查方案状态。
  await wait(() => !document.querySelector('.streaming-label') && !document.querySelector('.result-status[role=status]')?.textContent.includes('正在生成'))
  const state = await page.evaluate(() => ({
    panel: Boolean(document.querySelector('.negotiation')),
    enabled: [...document.querySelectorAll('.negotiation button')].filter(node => !node.disabled).length,
    status: document.querySelector('.result-status[role=status]').textContent,
  }))
  assert.equal(state.panel, false, '按旧位置生成的方案不得展示为可选')
  assert.equal(state.enabled, 0)
  assert.match(state.status, /位置或条件已在生成期间变化，本次方案已失效/)
  await pause(200)
  assert.equal(chats.length, 1, '不得自动发起请求')
  writeFileSync(join(f.evidenceDir, 'task13-location-race.json'), JSON.stringify(state, null, 2))
})
