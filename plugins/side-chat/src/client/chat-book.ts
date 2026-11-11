import type { ArchivedReason, ChatBookSnapshot, ChatStatus, ContextMode, ContextSnapshot, PendingCreate, PendingSend, PersistedState, Quote, SentQuote, SideChat } from '../shared/types.ts'

export interface ChatBookOptions {
  readonly createId: () => string
  readonly now: () => number
}

/**
 * In-memory Side Chat collection for one Parent Session. Drafts and the active
 * pointer live here; durability and cross-session persistence are not wired yet.
 */
export class ChatBook {
  private readonly chats = new Map<string, SideChat>()
  private readonly order: string[] = []
  private activeId: string | undefined
  private readonly listeners = new Set<() => void>()
  private snapshot: ChatBookSnapshot = { chats: [], activeId: undefined }
  private restored = false

  constructor(
    private readonly parentId: string,
    private readonly options: ChatBookOptions,
  ) {}

  readonly getSnapshot = (): ChatBookSnapshot => this.snapshot

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  list(): readonly SideChat[] {
    return this.snapshot.chats
  }

  /** True once the persisted record has been applied or skipped. */
  isRestored(): boolean {
    return this.restored
  }

  /**
   * Apply a persisted record without dropping chats created while it was loading.
   * Persisted chats the user already has locally are skipped, and the active
   * pointer is only ever restored to an open chat.
   */
  hydrate(state: PersistedState | null): void {
    if (this.restored) return
    this.restored = true
    let changed = false
    for (const persisted of state?.chats ?? []) {
      if (this.chats.has(persisted.id)) continue
      const chat: SideChat = {
        id: persisted.id,
        parentId: this.parentId,
        title: persisted.title,
        stage: persisted.stage,
        status: persisted.status,
        ...(persisted.archivedReason === undefined ? {} : { archivedReason: persisted.archivedReason }),
        ...(persisted.sideSessionId === undefined ? {} : { sideSessionId: persisted.sideSessionId }),
        draftText: persisted.draftText,
        pendingQuotes: persisted.pendingQuotes ?? [],
        sentQuotes: persisted.sentQuotes ?? [],
        ...(persisted.contextSnapshot === undefined ? {} : { contextSnapshot: persisted.contextSnapshot }),
        ...(persisted.contextDelivered === undefined ? {} : { contextDelivered: persisted.contextDelivered }),
        ...(persisted.pendingSend === undefined ? {} : { pendingSend: persisted.pendingSend }),
        ...(persisted.pendingCreate === undefined ? {} : { pendingCreate: persisted.pendingCreate }),
        ...(persisted.firstSendDone === undefined ? {} : { firstSendDone: persisted.firstSendDone }),
        contextMode: persisted.contextMode,
        createdAt: persisted.createdAt,
        updatedAt: persisted.updatedAt,
      }
      if (chat.firstSendDone !== true && persisted.contextDelivered === true) chat.firstSendDone = true
      this.chats.set(chat.id, chat)
      this.order.push(chat.id)
      changed = true
    }
    const openIds = this.order.filter(id => this.chats.get(id)?.status === 'open')
    const current = this.activeId === undefined ? undefined : this.chats.get(this.activeId)
    if (current === undefined || current.status !== 'open') {
      this.activeId = state?.activeId !== undefined && openIds.includes(state.activeId)
        ? state.activeId
        : openIds[openIds.length - 1]
      changed = true
    }
    if (changed) this.publish()
  }

  /** The record to persist; it never carries the parent id, which keys the record. */
  exportState(): PersistedState {
    return {
      ...(this.activeId === undefined ? {} : { activeId: this.activeId }),
      chats: this.snapshot.chats.map(chat => ({
        id: chat.id,
        title: chat.title,
        stage: chat.stage,
        status: chat.status,
        ...(chat.archivedReason === undefined ? {} : { archivedReason: chat.archivedReason }),
        ...(chat.sideSessionId === undefined ? {} : { sideSessionId: chat.sideSessionId }),
        draftText: chat.draftText,
        pendingQuotes: chat.pendingQuotes,
        sentQuotes: chat.sentQuotes,
        ...(chat.contextSnapshot === undefined ? {} : { contextSnapshot: chat.contextSnapshot }),
        ...(chat.contextDelivered === undefined ? {} : { contextDelivered: chat.contextDelivered }),
        ...(chat.pendingSend === undefined ? {} : { pendingSend: chat.pendingSend }),
        ...(chat.pendingCreate === undefined ? {} : { pendingCreate: chat.pendingCreate }),
        ...(chat.firstSendDone === undefined ? {} : { firstSendDone: chat.firstSendDone }),
        contextMode: chat.contextMode,
        createdAt: chat.createdAt,
        updatedAt: chat.updatedAt,
      })),
    }
  }

  get(id: string): SideChat | undefined {
    return this.chats.get(id)
  }

  getActive(): SideChat | undefined {
    return this.activeId === undefined ? undefined : this.chats.get(this.activeId)
  }

  createDraft(contextMode: ContextMode = 'summary'): SideChat {
    const now = this.options.now()
    const id = this.options.createId()
    const chat: SideChat = {
      id,
      parentId: this.parentId,
      title: `侧聊 ${this.order.length + 1}`,
      stage: 'draft',
      status: 'open',
      draftText: '',
      pendingQuotes: [],
      sentQuotes: [],
      contextMode,
      createdAt: now,
      updatedAt: now,
    }
    this.chats.set(id, chat)
    this.order.push(id)
    this.activeId = id
    this.publish()
    return chat
  }

