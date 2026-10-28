import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join, extname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { guardedBrowserArgs, startNetworkGuard } from './browser-network-guard.mjs'
import { installProbes } from './task6-fixture.mjs'

// 任务12本地 SSE 夹具：/agent/chat 挂起响应，由测试逐事件推送 decision→delta→done，不连接真实后端或模型。
const addresses = [
  { id: 1, label: '家', is_default: true, location: '116.400000,39.900000', formatted_address: '家附近路口' },
  { id: 2, label: '公司', is_default: false, location: '116.500000,39.800000', formatted_address: '公司楼下' },
]
const evidence = (state, fields) => ({ state, fields: state === 'unknown' ? [] : fields })
const assessment = (id, range, food, price) => ({ candidate_id: id, range: evidence(range, ['location']), food: evidence(food, ['tag']), price: evidence(price, ['business.cost']) })
const needsChoice = {
  status: 'needs_choice', selected_ids: [], reason_codes: ['outside_radius', 'food_mismatch'],
  assessments: [assessment('poi:FAR', 'unsatisfied', 'satisfied', 'unknown'), assessment('poi:NEAR', 'satisfied', 'unsatisfied', 'unknown')],
  options: [
    { option_id: 'wider', label: '保留四川火锅，扩大到4公里', observed_ids: ['poi:FAR'], reason_codes: ['outside_radius'], changes: { radius_meters: 4000, food_requirement: '四川火锅' } },
    { option_id: 'swap', label: '保持2公里，改吃冒菜', observed_ids: ['poi:NEAR'], reason_codes: ['food_mismatch'], changes: { food_requirement: '冒菜' } },
    { option_id: 'two', label: '只要2家', observed_ids: [], reason_codes: [], changes: { target_count: 2 } },
  ],
  candidates: [
    { candidate_id: 'poi:FAR', name: '远处川锅（长名称用于验证窄屏换行不溢出的四川火锅老店）', address: '二号路', distance_meters: 3600 },
    { candidate_id: 'poi:NEAR', name: '近处冒菜', address: '', distance_meters: 900 },
  ],
}
const ready = {
  status: 'ready', selected_ids: ['poi:FAR'], reason_codes: ['unknown_price'], options: [], candidates: [],
  assessments: [assessment('poi:FAR', 'satisfied', 'satisfied', 'unknown')],
}
const farPlace = { id: 'FAR', candidate_key: 'poi:FAR', name: '远处川锅', address: '二号路', distance: '3600', type: '火锅' }

async function openFixture() {
  const root = fileURLToPath(new URL('../', import.meta.url))
  const dist = process.env.TASK6_DIST_DIR ?? join(root, 'dist')
  const { TASK6_BROWSER_LOADER: loader, TASK6_BROWSER_PATH: browserPath } = process.env
  assert.ok(loader && browserPath, '请指定任务自有浏览器与 browser 技能 loader')
  const { loadOmowright } = await import(pathToFileURL(loader).href)
  const { omowright } = await loadOmowright()
  const evidenceDir = process.env.TASK12_EVIDENCE_DIR ?? mkdtempSync(join(tmpdir(), 'task12-negotiation-'))
  const profile = mkdtempSync(join(tmpdir(), 'task12-profile-'))
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
        let closed = false
        response.on('close', () => { closed = true })
        response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
        response.flushHeaders()
        chats.push({ body: JSON.parse(Buffer.concat(chunks).toString()), response, closed: () => closed })
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
  const guard = await startNetworkGuard('task12')
  let browser
  const cleanup = { profile, browserClosed: false, serverClosed: false, profileRemoved: false }
  async function close() {
    await browser?.close(); cleanup.browserClosed = true
    for (const chat of chats) chat.response.destroy()
    server.closeAllConnections()
    await new Promise(resolve => server.close(resolve)); cleanup.serverClosed = true
    cleanup.networkGuard = await guard.close()
    rmSync(profile, { recursive: true, force: true }); cleanup.profileRemoved = true
    writeFileSync(join(evidenceDir, 'cleanup.json'), JSON.stringify(cleanup, null, 2))
  }
  try {
    browser = await omowright.connectPipe({ browserPath, storageRoot: profile, browserArgs: guardedBrowserArgs(guard, profile) })
    cleanup.browserPid = browser.browserProcess.pid
    const page = await browser.newTab()
    const sid = await page.resolveSessionId()
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
    return { page, omowright, evidenceDir, chats, cleanup, wait, click, close, origin: `http://127.0.0.1:${server.address().port}` }
  } catch (failure) { await close(); throw failure }
}

