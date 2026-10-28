import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join, extname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { guardedBrowserArgs, startNetworkGuard } from './browser-network-guard.mjs'

// 任务7本地夹具：POST /addresses 按后端规则（首个地址自动默认、勾选默认清除其他默认）模拟，不连接真实后端。
const candidate = { id: 'B000A1', name: '测试公园', city: '北京', address: '东门', location: '116.400000,39.900000' }

async function openFixture() {
  const root = fileURLToPath(new URL('../', import.meta.url))
  const dist = process.env.TASK6_DIST_DIR ?? join(root, 'dist')
  const { TASK6_BROWSER_LOADER: loader, TASK6_BROWSER_PATH: browserPath } = process.env
  assert.ok(loader && browserPath, '请指定任务自有浏览器与 browser 技能 loader')
  const { loadOmowright } = await import(pathToFileURL(loader).href)
  const { omowright } = await loadOmowright()
  const evidenceDir = process.env.TASK7_EVIDENCE_DIR ?? mkdtempSync(join(tmpdir(), 'task7-create-address-'))
  const profile = mkdtempSync(join(tmpdir(), 'task7-profile-'))
  const posts = [], held = [], plan = [], getPlan = [], searchPlan = []
  let addresses = [], nextId = 1
  const server = createServer(async (request, response) => {
    const url = new URL(request.url, 'http://fixture')
    const json = (status, body) => response.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body))
    if (url.pathname.startsWith('/api/')) {
      const chunks = []
      for await (const chunk of request) chunks.push(chunk)
      if (url.pathname.endsWith('/me')) return json(200, { code: 200, data: { id: 1, username: '本地测试' } })
      if (url.pathname.endsWith('/locations/search')) return searchPlan.shift() === 500 ? json(500, { code: 500, message: '服务器内部错误' }) : json(200, { code: 200, data: { items: [candidate] } })
      if (url.pathname.endsWith('/addresses') && request.method === 'GET') {
        // 按请求到达时的快照应答：挂起的 GET 模拟“写库前已读出的旧列表”。
        const snapshot = addresses
        const reply = () => json(200, { code: 200, data: { total: snapshot.length, items: snapshot } })
        if (getPlan[0] === 'hold') { getPlan.shift(); held.push(reply) } else reply()
        return
      }
      if (url.pathname.endsWith('/addresses') && request.method === 'POST') {
        const body = JSON.parse(Buffer.concat(chunks).toString())
        posts.push(body)
        const reply = () => {
          const mode = plan.shift() ?? 'ok'
          if (mode === 500) return json(500, { code: 500, message: '服务器内部错误' })
          if (mode === 401) return json(401, { code: 401, message: '登录已过期' })
          const makeDefault = addresses.length === 0 || body.is_default === true
          if (makeDefault) addresses = addresses.map(item => ({ ...item, is_default: false }))
          const created = { id: nextId++, label: body.label.trim(), is_default: makeDefault, location: body.location, longitude: 0, latitude: 0,
            ...(body.name ? { name: body.name } : {}), ...(body.address ? { address: body.address } : {}) }
          addresses = [...addresses, created]
          json(200, { code: 200, data: created })
        }
        if (plan[0] === 'hold') { plan.shift(); held.push(reply) } else reply()
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
  const guard = await startNetworkGuard('task7')
  let browser
  const cleanup = { profile, browserClosed: false, serverClosed: false, profileRemoved: false }
  async function close() {
    await browser?.close(); cleanup.browserClosed = true
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
    async function reset(items = []) {
      addresses = items
      nextId = Math.max(0, ...items.map(item => item.id)) + 1
      await page.goto(`http://127.0.0.1:${server.address().port}`, { waitUntil: 'load' })
      await wait(() => document.querySelector('input[type=search]') && !document.querySelector('.sidebar > .message'))
    }
    return { page, sid, omowright, evidenceDir, posts, plan, getPlan, searchPlan, cleanup, wait, click, reset, close,
      addresses: () => addresses,
      release() { const reply = held.shift(); assert.ok(reply, '应有挂起的保存请求'); reply() },
      heldCount: () => held.length,
    }
  } catch (failure) { await close(); throw failure }
}

const state = page => page.evaluate(() => {
  const form = document.querySelector('.address-create')
  const rows = [...document.querySelectorAll('.address-list:not(.location-search *) .address-row')]
  return {
    formOpen: Boolean(form),
    save: form ? { disabled: form.querySelector('button[type=submit]').disabled, text: form.querySelector('button[type=submit]').textContent.trim() } : null,
    label: form?.querySelector('input:not([type=checkbox])').value ?? null,
    labelInvalid: form?.querySelector('input:not([type=checkbox])').getAttribute('aria-invalid') ?? null,
    isDefault: form?.querySelector('input[type=checkbox]').checked ?? null,
    place: form?.querySelector('.address-create-place')?.innerText ?? null,
    placeNote: form?.querySelector('#address-create-place-note')?.textContent.trim() ?? null,
    alerts: [...(form?.querySelectorAll('[role=alert]') ?? [])].map(node => node.textContent.trim()),
    rows: rows.map(row => ({ text: row.querySelector('strong').textContent, pressed: row.getAttribute('aria-pressed') })),
    notice: document.querySelector('.save-notice')?.textContent ?? '',
    focus: document.activeElement?.className || document.activeElement?.tagName,
    focusText: document.activeElement?.textContent?.trim() ?? '',
  }
})

async function confirmSearch(f) {
  await f.page.fill('input[type=search]', '公园')
  await f.wait(() => document.querySelector('.location-search .address-row'))
  await f.click('.location-search .address-row')
  await f.click('.location-search .button-primary')
  await f.wait(() => document.querySelector('.location-confirm'))
}

test('task7真实浏览器：新增地址入口、搜索/定位保存、失败保留、单次提交、布局', async t => {
  const f = await openFixture()
  t.after(f.close)
  const { page, wait } = f
  const receipt = { evidenceDir: f.evidenceDir, cases: [] }
  await f.omowright.emulate(page, 'desktop-1440')

  // 空地址簿：入口可发现；未确认地点不能保存；取消回到入口。
  await f.reset()
  await wait(() => document.querySelector('.empty-state .create-entry'))
  await f.click('.empty-state .create-entry')
  await wait(() => document.querySelector('.address-create'))
  let s = await state(page)
  assert.equal(s.save.disabled, true)
  assert.match(s.placeNote, /尚未确认地点/)
  assert.equal(await page.evaluate(() => document.activeElement.closest('.field')?.querySelector('span').textContent), '地址标签')
  await page.fill('.address-create input:not([type=checkbox])', '家')
  await page.evaluate(() => document.querySelector('.address-create').requestSubmit())
  assert.equal(f.posts.length, 0, '未确认地点不能提交')
  await page.keyboard.press('Escape')
  await wait(() => !document.querySelector('.address-create') && document.activeElement?.classList.contains('create-entry'))
  receipt.cases.push('空地址簿入口可发现；未确认地点禁用保存且不发POST；Escape取消回焦入口')

  // 搜索确认地点：确认本身不写库；保存中重复点击只发一次；首次默认由服务器决定。
  await confirmSearch(f)
  assert.equal(f.posts.length, 0, '搜索确认不能自动写库')
  await f.click('.empty-state .create-entry')
  await wait(() => document.querySelector('.address-create-place'))
  s = await state(page)
  assert.match(s.place, /测试公园/); assert.match(s.place, /东门/); assert.match(s.place, /116\.400000,39\.900000/)
  await page.evaluate(() => document.querySelector('.address-create button[type=submit]').click())
  await wait(() => document.querySelector('.address-create [role=alert]'))
  s = await state(page)
  assert.equal(s.labelInvalid, 'true'); assert.match(s.alerts[0], /地址标签/); assert.equal(f.posts.length, 0, '空标签不能提交')
  await page.fill('.address-create input:not([type=checkbox])', ' 家 ')
  f.plan.push('hold')
  await f.click('.address-create button[type=submit]')
  await f.click('.address-create button[type=submit]')
  await page.evaluate(() => { const form = document.querySelector('.address-create'); form.requestSubmit(); form.requestSubmit() })
  await page.keyboard.press('Enter')
  await wait(() => document.querySelector('.address-create button[type=submit]').textContent.includes('正在保存'))
  s = await state(page)
  assert.equal(s.save.disabled, true)
  assert.equal(f.posts.length, 1, '保存中重复点击只能有一次 POST')
  f.release()
  await wait(() => document.querySelector('.save-notice') && !document.querySelector('.address-create'))
  s = await state(page)
  assert.deepEqual(f.posts[0], { label: '家', location: '116.400000,39.900000', is_default: false, name: '测试公园', address: '东门' })
  assert.deepEqual(s.rows, [{ text: '家 · 默认', pressed: 'true' }])
  assert.match(s.notice, /已保存为地址「家」并选中/)
  await wait(() => document.activeElement?.classList.contains('create-entry'))
  receipt.cases.push('搜索确认→保存：确认不写库，空标签拦截，重复点击/Enter/requestSubmit仅1次POST，首地址由服务器设默认并选中')

  // 定位坐标：不编造门牌；POST 500 保留表单，重试成功并选中、设为默认。
  await page.evaluate(() => {
    navigator.geolocation.getCurrentPosition = success => setTimeout(() => success({ coords: { longitude: 116.397, latitude: 39.908 } }), 0)
  })
  await f.click('.location-button')
  await wait(() => document.querySelector('.location-confirm')?.textContent.includes('已使用当前位置'))
  await f.click('.sidebar > .create-entry')
  await wait(() => document.querySelector('.address-create-place'))
  s = await state(page)
  assert.match(s.place, /当前位置（仅坐标）/); assert.match(s.place, /未解析门牌地址/); assert.match(s.place, /116\.403243,39\.909403/)
  await page.fill('.address-create input:not([type=checkbox])', '公司')
  await f.click('.address-create-default')
  f.plan.push(500)
  await f.click('.address-create button[type=submit]')
  await wait(() => document.querySelector('.address-create [role=alert]'))
  s = await state(page)
  assert.equal(s.formOpen, true); assert.equal(s.label, '公司'); assert.equal(s.isDefault, true); assert.equal(s.save.disabled, false)
  assert.match(s.alerts[0], /地址未保存：服务器内部错误.*重试/)
  assert.equal(s.focusText, '保存地址', '失败后焦点回到保存按钮以便重试')
  assert.deepEqual(s.rows, [{ text: '家 · 默认', pressed: 'false' }])
  await page.evaluate(() => { document.documentElement.dataset.shotForm = '1' })
  for (const [preset, width] of [['iphone-14', 390], ['desktop-1440', 1440]]) {
    await f.omowright.emulate(page, preset)
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
    const layout = await page.evaluate(() => ({ width: innerWidth, overflow: document.documentElement.scrollWidth > innerWidth,
      targets: ['.address-create button[type=submit]', '.address-create .button-quiet', '.address-create-default', '.address-create input:not([type=checkbox])']
        .map(selector => { const rect = document.querySelector(selector).getBoundingClientRect(); return { selector, height: rect.height, right: rect.right } }) }))
    assert.equal(layout.width, width)
    assert.equal(layout.overflow, false, JSON.stringify(layout))
    for (const target of layout.targets) assert.ok(target.height >= 44 && target.right <= width, JSON.stringify(target))
    writeFileSync(join(f.evidenceDir, `task7-form-error-${width}.png`), await page.screenshot({ fullPage: true }))
    receipt[`layout${width}`] = layout
  }
  const posted = f.posts.length
  await f.click('.address-create button[type=submit]')
  await wait(() => document.querySelector('.save-notice') && !document.querySelector('.address-create'))
  s = await state(page)
  assert.equal(f.posts.length, posted + 1)
  assert.deepEqual(f.posts.at(-1), { label: '公司', location: '116.403243,39.909403', is_default: true })
  assert.deepEqual(s.rows, [{ text: '家', pressed: 'false' }, { text: '公司 · 默认', pressed: 'true' }])
  for (const [preset, width] of [['iphone-14', 390], ['desktop-1440', 1440]]) {
    await f.omowright.emulate(page, preset)
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false)
    writeFileSync(join(f.evidenceDir, `task7-saved-list-${width}.png`), await page.screenshot({ fullPage: true }))
  }
  receipt.cases.push('定位坐标→保存：仅显示坐标不编造门牌；500保留标签/默认勾选并回焦重试；重试成功设默认并选中；390/1440无横溢')

  // 回归：保存成功后的刷新期间用户切换到定位，刷新完成后不能再改选为新地址。
  const until = async (check, message) => {
    for (const deadline = Date.now() + 5000; !check();) {
      assert.ok(Date.now() < deadline, message)
      await new Promise(resolve => setTimeout(resolve, 20))
    }
  }
  await confirmSearch(f)
  await f.click('.sidebar > .create-entry')
  await page.fill('.address-create input:not([type=checkbox])', '公园')
  f.getPlan.push('hold')
  await f.click('.address-create button[type=submit]')
  await until(() => f.heldCount() === 1, '保存后的地址簿刷新应被挂起')
  await f.click('.location-button')
  await wait(() => document.querySelector('.location-confirm')?.textContent.includes('已使用当前位置'))
  f.release()
  await wait(() => document.querySelector('.save-notice') && !document.querySelector('.sidebar > .message'))
  s = await state(page)
  assert.deepEqual(s.rows, [{ text: '家', pressed: 'false' }, { text: '公司 · 默认', pressed: 'false' }, { text: '公园', pressed: 'false' }])
  assert.match(s.notice, /已保存地址「公园」，当前位置已切换/)
  assert.ok(await page.evaluate(() => document.querySelector('.location-confirm')?.textContent.includes('已使用当前位置')), '刷新后仍保持定位选择')
  receipt.cases.push('保存后刷新期间切换定位：刷新完成后保持定位选择，新地址出现但不被选中')

  // 回归：保存时已有地址簿刷新在途（其结果早于写库），保存后仍需等其完成再刷新一次，列表含新地址并选中。
  await f.reset([])
  await confirmSearch(f)
  await f.click('.empty-state .create-entry')
  await page.fill('.address-create input:not([type=checkbox])', '家')
  f.getPlan.push('hold')
  await f.click('.empty-state .button-quiet')
  await until(() => f.heldCount() === 1, '手动刷新应被挂起')
  const before = f.posts.length
  await f.click('.address-create button[type=submit]')
  await until(() => f.posts.length === before + 1, '应发出保存请求')
  f.release()
  await wait(() => document.querySelector('.save-notice') && !document.querySelector('.address-create') && !document.querySelector('.sidebar > .message'))
  s = await state(page)
  assert.deepEqual(s.rows, [{ text: '家 · 默认', pressed: 'true' }], '在途旧刷新结束后列表仍应包含新地址')
  assert.match(s.notice, /已保存为地址「家」并选中/)
  receipt.cases.push('保存时已有刷新在途：等待其完成后再刷新，列表含新地址并选中')

  // 已有地址时入口在列表旁；401 返回登录。
  await f.reset(f.addresses())
  await wait(() => document.querySelector('.sidebar > .create-entry'))
  await confirmSearch(f)
  await f.click('.sidebar > .create-entry')
  await page.fill('.address-create input:not([type=checkbox])', '健身房')
  f.plan.push(401)
  await f.click('.address-create button[type=submit]')
  await wait(() => document.body.textContent.includes('登录已过期，请重新登录'))
  receipt.cases.push('列表旁入口可发现；POST 401 回到登录并提示过期')
  receipt.posts = f.posts.length
  writeFileSync(join(f.evidenceDir, 'task7-browser.json'), JSON.stringify(receipt, null, 2))
})

// F3 A6/H3 回归：桌面 sticky 侧栏内滚动时，保存 500 / 搜索 500 的提示与焦点控件（含 6px 焦点环）须完整落在视口与侧栏可视区内。
const visibility = (page, selector) => page.evaluate(selector => {
  const s = document.querySelector('.sidebar').getBoundingClientRect()
  const top = Math.max(s.top, 0), bottom = Math.min(s.bottom, innerHeight)
  const box = (node, pad) => { const r = node.getBoundingClientRect(); return { top: Math.round(r.top - pad), bottom: Math.round(r.bottom + pad), inside: r.top - pad >= top && r.bottom + pad <= bottom } }
  const focus = document.activeElement, style = getComputedStyle(focus)
  return { visible: { top: Math.round(top), bottom: Math.round(bottom) }, alert: box(document.querySelector(selector), 0),
    focus: { text: focus.textContent.trim() || focus.type, ...box(focus, parseFloat(style.outlineWidth) + parseFloat(style.outlineOffset)) } }
}, selector)

test('F3回归：1440×900 与 1920×1080 下保存/搜索 500 后提示与焦点控件完整可见', async t => {
  const f = await openFixture()
  t.after(f.close)
  const { page, wait } = f
  const receipt = {}
  for (const [width, height] of [[1440, 900], [1920, 1080]]) {
    // 导航会重置仿真参数，须在页面加载后再仿真视口。
    await f.reset()
    await f.omowright.emulate(page, { width, height, deviceScaleFactor: 1, mobile: false, hasTouch: false })
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
    assert.deepEqual(await page.evaluate(() => [innerWidth, innerHeight]), [width, height])
    await confirmSearch(f)
    await f.click('.empty-state .create-entry')
    await wait(() => document.activeElement?.matches('.address-create input:not([type=checkbox])'))
    await page.cdp.send('Input.insertText', { text: '家' }, f.sid)
    f.plan.push(500)
    await page.keyboard.press('Enter')
    await wait(() => document.querySelector('.address-create [role=alert]') && document.activeElement?.type === 'submit')
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
    const save = receipt[`save${width}`] = await visibility(page, '.address-create [role=alert]')
    writeFileSync(join(f.evidenceDir, `f3-save-500-viewport-${width}.png`), await page.screenshot())
    assert.equal(save.focus.text, '保存地址')
    assert.ok(save.alert.inside, `保存失败提示应在可视区内：${JSON.stringify(save)}`)
    assert.ok(save.focus.inside, `保存按钮及焦点环应在可视区内：${JSON.stringify(save)}`)

    await page.keyboard.press('Escape')
    await wait(() => !document.querySelector('.address-create'))
    f.searchPlan.push(500)
    await page.evaluate(() => { const input = document.querySelector('input[type=search]'); input.value = ''; input.focus() })
    await page.cdp.send('Input.insertText', { text: '坏' }, f.sid)
    await wait(() => document.querySelector('#location-search-status[role=alert]'))
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
    const search = receipt[`search${width}`] = await visibility(page, '#location-search-status')
    writeFileSync(join(f.evidenceDir, `f3-search-500-viewport-${width}.png`), await page.screenshot())
    assert.ok(search.alert.inside, `搜索失败提示应在可视区内：${JSON.stringify(search)}`)
    assert.ok(search.focus.inside, `搜索框及焦点环应在可视区内：${JSON.stringify(search)}`)
  }
  writeFileSync(join(f.evidenceDir, 'f3-sidebar-visibility.json'), JSON.stringify(receipt, null, 2))
})
