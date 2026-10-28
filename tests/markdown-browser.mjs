import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'vite'
import { guardedBrowserArgs, startNetworkGuard } from './browser-network-guard.mjs'
import vue from '@vitejs/plugin-vue'

const root = fileURLToPath(new URL('../', import.meta.url))
const loaderPath = process.env.MARKDOWN_BROWSER_LOADER
const browserPath = process.env.MARKDOWN_BROWSER_PATH
assert.ok(loaderPath, '请通过 MARKDOWN_BROWSER_LOADER 指定 browser 技能的 scripts/omowright.mjs')
assert.ok(browserPath, '请通过 MARKDOWN_BROWSER_PATH 指定任务自有浏览器可执行文件')
assert.equal(typeof Promise.withResolvers, 'function', '浏览器探针需要 Node 22 或更新版本')
const { loadOmowright } = await import(pathToFileURL(loaderPath).href)
const { omowright } = await loadOmowright()
const evidenceDir = mkdtempSync(join(process.env.MARKDOWN_EVIDENCE_ROOT ?? tmpdir(), 'food-agent-markdown-'))
const evidencePath = join(evidenceDir, 'task-3-markdown-security.json')
const workDir = mkdtempSync(join(tmpdir(), 'food-agent-markdown-browser-'))
const profile = join(workDir, 'profile')
mkdirSync(profile)
const receipt = { passed: false, cases: [], requests: [], cleanup: {}, runtime: process.version }
let browser
let unsubscribe
let server
let guard

