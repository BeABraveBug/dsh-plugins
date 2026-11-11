import { describe, expect, it } from 'vitest'
import { BACKGROUND_CLOSE, BACKGROUND_OPEN, legacyBackgroundPrefix, selectBackground, stripBackgroundEnvelope, wrapBackground } from '../src/client/context.ts'
import { isQuotableNodeKey } from '../src/client/selection.ts'

describe('background selection', () => {
  it('keeps whole recent messages and stops at a message that does not fit', () => {
    const selection = selectBackground([
      { id: '1', role: 'user', text: 'old', seq: 1 },
      { id: '2', role: 'assistant', text: 'b'.repeat(9000), seq: 2 },
    ], 8000)
    expect(selection.text).toContain('助手：…')
    expect(selection.text).not.toContain('old')
    expect(selection.stoppedAtOverflow).toBe(true)
    expect(selection.toSeq).toBe(2)
  })

  it('marks a newest message as an excerpt when it alone exceeds the budget', () => {
    const selection = selectBackground([{ id: '1', role: 'assistant', text: 'x'.repeat(100), seq: 1 }], 30)
    expect(selection.truncated).toBe(true)
    expect(selection.text.length).toBeLessThanOrEqual(30)
    expect(selection.text.startsWith('助手：…')).toBe(true)
  })
})

describe('background display', () => {
  it('strips only the exact envelope and preserves user text with the same marker', () => {
    const envelope = wrapBackground('用户：hidden')
    expect(stripBackgroundEnvelope(`${envelope}\n\n【问题】\nvisible`, [envelope])).toBe('【问题】\nvisible')
    expect(stripBackgroundEnvelope('explain ⟦side-chat-background⟧ literal', [envelope]))
      .toBe('explain ⟦side-chat-background⟧ literal')
    expect(stripBackgroundEnvelope(`prefix ${envelope}`, [envelope])).toBe(`prefix ${envelope}`)
    const legacy = legacyBackgroundPrefix('用户：old')
    expect(stripBackgroundEnvelope(`${legacy}\n\n【问题】\nq`, [legacy])).toBe('【问题】\nq')
    expect(BACKGROUND_OPEN).not.toBe(BACKGROUND_CLOSE)
  })
})

describe('quotable node keys', () => {
  it('accepts user, assistant and agent message rows', () => {
    expect(isQuotableNodeKey('14:assistant-step1:1')).toBe(true)
    expect(isQuotableNodeKey('3:input-message1:0')).toBe(true)
    expect(isQuotableNodeKey('9:turn-error1')).toBe(false)
  })
})
