import { useCallback, useEffect, useState } from 'react'
import type { IndependentApi, ModelCatalog } from './independent-api.ts'
import type { SessionsServiceLike } from './host-api.ts'
import type { IndependentChat, IndependentChatView, IndependentParentState, ModelChoice } from '../shared/independent.ts'
import { buildParentBackground } from './independent-background.ts'

export interface IndependentChatsState {
  readonly parent: IndependentParentState | undefined
  readonly view: IndependentChatView | undefined
  readonly draft: string
  readonly sending: boolean
  readonly error: string | undefined
  readonly models: ModelCatalog | undefined
  readonly refresh: () => Promise<void>
  readonly select: (chatId: string) => Promise<void>
  readonly create: () => Promise<void>
  readonly setDraft: (text: string) => void
  readonly send: () => Promise<void>
  readonly removeQuote: (quoteId: string) => Promise<void>
  readonly clearQuotes: () => Promise<void>
  readonly archive: () => Promise<void>
  readonly setModel: (model: ModelChoice | undefined) => Promise<void>
}

export function useIndependentChats(api: IndependentApi, parentId: string, sessions: SessionsServiceLike): IndependentChatsState {
  const [parent, setParent] = useState<IndependentParentState | undefined>(undefined)
  const [view, setView] = useState<IndependentChatView | undefined>(undefined)
  const [draft, setDraftState] = useState('')
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string | undefined>(undefined)
  const [models, setModels] = useState<ModelCatalog | undefined>(undefined)

  const active: IndependentChat | undefined = parent?.chats.find(chat => chat.id === parent.activeId && chat.status === 'open')

  const loadView = useCallback(async (chatId: string | undefined): Promise<void> => {
    if (chatId === undefined) { setView(undefined); setDraftState(''); return }
    const next = await api.view(chatId)
    setView(next)
    setDraftState(next?.chat.draftText ?? '')
  }, [api])

  const refresh = useCallback(async (): Promise<void> => {
    try {
      const next = await api.list(parentId)
      setParent(next)
      const current = next.chats.find(chat => chat.id === next.activeId)
      await loadView(current?.id)
      setError(undefined)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }, [api, parentId, loadView])

  useEffect(() => {
    void refresh()
    void api.models().then(setModels).catch(() => undefined)
    const unsubscribe = api.subscribe(() => { void refresh() })
    return unsubscribe
  }, [api, refresh])

  useEffect(() => {
    if (view?.chat.status === 'archiving' && !view.messages.some(message => message.status === 'pending')) {
      void api.setStatus(view.chat.id, 'archived', view.chat.archivedReason ?? 'manual').catch(() => undefined)
    }
  }, [api, view])

  const select = useCallback(async (chatId: string): Promise<void> => {
    await api.setActive(parentId, chatId)
  }, [api, parentId])

  const create = useCallback(async (): Promise<void> => {
    await api.create(parentId)
  }, [api, parentId])

  const setDraft = useCallback((text: string): void => {
    setDraftState(text)
    if (view !== undefined) void api.draft(view.chat.id, text).catch(() => undefined)
  }, [api, view])

  const send = useCallback(async (): Promise<void> => {
    if (view === undefined || sending) return
    const text = draft.trim()
    if (text === '') return
    setSending(true)
    setError(undefined)
    try {
      let background: { text: string; fromSeq?: number; toSeq?: number } | undefined
      if (!view.chat.firstSendDone && view.chat.pendingQuotes.length === 0) {
        if (view.chat.backgroundText !== undefined && view.chat.backgroundText !== '') {
          background = {
            text: view.chat.backgroundText,
            ...(view.chat.backgroundFromSeq === undefined ? {} : { fromSeq: view.chat.backgroundFromSeq }),
            ...(view.chat.backgroundToSeq === undefined ? {} : { toSeq: view.chat.backgroundToSeq }),
          }
        } else {
          try {
            const snapshot = await buildParentBackground(sessions, parentId)
            if (snapshot.text !== '') background = snapshot
          } catch (cause) {
            setError(cause instanceof Error ? cause.message : String(cause))
            return
          }
        }
      }
      const requestId = `side-chat-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
      const next = await api.send(view.chat.id, requestId, text, view.chat.pendingQuotes.map(quote => quote.id), background)
      setView(next)
      setDraftState(next.chat.draftText)
      if (next.chat.status === 'archiving') await api.setStatus(next.chat.id, 'archived', next.chat.archivedReason ?? 'manual')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
      if (view !== undefined) {
        const latest = await api.view(view.chat.id).catch(() => undefined)
        if (latest !== undefined) setView(latest)
      }
    } finally {
      setSending(false)
    }
  }, [api, draft, parentId, sending, sessions, view])

  const removeQuote = useCallback(async (quoteId: string): Promise<void> => {
    if (view !== undefined) await api.removeQuote(view.chat.id, quoteId)
  }, [api, view])

  const clearQuotes = useCallback(async (): Promise<void> => {
    if (view !== undefined) await api.clearQuotes(view.chat.id)
  }, [api, view])

  const archive = useCallback(async (): Promise<void> => {
    if (view === undefined) return
    const busy = sending || view.messages.some(message => message.status === 'pending')
    await api.setStatus(view.chat.id, busy ? 'archiving' : 'archived', 'manual')
  }, [api, sending, view])

  const setModel = useCallback(async (model: ModelChoice | undefined): Promise<void> => {
    if (view !== undefined) await api.setModel(view.chat.id, model)
  }, [api, view])

  return {
    parent, view, draft, sending, error, models,
    refresh, select, create, setDraft, send, removeQuote, clearQuotes, archive, setModel,
  }
}
