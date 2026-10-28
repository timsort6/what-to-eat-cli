import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { done, openAcceptanceFixture, pause, respond, searchCandidate, send, sichuanHotpotReply, until } from './acceptance-fixture.mjs'

// 任务14离线端到端验收：一次连贯用户旅程（真实 Edge + 本地受控 API/SSE），每个用例输出 {name, passed, details}，任一失败退出码非 0。
const evidenceRoot = join(tmpdir(), 'opencode', 'task14-evidence-20261023')
const outDir = process.env.TASK14_ACCEPTANCE_DIR ?? join(evidenceRoot, 'acceptance')
const dist = process.env.TASK6_DIST_DIR ?? join(evidenceRoot, 'dist-accept')
mkdirSync(outDir, { recursive: true })

const ev = (state, fields) => ({ state, fields: state === 'unknown' ? [] : fields })
const assess = (id, { range = 'satisfied', food = 'satisfied', price = 'satisfied' } = {}) => ({
  candidate_id: id, range: ev(range, ['location']), food: ev(food, ['type']), price: ev(price, ['business.cost', 'business.currency', 'business.cost_basis']),
})
// 卡片数据：price 已知时带人民币人均来源字段；states 决定 evaluation 三态。
function place(id, name, n, { price = 'satisfied', food = 'satisfied', poiId = true, location = `116.40${n},39.90${n}` } = {}) {
  const key = `poi:${id}`
  return { ...(poiId ? { id } : {}), candidate_key: key, name, address: `${n} 号路`, location, distance: String(300 * n), type: '餐饮服务;中餐厅',
    ...(price === 'unknown' ? {} : { cost: '45', cost_currency: 'CNY', cost_basis: 'per_person' }), evaluation: assess(key, { price, food }) }
}
const ready = (places, reason_codes = []) => ({ status: 'ready', selected_ids: places.map(item => item.candidate_key), reason_codes, options: [], candidates: [], assessments: places.map(item => item.evaluation) })
const needsChoice = {
  status: 'needs_choice', selected_ids: [], reason_codes: ['outside_radius', 'food_mismatch'],
  assessments: [assess('poi:MAOCAI', { food: 'unsatisfied', price: 'unknown' }), assess('poi:GUIZHOU', { food: 'unsatisfied', price: 'unknown' }), assess('poi:FAR', { range: 'unsatisfied', price: 'unknown' })],
  options: [
    { option_id: 'wider', label: '保留四川火锅，扩大到4公里', observed_ids: ['poi:FAR'], reason_codes: ['outside_radius'], changes: { radius_meters: 4000, food_requirement: '四川火锅' } },
    { option_id: 'swap', label: '保持2公里，改吃冒菜或贵州酸汤锅', observed_ids: ['poi:MAOCAI', 'poi:GUIZHOU'], reason_codes: ['food_mismatch'], changes: { food_requirement: '冒菜' } },
  ],
  candidates: [
    { candidate_id: 'poi:MAOCAI', name: '巷口冒菜', address: '一号路', distance_meters: 900 },
    { candidate_id: 'poi:GUIZHOU', name: '贵州酸汤锅', address: '三号路', distance_meters: 1500 },
    { candidate_id: 'poi:FAR', name: '远处川锅', address: '二号路', distance_meters: 3600 },
  ],
}

const f = await openAcceptanceFixture(dist)
const { page, wait, chats } = f
const results = []
let cleanup = null

