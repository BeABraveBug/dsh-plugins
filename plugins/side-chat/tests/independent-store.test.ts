import { describe, expect, it } from 'vitest'
import { IndependentStore } from '../src/host/independent-store.ts'

function store(): IndependentStore {
  let now = 100
  return new IndependentStore(':memory:', { now: () => now++ })
}

describe('IndependentStore', () => {
  it('creates a chat, sets it active and keeps drafts and quotes', () => {
    const db = store()
    const chat = db.createChat('parent-a', { title: '侧聊 1' })
    expect(chat).toMatchObject({ parentSessionId: 'parent-a', status: 'open', draftText: '', firstSendDone: false })
    db.updateDraft(chat.id, 'hello')
    db.addQuote(chat.id, { id: 'q1', text: 'quoted', createdAt: 1 })
    const state = db.listParent('parent-a')
    expect(state.activeId).toBe(chat.id)
    expect(state.chats[0]).toMatchObject({ draftText: 'hello', pendingQuotes: [{ id: 'q1' }] })
    db.removeQuote(chat.id, 'q1')
    expect(db.getChat(chat.id)?.pendingQuotes).toEqual([])
  })

  it('marks the first send and records user/assistant messages idempotently', () => {
    const db = store()
    const chat = db.createChat('parent-a')
    db.addQuote(chat.id, { id: 'q1', text: 'quoted', createdAt: 1 })
    const user = db.beginSend(chat.id, { requestId: 'req-1', text: 'question', quoteIds: ['q1'], background: { text: 'bg' } })
    expect(user).toMatchObject({ role: 'user', text: 'question', status: 'pending' })
    expect(user.quotes.map(quote => quote.id)).toEqual(['q1'])
    expect(db.beginSend(chat.id, { requestId: 'req-1', text: 'question' }).id).toBe(user.id)
    const assistant = db.completeSend(chat.id, 'req-1', 'answer')
    expect(assistant).toMatchObject({ role: 'assistant', text: 'answer', status: 'complete' })
    expect(db.getChat(chat.id)?.firstSendDone).toBe(true)
    expect(db.messages(chat.id).map(message => message.status)).toEqual(['complete', 'complete'])
  })

  it('records failures, archives across parents and deletes plugin data', () => {
    const db = store()
    const first = db.createChat('parent-a')
    const second = db.createChat('parent-b')
    db.beginSend(first.id, { requestId: 'req-1', text: 'q' })
    db.failSend('req-1', 'model failed')
    expect(db.messages(first.id)[0]).toMatchObject({ status: 'error', error: 'model failed' })
    db.setStatus(first.id, 'archived', 'manual')
    db.setStatus(second.id, 'archiving', 'manual')
    expect(db.archived().map(chat => chat.id).sort()).toEqual([first.id, second.id].sort())
    db.deleteChat(first.id)
    expect(db.getChat(first.id)).toBeUndefined()
    expect(db.messages(first.id)).toEqual([])
  })

  it('persists model overrides and background snapshots', () => {
    const db = store()
    const chat = db.createChat('parent-a')
    db.setModel(chat.id, { provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'high' })
    db.setBackground(chat.id, { text: 'bg', fromSeq: 1, toSeq: 2 })
    expect(db.getChat(chat.id)).toMatchObject({
      model: { provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'high' },
      backgroundText: 'bg',
      backgroundFromSeq: 1,
      backgroundToSeq: 2,
    })
  })
})
