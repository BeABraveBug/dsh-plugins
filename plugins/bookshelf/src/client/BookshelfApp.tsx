import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { AddResult, BookRecord, BookView } from '../shared/types.ts'
import { BookshelfApiError, type BookshelfApi } from './api.ts'
import type { Translate } from './i18n.ts'
import { AddDialog, type AddMode } from './AddDialog.tsx'
import { NotesManager } from './NotesManager.tsx'
import { Reader } from './Reader.tsx'
import { BookCover } from './BookCover.tsx'
import { BookOpenIcon, BookshelfIcon, CheckIcon, PlusIcon, SearchIcon, TrashIcon, WarningIcon } from './icons.tsx'

interface BookshelfAppProps {
  readonly t: Translate
  readonly api: BookshelfApi
  readonly initialBookId?: string
}

const SHELF_PAGE_SIZE = 12

interface Toast {
  readonly key: number
  readonly kind: 'info' | 'error'
  readonly text: string
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function progressText(book: BookView, t: Translate): string {
  if (book.progress.position === null) return t('notStarted')
  if (book.progress.position.kind === 'pdf') {
    return t('pdfProgress', { page: book.progress.position.page, total: book.progress.position.total })
  }
  return t('percentProgress', { percent: Math.round(book.progress.percent ?? 0) })
}

function sizeText(size: number): string {
  if (size < 1024) return `${size} B`
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`
  return `${(size / (1024 * 1024)).toFixed(1)} MB`
}

function dateText(timestamp: number): string {
  return new Intl.DateTimeFormat(undefined, { year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(timestamp))
}

function mergeBook(books: readonly BookView[], record: BookRecord): BookView[] {
  return books.map((book) => book.id === record.id
    ? { ...book, ...record, availability: book.availability, availabilityDetail: book.availabilityDetail }
    : book)
}

function sortBooks(books: readonly BookView[]): BookView[] {
  return books.slice().sort((left, right) => {
    const recent = (right.lastOpenedAt ?? 0) - (left.lastOpenedAt ?? 0)
    if (recent !== 0) return recent
    const added = right.addedAt - left.addedAt
    if (added !== 0) return added
    return left.title.localeCompare(right.title)
  })
}

export function BookshelfApp({ t, api, initialBookId }: BookshelfAppProps) {
  const [books, setBooks] = useState<BookView[]>([])
  const [libraryPath, setLibraryPath] = useState<string>('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const [pageIndex, setPageIndex] = useState(0)
  const [addMode, setAddMode] = useState<AddMode | null>(null)
  const [notesOpen, setNotesOpen] = useState(false)
  const [readerId, setReaderId] = useState<string | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [confirmRemove, setConfirmRemove] = useState<BookView | null>(null)
  const [dismissed, setDismissed] = useState<ReadonlySet<string>>(new Set())
  const [toast, setToast] = useState<Toast | null>(null)
  const toastKey = useRef(0)
  const listRequest = useRef(0)
  const contentRef = useRef<HTMLDivElement>(null)
  const initialBookHandled = useRef(false)

  const notify = useCallback((kind: 'info' | 'error', text: string) => {
    toastKey.current += 1
    setToast({ key: toastKey.current, kind, text })
  }, [])

  const refresh = useCallback(async (clearDismissed = false) => {
    const request = ++listRequest.current
    if (clearDismissed) setDismissed(new Set())
    setLoading(true)
    try {
      const value = await api.list()
      if (request !== listRequest.current) return
      setBooks(value.books)
      setLibraryPath(value.libraryPath)
      setError(null)
    } catch (cause: unknown) {
      if (request !== listRequest.current) return
      setError(messageOf(cause))
    } finally {
      if (request === listRequest.current) setLoading(false)
    }
  }, [api])

  useEffect(() => { void refresh(true) }, [refresh])
  useEffect(() => {
    if (initialBookId === undefined || initialBookHandled.current || books.length === 0) return
    initialBookHandled.current = true
    if (books.some((book) => book.id === initialBookId)) setReaderId(initialBookId)
    else notify('error', t('initialBookMissing'))
  }, [books, initialBookId, notify, t])
  useEffect(() => {
    const onOnline = () => { void refresh(false) }
    window.addEventListener('online', onOnline)
    return () => window.removeEventListener('online', onOnline)
  }, [refresh])
  useEffect(() => {
    if (toast === null) return
    const timer = setTimeout(() => { setToast((current) => current?.key === toast.key ? null : current) }, 4500)
    return () => clearTimeout(timer)
  }, [toast])

  const addResultToast = useCallback((result: AddResult) => {
    const parts: string[] = []
    if (result.added.length > 0) parts.push(t('addedCount', { count: result.added.length }))
    if (result.skipped.length > 0) parts.push(t('skippedCount', { count: result.skipped.length }))
    if (result.invalid.length > 0) parts.push(t('invalidCount', { count: result.invalid.length }))
    if (parts.length > 0) notify(result.added.length === 0 && result.invalid.length > 0 ? 'error' : 'info', parts.join('; '))
  }, [notify, t])

  const handleAddPaths = useCallback(async (paths: readonly string[]): Promise<AddResult> => {
    try {
      const result = await api.addPaths(paths)
      addResultToast(result)
      await refresh(false)
      if (result.added.length === 0 && result.invalid.length > 0) {
        throw new Error(result.invalid[0]?.message ?? t('addFailed'))
      }
      return result
    } catch (cause: unknown) {
      notify('error', messageOf(cause))
      throw cause
    }
  }, [addResultToast, api, notify, refresh, t])

  const handleAddDirectory = useCallback(async (path: string): Promise<AddResult> => {
    try {
      const result = await api.addDirectory(path)
      addResultToast(result)
      await refresh(false)
      if (result.added.length === 0 && result.invalid.length === 0 && result.skipped.length === 0) {
        throw new Error(t('folderEmpty'))
      }
      if (result.added.length === 0 && result.invalid.length > 0) {
        throw new Error(result.invalid[0]?.message ?? t('folderEmpty'))
      }
      return result
    } catch (cause: unknown) {
      notify('error', messageOf(cause))
      throw cause
    }
  }, [addResultToast, api, notify, refresh, t])

  const openBook = useCallback(async (book: BookView) => {
    listRequest.current += 1
    if (book.availability !== 'ok') {
      notify('error', book.availability === 'missing' ? t('fileMissing') : t('fileInaccessible'))
      return
    }
    setBusyId(book.id)
    try {
      const record = await api.open(book.id)
      setBooks((current) => sortBooks(mergeBook(current, record)))
      setReaderId(book.id)
    } catch (cause: unknown) {
      notify('error', messageOf(cause))
      if (cause instanceof BookshelfApiError && cause.code === 'bookshelf/store-write-failed') {
        // Reading must not be blocked by the optional last-opened ordering write.
        setReaderId(book.id)
      } else {
        void refresh(false)
      }
    } finally {
      setBusyId(null)
    }
  }, [api, notify, refresh, t])

  const toggleRead = useCallback(async (book: BookView) => {
    listRequest.current += 1
    setBusyId(book.id)
    try {
      const record = await api.setRead(book.id, !book.markedRead)
      setBooks((current) => mergeBook(current, record))
    } catch (cause: unknown) {
      notify('error', messageOf(cause))
    } finally {
      setBusyId(null)
    }
  }, [api, notify])

  const removeBook = useCallback(async (book: BookView) => {
    listRequest.current += 1
    setBusyId(book.id)
    try {
      await api.remove(book.id)
      setBooks((current) => current.filter((entry) => entry.id !== book.id))
      setDismissed((current) => {
        if (!current.has(book.id)) return current
        const next = new Set(current)
        next.delete(book.id)
        return next
      })
      if (readerId === book.id) setReaderId(null)
      setConfirmRemove(null)
    } catch (cause: unknown) {
      notify('error', messageOf(cause))
    } finally {
      setBusyId(null)
    }
  }, [api, notify, readerId])

  const removeExistingFromDialog = useCallback(async (book: BookView) => {
    listRequest.current += 1
    setBusyId(book.id)
    try {
      await api.remove(book.id)
      setBooks((current) => current.filter((entry) => entry.id !== book.id))
      setDismissed((current) => {
        if (!current.has(book.id)) return current
        const next = new Set(current)
        next.delete(book.id)
        return next
      })
      if (readerId === book.id) setReaderId(null)
      notify('info', t('removedToast'))
    } finally {
      setBusyId(null)
    }
  }, [api, notify, readerId, t])

  const dismiss = useCallback((id: string) => {
    setDismissed((current) => new Set([...current, id]))
  }, [])

  const dismissAll = useCallback(() => {
    setDismissed((current) => {
      const next = new Set(current)
      for (const book of books) if (book.availability !== 'ok') next.add(book.id)
      return next
    })
  }, [books])

  const onSaved = useCallback((record: BookRecord) => {
    listRequest.current += 1
    setBooks((current) => sortBooks(mergeBook(current, record)))
  }, [])

  const onReaderSetRead = useCallback(async (id: string, markedRead: boolean) => {
    listRequest.current += 1
    const record = await api.setRead(id, markedRead)
    setBooks((current) => mergeBook(current, record))
  }, [api])

  const query = search.trim().toLowerCase()
  const visible = useMemo(() => query === '' ? books : books.filter((book) => book.title.toLowerCase().includes(query) || book.path.toLowerCase().includes(query)), [books, query])
  const pageCount = Math.max(1, Math.ceil(visible.length / SHELF_PAGE_SIZE))
  const page = Math.min(pageIndex, pageCount - 1)
  const pageBooks = useMemo(() => visible.slice(page * SHELF_PAGE_SIZE, (page + 1) * SHELF_PAGE_SIZE), [page, visible])
  const problems = useMemo(() => books.filter((book) => book.availability !== 'ok' && !dismissed.has(book.id)), [books, dismissed])
  const openBookRecord = readerId === null ? null : books.find((book) => book.id === readerId) ?? null

  useEffect(() => {
    if (pageIndex !== page) setPageIndex(page)
  }, [page, pageIndex])

  useEffect(() => {
    contentRef.current?.scrollTo({ top: 0 })
  }, [page])

  if (openBookRecord !== null) {
    return (
      <div className="bs-app">
        <Reader
          book={openBookRecord}
          api={api}
          t={t}
          onClose={() => setReaderId(null)}
          onSaved={onSaved}
          onSetRead={onReaderSetRead}
        />
        {toast !== null && <div key={toast.key} className={`bs-toast bs-toast-${toast.kind}`} role="status">{toast.text}</div>}
      </div>
    )
  }

  return (
    <div className="bs-app">
      <header className="bs-shelf-header">
        <div className="bs-title-block">
          <span className="bs-title-icon"><BookshelfIcon size={22} /></span>
          <div>
            <h1>{t('title')}</h1>
            <p>{t('subtitle')}</p>
          </div>
        </div>
        <div className="bs-header-actions">
          <button type="button" className="bs-button bs-button-primary" onClick={() => setAddMode('file')}><PlusIcon size={15} /> {t('addFile')}</button>
          <button type="button" className="bs-button" onClick={() => setAddMode('folder')}><PlusIcon size={15} /> {t('addFolder')}</button>
          <button type="button" className="bs-button" onClick={() => setNotesOpen(true)}>{t('notesData')}</button>
          <button type="button" className="bs-button" onClick={() => window.open('/api/bookshelf/standalone', '_blank', 'noopener')}>{t('standalonePage')}</button>
        </div>
      </header>

      {error !== null && (
        <section className="bs-banner bs-banner-error" role="alert">
          <WarningIcon size={18} />
          <div className="bs-banner-body">
            <strong>{t('loadFailed')}</strong>
            <span>{error}</span>
          </div>
          <button type="button" className="bs-button" onClick={() => { void refresh(true) }}>{t('retry')}</button>
        </section>
      )}

      {problems.length > 0 && (
        <section className="bs-banner bs-banner-warn">
          <WarningIcon size={18} />
          <div className="bs-banner-body">
            <strong>{
              problems.every((book) => book.availability === 'missing') ? t('missingTitle')
                : problems.every((book) => book.availability === 'inaccessible') ? t('inaccessibleTitle')
                  : t('mixedTitle')
            }</strong>
            {problems.map((book) => (
              <div key={book.id} className="bs-problem-row">
                <span className="bs-problem-title" title={book.path}>{book.title}</span>
                <span className={`bs-status bs-status-${book.availability}`}>{book.availability === 'missing' ? t('missing') : t('inaccessible')}</span>
                <button type="button" className="bs-link-button" onClick={() => dismiss(book.id)}>{t('keep')}</button>
                <button type="button" className="bs-link-button bs-danger" onClick={() => setConfirmRemove(book)}>{t('removeMissing')}</button>
              </div>
            ))}
          </div>
          <div className="bs-banner-buttons">
            <button type="button" className="bs-button" onClick={dismissAll}>{t('keepAll')}</button>
            <button type="button" className="bs-button" onClick={() => { void refresh(true) }}>{t('refresh')}</button>
          </div>
        </section>
      )}

      <div className="bs-toolbar">
        <label className="bs-search">
          <SearchIcon size={16} />
          <input value={search} onChange={(event) => { setSearch(event.target.value); setPageIndex(0) }} placeholder={t('search')} aria-label={t('search')} />
        </label>
        <span className="bs-count">{books.length}</span>
        <button type="button" className="bs-button" onClick={() => { void refresh(true) }} disabled={loading}>{t('refresh')}</button>
      </div>

      <div ref={contentRef} className="bs-content">
        {loading && books.length === 0
          ? <div className="bs-empty">{t('loading')}</div>
          : books.length === 0
            ? (
              <div className="bs-empty-state">
                <BookshelfIcon size={44} />
                <h2>{t('emptyTitle')}</h2>
                <p>{t('emptyBody')}</p>
                <div className="bs-empty-actions">
                  <button type="button" className="bs-button bs-button-primary" onClick={() => setAddMode('file')}><PlusIcon size={15} /> {t('addFile')}</button>
                  <button type="button" className="bs-button" onClick={() => setAddMode('folder')}><PlusIcon size={15} /> {t('addFolder')}</button>
          <button type="button" className="bs-button" onClick={() => setNotesOpen(true)}>{t('notesData')}</button>
          <button type="button" className="bs-button" onClick={() => window.open('/api/bookshelf/standalone', '_blank', 'noopener')}>{t('standalonePage')}</button>
                </div>
              </div>
            )
            : visible.length === 0
              ? <div className="bs-empty">{t('emptySearch')}</div>
              : (
                <div className="bs-grid">
                  {pageBooks.map((book) => (
                    <article key={book.id} className={`bs-book ${book.availability !== 'ok' ? 'is-unavailable' : ''}`}>
                      <button type="button" className="bs-book-main" onClick={() => { void openBook(book) }} disabled={busyId === book.id}>
                        <BookCover book={book} />
                        <span className="bs-book-text">
                          <span className="bs-book-title" title={book.path}>{book.title}</span>
                          <span className="bs-book-meta">{book.format === 'markdown' ? 'MD' : book.format.toUpperCase()} · {sizeText(book.size)}</span>
                          <span className="bs-book-progress">
                            {book.markedRead
                              ? <span className="bs-read-badge"><CheckIcon size={12} /> {t('readDone')}</span>
                              : book.progress.position !== null && <span className="bs-reading-badge">{t('inProgress')}</span>}
                            {(book.progress.position !== null || !book.markedRead) && <span>{progressText(book, t)}</span>}
                            {book.availability !== 'ok' && <span className={`bs-status bs-status-${book.availability}`}>{book.availability === 'missing' ? t('missing') : t('inaccessible')}</span>}
                          </span>
                          {book.lastOpenedAt !== null && <span className="bs-book-meta">{t('lastOpened', { date: dateText(book.lastOpenedAt) })}</span>}
                        </span>
                      </button>
                      <div className="bs-book-actions">
                        <button type="button" className="bs-button bs-button-primary" onClick={() => { void openBook(book) }} disabled={busyId === book.id || book.availability !== 'ok'}>
                          <BookOpenIcon size={14} /> {book.progress.position === null ? t('open') : t('reading')}
                        </button>
                        <span className="bs-book-action-spacer" />
                        <button type="button" className={`bs-icon-button bs-book-action-icon ${book.markedRead ? 'is-active' : ''}`} title={book.markedRead ? t('unmarkRead') : t('markRead')} aria-label={book.markedRead ? t('unmarkRead') : t('markRead')} onClick={() => { void toggleRead(book) }} disabled={busyId === book.id}>
                          <CheckIcon size={16} />
                        </button>
                        <button type="button" className="bs-icon-button bs-book-action-icon bs-danger" title={t('remove')} aria-label={t('remove')} onClick={() => setConfirmRemove(book)} disabled={busyId === book.id}>
                          <TrashIcon size={16} />
                        </button>
                      </div>
                    </article>
                  ))}
                </div>
              )}
      </div>

      {visible.length > 0 && pageCount > 1 && (
        <nav className="bs-pager" aria-label={t('pageOf', { page: page + 1, total: pageCount })}>
          <button type="button" className="bs-button" onClick={() => setPageIndex(Math.max(0, page - 1))} disabled={page === 0}>{t('prevBookPage')}</button>
          {pageCount <= 10
            ? <div className="bs-page-numbers">
                {Array.from({ length: pageCount }, (_, index) => (
                  <button
                    key={index}
                    type="button"
                    className={`bs-button bs-page-number ${index === page ? 'is-active' : ''}`}
                    aria-current={index === page ? 'page' : undefined}
                    onClick={() => setPageIndex(index)}
                  >{index + 1}</button>
                ))}
              </div>
            : <span className="bs-page-status">{t('pageOf', { page: page + 1, total: pageCount })}</span>}
          <button type="button" className="bs-button" onClick={() => setPageIndex(Math.min(pageCount - 1, page + 1))} disabled={page >= pageCount - 1}>{t('nextBookPage')}</button>
        </nav>
      )}

      <footer className="bs-footer">
        <span>{libraryPath === '' ? '' : t('libraryHint', { path: libraryPath })}</span>
      </footer>

      {notesOpen && <NotesManager api={api} t={t} onClose={() => setNotesOpen(false)} />}

      {addMode !== null && (
        <AddDialog
          mode={addMode}
          t={t}
          api={api}
          books={books}
          onClose={() => setAddMode(null)}
          onAddPaths={handleAddPaths}
          onAddDirectory={handleAddDirectory}
          onRemoveBook={removeExistingFromDialog}
        />
      )}

      {confirmRemove !== null && (
        <div className="bs-modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setConfirmRemove(null) }}>
          <section className="bs-modal bs-confirm" role="dialog" aria-modal="true" aria-label={t('removeTitle')}>
            <header className="bs-modal-header">
              <h2>{t('removeTitle')}</h2>
            </header>
            <p className="bs-confirm-body">{t('removeBody', { title: confirmRemove.title })}</p>
            <footer className="bs-modal-footer">
              <div className="bs-actions">
                <button type="button" className="bs-button" onClick={() => setConfirmRemove(null)}>{t('cancel')}</button>
                <button type="button" className="bs-button bs-button-danger" onClick={() => { void removeBook(confirmRemove) }} disabled={busyId === confirmRemove.id}>{t('confirmRemove')}</button>
              </div>
            </footer>
          </section>
        </div>
      )}

      {toast !== null && <div key={toast.key} className={`bs-toast bs-toast-${toast.kind}`} role="status">{toast.text}</div>}
    </div>
  )
}
