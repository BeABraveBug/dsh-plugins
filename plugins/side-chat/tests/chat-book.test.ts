import { describe, expect, it } from 'vitest'
import { ChatBook } from '../src/client/chat-book.ts'
import { collectMessages, lastTurnFailure } from '../src/client/messages.ts'
import { createOptionsFor } from '../src/client/session-options.ts'
import { SideChatHub } from '../src/client/hub.ts'
import { composePrompt } from '../src/client/quote-text.ts'
import { BACKGROUND_BUDGET, BACKGROUND_CLOSE, BACKGROUND_OPEN, legacyBackgroundPrefix, selectBackground, stripBackgroundEnvelope, wrapBackground } from '../src/client/context.ts'
import { isQuotableNodeKey } from '../src/client/selection.ts'

function book(): ChatBook {
  let id = 0
  let now = 1000
  return new ChatBook('parent-a', {
    createId: () => `chat-${++id}`,
    now: () => (now += 1),
  })
}

describe('ChatBook', () => {
  it('creates a draft, activates it and keeps drafts per chat', () => {
    const chats = book()
    const first = chats.createDraft()
    const second = chats.createDraft()
    expect(chats.getSnapshot().activeId).toBe(second.id)
    chats.setDraftText(first.id, 'first question')
    chats.setDraftText(second.id, 'second question')
    chats.setActive(first.id)
    expect(chats.getActive()?.draftText).toBe('first question')
    expect(chats.get(second.id)?.draftText).toBe('second question')
  })

  it('marks a chat real once its session exists and removes it again', () => {
    const chats = book()
    const chat = chats.createDraft()
    chats.markReal(chat.id, 'session-7')
    expect(chats.get(chat.id)).toMatchObject({ stage: 'real', sideSessionId: 'session-7' })
    chats.remove(chat.id)
    expect(chats.getSnapshot().chats).toEqual([])
    expect(chats.getSnapshot().activeId).toBeUndefined()
  })

  it('closes a chat to saved and activates another open chat', () => {
    const chats = book()
    const first = chats.createDraft()
    const second = chats.createDraft()
    chats.setStatus(second.id, 'saved')
    expect(chats.get(second.id)?.status).toBe('saved')
    expect(chats.getSnapshot().activeId).toBe(first.id)
    chats.setStatus(second.id, 'open')
    expect(chats.getSnapshot().activeId).toBe(first.id)
  })

  it('keeps the active pointer on an open chat when the active one is removed', () => {
    const chats = book()
    const first = chats.createDraft()
    const second = chats.createDraft()
    chats.remove(second.id)
    expect(chats.getSnapshot().activeId).toBe(first.id)
    chats.remove(first.id)
    expect(chats.getSnapshot().activeId).toBeUndefined()
  })

  it('notifies subscribers on every published change', () => {
    const chats = book()
    let calls = 0
    const unsubscribe = chats.subscribe(() => { calls += 1 })
    const chat = chats.createDraft()
    chats.setDraftText(chat.id, 'hello')
    chats.setDraftText(chat.id, 'hello')
    unsubscribe()
    chats.setDraftText(chat.id, 'ignored')
    expect(calls).toBe(2)
  })
})

describe('collectMessages', () => {
  it('keeps human user text and assistant text, skipping context and tools', () => {
    const entries = [
      { type: 'event', event: { type: 'user/message', seq: 1, data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'question' }] } } },
      { type: 'event', event: { type: 'user/message', seq: 2, data: { source: { kind: 'file-change' }, content: [{ type: 'text', text: 'injected' }] } } },
      { type: 'event', event: { type: 'assistant/message', seq: 3, data: { message: { source: { kind: 'model' }, content: [{ type: 'text', text: 'answer' }] } } } },
      { type: 'transient', event: { type: 'assistant/live-chunk', data: {} } },
    ]
    expect(collectMessages(entries as never)).toEqual([
      { id: 'user-1', role: 'user', text: 'question', seq: 1 },
      { id: 'assistant-3', role: 'assistant', text: 'answer', seq: 3 },
    ])
  })

  it('drops empty text and non-text blocks', () => {
    const entries = [
      { type: 'event', event: { type: 'user/message', seq: 1, data: { source: { kind: 'user' }, content: [{ type: 'image', value: {} }] } } },
      { type: 'event', event: { type: 'assistant/message', seq: 2, data: { message: { source: { kind: 'model' }, content: [{ type: 'text', text: '' }] } } } },
    ]
    expect(collectMessages(entries as never)).toEqual([])
  })
})

