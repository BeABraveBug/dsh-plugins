import { wrapBackground } from './context.ts'
import type { Quote } from '../shared/types.ts'

export const MAX_QUOTES = 5
export const MAX_QUOTE_CHARS = 8000

/**
 * Build the prompt sent to the side Session. Quotes are user-supplied text kept
 * in the ordinary user role with explicit labels; the labels mark them as
 * external material but are not a security boundary against prompt injection.
 */
export function composePrompt(text: string, quotes: readonly Quote[], backgroundText?: string): string {
  const background = backgroundText?.trim() ?? ''
  if (background === '' && quotes.length === 0) return text
  const sections: string[] = []
  if (background !== '') sections.push(wrapBackground(background))
  if (quotes.length > 0) {
    sections.push(quotes.map((quote, index) => `【引用 ${index + 1}】\n${quote.text}`).join('\n\n'))
  }
  sections.push(`【问题】\n${text}`)
  return sections.join('\n\n')
}
