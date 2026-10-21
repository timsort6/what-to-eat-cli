import { ApiError, isRecord, messageFrom, parseAddresses, parseAuth, parseUser } from './protocol'
import type { AuthData, ChatEvent, ChatRequest } from './protocol'
import { readSSE } from './sse'

const tokenKey = 'food-agent-token'
const baseUrl = (import.meta.env['VITE_API_BASE_URL'] ?? '').replace(/\/$/, '')

export function getToken(): string {
  return sessionStorage.getItem(tokenKey) ?? ''
}

export function clearSession(): void {
  sessionStorage.removeItem(tokenKey)
}

async function send(path: string, init: RequestInit): Promise<Response> {
  const headers = new Headers(init.headers)
  headers.set('Accept', headers.get('Accept') ?? 'application/json')
  if (init.body) headers.set('Content-Type', 'application/json')
  const accessToken = getToken()
  if (accessToken) headers.set('Authorization', `Bearer ${accessToken}`)
  const response = await fetch(`${baseUrl}/api/v1${path}`, { ...init, headers })
  if (!response.ok) {
    const text = await response.text()
    let body: unknown
    try {
      body = JSON.parse(text)
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error
    }
    throw new ApiError(messageFrom(body, `请求失败（HTTP ${response.status}），请检查后端服务`), response.status)
  }
  return response
}

async function request(path: string, init: RequestInit): Promise<unknown> {
  const response = await send(path, init)
  let body: unknown
  try {
    body = await response.json()
  } catch (error) {
    if (error instanceof SyntaxError) throw new ApiError('服务器未返回有效的 JSON')
    throw error
  }
  if (!isRecord(body) || typeof body['code'] !== 'number') throw new ApiError('服务器响应格式异常')
  if (body['code'] !== 200) throw new ApiError(messageFrom(body, '请求未成功'), body['code'])
  return body['data']
}

export async function authenticate(credentials: Readonly<{ username: string; password: string; register: boolean }>, signal: AbortSignal): Promise<AuthData> {
  clearSession()
  const body = JSON.stringify({ username: credentials.username, password: credentials.password })
  if (credentials.register) await request('/auth/register', { method: 'POST', body, signal })
  const data = parseAuth(await request('/auth/login', { method: 'POST', body, signal }))
  signal.throwIfAborted()
  sessionStorage.setItem(tokenKey, data.token)
  return data
}

export async function me(signal: AbortSignal) {
  return parseUser(await request('/me', { signal }))
}

export async function listAddresses(signal: AbortSignal) {
  return parseAddresses(await request('/addresses', { signal }))
}

export async function streamChat(payload: ChatRequest, onEvent: (event: ChatEvent) => void, signal: AbortSignal): Promise<void> {
  const response = await send('/agent/chat', {
    method: 'POST', body: JSON.stringify(payload), signal, headers: { Accept: 'text/event-stream' },
  })
  if (!response.headers.get('Content-Type')?.toLowerCase().includes('text/event-stream')) throw new ApiError('服务器未返回 SSE 流，请检查接口或代理配置')
  if (!response.body) throw new ApiError('服务器返回了空响应')
  await readSSE(response.body, onEvent)
}