const view = () => page.evaluate(() => ({
  markdown: document.querySelector('.markdown-body')?.innerText ?? '',
  panel: Boolean(document.querySelector('.negotiation')),
  panelText: document.querySelector('.negotiation')?.innerText ?? '',
  cards: [...document.querySelectorAll('.place-card')].map(node => ({ tag: node.tagName, name: node.querySelector('h3').textContent, href: node.getAttribute('href'), text: node.innerText.replace(/\s+/g, ' ') })),
  summary: document.querySelector('.preference-summary')?.textContent.replace('当前条件：', '').trim() ?? '',
  used: [...document.querySelectorAll('.result-status:not([role])')].map(node => node.textContent),
  status: document.querySelector('.result-status[role=status]')?.textContent ?? '',
  busy: Boolean(document.querySelector('.streaming-label')),
  resultText: document.querySelector('.result-section')?.innerText ?? '',
}))
async function setSelect(label, value) {
  await page.evaluate(([label, value]) => {
    const field = [...document.querySelectorAll('.preferences label.field')].find(node => node.querySelector('span').textContent.startsWith(label))
    const select = field.querySelector('select')
    select.value = value
    select.dispatchEvent(new Event('change', { bubbles: true }))
  }, [label, value])
}
// 提交一轮需求并返回新到达的本地 SSE 连接。
async function ask(text) {
  const before = chats.length
  await page.fill('.ask-panel textarea', text)
  await f.click('.ask-panel button[type=submit]')
  await until(() => chats.length > before, `“${text}”应发出推荐请求`)
  return chats.at(-1)
}
const finished = () => wait(() => !document.querySelector('.streaming-label') && document.querySelector('.result-status[role=status]') && !document.querySelector('.result-status[role=status]').textContent.includes('正在生成'))
const newConversation = async () => { await f.click('.content-header .text-button'); await wait(() => document.querySelector('.result-status[role=status]')?.textContent.includes('已开始新对话')) }
async function shot(file) {
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
  const width = await page.evaluate(() => innerWidth)
  assert.equal(width, 1440, '截图视口应为 1440 宽')
  writeFileSync(join(outDir, file), await page.screenshot({ fullPage: true }))
  return file
}
async function run(name, body) {
  const details = {}
  try {
    await body(details)
    results.push({ name, passed: true, details })
  } catch (failure) {
    results.push({ name, passed: false, details: { ...details, error: failure?.message ?? String(failure) } })
  }
  console.log(JSON.stringify(results.at(-1).passed ? { case: name, passed: true } : results.at(-1)))
}

