export type User = Readonly<{ id: number; username: string }>
export type AuthData = Readonly<{ token: string; user: User }>
export type Address = Readonly<{
  id: number
  label: string
  is_default: boolean
  location: string
  description: string
}>
export type Place = Readonly<{ id: string; name: string; address: string; distance: string; type: string }>
export type ChatDone = Readonly<{ answer_text: string; places: readonly Place[] }>
export type ChatEvent =
  | Readonly<{ kind: 'delta'; text: string }>
  | Readonly<{ kind: 'done'; data: ChatDone }>
  | Readonly<{ kind: 'error'; message: string }>
export type LocationChoice =
  | Readonly<{ kind: 'address'; address: Address }>
  | Readonly<{ kind: 'coordinates'; location: string }>
export type ChatRequest = Readonly<{
  messages: readonly Readonly<{ role: 'user'; content: string }>[]
  address_id?: number
  location?: string
}>

export class ApiError extends Error {
  constructor(message: string, readonly status = 0) {
    super(message)
    this.name = 'ApiError'
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function messageFrom(value: unknown, fallback = '请求失败，请检查网络或稍后重试'): string {
  if (value instanceof Error) return value.message
  if (isRecord(value) && typeof value['message'] === 'string') return value['message']
  return fallback
}

export function parseUser(value: unknown): User {
  if (!isRecord(value) || !Number.isSafeInteger(value['id']) || typeof value['id'] !== 'number' || value['id'] <= 0 || typeof value['username'] !== 'string') {
    throw new ApiError('服务器返回的用户信息格式异常')
  }
  return { id: value['id'], username: value['username'] }
}

export function parseAuth(value: unknown): AuthData {
  if (!isRecord(value) || typeof value['token'] !== 'string' || !value['token'].trim()) {
    throw new ApiError('服务器未返回有效的登录凭证')
  }
  return { token: value['token'], user: parseUser(value['user']) }
}

export function validLocation(location: string): boolean {
  const parts = location.split(',')
  if (parts.length !== 2 || parts.some((part) => !part.trim())) return false
  const lng = Number(parts[0])
  const lat = Number(parts[1])
  return Number.isFinite(lng) && Number.isFinite(lat)
    && Math.abs(lng) <= 180 && Math.abs(lat) <= 90
}

export function parseAddresses(value: unknown): readonly Address[] {
  if (!isRecord(value) || !Array.isArray(value['items'])) throw new ApiError('服务器返回的地址簿格式异常，请重试')
  return value['items'].map((item: unknown): Address => {
    if (!isRecord(item) || typeof item['id'] !== 'number' || !Number.isSafeInteger(item['id']) || item['id'] <= 0
      || typeof item['label'] !== 'string' || typeof item['location'] !== 'string' || typeof item['is_default'] !== 'boolean') {
      throw new ApiError('服务器返回的地址格式异常')
    }
    const description = [item['formatted_address'], item['address'], item['name']]
      .find((field): field is string => typeof field === 'string' && Boolean(field.trim())) ?? item['location']
    return { id: item['id'], label: item['label'], location: item['location'], is_default: item['is_default'], description }
  })
}

function parsePlace(value: unknown): Place {
  if (!isRecord(value)) throw new ApiError('推荐店铺格式异常')
  const field = (name: string): string => {
    const data = value[name]
    if (data === undefined) return ''
    if (typeof data !== 'string') throw new ApiError('推荐店铺字段格式异常')
    return data
  }
  return { id: field('id'), name: field('name'), address: field('address'), distance: field('distance'), type: field('type') }
}

export function parseChatEvent(name: string, raw: string): ChatEvent | null {
  if (!['delta', 'done', 'error'].includes(name)) return null
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch (error) {
    if (error instanceof SyntaxError) throw new ApiError('服务器事件不是有效的 JSON')
    throw error
  }
  if (!isRecord(value)) throw new ApiError('服务器事件格式异常')
  switch (name) {
    case 'delta':
      if (typeof value['text'] !== 'string') throw new ApiError('增量内容格式异常')
      return { kind: 'delta', text: value['text'] }
    case 'done': {
      if (typeof value['answer_text'] !== 'string' || !Array.isArray(value['places'])) throw new ApiError('最终推荐格式异常')
      return { kind: 'done', data: { answer_text: value['answer_text'], places: value['places'].map(parsePlace) } }
    }
    case 'error':
      return { kind: 'error', message: messageFrom(value, '推荐生成失败，请稍后重试') }
    default:
      return null
  }
}
