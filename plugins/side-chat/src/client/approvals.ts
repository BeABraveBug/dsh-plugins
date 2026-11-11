import type { SessionStatusLike } from './host-api.ts'

export type ApprovalOutcome = 'allowed-once' | 'rejected'

/** The answerable approval interaction the host publishes for one Session. */
export interface ApprovalView {
  readonly toolName?: string
  readonly callId?: string
  readonly reason?: string
  readonly answerable: boolean
  answer(outcome: ApprovalOutcome): Promise<unknown>
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null ? value as Record<string, unknown> : undefined
}

/** Resolve a host-localized text value, falling back to the base language and English. */
export function resolveLocalizedText(value: unknown, language: string): string | undefined {
  if (typeof value === 'string') return value === '' ? undefined : value
  const record = asRecord(value)
  if (record === undefined) return undefined
  const base = language.split('-')[0]?.toLowerCase() ?? ''
  const candidates = [language, language.toLowerCase(), base, 'en']
  for (const key of candidates) {
    const text = record[key]
    if (typeof text === 'string' && text !== '') return text
  }
  const first = Object.values(record).find(text => typeof text === 'string' && text !== '')
  return typeof first === 'string' ? first : undefined
}

/**
 * Read the approval domain's pending interaction. The shape follows the host
 * approval plugin (`kind: 'approval'` with a one-shot `answer`); a future host
 * version that renames or moves it must be re-checked, because this is not a
 * documented plugin API.
 */
export function approvalFromStatus(status: SessionStatusLike | undefined, language = 'en'): ApprovalView | undefined {
  const interaction = asRecord(status?.pendingInteraction)
  if (interaction === undefined || interaction.kind !== 'approval') return undefined
  if (typeof interaction.answer !== 'function') return undefined
  const toolName = typeof interaction.toolName === 'string' ? interaction.toolName : undefined
  const callId = typeof interaction.callId === 'string' ? interaction.callId : undefined
  const localized = resolveLocalizedText(interaction.displayReason, language)
  const plain = typeof interaction.reason === 'string' ? interaction.reason : undefined
  const reason = localized ?? plain
  return {
    ...(toolName === undefined ? {} : { toolName }),
    ...(callId === undefined ? {} : { callId }),
    ...(reason === undefined ? {} : { reason }),
    answerable: interaction.answerable !== false,
    answer: (outcome) => (interaction.answer as (value: ApprovalOutcome) => Promise<unknown>)(outcome),
  }
}

export interface ToolCallView {
  readonly name: string
  readonly argumentsText: string
}

/** Find the same-Session tool call the approval refers to, for review before answering. */
export function findToolCall(entries: readonly unknown[], callId: string | undefined): ToolCallView | undefined {
  if (callId === undefined) return undefined
  let found: ToolCallView | undefined
  for (const entry of entries) {
    const record = asRecord(entry)
    if (record?.type !== 'event') continue
    const event = asRecord(record.event)
    if (event?.type !== 'tool/call') continue
    const data = asRecord(event.data)
    if (data?.callId !== callId) continue
    if (typeof data.name !== 'string') continue
    const raw = typeof data.arguments === 'string' ? data.arguments : JSON.stringify(data.arguments ?? '')
    found = { name: data.name, argumentsText: raw }
  }
  return found
}
