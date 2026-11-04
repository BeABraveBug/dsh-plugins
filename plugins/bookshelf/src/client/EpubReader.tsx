import { useEffect, useRef, useState } from 'react'
import ePubImport from 'epubjs/lib/index.js'
import type { Book, Rendition } from 'epubjs'
import type { BookView, EpubPosition, ReaderTextContext } from '../shared/types.ts'
import type { Translate } from './i18n.ts'

interface EpubReaderProps {
  readonly book: BookView
  readonly initialPosition: EpubPosition | null
  readonly fetchBytes: (id: string) => Promise<ArrayBuffer>
  readonly onProgress: (position: EpubPosition, percent: number) => void
  readonly onContext: (context: ReaderTextContext | null) => void
  readonly t: Translate
}

interface RenditionEvents {
  on(event: 'relocated', listener: (location: { start: { cfi: string; percentage?: number } }) => void): void
  off?(event: 'relocated', listener: (location: { start: { cfi: string; percentage?: number } }) => void): void
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Resolve the EPUB factory across CJS/ESM interop wrappers. */
function epubFactory(): (input: ArrayBuffer) => Book {
  let current: unknown = ePubImport
  for (let depth = 0; depth < 3; depth += 1) {
    if (typeof current === 'function') return current as (input: ArrayBuffer) => Book
    if (current === null || typeof current !== 'object') break
    const next = (current as { default?: unknown }).default
    if (next === undefined) break
    current = next
  }
  throw new Error('EPUB parser is unavailable')
}

export function EpubReader({ book, initialPosition, fetchBytes, onProgress, onContext, t }: EpubReaderProps) {
  const hostRef = useRef<HTMLDivElement>(null)
  const onProgressRef = useRef(onProgress)
  const onContextRef = useRef(onContext)
  onProgressRef.current = onProgress
  onContextRef.current = onContext
  const initialRef = useRef(initialPosition)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let disposed = false
    let epubBook: Book | null = null
    let rendition: Rendition | null = null
    let locationsReady = false
    let lastCfi = initialRef.current?.cfi ?? null

    const emitContext = (source: string, cfi: string, selected: boolean, truncated = false) => {
      const excerpt = source.replace(/\s+/g, ' ').trim().slice(0, 12000)
      if (excerpt === '') { onContextRef.current(null); return }
      onContextRef.current({ format: 'epub', anchor: { kind: 'epub', cfi }, excerpt, truncated: truncated || (!selected && excerpt.length >= 12000) })
    }

    const readVisibleText = (percent = 0): { text: string; cfi: string } | null => {
      const contents = rendition?.getContents() as unknown as Array<{ document: Document }> | undefined
      const document = contents?.[0]?.document
      const full = document?.body?.innerText ?? ''
      if (full.trim() === '') return null
      const start = Math.floor((Math.min(100, Math.max(0, percent)) / 100) * Math.max(0, full.length - 12000))
      return { text: full.slice(start, start + 12000), cfi: lastCfi ?? initialRef.current?.cfi ?? '' }
    }

    const report = (cfi: string, fallback: number | undefined) => {
      if (disposed) return
      lastCfi = cfi
      let percent = fallback ?? 0
      if (locationsReady && epubBook !== null) {
        try { percent = epubBook.locations.percentageFromCfi(cfi) * 100 } catch { /* keep fallback */ }
      }
      const value = Math.min(100, Math.max(0, Number.isFinite(percent) ? percent : 0))
      onProgressRef.current({ kind: 'epub', cfi }, Math.round(value * 10) / 10)
      const visible = readVisibleText(value)
      if (visible !== null) emitContext(visible.text, cfi, false, value > 0)
    }

    void (async () => {
      try {
        const bytes = await fetchBytes(book.id)
        if (disposed) return
        epubBook = epubFactory()(new Uint8Array(bytes).buffer)
        await epubBook.ready
        if (disposed) return
        const host = hostRef.current
        if (host === null) return
        rendition = epubBook.renderTo(host, {
          width: '100%',
          height: '100%',
          flow: 'scrolled-doc',
          manager: 'continuous',
          spread: 'none',
          allowScriptedContent: false,
        })
        const events = rendition as unknown as RenditionEvents
        events.on('relocated', (location) => {
          report(location.start.cfi, location.start.percentage)
        })
        await rendition.display(initialRef.current?.cfi ?? undefined)
        if (disposed) return
        setLoading(false)
        if (lastCfi !== null) report(lastCfi, undefined)
        const contents = rendition.getContents() as unknown as Array<{ document: Document }>
        for (const content of contents) {
          content.document.addEventListener('mouseup', () => {
            if (disposed) return
            const selected = content.document.getSelection()?.toString().trim() ?? ''
            if (selected !== '') emitContext(selected, lastCfi ?? initialRef.current?.cfi ?? '', true)
            else {
              const visible = readVisibleText()
              if (visible !== null) emitContext(visible.text, visible.cfi, false)
            }
          })
        }
        const visible = readVisibleText()
        if (visible !== null) emitContext(visible.text, visible.cfi, false)
        // Location generation is intentionally deferred: the text is readable
        // before it finishes, and a complete percentage arrives afterwards.
        void epubBook.locations.generate(1200).then(() => {
          if (disposed) return
          locationsReady = true
          if (lastCfi !== null) report(lastCfi, undefined)
        }).catch(() => {})
      } catch (cause: unknown) {
        if (!disposed) {
          setError(messageOf(cause))
          setLoading(false)
        }
      }
    })()

    return () => {
      disposed = true
      try { rendition?.destroy() } catch {}
      try { epubBook?.destroy() } catch {}
      rendition = null
      epubBook = null
    }
  }, [book.id, fetchBytes])

  if (error !== null) {
    return <div className="bs-reader-error" role="alert"><p>{t('readerFailed')}</p><p className="bs-muted">{error}</p></div>
  }

  return (
    <div className="bs-epub-reader">
      {loading && <div className="bs-empty bs-reader-overlay">{t('readerLoading')}</div>}
      <div ref={hostRef} className="bs-epub-host" />
    </div>
  )
}

