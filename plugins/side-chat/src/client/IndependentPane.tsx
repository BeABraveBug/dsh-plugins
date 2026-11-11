import { useMemo, useState } from 'react'
import type { Translate } from './i18n.ts'
import type { SessionsServiceLike } from './host-api.ts'
import type { IndependentApi } from './independent-api.ts'
import type { IndependentChat, IndependentChatView, IndependentMessage, ModelChoice } from '../shared/independent.ts'
import { useIndependentChats } from './use-independent-chats.ts'

function Quotes({ message }: { message: IndependentMessage }) {
  if (message.quotes.length === 0) return null
  return (
    <ul className="side-chat-pane__quotes">
      {message.quotes.map(quote => (
        <li key={quote.id} className="side-chat-pane__quote">
          <span className="side-chat-pane__quote-label">引用</span>
          <span className="side-chat-pane__quote-text" title={quote.text}>{quote.text.slice(0, 160)}{quote.text.length > 160 ? '…' : ''}</span>
        </li>
      ))}
    </ul>
  )
}

function Thread({ view, t }: { view: IndependentChatView; t: Translate }) {
  return (
    <div className="side-chat-pane__thread">
      {view.messages.length === 0 ? <p className="side-chat-pane__hint">{t('thread.empty')}</p> : null}
      {view.messages.map(message => (
        <article key={message.id} className={`side-chat-pane__message side-chat-pane__message--${message.role}`}>
          <span className="side-chat-pane__role">{message.role === 'user' ? t('thread.roleUser') : t('thread.roleAssistant')}</span>
          <p className="side-chat-pane__text">{message.text}</p>
          <Quotes message={message} />
          {message.status === 'pending' ? <p className="side-chat-pane__hint">{t('thread.running')}</p> : null}
          {message.status === 'error' ? <p className="side-chat-pane__error">{message.error ?? t('thread.agentFailed')}</p> : null}
        </article>
      ))}
    </div>
  )
}

