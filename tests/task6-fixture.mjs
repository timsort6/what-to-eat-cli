import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join, extname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { guardedBrowserArgs, startNetworkGuard } from './browser-network-guard.mjs'

export const candidates = [
  { id: '', name: '测试公园', city: '北京', address: '东门', location: '116.400000123,39.900000456' },
  { id: '', name: '测试公园', city: '北京', address: '西门', location: '116.500000123,39.800000456' },
]

export async function openSearchFixture() {
  const root = fileURLToPath(new URL('../', import.meta.url))
  const dist = process.env.TASK6_DIST_DIR ?? join(root, 'dist')
  const { TASK6_BROWSER_LOADER: loader, TASK6_BROWSER_PATH: browserPath } = process.env
  assert.ok(loader && browserPath, '请指定任务自有浏览器与 browser 技能 loader')
  const { loadOmowright } = await import(pathToFileURL(loader).href)
  const { omowright } = await loadOmowright()
  const evidenceDir = mkdtempSync(join(tmpdir(), 'task6-repair-'))
  const profile = mkdtempSync(join(tmpdir(), 'task6-repair-profile-'))
  const requests = [], pending = [], waiters = []
  let addresses = []
  const server = createServer(async (request, response) => {
    const url = new URL(request.url, 'http://fixture')
    if (url.pathname.startsWith('/api/')) {
      const chunks = []
      for await (const chunk of request) chunks.push(chunk)
      requests.push({ method: request.method, path: url.pathname, query: url.search, body: Buffer.concat(chunks).toString() })
      if (url.pathname.endsWith('/locations/search')) {
        pending.push(response)
        waiters.shift()?.()
        return
      }
      if (url.pathname.endsWith('/agent/chat')) {
        response.writeHead(200, { 'content-type': 'text/event-stream' }).end('event: done\ndata: {"answer_text":"本地推荐完成","places":[]}\n\n')
        return
      }
      const data = url.pathname.endsWith('/me') ? { id: 1, username: '本地测试' } : { items: addresses }
      response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ code: 200, data }))
      return
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
  const guard = await startNetworkGuard('task6')
  let browser
  const cleanup = { serverPort: server.address().port, profile, browserClosed: false, serverClosed: false, profileRemoved: false }
  async function close() {
    await browser?.close(); cleanup.browserClosed = true
    for (const response of pending) response.destroy()
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
    const wait = condition => page.evaluate(source => new Promise((resolve, reject) => {
      const matches = new Function(`return (${source})()`)
      const deadline = performance.now() + 5000
      const check = () => matches() ? resolve(true) : performance.now() > deadline ? reject(new Error(`状态等待超时：${source}`)) : requestAnimationFrame(check)
      check()
    }), condition.toString())
    async function reset() {
      await page.goto(`http://127.0.0.1:${server.address().port}`, { waitUntil: 'load' })
      await wait(() => document.querySelector('input[type=search]') && !document.querySelector('.sidebar > .message'))
    }
    return { browser, page, sid, omowright, evidenceDir, requests, cleanup, wait, reset, close,
      setAddresses(value) { addresses = value },
      nextSearch: () => pending.length ? Promise.resolve() : new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('本地搜索请求等待超时')), 5000)
        waiters.push(() => { clearTimeout(timer); resolve() })
      }),
      release(items = candidates, status = 200) {
        const response = pending.shift()
        assert.ok(response, '应有本地挂起搜索请求')
        response.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify({ code: status, message: status === 200 ? '' : '地点服务暂不可用', data: { items } }))
      },
    }
  } catch (failure) { await close(); throw failure }
}

// task17 页面探针：对比度（透明背景向上取第一个不透明祖先）、按钮边界、子串实际占用的行数。
export const installProbes = page => page.evaluate(() => {
  const rgba = color => color.match(/[\d.]+/g).map(Number)
  const opaque = color => (rgba(color)[3] ?? 1) > 0
  const lum = color => rgba(color).slice(0, 3).map(v => v / 255).map(v => v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4)
    .reduce((sum, v, i) => sum + v * [.2126, .7152, .0722][i], 0)
  const surface = node => {
    for (let n = node; n; n = n.parentElement) { const bg = getComputedStyle(n).backgroundColor; if (opaque(bg)) return bg }
    return 'rgb(255, 255, 255)'
  }
  const contrast = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return +((x + .05) / (y + .05)).toFixed(2) }
  window.__probe = {
    contrast,
    button(node) {
      const css = getComputedStyle(node), own = surface(node), parent = surface(node.parentElement)
      const border = parseFloat(css.borderTopWidth) > 0 && css.borderTopStyle !== 'none' && opaque(css.borderTopColor)
      return { text: node.textContent.trim(), disabled: node.disabled, opacity: css.opacity, color: css.color, background: css.backgroundColor,
        filled: opaque(css.backgroundColor) && own !== parent, border, bounded: border || own !== parent, textContrast: contrast(css.color, own) }
    },
    // 子串跨越的视觉行数：按文本节点拼接定位 Range，矩形底边相差 >4px 视为不同行。
    lines(root, needle) {
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT), nodes = []
      let text = ''
      for (let node; (node = walker.nextNode());) { nodes.push([node, text.length]); text += node.data }
      const start = text.indexOf(needle)
      if (start < 0) return -1
      const at = pos => { const [node, offset] = nodes.findLast(([, base]) => base <= pos); return [node, pos - offset] }
      const range = document.createRange(), [endNode, endOffset] = at(start + needle.length - 1)
      range.setStart(...at(start)); range.setEnd(endNode, endOffset + 1)
      const bottoms = [...range.getClientRects()].filter(rect => rect.width > 0).map(rect => rect.bottom).sort((a, b) => a - b)
      return bottoms.filter((bottom, i) => i === 0 || bottom - bottoms[i - 1] > 4).length
    },
    size: selector => parseFloat(getComputedStyle(document.querySelector(selector)).fontSize),
  }
})
