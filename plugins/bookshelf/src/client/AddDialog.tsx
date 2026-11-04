import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { BookshelfApi } from './api.ts'
import type { Translate } from './i18n.ts'
import type { AddResult, BookView, BrowseEntry, BrowseResult } from '../shared/types.ts'
import { FileIcon, FolderIcon, UpIcon } from './icons.tsx'

export type AddMode = 'file' | 'folder'

type DialogTab = 'browse' | 'existing'

interface AddDialogProps {
  readonly mode: AddMode
  readonly t: Translate
  readonly api: BookshelfApi
  readonly books: readonly BookView[]
  readonly initialPath?: string
  readonly onClose: () => void
  readonly onAddPaths: (paths: readonly string[]) => Promise<AddResult>
  readonly onAddDirectory: (path: string) => Promise<AddResult>
  readonly onRemoveBook: (book: BookView) => Promise<void>
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function uriToPath(uri: string): string | null {
  if (!uri.startsWith('file://')) return null
  try {
    const url = new URL(uri)
    let path = decodeURIComponent(url.pathname)
    if (url.host !== '' && url.host !== 'localhost') path = `//${url.host}${path}`
    else if (/^\/[A-Za-z]:\//.test(path)) path = path.slice(1)
    return path === '' ? null : path
  } catch {
    return null
  }
}

function droppedPaths(data: DataTransfer): string[] {
  const paths = new Set<string>()
  for (const file of Array.from(data.files)) {
    const path = (file as File & { path?: unknown }).path
    if (typeof path === 'string' && path !== '') paths.add(path)
  }
  for (const type of ['text/uri-list', 'text/plain']) {
    for (const line of data.getData(type).split(/\r?\n/)) {
      const path = uriToPath(line.trim())
      if (path !== null) paths.add(path)
    }
  }
  return [...paths]
}

function looksLikeFile(path: string): boolean {
  return /\.(pdf|epub|txt|md|markdown)$/i.test(path.trim())
}

function sizeText(size: number | null): string {
  if (size === null) return ''
  if (size < 1024) return `${size} B`
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`
  return `${(size / (1024 * 1024)).toFixed(1)} MB`
}

export function AddDialog({ mode, t, api, books, initialPath, onClose, onAddPaths, onAddDirectory, onRemoveBook }: AddDialogProps) {
  const [tab, setTab] = useState<DialogTab>('browse')
  const [view, setView] = useState<BrowseResult | null>(null)
  const [pathInput, setPathInput] = useState(initialPath ?? '')
  const [selected, setSelected] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [removing, setRemoving] = useState<string | null>(null)
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [dragOver, setDragOver] = useState(false)
  const requestId = useRef(0)

  const existingPaths = useMemo(() => new Set(books.map((book) => book.path)), [books])
  const existingBooks = useMemo(
    () => [...books].sort((left, right) => left.path.localeCompare(right.path)),
    [books],
  )

  const navigate = useCallback(async (path?: string) => {
    const id = ++requestId.current
    setLoading(true)
    setError(null)
    try {
      const next = await api.browse(path)
      if (id !== requestId.current) return
      setView(next)
      setPathInput(next.path)
      setSelected(null)
    } catch (cause: unknown) {
      if (id === requestId.current) setError(messageOf(cause))
    } finally {
      if (id === requestId.current) setLoading(false)
    }
  }, [api])

  useEffect(() => { void navigate(initialPath) }, [navigate, initialPath])

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !busy && removing === null) onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [busy, onClose, removing])

  const switchTab = (next: DialogTab) => {
    if (busy || removing !== null) return
    setTab(next)
    setError(null)
    setConfirmRemove(null)
  }

  const addPaths = useCallback(async (paths: readonly string[]) => {
    if (busy || removing !== null) return
    setBusy(true)
    setError(null)
    try {
      await onAddPaths(paths)
      onClose()
    } catch (cause: unknown) {
      setError(messageOf(cause))
    } finally {
      setBusy(false)
    }
  }, [busy, onAddPaths, onClose, removing])

  const addFolder = useCallback(async (path: string | undefined) => {
    if (busy || removing !== null || path === undefined || path.trim() === '') return
    setBusy(true)
    setError(null)
    try {
      await onAddDirectory(path)
      onClose()
    } catch (cause: unknown) {
      setError(messageOf(cause))
    } finally {
      setBusy(false)
    }
  }, [busy, onAddDirectory, onClose, removing])

  const addByPath = useCallback(() => {
    const path = pathInput.trim()
    if (path === '') return
    if (mode === 'file') {
      if (!looksLikeFile(path)) {
        setError(t('pathNotFile'))
        return
      }
      void addPaths([path])
    } else {
      void addFolder(path)
    }
  }, [addFolder, addPaths, mode, pathInput, t])

  const canAddByPath = mode === 'folder' || looksLikeFile(pathInput)

  const handleDrop = useCallback((event: React.DragEvent) => {
    event.preventDefault()
    setDragOver(false)
    const paths = droppedPaths(event.dataTransfer)
    if (paths.length === 0) {
      setError(t('dropUnsupported'))
      return
    }
    void addPaths(paths)
  }, [addPaths, t])

  const removeExisting = useCallback(async (book: BookView) => {
    if (removing !== null) return
    setRemoving(book.id)
    setError(null)
    try {
      await onRemoveBook(book)
      setConfirmRemove(null)
    } catch (cause: unknown) {
      setError(messageOf(cause))
    } finally {
      setRemoving(null)
    }
  }, [onRemoveBook, removing])

  const entries = useMemo(() => view?.entries ?? [], [view])
  const selectedEntry = entries.find((entry) => entry.path === selected) ?? null
  const selectedExisting = selectedEntry !== null && existingPaths.has(selectedEntry.path)

  const choose = (entry: BrowseEntry) => {
    if (entry.kind === 'directory') {
      void navigate(entry.path)
    } else {
      setSelected(entry.path)
    }
  }

  const title = mode === 'file' ? t('browseTitleFile') : t('browseTitleFolder')
  const hint = tab === 'browse' ? t('browseHint') : t('existingHint')

  return (
    <div className="bs-modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !busy && removing === null) onClose() }}>
      <section className="bs-modal bs-add-modal" role="dialog" aria-modal="true" aria-label={title}>
        <header className="bs-modal-header">
          <div>
            <h2>{title}</h2>
            <p>{hint}</p>
          </div>
          <button type="button" className="bs-icon-button" onClick={onClose} disabled={busy || removing !== null} aria-label={t('close')}>×</button>
        </header>

        <div className="bs-dialog-tabs" role="tablist" aria-label={title}>
          <button type="button" role="tab" aria-selected={tab === 'browse'} className={`bs-dialog-tab ${tab === 'browse' ? 'is-active' : ''}`} onClick={() => switchTab('browse')} disabled={busy || removing !== null}>{t('browseTab')}</button>
          <button type="button" role="tab" aria-selected={tab === 'existing'} className={`bs-dialog-tab ${tab === 'existing' ? 'is-active' : ''}`} onClick={() => switchTab('existing')} disabled={busy || removing !== null}>{t('existingTab', { count: books.length })}</button>
        </div>

        {error !== null && <div className="bs-inline-error" role="alert">{error}</div>}

        {tab === 'browse' && (
          <>
            <div className="bs-pathbar">
              <button type="button" className="bs-icon-button" onClick={() => { if (view?.parent !== null && view?.parent !== undefined) void navigate(view.parent) }} disabled={view?.parent === null || view?.parent === undefined || loading || busy} aria-label={t('up')}>
                <UpIcon size={16} />
              </button>
              <input
                className="bs-path-input"
                value={pathInput}
                onChange={(event) => setPathInput(event.target.value)}
                onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); void navigate(pathInput) } }}
                aria-label={t('path')}
                spellCheck={false}
              />
              <button type="button" className="bs-button" onClick={() => { void navigate(pathInput) }} disabled={loading || busy}>{t('go')}</button>
            </div>
            <div
              className={`bs-browser ${dragOver ? 'is-dragover' : ''}`}
              onDragOver={(event) => { event.preventDefault(); if (!busy) setDragOver(true) }}
              onDragLeave={() => setDragOver(false)}
              onDrop={handleDrop}
            >
              {loading && <div className="bs-empty">{t('loading')}</div>}
              {!loading && entries.length === 0 && !view?.truncated && <div className="bs-empty">{t('noEntries')}</div>}
              {!loading && entries.map((entry) => {
                const isExisting = entry.kind === 'file' && existingPaths.has(entry.path)
                return (
                  <button
                    key={entry.path}
                    type="button"
                    className={`bs-browser-row ${selectedEntry?.path === entry.path ? 'is-selected' : ''} ${isExisting ? 'is-existing' : ''}`}
                    onClick={() => choose(entry)}
                    onDoubleClick={() => { if (entry.kind === 'file' && !isExisting) void addPaths([entry.path]) }}
                    disabled={busy}
                  >
                    <span className="bs-browser-icon">{entry.kind === 'directory' ? <FolderIcon size={18} /> : <FileIcon size={18} />}</span>
                    <span className="bs-browser-name">{entry.name}</span>
                    <span className="bs-browser-meta">{entry.format ?? ''}{entry.size === null ? '' : ` · ${sizeText(entry.size)}`}</span>
                    {isExisting && <span className="bs-existing-badge">{t('alreadyAdded')}</span>}
                  </button>
                )
              })}
              {view?.truncated === true && <div className="bs-empty">{t('truncated')}</div>}
              <div className="bs-drop-zone">{t('dropHere')}</div>
            </div>
          </>
        )}

        {tab === 'existing' && (
          <div className="bs-existing-list">
            {existingBooks.length === 0
              ? <div className="bs-empty">{t('noExistingPaths')}</div>
              : existingBooks.map((book) => (
                <div key={book.id} className="bs-existing-row">
                  <span className="bs-existing-icon"><FileIcon size={16} /></span>
                  <div className="bs-existing-text">
                    <span className="bs-existing-title" title={book.path}>{book.title}</span>
                    <span className="bs-existing-path" title={book.path}>{book.path}</span>
                  </div>
                  {book.availability !== 'ok' && <span className={`bs-status bs-status-${book.availability}`}>{book.availability === 'missing' ? t('missing') : t('inaccessible')}</span>}
                  {confirmRemove === book.id
                    ? (
                      <div className="bs-existing-actions">
                        <button type="button" className="bs-button bs-button-danger" onClick={() => { void removeExisting(book) }} disabled={removing !== null}>{removing === book.id ? t('removing') : t('confirmRemove')}</button>
                        <button type="button" className="bs-button" onClick={() => setConfirmRemove(null)} disabled={removing !== null}>{t('cancel')}</button>
                      </div>
                    )
                    : <button type="button" className="bs-button" onClick={() => setConfirmRemove(book.id)} disabled={removing !== null}>{t('removeFromShelf')}</button>}
                </div>
              ))}
          </div>
        )}

        <footer className="bs-modal-footer">
          {tab === 'browse'
            ? (
              <>
                <span className="bs-selection">
                  {mode === 'file'
                    ? `${selectedEntry?.name ?? t('noSelection')}${selectedExisting ? ` · ${t('alreadyAdded')}` : ''}`
                    : view?.path ?? ''}
                </span>
                <div className="bs-actions">
                  <button type="button" className="bs-button" onClick={onClose} disabled={busy || removing !== null}>{t('cancel')}</button>
                  <button type="button" className="bs-button" onClick={addByPath} disabled={busy || !canAddByPath}>{t('addPath')}</button>
                  {mode === 'file'
                    ? <button type="button" className="bs-button bs-button-primary" onClick={() => { if (selected !== null) void addPaths([selected]) }} disabled={busy || selected === null || selectedExisting}>{t('addThisFile')}</button>
                    : <button type="button" className="bs-button bs-button-primary" onClick={() => { void addFolder(view?.path ?? pathInput) }} disabled={busy || view === null}>{t('addThisFolder')}</button>}
                </div>
              </>
            )
            : (
              <>
                <span className="bs-selection">{t('existingCount', { count: books.length })}</span>
                <div className="bs-actions">
                  <button type="button" className="bs-button" onClick={onClose} disabled={busy || removing !== null}>{t('close')}</button>
                </div>
              </>
            )}
        </footer>
      </section>
    </div>
  )
}