describe('createOptionsFor', () => {
  it('joins the Workspace that accounts for the Parent', () => {
    const list = { ids: ['parent'], byId: { parent: { id: 'parent', cwd: '/work/project' } } }
    const workspaces = {
      items: [
        { workspaceId: 'ws-other', path: '/elsewhere', sessionIds: ['x'] },
        { workspaceId: 'ws-parent', path: '/work', sessionIds: ['parent'] },
      ],
    }
    expect(createOptionsFor(list, workspaces, 'parent')).toEqual({ workspaceId: 'ws-parent' })
  })

  it('resolves the enclosing Workspace by the Parent directory', () => {
    const list = { ids: ['parent'], byId: { parent: { id: 'parent', cwd: '/work/project/src' } } }
    const workspaces = {
      items: [
        { workspaceId: 'ws-work', path: '/work', sessionIds: [] },
        { workspaceId: 'ws-nested', path: '/work/project', sessionIds: [] },
      ],
    }
    expect(createOptionsFor(list, workspaces, 'parent')).toEqual({ workspaceId: 'ws-nested' })
  })

  it('creates beside the Parent directory when the list knows it', () => {
    const list = {
      ids: ['parent'],
      byId: { parent: { id: 'parent', cwd: '/work/project' } },
    }
    expect(createOptionsFor(list, undefined, 'parent')).toEqual({ cwd: '/work/project' })
  })

  it('falls back to Host defaults for an unknown or blank Parent', () => {
    expect(createOptionsFor(undefined, undefined, 'parent')).toEqual({})
    expect(createOptionsFor({ ids: [], byId: {} }, undefined, 'parent')).toEqual({})
    expect(createOptionsFor({ ids: ['p'], byId: { p: { id: 'p', cwd: '' } } }, undefined, 'p')).toEqual({})
  })
})

describe('ChatBook persistence', () => {
  it('hydrates a persisted record and exports it again', () => {
    const chats = book()
    chats.hydrate({
      activeId: 'old-1',
      chats: [
        { id: 'old-1', title: '旧侧聊', stage: 'real', status: 'open', sideSessionId: 'session-1', draftText: 'draft', pendingQuotes: [], contextMode: 'summary', createdAt: 5, updatedAt: 6 },
        { id: 'old-2', title: '草稿', stage: 'draft', status: 'open', draftText: '', pendingQuotes: [], contextMode: 'none', createdAt: 7, updatedAt: 7 },
      ],
    })
    expect(chats.isRestored()).toBe(true)
    expect(chats.getActive()?.id).toBe('old-1')
    expect(chats.get('old-1')).toMatchObject({ parentId: 'parent-a', sideSessionId: 'session-1' })
    expect(chats.exportState()).toEqual({
      activeId: 'old-1',
      chats: [
        { id: 'old-1', title: '旧侧聊', stage: 'real', status: 'open', sideSessionId: 'session-1', draftText: 'draft', pendingQuotes: [], sentQuotes: [], contextMode: 'summary', createdAt: 5, updatedAt: 6 },
        { id: 'old-2', title: '草稿', stage: 'draft', status: 'open', draftText: '', pendingQuotes: [], sentQuotes: [], contextMode: 'none', createdAt: 7, updatedAt: 7 },
      ],
    })
  })

  it('keeps a draft created before the record arrives without dropping the record', () => {
    const chats = book()
    const early = chats.createDraft()
    chats.hydrate({ chats: [{ id: 'old-1', title: '旧', stage: 'draft', status: 'open', draftText: '', pendingQuotes: [], contextMode: 'summary', createdAt: 1, updatedAt: 1 }] })
    expect(chats.list().map(entry => entry.id)).toEqual([early.id, 'old-1'])
  })
})

