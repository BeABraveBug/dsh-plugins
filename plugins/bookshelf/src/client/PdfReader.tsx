import { useCallback, useEffect, useRef, useState } from 'react'
import type { PDFDocumentProxy, RenderTask } from 'pdfjs-dist'
import { ensurePdfWorker, pdfjsLib } from './pdf.ts'
import type { BookView, PdfPosition } from '../shared/types.ts'
import type { Translate } from './i18n.ts'
import { pdfjsAssetUrl } from './api.ts'
import { ChevronLeftIcon, ChevronRightIcon } from './icons.tsx'

interface PdfReaderProps {
  readonly book: BookView
  readonly initialPosition: PdfPosition | null
  readonly initialWidth: number | null
  readonly onWidthChange: (width: number) => void
  readonly fetchBytes: (id: string) => Promise<ArrayBuffer>
  readonly onProgress: (position: PdfPosition, percent: number) => void
  readonly t: Translate
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function clampPage(value: number, total: number): number {
  return Math.min(total, Math.max(1, Math.round(value)))
}

export function PdfReader({ book, initialPosition, initialWidth, onWidthChange, fetchBytes, onProgress, t }: PdfReaderProps) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const docRef = useRef<PDFDocumentProxy | null>(null)
  const renderTaskRef = useRef<RenderTask | null>(null)
  const initialRef = useRef(initialPosition)
  const restoreRef = useRef(initialPosition?.offset ?? 0)
  const suppressRef = useRef(true)
  const pageRef = useRef(initialPosition?.page ?? 1)
  const totalRef = useRef(initialPosition?.total ?? 1)
  const onProgressRef = useRef(onProgress)
  const onWidthChangeRef = useRef(onWidthChange)
  onProgressRef.current = onProgress
  onWidthChangeRef.current = onWidthChange

  const [page, setPage] = useState(initialPosition?.page ?? 1)
  const [total, setTotal] = useState(initialPosition?.total ?? 0)
  const [zoom, setZoom] = useState(() => {
    const width = initialWidth ?? 1
    return Number.isFinite(width) ? Math.min(3, Math.max(0.4, width)) : 1
  })
  const [pageInput, setPageInput] = useState(String(initialPosition?.page ?? 1))
  const zoomRef = useRef(zoom)
  zoomRef.current = zoom
  const [loading, setLoading] = useState(true)
  const [rendering, setRendering] = useState(false)
  const [error, setError] = useState<string | null>(null)

