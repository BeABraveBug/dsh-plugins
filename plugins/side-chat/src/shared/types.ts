/** Shared shapes for the Side Chat surface and its Host store. */

export type ContextMode = 'none' | 'summary'

export type ChatStage = 'draft' | 'real'

export type ChatStatus = 'open' | 'saved' | 'archiving' | 'archived'

export type ArchivedReason = 'manual' | 'parent-removed'

export interface PendingSend {
  readonly requestId: string
  readonly text: string
  readonly quoteIds: readonly string[]
  /** Full quote records, kept so an accepted submission can retain its sources. */
  readonly quotes?: readonly Quote[]
  /** Whether this submission carried the one-time Parent summary. */
  readonly contextInjected?: boolean
  readonly createdAt: number
}

export interface PendingCreate {
  readonly sessionId: string
  readonly createdAt: number
}

export interface SentQuote {
  readonly quote: Quote
  readonly requestId?: string
  readonly sentAt: number
}

export interface ContextSnapshot {
  readonly text: string
  readonly createdAt: number
  readonly sourceSessionId: string
  /** Event seq of the oldest and newest message actually included. */
  readonly sourceFromSeq?: number
  readonly sourceToSeq?: number
  /** At least one message had to be shortened to fit the budget. */
  readonly truncated?: boolean
  readonly budget?: number
}

export interface Quote {
  readonly id: string
  readonly text: string
  readonly createdAt: number
  readonly sourceSessionId?: string
  readonly sourceNodeKey?: string
}

export interface SideChat {
  readonly id: string
  /** Parent Session this chat belongs to. */
  readonly parentId: string
  title: string
  stage: ChatStage
  status: ChatStatus
  archivedReason?: ArchivedReason
  /** Present only after the real Session was created. */
  sideSessionId?: string
  draftText: string
  pendingQuotes: readonly Quote[]
  contextSnapshot?: ContextSnapshot
  contextDelivered?: boolean
  pendingSend?: PendingSend
  pendingCreate?: PendingCreate
  sentQuotes: readonly SentQuote[]
  firstSendDone?: boolean
  contextMode: ContextMode
  readonly createdAt: number
  updatedAt: number
}

export interface ChatBookSnapshot {
  readonly chats: readonly SideChat[]
  readonly activeId?: string
}

/** One chat as the Host store persists it; the parent id is the map key. */
export interface PersistedChat {
  readonly id: string
  readonly title: string
  readonly stage: ChatStage
  readonly status: ChatStatus
  readonly archivedReason?: ArchivedReason
  readonly sideSessionId?: string
  readonly draftText: string
  readonly pendingQuotes?: readonly Quote[]
  readonly contextSnapshot?: ContextSnapshot
  readonly contextDelivered?: boolean
  readonly pendingSend?: PendingSend
  readonly pendingCreate?: PendingCreate
  readonly sentQuotes?: readonly SentQuote[]
  readonly firstSendDone?: boolean
  readonly contextMode: ContextMode
  readonly createdAt: number
  readonly updatedAt: number
}

export interface PersistedParent {
  readonly activeId?: string
  readonly chats: readonly PersistedChat[]
}

export interface PersistedState {
  readonly activeId?: string
  readonly chats: readonly PersistedChat[]
}

export interface ArchivedChatSummary {
  readonly status: 'archiving' | 'archived'
  readonly chatId: string
  readonly parentSessionId: string
  readonly title: string
  readonly sideSessionId?: string
  readonly archivedReason?: ArchivedReason
  readonly backgroundText?: string
  readonly updatedAt: number
}

export type SideChatRpcRequest =
  | { readonly op: 'load'; readonly parentId: string }
  | { readonly op: 'save'; readonly parentId: string; readonly state: PersistedState }
  | { readonly op: 'listArchived' }

export type SideChatRpcResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: { readonly code: string; readonly message: string } }