describe('lastTurnFailure', () => {
  it('reports a failed turn with its message and a blocked turn by kind', () => {
    const failed = lastTurnFailure([
      { type: 'event', event: { type: 'turn/end', seq: 4, data: { reason: { kind: 'error', error: { message: 'no API key' } } } } },
    ] as never)
    expect(failed).toEqual({ id: 'turn-4', kind: 'error', message: 'no API key' })
    const blocked = lastTurnFailure([
      { type: 'event', event: { type: 'turn/end', seq: 5, data: { reason: { kind: 'blocked' } } } },
    ] as never)
    expect(blocked).toMatchObject({ kind: 'blocked', message: 'blocked' })
  })

  it('reports aborted, interrupted and max-tokens ends', () => {
    for (const kind of ['aborted', 'interrupted', 'max-tokens'] as const) {
      const failure = lastTurnFailure([
        { type: 'event', event: { type: 'turn/end', seq: 1, data: { reason: { kind } } } },
      ] as never)
      expect(failure).toMatchObject({ kind, message: kind })
    }
  })

  it('keeps a failure across a fork boundary and clears it on completion', () => {
    const failure = lastTurnFailure([
      { type: 'event', event: { type: 'turn/end', seq: 1, data: { reason: { kind: 'error', error: { message: 'x' } } } } },
      { type: 'event', event: { type: 'turn/end', seq: 2, data: { reason: { kind: 'forked' } } } },
    ] as never)
    expect(failure).toMatchObject({ kind: 'error', message: 'x' })
  })

  it('clears the failure after a completed turn', () => {
    expect(lastTurnFailure([
      { type: 'event', event: { type: 'turn/end', seq: 1, data: { reason: { kind: 'error', error: { message: 'x' } } } } },
      { type: 'event', event: { type: 'turn/end', seq: 2, data: { reason: { kind: 'completed' } } } },
    ] as never)).toBeNull()
  })
})

function newHub(): SideChatHub {
  let id = 0
  let now = 100
  return new SideChatHub({ createId: () => `quote-${++id}`, now: () => (now += 1) })
}

describe('quotes', () => {
  it('adds, removes and clears pending quotes per chat', () => {
    const chats = book()
    const first = chats.createDraft()
    const second = chats.createDraft()
    const quote = { id: 'q1', text: 'quoted', createdAt: 1 }
    chats.addQuote(first.id, quote)
    chats.addQuote(first.id, quote)
    expect(chats.get(first.id)?.pendingQuotes).toHaveLength(1)
    expect(chats.get(second.id)?.pendingQuotes).toHaveLength(0)
    chats.removeQuote(first.id, 'missing')
    expect(chats.get(first.id)?.pendingQuotes).toHaveLength(1)
    chats.removeQuote(first.id, 'q1')
    expect(chats.get(first.id)?.pendingQuotes).toHaveLength(0)
    chats.addQuote(first.id, quote)
    chats.clearQuotes(first.id)
    expect(chats.get(first.id)?.pendingQuotes).toHaveLength(0)
  })

  it('keeps quotes in the exported record', () => {
    const chats = book()
    const chat = chats.createDraft()
    chats.addQuote(chat.id, { id: 'q1', text: 'quoted', createdAt: 2, sourceNodeKey: 'node-1' })
    expect(chats.exportState().chats[0]).toMatchObject({ pendingQuotes: [{ id: 'q1', text: 'quoted', sourceNodeKey: 'node-1' }] })
  })
})

describe('composePrompt', () => {
  it('returns the question alone without quotes', () => {
    expect(composePrompt('question', [])).toBe('question')
  })

  it('labels quotes as external material before the question', () => {
    const text = composePrompt('why?', [
      { id: 'q1', text: 'first', createdAt: 1 },
      { id: 'q2', text: 'second', createdAt: 2 },
    ])
    expect(text).toBe([
      '【引用 1】', 'first', '', '【引用 2】', 'second', '', '【问题】', 'why?',
    ].join('\n'))
  })
})

