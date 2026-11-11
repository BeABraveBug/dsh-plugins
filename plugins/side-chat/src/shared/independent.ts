export type IndependentStatus = 'open' | 'saved' | 'archiving' | 'archived'

export interface ModelChoice {
  readonly provider: string
  readonly model: string
  readonly reasoningEffort?: string
}

export interface IndependentQuote {
  readonly id: string
  readonly text: string
  readonly sourceSessionId?: string
  readonly sourceNodeKey?: string
  readonly createdAt: number
}

export interface IndependentChat {
  readonly id: string
  readonly parentSessionId: string
  readonly title: string
  readonly status: IndependentStatus
  readonly archivedReason?: 'manual' | 'parent-removed'
  readonly draftText: string
  readonly pendingQuotes: readonly IndependentQuote[]
  readonly model?: ModelChoice
  readonly backgroundText?: string
  readonly backgroundFromSeq?: number
  readonly backgroundToSeq?: number
  readonly backgroundCreatedAt?: number
  readonly firstSendDone: boolean
  readonly createdAt: number
  readonly updatedAt: number
}

export interface IndependentMessage {
  readonly id: number
  readonly chatId: string
  readonly role: 'user' | 'assistant'
  readonly text: string
  readonly quotes: readonly IndependentQuote[]
  readonly backgroundText?: string
  readonly status: 'pending' | 'complete' | 'error'
  readonly error?: string
  readonly requestId?: string
  readonly createdAt: number
}

export interface IndependentParentState {
  readonly activeId?: string
  readonly chats: readonly IndependentChat[]
}

export interface IndependentChatView {
  readonly chat: IndependentChat
  readonly messages: readonly IndependentMessage[]
}

export type IndependentRpcRequest =
  | { readonly op: 'ind.list'; readonly parentId: string }
  | { readonly op: 'ind.create'; readonly parentId: string; readonly title?: string }
  | { readonly op: 'ind.get'; readonly chatId: string }
  | { readonly op: 'ind.draft'; readonly chatId: string; readonly text: string }
  | { readonly op: 'ind.quoteAdd'; readonly chatId: string; readonly quote: IndependentQuote }
  | { readonly op: 'ind.quoteRemove'; readonly chatId: string; readonly quoteId: string }
  | { readonly op: 'ind.quotesClear'; readonly chatId: string }
  | { readonly op: 'ind.active'; readonly parentId: string; readonly chatId?: string }
  | { readonly op: 'ind.status'; readonly chatId: string; readonly status: IndependentStatus; readonly reason?: 'manual' | 'parent-removed' }
  | { readonly op: 'ind.model'; readonly chatId: string; readonly model?: ModelChoice }
  | { readonly op: 'ind.send'; readonly chatId: string; readonly requestId: string; readonly text: string; readonly quoteIds?: readonly string[]; readonly background?: { readonly text: string; readonly fromSeq?: number; readonly toSeq?: number } }
  | { readonly op: 'ind.delete'; readonly chatId: string }
  | { readonly op: 'ind.archived' }
  | { readonly op: 'ind.models' }
