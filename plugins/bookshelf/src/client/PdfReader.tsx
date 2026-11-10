import { useCallback, useEffect, useRef, useState } from 'react'
import type { PDFDocumentProxy, RenderTask } from 'pdfjs-dist'
import { ensurePdfWorker, pdfjsLib } from './pdf.ts'
import type { BookView, PdfPosition, ReaderScreenshot, ReaderTextContext, ReadingPosition } from '../shared/types.ts'
import type { Translate } from './i18n.ts'
import { pdfjsAssetUrl } from './api.ts'
import { ChevronLeftIcon, ChevronRightIcon } from './icons.tsx'

interface PdfReaderProps {
  readonly jumpTarget?: { readonly key: number; readonly anchor: ReadingPosition } | null
  readonly referencePage?: number
  readonly onJumpError?: (message: string) => void
  readonly book: BookView
  readonly initialPosition: PdfPosition | null
  readonly initialWidth: number | null
  readonly onWidthChange: (width: number) => void
  readonly fetchBytes: (id: string) => Promise<ArrayBuffer>
  readonly onProgress: (position: PdfPosition, percent: number) => void
  readonly onContext: (context: ReaderTextContext | null) => void
  readonly onScreenshot: (screenshot: ReaderScreenshot | null) => void
  readonly t: Translate
}

interface OutlineEntry {
  readonly title: string
  readonly page: number
  readonly children: readonly OutlineEntry[]
}

async function resolveOutline(doc: PDFDocumentProxy, items: readonly unknown[], depth = 0): Promise<OutlineEntry[]> {
  const result: OutlineEntry[] = []
  for (const raw of items) {
    const item = raw as { title?: unknown; dest?: unknown; items?: readonly unknown[] }
    if (typeof item.title !== 'string') continue
    let page = 0
    try {
      const dest = typeof item.dest === 'string' ? await doc.getDestination(item.dest) : item.dest
      if (Array.isArray(dest) && dest.length > 0) {
        const target = dest[0]
        page = typeof target === 'number' ? target + 1 : (await doc.getPageIndex(target as never)) + 1
        if (!Number.isInteger(page) || page < 1 || page > doc.numPages) page = 0
      }
    } catch { page = 0 }
    const children = Array.isArray(item.items) && depth < 8 ? await resolveOutline(doc, item.items, depth + 1) : []
    if (page > 0 || children.length > 0) result.push({ title: item.title, page, children })
  }
  return result
}

function OutlineTree({ entries, current, onOpen }: { readonly entries: readonly OutlineEntry[]; readonly current: number; readonly onOpen: (page: number) => void }) {
  return <ul className="bs-pdf-outline">{entries.map((entry, index) => <li key={`${entry.title}-${index}`}>
    {entry.children.length > 0
      ? <details open={entry.page === current || undefined}><summary>{entry.title}</summary><OutlineTree entries={entry.children} current={current} onOpen={onOpen} /></details>
      : <button type="button" className={entry.page === current ? 'is-current' : ''} onClick={() => { if (entry.page > 0) onOpen(entry.page) }}>{entry.title}</button>}
  </li>)}</ul>
}