const send = (chat, name, data) => chat.response.write(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`)
const done = (chat, decision, answer, places = []) => {
  send(chat, 'done', { answer_text: answer, places, places_count: places.length, location: '116.4,39.9', status: decision.status, preferences: chat.body.preferences, decision })
  chat.response.end()
}
function respond(chat, decision, answer, places = []) {
  send(chat, 'decision', decision)
  send(chat, 'delta', { text: answer })
  done(chat, decision, answer, places)
}
async function until(check, message) {
  for (const deadline = Date.now() + 5000; !check();) {
    assert.ok(Date.now() < deadline, message)
    await new Promise(resolve => setTimeout(resolve, 20))
  }
}
const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
// task18：条件摘要的每个 .keep-together 分段实际占用的行数（期望均为 1）。
const segmentLines = async (page, selector, prefix) => {
  await installProbes(page)
  return page.evaluate(([selector, prefix]) => {
    const root = [...document.querySelectorAll(selector)].find(node => node.textContent.startsWith(prefix))
    return root ? [...root.querySelectorAll('.keep-together')].map(node => [node.textContent, window.__probe.lines(node, node.textContent)]) : []
  }, [selector, prefix])
}

const view = page => page.evaluate(() => {
  const field = label => [...document.querySelectorAll('.preferences label.field')].find(node => node.querySelector('span').textContent.startsWith(label))
  return {
    panel: Boolean(document.querySelector('.negotiation')),
    buttons: [...document.querySelectorAll('.negotiation-option .button-primary')].map(node => ({ disabled: node.disabled, name: node.getAttribute('aria-label') })),
    keepDisabled: document.querySelector('.negotiation .button-quiet')?.disabled ?? null,
    panelText: document.querySelector('.negotiation')?.innerText ?? '',
    radius: field('搜索范围').querySelector('select').value,
    customRadius: field('自定义半径')?.querySelector('input').value ?? null,
    summary: document.querySelector('.preference-summary')?.textContent.replace('当前条件：', '').trim() ?? '',
    used: [...document.querySelectorAll('.result-status')].map(node => node.textContent),
    status: document.querySelector('.result-status[role=status]')?.textContent ?? '',
    markdown: document.querySelector('.markdown-body')?.innerHTML ?? '',
    cards: [...document.querySelectorAll('.place-card h3')].map(node => node.textContent),
    focus: document.activeElement?.tagName,
  }
})
async function setSelect(page, label, value) {
  await page.evaluate(([label, value]) => {
    const field = [...document.querySelectorAll('.preferences label.field')].find(node => node.querySelector('span').textContent.startsWith(label))
    const select = field.querySelector('select')
    select.value = value
    select.dispatchEvent(new Event('change', { bubbles: true }))
  }, [label, value])
}
async function submit(f, text) {
  await f.page.fill('.ask-panel textarea', text)
  await f.click('.ask-panel button[type=submit]')
}

test('task12真实浏览器：协商方案在done后可选、精确同步条件、失效与取消隔离、布局', async t => {
  const f = await openFixture()
  t.after(f.close)
  const { page, wait, chats } = f
  const receipt = { evidenceDir: f.evidenceDir, cases: [] }
  await f.omowright.emulate(page, 'desktop-1440')
  await page.goto(f.origin, { waitUntil: 'load' })
  await wait(() => document.querySelector('.location-line')?.textContent.includes('家附近路口'))

  // 1. 2km 无川锅 → needs_choice：done 前方案可见但禁用；done 后启用；替代候选与偏离项可见。
  await setSelect(page, '搜索范围', '2000')
  await submit(f, '想吃四川火锅')
  await until(() => chats.length === 1, '应发出首个推荐请求')
  assert.equal(chats[0].body.preferences.radius_meters, 2000)
  assert.equal('selection' in chats[0].body, false)
  send(chats[0], 'decision', needsChoice)
  send(chats[0], 'delta', { text: '**2 公里内**未找到四川火锅，' })
  await wait(() => document.querySelector('.negotiation') && document.querySelector('.markdown-body strong'))
  let s = await view(page)
  assert.deepEqual(s.buttons.map(button => button.disabled), [true, true, true], 'done 前方案必须禁用')
  assert.equal(s.keepDisabled, true)
  assert.match(s.panelText, /完整结果返回后才能选择方案/)
  writeFileSync(join(f.evidenceDir, 'task12-before-done-1440.png'), await page.screenshot({ fullPage: true }))
  send(chats[0], 'delta', { text: '请选择。' })
  done(chats[0], needsChoice, '**2 公里内**未找到四川火锅，请选择。')
  await wait(() => !document.querySelector('.negotiation-option .button-primary').disabled)
  s = await view(page)
  assert.deepEqual(s.buttons.map(button => button.disabled), [false, false, true], '无法在选单精确表示的2家方案保持禁用')
  assert.match(s.buttons[0].name, /选择方案：保留四川火锅，扩大到4公里（搜索范围（直线）从2 公里改为4 公里，品类从未指定改为四川火锅）/)
  for (const text of ['远处川锅', '二号路', '直线约 3,600 米', '偏离：超出原搜索范围', '近处冒菜', '暂无详细地址', '本次未观察到符合此方案的店铺', '保持原条件，继续描述']) assert.ok(s.panelText.includes(text), text)
  assert.match(s.markdown, /<strong>2 公里内<\/strong>/)
  assert.deepEqual(s.cards, [], 'needs_choice 不显示推荐卡片')
  for (const [preset, width] of [['iphone-14', 390], ['desktop-1440', 1440]]) {
    await f.omowright.emulate(page, preset)
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
    const layout = await page.evaluate(() => ({ width: innerWidth, overflow: document.documentElement.scrollWidth > innerWidth,
      targets: [...document.querySelectorAll('.negotiation button')].map(node => { const rect = node.getBoundingClientRect(); return { text: node.textContent.trim(), height: rect.height, right: rect.right } }) }))
    assert.equal(layout.width, width)
    assert.equal(layout.overflow, false, JSON.stringify(layout))
    for (const target of layout.targets) assert.ok(target.height >= 44 && target.right <= width, JSON.stringify(target))
    if (width === 390) {
      const segments = await segmentLines(page, '.negotiation .hint', '原条件：')
      receipt.originalSegments390 = segments
      assert.ok(segments.length >= 4, JSON.stringify(segments))
      for (const [text, lines] of segments) assert.equal(lines, 1, `390 原条件分段不得被拆行：${text}`)
    }
    writeFileSync(join(f.evidenceDir, `task12-needs-choice-${width}.png`), await page.screenshot({ fullPage: true }))
    receipt[`layout${width}`] = layout
  }
  // 键盘可达：从“保持原条件”反向 Tab 到最后一个可用方案按钮，焦点轮廓可见。
  await page.evaluate(() => document.querySelector('.negotiation .button-quiet').focus())
  await page.keyboard.press('Shift+Tab')
  receipt.keyboardFocus = await page.evaluate(() => ({ label: document.activeElement.getAttribute('aria-label'), outline: getComputedStyle(document.activeElement).outlineStyle }))
  assert.match(receipt.keyboardFocus.label ?? '', /选择方案：保持2公里，改吃冒菜/)
  assert.equal(receipt.keyboardFocus.outline, 'solid')
  receipt.cases.push('2km→needs_choice：decision先到时方案禁用，done后启用；替代候选/距离/偏离项可见；2家方案不可精确表示而禁用；无推荐卡；390/1440无横溢且按钮≥44px')

  // 2. 点选“扩大到4公里”：先同步选单与摘要，再提交含 selection 的新请求；新 ready 摘要一致。
  await f.click('.negotiation-option .button-primary')
  await until(() => chats.length === 2, '点选后应发出新请求')
  const second = chats[1].body
  assert.equal(second.preferences.radius_meters, 4000)
  assert.equal(second.preferences.food_requirement, '四川火锅')
  assert.deepEqual(second.selection, { option_id: 'wider', previous_preferences: chats[0].body.preferences, changes: { radius_meters: 4000, food_requirement: '四川火锅' } })
  assert.deepEqual(second.preferences, { ...chats[0].body.preferences, radius_meters: 4000, food_requirement: '四川火锅' })
  assert.deepEqual(second.messages.map(message => message.content), ['想吃四川火锅', '**2 公里内**未找到四川火锅，请选择。', '我选择方案：保留四川火锅，扩大到4公里'])
  s = await view(page)
  assert.equal(s.panel, false, '已选方案立即撤下')
  assert.equal(s.radius, 'custom'); assert.equal(s.customRadius, '4000')
  assert.match(s.summary, /4 公里内/); assert.match(s.summary, /品类：四川火锅/)
  respond(chats[1], ready, '## 推荐\n\n- **远处川锅**：直线约 3.6 公里', [farPlace])
  await wait(() => document.querySelector('.markdown-body h2') && document.querySelector('.place-card'))
  s = await view(page)
  assert.ok(s.used.some(text => text === `本次提交条件：${s.summary}`), JSON.stringify(s))
  assert.deepEqual(s.cards, ['远处川锅'])
  assert.equal(s.panel, false)
  assert.match(s.status, /推荐完成/)
  writeFileSync(join(f.evidenceDir, 'task12-ready-4km-1440.png'), await page.screenshot({ fullPage: true }))
  await f.omowright.emulate(page, 'iphone-14')
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
  const usedSegments = await segmentLines(page, '.result-status', '本次提交条件：')
  receipt.usedSegments390 = usedSegments
  assert.ok(usedSegments.length >= 5, JSON.stringify(usedSegments))
  for (const [text, lines] of usedSegments) assert.equal(lines, 1, `390 本次提交条件分段不得被拆行：${text}`)
  await f.omowright.emulate(page, 'desktop-1440')
  receipt.cases.push('点选扩大到4km：选单切自定义4000米、摘要含4公里与品类；请求含radius 4000、selection={option_id,previous_preferences,changes}；新ready结果的本次提交条件与当前摘要一致')

  // 3. 保持原条件：不发请求、回焦输入；随后输入“好的”只按当前条件提交，不带 selection、不扩大。
  await f.click('.content-header .text-button')
  await setSelect(page, '搜索范围', '2000')
  await submit(f, '想吃四川火锅')
  await until(() => chats.length === 3, '新对话请求')
  respond(chats[2], needsChoice, '请选择')
  await wait(() => document.querySelector('.negotiation .button-quiet') && !document.querySelector('.negotiation .button-quiet').disabled)
  await f.click('.negotiation .button-quiet')
  await wait(() => !document.querySelector('.negotiation') && document.activeElement?.tagName === 'TEXTAREA')
  await pause(300)
  assert.equal(chats.length, 3, '保持原条件不能发请求')
  assert.match((await view(page)).status, /已保留原条件，未扩大搜索/)
  await submit(f, '好的')
  await until(() => chats.length === 4, '“好的”作为普通文字提交')
  assert.equal('selection' in chats[3].body, false, '歧义文字不能套用方案')
  assert.equal(chats[3].body.preferences.radius_meters, 2000)
  assert.equal(chats[3].body.preferences.food_requirement, null)
  receipt.cases.push('保持原条件：不发请求、方案撤下并回焦输入；“好的”按原2km条件提交且无selection')

  // 4. 切换位置使旧方案失效，不发请求。
  respond(chats[3], needsChoice, '请选择')
  await wait(() => document.querySelector('.negotiation-option .button-primary') && !document.querySelector('.negotiation-option .button-primary').disabled)
  await f.click('.address-list:not(.location-search *) .address-row:not(.selected)')
  await wait(() => !document.querySelector('.negotiation') && document.querySelector('.location-line').textContent.includes('公司楼下'))
  assert.match((await view(page)).status, /位置已变更，旧方案已失效/)
  await pause(200)
  assert.equal(chats.length, 4)
  receipt.cases.push('切换地址后旧方案立即失效且不发请求')

  // 5. 修改条件使旧方案失效。
  await submit(f, '还是想吃火锅')
  await until(() => chats.length === 5, '公司位置请求')
  assert.equal(chats[4].body.address_id, 2)
  respond(chats[4], needsChoice, '请选择')
  await wait(() => document.querySelector('.negotiation-option .button-primary') && !document.querySelector('.negotiation-option .button-primary').disabled)
  await setSelect(page, '推荐数量', '5')
  await wait(() => !document.querySelector('.negotiation'))
  assert.match((await view(page)).status, /推荐条件已修改，旧方案已失效/)
  receipt.cases.push('修改选单条件后旧方案失效')

  // 6. 取消：decision 已到、方案禁用；取消后迟到 delta/done 不能复活方案或写入历史，也不自动重试。
  await submit(f, '取消测试')
  await until(() => chats.length === 6, '待取消请求')
  send(chats[5], 'decision', needsChoice)
  await wait(() => document.querySelector('.negotiation'))
  await f.click('.ask-actions .button-quiet')
  await wait(() => !document.querySelector('.negotiation') && document.querySelector('.result-status[role=status]')?.textContent.includes('已取消'))
  await until(() => chats[5].closed(), '取消应中止连接')
  send(chats[5], 'delta', { text: '迟到正文' })
  done(chats[5], needsChoice, '迟到正文')
  await pause(300)
  s = await view(page)
  assert.equal(s.panel, false); assert.doesNotMatch(s.markdown, /迟到正文/); assert.match(s.status, /已取消，未加入对话记录/)
  assert.equal(chats.length, 6, '取消后不自动重试')
  await submit(f, '换个说法')
  await until(() => chats.length === 7, '取消后的新请求')
  assert.equal(chats[6].body.messages.some(message => message.content === '取消测试'), false, '取消轮次不进入历史')
  respond(chats[6], ready, '好的，推荐如下', [farPlace])
  await wait(() => document.querySelector('.place-card'))
  receipt.cases.push('取消：decision后取消，迟到delta/done不复活方案、不写历史，无自动重试')

  // 7. 正文渲染失败（超 64000 字符）：受控失败，不写完成历史，不启用方案。
  await submit(f, '超长测试')
  await until(() => chats.length === 8, '超长请求')
  respond(chats[7], needsChoice, '汤'.repeat(64_001))
  await wait(() => document.querySelector('.result-status[role=status]')?.textContent.includes('未能安全显示'))
  s = await view(page)
  assert.equal(s.panel, false, '渲染失败不启用方案')
  assert.ok(await page.evaluate(() => document.querySelector('.markdown-answer [role=alert]')?.textContent.includes('64000')))
  await submit(f, '再来')
  await until(() => chats.length === 9, '渲染失败后的新请求')
  assert.equal(chats[8].body.messages.some(message => message.content === '超长测试'), false, '渲染失败轮次不进入历史')
  respond(chats[8], ready, '好的', [farPlace])
  await wait(() => document.querySelector('.result-status[role=status]')?.textContent.includes('推荐完成'))
  receipt.cases.push('正文超64000字符渲染失败：显示受控错误，不写历史、不启用方案')

  receipt.requests = chats.length
  writeFileSync(join(f.evidenceDir, 'task12-browser.json'), JSON.stringify(receipt, null, 2))
})