describe('SideChatHub', () => {
  it('creates a draft when no open chat exists and keeps the quote', () => {
    const hub = newHub()
    const delivery = hub.deliverQuote('parent-a', { text: 'quoted text' })
    expect(delivery.ok).toBe(true)
    const snapshot = hub.snapshotOf('parent-a')
    expect(snapshot.chats).toHaveLength(1)
    expect(snapshot.chats[0].pendingQuotes[0]).toMatchObject({ text: 'quoted text' })
    expect(snapshot.activeId).toBe(snapshot.chats[0].id)
  })

  it('enforces the quote count and length limits', () => {
    const hub = newHub()
    for (let index = 0; index < 5; index += 1) {
      expect(hub.deliverQuote('parent-a', { text: `quote ${index}` }).ok).toBe(true)
    }
    expect(hub.deliverQuote('parent-a', { text: 'overflow' })).toEqual({ ok: false, code: 'too-many' })
    expect(hub.deliverQuote('parent-a', { text: 'x'.repeat(8001) })).toEqual({ ok: false, code: 'too-long' })
  })
})

describe('context snapshot', () => {
  it('uses the confirmed 8000 character budget', () => {
    expect(BACKGROUND_BUDGET).toBe(8000)
  })
  it('stops at the first whole message that cannot fit', () => {
    const selection = selectBackground([
      { id: '1', role: 'user', text: 'a'.repeat(3000), seq: 1 },
      { id: '2', role: 'assistant', text: 'b'.repeat(7000), seq: 2 },
    ], 8000)
    expect(selection.stoppedAtOverflow).toBe(true)
    expect(selection.text).toContain('b'.repeat(7000))
    expect(selection.text).not.toContain('a'.repeat(3000))
  })

  it('selects whole recent messages within the budget', () => {
    const selection = selectBackground([
      { id: '1', role: 'user', text: 'hello', seq: 1 },
      { id: '2', role: 'assistant', text: 'hi', seq: 2 },
    ], 100)
    expect(selection.text).toBe('用户：hello\n助手：hi')
    expect(selection).toMatchObject({ fromSeq: 1, toSeq: 2, truncated: false, stoppedAtOverflow: false })
  })

  it('marks a newest message as an excerpt when it exceeds the budget', () => {
    const selection = selectBackground([
      { id: '1', role: 'user', text: 'old', seq: 1 },
      { id: '2', role: 'assistant', text: 'b'.repeat(100), seq: 2 },
    ], 30)
    expect(selection.truncated).toBe(true)
    expect(selection.stoppedAtOverflow).toBe(true)
    expect(selection.text.length).toBeLessThanOrEqual(30)
    expect(selection.text).toContain('助手：…')
    expect(selection.text).not.toContain('old')
    expect(selection.toSeq).toBe(2)
  })

  it('strips only the exact background envelope this chat produced', () => {
    const envelope = wrapBackground('用户：hidden')
    const prompt = `${envelope}\n\n【问题】\nvisible`
    expect(stripBackgroundEnvelope(prompt, [envelope])).toBe('【问题】\nvisible')
    expect(stripBackgroundEnvelope('explain ⟦side-chat-background⟧ literal', [envelope]))
      .toBe('explain ⟦side-chat-background⟧ literal')
    expect(stripBackgroundEnvelope(`prefix ${envelope}`, [envelope])).toBe(`prefix ${envelope}`)
  })

  it('strips the legacy summary prefix only when it matches', () => {
    const legacy = legacyBackgroundPrefix('用户：old')
    expect(stripBackgroundEnvelope(`${legacy}\n\n【问题】\nq`, [legacy])).toBe('【问题】\nq')
    expect(stripBackgroundEnvelope('unrelated', [legacy])).toBe('unrelated')
  })

  it('records the snapshot and delivery flag on the chat', () => {
    const chats = book()
    const chat = chats.createDraft()
    chats.setContextSnapshot(chat.id, { text: 'summary', createdAt: 9, sourceSessionId: 'parent-a' })
    chats.markContextDelivered(chat.id)
    expect(chats.exportState().chats[0]).toMatchObject({
      contextSnapshot: { text: 'summary', createdAt: 9, sourceSessionId: 'parent-a' },
      contextDelivered: true,
    })
  })

  it('wraps the background before quotes and the question', () => {
    const text = composePrompt('why?', [{ id: 'q1', text: 'quoted', createdAt: 1 }], 'background')
    expect(text.startsWith(BACKGROUND_OPEN)).toBe(true)
    expect(text).toContain('【主会话背景】')
    expect(text.indexOf('background')).toBeLessThan(text.indexOf('【引用 1】'))
    expect(text.endsWith('【问题】\nwhy?')).toBe(true)
    expect(text).toContain(BACKGROUND_CLOSE)
  })
})

