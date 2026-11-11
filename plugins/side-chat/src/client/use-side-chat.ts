import { useCallback, useRef, useState } from 'react'
import type { ChatBook } from './chat-book.ts'
import { BACKGROUND_BUDGET, selectBackground } from './context.ts'
import type { SessionBindingLike, SessionReferenceLike, SessionsServiceLike, WorkspacesServiceLike } from './host-api.ts'
import { collectMessages } from './messages.ts'
import { composePrompt } from './quote-text.ts'
import { createOptionsFor } from './session-options.ts'
import type { ContextSnapshot, PendingSend, Quote } from '../shared/types.ts'
import { NOT_READY } from './persistence.ts'

export const UNKNOWN_RESULT = 'side-chat/unknown-result'
export const CREATE_UNKNOWN = 'side-chat/create-unknown'
export const SESSION_UNAVAILABLE = 'side-chat/session-unavailable'
export const SAVE_FAILED = 'side-chat/save-failed'
export const BACKGROUND_FAILED = 'side-chat/background-failed'
export const ARCHIVED = 'side-chat/archived'

export interface SideChatSessionRefs {
  readonly bindingOf: (chatId: string) => SessionBindingLike | undefined
  readonly restore: (chatId: string, force?: boolean) => Promise<SessionBindingLike | undefined>
  readonly release: (chatId: string) => void
  readonly send: (chatId: string) => Promise<void>
  readonly retryUnknown: (chatId: string) => Promise<void>
  readonly sending: Readonly<Record<string, boolean>>
  readonly errors: Readonly<Record<string, string>>
  readonly isBusy: (chatId: string) => boolean
  readonly restoreFailed: (chatId: string) => boolean
  readonly revision: number
  readonly reconcile: (chatId: string) => Promise<'none' | 'delivered' | 'absent' | 'unknown'>
}

interface SubmittedSnapshot {
  readonly text: string
  readonly quotes: readonly Quote[]
  readonly contextSnapshot?: ContextSnapshot
  readonly firstSendDone: boolean
}

function describeFailure(code: string | undefined, message: string | undefined, fallback: string): string {
  if (message !== undefined && message.length > 0) return code === undefined ? message : `${code}: ${message}`
  return code ?? fallback
}

/**
 * Only rejections that prove the message was not accepted count as definite.
 * Carrier failures (`gateway/internal` and friends) fold into the error branch,
 * so anything outside this set is treated as an unknown outcome.
 */
export function isDefiniteRejection(code: string | undefined): boolean {
  if (code === undefined) return false
  return code === 'gateway/bad-request'
    || code === 'gateway/arguments-invalid'
    || code === 'remote-access/denied'
    || code === 'session/not-found'
    || code === 'session/conflict'
    || code === 'session/writer-held'
    || code === 'session/agent-busy'
}

function submissionBlocked(status: string | undefined): boolean {
  return status === 'archiving' || status === 'archived'
}

function latestSeq(entries: readonly unknown[]): number | undefined {
  let latest: number | undefined
  for (const entry of entries) {
    const record = entry as { type?: unknown; event?: { seq?: unknown } }
    if (record?.type !== 'event') continue
    const seq = record.event?.seq
    if (typeof seq === 'number' && (latest === undefined || seq > latest)) latest = seq
  }
  return latest
}

function messagesWithin(entries: readonly unknown[], cutoff: number | undefined): ReturnType<typeof collectMessages> {
  const messages = collectMessages(entries as never)
  return cutoff === undefined ? messages : messages.filter(message => message.seq === undefined || message.seq <= cutoff)
}

let requestCounter = 0
function mintRequestId(): string {
  return `side-chat-${Date.now().toString(36)}-${(requestCounter += 1)}`
}

