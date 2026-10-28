import type { Preferences, RecommendationDecision, RecommendationSelection } from './recommendation.js'

export type User = Readonly<{ id: number; username: string }>
export type AuthData = Readonly<{ token: string; user: User }>
export type Address = Readonly<{
  id: number
  label: string
  is_default: boolean
  location: string
  description: string
}>
export type LocationCandidate = Readonly<{ id: string; name: string; address: string; location: string; city: string }>
export type SourceState = 'satisfied' | 'unsatisfied' | 'unknown'
// 已接受推荐卡片：id 为服务端校验过的真实 POI ID（可空），candidate_key 只是本次稳定键，二者不得互相替代；
// cost 仅在来源价格状态已知时保留；states 为来源三态，旧服务端为 null。
export type Place = Readonly<{
  id: string; candidate_key: string; name: string; address: string; location: string; distance: string; type: string; cost: string
  states: Readonly<{ range: SourceState; food: SourceState; price: SourceState }> | null
}>
// 新版服务端的 done 摘要；旧服务端没有此字段，即为旧版文本结果（不得据此生成可点击方案）。
export type DoneRecommendation = Readonly<{ status: RecommendationDecision['status']; preferences: Preferences; decision: RecommendationDecision }>
export type ChatDone = Readonly<{ answer_text: string; places: readonly Place[]; recommendation?: DoneRecommendation }>
export type ChatEvent =
  | Readonly<{ kind: 'decision'; decision: RecommendationDecision }>
  | Readonly<{ kind: 'delta'; text: string }>
  | Readonly<{ kind: 'done'; data: ChatDone }>
  | Readonly<{ kind: 'error'; message: string }>
export type ChatMessage = Readonly<{ role: 'user' | 'assistant'; content: string }>
export type ChatTurn = Readonly<{ user: string; assistant: string }>
export type ChatTurnDraft = Readonly<{ user: string; assistant: string; completed: boolean }>
export type LocationChoice =
  | Readonly<{ kind: 'address'; address: Address }>
  | Readonly<{ kind: 'coordinates'; location: string; name?: string; address?: string; source?: 'search' }>
export type ChatRequest = Readonly<{
  messages: readonly ChatMessage[]
  address_id?: number
  location?: string
  preferences?: Preferences
  selection?: RecommendationSelection
}>

export class ApiError extends Error {
  constructor(message: string, readonly status = 0) {
    super(message)
    this.name = 'ApiError'
  }
}

export function buildChatMessages(history: readonly ChatTurn[], currentUser: string): readonly ChatMessage[] {
  return [
    ...history.flatMap((turn): readonly ChatMessage[] => [
      { role: 'user', content: turn.user },
      { role: 'assistant', content: turn.assistant },
    ]),
    { role: 'user', content: currentUser },
  ]
}

export function commitChatTurn(history: readonly ChatTurn[], draft: ChatTurnDraft): readonly ChatTurn[] {
  if (!draft.completed || !draft.user.trim()) return history
  return [...history, { user: draft.user, assistant: draft.assistant }]
}

