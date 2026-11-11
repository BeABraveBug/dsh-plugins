import { describe, expect, it } from 'vitest'
import { IndependentStore } from '../src/host/independent-store.ts'
import { IndependentService } from '../src/host/independent-service.ts'
import { buildExchanges, generateReply } from '../src/host/model-gateway.ts'
import type { LlmStreamLike } from '../src/host/model-gateway.ts'

function fakeLlm(reply = 'answer', finish = 'stop'): LlmStreamLike & { calls: any[] } {
  const calls: any[] = []
  return {
    calls,
    stream: (options: any) => {
      calls.push(options)
      return (async function* () {
        yield { type: 'text-delta', text: reply }
        yield { type: 'finish', reason: { kind: finish } }
      })()
    },
  }
}

function service(llm: LlmStreamLike, model = 'deepseek-flash') {
  const store = new IndependentStore(':memory:', { now: () => 100 })
  return {
    store,
    service: new IndependentService(store, llm, { currentSelection: () => ({ provider: 'deepseek-official', model }) }),
  }
}

describe('independent model gateway', () => {
  it('builds full history with background and quotes on the user turn', () => {
    const exchanges = buildExchanges([
      { id: 1, chatId: 'c', role: 'user', text: 'q', quotes: [{ id: 'q1', text: 'quote', createdAt: 1 }], backgroundText: 'bg', status: 'complete', createdAt: 1 },
      { id: 2, chatId: 'c', role: 'assistant', text: 'a', quotes: [], status: 'complete', createdAt: 2 },
    ]) as { role: string; content: { type: string; text: string }[] }[]
    expect(exchanges).toHaveLength(2)
    expect(exchanges[0].content[0].text).toContain('【主会话背景】')
    expect(exchanges[0].content[0].text).toContain('【引用 1】')
    expect(exchanges[0].content[0].text).toContain('【问题】')
    expect(exchanges[1]).toMatchObject({ role: 'assistant', content: [{ type: 'text', text: 'a' }] })
  })

  it('collects the reply and rejects non-stop finishes', async () => {
    const llm = fakeLlm('reply')
    await expect(generateReply(llm, { selection: { provider: 'p', model: 'm' }, messages: [] }))
      .resolves.toBe('reply')
    await expect(generateReply(fakeLlm('partial', 'max-tokens'), { selection: { provider: 'p', model: 'm' }, messages: [] }))
      .rejects.toThrow('side-chat/model-max-tokens')
  })
})

describe('IndependentService.send', () => {
  it('sends all history, persists the reply and clears used quotes and draft', async () => {
    const llm = fakeLlm('answer')
    const { service: api, store } = service(llm)
    const chat = store.createChat('parent-a')
    store.updateDraft(chat.id, 'question')
    store.addQuote(chat.id, { id: 'q1', text: 'quoted', createdAt: 1 })
    const first = await api.send(chat.id, { requestId: 'req-1', text: 'question', quoteIds: ['q1'], background: { text: 'bg' } })
    expect(first?.messages.map(message => message.text)).toEqual(['question', 'answer'])
    expect(first?.chat.draftText).toBe('')
    expect(first?.chat.pendingQuotes).toEqual([])
    expect(first?.chat.firstSendDone).toBe(true)
    const sent = llm.calls[0]
    expect(sent.messages).toHaveLength(1)
    expect(sent.messages[0].content[0].text).toContain('quoted')
    expect(sent.messages[0].content[0].text).toContain('bg')

    const second = await api.send(chat.id, { requestId: 'req-2', text: 'follow up' })
    expect(second?.messages).toHaveLength(4)
    expect(llm.calls[1].messages).toHaveLength(3)
  })

  it('uses the per-chat model override', async () => {
    const llm = fakeLlm()
    const { service: api, store } = service(llm, 'default-model')
    const chat = store.createChat('parent-a')
    store.setModel(chat.id, { provider: 'other', model: 'override' })
    await api.send(chat.id, { requestId: 'req-1', text: 'q' })
    expect(llm.calls[0]).toMatchObject({ provider: 'other', model: 'override' })
  })

  it('records model failures and refuses archived chats', async () => {
    const { service: api, store } = service(fakeLlm('x', 'error'))
    const chat = store.createChat('parent-a')
    await expect(api.send(chat.id, { requestId: 'req-1', text: 'q' })).rejects.toThrow('side-chat/model-error')
    expect(store.messages(chat.id)[0]).toMatchObject({ status: 'error', error: 'side-chat/model-error' })
    store.setStatus(chat.id, 'archived', 'manual')
    await expect(api.send(chat.id, { requestId: 'req-2', text: 'q' })).rejects.toThrow('side-chat/not-open')
  })
})
