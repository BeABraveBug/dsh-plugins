import { Component, useCallback, useEffect, useRef, useState } from 'react'
import type { ErrorInfo, ReactNode } from 'react'
import type { BookRecord, BookView, PdfPosition, ReaderScreenshot, ReaderTextContext, ReadingPosition } from '../shared/types.ts'
import type { BookshelfApi } from './api.ts'
import type { Translate } from './i18n.ts'
import { ArrowLeftIcon, CheckIcon } from './icons.tsx'
import { PdfReader } from './PdfReader.tsx'
import { EpubReader } from './EpubReader.tsx'
import { TextReader } from './TextReader.tsx'
import { NoteSidebar } from './NoteSidebar.tsx'

type SaveState = 'idle' | 'saving' | 'saved' | 'error'

interface ReaderProps {
  readonly book: BookView
  readonly api: BookshelfApi
  readonly t: Translate
  readonly onClose: () => void
  readonly onSaved: (record: BookRecord) => void
  readonly onSetRead: (id: string, markedRead: boolean) => Promise<void>
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function useProgressSaver(bookId: string, api: BookshelfApi, onSaved: (record: BookRecord) => void) {
  const [state, setState] = useState<SaveState>('idle')
  const [error, setError] = useState<string | null>(null)
  const pending = useRef<{ position: ReadingPosition; percent: number } | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const chain = useRef<Promise<boolean>>(Promise.resolve(true))
  const apiRef = useRef(api)
  const onSavedRef = useRef(onSaved)
  apiRef.current = api
  onSavedRef.current = onSaved

  const flush = useCallback(async (): Promise<boolean> => {
    if (timer.current !== null) {
      clearTimeout(timer.current)
      timer.current = null
    }
    const run = async (): Promise<boolean> => {
      const next = pending.current
      if (next === null) return true
      pending.current = null
      setState('saving')
      setError(null)
      try {
        const record = await apiRef.current.saveProgress(bookId, next.position, next.percent)
        onSavedRef.current(record)
        setState('saved')
        return true
      } catch (cause: unknown) {
        // Keep a newer position reported while this request was in flight;
        // restoring the failed position unconditionally would overwrite it.
        if (pending.current === null) pending.current = next
        setState('error')
        setError(messageOf(cause))
        return false
      }
    }
    chain.current = chain.current.then(run, run)
    return chain.current
  }, [bookId])

  const report = useCallback((position: ReadingPosition, percent: number) => {
    pending.current = { position, percent }
    if (timer.current !== null) clearTimeout(timer.current)
    timer.current = setTimeout(() => { void flush() }, 700)
  }, [flush])

  useEffect(() => {
    const onVisibility = () => { if (document.visibilityState === 'hidden') void flush() }
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      document.removeEventListener('visibilitychange', onVisibility)
      if (timer.current !== null) clearTimeout(timer.current)
      void flush()
    }
  }, [flush])

  return { state, error, report, flush }
}

class ReaderBoundary extends Component<{ fallback: ReactNode; children: ReactNode }, { failed: boolean }> {
  state = { failed: false }

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true }
  }

  componentDidCatch(error: unknown, info: ErrorInfo): void {
    console.error('[bookshelf] reader crashed', error, info)
  }

  render(): ReactNode {
    return this.state.failed ? this.props.fallback : this.props.children
  }
}

function progressText(book: BookView, t: Translate): string {
  const position = book.progress.position
  if (position === null) return t('notStarted')
  if (position.kind === 'pdf') return t('pdfProgress', { page: position.page, total: position.total })
  if (position.kind === 'epub' || position.kind === 'scroll') {
    return t('percentProgress', { percent: Math.round(book.progress.percent ?? 0) })
  }
  return t('notStarted')
}

