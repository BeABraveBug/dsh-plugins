import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import type { SideChatApi } from './api.ts'
import type { SideChatHub } from './hub.ts'
import type { SessionBindingLike, SessionReferenceLike, SessionStatusLike, SessionsServiceLike, UiSessionServiceLike, WorkspacesServiceLike } from './host-api.ts'
import type { Translate } from './i18n.ts'
import { legacyBackgroundPrefix, stripBackgroundEnvelope, wrapBackground } from './context.ts'
import { collectMessages, lastTurnFailure } from './messages.ts'
import { approvalFromStatus, findToolCall } from './approvals.ts'
import { NOT_READY, useChatPersistence } from './persistence.ts'
import { ARCHIVED, BACKGROUND_FAILED, CREATE_UNKNOWN, SAVE_FAILED, SESSION_UNAVAILABLE, UNKNOWN_RESULT } from './use-side-chat.ts'
import { useSideChatSessions } from './use-side-chat.ts'
import type { ArchivedChatSummary, SideChat } from '../shared/types.ts'

function ChatThread({ binding, t, uiSession, backgroundEnvelopes }: {
  binding: SessionBindingLike
  t: Translate
  uiSession: UiSessionServiceLike | undefined
  backgroundEnvelopes: readonly string[]
}) {
  const snapshot = useSyncExternalStore(
    listener => binding.session.subscribe(listener),
    () => binding.session.getSnapshot(),
  )
  const eventWindow = useSyncExternalStore(
    listener => binding.eventSource.subscribe(listener),
    () => binding.eventSource.getSnapshot(),
  )
  const messages = collectMessages(eventWindow.entries as never)
    .map(message => message.role === 'user'
      ? { ...message, text: stripBackgroundEnvelope(message.text, backgroundEnvelopes) }
      : message)
    .filter(message => message.text !== '')
  const durableFailure = lastTurnFailure(eventWindow.entries as never)
  const status = useSyncExternalStore(
    listener => uiSession?.sessionStatus.subscribe(listener) ?? (() => {}),
    () => uiSession?.sessionStatus.getSnapshot().get(binding.sessionId),
  )
  const [expandedArguments, setExpandedArguments] = useState(false)
  const [copiedArguments, setCopiedArguments] = useState(false)
  const language = typeof document === 'undefined' ? 'en' : document.documentElement.lang || navigator.language || 'en'
  const approval = approvalFromStatus(status, language)
  const toolCall = approval === undefined ? undefined : findToolCall(eventWindow.entries, approval.callId)
  const approvable = approval !== undefined && approval.answerable && toolCall !== undefined
  const pendingInteraction = status?.pendingInteraction !== undefined

  return (
    <div className="side-chat-pane__thread">
      {snapshot.openState === 'loading' && messages.length === 0
        ? <p className="side-chat-pane__hint">{t('thread.loading')}</p>
        : null}
      {snapshot.openState === 'error' ? (
        <p className="side-chat-pane__error">
          {t('thread.sessionMissing')}
          {snapshot.openError?.message === undefined ? '' : `: ${snapshot.openError.message}`}
        </p>
      ) : null}
      {messages.length === 0 && snapshot.openState !== 'loading'
        ? <p className="side-chat-pane__hint">{t('thread.empty')}</p>
        : null}
      {eventWindow.hasMore ? (
        <button
          type="button"
          className="side-chat-pane__load-older"
          onClick={() => { void binding.session.loadOlder?.() }}
        >
          {t('thread.loadOlder')}
        </button>
      ) : null}
      {messages.map(message => (
        <article key={message.id} className={`side-chat-pane__message side-chat-pane__message--${message.role}`}>
          <span className="side-chat-pane__role">{message.role === 'user' ? t('thread.roleUser') : t('thread.roleAssistant')}</span>
          <p className="side-chat-pane__text">{message.text}</p>
        </article>
      ))}
      {approval !== undefined ? (
        <div className="side-chat-pane__approval" role="group" aria-label={t('approval.title')}>
          <p className="side-chat-pane__approval-title">
            {approval.toolName === undefined ? t('approval.title') : `${t('approval.title')}: ${approval.toolName}`}
          </p>
          {toolCall === undefined ? (
            <p className="side-chat-pane__approval-unverifiable">{t('approval.unverifiable')}</p>
          ) : (
            <>
              <pre className="side-chat-pane__approval-arguments" title={toolCall.argumentsText}>
                {expandedArguments ? toolCall.argumentsText : `${toolCall.argumentsText.slice(0, 2000)}${toolCall.argumentsText.length > 2000 ? '…' : ''}`}
              </pre>
              <div className="side-chat-pane__approval-tools">
                {toolCall.argumentsText.length > 2000 ? (
                  <button
                    type="button"
                    className="side-chat-pane__quote-clear"
                    onClick={() => setExpandedArguments(value => !value)}
                  >
                    {expandedArguments ? t('approval.hideFull') : t('approval.showFull')}
                  </button>
                ) : null}
                <button
                  type="button"
                  className="side-chat-pane__quote-clear"
                  onClick={() => {
                    void navigator.clipboard?.writeText(toolCall.argumentsText).then(() => {
                      setCopiedArguments(true)
                      setTimeout(() => setCopiedArguments(false), 1500)
                    }).catch(() => undefined)
                  }}
                >
                  {copiedArguments ? t('approval.copied') : t('approval.copy')}
                </button>
              </div>
            </>
          )}
          {approval.reason === undefined ? null : <p className="side-chat-pane__approval-reason">{approval.reason}</p>}
          <div className="side-chat-pane__approval-actions">
            <button
              type="button"
              className="side-chat-pane__send"
              disabled={!approvable}
              title={approvable ? undefined : t('approval.needsDetails')}
              onClick={() => { void approval.answer('allowed-once').catch(() => undefined) }}
            >
              {t('approval.allow')}
            </button>
            <button
              type="button"
              className="side-chat-pane__send"
              disabled={!approval.answerable}
              onClick={() => { void approval.answer('rejected').catch(() => undefined) }}
            >
              {t('approval.reject')}
            </button>
          </div>
        </div>
      ) : pendingInteraction ? (
        <p className="side-chat-pane__hint">{t('thread.awaitingApproval')}</p>
      ) : null}
      {snapshot.running && approval === undefined ? <p className="side-chat-pane__hint">{t('thread.running')}</p> : null}
      {durableFailure !== null ? (
        <p className="side-chat-pane__error">
          {durableFailure.kind === 'error'
            ? `${t('thread.agentFailed')}: ${durableFailure.message}`
            : durableFailure.kind === 'aborted'
              ? t('turn.aborted')
              : durableFailure.kind === 'interrupted'
                ? t('turn.interrupted')
                : durableFailure.kind === 'max-tokens'
                  ? t('turn.maxTokens')
                  : t('thread.agentFailed')}
        </p>
      ) : snapshot.lastAgentError === null || snapshot.lastAgentError === '' ? null : (
        <p className="side-chat-pane__error">{t('thread.agentFailed')}: {snapshot.lastAgentError}</p>
      )}
      {snapshot.promptError === null ? null : (
        <p className="side-chat-pane__error">
          {snapshot.promptError.error.code ?? t('thread.sendFailed')}
          {snapshot.promptError.error.message === undefined ? '' : `: ${snapshot.promptError.error.message}`}
        </p>
      )}
    </div>
  )
}


