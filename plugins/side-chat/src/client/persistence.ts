import { useCallback, useEffect, useRef, useState } from 'react'
import type { SideChatApi } from './api.ts'
import type { ChatBook } from './chat-book.ts'

export type PersistenceStatus = 'loading' | 'ready' | 'error'

export const NOT_READY = 'side-chat/not-ready'

export interface PersistenceState {
  readonly status: PersistenceStatus
  readonly loadError?: string
  readonly saveError?: string
  /** Persist the current book now and surface the write failure to the caller. */
  readonly flush: () => Promise<void>
}

const SAVE_DELAY_MS = 500

/**
 * Loads the parent's persisted chat record into the book and saves later changes
 * through the Host route. Saves debounce; a failed save keeps the local state and
 * reports the error instead of pretending it was stored.
 */
export function useChatPersistence(book: ChatBook, api: SideChatApi, parentId: string): PersistenceState {
  const [status, setStatus] = useState<PersistenceStatus>('loading')
  const [loadError, setLoadError] = useState<string | undefined>(undefined)
  const [saveError, setSaveError] = useState<string | undefined>(undefined)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const disposed = useRef(false)
  const statusRef = useRef<PersistenceStatus>('loading')

  const flush = useCallback(async (): Promise<void> => {
    if (statusRef.current !== 'ready') throw new Error(NOT_READY)
    if (timer.current !== undefined) {
      clearTimeout(timer.current)
      timer.current = undefined
    }
    await api.save(parentId, book.exportState())
  }, [api, book, parentId])

  useEffect(() => {
    let cancelled = false
    statusRef.current = 'loading'
    setStatus('loading')
    setLoadError(undefined)
    api.load(parentId).then(state => {
      if (cancelled) return
      book.hydrate(state)
      statusRef.current = 'ready'
      setStatus('ready')
    }).catch((error: unknown) => {
      if (cancelled) return
      const message = error instanceof Error ? error.message : String(error)
      setLoadError(message)
      statusRef.current = 'error'
      setStatus('error')
    })
    return () => { cancelled = true }
  }, [api, book, parentId])

  useEffect(() => {
    if (status !== 'ready') return
    const save = (): void => {
      timer.current = undefined
      api.save(parentId, book.exportState()).then(() => {
        if (!disposed.current) setSaveError(undefined)
      }).catch((error: unknown) => {
        if (disposed.current) return
        setSaveError(error instanceof Error ? error.message : String(error))
      })
    }
    const criticalSignature = (): string => book.exportState().chats
      .map(chat => `${chat.id}:${chat.stage}:${chat.status}:${chat.archivedReason ?? ''}:${chat.firstSendDone === true ? 1 : 0}:${chat.sideSessionId ?? ''}:${chat.pendingSend?.requestId ?? ''}`)
      .join('|')
    let lastCritical = criticalSignature()
    if (book.list().length > 0) void save()
    const unsubscribe = book.subscribe(() => {
      const next = criticalSignature()
      const criticalChanged = next !== lastCritical
      lastCritical = next
      if (timer.current !== undefined) clearTimeout(timer.current)
      if (criticalChanged) {
        timer.current = undefined
        save()
        return
      }
      timer.current = setTimeout(save, SAVE_DELAY_MS)
    })
    return () => {
      unsubscribe()
      if (timer.current !== undefined) {
        clearTimeout(timer.current)
        timer.current = undefined
        save()
      }
    }
  }, [api, book, parentId, status])

  useEffect(() => () => { disposed.current = true }, [])

  return { status, loadError, saveError, flush }
}
