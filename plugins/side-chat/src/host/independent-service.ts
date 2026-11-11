import type { IndependentChat, IndependentMessage, IndependentStatus, ModelChoice } from '../shared/independent.ts'
import type { DefaultModelLike, LlmStreamLike } from './model-gateway.ts'
import { generateReply } from './model-gateway.ts'
import type { IndependentStore } from './independent-store.ts'

export class IndependentService {
  constructor(
    private readonly store: IndependentStore,
    private readonly llm: LlmStreamLike,
    private readonly defaultModel: DefaultModelLike,
  ) {}

  list(parentId: string) {
    return this.store.listParent(parentId)
  }

  create(parentId: string, title?: string): IndependentChat {
    return this.store.createChat(parentId, title === undefined ? {} : { title })
  }

  get(chatId: string) {
    return this.store.view(chatId)
  }

  setActive(parentId: string, chatId?: string): void {
    this.store.setActive(parentId, chatId)
  }

  setStatus(chatId: string, status: IndependentStatus, reason?: 'manual' | 'parent-removed'): void {
    this.store.setStatus(chatId, status, reason)
  }

  draft(chatId: string, text: string): void {
    this.store.updateDraft(chatId, text)
  }

  addQuote(chatId: string, quote: Parameters<IndependentStore['addQuote']>[1]): void {
    this.store.addQuote(chatId, quote)
  }

  removeQuote(chatId: string, quoteId: string): void {
    this.store.removeQuote(chatId, quoteId)
  }

  clearQuotes(chatId: string): void {
    this.store.clearQuotes(chatId)
  }

  setModel(chatId: string, model?: ModelChoice): void {
    this.store.setModel(chatId, model)
  }

  delete(chatId: string): void {
    this.store.deleteChat(chatId)
  }

  archived(): readonly IndependentChat[] {
    return this.store.archived()
  }

  async models(): Promise<{ default: ModelChoice; models: readonly { provider: string; model: string; name: string; description?: string }[] }> {
    const entries: { provider: string; model: string; name: string; description?: string }[] = []
    for (const provider of this.llm.listProviders?.() ?? []) {
      try {
        for (const model of await this.llm.listModels?.(provider.id) ?? []) {
          entries.push({
            provider: model.provider,
            model: model.id,
            name: model.name,
            ...(model.description === undefined ? {} : { description: model.description }),
          })
        }
      } catch {
        // A provider with a broken catalog stays unlisted; selection still accepts explicit ids.
      }
    }
    return { default: this.defaultModel.currentSelection(), models: entries }
  }

  async send(chatId: string, input: { requestId: string; text: string; quoteIds?: readonly string[]; background?: { text: string; fromSeq?: number; toSeq?: number } }) {
    const chat = this.store.getChat(chatId)
    if (chat === undefined) throw new Error('side-chat/not-found')
    if (chat.status !== 'open') throw new Error('side-chat/not-open')
    const text = input.text.trim()
    if (text === '') throw new Error('side-chat/empty')
    const user = this.store.beginSend(chatId, { ...input, text })
    try {
      const selection = chat.model ?? this.defaultModel.currentSelection()
      if (selection.provider === '' || selection.model === '') throw new Error('side-chat/model-unavailable')
      const reply = await generateReply(this.llm, {
        selection,
        messages: this.store.messages(chatId).map(message => message.id === user.id ? { ...message, status: 'complete' as const } : message),
      })
      this.store.completeSend(chatId, input.requestId, reply)
      for (const quote of user.quotes) this.store.removeQuote(chatId, quote.id)
      if (this.store.getChat(chatId)?.draftText.trim() === text) this.store.updateDraft(chatId, '')
      return this.store.view(chatId)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.store.failSend(input.requestId, message)
      throw error
    }
  }
}
