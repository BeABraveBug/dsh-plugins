import { marked } from 'marked'
import markedKatex from 'marked-katex-extension'
import mermaid from 'mermaid'
import createDOMPurify from 'dompurify'
import 'katex/dist/katex.min.css'

type Purifier = { sanitize: (html: string, options?: Record<string, unknown>) => string; addHook: (name: string, hook: (node: Element, data: { attrName: string; keepAttr: boolean }) => void) => void }

function makePurifier(): Purifier | null {
  if (typeof window === 'undefined') return null
  if (typeof createDOMPurify === 'function') return (createDOMPurify as unknown as (window: Window) => Purifier)(window)
  return createDOMPurify as unknown as Purifier
}

const purifier = makePurifier()
const mermaidPurifier = makePurifier()

if (typeof purifier?.addHook === 'function') {
  purifier.addHook('uponSanitizeAttribute', (node, data) => {
    if (data.attrName === 'style' && !(node as Element).closest?.('.katex')) data.keepAttr = false
  })
}

function sanitize(html: string, options: Record<string, unknown>): string {
  return purifier === null ? html : purifier.sanitize(html, options)
}

function sanitizeRawHtml(html: string): string {
  return purifier === null ? html : purifier.sanitize(html, {
    USE_PROFILES: { html: true },
    FORBID_TAGS: ['script', 'style', 'iframe', 'object', 'embed', 'form'],
    FORBID_ATTR: ['style'],
  })
}

marked.use({ renderer: { html: ({ text }: { text: string }) => sanitizeRawHtml(text) } })

marked.use(markedKatex({ throwOnError: false, output: 'html', nonStandard: true }))
mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', htmlLabels: false, flowchart: { htmlLabels: false }, class: { htmlLabels: false } })


let mermaidSequence = 0

/** Render user-authored Markdown into sanitized HTML for the reader and notes. */
export function renderMarkdown(source: string): string {
  const parsed = marked.parse(source, { async: false, gfm: true, breaks: false })
  const html = typeof parsed === 'string' ? parsed : ''
  return sanitize(html, {
    USE_PROFILES: { html: true, svg: true, svgFilters: true },
    FORBID_TAGS: ['script', 'style', 'iframe', 'object', 'embed', 'form'],
    FORBID_ATTR: [],
  })
}

/** Replace Mermaid code blocks in rendered Markdown with sanitized SVG diagrams. */
export async function renderMermaid(container: HTMLElement | null): Promise<void> {
  if (container === null) return
  const blocks = Array.from(container.querySelectorAll<HTMLElement>('pre > code.language-mermaid'))
  for (const code of blocks) {
    const source = code.textContent ?? ''
    if (source.trim() === '') continue
    const id = `bs-mermaid-${++mermaidSequence}`
    try {
      await mermaid.parse(source)
      const { svg } = await mermaid.render(id, source)
      const figure = document.createElement('div')
      figure.className = 'bs-mermaid'
      figure.innerHTML = mermaidPurifier === null ? '' : mermaidPurifier.sanitize(svg, { USE_PROFILES: { svg: true, svgFilters: true, html: true }, FORBID_TAGS: ['script', 'iframe', 'object', 'embed', 'form'] })
      code.parentElement?.replaceWith(figure)
    } catch {
      for (const leftover of [document.getElementById(id), document.getElementById(`d${id}`)]) leftover?.remove()
      // Keep the original code block when a diagram cannot be rendered.
    }
  }
}