try {
  await f.omowright.emulate(page, 'desktop-1440')
  await page.cdp.send('Browser.setPermission', { permission: { name: 'geolocation' }, setting: 'denied', origin: f.origin })
  await page.goto(f.origin, { waitUntil: 'load' })
  await wait(() => document.querySelector('input[type=search]') && !document.querySelector('.sidebar > .message'))

  await run('01 拒绝定位后搜索并确认地点（不写地址簿）', async d => {
    await f.click('.location-button')
    await wait(() => document.querySelector('.sidebar [role=alert]')?.textContent.includes('定位权限被拒绝'))
    d.geoError = await page.evaluate(() => document.querySelector('.sidebar [role=alert]').textContent)
    await page.fill('input[type=search]', '公园')
    await wait(() => document.querySelector('.location-search .address-row'))
    await f.click('.location-search .address-row')
    await f.click('.location-search .button-primary')
    await wait(() => document.querySelector('.location-confirm')?.textContent.includes('已使用：测试公园'))
    d.locationLine = await page.evaluate(() => document.querySelector('.location-line').textContent)
    assert.equal(d.locationLine, `${searchCandidate.name} · ${searchCandidate.address}`, '已确认搜索地点显示名称 · 地址而非坐标')
    await pause(200)
    assert.equal(f.posts.length, 0, '搜索确认不得写地址簿')
    d.searchRequests = f.searches.length; d.addressPosts = f.posts.length
    d.screenshot = await shot('case-01-denied-search-confirm-1440.png')
  })

  await run('02 保存为地址：首地址默认；保存500保留输入，重试成功', async d => {
    await f.click('.empty-state .create-entry')
    await wait(() => document.querySelector('.address-create-place')?.textContent.includes('测试公园'))
    await page.fill('.address-create input:not([type=checkbox])', '家')
    f.postPlan.push(500)
    await f.click('.address-create button[type=submit]')
    await wait(() => document.querySelector('.address-create [role=alert]'))
    const failed = await page.evaluate(() => ({
      alert: document.querySelector('.address-create [role=alert]').textContent, label: document.querySelector('.address-create input:not([type=checkbox])').value,
      place: document.querySelector('.address-create-place').innerText, saveEnabled: !document.querySelector('.address-create button[type=submit]').disabled,
    }))
    d.afterError = failed
    assert.match(failed.alert, /地址未保存：服务器内部错误.*重试/)
    assert.equal(failed.label, '家'); assert.match(failed.place, /测试公园/); assert.equal(failed.saveEnabled, true)
    d.screenshot = await shot('case-02-save-500-preserved-1440.png')
    await f.click('.address-create button[type=submit]')
    await wait(() => document.querySelector('.save-notice') && !document.querySelector('.address-create'))
    assert.equal(f.posts.length, 2, '失败一次 + 重试一次')
    const expected = { label: '家', location: searchCandidate.location, is_default: false, name: '测试公园', address: '东门' }
    assert.deepEqual(f.posts, [expected, expected], '重试请求与首次一致，默认由服务器决定')
    d.rows = await page.evaluate(() => [...document.querySelectorAll('.address-list:not(.location-search *) .address-row')].map(row => ({ text: row.querySelector('strong').textContent, pressed: row.getAttribute('aria-pressed') })))
    assert.deepEqual(d.rows, [{ text: '家 · 默认', pressed: 'true' }])
    d.notice = await page.evaluate(() => document.querySelector('.save-notice').textContent)
    assert.match(d.notice, /已保存为地址「家」并选中/)
  })

  let first
  await run('03 四项偏好进入实际请求体', async d => {
    await setSelect('推荐数量', '5'); await setSelect('搜索范围', '5000'); await setSelect('用餐安排', 'quick'); await setSelect('人均上限', '50')
    first = await ask('想吃点快的')
    d.body = { address_id: first.body.address_id, preferences: first.body.preferences, hasSelection: 'selection' in first.body }
    assert.equal(first.body.address_id, 1)
    assert.equal('selection' in first.body, false)
    assert.deepEqual(first.body.preferences, { target_count: 5, radius_meters: 5000, meal_style: 'quick', max_price_cny: 50, allow_unknown_price: true, food_requirement: null })
    d.summary = (await view()).summary
    for (const text of ['5 家', '5 公里内', '快速用餐', '人均 50 元以内']) assert.ok(d.summary.includes(text), text)
    d.screenshot = await shot('case-03-preferences-request-1440.png')
  })

  await run('04 精确匹配 ready：decision 先于正文、首块早于末块、卡片与 selected_ids 一一对应', async d => {
    assert.ok(first, '依赖用例03的请求')
    const places = [1, 2, 3, 4, 5].map(n => place(`B0EXACT00${n}`, `精确小馆${n}`, n))
    const decision = ready(places)
    send(first, 'decision', decision)
    send(first, 'delta', { text: '## 精确匹配推荐\n\n首块：五家均在 5 公里内。' })
    await wait(() => document.querySelector('.markdown-body')?.textContent.includes('首块'))
    const shownAt = Date.now()
    const early = await view()
    assert.equal(early.busy, true, '首块显示时仍在生成')
    assert.doesNotMatch(early.markdown, /末块/)
    assert.deepEqual(early.cards, [], 'done 前不显示卡片')
    await pause(400)
    send(first, 'delta', { text: '\n\n中块：人均 45 元。' })
    await pause(300)
    const tail = '\n\n末块：以上为全部推荐。'
    send(first, 'delta', { text: tail })
    const lastAt = first.writes.at(-1).at
    done(first, decision, '## 精确匹配推荐\n\n首块：五家均在 5 公里内。\n\n中块：人均 45 元。' + tail, places)
    await finished()
    const s = await view()
    const order = first.writes.map(item => item.name)
    d.eventOrder = order; d.firstShownBeforeLastChunkMs = lastAt - shownAt
    assert.equal(order[0], 'decision'); assert.ok(order.indexOf('decision') < order.indexOf('delta'))
    assert.ok(shownAt < lastAt, 'UI 必须在末块写出前已显示首块')
    assert.match(s.status, /推荐完成/)
    assert.deepEqual(s.cards.map(card => card.name), places.map(item => item.name), '卡片顺序与 selected_ids 一致')
    assert.deepEqual(s.cards.map(card => card.href), places.map(item => `https://uri.amap.com/poidetail?poiid=${item.id}&callnative=0`))
    assert.equal(s.cards.length, decision.selected_ids.length)
    for (const card of s.cards) assert.ok(card.text.includes('参考人均 ¥45'), card.text)
    assert.ok(s.markdown.includes('末块'))
    d.cards = s.cards.map(card => card.name); d.selected_ids = decision.selected_ids
    d.screenshot = await shot('case-04-exact-ready-1440.png')
  })

  let wider
  await run('05 2km 只有冒菜/贵州锅 → needs_choice → 扩大到4km → 新 ready', async d => {
    await newConversation()
    await setSelect('搜索范围', '2000')
    const chat = await ask('2公里内的四川火锅')
    // 真实首轮请求形状：没有品类控件，food_requirement 为 null；夹具按请求体与原话判定（不再写死 needs_choice）。
    d.firstBody = { preferences: chat.body.preferences, hasSelection: 'selection' in chat.body }
    assert.equal(chat.body.preferences.radius_meters, 2000); assert.equal(chat.body.preferences.food_requirement, null); assert.equal('selection' in chat.body, false)
    const first = sichuanHotpotReply(chat)
    assert.equal(first.status, 'needs_choice', '夹具据原话理解品类后应协商')
    await wait(() => document.querySelector('.negotiation-option .button-primary') && !document.querySelector('.negotiation-option .button-primary').disabled)
      .catch(async failure => { d.stateOnTimeout = { ...(await view()), alert: await page.evaluate(() => document.querySelector('[role=alert]')?.textContent ?? '') }; throw failure })
    let s = await view()
    d.roundOne = { summary: s.summary, used: s.used }
    assert.deepEqual(s.cards, [], 'needs_choice 卡片为空')
    for (const text of ['巷口冒菜', '贵州酸汤锅', '远处川锅', '保留四川火锅，扩大到4公里']) assert.ok(s.panelText.includes(text), text)
    assert.match(s.summary, /品类：四川火锅/, '被采纳的原话品类同步到条件摘要')
    assert.ok(s.used.some(line => line.includes('品类“四川火锅”据你的原话“四川火锅”理解')), '显示品类来源')
    await f.click('.negotiation-option .button-primary')
    await until(() => chats.length > chats.indexOf(chat) + 1, '点选扩大后应发新请求')
    wider = chats.at(-1)
    d.selection = wider.body.selection
    const adopted = { ...chat.body.preferences, food_requirement: '四川火锅' }
    assert.deepEqual(wider.body.preferences, { ...adopted, radius_meters: 4000 })
    assert.deepEqual(wider.body.selection, { option_id: 'wider', previous_preferences: adopted, changes: { radius_meters: 4000 } }, 'previous_preferences 取 done.preferences')
    const second = sichuanHotpotReply(wider)
    assert.equal(second.status, 'ready')
    await finished()
    s = await view()
    d.summary = s.summary; d.used = s.used; d.cards = s.cards.map(card => card.name)
    assert.match(s.summary, /4 公里内/); assert.match(s.summary, /品类：四川火锅/)
    assert.ok(s.used.includes(`本次提交条件：${s.summary}`), '本次提交条件与当前摘要一致')
    assert.deepEqual(d.cards, ['远处川锅', '川味火锅二店', '老码头火锅'])
    assert.equal(s.panel, false)
    d.screenshot = await shot('case-05-wider-4km-ready-1440.png')
  })

  await run('07 未知价格/品类仍推荐：显示待核实、无“符合”字样', async d => {
    assert.ok(wider, '依赖用例05的4km+四川火锅条件')
    await setSelect('人均上限', '50')
    const chat = await ask('再看看别的')
    assert.equal(chat.body.preferences.food_requirement, '四川火锅'); assert.equal(chat.body.preferences.max_price_cny, 50); assert.equal(chat.body.preferences.allow_unknown_price, true)
    const places = [1, 2, 3].map(n => place(`B0UNK000${n}`, `待核实火锅${n}`, n, { price: 'unknown', food: 'unknown' }))
    respond(chat, ready(places, ['unknown_price', 'unknown_evidence']), '以下店铺的价格与细分品类来源未提供，仅供参考。', places)
    await finished()
    const s = await view()
    d.cardTexts = s.cards.map(card => card.text)
    assert.equal(s.cards.length, 3, '未知字段的候选仍应推荐')
    for (const text of d.cardTexts) { assert.ok(text.includes('价格待核实'), text); assert.ok(text.includes('细分品类待核实'), text) }
    assert.doesNotMatch(s.resultText, /符合/, '结果区不得出现“符合”')
    d.screenshot = await shot('case-07-unknown-fields-1440.png')
  })

  await run('06 “保持原条件”与输入“好的”不发 selection/扩大请求', async d => {
    await newConversation()
    await setSelect('搜索范围', '2000')
    const chat = await ask('想吃四川火锅')
    respond(chat, needsChoice, '请选择')
    await wait(() => document.querySelector('.negotiation .button-quiet') && !document.querySelector('.negotiation .button-quiet').disabled)
    const before = chats.length
    await f.click('.negotiation .button-quiet')
    await wait(() => !document.querySelector('.negotiation') && document.activeElement?.tagName === 'TEXTAREA')
    await pause(400)
    assert.equal(chats.length, before, '保持原条件不得发请求')
    d.status = (await view()).status
    assert.match(d.status, /已保留原条件，未扩大搜索/)
    d.screenshot = await shot('case-06-keep-conditions-1440.png')
    const ok = await ask('好的')
    d.okBody = { hasSelection: 'selection' in ok.body, radius: ok.body.preferences.radius_meters, food: ok.body.preferences.food_requirement, last: ok.body.messages.at(-1).content }
    assert.equal('selection' in ok.body, false); assert.equal(ok.body.preferences.radius_meters, 2000); assert.equal(ok.body.preferences.food_requirement, null)
    await pause(300)
    assert.equal(chats.length, before + 1, '“好的”只发一次普通请求')
    respond(ok, needsChoice, '请选择')
    await finished()
  })

  await run('08 数量不足说明缺口', async d => {
    await newConversation()
    await setSelect('推荐数量', '5')
    const chat = await ask('附近随便吃点')
    assert.equal(chat.body.preferences.target_count, 5)
    const places = [place('B0FEW0001', '仅有小馆一', 1), place('B0FEW0002', '仅有小馆二', 2)]
    respond(chat, ready(places, ['insufficient_count']), '## 推荐\n\n本次仅找到 2 家，少于期望的 5 家；没有为凑数放宽条件。', places)
    await finished()
    const s = await view()
    d.cards = s.cards.map(card => card.name); d.markdown = s.markdown
    assert.equal(s.cards.length, 2)
    assert.match(s.markdown, /仅找到 2 家，少于期望的 5 家/)
    // ready 且卡片少于期望数量：界面确定性显示数量缺口，不依赖正文。
    d.used = s.used
    assert.ok(s.used.includes('找到 2 家（期望 5 家）'), '应显示结构化数量缺口')
    d.screenshot = await shot('case-08-insufficient-count-1440.png')
  })

  await run('09 取消进行中请求后新对话无旧内容/旧方案', async d => {
    const old = await ask('取消测试')
    send(old, 'decision', needsChoice)
    send(old, 'delta', { text: '旧正文OLD-CONTENT' })
    await wait(() => document.querySelector('.negotiation') && document.querySelector('.markdown-body')?.textContent.includes('旧正文'))
    await f.click('.ask-actions .button-quiet')
    await wait(() => document.querySelector('.result-status[role=status]')?.textContent.includes('已取消'))
    await until(() => old.closed, '取消应中止连接')
    await newConversation()
    send(old, 'delta', { text: '迟到正文LATE' }); done(old, needsChoice, '迟到正文LATE')
    await pause(300)
    let s = await view()
    assert.equal(s.panel, false); assert.deepEqual(s.cards, []); assert.equal(s.markdown, '')
    assert.doesNotMatch(s.resultText, /旧正文|迟到正文|仅有小馆/)
    const fresh = await ask('新的需求')
    d.freshMessages = fresh.body.messages.map(message => message.content)
    assert.deepEqual(d.freshMessages, ['新的需求'], '新对话不得携带旧轮次')
    const places = [place('B0NEW0001', '新对话小馆', 1)]
    respond(fresh, ready(places, ['insufficient_count']), '新对话的推荐。', places)
    await finished()
    s = await view()
    d.cards = s.cards.map(card => card.name)
    assert.deepEqual(d.cards, ['新对话小馆']); assert.equal(s.panel, false)
    assert.doesNotMatch(s.resultText, /旧正文|迟到正文|仅有小馆/)
    d.screenshot = await shot('case-09-cancel-new-conversation-1440.png')
  })

  await run('10 卡片：ID→poidetail、坐标→marker、无ID无坐标为非链接', async d => {
    const chat = await ask('看看卡片')
    const places = [
      place('B0FFH5ZK1A', '川味小馆', 1),
      place('NOID', '无号&小馆#1', 2, { poiId: false, location: '116.402,39.902' }),
      place('NOLOC', '无坐标小店', 3, { poiId: false, location: '' }),
    ]
    respond(chat, ready(places), '三张卡片', places)
    await finished()
    const s = await view()
    const detailURL = 'https://uri.amap.com/poidetail?poiid=B0FFH5ZK1A&callnative=0'
    const markerURL = `https://uri.amap.com/marker?position=116.402,39.902&${new URLSearchParams({ name: '无号&小馆#1', coordinate: 'gaode', callnative: '0' })}`
    assert.deepEqual(s.cards.map(card => card.tag), ['A', 'A', 'ARTICLE'])
    assert.equal(s.cards[0].href, detailURL); assert.equal(s.cards[1].href, markerURL); assert.equal(s.cards[2].href, null)
    d.screenshot = await shot('case-10-cards-1440.png')
    let before = f.opened.length
    await f.click('a.place-card[href^="https://uri.amap.com/poidetail"]')
    d.openedDetail = await f.nextOpened(before)
    before = f.opened.length
    await f.click('a.place-card[href^="https://uri.amap.com/marker"]')
    d.openedMarker = await f.nextOpened(before)
    assert.equal(d.openedDetail, detailURL); assert.equal(d.openedMarker, markerURL)
    before = f.opened.length
    await f.click('article.place-card')
    await pause(400)
    assert.equal(f.opened.length, before, '非链接卡点击不得打开页面')
    d.refusedByGuard = f.guard.refused.filter(entry => entry.includes('uri.amap.com'))
    assert.ok(d.refusedByGuard.length > 0, '新页导航只应到达本地拒绝代理')
  })

  await run('11 恶意 Markdown 零执行零资源请求', async d => {
    const track = `${f.origin}/track`
    const payload = [
      '## 恶意内容测试', `<script>window.__acceptanceAttack=1</script>`, `<img src="${track}" onerror="window.__acceptanceAttack=1">`,
      `<svg onload="window.__acceptanceAttack=1"><image href="${track}"/></svg>`, `<iframe src="${track}"></iframe><style>@import '${track}';</style>`,
      `<link rel="stylesheet" href="${track}"><object data="${track}"></object><video poster="${track}"><source src="${track}"></video>`,
      `![追踪](${track}) ![外部](https://tracker.invalid/pixel)`, '[点我](javascript:window.__acceptanceAttack=1) [编码](java&#x73;cript:window.__acceptanceAttack=1)',
      `<form action="${track}"><input autofocus onfocus="window.__acceptanceAttack=1"></form>`, `<div style="background:url(${track})">背景</div>`,
    ].join('\n\n')
    const refusedBefore = f.guard.refused.length, straysBefore = f.strays.length
    const chat = await ask('恶意测试')
    const places = [place('NOLINK', '安全小店', 1, { poiId: false, location: '' })]
    respond(chat, ready(places), payload, places)
    await finished()
    await pause(800)
    d.dom = await page.evaluate(() => {
      const body = document.querySelector('.markdown-body')
      return {
        rendered: body.querySelector('h2')?.textContent ?? '',
        executed: window.__acceptanceAttack ?? null,
        dangerous: body.querySelectorAll('script,img,iframe,svg,math,style,link,object,embed,video,audio,source,form,input,image').length,
        handlers: [...body.querySelectorAll('*')].filter(node => [...node.attributes].some(attr => /^on/i.test(attr.name) || attr.name === 'style')).length,
        scriptHrefs: [...body.querySelectorAll('a')].filter(node => !/^https?:/i.test(node.getAttribute('href') ?? 'https:')).length,
        resources: performance.getEntriesByType('resource').filter(entry => /track/.test(entry.name)).map(entry => entry.name),
      }
    })
    d.localStrayRequests = f.strays.slice(straysBefore)
    // Edge 自身后台联网（bing/msn/office 等）与页面无关，可能随时落在本窗口内；单列记录，只把其余外部请求计为页面资源请求。
    const delta = f.guard.refused.slice(refusedBefore)
    d.edgeBackgroundRefused = delta.filter(entry => /microsoft|msn\.|bing\.|office\.|live\.com|windows\./.test(entry))
    d.externalRefusedDelta = delta.length - d.edgeBackgroundRefused.length
    assert.equal(d.dom.rendered, '恶意内容测试', '恶意正文须实际进入渲染路径')
    assert.equal(d.dom.executed, null, '恶意脚本不得执行')
    assert.equal(d.dom.dangerous, 0); assert.equal(d.dom.handlers, 0); assert.equal(d.dom.scriptHrefs, 0)
    assert.deepEqual(d.dom.resources, []); assert.deepEqual(d.localStrayRequests, []); assert.equal(d.externalRefusedDelta, 0)
    d.screenshot = await shot('case-11-malicious-markdown-1440.png')
  })
} catch (failure) {
  results.push({ name: '夹具/浏览器启动', passed: false, details: { error: failure?.message ?? String(failure) } })
} finally {
  cleanup = await f.close()
}