export function Reader({ book, api, t, onClose, onSaved, onSetRead }: ReaderProps) {
  const saver = useProgressSaver(book.id, api, onSaved)
  const [readBusy, setReadBusy] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)
  const [notesOpen, setNotesOpen] = useState(true)
  const [notesWidth, setNotesWidth] = useState(360)
  const noteFlushRef = useRef<(() => Promise<boolean>) | null>(null)
  const readerRef = useRef<HTMLDivElement>(null)
  const [fullscreen, setFullscreen] = useState(false)
  const [readerContext, setReaderContext] = useState<ReaderTextContext | null>(null)
  const [screenshot, setScreenshot] = useState<ReaderScreenshot | null>(null)

  useEffect(() => {
    const onChange = () => setFullscreen(document.fullscreenElement === readerRef.current)
    document.addEventListener('fullscreenchange', onChange)
    return () => document.removeEventListener('fullscreenchange', onChange)
  }, [])

  const toggleFullscreen = useCallback(async () => {
    try {
      if (document.fullscreenElement === readerRef.current) await document.exitFullscreen()
      else await readerRef.current?.requestFullscreen()
    } catch (cause: unknown) {
      setActionError(messageOf(cause))
    }
  }, [])

  const close = useCallback(async () => {
    const saved = await saver.flush()
    const notesSaved = noteFlushRef.current === null ? true : await noteFlushRef.current()
    if (saved && notesSaved) onClose()
  }, [onClose, saver])

  const toggleRead = async () => {
    if (readBusy) return
    setReadBusy(true)
    setActionError(null)
    try {
      await onSetRead(book.id, !book.markedRead)
    } catch (cause: unknown) {
      setActionError(messageOf(cause))
    } finally {
      setReadBusy(false)
    }
  }

  const toggleNotes = useCallback(async () => {
    if (notesOpen && noteFlushRef.current !== null) {
      const saved = await noteFlushRef.current()
      if (!saved) return
    }
    setNotesOpen((current) => !current)
  }, [notesOpen])

  const startResize = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    event.preventDefault()
    const startX = event.clientX
    const startWidth = notesWidth
    const move = (moveEvent: PointerEvent) => {
      setNotesWidth(Math.min(640, Math.max(280, startWidth + startX - moveEvent.clientX)))
    }
    const up = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }, [notesWidth])

  const onProgress = useCallback((position: ReadingPosition, percent: number) => {
    saver.report(position, percent)
  }, [saver])

  const onWidthChange = useCallback(async (width: number) => {
    try {
      const record = await api.saveReaderWidth(book.id, width)
      onSaved(record)
    } catch (cause: unknown) {
      setActionError(messageOf(cause))
    }
  }, [api, book.id, onSaved])

  const fallback = (
    <div className="bs-reader-error" role="alert">
      <p>{t('readerFailed')}</p>
      <p className="bs-muted">{t('unknownError')}</p>
      <button type="button" className="bs-button" onClick={() => { void close() }}>{t('back')}</button>
    </div>
  )

  return (
    <div ref={readerRef} className="bs-reader">
      <header className="bs-reader-header">
        <button type="button" className="bs-button bs-back-button" onClick={() => { void close() }}>
          <ArrowLeftIcon size={16} /> {t('back')}
        </button>
        <div className="bs-reader-title">
          <h2 title={book.path}>{book.title}</h2>
          <span className="bs-muted">{progressText(book, t)} · {book.format.toUpperCase()}</span>
        </div>
        <div className="bs-reader-actions">
          <span className={`bs-save-state bs-save-${saver.state}`} title={saver.error ?? undefined}>
            {saver.state === 'saving' ? t('saveSaving')
              : saver.state === 'saved' ? t('saveSaved')
                : saver.state === 'error' ? t('saveFailed')
                  : ''}
          </span>
          {saver.state === 'error' && <button type="button" className="bs-button" onClick={() => { void saver.flush() }}>{t('saveRetry')}</button>}
          <button type="button" className="bs-button" onClick={() => { void toggleFullscreen() }}>{fullscreen ? t('exitFullscreen') : t('enterFullscreen')}</button>
          <button type="button" className={`bs-button ${notesOpen ? 'bs-button-primary' : ''}`} onClick={() => { void toggleNotes() }}>
            {t('notes')}
          </button>
          <button type="button" className={`bs-button ${book.markedRead ? 'bs-button-primary' : ''}`} onClick={() => { void toggleRead() }} disabled={readBusy}>
            {book.markedRead ? <><CheckIcon size={14} /> {t('unmarkRead')}</> : t('markRead')}
          </button>
        </div>
      </header>
      {actionError !== null && <div className="bs-inline-error" role="alert">{actionError}</div>}
      <div className="bs-reader-body">
        <div className="bs-reader-main">
          <ReaderBoundary key={book.id} fallback={fallback}>
            {book.format === 'pdf' && (
              <PdfReader
                book={book}
                initialPosition={book.progress.position?.kind === 'pdf' ? book.progress.position : null}
                initialWidth={book.readerWidth}
                onWidthChange={onWidthChange}
                fetchBytes={api.fileBytes}
                onProgress={onProgress}
                onContext={setReaderContext}
                onScreenshot={setScreenshot}
                t={t}
              />
            )}
            {book.format === 'epub' && (
              <EpubReader
                book={book}
                initialPosition={book.progress.position?.kind === 'epub' ? book.progress.position : null}
                fetchBytes={api.fileBytes}
                onProgress={onProgress}
                onContext={setReaderContext}
                t={t}
              />
            )}
            {(book.format === 'txt' || book.format === 'markdown') && (
              <TextReader
                book={book}
                initialPosition={book.progress.position?.kind === 'scroll' ? book.progress.position : null}
                fetchText={api.fileText}
                onProgress={onProgress}
                onContext={setReaderContext}
                t={t}
              />
            )}
          </ReaderBoundary>
        </div>
        {notesOpen && (
          <>
            <div className="bs-note-resizer" onPointerDown={startResize} role="separator" aria-orientation="vertical" aria-label={t('resizeNotes')} />
            <div className="bs-note-pane" style={{ width: notesWidth }}>
              <NoteSidebar book={book} api={api} t={t} context={readerContext} screenshot={screenshot} onClearScreenshot={() => setScreenshot(null)}
                onClearContext={() => setReaderContext(null)} onClose={() => setNotesOpen(false)} flushRef={noteFlushRef} />
            </div>
          </>
        )}
      </div>
    </div>
  )
}

/** Exported only for the reader's type-level use in tests. */
export type ReaderPdfPosition = PdfPosition
