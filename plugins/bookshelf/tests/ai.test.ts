import { describe, expect, it } from 'vitest'
import { AiService } from '../src/host/ai.ts'

function service(answer = 'answer') {
  return new AiService({
    listProviders: () => [{ id: 'p', name: 'Provider' }],
    listModels: async () => [{ id: 'm', name: 'Model', inputModalities: ['text', 'image'] }],
    stream: async function* () {
      yield { type: 'text-delta', text: answer }
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
  }, {
    currentSelection: () => ({ provider: 'p', model: 'm' }),
  })
}

describe('AiService', () => {
  it('lists configured models and the default selection', async () => {
    const catalog = await service().listModels()
    expect(catalog.defaultSelection).toEqual({ provider: 'p', model: 'm' })
    expect(catalog.providers[0]?.models[0]).toMatchObject({ id: 'm', supportsImages: true })
  })

  it('sends fixed context and returns the collected text', async () => {
    const result = await service('summary').ask('what?', 'context')
    expect(result.answer).toBe('summary')
    expect(result.selection).toEqual({ provider: 'p', model: 'm' })
  })
})
