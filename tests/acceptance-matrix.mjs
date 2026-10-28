import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { openAcceptanceFixture, pause, respond, until } from './acceptance-fixture.mjs'
import { guardedBrowserArgs, startNetworkGuard } from './browser-network-guard.mjs'

// 任务14截图矩阵：A 段离线（经拒绝代理，转发须为 0）采集 6 个关键界面状态 × 3 宽度 × 系统 light/dark × 首屏/底部/关键区，
// 另加 reduced-motion 与键盘焦点帧并生成联系表；B 段为独立可选的公开高德 URI 可达性检查，结果单独记录、不计入退出码。
const evidenceRoot = join(tmpdir(), 'opencode', 'task14-evidence-20261023')
const outDir = process.env.TASK14_MATRIX_DIR ?? join(evidenceRoot, 'matrix')
const dist = process.env.TASK6_DIST_DIR ?? join(evidenceRoot, 'dist-accept')
const frameDir = join(outDir, 'frames')
mkdirSync(frameDir, { recursive: true })
const home = homedir()
const redact = (key, value) => key === 'profile' ? undefined : typeof value === 'string' ? value.split(home).join('~') : value

const WIDTHS = [
  { width: 390, preset: 'iphone-14', dpr: 3 },
  { width: 1440, preset: 'desktop-1440', dpr: 1 },
  { width: 1920, preset: 'desktop-1440', dpr: 1, metrics: { width: 1920, height: 1080, deviceScaleFactor: 1, mobile: false } },
]
const ev = (state, fields) => ({ state, fields: state === 'unknown' ? [] : fields })
const assess = (id, { range = 'satisfied', food = 'satisfied', price = 'satisfied' } = {}) => ({
  candidate_id: id, range: ev(range, ['location']), food: ev(food, ['type']), price: ev(price, ['business.cost', 'business.currency', 'business.cost_basis']),
})
function place(id, name, n, { poiId = true, location = `116.40${n},39.90${n}` } = {}) {
  const key = `poi:${id}`
  return { ...(poiId ? { id } : {}), candidate_key: key, name, address: `${n} 号路`, location, distance: String(300 * n), type: '餐饮服务;中餐厅',
    cost: '45', cost_currency: 'CNY', cost_basis: 'per_person', evaluation: assess(key) }
}
const ready = places => ({ status: 'ready', selected_ids: places.map(item => item.candidate_key), reason_codes: [], options: [], candidates: [], assessments: places.map(item => item.evaluation) })
const needsChoice = {
  status: 'needs_choice', selected_ids: [], reason_codes: ['outside_radius', 'food_mismatch'],
  assessments: [assess('poi:MAOCAI', { food: 'unsatisfied', price: 'unknown' }), assess('poi:GUIZHOU', { food: 'unsatisfied', price: 'unknown' }), assess('poi:FAR', { range: 'unsatisfied', price: 'unknown' })],
  options: [
    { option_id: 'wider', label: '保留四川火锅，扩大到4公里', observed_ids: ['poi:FAR'], reason_codes: ['outside_radius'], changes: { radius_meters: 4000, food_requirement: '四川火锅' } },
    { option_id: 'swap', label: '保持范围，改吃冒菜或贵州酸汤锅', observed_ids: ['poi:MAOCAI', 'poi:GUIZHOU'], reason_codes: ['food_mismatch'], changes: { food_requirement: '冒菜' } },
  ],
  candidates: [
    { candidate_id: 'poi:MAOCAI', name: '巷口冒菜', address: '一号路', distance_meters: 900 },
    { candidate_id: 'poi:GUIZHOU', name: '贵州酸汤锅', address: '三号路', distance_meters: 1500 },
    { candidate_id: 'poi:FAR', name: '远处川锅', address: '二号路', distance_meters: 3600 },
  ],
}
const pngSize = buffer => ({ width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) })