function mintSessionId(): string {
  const random = typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`
  return `session-${random}`
}

function hasDurableRequest(binding: SessionBindingLike, requestId: string): boolean {
  const entries = binding.eventSource.getSnapshot().entries
  for (const entry of entries) {
    if (typeof entry !== 'object' || entry === null) continue
    const record = entry as { type?: unknown; event?: { type?: unknown; data?: Record<string, unknown> } }
    if (record.type !== 'event' || record.event?.type !== 'user/message') continue
    const data = record.event.data ?? {}
    const source = typeof data.source === 'object' && data.source !== null
      ? data.source as Record<string, unknown>
      : {}
    if (data.rpcId === requestId || data.requestId === requestId || source.rpcId === requestId) return true
  }
  return false
}

/**
 * Owns the real Session behind each side chat. A recorded sideSessionId is only
 * ever restored, never replaced. A submission identity is written to the Host
 * record before the prompt leaves the browser, and unknown outcomes stay blocked
 * until the durable log proves acceptance or the user confirms a retry.
 */
export function useSideChatSessions(
  book: ChatBook,
  sessions: SessionsServiceLike,
  workspaces: WorkspacesServiceLike | undefined,
  parentSessionId: string,
  persist: () => Promise<void>,
): SideChatSessionRefs {
  const [sending, setSending] = useState<Readonly<Record<string, boolean>>>({})
  const [errors, setErrors] = useState<Readonly<Record<string, string>>>({})
  const [revision, setRevision] = useState(0)
  const sendingRef = useRef(new Set<string>())
  const failedRestores = useRef(new Set<string>())
  const restoringRef = useRef(new Map<string, Promise<SessionBindingLike | undefined>>())
  const bindingRef = useRef(new Map<string, SessionBindingLike>())
  const referenceRef = useRef(new Map<string, SessionReferenceLike>())

  const bindingOf = useCallback((chatId: string) => bindingRef.current.get(chatId), [])

  const setError = useCallback((chatId: string, message: string | undefined) => {
    setErrors(previous => {
      const next = { ...previous }
      if (message === undefined) delete next[chatId]
      else next[chatId] = message
      return next
    })
  }, [])

  const restore = useCallback(async (chatId: string, force = false): Promise<SessionBindingLike | undefined> => {
    const existing = bindingRef.current.get(chatId)
    if (existing !== undefined) return existing
    const inFlight = restoringRef.current.get(chatId)
    if (inFlight !== undefined) return inFlight
    if (!force && failedRestores.current.has(chatId)) return undefined
    const chat = book.get(chatId)
    if (chat?.sideSessionId === undefined) return undefined
    const sessionId = chat.sideSessionId
    const attempt = (async (): Promise<SessionBindingLike | undefined> => {
      let reference: SessionReferenceLike | undefined
      try {
        reference = sessions.retain(sessionId, { source: 'controllerOperation' })
        const binding = await reference.ready
        referenceRef.current.set(chatId, reference)
        bindingRef.current.set(chatId, binding)
        failedRestores.current.delete(chatId)
        setRevision(value => value + 1)
        return binding
      } catch {
        reference?.release()
        failedRestores.current.add(chatId)
        setError(chatId, SESSION_UNAVAILABLE)
        return undefined
      }
    })()
    restoringRef.current.set(chatId, attempt)
    void attempt.then(() => {
      if (restoringRef.current.get(chatId) === attempt) restoringRef.current.delete(chatId)
    })
    return attempt
  }, [book, sessions, setError])

  const release = useCallback((chatId: string) => {
    referenceRef.current.get(chatId)?.release()
    referenceRef.current.delete(chatId)
    bindingRef.current.delete(chatId)
    failedRestores.current.delete(chatId)
    setRevision(value => value + 1)
  }, [])

  const complete = useCallback(async (
    chatId: string,
    submitted: { text: string; quoteIds: readonly string[]; quotes?: readonly Quote[]; contextInjected?: boolean; requestId?: string },
  ): Promise<void> => {
    const current = book.get(chatId)
    if (submitted.quotes !== undefined && submitted.quotes.length > 0) {
      book.addSentQuotes(chatId, submitted.quotes.map(quote => ({
        quote,
        ...(submitted.requestId === undefined ? {} : { requestId: submitted.requestId }),
        sentAt: Date.now(),
      })))
    }
    book.clearPendingSend(chatId)
    for (const quoteId of submitted.quoteIds) book.removeQuote(chatId, quoteId)
    if (current !== undefined && current.draftText === submitted.text) book.setDraftText(chatId, '')
    book.markFirstSendDone(chatId)
    if (submitted.contextInjected === true) book.markContextDelivered(chatId)
    setError(chatId, undefined)
    await persist().catch(() => undefined)
  }, [book, persist, setError])

  const buildBackground = useCallback(async (parentId: string): Promise<ContextSnapshot> => {
    const reference = sessions.retain(parentId, { source: 'controllerOperation' })
    try {
      const binding = await reference.ready
      let window = binding.eventSource.getSnapshot()
      // Freeze the cutoff at acquisition time; later live messages must not enter.
      const cutoff = latestSeq(window.entries)
      let selection = selectBackground(messagesWithin(window.entries, cutoff), BACKGROUND_BUDGET)
      let pages = 0
      while (window.hasMore && !selection.stoppedAtOverflow && selection.text.length < BACKGROUND_BUDGET) {
        if (pages >= 20) throw new Error('side-chat/background-history-limit')
        const loader = binding.session.loadOlder
        if (typeof loader !== 'function') throw new Error('side-chat/background-no-history-loader')
        const before = window.entries.length
        try {
          await loader.call(binding.session)
        } catch {
          throw new Error('side-chat/background-load-failed')
        }
        const next = binding.eventSource.getSnapshot()
        if (next.entries.length <= before) throw new Error('side-chat/background-load-stalled')
        window = next
        selection = selectBackground(messagesWithin(window.entries, cutoff), BACKGROUND_BUDGET)
        pages += 1
      }
      if (window.hasMore && !selection.stoppedAtOverflow && selection.text.length < BACKGROUND_BUDGET) {
        throw new Error('side-chat/background-incomplete')
      }
      return {
        text: selection.text,
        createdAt: Date.now(),
        sourceSessionId: parentId,
        ...(selection.fromSeq === undefined ? {} : { sourceFromSeq: selection.fromSeq }),
        ...(selection.toSeq === undefined ? {} : { sourceToSeq: selection.toSeq }),
        ...(selection.truncated ? { truncated: true } : {}),
        budget: BACKGROUND_BUDGET,
      }
    } finally {
      reference.release()
    }
  }, [sessions])

  const run = useCallback(async (chatId: string, options: { forceRetry: boolean }): Promise<void> => {
    const chat = book.get(chatId)
    if (chat === undefined || sendingRef.current.has(chatId)) return

    if (chat.pendingSend !== undefined) {
      const binding = bindingRef.current.get(chatId) ?? await restore(chatId)
      if (binding !== undefined && hasDurableRequest(binding, chat.pendingSend.requestId)) {
        const pending = chat.pendingSend
        await complete(chatId, {
          text: pending.text,
          quoteIds: pending.quoteIds,
          ...(pending.quotes === undefined ? {} : { quotes: pending.quotes }),
          ...(pending.contextInjected === undefined ? {} : { contextInjected: pending.contextInjected }),
          requestId: pending.requestId,
        })
        return
      }
      if (!options.forceRetry) {
        setError(chatId, UNKNOWN_RESULT)
        return
      }
      book.clearPendingSend(chatId)
    }

    const text = chat.draftText.trim()
    if (text.length === 0) return
    const submitted: SubmittedSnapshot = {
      text,
      quotes: [...chat.pendingQuotes],
      ...(chat.contextSnapshot === undefined ? {} : { contextSnapshot: chat.contextSnapshot }),
      firstSendDone: chat.firstSendDone === true,
    }

    sendingRef.current.add(chatId)
    setSending(previous => ({ ...previous, [chatId]: true }))
    let requestId: string | undefined
    try {
      if (submissionBlocked(book.get(chatId)?.status)) {
        setError(chatId, ARCHIVED)
        return
      }

      let binding = bindingRef.current.get(chatId)
      if (binding === undefined && chat.sideSessionId !== undefined) {
        binding = await restore(chatId, true)
        if (binding === undefined) {
          setError(chatId, SESSION_UNAVAILABLE)
          return
        }
      }
      if (chat.stage === 'real' && chat.sideSessionId === undefined) {
        setError(chatId, SESSION_UNAVAILABLE)
        return
      }

      let first = submitted.firstSendDone !== true
      if (first) {
        const current = book.get(chatId) ?? chat
        if (current.contextDelivered === true) {
          book.markFirstSendDone(chatId)
          first = false
        } else if (binding !== undefined) {
          const snapshot = binding.session.getSnapshot()
          const window = binding.eventSource.getSnapshot()
          const hasUser = collectMessages(window.entries as never).some(message => message.role === 'user')
          if (snapshot.blank === false || hasUser || (snapshot.blank !== true && window.hasMore)) {
            book.markFirstSendDone(chatId)
            first = false
          }
        }
      }

      let backgroundText: string | undefined
      if (first && submitted.quotes.length === 0) {
        let snapshot = submitted.contextSnapshot
        if (snapshot === undefined) {
          try {
            snapshot = await buildBackground(parentSessionId)
          } catch {
            setError(chatId, BACKGROUND_FAILED)
            return
          }
          book.setContextSnapshot(chatId, snapshot)
        }
        backgroundText = snapshot.text
      }
      const contextInjected = backgroundText !== undefined && backgroundText !== ''

      if (binding === undefined) {
        if (book.get(chatId)?.status === 'archived') {
          setError(chatId, ARCHIVED)
          return
        }
        const sessionId = chat.pendingCreate?.sessionId ?? mintSessionId()
        if (chat.pendingCreate === undefined) {
          book.setPendingCreate(chatId, { sessionId, createdAt: Date.now() })
        }
        // The identity must reach the Host record before create can have any effect,
        // including on a retry after an earlier save failure.
        try {
          await persist()
        } catch (error) {
          setError(chatId, error instanceof Error && error.message === NOT_READY ? NOT_READY : SAVE_FAILED)
          return
        }
        if (submissionBlocked(book.get(chatId)?.status)) {
          setError(chatId, ARCHIVED)
          return
        }
        try {
          await sessions.create({ sessionId, ...createOptionsFor(sessions.list?.getSnapshot(), workspaces?.list.getSnapshot(), parentSessionId) })
        } catch {
          setError(chatId, CREATE_UNKNOWN)
          return
        }
        book.clearPendingCreate(chatId)
        book.markReal(chatId, sessionId)
        try {
          await persist()
        } catch {
          setError(chatId, SAVE_FAILED)
          return
        }
        const reference = sessions.retain(sessionId, { source: 'controllerOperation' })
        referenceRef.current.set(chatId, reference)
        try {
          binding = await reference.ready
        } catch {
          referenceRef.current.delete(chatId)
          reference.release()
          setError(chatId, SESSION_UNAVAILABLE)
          return
        }
        bindingRef.current.set(chatId, binding)
        setRevision(value => value + 1)
      }

      const promptText = composePrompt(submitted.text, submitted.quotes, backgroundText)
      const handle = binding.session.beginSubmission?.({ mode: 'queue', text: promptText, attachments: [] })
      requestId = handle?.requestId ?? mintRequestId()
      const pending: PendingSend = {
        requestId,
        text: submitted.text,
        quoteIds: submitted.quotes.map(quote => quote.id),
        quotes: submitted.quotes,
        contextInjected,
        createdAt: Date.now(),
      }
      book.setPendingSend(chatId, pending)
      try {
        await persist()
      } catch (error) {
        book.clearPendingSend(chatId)
        setError(chatId, error instanceof Error && error.message === NOT_READY ? NOT_READY : SAVE_FAILED)
        return
      }
      if (submissionBlocked(book.get(chatId)?.status)) {
        book.clearPendingSend(chatId)
        setError(chatId, ARCHIVED)
        return
      }

      let result
      try {
        result = await binding.session.prompt([{ type: 'text', text: promptText }], 'queue', undefined, requestId)
      } catch {
        setError(chatId, UNKNOWN_RESULT)
        return
      }
      if (!result.ok) {
        if (isDefiniteRejection(result.error.code)) {
          handle?.abandon?.()
          book.clearPendingSend(chatId)
          await persist().catch(() => undefined)
          setError(chatId, describeFailure(result.error.code, result.error.message, 'send failed'))
          return
        }
        setError(chatId, UNKNOWN_RESULT)
        return
      }
      await complete(chatId, {
        text: submitted.text,
        quoteIds: submitted.quotes.map(quote => quote.id),
        quotes: submitted.quotes,
        contextInjected,
        requestId,
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      setError(chatId, message)
    } finally {
      sendingRef.current.delete(chatId)
      setSending(previous => {
        const next = { ...previous }
        delete next[chatId]
        return next
      })
    }
  }, [book, sessions, workspaces, parentSessionId, persist, restore, complete, buildBackground, setError])

  const reconcile = useCallback(async (chatId: string): Promise<'none' | 'delivered' | 'absent' | 'unknown'> => {
    const chat = book.get(chatId)
    const pending = chat?.pendingSend
    if (chat === undefined || pending === undefined) return 'none'
    const binding = bindingRef.current.get(chatId) ?? await restore(chatId)
    if (binding === undefined) return 'unknown'
    if (binding.session.getSnapshot().running === true) return 'unknown'
    if (!hasDurableRequest(binding, pending.requestId)) return 'absent'
    await complete(chatId, {
      text: pending.text,
      quoteIds: pending.quoteIds,
      ...(pending.quotes === undefined ? {} : { quotes: pending.quotes }),
      ...(pending.contextInjected === undefined ? {} : { contextInjected: pending.contextInjected }),
      requestId: pending.requestId,
    })
    return 'delivered'
  }, [book, restore, complete])

  const isBusy = useCallback((chatId: string): boolean => {
    if (sendingRef.current.has(chatId)) return true
    const chat = book.get(chatId)
    if (chat?.pendingSend !== undefined) return true
    const binding = bindingRef.current.get(chatId)
    return binding?.session.getSnapshot().running === true
  }, [book])

  const send = useCallback((chatId: string) => run(chatId, { forceRetry: false }), [run])
  const retryUnknown = useCallback((chatId: string) => run(chatId, { forceRetry: true }), [run])

  return { bindingOf, restore, release, send, retryUnknown, sending, errors, isBusy, restoreFailed: (chatId: string) => failedRestores.current.has(chatId), revision, reconcile }
}