  setActive(id: string): void {
    if (!this.chats.has(id) || this.activeId === id) return
    this.activeId = id
    this.publish()
  }

  setDraftText(id: string, text: string): void {
    const chat = this.chats.get(id)
    if (!chat || chat.draftText === text) return
    chat.draftText = text
    chat.updatedAt = this.options.now()
    this.publish()
  }

  markReal(id: string, sideSessionId: string): void {
    const chat = this.chats.get(id)
    if (!chat) return
    chat.stage = 'real'
    chat.sideSessionId = sideSessionId
    chat.updatedAt = this.options.now()
    this.publish()
  }

  addQuote(id: string, quote: Quote): void {
    const chat = this.chats.get(id)
    if (!chat || chat.pendingQuotes.some(existing => existing.id === quote.id)) return
    chat.pendingQuotes = [...chat.pendingQuotes, quote]
    chat.updatedAt = this.options.now()
    this.publish()
  }

  removeQuote(id: string, quoteId: string): void {
    const chat = this.chats.get(id)
    if (!chat) return
    const next = chat.pendingQuotes.filter(quote => quote.id !== quoteId)
    if (next.length === chat.pendingQuotes.length) return
    chat.pendingQuotes = next
    chat.updatedAt = this.options.now()
    this.publish()
  }

  clearQuotes(id: string): void {
    const chat = this.chats.get(id)
    if (!chat || chat.pendingQuotes.length === 0) return
    chat.pendingQuotes = []
    chat.updatedAt = this.options.now()
    this.publish()
  }

  setPendingSend(id: string, pending: PendingSend): void {
    const chat = this.chats.get(id)
    if (!chat) return
    chat.pendingSend = pending
    chat.updatedAt = this.options.now()
    this.publish()
  }

  addSentQuotes(id: string, quotes: readonly SentQuote[]): void {
    const chat = this.chats.get(id)
    if (!chat || quotes.length === 0) return
    chat.sentQuotes = [...chat.sentQuotes, ...quotes]
    chat.updatedAt = this.options.now()
    this.publish()
  }

  setPendingCreate(id: string, pending: PendingCreate): void {
    const chat = this.chats.get(id)
    if (!chat) return
    chat.pendingCreate = pending
    chat.updatedAt = this.options.now()
    this.publish()
  }

  clearPendingCreate(id: string): void {
    const chat = this.chats.get(id)
    if (!chat || chat.pendingCreate === undefined) return
    delete chat.pendingCreate
    chat.updatedAt = this.options.now()
    this.publish()
  }

  clearPendingSend(id: string): void {
    const chat = this.chats.get(id)
    if (!chat || chat.pendingSend === undefined) return
    delete chat.pendingSend
    chat.updatedAt = this.options.now()
    this.publish()
  }

  setContextSnapshot(id: string, snapshot: ContextSnapshot): void {
    const chat = this.chats.get(id)
    if (!chat) return
    chat.contextSnapshot = snapshot
    chat.updatedAt = this.options.now()
    this.publish()
  }

  markContextDelivered(id: string): void {
    const chat = this.chats.get(id)
    if (!chat || chat.contextDelivered === true) return
    chat.contextDelivered = true
    chat.updatedAt = this.options.now()
    this.publish()
  }

  setStatus(id: string, status: ChatStatus, reason?: ArchivedReason): void {
    const chat = this.chats.get(id)
    if (!chat || (chat.status === status && chat.archivedReason === reason)) return
    chat.status = status
    if (reason === undefined) delete chat.archivedReason
    else chat.archivedReason = reason
    chat.updatedAt = this.options.now()
    if (status !== 'open' && this.activeId === id) {
      this.activeId = this.order.find(candidate => candidate !== id && this.chats.get(candidate)?.status === 'open')
    }
    this.publish()
  }

  /** Archive every chat of this Parent after a reliable parent-removal signal. */
  archiveAllForParent(reason: ArchivedReason): void {
    let changed = false
    for (const chat of this.chats.values()) {
      if (chat.status === 'archived') continue
      chat.status = 'archived'
      chat.archivedReason = reason
      chat.updatedAt = this.options.now()
      changed = true
    }
    if (changed) {
      this.activeId = undefined
      this.publish()
    }
  }

  markFirstSendDone(id: string): void {
    const chat = this.chats.get(id)
    if (!chat || chat.firstSendDone === true) return
    chat.firstSendDone = true
    chat.updatedAt = this.options.now()
    this.publish()
  }

  setContextMode(id: string, mode: ContextMode): void {
    const chat = this.chats.get(id)
    if (!chat || chat.contextMode === mode) return
    chat.contextMode = mode
    chat.updatedAt = this.options.now()
    this.publish()
  }

  remove(id: string): void {
    if (!this.chats.delete(id)) return
    const index = this.order.indexOf(id)
    if (index >= 0) this.order.splice(index, 1)
    if (this.activeId === id) {
      this.activeId = this.order.find(candidate => this.chats.get(candidate)?.status === 'open')
    }
    this.publish()
  }

  private publish(): void {
    this.snapshot = {
      chats: this.order.flatMap(id => {
        const chat = this.chats.get(id)
        return chat === undefined ? [] : [chat]
      }),
      activeId: this.activeId,
    }
    for (const listener of this.listeners) listener()
  }
}