describe('isQuotableNodeKey', () => {
  it('accepts user and assistant message rows only', () => {
    expect(isQuotableNodeKey('13:input-messageabc')).toBe(true)
    expect(isQuotableNodeKey('7:agent-messageabc')).toBe(true)
    expect(isQuotableNodeKey('14:assistant-step1:1')).toBe(true)
    expect(isQuotableNodeKey('12:turn-process1')).toBe(false)
    expect(isQuotableNodeKey('10:turn-error1')).toBe(false)
    expect(isQuotableNodeKey(null)).toBe(false)
    expect(isQuotableNodeKey(undefined)).toBe(false)
    expect(isQuotableNodeKey('')).toBe(false)
  })
})

describe('hydrate merging', () => {
  it('keeps a draft created before the record and merges persisted chats', () => {
    const chats = book()
    const early = chats.createDraft()
    chats.setDraftText(early.id, 'early draft')
    chats.hydrate({
      activeId: 'old-1',
      chats: [
        { id: 'old-1', title: '旧侧聊', stage: 'real', status: 'open', sideSessionId: 'session-1', draftText: '', pendingQuotes: [], contextMode: 'summary', createdAt: 1, updatedAt: 1 },
      ],
    })
    expect(chats.list().map(chat => chat.id)).toEqual([early.id, 'old-1'])
    expect(chats.getActive()?.id).toBe(early.id)
    expect(chats.exportState().chats.map(chat => chat.id)).toEqual([early.id, 'old-1'])
  })

  it('never activates a saved chat while restoring', () => {
    const chats = book()
    chats.hydrate({
      activeId: 'old-saved',
      chats: [
        { id: 'old-saved', title: '已保留', stage: 'draft', status: 'saved', draftText: '', pendingQuotes: [], contextMode: 'summary', createdAt: 1, updatedAt: 1 },
      ],
    })
    expect(chats.getActive()).toBeUndefined()
    expect(chats.list()).toHaveLength(1)
  })
})

describe('archived chats', () => {
  it('moves the active chat out of open on manual archive and keeps it listed', () => {
    const chats = book()
    const first = chats.createDraft()
    const second = chats.createDraft()
    chats.setStatus(second.id, 'archived', 'manual')
    expect(chats.get(second.id)).toMatchObject({ status: 'archived', archivedReason: 'manual' })
    expect(chats.getSnapshot().activeId).toBe(first.id)
    expect(chats.exportState().chats.find(chat => chat.id === second.id)).toMatchObject({
      status: 'archived',
      archivedReason: 'manual',
    })
  })

  it('archives every chat when the parent is removed', () => {
    const chats = book()
    const first = chats.createDraft()
    const second = chats.createDraft()
    chats.setStatus(first.id, 'saved')
    chats.archiveAllForParent('parent-removed')
    expect(chats.list().map(chat => chat.status)).toEqual(['archived', 'archived'])
    expect(chats.list().map(chat => chat.archivedReason)).toEqual(['parent-removed', 'parent-removed'])
    expect(chats.getSnapshot().activeId).toBeUndefined()
  })

  it('infers first send completion from a delivered background on old records', () => {
    const chats = book()
    chats.hydrate({
      chats: [{
        id: 'old', title: '旧', stage: 'real', status: 'open', sideSessionId: 'session-1',
        draftText: '', pendingQuotes: [], sentQuotes: [], contextDelivered: true,
        contextSnapshot: { text: 'old', createdAt: 1, sourceSessionId: 'parent-a' },
        contextMode: 'summary', createdAt: 1, updatedAt: 1,
      }],
    })
    expect(chats.get('old')?.firstSendDone).toBe(true)
  })

  it('never activates an archived chat while restoring', () => {
    const chats = book()
    chats.hydrate({
      activeId: 'old-archived',
      chats: [{
        id: 'old-archived', title: '归档', stage: 'draft', status: 'archived', archivedReason: 'manual',
        draftText: '', pendingQuotes: [], sentQuotes: [], contextMode: 'summary', createdAt: 1, updatedAt: 1,
      }],
    })
    expect(chats.getActive()).toBeUndefined()
    expect(chats.get('old-archived')?.status).toBe('archived')
  })
})
