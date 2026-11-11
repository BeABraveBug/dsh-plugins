import { describe, expect, it } from 'vitest'
import { approvalFromStatus, findToolCall, resolveLocalizedText } from '../src/client/approvals.ts'

describe('approvalFromStatus', () => {
  it('returns the answerable approval interaction with call id', async () => {
    const answers: string[] = []
    const view = approvalFromStatus({
      pendingInteraction: {
        kind: 'approval',
        toolName: 'bash',
        callId: 'call-A',
        reason: 'run tests',
        answerable: true,
        answer: async (outcome: string) => { answers.push(outcome) },
      },
    })
    expect(view).toMatchObject({ toolName: 'bash', callId: 'call-A', reason: 'run tests', answerable: true })
    await view?.answer('allowed-once')
    expect(answers).toEqual(['allowed-once'])
  })

  it('resolves a localized displayReason and prefers it over the plain reason', () => {
    const status = {
      pendingInteraction: {
        kind: 'approval',
        displayReason: { en: 'Run tests', zh: '运行测试' },
        reason: 'plain',
        answer: async () => undefined,
      },
    }
    expect(approvalFromStatus(status, 'zh-CN')?.reason).toBe('运行测试')
    expect(approvalFromStatus(status, 'en-US')?.reason).toBe('Run tests')
    expect(approvalFromStatus(status, 'fr')?.reason).toBe('Run tests')
    expect(approvalFromStatus({
      pendingInteraction: { kind: 'approval', reason: 'plain', answer: async () => undefined },
    }, 'zh-CN')?.reason).toBe('plain')
  })

  it('ignores other interaction domains and settled requests', () => {
    expect(approvalFromStatus({ pendingInteraction: { kind: 'question' } })).toBeUndefined()
    expect(approvalFromStatus({ pendingInteraction: { kind: 'approval' } })).toBeUndefined()
    expect(approvalFromStatus({})).toBeUndefined()
    expect(approvalFromStatus(undefined)).toBeUndefined()
  })

  it('marks a non-answerable request as disabled', () => {
    expect(approvalFromStatus({
      pendingInteraction: { kind: 'approval', answer: async () => undefined, answerable: false },
    })?.answerable).toBe(false)
  })
})

describe('resolveLocalizedText', () => {
  it('handles strings, empty values and language fallbacks', () => {
    expect(resolveLocalizedText('plain', 'en')).toBe('plain')
    expect(resolveLocalizedText('', 'en')).toBeUndefined()
    expect(resolveLocalizedText({ zh: '中文', en: 'English' }, 'zh-TW')).toBe('中文')
    expect(resolveLocalizedText({ de: 'Deutsch' }, 'fr')).toBe('Deutsch')
    expect(resolveLocalizedText(null, 'en')).toBeUndefined()
  })
})

describe('findToolCall', () => {
  it('returns the matching call arguments and ignores other calls', () => {
    const entries = [
      { type: 'event', event: { type: 'tool/call', data: { callId: 'call-A', name: 'bash', arguments: '{"command":"printf review-action-A"}' } } },
      { type: 'event', event: { type: 'tool/call', data: { callId: 'call-B', name: 'bash', arguments: '{"command":"other"}' } } },
    ]
    expect(findToolCall(entries, 'call-A')).toEqual({
      name: 'bash',
      argumentsText: '{"command":"printf review-action-A"}',
    })
    expect(findToolCall(entries, 'missing')).toBeUndefined()
    expect(findToolCall(entries, undefined)).toBeUndefined()
  })
})
