import { useEffect, useMemo, useRef, useState } from 'react'
import type { BookView, ReaderTextContext, ScrollPosition } from '../shared/types.ts'
import type { Translate } from './i18n.ts'
import { renderMarkdown, renderMermaid } from './markdown.ts'

interface TextReaderProps {
  readonly jumpTarget?: { readonly key: number; readonly anchor: ScrollPosition } | null
  readonly onJumpError?: (message: string) => void
  readonly book: BookView
  readonly initialPosition: ScrollPosition | null
  readonly fetchText: (id: string) => Promise<string>
  readonly onProgress: (position: ScrollPosition, percent: number) => void
  readonly onContext: (context: ReaderTextContext | null) => void
  readonly t: Translate
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}


export function TextReader({ book, initialPosition, fetchText, onProgress, onContext, jumpTarget, onJumpError, t }: TextReaderProps) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const articleRef = useRef<HTMLDivElement>(null)
  const onProgressRef = useRef(onProgress)
  const onContextRef = useRef(onContext)
  onProgressRef.current = onProgress
  onContextRef.current = onContext
  const initialRatio = initialPosition?.ratio ?? 0
  const initialRatioRef = useRef(initialRatio)
  const restoredRef = useRef(false)
  const [text, setText] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [preparing, setPreparing] = useState(false)
  const [reloadToken, setReloadToken] = useState(0)

  useEffect(() => {
    let cancelled = false
    restoredRef.current = false
    setText(null)
    setError(null)
    setPreparing(false)
    void (async () => {
      try {
        const content = await fetchText(book.id)
        if (!cancelled) {
          setPreparing(true)
          // Let the loading state commit and paint before mounting the full body.
          requestAnimationFrame(() => { if (!cancelled) setText(content) })
        }
      } catch (cause: unknown) {
        if (!cancelled) setError(messageOf(cause))
      }
    })()
    return () => { cancelled = true }
  }, [book.id, fetchText, reloadToken])

  const html = useMemo(() => (book.format === 'markdown' && text !== null ? renderMarkdown(text) : null), [book.format, text])
  const textChunks = useMemo(() => {
    if (text === null || book.format === 'markdown') return []
    const chunks: string[] = []
    let current = ''
    for (const line of text.match(/[^\n]*\n|[^\n]+$/g) ?? [text]) {
      if (current !== '' && current.length + line.length > 32000) {
        chunks.push(current)
        current = ''
      }
      current += line
    }
    if (current !== '') chunks.push(current)
    return chunks
  }, [book.format, text])

  useEffect(() => {
    if (html !== null) void renderMermaid(articleRef.current)
  }, [html])

  useEffect(() => {
    if (text === null) return
    if (!preparing) return
    const timer = setTimeout(() => setPreparing(false), 150)
    return () => clearTimeout(timer)
  }, [text])

  useEffect(() => {
    if (text === null || restoredRef.current) return
    const scroller = scrollRef.current
    if (scroller === null) return
    restoredRef.current = true
    const max = Math.max(0, scroller.scrollHeight - scroller.clientHeight)
    const ratio = initialRatioRef.current
    scroller.scrollTop = ratio * max
    onProgressRef.current({ kind: 'scroll', ratio }, Math.round(ratio * 1000) / 10)
    if (text !== null) emitContext(text, ratio, false)
  }, [text])

  const emitContext = (source: string, ratio: number, selected: boolean) => {
    const text = selected ? source : source.slice(Math.floor(ratio * Math.max(0, source.length - 12000)), Math.floor(ratio * Math.max(0, source.length - 12000)) + 12000)
    const excerpt = text.trim()
    if (excerpt === '') { onContextRef.current(null); return }
    onContextRef.current({ format: book.format, anchor: { kind: 'scroll', ratio }, excerpt, truncated: !selected && excerpt.length >= 12000 })
  }

  const handleSelection = () => {
    const selected = window.getSelection()?.toString().trim() ?? ''
    if (selected !== '' && text !== null) {
      const scroller = scrollRef.current
      const max = scroller === null ? 0 : Math.max(0, scroller.scrollHeight - scroller.clientHeight)
      const ratio = scroller === null || max === 0 ? 0 : Math.min(1, Math.max(0, scroller.scrollTop / max))
      emitContext(selected, ratio, true)
    }
  }

  useEffect(() => {
    if (jumpTarget === null || jumpTarget === undefined) return
    if (!Number.isFinite(jumpTarget.anchor.ratio) || jumpTarget.anchor.ratio < 0 || jumpTarget.anchor.ratio > 1) {
      onJumpError?.(t('jumpUnavailable'))
      return
    }
    const scroller = scrollRef.current
    if (scroller === null) return
    const max = Math.max(0, scroller.scrollHeight - scroller.clientHeight)
    scroller.scrollTop = jumpTarget.anchor.ratio * max
  }, [jumpTarget?.key, text, onJumpError, t])

  const handleScroll = () => {
    const scroller = scrollRef.current
    if (scroller === null) return
    const max = Math.max(0, scroller.scrollHeight - scroller.clientHeight)
    const ratio = max === 0 ? 0 : Math.min(1, Math.max(0, scroller.scrollTop / max))
    onProgressRef.current({ kind: 'scroll', ratio }, Math.round(ratio * 1000) / 10)
    if (text !== null) emitContext(text, ratio, false)
  }

  if (error !== null) {
    return <div className="bs-reader-error" role="alert"><p>{t('readerFailed')}</p><p className="bs-muted">{error}</p><button type="button" className="bs-button" onClick={() => setReloadToken((value) => value + 1)}>{t('retry')}</button></div>
  }
  if (text === null) return <div className="bs-empty">{t('readingFile')}</div>
  if (text.trim() === '') return <div className="bs-empty">{t('readerEmpty')}</div>

  return (
    <div className="bs-text-reader">
    <div ref={scrollRef} className="bs-text-scroll" onScroll={handleScroll} onMouseUp={handleSelection}>
      {html !== null
        ? <article ref={articleRef} className="bs-markdown" dangerouslySetInnerHTML={{ __html: html }} />
        : <div className="bs-plain-text">{textChunks.map((chunk, index) => <pre key={index} className="bs-text-chunk">{chunk}</pre>)}</div>}
    </div>
    {preparing && <div className="bs-text-preparing" role="status">{t('preparingText')}</div>}
    </div>
  )
}
