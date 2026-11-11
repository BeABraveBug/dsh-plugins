import { ChatBook } from './chat-book.ts'
import { MAX_QUOTES, MAX_QUOTE_CHARS } from './quote-text.ts'
import type { ChatBookSnapshot } from '../shared/types.ts'

export interface QuoteRequest {
  readonly text: string
  readonly sourceSessionId?: string
  readonly sourceNodeKey?: string
}

export type QuoteDelivery =
  | { readonly ok: true; readonly chatId: string; readonly created: boolean }
  | { readonly ok: false; readonly code: 'too-many' | 'too-long' | 'empty' }

/**
 * One process-lifetime owner of the in-memory ChatBooks, shared by the panel and
 * the selection overlay so a quote can reach the Parent's active chat even while
 * the panel is collapsed.
 */
export class SideChatHub {
  private readonly books = new Map<string, ChatBook>()

  constructor(private readonly options: { createId: () => string; now: () => number }) {}

  bookFor(parentId: string): ChatBook {
    const existing = this.books.get(parentId)
    if (existing !== undefined) return existing
    const book = new ChatBook(parentId, this.options)
    this.books.set(parentId, book)
    return book
  }

  snapshotOf(parentId: string): ChatBookSnapshot {
    return this.bookFor(parentId).getSnapshot()
  }

  deliverQuote(parentId: string, request: QuoteRequest): QuoteDelivery {
    const text = request.text.trim()
    if (text === '') return { ok: false, code: 'empty' }
    if (text.length > MAX_QUOTE_CHARS) return { ok: false, code: 'too-long' }
    const book = this.bookFor(parentId)
    let chat = book.getActive()
    const created = chat === undefined || chat.status !== 'open'
    if (created) chat = book.createDraft()
    if (chat === undefined) return { ok: false, code: 'empty' }
    if (chat.pendingQuotes.length >= MAX_QUOTES) return { ok: false, code: 'too-many' }
    book.addQuote(chat.id, {
      id: this.options.createId(),
      text,
      createdAt: this.options.now(),
      ...(request.sourceSessionId === undefined ? {} : { sourceSessionId: request.sourceSessionId }),
      ...(request.sourceNodeKey === undefined ? {} : { sourceNodeKey: request.sourceNodeKey }),
    })
    return { ok: true, chatId: chat.id, created }
  }
}
