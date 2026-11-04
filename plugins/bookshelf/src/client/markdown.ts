import { marked } from 'marked'
import DOMPurify from 'dompurify'

/** Render user-authored Markdown into sanitized HTML for the reader and notes. */
export function renderMarkdown(source: string): string {
  const parsed = marked.parse(source, { async: false, gfm: true, breaks: false })
  const html = typeof parsed === 'string' ? parsed : ''
  return DOMPurify.sanitize(html, {
    USE_PROFILES: { html: true },
    FORBID_TAGS: ['script', 'style', 'iframe', 'object', 'embed', 'form'],
    FORBID_ATTR: ['style'],
  })
}