function PdfThumbnail({ doc, page, current, onOpen, label }: { readonly doc: PDFDocumentProxy; readonly page: number; readonly current: boolean; readonly onOpen: (page: number) => void; readonly label: string }) {
  const ref = useRef<HTMLCanvasElement>(null)
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    const canvas = ref.current
    if (canvas === null) return
    let cancelled = false
    let task: RenderTask | null = null
    const observer = new IntersectionObserver((entries) => {
      if (!entries.some((entry) => entry.isIntersecting)) return
      observer.disconnect()
      void (async () => {
        try {
          const pdfPage = await doc.getPage(page)
          if (cancelled) return
          const viewport = pdfPage.getViewport({ scale: 0.22 })
          const context = canvas.getContext('2d')
          if (context === null) return
          canvas.width = Math.max(1, Math.floor(viewport.width))
          canvas.height = Math.max(1, Math.floor(viewport.height))
          task = pdfPage.render({ canvas, viewport })
          await task.promise
        } catch { if (!cancelled) setFailed(true) }
      })()
    }, { rootMargin: '120px' })
    observer.observe(canvas)
    return () => { cancelled = true; observer.disconnect(); task?.cancel() }
  }, [doc, page])
  return <button type="button" className={`bs-pdf-thumb ${current ? 'is-current' : ''}`} onClick={() => onOpen(page)} aria-label={`${label} ${page}`}>
    {failed ? <span className="bs-pdf-thumb-fallback">{page}</span> : <canvas ref={ref} />}
    <span>{page}</span>
  </button>
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function clampPage(value: number, total: number): number {
  return Math.min(total, Math.max(1, Math.round(value)))
}

function cleanPdfText(raw: string): string {
  let text = raw.replace(/\r\n?/g, '\n').replace(/[ \t]+/g, ' ')
  text = text.replace(/[ \t]*([，。；：！？、])[ \t]*/g, '$1')
  text = text.replace(/([\u4e00-\u9fff])[ \t]+(?=[\u4e00-\u9fff])/g, '$1')
  text = text.replace(/([\u4e00-\u9fff])[ \t]+(?=[0-9A-Za-z])/g, '$1')
  text = text.replace(/([0-9A-Za-z])[ \t]+(?=[\u4e00-\u9fff])/g, '$1')
  text = text.replace(/(\d)[ \t]*\.[ \t]*(\d)/g, '$1.$2')
  return text.replace(/\n{3,}/g, '\n\n').trim()
}

