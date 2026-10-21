import { ApiError, parseChatEvent } from './protocol.js'
import type { ChatEvent } from './protocol.js'

export function createSSEParser(onEvent: (event: ChatEvent) => void) {
  let line = ''
  let skipLF = false
  let name = ''
  let data: string[] = []
  let terminal = false

  function processLine(): void {
    if (!line) {
      if (data.length) {
        const event = parseChatEvent(name, data.join('\n'))
        if (event) {
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