function ArchiveBrowser({ api, t, onClose }: { api: IndependentApi; t: Translate; onClose: () => void }) {
  const [items, setItems] = useState<readonly IndependentChat[] | undefined>(undefined)
  const [selected, setSelected] = useState<IndependentChatView | undefined>(undefined)
  const [error, setError] = useState<string | undefined>(undefined)
  useMemo(() => {
    if (items !== undefined) return
    void api.archived().then(setItems).catch(cause => setError(String(cause)))
  }, [api, items])
  if (selected !== undefined) {
    return (
      <div className="side-chat-pane__archive-view">
        <div className="side-chat-pane__archive-head">
          <button type="button" className="side-chat-pane__quote-clear" onClick={() => setSelected(undefined)}>{t('panel.archiveBack')}</button>
          <span className="side-chat-pane__archive-parent">{t('panel.archivedParent')}: {selected.chat.parentSessionId}</span>
        </div>
        <Thread view={selected} t={t} />
        <p className="side-chat-pane__banner">{selected.chat.status === 'archiving' ? t('thread.archivingWait') : t('thread.archivedReadonly')}</p>
        <button
          type="button"
          className="side-chat-pane__quote-clear"
          onClick={() => {
            if (!window.confirm(t('panel.deletePermanentHint'))) return
            void api.delete(selected.chat.id).then(() => { setSelected(undefined); setItems(undefined) }).catch(cause => setError(String(cause)))
          }}
        >
          {t('panel.deletePermanent')}
        </button>
      </div>
    )
  }
  return (
    <div className="side-chat-pane__archive-view">
      <div className="side-chat-pane__archive-head">
        <strong>{t('panel.archiveBrowser')}</strong>
        <button type="button" className="side-chat-pane__quote-clear" onClick={onClose}>{t('panel.cancel')}</button>
      </div>
      {error !== undefined ? <p className="side-chat-pane__error">{t('panel.archiveLoadFailed')}: {error}</p> : null}
      {items === undefined && error === undefined ? <p className="side-chat-pane__hint">{t('panel.loading')}</p> : null}
      {items !== undefined && items.length === 0 ? <p className="side-chat-pane__hint">{t('panel.archiveEmpty')}</p> : null}
      <ul className="side-chat-pane__archive-list">
        {(items ?? []).map(item => (
          <li key={item.id}>
            <button
              type="button"
              className="side-chat-pane__menu-item"
              onClick={() => { void api.view(item.id).then(setSelected).catch(cause => setError(String(cause))) }}
            >
              <span>{item.title}</span>
              <span className="side-chat-pane__menu-badge">{item.status === 'archiving' ? t('panel.archiving') : item.parentSessionId.slice(0, 12)}</span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  )
}

export function IndependentPane({ sessionId, t, sessions, api }: {
  sessionId: string
  t: Translate
  sessions: SessionsServiceLike
  api: IndependentApi
}) {
  const chats = useIndependentChats(api, sessionId, sessions)
  const [menuOpen, setMenuOpen] = useState(false)
  const [actionsOpen, setActionsOpen] = useState(false)
  const [archiveOpen, setArchiveOpen] = useState(false)
  const view = chats.view
  const chat = view?.chat
  const active = chats.parent?.chats.find(item => item.id === chats.parent?.activeId && item.status === 'open')
  const openChats = chats.parent?.chats.filter(item => item.status === 'open') ?? []
  const savedChats = chats.parent?.chats.filter(item => item.status === 'saved') ?? []
  const archivingChats = chats.parent?.chats.filter(item => item.status === 'archiving') ?? []
  const archivedChats = chats.parent?.chats.filter(item => item.status === 'archived') ?? []
  const currentModel = chat?.model

  const select = (id: string): void => {
    setMenuOpen(false)
    const item = chats.parent?.chats.find(chat => chat.id === id)
    void (async () => {
      if (item?.status === 'saved') await api.setStatus(id, 'open')
      await chats.select(id)
    })()
  }

  return (
    <div className="side-chat-pane">
      <header className="side-chat-pane__header">
        <button type="button" className="side-chat-pane__title" aria-haspopup="listbox" aria-expanded={menuOpen} onClick={() => setMenuOpen(open => !open)} disabled={(chats.parent?.chats.length ?? 0) === 0}>
          {chat?.title ?? t('panel.title')}
        </button>
        {chat === undefined || chat.status !== 'open' ? null : (
          <button type="button" className="side-chat-pane__action" aria-label={t('panel.actions')} aria-expanded={actionsOpen} onClick={() => setActionsOpen(open => !open)}>···</button>
        )}
        <button type="button" className="side-chat-pane__action" aria-label={t('panel.archiveBrowser')} onClick={() => setArchiveOpen(true)}>▤</button>
        <button type="button" className="side-chat-pane__action" aria-label={t('panel.new')} onClick={() => { void chats.create(); setMenuOpen(false); setActionsOpen(false) }}>+</button>
      </header>

      {archiveOpen ? <ArchiveBrowser api={api} t={t} onClose={() => setArchiveOpen(false)} /> : (
        <>
          {actionsOpen && chat !== undefined ? (
            <div className="side-chat-pane__actions" role="menu">
              <button type="button" role="menuitem" className="side-chat-pane__menu-item" onClick={() => { void api.setStatus(chat.id, 'saved'); setActionsOpen(false) }}>{t('panel.close')}</button>
              <button type="button" role="menuitem" className="side-chat-pane__menu-item" onClick={() => { void chats.archive(); setActionsOpen(false) }}>{t('panel.archive')}</button>
            </div>
          ) : null}

          {menuOpen ? (
            <ul className="side-chat-pane__menu" role="listbox" aria-label={t('panel.select')}>
              {openChats.length > 0 ? <li className="side-chat-pane__menu-heading">{t('panel.openSection')}</li> : null}
              {openChats.map(item => (
                <li key={item.id}>
                  <button type="button" role="option" aria-selected={item.id === active?.id} className="side-chat-pane__menu-item" onClick={() => select(item.id)}>
                    <span>{item.title}</span><span className="side-chat-pane__menu-badge">{t('panel.real')}</span>
                  </button>
                </li>
              ))}
              {savedChats.length > 0 ? <li className="side-chat-pane__menu-heading">{t('panel.savedSection')}</li> : null}
              {savedChats.map(item => (
                <li key={item.id}><button type="button" role="option" className="side-chat-pane__menu-item" onClick={() => select(item.id)}><span>{item.title}</span><span className="side-chat-pane__menu-badge">{t('panel.saved')}</span></button></li>
              ))}
              {archivingChats.length + archivedChats.length > 0 ? <li className="side-chat-pane__menu-heading">{t('panel.archivedSection')}</li> : null}
              {[...archivingChats, ...archivedChats].map(item => (
                <li key={item.id}><button type="button" role="option" className="side-chat-pane__menu-item" onClick={() => select(item.id)}><span>{item.title}</span><span className="side-chat-pane__menu-badge">{item.status === 'archiving' ? t('panel.archiving') : t('panel.archived')}</span></button></li>
              ))}
            </ul>
          ) : null}

          {chats.error !== undefined ? (
            <p className="side-chat-pane__error">{chats.error.startsWith('side-chat/model-') ? t('thread.modelFailed') : chats.error}</p>
          ) : null}
          {view === undefined ? (
            <div className="side-chat-pane__body">
              <p className="side-chat-pane__empty">{t('panel.empty')}</p>
              <p className="side-chat-pane__hint">{t('panel.hint')}</p>
            </div>
          ) : (
            <>
              <Thread view={view} t={t} />
              {chat?.status === 'archived' ? <p className="side-chat-pane__banner">{t('thread.archivedReadonly')}</p> : null}
              {chat?.status === 'archiving' ? <p className="side-chat-pane__banner">{t('thread.archivingWait')}</p> : null}
              {chat?.status === 'open' ? (
                <div className="side-chat-pane__composer">
                  <label className="side-chat-pane__context">
                    <span>{t('panel.model')}</span>
                    <select
                      className="side-chat-pane__context-select"
                      value={currentModel === undefined ? '' : `${currentModel.provider}/${currentModel.model}`}
                      onChange={event => {
                        if (event.target.value === '') { void chats.setModel(undefined); return }
                        const [provider, ...rest] = event.target.value.split('/')
                        const model = rest.join('/')
                        void chats.setModel({ provider, model })
                      }}
                    >
                      <option value="">{t('panel.modelDefault')}</option>
                      {(chats.models?.models ?? []).map(item => (
                        <option key={`${item.provider}/${item.model}`} value={`${item.provider}/${item.model}`}>{item.name}</option>
                      ))}
                    </select>
                  </label>
                  {chat.pendingQuotes.length === 0 ? null : (
                    <div className="side-chat-pane__quotes-head">
                      <span>{t('quote.pending', { count: chat.pendingQuotes.length })}</span>
                      <button type="button" className="side-chat-pane__quote-clear" onClick={() => { void chats.clearQuotes() }}>{t('quote.clearAll')}</button>
                    </div>
                  )}
                  {chat.pendingQuotes.length === 0 ? null : (
                    <ul className="side-chat-pane__quotes">
                      {chat.pendingQuotes.map(quote => (
                        <li key={quote.id} className="side-chat-pane__quote">
                          <span className="side-chat-pane__quote-label">{t('quote.cardLabel')}</span>
                          <span className="side-chat-pane__quote-text" title={quote.text}>{quote.text.slice(0, 160)}{quote.text.length > 160 ? '…' : ''}</span>
                          <button type="button" className="side-chat-pane__quote-remove" aria-label={t('quote.remove')} onClick={() => { void chats.removeQuote(quote.id) }}>×</button>
                        </li>
                      ))}
                    </ul>
                  )}
                  <textarea
                    className="side-chat-pane__input"
                    aria-label={t('composer.placeholder')}
                    placeholder={t('composer.placeholder')}
                    value={chats.draft}
                    onChange={event => chats.setDraft(event.target.value)}
                    onKeyDown={event => {
                      if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
                        event.preventDefault()
                        void chats.send()
                      }
                    }}
                    rows={3}
                  />
                  <button type="button" className="side-chat-pane__send" onClick={() => { void chats.send() }} disabled={chats.sending || chats.draft.trim() === ''}>
                    {chats.sending ? t('composer.sending') : t('composer.send')}
                  </button>
                </div>
              ) : null}
            </>
          )}
        </>
      )}
    </div>
  )
}