results.sort((a, b) => a.name.localeCompare(b.name))
const guard = cleanup.networkGuard
const cleanOk = cleanup.browserClosed && cleanup.browserProcessExited !== false && cleanup.serverClosed && cleanup.profileRemoved && guard?.forwarded === 0 && !guard?.error
const report = {
  test: 'task14-acceptance', generatedAt: new Date().toISOString(), browser: 'Edge（TASK6_BROWSER_PATH，headless，任务自有 profile）', viewport: 'desktop-1440',
  passed: results.every(item => item.passed) && results.length === 11 && cleanOk,
  summary: { total: results.length, passed: results.filter(item => item.passed).length, failed: results.filter(item => !item.passed).map(item => item.name) },
  cases: results,
  externalRequests: { refused: guard?.refused ?? null, forwarded: guard?.forwarded ?? null, refusedHosts: guard?.refusedHosts ?? null },
  localStrayRequests: f.strays,
  cleanup: { ...cleanup, networkGuard: undefined },
}
// 脱敏：用户目录替换为 ~，不输出令牌、profile 路径与请求原文。
const home = homedir()
const json = JSON.stringify(report, (key, value) => key === 'profile' ? undefined : typeof value === 'string' ? value.split(home).join('~') : value, 2)
writeFileSync(join(outDir, 'task-14-acceptance.json'), json)
console.log(JSON.stringify({ acceptance: report.summary, externalRequests: report.externalRequests, cleanOk }))
process.exitCode = report.passed ? 0 : 1
