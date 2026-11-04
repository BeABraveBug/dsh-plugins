import { useEffect, useMemo, useRef, useState } from 'react'
import type { BookView, ScrollPosition } from '../shared/types.ts'
import type { Translate } from './i18n.ts'
import { renderMarkdown } from './markdown.ts'

interface TextReaderProps {
  readonly book: BookView
  readonly initialPosition: ScrollPosition | null
  readonly fetchText: (id: string) => Promise<string>
  readonly onProgress: (position: ScrollPosition, percent: number) => void
  readonly t: Translate
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}


export function TextReader({ book, initialPosition, fetchText, onProgress, t }: TextReaderProps) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const onProgressRef = useRef(onProgress)
  onProgressRef.current = onProgress
  const initialRatio = initialPosition?.ratio ?? 0
  const initialRatioRef = useRef(initialRatio)
  const restoredRef = useRef(false)
  const [text, setText] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    restoredRef.current = false
    setText(null)
    setError(null)
    void (async () => {
      try {
        const content = await fetchText(book.id)
        if (!cancelled) setText(content)
      } catch (cause: unknown) {
        if (!cancelled) setError(messageOf(cause))
      }
    })()
    return () => { cancelled = true }
  }, [book.id, fetchText])

  const html = useMemo(() => (book.format === 'markdown' && text !== null ? renderMarkdown(text) : null), [book.format, text])

  useEffect(() => {
    if (text === null || restoredRef.current) return
    const scroller = scrollRef.current
    if (scroller === null) return
    restoredRef.current = true
    const max = Math.max(0, scroller.scrollHeight - scroller.clientHeight)
    const ratio = initialRatioRef.current
    scroller.scrollTop = ratio * max
    onProgressRef.current({ kind: 'scroll', ratio }, Math.round(ratio * 1000) / 10)
  }, [text])

  const handleScroll = () => {
    const scroller = scrollRef.current
    if (scroller === null) return
    const max = Math.max(0, scroller.scrollHeight - scroller.clientHeight)
    const ratio = max === 0 ? 0 : Math.min(1, Math.max(0, scroller.scrollTop / max))
    onProgressRef.current({ kind: 'scroll', ratio }, Math.round(ratio * 1000) / 10)
  }

  if (error !== null) {
    return <div className="bs-reader-error" role="alert"><p>{t('readerFailed')}</p><p className="bs-muted">{error}</p></div>
  }
  if (text === null) return <div className="bs-empty">{t('readerLoading')}</div>
  if (text.trim() === '') return <div className="bs-empty">{t('readerEmpty')}</div>

  return (
    <div ref={scrollRef} className="bs-text-scroll" onScroll={handleScroll}>
      {html !== null
        ? <article className="bs-markdown" dangerouslySetInnerHTML={{ __html: html }} />
        : <pre className="bs-plain-text">{text}</pre>}
    </div>
  )
}
