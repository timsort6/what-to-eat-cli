import MarkdownIt from 'markdown-it'
import createDOMPurify from 'dompurify'

const httpUrl = /^https?:\/\//i
const parser = new MarkdownIt({ html: false })
parser.validateLink = (url: string): boolean => httpUrl.test(url)
parser.renderer.rules['image'] = () => ''

const purifier = createDOMPurify(window)
purifier.addHook('afterSanitizeAttributes', (node) => {
  if (node.tagName === 'A' && node.hasAttribute('href')) {
    node.setAttribute('rel', 'noopener noreferrer')
  }
})

// 上限按 Unicode 码点计数，与后端 rune 计数一致；逐码点计数到超限即停，不展开数组。
export function exceedsMarkdownLimit(source: string): boolean {
  if (source.length <= 64_000) return false
  let count = 0
  for (const _ of source) if (++count > 64_000) return true
  return false
}

export function renderMarkdown(source: string): string {
  if (exceedsMarkdownLimit(source)) {
    throw new RangeError('Markdown 内容超过 64000 字符上限')
  }

  return purifier.sanitize(parser.render(source), {
    ALLOWED_TAGS: [
      'p', 'br', 'hr', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
      'ul', 'ol', 'li', 'em', 'strong', 's', 'blockquote', 'pre', 'code',
      'table', 'thead', 'tbody', 'tr', 'th', 'td', 'a',
    ],
    ALLOWED_ATTR: ['href', 'title', 'rel', 'start', 'class'],
    ADD_URI_SAFE_ATTR: ['start'],
    ALLOW_DATA_ATTR: false,
    ALLOW_ARIA_ATTR: false,
    ALLOWED_URI_REGEXP: httpUrl,
  })
}
