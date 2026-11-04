import { useEffect, useState } from 'react'
import type { NoteBookSummary } from '../shared/types.ts'
import type { BookshelfApi } from './api.ts'
import type { Translate } from './i18n.ts'
import { TrashIcon } from './icons.tsx'

interface NotesManagerProps {
  readonly api: BookshelfApi
  readonly t: Translate
  readonly onClose: () => void
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Shelf-level data manager for notes retained after a book leaves the shelf. */
export function NotesManager({ api, t, onClose }: NotesManagerProps) {
  const [books, setBooks] = useState<NoteBookSummary[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [confirmId, setConfirmId] = useState<string | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const value = await api.listNoteBooks()
        if (!cancelled) setBooks(value)
      } catch (cause: unknown) {
        if (!cancelled) setError(messageOf(cause))
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => { cancelled = true }
  }, [api])

  const remove = async (book: NoteBookSummary) => {
    setBusyId(book.bookId)
    setError(null)
    try {
      await api.deleteNoteBook(book.bookId)
      setBooks((current) => current.filter((entry) => entry.bookId !== book.bookId))
      setConfirmId(null)
    } catch (cause: unknown) {
      setError(messageOf(cause))
    } finally {
      setBusyId(null)
    }
  }

  return (
    <div className="bs-modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && busyId === null) onClose() }}>
      <section className="bs-modal bs-notes-manager" role="dialog" aria-modal="true" aria-label={t('notesData')}>
        <header className="bs-modal-header">
          <div>
            <h2>{t('notesData')}</h2>
            <p>{t('notesDataHint')}</p>
          </div>
          <button type="button" className="bs-icon-button" onClick={onClose} aria-label={t('close')}>×</button>
        </header>
        {error !== null && <div className="bs-inline-error" role="alert">{error}</div>}
        <div className="bs-note-data-list">
          {loading && <div className="bs-empty">{t('loading')}</div>}
          {!loading && books.length === 0 && <div className="bs-empty">{t('noNotesData')}</div>}
          {!loading && books.map((book) => (
            <div key={book.bookId} className="bs-note-data-row">
              <div className="bs-note-data-text">
                <strong>{book.bookTitle}</strong>
                <span>{book.bookPath}</span>
                <small>{t('noteCount', { count: book.noteCount })}</small>
              </div>
              {confirmId === book.bookId
                ? (
                  <div className="bs-existing-actions">
                    <button type="button" className="bs-button bs-button-danger" onClick={() => { void remove(book) }} disabled={busyId !== null}>{t('confirmDeleteNoteBook')}</button>
                    <button type="button" className="bs-button" onClick={() => setConfirmId(null)} disabled={busyId !== null}>{t('cancel')}</button>
                  </div>
                )
                : <button type="button" className="bs-button" onClick={() => setConfirmId(book.bookId)} disabled={busyId !== null}><TrashIcon size={14} /> {t('deleteNotesData')}</button>}
            </div>
          ))}
        </div>
        <footer className="bs-modal-footer">
          <span className="bs-selection">{t('notesDataFooter')}</span>
          <div className="bs-actions"><button type="button" className="bs-button" onClick={onClose}>{t('close')}</button></div>
        </footer>
      </section>
    </div>
  )
}