// ---------- A. 离线截图矩阵 ----------
const frames = [], extras = [], focus = [], failures = [], sheets = []
let cleanup = null
const f = await openAcceptanceFixture(dist)
const { page, wait, chats } = f
const sid = await page.resolveSessionId()
const media = (scheme, motion = 'no-preference') => page.cdp.send('Emulation.setEmulatedMedia', {
  features: [{ name: 'prefers-color-scheme', value: scheme }, { name: 'prefers-reduced-motion', value: motion }],
}, sid)
async function emulate({ preset, metrics }) {
  await f.omowright.emulate(page, preset)
  if (metrics) await page.cdp.send('Emulation.setDeviceMetricsOverride', metrics, sid)
}
const settle = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
// 每帧度量：横向溢出、body 背景是否等于浅色 token、媒体仿真是否生效、关键区域是否在本帧可见、关键区内部元素是否被裁切。
const measure = target => page.evaluate(target => {
  const root = document.documentElement
  const hex = getComputedStyle(root).getPropertyValue('--surface-primary').trim()
  const token = `rgb(${[1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16)).join(', ')})`
  const bg = getComputedStyle(document.body).backgroundColor
  const [r, g, b] = bg.match(/\d+/g).map(Number)
  const region = document.querySelector(target)
  const rect = region?.getBoundingClientRect()
  // 关键区“头部”= 前两个可见子元素（标题 + 首段/首项）：须完整落在视口内，且中心点未被其它元素遮挡。
  const heads = region ? [...region.children].filter(node => node.getClientRects().length).slice(0, 2).map(node => {
    const box = node.getBoundingClientRect()
    const hit = document.elementFromPoint(Math.min(box.left + box.width / 2, innerWidth - 1), Math.min(box.top + box.height / 2, innerHeight - 1))
    // 容差 1px：DPR=3 时 scrollIntoView 后 top 可能为 -0.33 等亚像素值。
    return { tag: node.tagName, text: node.textContent.replace(/\s+/g, ' ').trim().slice(0, 30), top: +box.top.toFixed(2), bottom: +box.bottom.toFixed(2),
      hit: hit ? `${hit.tagName}.${String(hit.className)}` : null, inside: Boolean(hit && region.contains(hit)),
      visible: box.top >= -1 && box.bottom <= innerHeight + 1 && Boolean(hit && region.contains(hit)) }
  }) : []
  // 内部裁切：scrollWidth > clientWidth+1 且自身与区内祖先都不是横向滚动容器（代码块/表格自带 overflow-x:auto，视为允许）。
  const scroller = node => ['auto', 'scroll'].includes(getComputedStyle(node).overflowX)
  const clipped = region ? [region, ...region.querySelectorAll('*')].filter(node => {
    if (!(node.scrollWidth > node.clientWidth + 1)) return false
    for (let up = node; up && up !== region.parentElement; up = up.parentElement) if (scroller(up)) return false
    return true
  }).map(node => ({ tag: node.tagName, className: String(node.className), text: node.textContent.replace(/\s+/g, ' ').trim().slice(0, 40),
    scrollWidth: node.scrollWidth, clientWidth: node.clientWidth, overflowX: getComputedStyle(node).overflowX })) : null
  return {
    scrollWidth: root.scrollWidth, clientWidth: root.clientWidth, overflow: root.scrollWidth > root.clientWidth,
    bg, token, bgLight: bg === token && (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255 > 0.85, colorScheme: getComputedStyle(root).colorScheme,
    prefersDark: matchMedia('(prefers-color-scheme: dark)').matches, reducedMotion: matchMedia('(prefers-reduced-motion: reduce)').matches,
    innerWidth, innerHeight, dpr: devicePixelRatio, scrollY: Math.round(scrollY),
    targetVisible: Boolean(rect && rect.bottom > 0 && rect.top < innerHeight),
    keyVisible: Boolean(rect && rect.top >= -1 && rect.top < innerHeight && heads.length && heads.every(head => head.visible)),
    regionTop: rect ? Math.round(rect.top) : null, heads, clipped,
  }
}, target)
async function snap(file, expectWidth, expectDpr) {
  await settle()
  const buffer = await page.screenshot()
  const size = pngSize(buffer)
  const view = await page.evaluate(() => ({ w: innerWidth, h: innerHeight }))
  assert.equal(view.w, expectWidth, `${file} 视口宽度`)
  assert.deepEqual(size, { width: view.w * expectDpr, height: view.h * expectDpr }, `${file} PNG 尺寸应等于视口×DPR`)
  const path = join(frameDir, file)
  writeFileSync(path, buffer)
  return { path, png: size }
}
// 一个状态的 18 帧：宽度 × 系统配色 × 首屏/底部/关键区（scrollIntoView block:start）；状态已在 1440 浅色下搭好，仿真切换不改变 Vue 状态。
// targetVisible 在首屏/底部帧仅记录；key 帧断言 keyVisible（区域顶部 + 标题/首段完整可见且未被遮挡）。所有帧断言关键区无内部裁切。
async function capture(state, target) {
  for (const spec of WIDTHS) {
    await emulate(spec)
    for (const scheme of ['light', 'dark']) {
      await media(scheme)
      for (const scroll of ['top', 'bottom', 'key']) {
        await page.evaluate(([scroll, target]) => scroll === 'key'
          ? document.querySelector(target).scrollIntoView({ block: 'start', behavior: 'instant' })
          : window.scrollTo(0, scroll === 'top' ? 0 : document.documentElement.scrollHeight), [scroll, target])
        await settle()
        const m = await measure(target)
        const file = `${state}-${spec.width}-${scheme}-${scroll}.png`
        const { path, png } = await snap(file, spec.width, spec.dpr)
        const frame = { state, width: spec.width, scheme, scroll, path, overflow: m.overflow, bgLight: m.bgLight,
          schemeApplied: m.prefersDark === (scheme === 'dark'), colorScheme: m.colorScheme, bg: m.bg, dpr: m.dpr, png, scrollY: m.scrollY, targetVisible: m.targetVisible,
          clipped: m.clipped, ...(scroll === 'key' ? { keyVisible: m.keyVisible, regionTop: m.regionTop, heads: m.heads } : {}) }
        frames.push(frame)
        if (frame.overflow || !frame.bgLight || !frame.schemeApplied) failures.push(`${file}: overflow=${frame.overflow} bgLight=${frame.bgLight} schemeApplied=${frame.schemeApplied}`)
        if (!m.clipped || m.clipped.length) failures.push(`${file}: 关键区内部裁切 ${JSON.stringify(m.clipped)}`)
        if (scroll === 'key' && !m.keyVisible) failures.push(`${file}: 关键区不可见 regionTop=${m.regionTop} heads=${JSON.stringify(m.heads)}`)
      }
    }
  }
  await emulate(WIDTHS[1]); await media('light')
}
// reduced-motion 帧：1440 浅色，关键区域滚入视口中央。
async function reduced(state, target) {
  await emulate(WIDTHS[1]); await media('light', 'reduce')
  await page.evaluate(target => document.querySelector(target).scrollIntoView({ block: 'center' }), target)
  const m = await measure(target)
  const { path } = await snap(`${state}-1440-light-reduced-motion.png`, 1440, 1)
  extras.push({ state, width: 1440, scheme: 'light', scroll: 'target', motion: 'reduce', path, overflow: m.overflow, bgLight: m.bgLight, reducedApplied: m.reducedMotion, targetVisible: m.targetVisible })
  if (m.overflow || !m.bgLight || !m.reducedMotion || !m.targetVisible) failures.push(`${state} reduced-motion 帧异常`)
  await media('light')
}
// 键盘导航：先点页面左上空白处把顺序焦点起点放到页面顶部，再逐次 Tab 直到命中目标。
async function tabTo(name, selector) {
  await emulate(WIDTHS[1]); await media('light')
  await page.evaluate(() => { document.activeElement?.blur(); window.scrollTo(0, 0) })
  await settle()
  for (const type of ['mousePressed', 'mouseReleased']) await page.cdp.send('Input.dispatchMouseEvent', { type, x: 2, y: 2, button: 'left', buttons: type === 'mousePressed' ? 1 : 0, clickCount: 1 }, sid)
  let tabs = 0, hit = false
  while (!hit && tabs < 150) {
    for (const type of ['rawKeyDown', 'keyUp']) await page.cdp.send('Input.dispatchKeyEvent', { type, key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9, nativeVirtualKeyCode: 9 }, sid)
    tabs++
    hit = await page.evaluate(selector => document.activeElement?.matches(selector) ?? false, selector)
  }
  const info = await page.evaluate(() => {
    const node = document.activeElement, style = getComputedStyle(node), rect = node.getBoundingClientRect()
    return { tag: node.tagName, text: node.textContent.replace(/\s+/g, ' ').trim().slice(0, 40), focusVisible: node.matches(':focus-visible'),
      outlineStyle: style.outlineStyle, outlineWidth: parseFloat(style.outlineWidth), outlineColor: style.outlineColor, inViewport: rect.top >= 0 && rect.bottom <= innerHeight }
  })
  const { path } = await snap(`focus-${name}-1440-light.png`, 1440, 1)
  const passed = hit && info.focusVisible && info.outlineStyle !== 'none' && info.outlineWidth >= 2 && info.inViewport
  focus.push({ name, selector, tabs, reached: hit, ...info, path, passed })
  if (!passed) failures.push(`焦点 ${name} 未满足：${JSON.stringify(info)}`)
}

async function setSelect(label, value) {
  await page.evaluate(([label, value]) => {
    const field = [...document.querySelectorAll('.preferences label.field')].find(node => node.querySelector('span').textContent.startsWith(label))
    const select = field.querySelector('select')
    select.value = value
    select.dispatchEvent(new Event('change', { bubbles: true }))
  }, [label, value])
}
async function ask(text) {
  const before = chats.length
  await page.fill('.ask-panel textarea', text)
  await f.click('.ask-panel button[type=submit]')
  await until(() => chats.length > before, `“${text}”应发出推荐请求`)
  return chats.at(-1)
}
const finished = () => wait(() => !document.querySelector('.streaming-label') && document.querySelector('.result-status[role=status]') && !document.querySelector('.result-status[role=status]').textContent.includes('正在生成'))
const newConversation = async () => { await f.click('.content-header .text-button'); await wait(() => document.querySelector('.result-status[role=status]')?.textContent.includes('已开始新对话')) }

try {
  await emulate(WIDTHS[1]); await media('light')
  await page.goto(f.origin, { waitUntil: 'load' })
  await wait(() => document.querySelector('input[type=search]') && !document.querySelector('.sidebar > .message'))

  // ① 位置面板：搜索结果已选中、尚未确认的草稿。
  await page.fill('input[type=search]', '公园')
  await wait(() => document.querySelector('.location-search .address-row'))
  await f.click('.location-search .address-row')
  await wait(() => document.querySelector('.location-search .address-row.selected'))
  await capture('s1-location-draft', '.location-search')

  // ② 新增地址表单错误态：确认地点后打开表单，空标签提交触发校验错误。
  await f.click('.location-search .button-primary')
  await wait(() => document.querySelector('.location-confirm')?.textContent.includes('测试公园'))
  await f.click('.empty-state .create-entry')
  await wait(() => document.querySelector('.address-create-place'))
  await f.click('.address-create button[type=submit]')
  await wait(() => document.querySelector('#address-create-label-error'))
  assert.equal(f.posts.length, 0, '空标签不得发保存请求')
  await capture('s2-address-form-error', '.address-create')
  await f.click('.address-create .button-quiet')
  await wait(() => !document.querySelector('.address-create'))

  // ③ 偏好面板：自定义半径 3500 米（已失焦）。
  await setSelect('搜索范围', 'custom')
  await wait(() => document.querySelector('.preferences input[type=number]'))
  await page.fill('.preferences input[type=number]', '3500')
  await page.evaluate(() => document.querySelector('.preferences input[type=number]').blur())
  await wait(() => document.querySelector('.preference-summary')?.textContent.includes('3500 米'))
  await capture('s3-preferences-custom-radius', '.preferences')

  // ④ ready 回答：Markdown（标题/列表/表格/强调）+ 卡片。
  let chat = await ask('附近想吃川菜')
  assert.equal(chat.body.preferences.radius_meters, 3500, '自定义半径应进入请求体')
  const readyPlaces = [1, 2, 3].map(n => place(`B0READY00${n}`, `川味小馆${n}`, n))
  respond(chat, ready(readyPlaces), '## 3500 米内的川菜推荐\n\n- **川味小馆1**：步行约 5 分钟\n- **川味小馆2**：人均 45 元\n- **川味小馆3**：适合多人\n\n| 店名 | 距离 |\n| --- | --- |\n| 川味小馆1 | 300 米 |\n| 川味小馆2 | 600 米 |\n\n> 价格来自来源参考，以门店为准。', readyPlaces)
  await finished()
  await wait(() => document.querySelectorAll('.place-card').length === 3 && document.querySelector('.markdown-body table'))
  await capture('s4-ready-answer', '.markdown-body')
  await reduced('s4-ready-answer', '.markdown-body')

  // ⑤ needs_choice 协商面板。
  await newConversation()
  chat = await ask('想吃四川火锅')
  respond(chat, needsChoice, '**3500 米内**只有巷口冒菜和贵州酸汤锅，没有四川火锅。请选择。')
  await wait(() => document.querySelector('.negotiation-option .button-primary') && !document.querySelector('.negotiation-option .button-primary').disabled)
  await capture('s5-needs-choice', '.negotiation')
  await reduced('s5-needs-choice', '.negotiation')
  await tabTo('negotiation-option', '.negotiation-option .button-primary')

  // ⑥ 卡片区：POI 详情链接 / 坐标 marker 链接 / 无 ID 无坐标的非链接卡。
  await newConversation()
  chat = await ask('看看卡片')
  const cardPlaces = [place('B0FFH5ZK1A', '川味小馆', 1), place('NOID', '无号&小馆#1', 2, { poiId: false, location: '116.402,39.902' }), place('NOLOC', '无坐标小店', 3, { poiId: false, location: '' })]
  respond(chat, ready(cardPlaces), '三张卡片：详情、位置与非链接。', cardPlaces)
  await finished()
  const tags = await page.evaluate(() => [...document.querySelectorAll('.place-card')].map(node => `${node.tagName}:${(node.getAttribute('href') ?? '').split('?')[0]}`))
  assert.deepEqual(tags, ['A:https://uri.amap.com/poidetail', 'A:https://uri.amap.com/marker', 'ARTICLE:'])
  await capture('s6-cards', '.places-grid')
  await tabTo('first-card-link', 'a.place-card')

  // 联系表：每个状态一张（18 帧，每行 = 一个宽度的 light 首屏/底部/关键区 + dark 同序），附加帧一张；file:// 本地页面渲染，不经网络。
  const groups = [...new Set(frames.map(frame => frame.state))].map(state => ({ name: state, items: frames.filter(frame => frame.state === state) }))
  groups.push({ name: 'extras-reduced-motion-focus', items: [...extras, ...focus] })
  await emulate(WIDTHS[1]); await media('light')
  for (const group of groups) {
    assert.ok(group.items.length <= 18, `${group.name} 联系表帧数应 ≤18`)
    const cells = group.items.map(item => {
      const name = item.path.split(/[\\/]/).at(-1)
      return `<figure><img src="frames/${encodeURIComponent(name)}"><figcaption>${name}</figcaption></figure>`
    }).join('')
    const html = join(outDir, `contact-${group.name}.html`)
    writeFileSync(html, `<!doctype html><meta charset="utf-8"><style>body{margin:16px;font:12px Consolas,monospace;background:#fff}h1{font-size:16px;margin:0 0 12px}main{display:grid;grid-template-columns:repeat(6,1fr);gap:12px}figure{margin:0;border:1px solid #bbb;padding:6px}img{display:block;width:100%;height:300px;object-fit:contain;background:#ddd}figcaption{margin-top:4px;word-break:break-all}</style><h1>${group.name}（${group.items.length} 帧）</h1><main>${cells}</main>`)
    await page.goto(pathToFileURL(html).href, { waitUntil: 'load' })
    await wait(() => [...document.images].every(img => img.complete && img.naturalWidth > 0))
    const png = join(outDir, `contact-${group.name}.png`)
    writeFileSync(png, await page.screenshot({ fullPage: true }))
    sheets.push({ name: group.name, frames: group.items.length, path: png })
  }
} catch (failure) {
  failures.push(`执行中断：${failure?.stack ?? failure}`)
} finally {
  try { await f.omowright.emulate(page, null) } catch { /* 浏览器已关闭时忽略 */ }
  cleanup = await f.close()
}

const guard = cleanup.networkGuard
const cleanOk = cleanup.browserClosed && cleanup.browserProcessExited !== false && cleanup.serverClosed && cleanup.profileRemoved && guard?.forwarded === 0 && !guard?.error
const summary = {
  frames: frames.length, expectedFrames: 108, overflow: frames.filter(item => item.overflow).length, darkNotLight: frames.filter(item => item.scheme === 'dark' && !item.bgLight).length,
  keyFrames: frames.filter(item => item.scroll === 'key').length, keyVisible: frames.filter(item => item.keyVisible).length,
  internalClipped: frames.filter(item => !item.clipped || item.clipped.length).length,
  notLight: frames.filter(item => !item.bgLight).length, schemeNotApplied: frames.filter(item => !item.schemeApplied).length,
  extras: extras.length, focusPassed: focus.filter(item => item.passed).length, focusTotal: focus.length, contactSheets: sheets.length,
}
const passed = failures.length === 0 && frames.length === 108 && summary.keyFrames === 36 && summary.keyVisible === 36 && summary.internalClipped === 0 && extras.length === 2 && focus.length === 2 && sheets.length === 7 && cleanOk
const matrix = {
  test: 'task14-acceptance-matrix', generatedAt: new Date().toISOString(), dist, passed, summary, failures,
  browser: 'Edge（TASK6_BROWSER_PATH，headless，任务自有 profile，经拒绝代理）',
  frames, extras, focus, contactSheets: sheets,
  externalRequests: { refused: guard?.refused ?? null, forwarded: guard?.forwarded ?? null, refusedHosts: guard?.refusedHosts ?? null },
  localStrayRequests: f.strays, cleanup: { ...cleanup, networkGuard: undefined },
}
writeFileSync(join(outDir, 'matrix.json'), JSON.stringify(matrix, redact, 2))
console.log(JSON.stringify({ matrix: summary, failures, externalRequests: matrix.externalRequests, cleanOk }))

// ---------- B. 公开高德 URI 可达性（独立、可选、联网；不计入退出码） ----------
// 单独的 Edge 与 profile；代理只放行 uri.amap.com 与主框架文档跳转到的域，其余一律 403；每个 URI 只加载一次，不重试。
async function publicCheck() {
  const allowed = new Set(['uri.amap.com'])
  const upstream = process.env.TASK14_PUBLIC_UPSTREAM || null
  const report = { test: 'task14-public-uri', separateFromOffline: true, note: '与离线矩阵断言分开计算，失败不影响退出码', upstream, generatedAt: new Date().toISOString(), loads: [] }
  const guardB = await startNetworkGuard('task14-public-uri', { allow: host => allowed.has(host), upstream, allowWaitMs: 3000 })
  const profile = mkdtempSync(join(tmpdir(), 'task14-public-profile-'))
  const { loadOmowright } = await import(pathToFileURL(process.env.TASK6_BROWSER_LOADER).href)
  const { omowright } = await loadOmowright()
  let browser
  try {
    browser = await omowright.connectPipe({ browserPath: process.env.TASK6_BROWSER_PATH, storageRoot: profile, browserArgs: guardedBrowserArgs(guardB, profile) })
    report.browserPid = browser.browserProcess.pid
    const tab = await browser.newTab()
    const tabSid = await tab.resolveSessionId()
    await omowright.emulate(tab, 'desktop-1440')
    const { frameTree } = await tab.cdp.send('Page.getFrameTree', {}, tabSid)
    const mainFrame = frameTree.frame.id
    let current = null
    tab.cdp.on('Network.requestWillBeSent', (params, meta) => {
      if (meta?.sessionId !== tabSid || params.type !== 'Document' || params.frameId !== mainFrame) return
      allowed.add(new URL(params.request.url).hostname)
      current?.chain.push(params.request.url)
    })
    tab.cdp.on('Network.responseReceived', (params, meta) => {
      if (meta?.sessionId === tabSid && params.type === 'Document' && params.frameId === mainFrame) current?.responses.push({ url: params.response.url, status: params.response.status })
    })
    await tab.cdp.send('Network.enable', {}, tabSid)
    for (const [name, url] of [['poidetail', 'https://uri.amap.com/poidetail?poiid=B0FFH5ZK1A&callnative=0'], ['marker', 'https://uri.amap.com/marker?position=116.397428,39.90923&name=%E6%B5%8B%E8%AF%95&coordinate=gaode&callnative=0']]) {
      current = { name, url, chain: [], responses: [] }
      const started = Date.now()
      try {
        await Promise.race([tab.goto(url, { waitUntil: 'load' }), pause(30000).then(() => { throw new Error('页面加载超时 30s') })])
      } catch (failure) { current.loadError = failure?.message ?? String(failure) }
      // shortcut: 固定等待 4s 让站点自身的脚本跳转完成，若需精确判定再改为监听目标 URL。
      await pause(4000)
      try {
        Object.assign(current, await tab.evaluate(() => ({ finalUrl: location.href, title: document.title, textLength: document.body?.innerText.trim().length ?? 0 })))
      } catch (failure) { current.evaluateError = failure?.message ?? String(failure) }
      current.rendered = Boolean(current.finalUrl && !current.finalUrl.startsWith('chrome-error') && current.textLength > 0)
      current.httpStatus = current.responses.at(-1)?.status ?? null
      current.elapsedMs = Date.now() - started
      try {
        current.screenshot = join(outDir, `public-${name}-1440.png`)
        writeFileSync(current.screenshot, await tab.screenshot())
      } catch (failure) { current.screenshotError = failure?.message ?? String(failure) }
      report.loads.push(current)
    }
    await omowright.emulate(tab, null).catch(() => {})
  } catch (failure) {
    report.error = failure?.message ?? String(failure)
  } finally {
    try { await browser?.close(); report.browserClosed = true } catch (failure) { report.browserError = String(failure) }
    if (report.browserPid) for (let i = 0; i < 50; i++) { try { process.kill(report.browserPid, 0); await pause(100) } catch { report.browserProcessExited = true; break } }
    report.networkGuard = await guardB.close()
    rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
    report.profileRemoved = !existsSync(profile)
  }
  report.allowedHosts = [...allowed]
  report.reachable = report.loads.length === 2 && report.loads.every(load => load.rendered)
  writeFileSync(join(outDir, 'public-uri.json'), JSON.stringify(report, redact, 2))
  console.log(JSON.stringify({ publicUri: { reachable: report.reachable, loads: report.loads.map(load => ({ name: load.name, finalUrl: load.finalUrl, httpStatus: load.httpStatus, rendered: load.rendered, error: load.loadError ?? load.evaluateError })), guard: report.networkGuard } }))
}
if (process.env.TASK14_SKIP_PUBLIC !== '1') await publicCheck().catch(failure => console.log(JSON.stringify({ publicUri: { error: String(failure) } })))

process.exitCode = passed ? 0 : 1
