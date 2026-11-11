import type { ChatMessage } from './messages.ts'
import type { ContextSnapshot } from '../shared/types.ts'

export const BACKGROUND_BUDGET = 8000
export const BACKGROUND_OPEN = '⟦side-chat-background⟧'
export const BACKGROUND_CLOSE = '⟦/side-chat-background⟧'

export type { ContextSnapshot }

export interface BackgroundSelection {
  readonly text: string
  readonly fromSeq?: number
  readonly toSeq?: number
  readonly truncated: boolean
  /** The next older whole message did not fit, so the contiguous range is final. */
  readonly stoppedAtOverflow: boolean
}

function label(role: 'user' | 'assistant'): string {
  return role === 'user' ? '用户' : '助手'
}

/**
 * Take the most recent completed messages backwards until the character budget is
 * met, keeping whole messages whenever they fit. A single newest message larger
 * than the budget is shortened and marked as an excerpt; older messages are then
 * omitted rather than split.
 */
export function selectBackground(messages: readonly ChatMessage[], budget = BACKGROUND_BUDGET): BackgroundSelection {
  const chosen: { role: 'user' | 'assistant'; text: string; seq?: number }[] = []
  let used = 0
  let truncated = false
  let stoppedAtOverflow = false
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    const whole = `${label(message.role)}：${message.text}`
    const cost = whole.length + (chosen.length === 0 ? 0 : 1)
    if (used + cost <= budget) {
      chosen.unshift({ role: message.role, text: message.text, ...(message.seq === undefined ? {} : { seq: message.seq }) })
      used += cost
      continue
    }
    if (chosen.length === 0) {
      const prefix = `${label(message.role)}：…`
      const room = Math.max(0, budget - prefix.length)
      if (room > 0) {
        const tail = message.text.slice(Math.max(0, message.text.length - room))
        chosen.unshift({ role: message.role, text: `…${tail}`, ...(message.seq === undefined ? {} : { seq: message.seq }) })
        truncated = true
      }
    }
    stoppedAtOverflow = true
    break
  }
  const text = chosen.map(message => `${label(message.role)}：${message.text}`).join('\n')
  const seqs = chosen.flatMap(message => message.seq === undefined ? [] : [message.seq])
  return {
    text,
    ...(seqs.length === 0 ? {} : { fromSeq: seqs[0], toSeq: seqs[seqs.length - 1] }),
    truncated,
    stoppedAtOverflow,
  }
}

/** Wrap the background so the durable prompt carries it but the side chat hides it. */
export function wrapBackground(text: string): string {
  return `${BACKGROUND_OPEN}\n【主会话背景】\n${text}\n${BACKGROUND_CLOSE}`
}

/** Legacy first-send label used before the background envelope existed. */
export function legacyBackgroundPrefix(text: string): string {
  return `【主会话摘要】\n${text}`
}

/**
 * Remove exactly the envelopes this chat produced, so a user question that
 * happens to contain the marker text keeps its characters.
 */
export function stripBackgroundEnvelope(text: string, envelopes: readonly string[]): string {
  for (const envelope of envelopes) {
    if (envelope === '') continue
    if (text === envelope) return ''
    if (!text.startsWith(envelope)) continue
    const rest = text.slice(envelope.length)
    if (rest === '') return ''
    if (rest.startsWith('\n\n')) return rest.slice(2)
    if (rest.startsWith('\n')) return rest.slice(1)
    return rest
  }
  return text
}
