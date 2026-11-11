import { MAX_QUOTES, MAX_QUOTE_CHARS } from './quote-text.ts'
import type {
  IndependentChat,
  IndependentChatView,
  IndependentParentState,
  IndependentQuote,
  IndependentRpcRequest,
  IndependentStatus,
  ModelChoice,
} from '../shared/independent.ts'

export const INDEPENDENT_RPC_PATH = '/api/side-chat/independent'

type Envelope<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: { readonly code: string; readonly message: string } }

export class IndependentApiError extends Error {
  constructor(readonly code: string, message: string) {
    super(message)
    this.name = 'IndependentApiError'
  }
}

export interface ModelCatalog {
  readonly default: ModelChoice
  readonly models: readonly { provider: string; model: string; name: string; description?: string }[]
}

export class IndependentApi {
  private readonly listeners = new Set<() => void>()

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private notify(): void {
    for (const listener of this.listeners) listener()
  }

  private async rpc<T>(request: IndependentRpcRequest): Promise<T> {
    let response: Response
    try {
      response = await fetch(INDEPENDENT_RPC_PATH, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(request),
      })
    } catch (error) {
      throw new IndependentApiError('side-chat/network', error instanceof Error ? error.message : String(error))
    }
    let envelope: Envelope<T>
    try {
      envelope = await response.json() as Envelope<T>
    } catch (error) {
      throw new IndependentApiError('side-chat/bad-response', error instanceof Error ? error.message : String(error))
    }
    if (!envelope.ok) throw new IndependentApiError(envelope.error.code, envelope.error.message)
    return envelope.value
  }

  async list(parentId: string): Promise<IndependentParentState> {
    return this.rpc({ op: 'ind.list', parentId })
  }

  async create(parentId: string): Promise<IndependentChat> {
    const chat = await this.rpc<IndependentChat>({ op: 'ind.create', parentId })
    this.notify()
    return chat
  }

  async view(chatId: string): Promise<IndependentChatView | undefined> {
    return this.rpc<IndependentChatView | undefined>({ op: 'ind.get', chatId })
  }

  async draft(chatId: string, text: string): Promise<void> {
    await this.rpc({ op: 'ind.draft', chatId, text })
  }

  async addQuote(chatId: string, quote: IndependentQuote): Promise<void> {
    await this.rpc({ op: 'ind.quoteAdd', chatId, quote })
    this.notify()
  }

  async removeQuote(chatId: string, quoteId: string): Promise<void> {
    await this.rpc({ op: 'ind.quoteRemove', chatId, quoteId })
    this.notify()
  }

  async clearQuotes(chatId: string): Promise<void> {
    await this.rpc({ op: 'ind.quotesClear', chatId })
    this.notify()
  }

  async setActive(parentId: string, chatId?: string): Promise<void> {
    await this.rpc({ op: 'ind.active', parentId, ...(chatId === undefined ? {} : { chatId }) })
    this.notify()
  }

  async setStatus(chatId: string, status: IndependentStatus, reason?: 'manual' | 'parent-removed'): Promise<void> {
    await this.rpc({ op: 'ind.status', chatId, status, ...(reason === undefined ? {} : { reason }) })
    this.notify()
  }

  async setModel(chatId: string, model?: ModelChoice): Promise<void> {
    await this.rpc({ op: 'ind.model', chatId, ...(model === undefined ? {} : { model }) })
    this.notify()
  }

  async send(chatId: string, requestId: string, text: string, quoteIds?: readonly string[], background?: { text: string; fromSeq?: number; toSeq?: number }): Promise<IndependentChatView> {
    const view = await this.rpc<IndependentChatView>({ op: 'ind.send', chatId, requestId, text, ...(quoteIds === undefined ? {} : { quoteIds }), ...(background === undefined ? {} : { background }) })
    this.notify()
    return view
  }

  async delete(chatId: string): Promise<void> {
    await this.rpc({ op: 'ind.delete', chatId })
    this.notify()
  }

  async archived(): Promise<readonly IndependentChat[]> {
    return this.rpc({ op: 'ind.archived' })
  }

  async models(): Promise<ModelCatalog> {
    return this.rpc({ op: 'ind.models' })
  }

  async addQuoteToActive(parentId: string, quote: IndependentQuote): Promise<{ chatId: string; created: boolean }> {
    const state = await this.list(parentId)
    let chat = state.chats.find(item => item.id === state.activeId && item.status === 'open')
    let created = false
    if (chat === undefined) {
      chat = await this.create(parentId)
      created = true
    }
    if (quote.text.length > MAX_QUOTE_CHARS) throw new IndependentApiError('side-chat/quote-too-long', 'quote too long')
    if (chat.pendingQuotes.length >= MAX_QUOTES) throw new IndependentApiError('side-chat/quote-too-many', 'too many quotes')
    await this.addQuote(chat.id, quote)
    return { chatId: chat.id, created }
  }
}
