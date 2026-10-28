import { ApiError, messageFrom, validLocation } from './protocol.js'
import type { LocationCandidate, LocationChoice } from './protocol.js'

export type LocationSearchInput = Readonly<{ query: string; city: string }>
export type SearchState = Readonly<{
  phase: 'idle' | 'waiting' | 'loading' | 'ready' | 'empty' | 'error'
  items: readonly LocationCandidate[]
  selected: LocationCandidate | null
  error: string
  invalidFields: readonly (keyof LocationSearchInput)[]
}>

class LocationSearchValidationError extends ApiError {
  constructor(message: string, readonly invalidFields: readonly (keyof LocationSearchInput)[]) {
    super(message)
  }
}
type SearchEffects = Readonly<{
  search: (input: LocationSearchInput, signal: AbortSignal) => Promise<readonly LocationCandidate[]>
  changed: (state: SearchState) => void
  confirmed: (choice: Extract<LocationChoice, { kind: 'coordinates' }>) => void
  expired: () => void
}>

export function parseLocationSearchInput(input: LocationSearchInput): LocationSearchInput {
  const query = input.query.trim()
  const city = input.city.trim()
  const invalidFields: (keyof LocationSearchInput)[] = []
  if ([...query].length < 1 || [...query].length > 80) invalidFields.push('query')
  if ([...city].length > 100) invalidFields.push('city')
  if (invalidFields.length) throw new LocationSearchValidationError(invalidFields.map(field => field === 'query'
    ? '搜索地点请输入 1–80 个字符' : '城市最多输入 100 个字符').join('；'), invalidFields)
  return { query, city }
}

export function createLocationSearch(effects: SearchEffects, signal: AbortSignal) {
  let generation = 0
  let timer: ReturnType<typeof setTimeout> | undefined
  let timeout: ReturnType<typeof setTimeout> | undefined
  let active: AbortController | null = null
  let state: SearchState = { phase: 'idle', items: [], selected: null, error: '', invalidFields: [] }

  function publish(next: SearchState): void {
    state = next
    effects.changed(state)
  }

  function invalidate(): void {
    generation++
    clearTimeout(timer)
    clearTimeout(timeout)
    active?.abort()
    active = null
  }

  function cancel(): void {
    invalidate()
    publish({ phase: 'idle', items: [], selected: null, error: '', invalidFields: [] })
  }

  async function run(input: LocationSearchInput, requestGeneration: number): Promise<void> {
    const controller = new AbortController()
    active = controller
    const current = () => requestGeneration === generation && !signal.aborted && !controller.signal.aborted
    publish({ phase: 'loading', items: [], selected: null, error: '', invalidFields: [] })
    timeout = setTimeout(() => {
      if (!current()) return
      invalidate()
      publish({ phase: 'error', items: [], selected: null, error: '地点搜索超时，请重试', invalidFields: [] })
    }, 10000)
    try {
      const items = await effects.search(input, controller.signal)
      if (!current()) return
      publish({ phase: items.length ? 'ready' : 'empty', items, selected: null, error: '', invalidFields: [] })
    } catch (failure) {
      if (!current()) return
      const expired = failure instanceof ApiError && failure.status === 401
      const timedOut = failure instanceof ApiError && [408, 504].includes(failure.status)
      publish({ phase: 'error', items: [], selected: null, invalidFields: [], error: expired ? '登录已过期，请重新登录'
        : timedOut ? '地点搜索超时，请重试' : failure instanceof TypeError
          ? '网络连接中断，请检查连接后重新搜索，也可使用定位或地址簿'
          : `${messageFrom(failure, '地点搜索失败')}，请重试` })
      if (expired) effects.expired()
    } finally {
      if (requestGeneration === generation) {
        clearTimeout(timeout)
        active = null
      }
    }
  }

  function update(input: LocationSearchInput): void {
    cancel()
    if (signal.aborted) return
    if (!input.query.trim()) {
      if ([...input.city.trim()].length > 100) publish({ phase: 'error', items: [], selected: null,
        error: '城市最多输入 100 个字符', invalidFields: ['city'] })
      return
    }
    let parsed: LocationSearchInput
    try {
      parsed = parseLocationSearchInput(input)
    } catch (failure) {
      if (!(failure instanceof LocationSearchValidationError)) throw failure
      publish({ phase: 'error', items: [], selected: null, error: failure.message, invalidFields: failure.invalidFields })
      return
    }
    publish({ phase: 'waiting', items: [], selected: null, error: '', invalidFields: [] })
    const requestGeneration = generation
    timer = setTimeout(() => { void run(parsed, requestGeneration) }, 300)
  }

  function select(index: number): void {
    const candidate = state.items[index]
    if (signal.aborted || !candidate || !validLocation(candidate.location)) return
    invalidate()
    publish({ ...state, selected: candidate })
  }

  function confirm(): void {
    const candidate = state.selected
    if (signal.aborted || !candidate || !validLocation(candidate.location)) return
    cancel()
    effects.confirmed({ kind: 'coordinates', location: candidate.location, name: candidate.name, address: candidate.address, source: 'search' })
  }

  signal.addEventListener('abort', cancel)
  return { update, select, confirm, cancel, dispose() { signal.removeEventListener('abort', cancel); cancel() } }
}
