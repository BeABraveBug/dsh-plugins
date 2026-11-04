import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { MutableRefObject } from 'react'
import type { BookNote, BookView } from '../shared/types.ts'
import type { BookshelfApi } from './api.ts'
import type { Translate } from './i18n.ts'
import { CheckIcon, PlusIcon, TrashIcon } from './icons.tsx'
import { renderMarkdown } from './markdown.ts'

type SaveState = 'idle' | 'saving' | 'saved' | 'error'
type SidebarTab = 'notes' | 'qa'

interface NoteSidebarProps {
  readonly book: BookView
  readonly api: BookshelfApi
  readonly t: Translate
  readonly onClose: () => void
  readonly flushRef?: MutableRefObject<(() => Promise<boolean>) | null>
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function noteDate(timestamp: number): string {
  return new Intl.DateTimeFormat(undefined, { month: '2-digit', day: '2-digit' }).format(new Date(timestamp))
}

/** Side panel for per-book Markdown notes. AI Q&A is added in a later phase. */
export function NoteSidebar({ book, api, t, onClose, flushRef }: NoteSidebarProps) {
  const [tab, setTab] = useState<SidebarTab>('notes')
  const [notes, setNotes] = useState<BookNote[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [title, setTitle] = useState('')
  const [markdown, setMarkdown] = useState('')
  const [preview, setPreview] = useState(false)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [saveState, setSaveState] = useState<SaveState>('idle')
  const [confirmDelete, setConfirmDelete] = useState(false)
  const dirty = useRef(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const selectedRef = useRef<BookNote | null>(null)
  const titleRef = useRef('')
  const markdownRef = useRef('')
  titleRef.current = title
  markdownRef.current = markdown
  selectedRef.current = notes.find((note) => note.id === selectedId) ?? null

  const persist = useCallback(async (noteId: string): Promise<BookNote | null> => {
    if (!dirty.current) return selectedRef.current
    setSaveState('saving')
    setError(null)
    try {
      const saved = await api.saveNote({
        bookId: book.id,
        bookPath: book.path,
        bookTitle: book.title,
        bookFormat: book.format,
        noteId,
        title: titleRef.current,
        markdown: markdownRef.current,
        anchor: selectedRef.current?.anchor ?? book.progress.position,
      })
      setNotes((current) => current.map((note) => note.id === saved.id ? saved : note))
      dirty.current = false
      setSaveState('saved')
      return saved
    } catch (cause: unknown) {
      setSaveState('error')
      setError(messageOf(cause))
      return null
    }
  }, [api, book])

  const flush = useCallback(async (): Promise<boolean> => {
    if (timer.current !== null) {
      clearTimeout(timer.current)
      timer.current = null
    }
    if (selectedId === null) return true
    const saved = await persist(selectedId)
    return saved !== null
  }, [persist, selectedId])

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    void (async () => {
      try {
        const value = await api.listNotes(book.id)
        if (cancelled) return
        setNotes(value.notes)
        const initial = value.notes.find((note) => note.id === value.lastEditedNoteId) ?? value.notes[0] ?? null
        setSelectedId(initial?.id ?? null)
        setTitle(initial?.title ?? '')
        setMarkdown(initial?.markdown ?? '')
        dirty.current = false
        setLoading(false)
      } catch (cause: unknown) {
        if (!cancelled) {
          setError(messageOf(cause))
          setLoading(false)
        }
      }
    })()
    return () => { cancelled = true }
  }, [api, book.id])

  useEffect(() => {
    if (!dirty.current || selectedId === null) return
    if (timer.current !== null) clearTimeout(timer.current)
    timer.current = setTimeout(() => { void persist(selectedId) }, 700)
    return () => {
      if (timer.current !== null) clearTimeout(timer.current)
    }
  }, [markdown, persist, selectedId, title])

  useEffect(() => () => {
    if (timer.current !== null) clearTimeout(timer.current)
    if (dirty.current && selectedId !== null) void persist(selectedId)
  }, [persist, selectedId])

  const selectNote = async (note: BookNote) => {
    if (note.id === selectedId || busy) return
    if (!(await flush())) return
    setSelectedId(note.id)
    setTitle(note.title)
    setMarkdown(note.markdown)
    setPreview(false)
    setConfirmDelete(false)
    setSaveState('idle')
    setError(null)
    dirty.current = false
  }

  const createNote = async () => {
    if (busy || !(await flush())) return
    setBusy(true)
    setError(null)
    try {
      const saved = await api.saveNote({
        bookId: book.id,
        bookPath: book.path,
        bookTitle: book.title,
        bookFormat: book.format,
        title: t('untitledNote'),
        markdown: '',
        anchor: book.progress.position,
      })
      setNotes((current) => [...current, saved])
      setSelectedId(saved.id)
      setTitle(saved.title)
      setMarkdown(saved.markdown)
      setPreview(false)
      setSaveState('saved')
      dirty.current = false
    } catch (cause: unknown) {
      setError(messageOf(cause))
    } finally {
      setBusy(false)
    }
  }

  const removeNote = async () => {
    if (selectedId === null || busy) return
    setBusy(true)
    try {
      await api.deleteNote(book.id, selectedId)
      const remaining = notes.filter((note) => note.id !== selectedId)
      setNotes(remaining)
      const next = remaining[0] ?? null
      setSelectedId(next?.id ?? null)
      setTitle(next?.title ?? '')
      setMarkdown(next?.markdown ?? '')
      setPreview(false)
      setSaveState('idle')
      setConfirmDelete(false)
      dirty.current = false
    } catch (cause: unknown) {
      setError(messageOf(cause))
    } finally {
      setBusy(false)
    }
  }

  const changed = () => {
    dirty.current = true
    setSaveState('idle')
  }

  useEffect(() => {
    if (flushRef !== undefined) flushRef.current = flush
    return () => { if (flushRef !== undefined) flushRef.current = null }
  }, [flush, flushRef])

  const previewHtml = useMemo(() => preview ? renderMarkdown(markdown) : '', [markdown, preview])
  const selected = selectedRef.current

  return (
    <aside className="bs-note-sidebar" aria-label={t('notes')}>
      <header className="bs-note-header">
        <div className="bs-note-tabs" role="tablist">
          <button type="button" role="tab" aria-selected={tab === 'notes'} className={`bs-note-tab ${tab === 'notes' ? 'is-active' : ''}`} onClick={() => setTab('notes')}>{t('notes')}</button>
          <button type="button" role="tab" aria-selected={tab === 'qa'} className={`bs-note-tab ${tab === 'qa' ? 'is-active' : ''}`} onClick={() => setTab('qa')}>{t('qa')}</button>
        </div>
        <button type="button" className="bs-icon-button" onClick={() => { void flush().then((saved) => { if (saved) onClose() }) }} aria-label={t('close')}>×</button>
      </header>

      {tab === 'qa' && <div className="bs-note-placeholder"><p>{t('qaComingSoon')}</p></div>}

      {tab === 'notes' && (
        <div className="bs-note-body">
          <div className="bs-note-toolbar">
            <button type="button" className="bs-button bs-button-primary" onClick={() => { void createNote() }} disabled={busy || loading}><PlusIcon size={14} /> {t('newNote')}</button>
            {selected !== null && (
              <>
                <button type="button" className="bs-button" onClick={() => setPreview((current) => !current)} disabled={busy}>{preview ? t('editNote') : t('previewNote')}</button>
                <button type="button" className={`bs-button ${confirmDelete ? 'bs-button-danger' : ''}`} onClick={() => { if (confirmDelete) { void removeNote() } else setConfirmDelete(true) }} disabled={busy}>
                  <TrashIcon size={14} /> {confirmDelete ? t('confirmDeleteNote') : t('deleteNote')}
                </button>
              </>
            )}
            {saveState === 'error' && <button type="button" className="bs-button" onClick={() => { void flush() }}>{t('saveRetry')}</button>}
            <span className={`bs-note-save bs-note-save-${saveState}`}>
              {saveState === 'saving' ? t('saveSaving') : saveState === 'saved' ? t('saveSaved') : saveState === 'error' ? t('saveFailed') : ''}
            </span>
          </div>
          {error !== null && <div className="bs-inline-error" role="alert">{error}</div>}
          {loading && <div className="bs-empty">{t('loading')}</div>}
          {!loading && notes.length === 0 && <div className="bs-empty">{t('noNotes')}</div>}
          {!loading && notes.length > 0 && (
            <>
              <div className="bs-note-list">
                {notes.map((note) => (
                  <button key={note.id} type="button" className={`bs-note-list-item ${note.id === selectedId ? 'is-active' : ''}`} onClick={() => { void selectNote(note) }} disabled={busy}>
                    <span className="bs-note-list-title">{note.title || t('untitledNote')}</span>
                    <span className="bs-note-list-date">{noteDate(note.updatedAt)}</span>
                  </button>
                ))}
              </div>
              {selected !== null && (
                <div className="bs-note-editor">
                  <input className="bs-note-title-input" value={title} onChange={(event) => { setTitle(event.target.value); changed() }} placeholder={t('noteTitle')} aria-label={t('noteTitle')} />
                  {preview
                    ? <div className="bs-note-preview bs-markdown" dangerouslySetInnerHTML={{ __html: previewHtml }} />
                    : <textarea className="bs-note-textarea" value={markdown} onChange={(event) => { setMarkdown(event.target.value); changed() }} placeholder={t('notePlaceholder')} aria-label={t('notePlaceholder')} />}
                </div>
              )}
            </>
          )}
        </div>
      )}
    </aside>
  )
}
