import { useEffect, useRef, useState } from 'react'
import type { PDFDocumentProxy } from 'pdfjs-dist'
import type { BookView } from '../shared/types.ts'
import { coverUrl, fileUrl, pdfjsAssetUrl } from './api.ts'
import { FileIcon } from './icons.tsx'
import { ensurePdfWorker, pdfjsLib } from './pdf.ts'

const PDF_COVER_WIDTH = 160
const MAX_PDF_COVER_LOAD_BYTES = 6 * 1024 * 1024
const MAX_FULL_COVER_FALLBACK = 5 * 1024 * 1024
const MAX_CONCURRENT_PDF_COVERS = 2
const pdfCoverCache = new Map<string, string>()

let activePdfLoads = 0
const waitingPdfLoads: Array<() => void> = []

function acquirePdfSlot(): Promise<void> {
  if (activePdfLoads < MAX_CONCURRENT_PDF_COVERS) {
    activePdfLoads += 1
    return Promise.resolve()
  }
  return new Promise((resolve) => {
    waitingPdfLoads.push(() => {
      activePdfLoads += 1
      resolve()
    })
  })
}

function releasePdfSlot(): void {
  activePdfLoads = Math.max(0, activePdfLoads - 1)
  const next = waitingPdfLoads.shift()
  if (next !== undefined) next()
}

type RemoteCover = 'checking' | 'available' | 'missing'

interface BookCoverProps {
  readonly book: BookView
}

/** Shelf thumbnail: embedded/sidecar cover first; PDF first page as the fallback. */
export function BookCover({ book }: BookCoverProps) {
  const cacheKey = `${book.id}:${book.size}`
  const hostRef = useRef<HTMLSpanElement>(null)
  const [remote, setRemote] = useState<RemoteCover>('checking')
  const [pdfSrc, setPdfSrc] = useState<string | null>(() => pdfCoverCache.get(cacheKey) ?? null)
  const [pdfFailed, setPdfFailed] = useState(false)
  const [observed, setObserved] = useState(false)
  const isPdf = book.format === 'pdf'

  async function renderFirstPage(pdf: PDFDocumentProxy): Promise<string> {
    const page = await pdf.getPage(1)
    const initial = page.getViewport({ scale: 1 })
    const viewport = page.getViewport({ scale: Math.max(0.1, PDF_COVER_WIDTH / initial.width) })
    const canvas = document.createElement('canvas')
    canvas.width = Math.max(1, Math.round(viewport.width))
    canvas.height = Math.max(1, Math.round(viewport.height))
    await page.render({ canvas, viewport }).promise
    return canvas.toDataURL('image/jpeg', 0.82)
  }

  useEffect(() => {
    const element = hostRef.current
    if (element === null) return
    if (typeof IntersectionObserver === 'undefined') {
      setObserved(true)
      return
    }
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) {
        setObserved(true)
        observer.disconnect()
      }
    }, { rootMargin: '160px' })
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    if (!observed) return
    if (book.availability !== 'ok') {
      setRemote('missing')
      return
    }
    let cancelled = false
    setRemote('checking')
    setPdfFailed(false)
    void fetch(coverUrl(book.id), { method: 'HEAD', credentials: 'same-origin', cache: 'no-store' })
      .then((response) => {
        if (!cancelled) setRemote(response.status === 200 ? 'available' : 'missing')
      })
      .catch(() => {
        if (!cancelled) setRemote('missing')
      })
    return () => { cancelled = true }
  }, [book.availability, book.id, observed])

  useEffect(() => {
    if (!isPdf || book.availability !== 'ok' || remote !== 'missing' || pdfSrc !== null || pdfFailed || !observed) return
    let cancelled = false
    let pdf: PDFDocumentProxy | null = null
    let loadingTask: ReturnType<typeof pdfjsLib.getDocument> | null = null
    let aborted = false
    void (async () => {
      await acquirePdfSlot()
      try {
        if (cancelled) return
        ensurePdfWorker()
        try {
          const task = pdfjsLib.getDocument({
            url: new URL(fileUrl(book.id), window.location.href).href,
            rangeChunkSize: 64 * 1024,
            disableAutoFetch: true,
            disableStream: true,
            cMapUrl: pdfjsAssetUrl('cmap'),
            cMapPacked: true,
            standardFontDataUrl: pdfjsAssetUrl('font'),
            wasmUrl: pdfjsAssetUrl('wasm'),
            disableFontFace: true,
            useWorkerFetch: false,
            verbosity: 0,
          })
          loadingTask = task
          task.onProgress = (progress: { loaded: number }) => {
            const loaded = progress.loaded
            if (loaded > MAX_PDF_COVER_LOAD_BYTES && !aborted) {
              aborted = true
              void task.destroy().catch(() => {})
              if (!cancelled) setPdfFailed(true)
            }
          }
          pdf = await task.promise
        } catch (rangeError: unknown) {
          if (cancelled || aborted || book.size > MAX_FULL_COVER_FALLBACK) throw rangeError
          // Some PDFs cannot be opened through range requests. Only small files
          // get a one-time full read so a cover attempt cannot download a huge book.
          const response = await fetch(fileUrl(book.id), { credentials: 'same-origin', cache: 'no-store' })
          if (!response.ok) throw rangeError
          const bytes = await response.arrayBuffer()
          if (cancelled) return
          pdf = await pdfjsLib.getDocument({
            data: new Uint8Array(bytes),
            cMapUrl: pdfjsAssetUrl('cmap'),
            cMapPacked: true,
            standardFontDataUrl: pdfjsAssetUrl('font'),
            wasmUrl: pdfjsAssetUrl('wasm'),
            disableFontFace: true,
            useWorkerFetch: false,
            verbosity: 0,
          }).promise
        }
        if (cancelled || aborted) return
        const url = await renderFirstPage(pdf)
        if (cancelled || aborted) return
        pdfCoverCache.set(cacheKey, url)
        setPdfSrc(url)
      } catch {
        if (!cancelled && !aborted) setPdfFailed(true)
      } finally {
        loadingTask = null
        const current = pdf
        pdf = null
        if (current !== null) void current.destroy().catch(() => {})
        releasePdfSlot()
      }
    })()
    return () => {
      cancelled = true
      void loadingTask?.destroy().catch(() => {})
      if (pdf !== null) void pdf.destroy().catch(() => {})
    }
  }, [book.availability, book.id, book.size, cacheKey, isPdf, observed, pdfFailed, pdfSrc, remote])

  const showRemote = remote === 'available'
  const showPdf = isPdf && remote === 'missing' && pdfSrc !== null && !pdfFailed
  const displaySrc = showRemote ? coverUrl(book.id) : showPdf ? pdfSrc : null
  const formatLabel = book.format === 'markdown' ? 'MD' : book.format.toUpperCase()

  return (
    <span ref={hostRef} className={`bs-cover bs-cover-${book.format} ${displaySrc === null ? '' : 'has-image'}`}>
      {displaySrc === null
        ? <><FileIcon size={32} /><span>{formatLabel}</span></>
        : (
          <img
            src={displaySrc}
            alt=""
            loading="lazy"
            draggable={false}
            onError={() => {
              if (showRemote) setRemote('missing')
              else setPdfFailed(true)
            }}
          />
        )}
    </span>
  )
}
