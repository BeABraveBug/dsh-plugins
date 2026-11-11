/** Minimal read model over durable Session events for the side-chat thread. */

export interface ChatMessage {
  readonly id: string
  readonly role: 'user' | 'assistant'
  readonly text: string
  readonly seq?: number
}

interface EventEntry {
  readonly type: 'event' | 'transient'
  readonly event: {
    readonly type: string
    readonly seq?: number
    readonly time?: number
    readonly data?: Record<string, unknown>
  }
}

interface ContentBlock {
  readonly type: string
  readonly text?: string
}

function textOf(blocks: unknown): string {
  if (!Array.isArray(blocks)) return ''
  return blocks
    .filter((block): block is ContentBlock => typeof block === 'object' && block !== null && (block as ContentBlock).type === 'text')
    .map(block => block.text ?? '')
    .join('')
}

function messageSource(message: unknown): string | undefined {
  if (typeof message !== 'object' || message === null) return undefined
  const source = (message as { source?: { kind?: unknown } }).source
  return typeof source?.kind === 'string' ? source.kind : undefined
}

/**
 * Keep the visible user and assistant text of a session window. Context
 * injections and tool traffic are outside the minimal surface for now.
 */
export function collectMessages(entries: readonly EventEntry[]): readonly ChatMessage[] {
  const messages: ChatMessage[] = []
  for (const entry of entries) {
    if (entry.type !== 'event') continue
    const { event } = entry
    if (event.type === 'user/message') {
      const data = event.data ?? {}
      if (messageSource(data) !== 'user') continue
      const text = textOf(data.content)
      if (text.length === 0) continue
      messages.push({
        id: `user-${event.seq ?? messages.length}`,
        role: 'user',
        text,
        ...(event.seq === undefined ? {} : { seq: event.seq }),
      })
    } else if (event.type === 'assistant/message') {
      const message = (event.data?.message ?? {}) as Record<string, unknown>
      if (messageSource(message) !== 'model') continue
      const text = textOf(message.content)
      if (text.length === 0) continue
      messages.push({
        id: `assistant-${event.seq ?? messages.length}`,
        role: 'assistant',
        text,
        ...(event.seq === undefined ? {} : { seq: event.seq }),
      })
    }
  }
  return messages.filter(message => message.text !== '')
}

export type TurnFailureKind = 'error' | 'blocked' | 'aborted' | 'interrupted' | 'max-tokens'

/** A terminal Turn failure that survives reloads, as recorded in the session log. */
export interface TurnFailure {
  readonly id: string
  readonly kind: TurnFailureKind
  readonly message: string
}

/**
 * The latest failed Turn in the window. A completed Turn after it clears the
 * failure, so the surface does not keep showing an error the Session recovered
 * from.
 */
export function lastTurnFailure(entries: readonly EventEntry[]): TurnFailure | null {
  let failure: TurnFailure | null = null
  for (const entry of entries) {
    if (entry.type !== 'event' || entry.event.type !== 'turn/end') continue
    const data = entry.event.data ?? {}
    const reason = (data as { reason?: unknown }).reason
    if (typeof reason !== 'object' || reason === null) continue
    const kind = (reason as { kind?: unknown }).kind
    const seq = entry.event.seq ?? 0
    if (kind === 'completed') {
      failure = null
    } else if (kind === 'forked') {
      // A fork boundary is not a failure and does not erase an earlier one.
    } else if (kind === 'error') {
      const error = (reason as { error?: unknown }).error
      const record = typeof error === 'object' && error !== null ? error as Record<string, unknown> : {}
      const message = typeof record.message === 'string' && record.message !== ''
        ? record.message
        : typeof record.code === 'string' ? record.code : 'error'
      failure = { id: `turn-${seq}`, kind: 'error', message }
    } else if (kind === 'blocked' || kind === 'aborted' || kind === 'interrupted' || kind === 'max-tokens') {
      failure = { id: `turn-${seq}`, kind, message: kind }
    }
  }
  return failure
}