export function PdfReader({ book, initialPosition, initialWidth, onWidthChange, fetchBytes, onProgress, onContext, onScreenshot, jumpTarget, referencePage, onJumpError, t }: PdfReaderProps) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const textLayerRef = useRef<HTMLDivElement>(null)
  const textLayerTaskRef = useRef<{ cancel?: () => void } | null>(null)
  const docRef = useRef<PDFDocumentProxy | null>(null)
  const [navOpen, setNavOpen] = useState(false)
  const [outline, setOutline] = useState<readonly OutlineEntry[] | null>(null)
  const renderTaskRef = useRef<RenderTask | null>(null)
  const initialRef = useRef(initialPosition)
  const restoreRef = useRef(initialPosition?.offset ?? 0)
  const suppressRef = useRef(true)
  const pageRef = useRef(initialPosition?.page ?? 1)
  const totalRef = useRef(initialPosition?.total ?? 1)
  const onProgressRef = useRef(onProgress)
  const onWidthChangeRef = useRef(onWidthChange)
  const onContextRef = useRef(onContext)
  const pageTextRef = useRef('')
  onProgressRef.current = onProgress
  onWidthChangeRef.current = onWidthChange
  onContextRef.current = onContext

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
  const [capture, setCapture] = useState<ReaderScreenshot | null>(null)
  const [containerWidth, setContainerWidth] = useState(0)
  const initialRestoreDone = useRef(false)
  const renderingRef = useRef(false)

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
        if (referencePage !== undefined && (referencePage < 1 || referencePage > doc.numPages)) {
          setError(t('jumpUnavailable'))
          setLoading(false)
          return
        }
        docRef.current = doc
        try {
          const rawOutline = await doc.getOutline()
          const resolved = rawOutline === null ? [] : await resolveOutline(doc, rawOutline)
          setOutline(resolved.length === 0 ? null : resolved)
        } catch { setOutline(null) }
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

  const emitContext = useCallback((text: string, keepRaw = false) => {
    const trimmed = keepRaw ? text.trim() : cleanPdfText(text)
    if (trimmed === '') {
      onContextRef.current(null)
      return
    }
    const scroller = scrollRef.current
    const max = scroller === null ? 0 : Math.max(0, scroller.scrollHeight - scroller.clientHeight)
    const offset = scroller === null || max === 0 ? 0 : Math.min(1, Math.max(0, scroller.scrollTop / max))
    const excerpt = trimmed.slice(0, 12000)
    onContextRef.current({
      format: 'pdf',
      anchor: { kind: 'pdf', page: pageRef.current, total: Math.max(1, totalRef.current), offset },
      excerpt,
      truncated: trimmed.length > excerpt.length,
    })
  }, [])

  const handleSelection = useCallback(() => {
    const selection = window.getSelection()
    const layer = textLayerRef.current
    if (selection === null || selection.rangeCount === 0 || layer === null) return
    const range = selection.getRangeAt(0)
    if (!layer.contains(range.startContainer) || !layer.contains(range.endContainer)) return
    const selected = selection.toString().trim()
    emitContext(selected === '' ? pageTextRef.current : selected, selected !== '')
  }, [emitContext])

  useEffect(() => {
    const onSelectionChange = () => { handleSelection() }
    document.addEventListener('selectionchange', onSelectionChange)
    return () => document.removeEventListener('selectionchange', onSelectionChange)
  }, [handleSelection])

  const captureRegion = useCallback(() => {
    const canvas = canvasRef.current
    const scroller = scrollRef.current
    if (canvas === null || scroller === null) return
    const canvasRect = canvas.getBoundingClientRect()
    const scrollRect = scroller.getBoundingClientRect()
    const left = Math.max(0, scrollRect.left - canvasRect.left)
    const top = Math.max(0, scrollRect.top - canvasRect.top)
    const right = Math.min(canvasRect.width, scrollRect.right - canvasRect.left)
    const bottom = Math.min(canvasRect.height, scrollRect.bottom - canvasRect.top)
    if (right <= left || bottom <= top) return
    const scaleX = canvas.width / canvasRect.width
    const scaleY = canvas.height / canvasRect.height
    const cropWidth = Math.max(1, Math.round((right - left) * scaleX))
    const cropHeight = Math.max(1, Math.round((bottom - top) * scaleY))
    const out = document.createElement('canvas')
    out.width = cropWidth
    out.height = cropHeight
    const context = out.getContext('2d')
    if (context === null) return
    context.drawImage(canvas, left * scaleX, top * scaleY, cropWidth, cropHeight, 0, 0, cropWidth, cropHeight)
    setCapture({ dataUrl: out.toDataURL('image/png'), width: cropWidth, height: cropHeight })
  }, [])

  const report = useCallback((pageNumber: number, ratio: number) => {
    const totalPages = Math.max(1, totalRef.current)
    const clamped = Math.min(1, Math.max(0, ratio))
    const percent = Math.min(100, Math.max(0, ((pageNumber - 1 + clamped) / totalPages) * 100))
    onProgressRef.current({ kind: 'pdf', page: pageNumber, total: totalPages, offset: clamped }, Math.round(percent * 10) / 10)
  }, [])

  useEffect(() => {
    if (loading) return
    const scroller = scrollRef.current
    if (scroller === null) return
    const observer = new ResizeObserver(() => {
      const width = scroller.clientWidth
      setContainerWidth(width)
      // Never capture geometry before the initial saved position has been
      // applied, or from a transient layout while a render is in flight.
      if (!initialRestoreDone.current || renderingRef.current) return
      const max = Math.max(0, scroller.scrollHeight - scroller.clientHeight)
      if (max > 0) {
        restoreRef.current = scroller.scrollTop / max
        suppressRef.current = true
      }
    })
    observer.observe(scroller)
    return () => observer.disconnect()
  }, [loading])

  useEffect(() => {
    const doc = docRef.current
    if (doc === null || loading) return
    let cancelled = false
    setRendering(true)
    renderingRef.current = true
    onContextRef.current(null)
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
        const textContent = await pdfPage.getTextContent()
        if (cancelled) return
        const text = textContent.items.map((item) => {
          if (!('str' in item)) return ''
          return `${item.str}${item.hasEOL ? '\n' : ''}`
        }).join('')
        pageTextRef.current = text
        textLayerTaskRef.current?.cancel?.()
        textLayerTaskRef.current = null
        const textLayer = textLayerRef.current
        if (textLayer !== null) {
          textLayer.replaceChildren()
          textLayer.style.setProperty('--scale-factor', String(viewport.scale))
          textLayer.style.setProperty('--total-scale-factor', String(viewport.scale))
          try {
            const layer = new pdfjsLib.TextLayer({ textContentSource: textContent, container: textLayer, viewport })
            textLayerTaskRef.current = layer
            await layer.render()
            if (cancelled) return
            textLayerTaskRef.current = null
          } catch {
            // A cancelled text layer rejects its render promise. Do not
            // publish the old page's text or advance progress after cancel.
            if (cancelled) return
          }
        }
        if (cancelled) return
        emitContext(text)
        const scroller = scrollRef.current
        if (scroller !== null) {
          const offset = restoreRef.current
          restoreRef.current = 0
          scroller.scrollTop = offset * Math.max(0, scroller.scrollHeight - scroller.clientHeight)
          suppressRef.current = false
          initialRestoreDone.current = true
          renderingRef.current = false
          report(pageRef.current, offset)
        }
      } catch (cause: unknown) {
        if (cancelled) return
        if ((cause as { name?: string } | null)?.name === 'RenderingCancelledException') return
        setError(messageOf(cause))
        setRendering(false)
        renderingRef.current = false
      }
    })()
    return () => {
      cancelled = true
      renderTaskRef.current?.cancel()
      renderTaskRef.current = null
      textLayerTaskRef.current?.cancel?.()
      textLayerTaskRef.current = null
      renderingRef.current = false
    }
  }, [containerWidth, emitContext, loading, page, report, zoom])

  useEffect(() => {
    const target = jumpTarget
    if (target === null || target === undefined || target.anchor.kind !== 'pdf') return
    const anchor = target.anchor
    if (anchor.page < 1 || anchor.page > totalRef.current) {
      onJumpError?.(t('jumpUnavailable'))
      return
    }
    const scroller = scrollRef.current
    if (anchor.page === pageRef.current) {
      if (scroller !== null) {
        const max = Math.max(0, scroller.scrollHeight - scroller.clientHeight)
        scroller.scrollTop = anchor.offset * max
      }
      return
    }
    goTo(anchor.page, anchor.offset)
    // goTo is stable for the target page; key changes only on an explicit note jump.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jumpTarget?.key, onJumpError, t])

  useEffect(() => { setPageInput(String(page)) }, [page])

  const handleScroll = useCallback(() => {
    if (suppressRef.current) return
    const scroller = scrollRef.current
    if (scroller === null) return
    const max = Math.max(0, scroller.scrollHeight - scroller.clientHeight)
    const ratio = max === 0 ? 0 : scroller.scrollTop / max
    report(pageRef.current, ratio)
  }, [report])

  const goTo = useCallback((next: number, offset = 0) => {
    const target = clampPage(next, Math.max(1, totalRef.current))
    if (target === pageRef.current) return
    restoreRef.current = offset
    suppressRef.current = true
    renderingRef.current = true
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
    renderingRef.current = true
    zoomRef.current = clamped
    setZoom(clamped)
    onWidthChangeRef.current(clamped)
  }, [])

  const forwardWheel = useCallback((event: React.WheelEvent<HTMLButtonElement>) => {
    const scroller = scrollRef.current
    if (scroller === null) return
    scroller.scrollTop += event.deltaY
    scroller.scrollLeft += event.deltaX
    event.preventDefault()
  }, [])

  if (error !== null) {
    return <div className="bs-reader-error" role="alert"><p>{t('readerFailed')}</p><p className="bs-muted">{error}</p></div>
  }
  if (loading) return <div className="bs-empty">{t('readerLoading')}</div>

  return (
    <div className="bs-pdf-reader">
      <div className="bs-pdf-toolbar">
        <button type="button" className="bs-icon-button" onClick={() => goTo(page - 1)}
            onWheel={forwardWheel} disabled={page <= 1} aria-label={t('prevPage')}><ChevronLeftIcon size={16} /></button>
        <form className="bs-page-form" onSubmit={(event) => { event.preventDefault(); const value = Number(pageInput); if (Number.isFinite(value)) goTo(value) }}>
          <input className="bs-page-input" value={pageInput} onChange={(event) => setPageInput(event.target.value)} aria-label={t('page')} inputMode="numeric" />
          <span className="bs-muted">/ {total}</span>
        </form>
        <button type="button" className="bs-icon-button" onClick={() => goTo(page + 1)}
            onWheel={forwardWheel} disabled={page >= total} aria-label={t('nextPage')}><ChevronRightIcon size={16} /></button>
        <button type="button" className={`bs-button ${navOpen ? 'bs-button-primary' : ''}`} onClick={() => setNavOpen((current) => !current)}>{t('contents')}</button>
        <span className="bs-toolbar-spacer" />
        <button type="button" className="bs-button" onClick={() => changeZoom(zoom - 0.1)} aria-label={t('zoomOut')}>−</button>
        <span className="bs-zoom-label">{Math.round(zoom * 100)}%</span>
        <button type="button" className="bs-button" onClick={() => changeZoom(zoom + 0.1)} aria-label={t('zoomIn')}>+</button>
        <button type="button" className="bs-button" onClick={() => changeZoom(1)}>{t('resetZoom')}</button>
        <button type="button" className="bs-button" onClick={captureRegion}>{t('captureRegion')}</button>
        {rendering && <span className="bs-muted">{t('loading')}</span>}
      </div>
      <div className="bs-pdf-layout">
        {navOpen && <aside className="bs-pdf-nav" aria-label={t('contents')}>
          {outline !== null ? <OutlineTree entries={outline} current={page} onOpen={goTo} /> : <div className="bs-pdf-thumbs">{Array.from({ length: total }, (_, index) => index + 1).map((number) => <PdfThumbnail key={number} doc={docRef.current as PDFDocumentProxy} page={number} current={number === page} onOpen={goTo} label={t('page')} />)}</div>}
        </aside>}
        <div className="bs-pdf-viewport">
        <div ref={scrollRef} className="bs-pdf-scroll" onScroll={handleScroll}>
          <div className="bs-pdf-canvas-wrap">
            <canvas ref={canvasRef} className="bs-pdf-canvas" />
            <div ref={textLayerRef} className="bs-pdf-text-layer" onMouseUp={handleSelection} />
          </div>
        </div>
        {total > 0 && (
          <button
            type="button"
            className="bs-pdf-turn bs-pdf-turn-left"
            onClick={() => goTo(page - 1)}
            onWheel={forwardWheel}
            disabled={page <= 1}
            aria-label={t('prevPage')}
          ><ChevronLeftIcon size={22} /></button>
        )}
        {total > 0 && (
          <button
            type="button"
            className="bs-pdf-turn bs-pdf-turn-right"
            onClick={() => goTo(page + 1)}
            onWheel={forwardWheel}
            disabled={page >= total}
            aria-label={t('nextPage')}
          ><ChevronRightIcon size={22} /></button>
        )}
      </div>
      </div>
      {capture !== null && (
        <div className="bs-capture-overlay" role="dialog" aria-label={t('capturePreview')}>
          <div className="bs-capture-card">
            <strong>{t('capturePreview')}</strong>
            <img src={capture.dataUrl} alt={t('capturePreview')} />
            <div className="bs-actions">
              <button type="button" className="bs-button" onClick={() => setCapture(null)}>{t('discardScreenshot')}</button>
              <button type="button" className="bs-button bs-button-primary" onClick={() => { onScreenshot(capture); setCapture(null) }}>{t('useScreenshot')}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