try {
  // MarkdownAnswer 夹具：响应式 state 控制累计文本、流式状态与挂载，便于验证节流、重置与卸载。
  const answerEntry = join(workDir, 'answer-entry.js')
  const posix = (path) => JSON.stringify(path.replaceAll('\\', '/'))
  writeFileSync(answerEntry, [
    "import { createApp, h, reactive, nextTick } from 'vue'",
    `import MarkdownAnswer from ${posix(join(root, 'src/MarkdownAnswer.vue'))}`,
    `import ${posix(join(root, 'src/style.css'))}`,
    'export const state = reactive({ text: "", streaming: false, mounted: false })',
    'export const failures = []',
    'createApp({ render: () => state.mounted ? h("section", { class: "answer-block", id: "answer" }, [h(MarkdownAnswer, {',
    '  text: state.text, streaming: state.streaming, onFailed: reason => failures.push(reason) })]) : null }).mount("#app")',
    'export { nextTick }',
  ].join('\n'))
  // PreferencesPanel 夹具：errors/summary 与 ChatPanel 同样由 preferencesFromForm 推导。
  const prefsEntry = join(workDir, 'prefs-entry.js')
  writeFileSync(prefsEntry, [
    "import { computed, createApp, h, ref } from 'vue'",
    `import PreferencesPanel from ${posix(join(root, 'src/PreferencesPanel.vue'))}`,
    `import { DEFAULT_PREFERENCE_FORM, describePreferences, preferencesFromForm } from ${posix(join(root, 'src/recommendation.ts'))}`,
    'const form = ref(DEFAULT_PREFERENCE_FORM)',
    'const result = computed(() => preferencesFromForm(form.value))',
    'createApp({ render: () => h(PreferencesPanel, { modelValue: form.value, "onUpdate:modelValue": value => { form.value = value }, disabled: false,',
    '  errors: result.value.ok ? {} : result.value.errors,',
    '  summary: result.value.ok ? describePreferences(result.value.preferences) : "条件有误，修正后才能提交" }) }).mount("#prefs")',
  ].join('\n'))
  const rootPosix = root.replaceAll('\\', '/')
  // 夹具入口位于系统临时目录：其裸导入 vue 按快照 src 解析，与组件共用同一份 vue。
  const fixtureVue = {
    name: 'fixture-vue', enforce: 'pre',
    resolveId(id, importer, options) {
      if (id === 'vue' && importer && !importer.replaceAll('\\', '/').startsWith(rootPosix)) {
        return this.resolve(id, join(root, 'src/MarkdownAnswer.vue'), { ...options, skipSelf: true })
      }
    },
  }
  await build({
    configFile: false, root, logLevel: 'silent', plugins: [fixtureVue, vue()],
    define: { 'process.env.NODE_ENV': '"production"' },
    build: {
      outDir: join(workDir, 'bundle'), emptyOutDir: false,
      lib: {
        entry: { renderer: join(root, 'src/markdown.ts'), answer: answerEntry, prefs: prefsEntry },
        formats: ['es'], fileName: (_format, name) => `${name}.js`, cssFileName: 'answer',
      },
    },
  })
  const bundleFiles = new Map(readdirSync(join(workDir, 'bundle')).filter(name => name.endsWith('.js'))
    .map(name => [`/${name}`, readFileSync(join(workDir, 'bundle', name))]))
  // 样式内联进夹具，避免订阅网络事件后再出现样式表请求。
  const answerCss = readFileSync(join(workDir, 'bundle/answer.css'), 'utf8')
  const fixture = '<!doctype html><html><head><title>Markdown 安全探针</title>' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">' +
    `<link rel="icon" href="data:,"><style>${answerCss}</style></head><body><main id="output"></main>` +
    '<div id="app" style="max-width:1180px;margin:0 auto;padding:16px"></div><div id="prefs"></div>' +
    '<script type="module">window.rendererReady = import("/renderer.js").then(module => {' +
    'window.renderMarkdown = module.renderMarkdown; });</script></body></html>'
  const unexpectedRequests = []
  server = createServer((request, response) => {
    if (bundleFiles.has(request.url)) {
      response.writeHead(200, { 'Content-Type': 'text/javascript' }).end(bundleFiles.get(request.url))
    } else if (request.url === '/') {
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(fixture)
    } else {
      unexpectedRequests.push(request.url)
      response.writeHead(404).end()
    }
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  assert.ok(address && typeof address === 'object')
  const origin = `http://127.0.0.1:${address.port}`
  receipt.fixture = origin
  guard = await startNetworkGuard('markdown-browser')
  browser = await omowright.connectPipe({ browserPath, storageRoot: profile, browserArgs: guardedBrowserArgs(guard, profile) })
  receipt.browserPid = browser.browserProcess.pid
  const page = await browser.newTab()
  await page.goto(origin, { waitUntil: 'commit' })
  await page.evaluate(async () => {
    const { renderMarkdown } = await import('/renderer.js')
    window.renderMarkdown = renderMarkdown
    // 跟踪尚未触发也未清除的定时器，验证完成/卸载后没有迟到更新。
    window.pendingTimers = new Set()
    const nativeSet = window.setTimeout.bind(window)
    const nativeClear = window.clearTimeout.bind(window)
    window.setTimeout = (callback, ms, ...args) => {
      const id = nativeSet(() => { window.pendingTimers.delete(id); callback(...args) }, ms)
      window.pendingTimers.add(id)
      return id
    }
    window.clearTimeout = (id) => { window.pendingTimers.delete(id); nativeClear(id) }
    window.answer = await import('/answer.js')
    await import('/prefs.js')
    window.sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms))
    window.renderLog = []
    new MutationObserver(() => window.renderLog.push(performance.now()))
      .observe(document.querySelector('#app'), { childList: true, subtree: true, characterData: true })
    window.inspectAnswer = () => {
      const root = document.querySelector('#answer')
      const body = root?.querySelector('.markdown-body')
      const elements = body ? [...body.querySelectorAll('*')] : []
      for (const element of elements) {
        element.dispatchEvent(new Event('error'))
        element.dispatchEvent(new Event('load'))
        element.dispatchEvent(new MouseEvent('mouseover'))
      }
      return {
        // tabindex 由组件在 DOM 上追加（键盘可聚焦滚动区），比对消毒输出时去掉。
        html: body ? body.innerHTML.replaceAll(' tabindex="0"', '') : null,
        alert: root?.querySelector('[role=alert]')?.textContent ?? null,
        dangerous: root ? root.querySelectorAll('script,style,iframe,svg,math,img,video,audio,source,link,object,embed,form').length : -1,
        attributes: elements.flatMap(element => [...element.attributes].map(attr => attr.name))
          .filter(name => !['href', 'title', 'rel', 'start', 'class', 'tabindex'].includes(name)),
        hrefs: elements.filter(element => element.tagName === 'A').map(link => link.getAttribute('href')),
        attack: window.__markdownAttack,
      }
    }
  })
  const sessionId = await page.resolveSessionId()
  unsubscribe = page.cdp.on('Network.requestWillBeSent', (params, meta) => {
    if (meta?.sessionId === sessionId) receipt.requests.push(params.request.url)
  })

  const normalCases = [
    { name: '标题', source: '# 标题', selector: 'h1', text: '标题' },
    { name: '无序列表', source: '- 第一项\n- 第二项', selector: 'ul > li', text: '第二项' },
    { name: '有序列表', source: '3. 第三项', selector: 'ol[start="3"] > li', text: '第三项' },
    { name: '强调', source: '**粗体** *强调* ~~删除~~', selector: 'strong + em + s', text: '删除' },
    { name: '引用', source: '> 引用', selector: 'blockquote', text: '引用' },
    { name: '表格', source: '| 列 |\n| :---: |\n| 值 |', selector: 'table tbody td', text: '值' },
    { name: '围栏代码', source: '```html\n<script>window.__markdownAttack = 1</script>\n```', selector: 'pre > code.language-html', text: '<script>' },
    { name: '行内代码', source: '`<img src="/track">`', selector: 'code', text: '<img' },
    { name: 'HTTPS链接', source: '[安全](https://example.test/path "标题")', selector: 'a[href="https://example.test/path"][title="标题"]', text: '安全' },
    { name: 'HTTP链接', source: '[安全](http://example.test/path)', selector: 'a[href="http://example.test/path"]', text: '安全' },
  ]
  const attackCases = [
    ['脚本与事件', '<script>window.__markdownAttack=1</script><p onclick="window.__markdownAttack=1">正文</p>'],
    ['样式与框架', `<style>@import '${origin}/track';</style><iframe src="${origin}/track"></iframe>`],
    ['SVG与MathML', `<svg onload="window.__markdownAttack=1"><image href="${origin}/track"/></svg><math><mtext><img src="${origin}/track"></mtext></math>`],
    ['混淆标签', `<ScRiPt>window.__markdownAttack=1</sCrIpT><IMG SRC=${origin}/track onerror=window.__markdownAttack=1>`],
    ['未闭合标签', `<svg><g/onload=window.__markdownAttack=1//<p><iframe src="${origin}/track`],
    ['变异HTML', `<math><mtext><table><mglyph><style><!--</style><img title="--><img src=${origin}/track onerror=window.__markdownAttack=1>">`],
    ['未闭合Markdown', '[链接](javascript:window.__markdownAttack=1\n\n```html\n<img src="/track" onerror="window.__markdownAttack=1">'],
    ['原始追踪资源', `<img src="${origin}/track" srcset="${origin}/track 2x"><video poster="${origin}/track"><source src="${origin}/track"></video><link rel="stylesheet" href="${origin}/track"><object data="${origin}/track"></object>`],
    ['Markdown追踪图片', `![追踪](${origin}/track) ![追踪](https://tracker.invalid/pixel) ![内联](data:image/png;base64,AAAA)`],
    ...['javascript:alert(1)', 'JaVaScRiPt:alert(1)', 'java&#x73;cript:alert(1)', 'java&#10;script:alert(1)',
      'javascript%3Aalert(1)', 'data:text/html;base64,PHNjcmlwdD4=', 'data:image/svg+xml,attack', 'vbscript:attack',
      'file:///etc/passwd', 'blob:https://example.test/id', 'mailto:test@example.test', '//example.test/path', '/relative', '#fragment']
      .map((url) => [`禁用协议:${url.split(':')[0]}`, `[恶意](${url}) <${url}> <a href="${url}">恶意</a>`]),
  ]
  for (const fixtureCase of [...normalCases, ...attackCases.map(([name, source]) => ({ name, source }))]) {
    const result = await page.evaluate(({ source, selector }) => {
      const output = document.querySelector('#output')
      window.__markdownAttack = 0
      output.innerHTML = window.renderMarkdown(source)
      const elements = [...output.querySelectorAll('*')]
      for (const element of elements) {
        element.dispatchEvent(new Event('error'))
        element.dispatchEvent(new Event('load'))
        element.dispatchEvent(new MouseEvent('mouseover'))
      }
      return {
        dangerous: output.querySelectorAll('script,style,iframe,svg,math,img,video,audio,source,link,object,embed,form').length,
        attributes: elements.flatMap(element => [...element.attributes].map(attr => attr.name))
          .filter(name => !['href', 'title', 'rel', 'start', 'class'].includes(name)),
        links: [...output.querySelectorAll('a')].map(link => ({ href: link.getAttribute('href'), rel: link.getAttribute('rel') })),
        matches: selector ? output.querySelectorAll(selector).length : 0,
        text: output.textContent, attack: window.__markdownAttack,
      }
    }, fixtureCase)
    assert.equal(result.dangerous, 0, fixtureCase.name)
    assert.deepEqual(result.attributes, [], fixtureCase.name)
    assert.equal(result.attack, 0, fixtureCase.name)
    for (const link of result.links) {
      assert.match(link.href, /^https?:\/\//i, fixtureCase.name)
      assert.equal(link.rel, 'noopener noreferrer', fixtureCase.name)
    }
    if (fixtureCase.selector) {
      assert.ok(result.matches > 0, fixtureCase.name)
      assert.ok(result.text.includes(fixtureCase.text), fixtureCase.name)
    } else {
      assert.equal(result.links.length, 0, fixtureCase.name)
    }
    receipt.cases.push(fixtureCase.name)
  }

  // 上限按 Unicode 码点计数（与后端 rune 一致）：64000 个 BMP 字或 emoji（代理对）均接受，第 64001 个码点受控失败。
  const limits = await page.evaluate(() => Object.fromEntries([['文', '文'], ['😀', '😀'], ['😀', '文']].map(([fill, extra]) => {
    const name = `${fill}+${extra}`
    let accepted
    try { accepted = window.renderMarkdown(fill.repeat(64_000)).includes(fill.repeat(64_000)) } catch (error) {
      if (!(error instanceof RangeError)) throw error
      accepted = false
    }
    try {
      window.renderMarkdown(fill.repeat(64_000) + extra)
      return [name, { accepted, rejected: false }]
    } catch (error) {
      if (!(error instanceof RangeError)) throw error
      return [name, { accepted, rejected: true }]
    }
  })))
  assert.deepEqual(limits, { '文+文': { accepted: true, rejected: true }, '😀+😀': { accepted: true, rejected: true }, '😀+文': { accepted: true, rejected: true } })
  receipt.cases.push('64000码点接受与64001码点受控失败（含emoji代理对边界）')

  // ---- MarkdownAnswer 组件 ----
  const answerReceipt = { cases: [] }
  receipt.answer = answerReceipt
  const setAnswer = (patch, wait = 0) => page.evaluate(async ({ patch, wait }) => {
    document.querySelector('#output').innerHTML = ''
    Object.assign(window.answer.state, patch)
    await window.answer.nextTick()
    if (wait) await window.sleep(wait)
    return { ...window.inspectAnswer(), expected: window.renderMarkdown([...window.answer.state.text].slice(0, 64_000).join('')),
      pending: window.pendingTimers.size, failures: window.answer.failures.length }
  }, { patch, wait })
  const assertSafe = (result, name) => {
    assert.equal(result.dangerous, 0, name)
    assert.deepEqual(result.attributes, [], name)
    assert.equal(result.attack, 0, name)
    for (const href of result.hrefs) assert.match(href, /^https?:\/\//i, name)
  }

  await setAnswer({ mounted: true, streaming: true, text: '' })
  // 未闭合围栏：流式期间整段按代码显示，闭合后后续内容恢复为正文。
  let snap = await setAnswer({ text: '```js\nconst a = 1\n**不是粗体**' }, 60)
  assert.equal(snap.html, snap.expected)
  assert.match(snap.html, /<pre[^>]*><code class="language-js">const a = 1\n\*\*不是粗体\*\*/)
  assert.doesNotMatch(snap.html, /<strong>/)
  snap = await setAnswer({ text: '```js\nconst a = 1\n**不是粗体**\n```\n\n**粗体**' }, 60)
  assert.equal(snap.html, snap.expected)
  assert.match(snap.html, /<\/pre>\s*<p><strong>粗体<\/strong><\/p>/)
  answerReceipt.cases.push('未闭合围栏流式稳定')
  // 跨 chunk 强调与链接：逐块累计，每次都等于对完整累计文本的重新渲染。
  await setAnswer({ text: '' })
  const streamDoc = '# 推荐\n\n**粗体强调** 与 *斜体* 和 [链接](https://example.test/a?b=1 "标题")\n\n' +
    '| 店 | 价 |\n| --- | --- |\n| 面馆 | 30 |\n\n> 引用\n\n1. 第一\n2. 第二\n'
  let accumulated = ''
  for (let index = 0; index < streamDoc.length; index += 4) {
    accumulated += streamDoc.slice(index, index + 4)
    snap = await setAnswer({ text: accumulated }, 55)
    assert.equal(snap.html, snap.expected, `跨块渲染与整体重渲染一致：${JSON.stringify(accumulated)}`)
    assertSafe(snap, '跨块渲染')
  }
  assert.match(snap.html, /<strong>粗体强调<\/strong>/)
  assert.match(snap.html, /<a href="https:\/\/example\.test\/a\?b=1" title="标题" rel="noopener noreferrer">链接<\/a>/)
  snap = await setAnswer({ text: '**粗' }, 55)
  assert.ok(snap.html.includes('**粗') && !snap.html.includes('<strong>'))
  snap = await setAnswer({ text: '**粗体** [链接](https://exa' }, 55)
  assert.ok(snap.html.includes('<strong>粗体</strong>') && snap.hrefs.length === 0)
  snap = await setAnswer({ text: '**粗体** [链接](https://example.test/a)' }, 55)
  assert.deepEqual(snap.hrefs, ['https://example.test/a'])
  answerReceipt.cases.push('跨chunk强调与链接稳定')

  // 节流：真实时间内每 5ms 追加一块，统计 DOM 渲染批次；done 后同步立即刷新且无残留定时器。
  const throttle = await page.evaluate(async () => {
    const { state, nextTick } = window.answer
    state.text = ''
    state.streaming = true
    await nextTick()
    await window.sleep(80)
    window.renderLog = []
    const start = performance.now()
    for (let index = 0; index < 60; index++) {
      state.text += `第${index}块 **强调${index}** `
      await window.sleep(5)
    }
    const end = performance.now()
    const streamed = window.renderLog.filter(time => time <= end)
    const gaps = streamed.slice(1).map((time, index) => time - streamed[index])
    const beforeDone = document.querySelector('.markdown-body').innerHTML.replaceAll(' tabindex="0"', '')
    state.streaming = false
    await nextTick()
    const afterDone = document.querySelector('.markdown-body').innerHTML.replaceAll(' tabindex="0"', '')
    return { duration: end - start, renders: streamed.length, minGap: Math.min(...gaps), pending: window.pendingTimers.size,
      flushed: afterDone === window.renderMarkdown(state.text), staleBeforeDone: beforeDone !== afterDone }
  })
  assert.ok(throttle.renders >= 2 && throttle.renders <= Math.ceil(throttle.duration / 50) + 1, JSON.stringify(throttle))
  assert.ok(throttle.minGap >= 45, JSON.stringify(throttle))
  assert.equal(throttle.flushed, true, 'done 后必须在同一 tick 内刷新为完整文本')
  assert.equal(throttle.pending, 0, 'done 后不得残留定时器')
  answerReceipt.throttle = throttle
  answerReceipt.cases.push('50ms节流与done立即刷新')

  // 重置：冷却期内的旧内容不能迟到渲染。
  await setAnswer({ streaming: true, text: '旧' })
  await setAnswer({ text: '旧 **待渲染**' })
  snap = await setAnswer({ text: '' }, 120)
  assert.equal(snap.html, '', '重置后不得出现旧内容迟到渲染')
  answerReceipt.cases.push('重置无迟到更新')
  // 卸载：清除所有待执行定时器。
  await setAnswer({ text: '卸载前' })
  snap = await setAnswer({ text: '卸载前 **尾部**' })
  assert.ok(snap.pending > 0, '卸载前应存在冷却定时器')
  snap = await setAnswer({ mounted: false })
  assert.equal(snap.pending, 0, '卸载后不得残留定时器')
  assert.equal(snap.html, null)
  answerReceipt.cases.push('卸载清除定时器')

  // 流式注入：攻击载荷被切成小块逐块到达，任一中间态与最终态都不得出现危险 DOM。
  await setAnswer({ mounted: true, streaming: true, text: '' })
  for (const [name, source] of attackCases) {
    await setAnswer({ streaming: true, text: '' })
    let partial = ''
    for (let index = 0; index < source.length; index += 7) {
      partial += source.slice(index, index + 7)
      assertSafe(await setAnswer({ text: partial }), `流式注入:${name}`)
    }
    snap = await setAnswer({ streaming: false })
    assertSafe(snap, `流式注入:${name}`)
    assert.equal(snap.html, snap.expected, name)
    assert.equal(snap.hrefs.length, 0, name)
  }
  answerReceipt.cases.push(`流式注入${attackCases.length}类`)

  // 超限：受控失败，不显示任何正文，也不冒充成功。
  snap = await setAnswer({ streaming: true, text: '文'.repeat(64_001) }, 60)
  assert.equal(snap.html, null)
  assert.match(snap.alert, /64000/)
  assert.ok(snap.failures > 0)
  snap = await setAnswer({ streaming: false })
  assert.match(snap.alert ?? '', /未完成/)
  snap = await setAnswer({ streaming: false, text: '恢复' })
  assert.equal(snap.alert, null)
  assert.equal(snap.html, '<p>恢复</p>\n')
  // emoji 边界：64000 个代理对（128000 个 UTF-16 单元）仍正常显示；再多 1 个码点则受控失败。
  snap = await setAnswer({ streaming: false, text: '😀'.repeat(64_000) })
  assert.equal(snap.alert, null, 'emoji 64000 码点不得误判超限')
  assert.equal(snap.html, snap.expected)
  snap = await setAnswer({ streaming: false, text: '😀'.repeat(64_000) + '文' })
  assert.match(snap.alert ?? '', /64000/)
  await setAnswer({ streaming: false, text: '恢复' })
  answerReceipt.cases.push('64001码点受控失败（含emoji边界）')

  // 复核回归：超限在同一文本会话只通知一次；非超限异常给通用提示；偏好错误失焦后才显示，摘要不逐键播报。
  const regression = {}
  const overLimit = async () => {
    const before = (await setAnswer({ streaming: true, text: '' })).failures
    let over = '文'.repeat(64_001)
    for (let index = 0; index < 4; index++) {
      over += '溢'
      await setAnswer({ text: over }, 60)
    }
    return (await setAnswer({ streaming: false })).failures - before
  }
  regression.limitFailures = await overLimit()
  regression.limitFailuresAfterReset = await overLimit()
  Object.assign(regression, await page.evaluate(async () => {
    const { state, nextTick, failures } = window.answer
    const native = String.prototype.replace
    // 故障注入：仅对带标记的正文让 markdown-it 预处理抛出与长度无关的 RangeError。
    String.prototype.replace = function (...args) {
      if (String(this).includes('@@渲染故障@@')) throw new RangeError('注入的渲染异常')
      return native.apply(this, args)
    }
    try {
      const count = failures.length
      state.text = '@@渲染故障@@'
      await nextTick()
      return { genericAlert: document.querySelector('#answer [role=alert]')?.textContent ?? null, genericFailures: failures.length - count }
    } finally {
      String.prototype.replace = native
    }
  }))
  Object.assign(regression, await page.evaluate(async () => {
    const panel = document.querySelector('#prefs')
    const settle = () => window.sleep(0)
    const field = (label) => [...panel.querySelectorAll('label')].find(element => element.querySelector('span')?.textContent.startsWith(label))
    const alerts = () => [...panel.querySelectorAll('[role=alert]')].map(element => element.textContent)
    const input = (label) => field(label).querySelector('input')
    const choose = async (label, value) => {
      const select = field(label).querySelector('select')
      select.value = value
      select.dispatchEvent(new Event('change'))
      await settle()
    }
    const type = async (label, value) => {
      input(label).value = value
      input(label).dispatchEvent(new Event('input'))
      await settle()
    }
    const blur = async (label) => { input(label).dispatchEvent(new FocusEvent('blur')); await settle() }
    const result = {}
    await choose('搜索范围', 'custom')
    result.radiusBeforeBlur = [alerts(), input('自定义半径').getAttribute('aria-invalid')]
    await type('自定义半径', '4')
    result.radiusWhileTyping = alerts()
    await blur('自定义半径')
    result.radiusAfterBlur = [alerts().length, input('自定义半径').getAttribute('aria-invalid')]
    await type('自定义半径', '4000')
    result.radiusValid = alerts()
    await choose('人均上限', 'custom')
    result.priceBeforeBlur = alerts()
    await blur('自定义人均上限')
    result.priceAfterBlur = alerts().length
    await type('自定义人均上限', '80')
    const summary = panel.querySelector('.preference-summary')
    result.summary = summary.textContent
    result.liveRegions = panel.querySelectorAll('[aria-live]').length + (panel.closest('[aria-live]') ? 1 : 0)
    return result
  }))
  answerReceipt.regression = regression
  assert.deepEqual(regression, {
    limitFailures: 1, limitFailuresAfterReset: 1,
    genericAlert: '回答渲染失败，本次回答未完成。', genericFailures: 1,
    radiusBeforeBlur: [[], 'false'], radiusWhileTyping: [], radiusAfterBlur: [1, 'true'], radiusValid: [],
    priceBeforeBlur: [], priceAfterBlur: 1,
    summary: '当前条件：3 家 · 4 公里内 · 用餐安排：不限 · 人均 80 元以内 · 价格未知也展示（待核实）', liveRegions: 0,
  })
  answerReceipt.cases.push('超限单次通知与通用渲染失败', '偏好失焦后报错且摘要不逐键播报')

  // 布局：390 与 1440 宽度下长表格/代码/URL 局部滚动或换行，页面无横向溢出。
  const wide = `## 长内容\n\n访问 https://example.test/${'very-long-path-segment-'.repeat(12)}end 与 ` +
    `[超长链接](https://example.test/${'q'.repeat(160)})\n\n` +
    `\`\`\`text\n${'const veryLongIdentifier = "不换行代码"; '.repeat(12)}\n\`\`\`\n\n` +
    `| ${Array.from({ length: 8 }, (_, index) => `第${index + 1}列店铺名称`).join(' | ')} |\n` +
    `| ${Array(8).fill('---').join(' | ')} |\n| ${Array.from({ length: 8 }, (_, index) => `人均 ${index * 10 + 30} 元`).join(' | ')} |\n\n` +
    '- 列表项 **强调** 与 `inline code`\n- 第二项\n\n> 引用说明：以上数据待核实。\n'
  await setAnswer({ streaming: false, text: wide })
  answerReceipt.layout = {}
  for (const [preset, width] of [['iphone-14', 390], ['desktop-1440', 1440]]) {
    await omowright.emulate(page, preset)
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
    const layout = await page.evaluate(() => {
      const box = selector => document.querySelector(`.markdown-body ${selector}`)
      const pre = box('pre'), table = box('table')
      const links = [...document.querySelectorAll('.markdown-body a')]
      return {
        width: innerWidth, pageOverflow: document.documentElement.scrollWidth > innerWidth,
        preScrolls: pre.scrollWidth > pre.clientWidth, tableScrolls: table.scrollWidth > table.clientWidth,
        preRight: pre.getBoundingClientRect().right, tableRight: table.getBoundingClientRect().right,
        linkRight: Math.max(...links.map(link => link.getBoundingClientRect().right)),
        focusable: [pre.tabIndex, table.tabIndex],
      }
    })
    assert.equal(layout.width, width)
    assert.equal(layout.pageOverflow, false, JSON.stringify(layout))
    assert.ok(layout.preRight <= width && layout.tableRight <= width && layout.linkRight <= width, JSON.stringify(layout))
    assert.deepEqual(layout.focusable, [0, 0])
    if (width === 390) assert.ok(layout.preScrolls && layout.tableScrolls, JSON.stringify(layout))
    answerReceipt.layout[width] = layout
    const shot = await page.screenshot({ fullPage: true })
    writeFileSync(join(evidenceDir, `task-10-markdown-${width}.png`), shot)
  }
  answerReceipt.cases.push('390/1440无页面横向溢出')
  receipt.cases.push(...answerReceipt.cases.map(name => `MarkdownAnswer:${name}`))
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
  assert.deepEqual(receipt.requests, [], '渲染不得产生任何资源请求')
  assert.deepEqual(unexpectedRequests, [], '本地追踪端点不得被访问')
  receipt.resourceRequests = receipt.requests.length
  receipt.passed = true
} finally {
  try {
    unsubscribe?.()
    if (browser) {
      await browser.close()
      receipt.cleanup.browser = '已关闭并回收进程'
    }
  } finally {
    try {
      if (server?.listening) {
        await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
        receipt.cleanup.server = '已关闭'
      }
      if (guard) receipt.cleanup.networkGuard = await guard.close()
    } finally {
      rmSync(workDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
      receipt.cleanup.profileAndFixture = '已删除'
      receipt.hashes = Object.fromEntries(['package.json', 'package-lock.json', 'src/markdown.ts', 'src/MarkdownAnswer.vue', 'src/markdownThrottle.ts', 'tests/markdown-browser.mjs']
        .map(path => [path, createHash('sha256').update(readFileSync(join(root, path))).digest('hex')]))
      writeFileSync(evidencePath, JSON.stringify(receipt, null, 2))
      writeFileSync(join(evidenceDir, 'task-10-markdown-ui.json'), JSON.stringify({ passed: receipt.passed,
        ...receipt.answer, requests: receipt.requests, hashes: receipt.hashes }, null, 2))
      console.log(JSON.stringify({ passed: receipt.passed, cases: receipt.cases.length, evidencePath, cleanup: receipt.cleanup }))
    }
  }
}