function ArchivedHistory({ item, t, sessions, uiSession, onBack }: {
  item: ArchivedChatSummary
  t: Translate
  sessions: SessionsServiceLike
  uiSession: UiSessionServiceLike | undefined
  onBack: () => void
}) {
  const [binding, setBinding] = useState<SessionBindingLike | undefined>(undefined)
  const [error, setError] = useState<string | undefined>(undefined)
  useEffect(() => {
    if (item.sideSessionId === undefined) return
    let reference: SessionReferenceLike | undefined
    try {
      reference = sessions.retain(item.sideSessionId, { source: 'controllerOperation' })
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
      return
    }
    const retained = reference
    let cancelled = false
    void retained.ready.then(next => {
      if (!cancelled) setBinding(next)
    }).catch(cause => {
      if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause))
    })
    return () => {
      cancelled = true
      retained.release()
    }
  }, [item.sideSessionId, sessions])

  const envelopes = item.backgroundText === undefined
    ? []
    : [wrapBackground(item.backgroundText), legacyBackgroundPrefix(item.backgroundText)]

  return (
    <div className="side-chat-pane__archive-view">
      <div className="side-chat-pane__archive-head">
        <button type="button" className="side-chat-pane__quote-clear" onClick={onBack}>{t('panel.archiveBack')}</button>
        <span className="side-chat-pane__archive-parent">{t('panel.archivedParent')}: {item.parentSessionId}</span>
      </div>
      {item.sideSessionId === undefined ? (
        <p className="side-chat-pane__hint">{t('panel.archivedHistoryMissing')}</p>
      ) : error !== undefined ? (
        <p className="side-chat-pane__error">{t('panel.archiveLoadFailed')}: {error}</p>
      ) : binding === undefined ? (
        <p className="side-chat-pane__hint">{t('thread.loading')}</p>
      ) : (
        <ChatThread binding={binding} t={t} uiSession={uiSession} backgroundEnvelopes={envelopes} />
      )}
      <p className="side-chat-pane__banner">
        {item.status === 'archiving' ? t('thread.archivingWait') : t('thread.archivedReadonly')}
      </p>
    </div>
  )
}