  pageRef.current = page
  totalRef.current = total

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      setLoading(true)
      setError(null)
      try {
        ensurePdfWorker()
        const bytes = await fetchBytes(book.id)
        if (cancelled) return
        const loadingTask = pdfjsLib.getDocument({
          data: new Uint8Array(bytes),
          cMapUrl: pdfjsAssetUrl('cmap'),
          cMapPacked: true,
          standardFontDataUrl: pdfjsAssetUrl('font'),
          wasmUrl: pdfjsAssetUrl('wasm'),
          disableFontFace: true,
          useWorkerFetch: false,
          verbosity: 0,
        })
        const doc = await loadingTask.promise
        if (cancelled) {
          void doc.destroy().catch(() => {})
          return
        }
        docRef.current = doc
        setTotal(doc.numPages)
        totalRef.current = doc.numPages
        setPage((current) => clampPage(initialRef.current?.page ?? current, doc.numPages))
        setLoading(false)
      } catch (cause: unknown) {
        if (!cancelled) {
          setError(messageOf(cause))
          setLoading(false)
        }
      }
    })()
    return () => {
      cancelled = true
      renderTaskRef.current?.cancel()
      const doc = docRef.current
      docRef.current = null
      if (doc !== null) void doc.destroy().catch(() => {})
    }
  }, [book.id, fetchBytes])

  const report = useCallback((pageNumber: number, ratio: number) => {
    const totalPages = Math.max(1, totalRef.current)
    const clamped = Math.min(1, Math.max(0, ratio))
    const percent = Math.min(100, Math.max(0, ((pageNumber - 1 + clamped) / totalPages) * 100))
    onProgressRef.current({ kind: 'pdf', page: pageNumber, total: totalPages, offset: clamped }, Math.round(percent * 10) / 10)
  }, [])

  useEffect(() => {
    const doc = docRef.current
    if (doc === null || loading) return
    let cancelled = false
    setRendering(true)
    ;(async () => {
      try {
        const pdfPage = await doc.getPage(clampPage(page, doc.numPages))
        if (cancelled) return
        const base = pdfPage.getViewport({ scale: 1 })
        const containerWidth = scrollRef.current?.clientWidth ?? 900
        const fit = Math.max(0.15, (containerWidth - 32) / base.width)
        const viewport = pdfPage.getViewport({ scale: fit * zoom })
        const canvas = canvasRef.current
        if (canvas === null) return
        const ratio = window.devicePixelRatio || 1
        canvas.width = Math.max(1, Math.floor(viewport.width * ratio))
        canvas.height = Math.max(1, Math.floor(viewport.height * ratio))
        canvas.style.width = `${viewport.width}px`
        canvas.style.height = `${viewport.height}px`
        const task = pdfPage.render({
          canvas,
          viewport,
          transform: ratio === 1 ? undefined : [ratio, 0, 0, ratio, 0, 0],
        })
        renderTaskRef.current = task
        await task.promise
        if (cancelled) return
        setRendering(false)
        const scroller = scrollRef.current
        if (scroller !== null) {
          const offset = restoreRef.current
          restoreRef.current = 0
          scroller.scrollTop = offset * Math.max(0, scroller.scrollHeight - scroller.clientHeight)
          suppressRef.current = false
          report(pageRef.current, offset)
        }
      } catch (cause: unknown) {
        if (cancelled) return
        if ((cause as { name?: string } | null)?.name === 'RenderingCancelledException') return
        setError(messageOf(cause))
        setRendering(false)
      }
    })()
    return () => {
      cancelled = true
      renderTaskRef.current?.cancel()
      renderTaskRef.current = null
    }
  }, [loading, page, report, zoom])

  useEffect(() => { setPageInput(String(page)) }, [page])

  const handleScroll = useCallback(() => {
    if (suppressRef.current) return
    const scroller = scrollRef.current
    if (scroller === null) return
    const max = Math.max(0, scroller.scrollHeight - scroller.clientHeight)
    const ratio = max === 0 ? 0 : scroller.scrollTop / max
    report(pageRef.current, ratio)
  }, [report])

  const goTo = useCallback((next: number) => {
    const target = clampPage(next, Math.max(1, totalRef.current))
    if (target === pageRef.current) return
    restoreRef.current = 0
    suppressRef.current = true
    setPage(target)
  }, [])

  const changeZoom = useCallback((next: number) => {
    const clamped = Math.min(3, Math.max(0.4, Math.round(next * 100) / 100))
    // At a zoom boundary the render effect will not run; entering the
    // suppressed state here would stop scroll progress until another change.
    if (clamped === zoomRef.current) return
    const scroller = scrollRef.current
    if (scroller !== null) {
      const max = Math.max(0, scroller.scrollHeight - scroller.clientHeight)
      restoreRef.current = max === 0 ? 0 : scroller.scrollTop / max
      suppressRef.current = true
    }
    zoomRef.current = clamped
    setZoom(clamped)
    onWidthChangeRef.current(clamped)
  }, [])

  if (error !== null) {
    return <div className="bs-reader-error" role="alert"><p>{t('readerFailed')}</p><p className="bs-muted">{error}</p></div>
  }
  if (loading) return <div className="bs-empty">{t('readerLoading')}</div>

  return (
    <div className="bs-pdf-reader">
      <div className="bs-pdf-toolbar">
        <button type="button" className="bs-icon-button" onClick={() => goTo(page - 1)} disabled={page <= 1} aria-label={t('prevPage')}><ChevronLeftIcon size={16} /></button>
        <form className="bs-page-form" onSubmit={(event) => { event.preventDefault(); const value = Number(pageInput); if (Number.isFinite(value)) goTo(value) }}>
          <input className="bs-page-input" value={pageInput} onChange={(event) => setPageInput(event.target.value)} aria-label={t('page')} inputMode="numeric" />
          <span className="bs-muted">/ {total}</span>
        </form>
        <button type="button" className="bs-icon-button" onClick={() => goTo(page + 1)} disabled={page >= total} aria-label={t('nextPage')}><ChevronRightIcon size={16} /></button>
        <span className="bs-toolbar-spacer" />
        <button type="button" className="bs-button" onClick={() => changeZoom(zoom - 0.1)} aria-label={t('zoomOut')}>−</button>
        <span className="bs-zoom-label">{Math.round(zoom * 100)}%</span>
        <button type="button" className="bs-button" onClick={() => changeZoom(zoom + 0.1)} aria-label={t('zoomIn')}>+</button>
        <button type="button" className="bs-button" onClick={() => changeZoom(1)}>{t('resetZoom')}</button>
        {rendering && <span className="bs-muted">{t('loading')}</span>}
      </div>
      <div ref={scrollRef} className="bs-pdf-scroll" onScroll={handleScroll}>
        <div className="bs-pdf-canvas-wrap">
          <canvas ref={canvasRef} className="bs-pdf-canvas" />
        </div>
      </div>
    </div>
  )
}