export function isCurrentGeneration(generation: number, currentGeneration: number, signal: AbortSignal): boolean {
  return generation === currentGeneration && !signal.aborted
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

export function parseAddress(item: unknown): Address {
  if (!isRecord(item) || typeof item['id'] !== 'number' || !Number.isSafeInteger(item['id']) || item['id'] <= 0
    || typeof item['label'] !== 'string' || typeof item['location'] !== 'string' || typeof item['is_default'] !== 'boolean') {
    throw new ApiError('服务器返回的地址格式异常')
  }
  const text = (field: unknown): field is string => typeof field === 'string' && Boolean(field.trim())
  const name = item['name']
  const address = [item['formatted_address'], item['address']].find(text)
  const description = text(name) && address && name.trim() !== address.trim()
    ? `${name.trim()} · ${address.trim()}`
    : address ?? (text(name) ? name : item['location'])
  return { id: item['id'], label: item['label'], location: item['location'], is_default: item['is_default'], description }
}

export function parseAddresses(value: unknown): readonly Address[] {
  if (!isRecord(value) || !Array.isArray(value['items'])) throw new ApiError('服务器返回的地址簿格式异常，请重试')
  return value['items'].map(parseAddress)
}

// 后端 Label 列为 size:64；is_default 只透传用户勾选，首个地址自动默认由后端决定。
export const addressLabelMax = 64
export type SavableChoice = Extract<LocationChoice, { kind: 'coordinates' }>
export type CreateAddressRequest = Readonly<{ label: string; location: string; is_default: boolean; name?: string; address?: string }>

export function savableChoice(choice: LocationChoice | null): choice is SavableChoice {
  return choice?.kind === 'coordinates' && validLocation(choice.location)
}

export function addressLabelError(label: string): string {
  const length = [...label.trim()].length
  if (!length) return '请填写地址标签，例如：家、公司'
  return length > addressLabelMax ? `地址标签最多 ${addressLabelMax} 个字符` : ''
}

export function buildCreateAddressRequest(label: string, choice: LocationChoice | null, isDefault: boolean): CreateAddressRequest {
  if (!savableChoice(choice)) throw new ApiError('请先确认一个有效地点再保存')
  const problem = addressLabelError(label)
  if (problem) throw new ApiError(problem)
  return {
    label: label.trim(), location: choice.location, is_default: isDefault,
    ...(choice.name?.trim() ? { name: choice.name.trim() } : {}),
    ...(choice.address?.trim() ? { address: choice.address.trim() } : {}),
  }
}

export function parseLocationCandidates(value: unknown): readonly LocationCandidate[] {
  if (!isRecord(value) || !Array.isArray(value['items']) || value['items'].length > 10) {
    throw new ApiError('服务器返回的地点列表格式异常，请重试')
  }
  return value['items'].map((item: unknown): LocationCandidate => {
    if (!isRecord(item) || typeof item['id'] !== 'string' || typeof item['name'] !== 'string' || !item['name'].trim()
      || typeof item['address'] !== 'string' || typeof item['city'] !== 'string'
      || typeof item['location'] !== 'string' || !validLocation(item['location'])) {
      throw new ApiError('服务器返回的地点格式异常，请重试')
    }
    return { id: item['id'], name: item['name'], address: item['address'], location: item['location'], city: item['city'] }
  })
}

// 来源价格多为高德参考人均，只称“参考”，不声称已核实。
export function priceLabel(cost: string): string {
  return /^\d+(?:\.\d+)?$/.test(cost) ? `参考人均 ¥${cost}` : '价格待核实'
}

function parsePlace(value: unknown): Place {
  if (!isRecord(value)) throw new ApiError('推荐店铺格式异常')
  const field = (name: string): string => {
    const data = value[name]
    if (data === undefined) return ''
    if (typeof data !== 'string') throw new ApiError('推荐店铺字段格式异常')
    return data
  }
  const state = (evaluation: Record<string, unknown>, name: string): SourceState => {
    const evidence = evaluation[name]
    const value = isRecord(evidence) ? evidence['state'] : undefined
    if (value !== 'satisfied' && value !== 'unsatisfied' && value !== 'unknown') throw new ApiError('推荐店铺字段格式异常')
    return value
  }
  const evaluation = value['evaluation']
  if (evaluation !== undefined && !isRecord(evaluation)) throw new ApiError('推荐店铺字段格式异常')
  const states = evaluation ? { range: state(evaluation, 'range'), food: state(evaluation, 'food'), price: state(evaluation, 'price') } : null
  // 卡片以“参考人均 ¥X”展示，与后端 assessPrice 一致：币种/口径为人民币人均，或缺失（高德参考人均）；明确的其他币种/口径一律“价格待核实”。
  const priced = states !== null && states.price !== 'unknown'
    && ['', 'CNY', 'RMB', '人民币'].includes(field('cost_currency').toUpperCase()) && ['', 'per_person', '人均'].includes(field('cost_basis').toLowerCase())
  return {
    id: field('id'), candidate_key: field('candidate_key'), name: field('name'), address: field('address'), location: field('location'),
    distance: field('distance'), type: field('type'), cost: priced ? field('cost') : '', states,
  }
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
