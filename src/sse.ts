import { ApiError, isRecord, parseChatEvent } from './protocol.js'
import type { ChatDone, ChatEvent } from './protocol.js'
import { parsePreferences, parseRecommendationDecision } from './recommendation.js'
import type { Preferences, RecommendationDecision } from './recommendation.js'

function invalidStream(message = '最终结果与推荐决策不一致，本次推荐未完成'): never {
  throw new ApiError(message)
}

function strictly<T>(parse: () => T, message: string): T {
  try {
    return parse()
  } catch (error) {
    if (error instanceof SyntaxError || error instanceof ApiError) return invalidStream(message)
    throw error
  }
}

// 新版 done 必须复述先前唯一 decision 的同一快照；status/preferences/decision 全缺且未收到 decision 才是旧版服务端。
function completeDone(data: ChatDone, raw: string, decision: RecommendationDecision | null): ChatDone {
  const value: unknown = JSON.parse(raw)
  if (!isRecord(value)) return invalidStream()
  const present = ['status', 'preferences', 'decision'].filter((key) => key in value)
  if (present.length === 0) return decision ? invalidStream() : data
  if (present.length !== 3 || !decision) return invalidStream()
  const summary = strictly(() => parseRecommendationDecision(JSON.stringify(value['decision'])), '最终结果的决策摘要格式异常')
  const preferences: Preferences = strictly(() => parsePreferences(value['preferences']), '最终结果的推荐条件格式异常')
  const places: readonly unknown[] = Array.isArray(value['places']) ? value['places'] : []
  const keys = places.map((place) => isRecord(place) ? place['candidate_key'] : undefined)
  if (JSON.stringify(summary) !== JSON.stringify(decision) || value['status'] !== decision.status
    || keys.length !== decision.selected_ids.length || keys.some((key, index) => key !== decision.selected_ids[index])) return invalidStream()
  return { ...data, recommendation: { status: decision.status, preferences, decision } }
}

export function createSSEParser(onEvent: (event: ChatEvent) => void) {
  let line = ''
  let skipLF = false
  let name = ''
  let data: string[] = []
  let terminal = false
  let decision: RecommendationDecision | null = null
  let answered = false

  function sequence(event: ChatEvent, raw: string): ChatEvent {
    switch (event.kind) {
      case 'decision':
        if (decision || answered) return invalidStream('推荐决策重复或晚于正文，本次推荐未完成')
        decision = event.decision
        return event
      case 'delta':
        answered = true
        return event
      case 'done':
        return { kind: 'done', data: completeDone(event.data, raw, decision) }
      case 'error':
        return event
    }
  }

  function processLine(): void {
    if (!line) {
      if (data.length) {
        const raw = data.join('\n')
        const parsed = name === 'decision'
          ? { kind: 'decision' as const, decision: strictly(() => parseRecommendationDecision(raw), '服务器推荐决策格式异常') }
          : parseChatEvent(name, raw)
        if (parsed) {
          const event = sequence(parsed, raw)
          terminal = event.kind === 'done' || event.kind === 'error'
          onEvent(event)
        }
      }
      name = ''
      data = []
    } else if (!line.startsWith(':')) {
      const colon = line.indexOf(':')
      const field = colon === -1 ? line : line.slice(0, colon)
      const value = colon === -1 ? '' : line.slice(colon + 1).replace(/^ /, '')
      if (field === 'event') name = value
      if (field === 'data') data.push(value)
    }
    line = ''
  }

  function feed(text: string): boolean {
    for (const character of text) {
      if (terminal) break
      if (skipLF && character === '\n') {
        skipLF = false
        continue
      }
      skipLF = false
      if (character === '\r' || character === '\n') {
        processLine()
        skipLF = character === '\r'
      } else {
        line += character
      }
    }
    return terminal
  }

  function finish(): void {
    if (!terminal) throw new ApiError('连接在推荐完成前中断，请重试；已收到的内容已保留')
  }

  return { feed, finish }
}

export async function readSSE(body: ReadableStream<Uint8Array>, onEvent: (event: ChatEvent) => void): Promise<void> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  const parser = createSSEParser(onEvent)
  try {
    while (true) {
      const { value, done } = await reader.read()
      if (done) {
        parser.feed(decoder.decode())
        parser.finish()
        return
      }
      if (parser.feed(decoder.decode(value, { stream: true }))) return
    }
  } finally {
    try {
      await reader.cancel()
    } finally {
      reader.releaseLock()
    }
  }
}
