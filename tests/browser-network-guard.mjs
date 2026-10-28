import assert from 'node:assert/strict'
import { createServer, request as httpRequest } from 'node:http'
import { connect } from 'node:net'

// 所有浏览器测试共用的外网防护：本地代理记录并以 403 拒绝每个外部请求（默认从不转发），
// 主机名解析只放行回环地址，并关闭 Edge/Chromium 后台联网特性。回环地址由 Chromium 默认直连，不经代理。
const BACKGROUND_FLAGS = [
  '--disable-background-networking', '--disable-component-update', '--disable-sync', '--disable-default-apps',
  '--disable-extensions', '--disable-domain-reliability', '--disable-client-side-phishing-detection', '--disable-breakpad',
  '--no-default-browser-check', '--no-pings', '--metrics-recording-only', '--disable-features=OptimizationHints,MediaRouter,Translate,AutofillServerCommunication,CertificateTransparencyComponentUpdater,InterestFeedContentSuggestions,msSmartScreenProtection,msEdgeShoppingUI,msShowcasingService,EdgeCollections',
]
export const HOST_RESOLVER_RULES = '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1, EXCLUDE localhost'

const hostOf = (target) => {
  try { return target.includes('://') ? new URL(target).hostname : target.replace(/:\d+$/, '').replace(/^\[|\]$/g, '') } catch { return target }
}

// allow(host) 仅供独立的公开 URI 可达性步骤使用；离线断言不得传入。upstream 为可选上游 HTTP 代理（host:port）。
export async function startNetworkGuard(name, { allow = null, upstream = null, allowWaitMs = 0 } = {}) {
  const refused = [], forwarded = []
  const sockets = new Set()
  const tunnel = (host, port, onSocket, onError) => {
    if (!upstream) {
      const socket = connect(port, host, () => onSocket(socket))
      return socket.on('error', onError)
    }
    const [proxyHost, proxyPort] = upstream.split(':')
    const socket = connect(Number(proxyPort), proxyHost, () => socket.write(`CONNECT ${host}:${port} HTTP/1.1\r\nHost: ${host}:${port}\r\n\r\n`))
    let head = ''
    const onData = chunk => {
      head += chunk.toString('latin1')
      if (!head.includes('\r\n\r\n')) return
      socket.off('data', onData)
      if (/^HTTP\/1\.[01] 200/.test(head)) onSocket(socket)
      else { socket.destroy(); onError(new Error(`上游代理拒绝：${head.split('\r\n')[0]}`)) }
    }
    socket.on('data', onData)
    return socket.on('error', onError)
  }
  const proxy = createServer((req, res) => {
    const host = hostOf(req.url)
    if (!allow?.(host)) { refused.push(`${req.method} ${host}`); res.writeHead(403).end(); return }
    forwarded.push(`${req.method} ${host}`)
    // shortcut: 公开步骤只做页面导航，明文 HTTP 转发未单独处理 hop-by-hop 头，若需长期复用再补齐。
    const target = new URL(req.url)
    const upstreamRequest = httpRequest(upstream
      ? { host: upstream.split(':')[0], port: Number(upstream.split(':')[1]), path: req.url, method: req.method, headers: req.headers }
      : { host: target.hostname, port: target.port || 80, path: target.pathname + target.search, method: req.method, headers: req.headers },
    upstreamResponse => { res.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers); upstreamResponse.pipe(res) })
    upstreamRequest.on('error', () => res.destroy())
    req.pipe(upstreamRequest)
  })
  proxy.on('connect', async (req, client, head) => {
    client.on('error', () => {})
    sockets.add(client)
    const host = hostOf(req.url)
    // 公开步骤中重定向目标由 CDP 事件登记，可能略晚于 CONNECT 到达，故有界等待后再判定。
    for (const deadline = Date.now() + allowWaitMs; allow && !allow(host) && Date.now() < deadline;) await new Promise(resolve => setTimeout(resolve, 100))
    if (!allow?.(host)) { refused.push(`CONNECT ${req.url}`); client.end('HTTP/1.1 403 Forbidden\r\n\r\n'); return }
    forwarded.push(`CONNECT ${req.url}`)
    const port = Number(req.url.split(':').at(-1)) || 443
    const remote = tunnel(host, port, socket => {
      sockets.add(socket)
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n')
      if (head?.length) socket.write(head)
      socket.pipe(client); client.pipe(socket)
    }, () => client.destroy())
    sockets.add(remote)
  })
  proxy.on('clientError', (_error, socket) => socket.destroy())
  await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve))
  const args = [`--proxy-server=http://127.0.0.1:${proxy.address().port}`, HOST_RESOLVER_RULES, ...BACKGROUND_FLAGS]
  const report = () => {
    const hosts = {}
    for (const entry of refused) { const host = hostOf(entry.split(' ')[1]); hosts[host] = (hosts[host] ?? 0) + 1 }
    return { test: name, refused: refused.length, forwarded: forwarded.length, forwardedHosts: [...new Set(forwarded.map(entry => hostOf(entry.split(' ')[1])))], refusedHosts: hosts }
  }
  let closed = null
  return {
    args, refused, forwarded, report,
    // 关闭代理并打印一行机器可读计数；离线模式（无 allow）下实际转发必须为 0。
    async close() {
      closed ??= (async () => {
        for (const socket of sockets) socket.destroy()
        proxy.closeAllConnections()
        await new Promise(resolve => proxy.close(resolve))
        const summary = report()
        console.log(JSON.stringify({ networkGuard: summary }))
        if (!allow) assert.equal(summary.forwarded, 0, '离线浏览器测试不得转发任何外部请求')
        return summary
      })()
      return closed
    },
  }
}

// 统一的 Edge 启动参数：无头、任务自有 profile、拒绝代理与 DNS 屏蔽。
export function guardedBrowserArgs(guard, profile, extra = []) {
  return ['--headless', '--no-first-run', ...guard.args, ...extra, `--user-data-dir=${profile}`]
}