function ArchiveBrowser({ api, t, sessions, uiSession, onClose }: {
  api: SideChatApi
  t: Translate
  sessions: SessionsServiceLike
  uiSession: UiSessionServiceLike | undefined
  onClose: () => void
}) {
  const [items, setItems] = useState<readonly ArchivedChatSummary[] | undefined>(undefined)
  const [error, setError] = useState<string | undefined>(undefined)
  const [selected, setSelected] = useState<ArchivedChatSummary | undefined>(undefined)
  useEffect(() => {
    let cancelled = false
    api.listArchived().then(value => {
      if (!cancelled) setItems(value)
    }).catch(cause => {
      if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause))
    })
    return () => { cancelled = true }
  }, [api])
  if (selected !== undefined) {
    return <ArchivedHistory item={selected} t={t} sessions={sessions} uiSession={uiSession} onBack={() => setSelected(undefined)} />
  }
  return (
    <div className="side-chat-pane__archive-view">
      <div className="side-chat-pane__archive-head">
        <strong>{t('panel.archiveBrowser')}</strong>
        <button type="button" className="side-chat-pane__quote-clear" onClick={onClose}>{t('panel.cancel')}</button>
      </div>
      {error !== undefined ? <p className="side-chat-pane__error">{t('panel.archiveLoadFailed')}: {error}</p> : null}
      {error === undefined && items === undefined ? <p className="side-chat-pane__hint">{t('thread.loading')}</p> : null}
      {items !== undefined && items.length === 0 ? <p className="side-chat-pane__hint">{t('panel.archiveEmpty')}</p> : null}
      {items === undefined ? null : (
        <ul className="side-chat-pane__archive-list">
          {items.map(item => (
            <li key={`${item.parentSessionId}:${item.chatId}`}>
              <button type="button" className="side-chat-pane__menu-item" onClick={() => setSelected(item)}>
                <span>{item.title}</span>
                <span className="side-chat-pane__menu-badge">
                  {item.status === 'archiving' ? t('panel.archiving') : item.parentSessionId.slice(0, 12)}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

/**
 * The Side Chat panel: one active chat at a time, chosen from the header list.
 * Chats are in memory only; the first send creates their real Session.
 */
export function SideChatPane({ sessionId, t, sessions, workspaces, uiSession, api, hub }: {
  sessionId: string
  t: Translate
  sessions: SessionsServiceLike
  workspaces: WorkspacesServiceLike | undefined
  uiSession: UiSessionServiceLike | undefined
  api: SideChatApi
  hub: SideChatHub
}) {
  const book = useMemo(() => hub.bookFor(sessionId), [hub, sessionId])
  const snapshot = useSyncExternalStore(book.subscribe, book.getSnapshot)
  const persistence = useChatPersistence(book, api, sessionId)
  const sessionsRef = useSideChatSessions(book, sessions, workspaces, sessionId, persistence.flush)
  const [menuOpen, setMenuOpen] = useState(false)
  const [actionsOpen, setActionsOpen] = useState(false)
  const [viewingArchivedId, setViewingArchivedId] = useState<string | undefined>(undefined)
  const [archiveBrowserOpen, setArchiveBrowserOpen] = useState(false)
  const [reconcileNote, setReconcileNote] = useState<string | undefined>(undefined)
  const reconcilingIds = useRef(new Set<string>())
  const [parentUnavailable, setParentUnavailable] = useState(false)
  const active = snapshot.activeId === undefined
    ? undefined
    : snapshot.chats.find(chat => chat.id === snapshot.activeId)
  const archivedView = viewingArchivedId === undefined
    ? undefined
    : snapshot.chats.find(chat => chat.id === viewingArchivedId && (chat.status === 'archived' || chat.status === 'archiving'))
  const displayed = archivedView ?? active
  const binding = displayed === undefined ? undefined : sessionsRef.bindingOf(displayed.id)
  const backgroundEnvelopes = displayed?.contextSnapshot?.text === undefined
    ? []
    : [wrapBackground(displayed.contextSnapshot.text), legacyBackgroundPrefix(displayed.contextSnapshot.text)]
  const sending = displayed !== undefined && sessionsRef.sending[displayed.id] === true
  const error = displayed === undefined ? undefined : sessionsRef.errors[displayed.id]
  const unknownResult = error === UNKNOWN_RESULT
  const readOnly = displayed !== undefined && (displayed.status === 'archived' || displayed.status === 'archiving')
  const ready = persistence.status === 'ready'
  const errorText = error === undefined
    ? undefined
    : error === UNKNOWN_RESULT
      ? t('thread.unknownResult')
      : error === SESSION_UNAVAILABLE
        ? t('thread.sessionMissing')
        : error === CREATE_UNKNOWN
          ? t('thread.createUnknown')
          : error === SAVE_FAILED
            ? t('thread.saveFailed')
            : error === NOT_READY
              ? t('thread.notReady')
              : error === BACKGROUND_FAILED
                ? t('thread.backgroundFailed')
                : error === ARCHIVED
                  ? t('thread.archivedSend')
                  : error

  useEffect(() => {
    if (persistence.status !== 'ready') return
    for (const chat of snapshot.chats) {
      if (chat.stage === 'real') void sessionsRef.restore(chat.id)
    }
  }, [persistence.status, snapshot.chats, sessionsRef.restore])

  useEffect(() => {
    let reference: SessionReferenceLike | undefined
    try {
      reference = sessions.retain(sessionId, { source: 'controllerOperation' })
    } catch {
      return
    }
    let cancelled = false
    let unsubscribe = (): void => {}
    const retained = reference
    void retained.ready.then(binding => {
      if (cancelled) return
      const check = (): void => {
        if (binding.session.getSnapshot().removed === true) setParentUnavailable(true)
      }
      check()
      unsubscribe = binding.session.subscribe(check)
    }).catch(() => undefined)
    return () => {
      cancelled = true
      unsubscribe()
      retained.release()
    }
  }, [book, sessionId, sessions])

  const select = (chat: SideChat): void => {
    if (chat.status === 'archived' || chat.status === 'archiving') {
      setViewingArchivedId(chat.id)
    } else {
      setViewingArchivedId(undefined)
      if (chat.status === 'saved') book.setStatus(chat.id, 'open')
      book.setActive(chat.id)
    }
    setMenuOpen(false)
    setActionsOpen(false)
  }

  const archiveChat = (chat: SideChat): void => {
    book.setStatus(chat.id, 'archiving', 'manual')
    setViewingArchivedId(chat.id)
    setActionsOpen(false)
    setMenuOpen(false)
    void (async () => {
      let binding = sessionsRef.bindingOf(chat.id)
      if (binding === undefined && chat.sideSessionId !== undefined) {
        binding = await sessionsRef.restore(chat.id, true)
      }
      if (sessionsRef.isBusy(chat.id)) return
      if (binding !== undefined && binding.session.getSnapshot().running === true) return
      book.setStatus(chat.id, 'archived', 'manual')
    })()
  }

  useEffect(() => {
    const archiving = snapshot.chats.filter(chat => chat.status === 'archiving')
    if (archiving.length === 0) return
    const cleanups = archiving.map(chat => {
      const finish = (): void => {
        if (!sessionsRef.isBusy(chat.id)) book.setStatus(chat.id, 'archived', chat.archivedReason ?? 'manual')
      }
      const binding = sessionsRef.bindingOf(chat.id)
      if (binding === undefined) {
        if (chat.sideSessionId === undefined || sessionsRef.restoreFailed(chat.id)) finish()
        return () => {}
      }
      finish()
      const attempt = (): void => {
        if (book.get(chat.id)?.pendingSend === undefined) return
        if (sessionsRef.sending[chat.id] === true) return
        if (binding.session.getSnapshot().running === true) return
        if (reconcilingIds.current.has(chat.id)) return
        reconcilingIds.current.add(chat.id)
        void sessionsRef.reconcile(chat.id).then(result => {
          reconcilingIds.current.delete(chat.id)
          if (result === 'delivered') book.setStatus(chat.id, 'archived', chat.archivedReason ?? 'manual')
          else if (result === 'absent') setReconcileNote(t('thread.reconcileAbsent'))
        })
      }
      attempt()
      const unsubscribeSession = binding.session.subscribe(() => { finish(); attempt() })
      const unsubscribeEvents = binding.eventSource.subscribe(attempt)
      return () => { unsubscribeSession(); unsubscribeEvents() }
    })
    return () => { for (const cleanup of cleanups) cleanup() }
  }, [snapshot.chats, sessionsRef, sessionsRef.sending, sessionsRef.revision, book, t])

  const openChats = snapshot.chats.filter(chat => chat.status === 'open')
  const savedChats = snapshot.chats.filter(chat => chat.status === 'saved')
  const archivingChats = snapshot.chats.filter(chat => chat.status === 'archiving')
  const archivedChats = snapshot.chats.filter(chat => chat.status === 'archived')

  return (
    <div className="side-chat-pane">
      <header className="side-chat-pane__header">
        <button
          type="button"
          className="side-chat-pane__title"
          aria-haspopup="listbox"
          aria-expanded={menuOpen}
          onClick={() => setMenuOpen(open => !open)}
          disabled={snapshot.chats.length === 0}
        >
          {displayed?.title ?? t('panel.title')}
        </button>
        {active === undefined || archivedView !== undefined ? null : (
          <button
            type="button"
            className="side-chat-pane__action"
            aria-label={t('panel.actions')}
            title={t('panel.actions')}
            aria-expanded={actionsOpen}
            onClick={() => setActionsOpen(open => !open)}
          >
            ···
          </button>
        )}
        <button
          type="button"
          className="side-chat-pane__action"
          aria-label={t('panel.archiveBrowser')}
          title={t('panel.archiveBrowser')}
          onClick={() => { setArchiveBrowserOpen(true); setMenuOpen(false); setActionsOpen(false) }}
        >
          ▤
        </button>
        <button
          type="button"
          className="side-chat-pane__action"
          aria-label={t('panel.new')}
          title={t('panel.new')}
          onClick={() => { book.createDraft(); setViewingArchivedId(undefined); setMenuOpen(false); setActionsOpen(false) }}
        >
          +
        </button>
      </header>

      {archiveBrowserOpen ? (
        <ArchiveBrowser
          api={api}
          t={t}
          sessions={sessions}
          uiSession={uiSession}
          onClose={() => setArchiveBrowserOpen(false)}
        />
      ) : (
      <>
      {actionsOpen && active !== undefined ? (
        <div className="side-chat-pane__actions" role="menu">
          {active.status === 'open' ? (
            <button
              type="button"
              role="menuitem"
              className="side-chat-pane__menu-item"
              onClick={() => { book.setStatus(active.id, 'saved'); setActionsOpen(false) }}
            >
              {t('panel.close')}
            </button>
          ) : (
            <button
              type="button"
              role="menuitem"
              className="side-chat-pane__menu-item"
              onClick={() => { book.setStatus(active.id, 'open'); setActionsOpen(false) }}
            >
              {t('panel.restore')}
            </button>
          )}
          {active.status !== 'archived' && active.status !== 'archiving' ? (
            <button
              type="button"
              role="menuitem"
              className="side-chat-pane__menu-item"
              onClick={() => archiveChat(active)}
            >
              {t('panel.archive')}
            </button>
          ) : null}
        </div>
      ) : null}

      {menuOpen && snapshot.chats.length > 0 ? (
        <ul className="side-chat-pane__menu" role="listbox" aria-label={t('panel.select')}>
          {openChats.length > 0 ? <li className="side-chat-pane__menu-heading">{t('panel.openSection')}</li> : null}
          {openChats.map(chat => (
            <li key={chat.id}>
              <button
                type="button"
                role="option"
                aria-selected={chat.id === snapshot.activeId}
                className="side-chat-pane__menu-item"
                onClick={() => select(chat)}
              >
                <span>{chat.title}</span>
                <span className="side-chat-pane__menu-badge">
                  {chat.stage === 'draft' ? t('panel.draft') : t('panel.real')}
                </span>
              </button>
            </li>
          ))}
          {savedChats.length > 0 ? <li className="side-chat-pane__menu-heading">{t('panel.savedSection')}</li> : null}
          {savedChats.map(chat => (
            <li key={chat.id}>
              <button
                type="button"
                role="option"
                aria-selected={chat.id === snapshot.activeId && archivedView === undefined}
                className="side-chat-pane__menu-item"
                onClick={() => select(chat)}
              >
                <span>{chat.title}</span>
                <span className="side-chat-pane__menu-badge">{t('panel.saved')}</span>
              </button>
            </li>
          ))}
          {archivingChats.length > 0 ? <li className="side-chat-pane__menu-heading">{t('panel.archivingSection')}</li> : null}
          {archivingChats.map(chat => (
            <li key={chat.id}>
              <button
                type="button"
                role="option"
                aria-selected={chat.id === viewingArchivedId}
                className="side-chat-pane__menu-item"
                onClick={() => select(chat)}
              >
                <span>{chat.title}</span>
                <span className="side-chat-pane__menu-badge">{t('panel.archiving')}</span>
              </button>
            </li>
          ))}
          {archivedChats.length > 0 ? <li className="side-chat-pane__menu-heading">{t('panel.archivedSection')}</li> : null}
          {archivedChats.map(chat => (
            <li key={chat.id}>
              <button
                type="button"
                role="option"
                aria-selected={chat.id === viewingArchivedId}
                className="side-chat-pane__menu-item"
                onClick={() => select(chat)}
              >
                <span>{chat.title}</span>
                <span className="side-chat-pane__menu-badge">{t('panel.archived')}</span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}

      {parentUnavailable ? (
        <p className="side-chat-pane__banner">{t('thread.parentUnavailable')}</p>
      ) : null}
      {persistence.status === 'loading' ? (
        <p className="side-chat-pane__banner">{t('panel.loading')}</p>
      ) : null}
      {persistence.loadError === undefined ? null : (
        <p className="side-chat-pane__banner">{t('panel.loadFailed')}: {persistence.loadError}</p>
      )}
      {persistence.saveError === undefined ? null : (
        <p className="side-chat-pane__banner">{t('panel.saveFailed')}: {persistence.saveError}</p>
      )}

      {displayed === undefined ? (
        <div className="side-chat-pane__body">
          <p className="side-chat-pane__empty">{t('panel.empty')}</p>
          <p className="side-chat-pane__hint">{t('panel.hint')}</p>
        </div>
      ) : (
        <>
          {binding === undefined
            ? (
              <div className="side-chat-pane__thread">
                <p className="side-chat-pane__hint">
                  {displayed.stage === 'draft' ? t('thread.draft') : t('thread.sessionMissing')}
                </p>
              </div>
            )
            : <ChatThread binding={binding} t={t} uiSession={uiSession} backgroundEnvelopes={backgroundEnvelopes} />}
          {errorText === undefined ? null : <p className="side-chat-pane__error">{errorText}</p>}
          {displayed?.status === 'archived' ? (
            <p className="side-chat-pane__banner">{t('thread.archivedReadonly')}</p>
          ) : displayed?.status === 'archiving' ? (
            <p className="side-chat-pane__banner">{t('thread.archivingWait')}</p>
          ) : null}
          {displayed?.status === 'archiving' && displayed.pendingSend !== undefined ? (
            <div className="side-chat-pane__reconcile">
              <span>{reconcileNote ?? t('thread.reconcilePending')}</span>
              <button
                type="button"
                className="side-chat-pane__send"
                onClick={() => {
                  setReconcileNote(undefined)
                  void sessionsRef.reconcile(displayed.id).then(result => {
                    if (result === 'delivered') book.setStatus(displayed.id, 'archived', displayed.archivedReason ?? 'manual')
                    else if (result === 'absent') setReconcileNote(t('thread.reconcileAbsent'))
                  })
                }}
              >
                {t('thread.reconcileCheck')}
              </button>
              <button
                type="button"
                className="side-chat-pane__send"
                disabled={
                  binding === undefined
                  || sessionsRef.restoreFailed(displayed.id)
                  || sessionsRef.sending[displayed.id] === true
                  || binding.session.getSnapshot().running === true
                }
                onClick={() => {
                  void (async () => {
                    const chat = book.get(displayed.id)
                    const requestId = chat?.pendingSend?.requestId
                    if (chat === undefined || requestId === undefined) return
                    let current = sessionsRef.bindingOf(displayed.id)
                    if (current === undefined && chat.sideSessionId !== undefined) {
                      current = await sessionsRef.restore(displayed.id, true)
                    }
                    if (current === undefined) {
                      setReconcileNote(t('thread.reconcileUnavailable'))
                      return
                    }
                    if (sessionsRef.sending[displayed.id] === true || current.session.getSnapshot().running === true) {
                      setReconcileNote(t('thread.reconcileStillRunning'))
                      return
                    }
                    const latest = book.get(displayed.id)
                    if (latest?.pendingSend?.requestId !== requestId) return
                    const result = await sessionsRef.reconcile(displayed.id)
                    if (result === 'delivered') {
                      book.setStatus(displayed.id, 'archived', latest.archivedReason ?? 'manual')
                      return
                    }
                    if (result !== 'absent') {
                      setReconcileNote(t('thread.reconcileStillRunning'))
                      return
                    }
                    const after = book.get(displayed.id)
                    if (after?.pendingSend?.requestId !== requestId) return
                    book.clearPendingSend(displayed.id)
                    book.setStatus(displayed.id, 'archived', after.archivedReason ?? 'manual')
                  })()
                }}
              >
                {t('thread.reconcileDiscard')}
              </button>
            </div>
          ) : null}
          {readOnly ? null : (
          <>
          {unknownResult && displayed !== undefined ? (
            <div className="side-chat-pane__reconcile">
              <span>{t('thread.reconcileHint')}</span>
              <button
                type="button"
                className="side-chat-pane__send"
                onClick={() => { void sessionsRef.retryUnknown(displayed.id) }}
              >
                {t('thread.retryConfirmed')}
              </button>
            </div>
          ) : null}
          <div className="side-chat-pane__composer">
            {displayed.firstSendDone === true ? null : (
              <p className="side-chat-pane__context-hint">
                {displayed.pendingQuotes.length === 0 ? t('context.firstBackground') : t('context.firstQuotes')}
              </p>
            )}
            {displayed.pendingQuotes.length === 0 ? null : (
              <div className="side-chat-pane__quotes-head">
                <span>{t('quote.pending', { count: displayed.pendingQuotes.length })}</span>
                <button
                  type="button"
                  className="side-chat-pane__quote-clear"
                  onClick={() => book.clearQuotes(displayed.id)}
                >
                  {t('quote.clearAll')}
                </button>
              </div>
            )}
            {displayed.pendingQuotes.length === 0 ? null : (
              <ul className="side-chat-pane__quotes">
                {displayed.pendingQuotes.map(quote => (
                  <li key={quote.id} className="side-chat-pane__quote">
                    <span className="side-chat-pane__quote-label">{t('quote.cardLabel')}</span>
                    <span className="side-chat-pane__quote-text" title={quote.text}>{quote.text.slice(0, 160)}{quote.text.length > 160 ? '…' : ''}</span>
                    <button
                      type="button"
                      className="side-chat-pane__quote-remove"
                      aria-label={t('quote.remove')}
                      onClick={() => book.removeQuote(displayed.id, quote.id)}
                    >
                      ×
                    </button>
                  </li>
                ))}
              </ul>
            )}
            <textarea
              className="side-chat-pane__input"
              aria-label={t('composer.placeholder')}
              placeholder={t('composer.placeholder')}
              value={displayed.draftText}
              disabled={!ready}
              onChange={event => book.setDraftText(displayed.id, event.target.value)}
              onKeyDown={event => {
                if (!ready) return
                if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
                  event.preventDefault()
                  void sessionsRef.send(displayed.id)
                }
              }}
              rows={3}
            />
            <button
              type="button"
              className="side-chat-pane__send"
              onClick={() => { void sessionsRef.send(displayed.id) }}
              disabled={!ready || sending || displayed.draftText.trim().length === 0}
            >
              {sending ? t('composer.sending') : t('composer.send')}
            </button>
          </div>
          </>
          )}
        </>
      )}
      </>
      )}
    </div>
  )
}
