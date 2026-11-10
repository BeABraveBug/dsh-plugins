import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import type { MutableRefObject } from 'react'
import type { AiModelCatalog, AiSelection, BookNote, BookView, ReaderScreenshot, ReaderTextContext, ReadingPosition } from '../shared/types.ts'
import type { BookshelfApi } from './api.ts'
import type { Translate } from './i18n.ts'
import { CloseIcon, MoreIcon, PlusIcon, SendIcon, TrashIcon } from './icons.tsx'
import { renderMarkdown, renderMermaid } from './markdown.ts'

type SaveState = 'idle' | 'saving' | 'saved' | 'error'
type SidebarTab = 'notes' | 'qa'

interface CopyNotice {
  readonly index: number
  readonly error: boolean
  readonly detail?: string
}

interface NoteSidebarProps {
  readonly book: BookView
  readonly api: BookshelfApi
  readonly t: Translate
  readonly context: ReaderTextContext | null
  readonly screenshot: ReaderScreenshot | null
  readonly onClearScreenshot: () => void
  readonly onClearContext: () => void
  readonly onJump: (anchor: ReadingPosition) => void
  readonly getCurrentAnchor: () => ReadingPosition | null
  readonly onClose: () => void
  readonly flushRef?: MutableRefObject<(() => Promise<boolean>) | null>
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Describes the reading range attached to the pending question without replacing the excerpt itself. */
function contextRangeLabel(context: ReaderTextContext, t: Translate): string {
  const anchor = context.anchor
  if (anchor.kind === 'pdf') return t('pdfProgress', { page: anchor.page, total: anchor.total })
  if (anchor.kind === 'scroll') return t('percentProgress', { percent: Math.round(anchor.ratio * 100) })
  return 'EPUB'
}

/** Side panel with per-book Markdown notes and current-context Q&A. */
export function NoteSidebar({ book, api, t, context, screenshot, onClearScreenshot, onClearContext, onJump, getCurrentAnchor, onClose, flushRef }: NoteSidebarProps) {
  const [tab, setTab] = useState<SidebarTab>('notes')
  const [notes, setNotes] = useState<BookNote[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [title, setTitle] = useState('')
  const [markdown, setMarkdown] = useState('')
  const [preview, setPreview] = useState(false)
  const previewRef = useRef<HTMLDivElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const [referenceOpen, setReferenceOpen] = useState(false)
  const [referenceBooks, setReferenceBooks] = useState<BookView[]>([])
  const [referenceBookId, setReferenceBookId] = useState('')
  const [referencePage, setReferencePage] = useState('1')
  const [referenceError, setReferenceError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [saveState, setSaveState] = useState<SaveState>('idle')
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [models, setModels] = useState<AiModelCatalog | null>(null)
  const [selection, setSelection] = useState<AiSelection | null>(null)
  const [question, setQuestion] = useState('')
  const [messages, setMessages] = useState<{ role: 'user' | 'assistant'; content: string }[]>([])
  const [aiBusy, setAiBusy] = useState(false)
  const [aiError, setAiError] = useState<string | null>(null)
  const [modelError, setModelError] = useState<string | null>(null)
  const [copyNotice, setCopyNotice] = useState<CopyNotice | null>(null)
  const savedSelectionRef = useRef<AiSelection | null | undefined>(undefined)
  const dirty = useRef(false)
  const revision = useRef(0)
  const saveChain = useRef<Promise<BookNote | null>>(Promise.resolve(null))
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const selectedRef = useRef<BookNote | null>(null)
  const titleRef = useRef('')
  const markdownRef = useRef('')
  const pickerRef = useRef<HTMLDetailsElement | null>(null)
  const moreRef = useRef<HTMLDetailsElement | null>(null)
  const panelId = useId()
  titleRef.current = title
  markdownRef.current = markdown
  selectedRef.current = notes.find((note) => note.id === selectedId) ?? null

  const persist = useCallback((noteId: string): Promise<BookNote | null> => {
    if (!dirty.current) return Promise.resolve(selectedRef.current)
    const targetRevision = revision.current
    const titleToSave = titleRef.current
    const markdownToSave = markdownRef.current
    const run = async (): Promise<BookNote | null> => {
      setSaveState('saving')
      setError(null)
      try {
        const saved = await api.saveNote({
          bookId: book.id,
          bookPath: book.path,
          bookTitle: book.title,
          bookFormat: book.format,
          noteId,
          title: titleToSave,
          markdown: markdownToSave,
          anchor: selectedRef.current?.anchor ?? book.progress.position,
        })
        setNotes((current) => current.map((note) => note.id === saved.id ? saved : note))
        if (revision.current === targetRevision) dirty.current = false
        setSaveState(revision.current === targetRevision ? 'saved' : 'idle')
        return saved
      } catch (cause: unknown) {
        setSaveState('error')
        setError(messageOf(cause))
        return null
      }
    }
    const next = saveChain.current.then(run, run)
    saveChain.current = next
    return next
  }, [api, book])

  const flush = useCallback(async (): Promise<boolean> => {
    if (timer.current !== null) {
      clearTimeout(timer.current)
      timer.current = null
    }
    if (selectedId === null) return true
    for (let attempt = 0; attempt < 10; attempt += 1) {
      if (!dirty.current) return true
      const saved = await persist(selectedId)
      if (saved === null) return false
    }
    return !dirty.current
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
    let cancelled = false
    void api.getBookAiSelection(book.id).then((saved) => {
      if (cancelled) return
      savedSelectionRef.current = saved
      if (saved !== null) setSelection(saved)
    }).catch((cause: unknown) => { if (!cancelled) setModelError(messageOf(cause)) })
    return () => { cancelled = true }
  }, [api, book.id])

  useEffect(() => {
    if (tab !== 'qa' || models !== null) return
    let cancelled = false
    void (async () => {
      try {
        const catalog = await api.listAiModels()
        if (cancelled) return
        setModels(catalog)
        const saved = savedSelectionRef.current
        setSelection(saved !== undefined && saved !== null ? saved : catalog.defaultSelection)
      } catch (cause: unknown) {
        if (!cancelled) setModelError(messageOf(cause))
      }
    })()
    return () => { cancelled = true }
  }, [api, book.id, models, tab])

  useEffect(() => {
    let cancelled = false
    void api.listConversation(book.id).then((items) => {
      if (!cancelled) setMessages(items.map((item) => ({ role: item.role, content: item.content })))
    }).catch((cause: unknown) => { if (!cancelled) setAiError(messageOf(cause)) })
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

  const currentPdfAnchor = (): { page: number; total: number } | null => {
    const anchor = getCurrentAnchor()
    return anchor?.kind === 'pdf' ? { page: anchor.page, total: anchor.total } : null
  }

  const insertReference = (id: string, title: string, page: number) => {
    if (!Number.isInteger(page) || page < 1) return
    const text = `[《${title}》 · 第 ${page} 页](#bookshelf-pdf-ref?book=${encodeURIComponent(id)}&page=${page})`
    const textarea = textareaRef.current
    const start = textarea?.selectionStart ?? markdown.length
    const end = textarea?.selectionEnd ?? start
    setMarkdown(`${markdown.slice(0, start)}${text}${markdown.slice(end)}`)
    setPreview(false)
    changed()
    requestAnimationFrame(() => { textarea?.focus(); textarea?.setSelectionRange(start + text.length, start + text.length) })
  }

  const openReferenceDialog = async () => {
    setError(null)
    try {
      const { books } = await api.list()
      const pdfs = books.filter((entry) => entry.format === 'pdf')
      setReferenceBooks(pdfs)
      setReferenceBookId(pdfs.find((entry) => entry.id !== book.id)?.id ?? pdfs[0]?.id ?? '')
      setReferencePage('1')
      setReferenceError(null)
      setReferenceOpen(true)
    } catch (cause: unknown) {
      setError(messageOf(cause))
    }
  }

  const jumpToReference = (href: string) => {
    if (!href.startsWith('#bookshelf-pdf-ref?')) return false
    const params = new URLSearchParams(href.slice('#bookshelf-pdf-ref?'.length))
    const id = params.get('book')
    const page = Number(params.get('page'))
    if (id === null || !Number.isInteger(page) || page < 1) { setError(t('jumpUnavailable')); return true }
    if (id === book.id) {
      const anchor = currentPdfAnchor()
      onJump({ kind: 'pdf', page, total: anchor?.total ?? page, offset: 0 })
    } else {
      window.open(`/api/bookshelf/standalone?book=${encodeURIComponent(id)}&page=${page}`, '_blank', 'noopener')
    }
    return true
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
        anchor: getCurrentAnchor() ?? book.progress.position,
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
    revision.current += 1
    dirty.current = true
    setSaveState('idle')
  }

  const ask = async () => {
    if (aiBusy || question.trim() === '') return
    if (context === null) {
      setAiError(t('contextRequired'))
      return
    }
    setAiBusy(true)
    setAiError(null)
    const asked = question.trim()
    setMessages((current) => [...current, { role: 'user', content: asked }])
    setQuestion('')
    void api.appendConversation(book.id, book.path, book.title, book.format, 'user', asked).catch((cause: unknown) => setAiError(messageOf(cause)))
    try {
      const result = await api.askAi(asked, context.excerpt, selection)
      setMessages((current) => [...current, { role: 'assistant', content: result.answer }])
      setSelection(result.selection)
      void api.appendConversation(book.id, book.path, book.title, book.format, 'assistant', result.answer).catch((cause: unknown) => setAiError(messageOf(cause)))
    } catch (cause: unknown) {
      setAiError(messageOf(cause))
    } finally {
      setAiBusy(false)
    }
  }

  const addAnswer = (answer: string) => {
    if (selectedId === null) return
    setMarkdown((current) => `${current}${current.trim() === '' ? '' : '\n\n'}${answer}`)
    changed()
  }

  const copyAnswer = async (index: number, content: string) => {
    try {
      const clipboard = (navigator as Navigator & { clipboard?: Clipboard }).clipboard
      if (clipboard === undefined) throw new Error(t('copyUnavailable'))
      await clipboard.writeText(content)
      setCopyNotice({ index, error: false })
    } catch (cause: unknown) {
      setCopyNotice({ index, error: true, detail: messageOf(cause) })
    }
  }

  const closeMenu = (ref: MutableRefObject<HTMLDetailsElement | null>) => {
    const element = ref.current
    if (element === null) return
    element.open = false
    element.querySelector<HTMLElement>('summary')?.focus()
  }

  useEffect(() => {
    if (flushRef !== undefined) flushRef.current = flush
    return () => { if (flushRef !== undefined) flushRef.current = null }
  }, [flush, flushRef])

  const previewHtml = useMemo(() => preview ? renderMarkdown(markdown) : '', [markdown, preview])

  useEffect(() => {
    if (preview && previewRef.current !== null) void renderMermaid(previewRef.current)
  }, [preview, previewHtml])
  const renderedAnswers = useMemo(
    () => messages.map((message) => message.role === 'assistant' ? renderMarkdown(message.content) : ''),
    [messages],
  )
  const contextSummary = useMemo(
    () => context === null ? '' : `${t('contextTitle')} · ${contextRangeLabel(context, t)}`,
    [context, t],
  )
  const selected = selectedRef.current
  const notesPanelId = `${panelId}-notes`
  const qaPanelId = `${panelId}-qa`

  return (
    <aside className="bs-note-sidebar" aria-label={t('readingPanel')}>
      <header className="bs-note-header">
        <div className="bs-note-tabs" role="tablist">
          <button type="button" role="tab" id={`${panelId}-notes-tab`} aria-selected={tab === 'notes'} aria-controls={notesPanelId} className={`bs-note-tab ${tab === 'notes' ? 'is-active' : ''}`} onClick={() => setTab('notes')}>{t('notes')}</button>
          <button type="button" role="tab" id={`${panelId}-qa-tab`} aria-selected={tab === 'qa'} aria-controls={qaPanelId} className={`bs-note-tab ${tab === 'qa' ? 'is-active' : ''}`} onClick={() => setTab('qa')}>{t('qa')}</button>
        </div>
        <button type="button" className="bs-icon-button" aria-label={t('close')} title={t('close')} onClick={() => { void flush().then((saved) => { if (saved) onClose() }) }}><CloseIcon size={16} /></button>
      </header>

      <section className="bs-note-notes" role="tabpanel" id={notesPanelId} aria-labelledby={`${panelId}-notes-tab`} hidden={tab !== 'notes'}>
        <div className="bs-note-tools">
          <details className="bs-note-picker" ref={pickerRef}>
            <summary>{t('bookNotesCount', { count: notes.length })}</summary>
            <div className="bs-note-popover">
              {notes.length === 0 && <p className="bs-note-muted">{t('noNotes')}</p>}
              {notes.map((note) => (
                <button key={note.id} type="button" aria-pressed={note.id === selectedId} disabled={busy}
                  onClick={() => {
                    closeMenu(pickerRef)
                    void selectNote(note)
                  }}>
                  {note.title || t('untitledNote')}
                </button>
              ))}
            </div>
          </details>
          <div className="bs-note-actions">
            {selected !== null && currentPdfAnchor() !== null && (
              <button type="button" className="bs-note-action" onClick={() => { const anchor = currentPdfAnchor(); if (anchor !== null) insertReference(book.id, book.title, anchor.page) }} disabled={busy}>{t('insertCurrentPage')}</button>
            )}
            {selected !== null && (
              <button type="button" className="bs-note-action" onClick={() => { void openReferenceDialog() }} disabled={busy}>{t('insertPdfReference')}</button>
            )}
            {selected !== null && (
              <button type="button" className="bs-note-action" onClick={() => setPreview((current) => !current)} disabled={busy}>{preview ? t('editNote') : t('previewNote')}</button>
            )}
            {selected?.anchor !== null && selected?.anchor !== undefined && (
              <button type="button" className="bs-note-action" onClick={() => onJump(selected.anchor as ReadingPosition)} disabled={busy}>{t('goToAnchor')}</button>
            )}
            <button type="button" className="bs-note-action bs-note-action-icon" aria-label={t('newNote')} title={t('newNote')} onClick={() => { void createNote() }} disabled={busy || loading}><PlusIcon size={16} /></button>
            {selected !== null && (
              <details className="bs-note-more" ref={moreRef} onToggle={(event) => { if (!event.currentTarget.open) setConfirmDelete(false) }}>
                <summary aria-label={t('moreActions')} title={t('moreActions')}><MoreIcon size={16} /></summary>
                <div className="bs-note-popover">
                  <button type="button" className="bs-danger" disabled={busy}
                    onClick={() => {
                      if (confirmDelete) {
                        closeMenu(moreRef)
                        void removeNote()
                      } else {
                        setConfirmDelete(true)
                      }
                    }}>
                    <TrashIcon size={14} /> {confirmDelete ? t('confirmDeleteNote') : t('deleteNote')}
                  </button>
                </div>
              </details>
            )}
          </div>
        </div>

        <div className="bs-note-scroll">
          {error !== null && (
            <div className="bs-note-error" role="alert">
              <span>{error}</span>
              {saveState === 'error' && <button type="button" className="bs-button" onClick={() => { void flush() }}>{t('saveRetry')}</button>}
            </div>
          )}
          {loading && <div className="bs-note-empty">{t('loading')}</div>}
          {!loading && notes.length === 0 && <div className="bs-note-empty">{t('noNotes')}</div>}
          {!loading && notes.length > 0 && selected === null && <div className="bs-note-empty">{t('noNotes')}</div>}
          {!loading && selected !== null && (
            <article className="bs-note-document">
              <input className="bs-note-title-input" value={title} onChange={(event) => { setTitle(event.target.value); changed() }} placeholder={t('noteTitle')} aria-label={t('noteTitle')} />
              {preview
                ? <div ref={previewRef} className="bs-note-preview bs-markdown" onClick={(event) => { const link = (event.target as Element).closest('a'); if (link !== null && jumpToReference(link.getAttribute('href') ?? '')) event.preventDefault() }} dangerouslySetInnerHTML={{ __html: previewHtml }} />
                : <textarea ref={textareaRef} className="bs-note-textarea" value={markdown} onChange={(event) => { setMarkdown(event.target.value); changed() }} placeholder={t('notePlaceholder')} aria-label={t('notePlaceholder')} />}
            </article>
          )}
        </div>

        <footer className={`bs-note-footer bs-note-save-${saveState}`}>
          <span role="status">{saveState === 'saving' ? t('saveSaving') : saveState === 'saved' ? t('saveSaved') : saveState === 'error' ? t('saveFailed') : ''}</span>
          <span>Markdown</span>
        </footer>
      </section>

      <section className="bs-note-qa" role="tabpanel" id={qaPanelId} aria-labelledby={`${panelId}-qa-tab`} hidden={tab !== 'qa'}>
        <div className="bs-qa-messages">
          {messages.length === 0 && <div className="bs-note-empty">{t('qaEmpty')}</div>}
          {messages.length > 0 && (
            <div className="bs-qa-history-tools">
              <button type="button" className="bs-qa-action" onClick={() => { void api.clearConversation(book.id).then(() => { setMessages([]); setCopyNotice(null) }).catch((cause: unknown) => setAiError(messageOf(cause))) }}>{t('clearConversation')}</button>
            </div>
          )}
          {messages.map((message, index) => (
            <article key={index} className={`bs-qa-message bs-qa-${message.role}`}>
              {message.role === 'assistant' && <div className="bs-qa-assistant-name">{t('assistantName')}</div>}
              {message.role === 'assistant'
                ? <div className="bs-qa-answer bs-markdown" dangerouslySetInnerHTML={{ __html: renderedAnswers[index] ?? '' }} />
                : <div className="bs-qa-user-text">{message.content}</div>}
              {message.role === 'assistant' && (
                <div className="bs-qa-message-actions">
                  {selectedId !== null && <button type="button" className="bs-qa-action" onClick={() => addAnswer(message.content)}>{t('addAnswerToNote')}</button>}
                  <button type="button" className="bs-qa-action" onClick={() => { void copyAnswer(index, message.content) }}>{t('copyAnswer')}</button>
                  {copyNotice !== null && copyNotice.index === index && (
                    <span className={`bs-qa-action-status ${copyNotice.error ? 'is-error' : ''}`} role="status" title={copyNotice.detail}>
                      {copyNotice.error ? t('copyFailed') : t('copied')}
                    </span>
                  )}
                </div>
              )}
            </article>
          ))}
        </div>

        <div className="bs-qa-input-zone">
          {modelError !== null && <div className="bs-qa-error" role="alert">{modelError}</div>}
          {aiError !== null && <div className="bs-qa-error" role="alert">{aiError}</div>}
          <div className="bs-qa-composer">
            {context === null
              ? <p className="bs-qa-context-empty">{t('contextEmpty')}</p>
              : (
                <div className="bs-qa-context-row">
                  <details className="bs-qa-context">
                    <summary>{contextSummary}</summary>
                    <div className="bs-qa-context-text">
                      <p>{context.excerpt}</p>
                      {context.truncated && <p>{t('contextTruncated')}</p>}
                    </div>
                  </details>
                  <button type="button" className="bs-qa-attachment-remove" aria-label={t('clearContext')} title={t('clearContext')} onClick={onClearContext}><CloseIcon size={14} /></button>
                </div>
              )}
            {screenshot !== null && (
              <div className="bs-qa-capture">
                <div className="bs-qa-capture-head">
                  <span>{t('capturePreview')}</span>
                  <button type="button" className="bs-qa-attachment-remove" aria-label={t('discardScreenshot')} title={t('discardScreenshot')} onClick={onClearScreenshot}><CloseIcon size={14} /></button>
                </div>
                <img className="bs-qa-capture-image" src={screenshot.dataUrl} alt={t('capturePreview')} />
                <span className="bs-note-muted">{t('screenshotTextOnlyPending')}</span>
              </div>
            )}
            <textarea className="bs-qa-question-input" value={question} onChange={(event) => setQuestion(event.target.value)} placeholder={t('askPlaceholder')} aria-label={t('askPlaceholder')} />
            <div className="bs-qa-compose-bottom">
              <div className="bs-qa-model">
                <select
                  aria-label={t('model')}
                  value={selection === null ? '' : `${selection.provider}::${selection.model}`}
                  onChange={(event) => {
                    const [provider, model] = event.target.value.split('::')
                    const next = provider !== undefined && model !== undefined && provider !== '' ? { provider, model } : null
                    setSelection(next)
                    void api.saveBookAiSelection(book.id, book.path, book.title, book.format, next).catch((cause: unknown) => setAiError(messageOf(cause)))
                  }}
                  disabled={aiBusy || models === null}
                >
                  <option value="">{t('defaultModel')}</option>
                  {models?.providers.flatMap((provider) => provider.models.map((model) => (
                    <option key={`${provider.id}::${model.id}`} value={`${provider.id}::${model.id}`}>{provider.name} · {model.name}</option>
                  )))}
                </select>
              </div>
              <button type="button" className="bs-qa-send" aria-label={aiBusy ? t('sending') : t('ask')} title={aiBusy ? t('sending') : t('ask')} onClick={() => { void ask() }} disabled={aiBusy || question.trim() === '' || context === null}>{aiBusy ? '…' : <SendIcon size={16} />}</button>
            </div>
          </div>
        </div>
      </section>
      {referenceOpen && (
        <div className="bs-modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setReferenceOpen(false) }}>
          <section className="bs-modal bs-confirm" role="dialog" aria-modal="true" aria-label={t('insertPdfReference')}>
            <header className="bs-modal-header"><h2>{t('insertPdfReference')}</h2></header>
            <div className="bs-detail-body">
              <label>{t('book')}
                <select value={referenceBookId} onChange={(event) => setReferenceBookId(event.target.value)}>
                  {referenceBooks.map((entry) => <option key={entry.id} value={entry.id}>{entry.title}</option>)}
                </select>
              </label>
              <label>{t('page')}<input type="number" min={1} value={referencePage} onChange={(event) => { setReferencePage(event.target.value); setReferenceError(null) }} /></label>
              {referenceError !== null && <div className="bs-inline-error" role="alert">{referenceError}</div>}
            </div>
            <footer className="bs-modal-footer"><div className="bs-actions">
              <button type="button" className="bs-button" onClick={() => setReferenceOpen(false)}>{t('cancel')}</button>
              <button type="button" className="bs-button bs-button-primary" onClick={() => { const target = referenceBooks.find((entry) => entry.id === referenceBookId); const page = Number(referencePage); if (target === undefined || !Number.isInteger(page) || page < 1) { setReferenceError(t('invalidPage')); return } insertReference(target.id, target.title, page); setReferenceOpen(false) }} disabled={referenceBookId === ''}>{t('insert')}</button>
            </div></footer>
          </section>
        </div>
      )}
    </aside>
  )
}
