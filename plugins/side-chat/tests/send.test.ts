import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('react', () => ({
  useCallback: (fn: unknown) => fn,
  useRef: (initial: unknown) => ({ current: initial }),
  useState: (initial: unknown) => [typeof initial === 'function' ? (initial as () => unknown)() : initial, () => {}],
}))

import { ChatBook } from '../src/client/chat-book.ts'
import type { SessionBindingLike, SessionsServiceLike, WorkspacesServiceLike } from '../src/client/host-api.ts'
import { useSideChatSessions } from '../src/client/use-side-chat.ts'

interface StubOptions {
  readonly readyFailsFor?: readonly string[]
  readonly readyFailsAll?: boolean
  readonly promptThrows?: boolean
  readonly promptErrorCode?: string
  readonly deferredPrompt?: boolean
  readonly blank?: boolean
  readonly history?: 'fail' | 'stall' | 'add-older' | 'add-older-and-new'
}

let requestCounter = 0

function makeBinding(
  sessionId: string,
  state: { entries: unknown[]; parentEntries?: unknown[]; hasMore?: boolean; loadCalls?: number; resolvePrompt?: (value: unknown) => void },
  options: StubOptions,
  prompts: { text: string; requestId?: string }[],
): SessionBindingLike {
  const binding: SessionBindingLike = {
    sessionId,
    session: {
      getSnapshot: () => ({
        running: false,
        openState: 'open',
        promptError: null,
        lastAgentError: null,
        openError: null,
        removed: false,
        blank: options.blank ?? true,
      }),
      subscribe: () => () => {},
      beginSubmission: () => ({ requestId: `req-${++requestCounter}`, abandon: () => {} }),
      loadOlder: options.history === undefined ? undefined : async () => {
        state.loadCalls = (state.loadCalls ?? 0) + 1
        if (options.history === 'fail') throw new Error('history failed')
        if (options.history === 'stall') return
        state.entries.unshift({
          type: 'event',
          event: { type: 'user/message', seq: 1, data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'older context' }] } },
        })
        if (options.history === 'add-older-and-new') {
          state.entries.push({
            type: 'event',
            event: { type: 'user/message', seq: 9, data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'arrived-after-click' }] } },
          })
        }
        state.hasMore = false
      },
      prompt: async (content, _mode, _signal, requestId) => {
        prompts.push({ text: content[0]?.text ?? '', requestId })
        if (options.promptThrows === true) throw new Error('network lost after send')
        if (options.promptErrorCode !== undefined) return { ok: false, error: { code: options.promptErrorCode, message: 'carrier failed' } }
        if (options.deferredPrompt === true) {
          return await new Promise(resolve => { state.resolvePrompt = value => resolve(value as { ok: true; value: { accepted: true } }) })
        }
        return { ok: true, value: { accepted: true } }
      },
    },
    eventSource: {
      getSnapshot: () => ({
        entries: sessionId === 'parent-a' ? (state.parentEntries ?? state.entries) : state.entries,
        hasMore: state.hasMore === true,
        revision: 0,
      }),
      subscribe: () => () => {},
    },
  }
  return binding
}

function makeSessions(options: StubOptions = {}): {
  sessions: SessionsServiceLike
  workspaces: WorkspacesServiceLike
  created: string[]
  createOptions: unknown[]
  retained: string[]
  prompts: { text: string; requestId?: string }[]
  state: { entries: unknown[]; parentEntries?: unknown[]; hasMore?: boolean; loadCalls?: number; resolvePrompt?: (value: unknown) => void }
  bindingFor: (id: string) => SessionBindingLike
} {
  const created: string[] = []
  const createOptions: unknown[] = []
  const retained: string[] = []
  const prompts: { text: string; requestId?: string }[] = []
  const state: { entries: unknown[]; parentEntries?: unknown[]; hasMore?: boolean; resolvePrompt?: (value: unknown) => void } = { entries: [] }
  const bindings = new Map<string, SessionBindingLike>()
  let nextId = 1
  const sessions: SessionsServiceLike = {
    list: {
      getSnapshot: () => ({ ids: ['parent-a'], byId: { 'parent-a': { id: 'parent-a', cwd: '/work' } } }),
      subscribe: () => () => {},
    },
    create: async (options) => {
      const id = options?.sessionId ?? `session-new-${nextId++}`
      created.push(id)
      createOptions.push(options)
      return id
    },
    retain: (id: string) => {
      retained.push(id)
      let binding = bindings.get(id)
      if (binding === undefined) {
        binding = makeBinding(id, state, options, prompts)
        bindings.set(id, binding)
      }
      const ready = (options.readyFailsAll === true && id !== 'parent-a') || options.readyFailsFor?.includes(id) === true
        ? Promise.reject(new Error('ready failed'))
        : Promise.resolve(binding)
      return {
        sessionId: id,
        binding,
        ready,
        release: () => {},
      }
    },
    binding: (id: string) => bindings.get(id),
  }
  const workspaces = {
    list: {
      getSnapshot: () => ({ items: [{ workspaceId: 'ws-parent', path: '/work', sessionIds: ['parent-a'] }] }),
      subscribe: () => () => {},
    },
  }
  return {
    sessions,
    workspaces,
    created,
    createOptions,
    retained,
    prompts,
    state,
    bindingFor: (id: string) => {
      let binding = bindings.get(id)
      if (binding === undefined) {
        binding = makeBinding(id, state, options, prompts)
        bindings.set(id, binding)
      }
      return binding
    },
  }
}

function hydratedBook(chat: Partial<Record<string, unknown>> & { id: string; draftText: string }): ChatBook {
  const book = new ChatBook('parent-a', { createId: () => 'chat-new', now: () => 100 })
  book.hydrate({
    activeId: chat.id,
    chats: [{
      title: '侧聊 1',
      stage: 'real',
      status: 'open',
      sideSessionId: 'session-real',
      pendingQuotes: [],
      firstSendDone: true,
      contextMode: 'none',
      createdAt: 1,
      updatedAt: 1,
      ...chat,
    } as never],
  })
  return book
}

describe('send pipeline', () => {
  beforeEach(() => { requestCounter = 0 })

  it('restores the recorded session id instead of creating a new one', async () => {
    const book = hydratedBook({ id: 'chat-1', draftText: 'hello' })
    const stub = makeSessions()
    const refs = useSideChatSessions(book, stub.sessions, stub.workspaces, 'parent-a', async () => {})
    await refs.send('chat-1')
    expect(stub.created).toEqual([])
    expect(stub.retained).toEqual(['session-real'])
    expect(stub.prompts).toHaveLength(1)
    expect(book.get('chat-1')?.draftText).toBe('')
  })

  it('records a created session before waiting for its binding', async () => {
    const book = new ChatBook('parent-a', { createId: () => 'chat-new', now: () => 100 })
    book.createDraft()
    book.setDraftText('chat-new', 'hello')
    const stub = makeSessions({ readyFailsAll: true })
    const refs = useSideChatSessions(book, stub.sessions, stub.workspaces, 'parent-a', async () => {})

    await refs.send('chat-new')
    const createdId = stub.created[0]
    expect(createdId).toBeDefined()
    expect(book.get('chat-new')?.sideSessionId).toBe(createdId)
    expect(book.get('chat-new')?.stage).toBe('real')

    await refs.send('chat-new')
    expect(stub.created).toEqual([createdId])
    expect(stub.createOptions[0]).toMatchObject({ workspaceId: 'ws-parent', sessionId: createdId })
    expect(stub.retained.filter(id => id === createdId)).toHaveLength(2)
  })

  it('blocks a resend when the submission result is unknown', async () => {
    const book = hydratedBook({ id: 'chat-1', draftText: 'hello' })
    const stub = makeSessions({ promptThrows: true })
    const refs = useSideChatSessions(book, stub.sessions, stub.workspaces, 'parent-a', async () => {})

    await refs.send('chat-1')
    expect(book.get('chat-1')?.pendingSend).toMatchObject({ text: 'hello' })
    expect(stub.prompts).toHaveLength(1)

    await refs.send('chat-1')
    expect(stub.prompts).toHaveLength(1)

    stub.state.entries.push({
      type: 'event',
      event: { type: 'user/message', seq: 1, data: { source: { kind: 'user', rpcId: book.get('chat-1')?.pendingSend?.requestId } } },
    })
    await refs.send('chat-1')
    expect(book.get('chat-1')?.pendingSend).toBeUndefined()
    expect(book.get('chat-1')?.draftText).toBe('')
  })

  it('keeps a draft and quotes added while the request is in flight', async () => {
    const book = hydratedBook({ id: 'chat-1', draftText: 'first question' })
    book.addQuote('chat-1', { id: 'q1', text: 'quoted', createdAt: 1 })
    const stub = makeSessions({ deferredPrompt: true })
    const refs = useSideChatSessions(book, stub.sessions, stub.workspaces, 'parent-a', async () => {})

    const sending = refs.send('chat-1')
    await vi.waitFor(() => expect(stub.prompts).toHaveLength(1))
    expect(stub.prompts[0].text).toContain('quoted')
    expect(stub.prompts[0].text).toContain('first question')
    book.setDraftText('chat-1', 'next question')
    book.addQuote('chat-1', { id: 'q2', text: 'later', createdAt: 2 })

    await vi.waitFor(() => expect(typeof stub.state.resolvePrompt).toBe('function'))
    stub.state.resolvePrompt?.({ ok: true, value: { accepted: true } })
    await sending

    expect(book.get('chat-1')?.draftText).toBe('next question')
    expect(book.get('chat-1')?.pendingQuotes.map(quote => quote.id)).toEqual(['q2'])
  })
})

describe('submission outcome classification', () => {
  beforeEach(() => { requestCounter = 0 })

  it('treats a carrier error as unknown instead of a definite rejection', async () => {
    const book = hydratedBook({ id: 'chat-1', draftText: 'hello' })
    const stub = makeSessions({ promptErrorCode: 'gateway/internal' })
    const refs = useSideChatSessions(book, stub.sessions, stub.workspaces, 'parent-a', async () => {})

    await refs.send('chat-1')
    expect(book.get('chat-1')?.pendingSend).toBeDefined()
    expect(stub.prompts).toHaveLength(1)

    await refs.send('chat-1')
    expect(stub.prompts).toHaveLength(1)
  })

  it('treats a session business error as a definite rejection', async () => {
    const book = hydratedBook({ id: 'chat-1', draftText: 'hello' })
    const stub = makeSessions({ promptErrorCode: 'session/not-found' })
    const refs = useSideChatSessions(book, stub.sessions, stub.workspaces, 'parent-a', async () => {})

    await refs.send('chat-1')
    expect(book.get('chat-1')?.pendingSend).toBeUndefined()
    await refs.send('chat-1')
    expect(stub.prompts).toHaveLength(2)
  })

  it('treats a cancellation result as unknown, not as proof of non-acceptance', async () => {
    const book = hydratedBook({ id: 'chat-1', draftText: 'hello' })
    const stub = makeSessions({ promptErrorCode: 'gateway/cancelled' })
    const refs = useSideChatSessions(book, stub.sessions, stub.workspaces, 'parent-a', async () => {})
    await refs.send('chat-1')
    expect(book.get('chat-1')?.pendingSend).toBeDefined()
    await refs.send('chat-1')
    expect(stub.prompts).toHaveLength(1)
  })

  it('marks the summary as delivered when reconciliation proves acceptance', async () => {
    const book = new ChatBook('parent-a', { createId: () => 'chat-ctx', now: () => 100 })
    book.hydrate({
      activeId: 'chat-ctx',
      chats: [{
        id: 'chat-ctx',
        title: '侧聊',
        stage: 'real',
        status: 'open',
        sideSessionId: 'session-real',
        draftText: 'hello',
        pendingQuotes: [],
        sentQuotes: [],
        contextMode: 'summary',
        contextSnapshot: { text: 'parent says hi', createdAt: 1, sourceSessionId: 'parent-a' },
        contextDelivered: false,
        pendingSend: { requestId: 'req-known', text: 'hello', quoteIds: [], contextInjected: true, createdAt: 2 },
        createdAt: 1,
        updatedAt: 2,
      } as never],
    })
    const stub = makeSessions()
    stub.state.entries.push({
      type: 'event',
      event: { type: 'user/message', seq: 1, data: { source: { kind: 'user', rpcId: 'req-known' } } },
    })
    const refs = useSideChatSessions(book, stub.sessions, stub.workspaces, 'parent-a', async () => {})
    await refs.send('chat-ctx')
    expect(book.get('chat-ctx')?.pendingSend).toBeUndefined()
    expect(book.get('chat-ctx')?.contextDelivered).toBe(true)
  })

  it('does not retry a failed restore on every render', async () => {
    const book = hydratedBook({ id: 'chat-1', draftText: '' })
    const stub = makeSessions({ readyFailsAll: true })
    const refs = useSideChatSessions(book, stub.sessions, stub.workspaces, 'parent-a', async () => {})
    expect(await refs.restore('chat-1')).toBeUndefined()
    expect(await refs.restore('chat-1')).toBeUndefined()
    expect(stub.retained).toEqual(['session-real'])
  })

  it('keeps sent quote sources after acceptance', async () => {
    const book = hydratedBook({ id: 'chat-1', draftText: 'hello' })
    book.addQuote('chat-1', { id: 'q1', text: 'quoted', createdAt: 1, sourceNodeKey: 'node-1' })
    const stub = makeSessions()
    const refs = useSideChatSessions(book, stub.sessions, stub.workspaces, 'parent-a', async () => {})
    await refs.send('chat-1')
    expect(book.get('chat-1')?.pendingQuotes).toHaveLength(0)
    expect(book.get('chat-1')?.sentQuotes[0]).toMatchObject({
      quote: { id: 'q1', text: 'quoted', sourceNodeKey: 'node-1' },
    })
  })

  it('persists the submission identity before the prompt leaves', async () => {
    const book = hydratedBook({ id: 'chat-1', draftText: 'hello' })
    const order: string[] = []
    const stub = makeSessions()
    const persist = async (): Promise<void> => {
      order.push(book.get('chat-1')?.pendingSend === undefined ? 'persist-no-pending' : 'persist-pending')
    }
    const refs = useSideChatSessions(book, stub.sessions, stub.workspaces, 'parent-a', persist)
    await refs.send('chat-1')
    expect(order[0]).toBe('persist-pending')
    expect(stub.prompts).toHaveLength(1)
  })
})


describe('initialization and restore failures', () => {
  it('never calls create when the pending create identity could not be saved', async () => {
    const book = new ChatBook('parent-a', { createId: () => 'chat-new', now: () => 100 })
    book.createDraft()
    book.setDraftText('chat-new', 'hello')
    const stub = makeSessions()
    let persistCalls = 0
    const persist = async (): Promise<void> => {
      persistCalls += 1
      throw new Error('side-chat/not-ready')
    }
    const refs = useSideChatSessions(book, stub.sessions, stub.workspaces, 'parent-a', persist)
    await refs.send('chat-new')
    expect(stub.created).toEqual([])
    expect(book.get('chat-new')?.pendingCreate).toBeDefined()
    expect(persistCalls).toBe(1)
  })

  it('retries the identity save before reusing a pending create id', async () => {
    const book = new ChatBook('parent-a', { createId: () => 'chat-new', now: () => 100 })
    book.createDraft()
    book.setDraftText('chat-new', 'hello')
    const stub = makeSessions()
    let persistCalls = 0
    const persist = async (): Promise<void> => {
      persistCalls += 1
      if (persistCalls === 1) throw new Error('save failed')
    }
    const refs = useSideChatSessions(book, stub.sessions, stub.workspaces, 'parent-a', persist)
    await refs.send('chat-new')
    expect(stub.created).toEqual([])
    await refs.send('chat-new')
    expect(stub.created).toHaveLength(1)
    expect(stub.createOptions[0]).toMatchObject({ sessionId: book.get('chat-new')?.sideSessionId })
  })

  it('handles a synchronous retain throw and retries it explicitly', async () => {
    const book = hydratedBook({ id: 'chat-1', draftText: '' })
    const stub = makeSessions()
    let attempts = 0
    stub.sessions.retain = () => {
      attempts += 1
      throw new Error('sessions.retain: unknown session')
    }
    const refs = useSideChatSessions(book, stub.sessions, stub.workspaces, 'parent-a', async () => {})
    expect(await refs.restore('chat-1')).toBeUndefined()
    expect(await refs.restore('chat-1')).toBeUndefined()
    expect(attempts).toBe(1)
    expect(await refs.restore('chat-1', true)).toBeUndefined()
    expect(attempts).toBe(2)
  })
})

describe('first-send background rules', () => {
  function draftBook(): ChatBook {
    const book = new ChatBook('parent-a', { createId: () => 'chat-new', now: () => 100 })
    book.createDraft()
    book.setDraftText('chat-new', 'question')
    return book
  }

  function withParentMessage(stub: ReturnType<typeof makeSessions>): void {
    stub.state.entries.push({
      type: 'event',
      event: { type: 'user/message', seq: 1, data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'parent context' }] } },
    })
  }

  it('attaches the parent background on a first send without quotes', async () => {
    const book = draftBook()
    const stub = makeSessions()
    withParentMessage(stub)
    const refs = useSideChatSessions(book, stub.sessions, stub.workspaces, 'parent-a', async () => {})
    await refs.send('chat-new')
    expect(stub.retained).toContain('parent-a')
    expect(stub.prompts[0].text).toContain('parent context')
    expect(stub.prompts[0].text).toContain('⟦side-chat-background⟧')
    expect(book.get('chat-new')?.firstSendDone).toBe(true)
    expect(book.get('chat-new')?.contextDelivered).toBe(true)
  })

  it('skips the background when the first send has quotes and never adds it later', async () => {
    const book = draftBook()
    book.addQuote('chat-new', { id: 'q1', text: 'quoted', createdAt: 1 })
    const stub = makeSessions()
    withParentMessage(stub)
    const refs = useSideChatSessions(book, stub.sessions, stub.workspaces, 'parent-a', async () => {})
    await refs.send('chat-new')
    expect(stub.retained).not.toContain('parent-a')
    expect(stub.prompts[0].text).not.toContain('parent context')
    expect(book.get('chat-new')?.firstSendDone).toBe(true)

    book.setDraftText('chat-new', 'second question')
    await refs.send('chat-new')
    expect(stub.prompts[1].text).not.toContain('parent context')
    expect(stub.retained).not.toContain('parent-a')
  })

  it('does not add the background again after a successful background first send', async () => {
    const book = draftBook()
    const stub = makeSessions()
    withParentMessage(stub)
    const refs = useSideChatSessions(book, stub.sessions, stub.workspaces, 'parent-a', async () => {})
    await refs.send('chat-new')
    book.setDraftText('chat-new', 'follow up')
    await refs.send('chat-new')
    expect(stub.prompts[1].text).not.toContain('⟦side-chat-background⟧')
  })

  it('keeps the draft when the background cannot be read', async () => {
    const book = draftBook()
    const stub = makeSessions({ readyFailsFor: ['parent-a'] })
    const refs = useSideChatSessions(book, stub.sessions, stub.workspaces, 'parent-a', async () => {})
    await refs.send('chat-new')
    expect(stub.prompts).toHaveLength(0)
    expect(stub.created).toEqual([])
    expect(book.get('chat-new')?.draftText).toBe('question')
    expect(book.get('chat-new')?.firstSendDone).toBeUndefined()
  })
})

describe('background safety', () => {
  function draftBook(): ChatBook {
    const book = new ChatBook('parent-a', { createId: () => 'chat-new', now: () => 100 })
    book.createDraft()
    book.setDraftText('chat-new', 'question')
    return book
  }

  function recentParent(stub: ReturnType<typeof makeSessions>): void {
    stub.state.entries.push({
      type: 'event',
      event: { type: 'user/message', seq: 2, data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'recent context' }] } },
    })
    stub.state.hasMore = true
  }

  it('fails instead of sending an incomplete snapshot when history loading fails', async () => {
    for (const history of ['fail', 'stall'] as const) {
      const book = draftBook()
      const stub = makeSessions({ history })
      recentParent(stub)
      const refs = useSideChatSessions(book, stub.sessions, stub.workspaces, 'parent-a', async () => {})
      await refs.send('chat-new')
      expect(stub.prompts).toHaveLength(0)
      expect(stub.created).toEqual([])
      expect(book.get('chat-new')?.draftText).toBe('question')
      expect(book.get('chat-new')?.contextSnapshot).toBeUndefined()
    }
  })

  it('fails when older history remains but no loader is available', async () => {
    const book = draftBook()
    const stub = makeSessions()
    recentParent(stub)
    const refs = useSideChatSessions(book, stub.sessions, stub.workspaces, 'parent-a', async () => {})
    await refs.send('chat-new')
    expect(stub.prompts).toHaveLength(0)
    expect(book.get('chat-new')?.draftText).toBe('question')
  })

  it('keeps the cutoff frozen while older pages load', async () => {
    const book = draftBook()
    const stub = makeSessions({ history: 'add-older-and-new' })
    recentParent(stub)
    const refs = useSideChatSessions(book, stub.sessions, stub.workspaces, 'parent-a', async () => {})
    await refs.send('chat-new')
    const prompt = stub.prompts[0]?.text ?? ''
    expect(prompt).toContain('older context')
    expect(prompt).toContain('recent context')
    expect(prompt).not.toContain('arrived-after-click')
    expect(book.get('chat-new')?.contextSnapshot?.sourceToSeq).toBe(2)
  })

  it('does not re-inject a background into a chat that already delivered one', async () => {
    const book = hydratedBook({
      id: 'chat-1',
      draftText: 'follow up',
      sideSessionId: 'session-real',
      firstSendDone: undefined,
      contextDelivered: true,
      contextSnapshot: { text: 'old background', createdAt: 1, sourceSessionId: 'parent-a' },
    })
    const stub = makeSessions({ blank: false })
    const refs = useSideChatSessions(book, stub.sessions, stub.workspaces, 'parent-a', async () => {})
    await refs.send('chat-1')
    expect(stub.retained).not.toContain('parent-a')
    expect(stub.prompts[0].text).not.toContain('old background')
    expect(book.get('chat-1')?.firstSendDone).toBe(true)
  })

  it('treats an old real session with messages as already sent', async () => {
    const book = hydratedBook({ id: 'chat-1', draftText: 'follow up', firstSendDone: undefined })
    const stub = makeSessions({ blank: false })
    const refs = useSideChatSessions(book, stub.sessions, stub.workspaces, 'parent-a', async () => {})
    await refs.send('chat-1')
    expect(stub.retained).not.toContain('parent-a')
    expect(book.get('chat-1')?.firstSendDone).toBe(true)
  })

  it('adds the background to an existing session that has no turn yet', async () => {
    const book = hydratedBook({ id: 'chat-1', draftText: 'first question', firstSendDone: undefined })
    const stub = makeSessions({ blank: true })
    stub.state.parentEntries = [{
      type: 'event',
      event: { type: 'user/message', seq: 1, data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'parent context' }] } },
    }]
    const refs = useSideChatSessions(book, stub.sessions, stub.workspaces, 'parent-a', async () => {})
    await refs.send('chat-1')
    expect(stub.prompts[0].text).toContain('parent context')
    expect(book.get('chat-1')?.firstSendDone).toBe(true)
  })

  it('refuses to send or create when the chat is archived', async () => {
    const book = hydratedBook({ id: 'chat-1', draftText: 'hello', status: 'archived', archivedReason: 'manual' })
    const stub = makeSessions()
    const refs = useSideChatSessions(book, stub.sessions, stub.workspaces, 'parent-a', async () => {})
    await refs.send('chat-1')
    expect(stub.prompts).toHaveLength(0)
    expect(stub.created).toEqual([])
  })

  it('refuses new submissions while the chat is archiving', async () => {
    const book = hydratedBook({ id: 'chat-1', draftText: 'hello', status: 'archiving', archivedReason: 'manual' })
    const stub = makeSessions()
    const refs = useSideChatSessions(book, stub.sessions, stub.workspaces, 'parent-a', async () => {})
    await refs.send('chat-1')
    expect(stub.prompts).toHaveLength(0)
    expect(stub.created).toEqual([])
  })
})

describe('budget boundary and archive races', () => {
  it('freezes at the message boundary instead of chasing an exact budget', async () => {
    const book = new ChatBook('parent-a', { createId: () => 'chat-new', now: () => 1 })
    book.createDraft()
    book.setDraftText('chat-new', 'question')
    const stub = makeSessions()
    stub.state.entries.push(
      { type: 'event', event: { type: 'user/message', seq: 1, data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'a'.repeat(3000) }] } } },
      { type: 'event', event: { type: 'user/message', seq: 2, data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'b'.repeat(7000) }] } } },
    )
    stub.state.hasMore = true
    const refs = useSideChatSessions(book, stub.sessions, stub.workspaces, 'parent-a', async () => {})
    await refs.send('chat-new')
    expect(stub.prompts).toHaveLength(1)
    expect(stub.state.loadCalls ?? 0).toBe(0)
    expect(stub.prompts[0].text).toContain('b'.repeat(100))
    expect(stub.prompts[0].text).not.toContain('a'.repeat(100))
  })

  it('rechecks archived after the identity persist and skips create', async () => {
    const book = new ChatBook('parent-a', { createId: () => 'chat-new', now: () => 1 })
    book.createDraft()
    book.setDraftText('chat-new', 'question')
    const stub = makeSessions()
    let archivedOnPersist = false
    const refs = useSideChatSessions(book, stub.sessions, stub.workspaces, 'parent-a', async () => {
      if (!archivedOnPersist) {
        archivedOnPersist = true
        book.setStatus('chat-new', 'archived', 'manual')
      }
    })
    await refs.send('chat-new')
    expect(stub.created).toEqual([])
    expect(stub.prompts).toHaveLength(0)
    expect(book.get('chat-new')?.draftText).toBe('question')
  })
})

describe('read-only reconcile', () => {
  const pendingSend = { requestId: 'req-1', text: 'question', quoteIds: [], createdAt: 1 }

  it('clears a pending send when the durable history contains it', async () => {
    const book = hydratedBook({ id: 'chat-1', draftText: '', pendingSend })
    const stub = makeSessions({ blank: false })
    stub.state.entries.push({
      type: 'event',
      event: { type: 'user/message', seq: 1, data: { rpcId: 'req-1', source: { kind: 'user' }, content: [{ type: 'text', text: 'question' }] } },
    })
    const refs = useSideChatSessions(book, stub.sessions, stub.workspaces, 'parent-a', async () => {})
    await expect(refs.reconcile('chat-1')).resolves.toBe('delivered')
    expect(book.get('chat-1')?.pendingSend).toBeUndefined()
    expect(book.get('chat-1')?.firstSendDone).toBe(true)
    expect(stub.prompts).toHaveLength(0)
  })

  it('settles a delivered reconcile like a normal success', async () => {
    const quote = { id: 'q1', text: 'quoted', createdAt: 1 }
    const book = hydratedBook({
      id: 'chat-1',
      draftText: 'question',
      pendingQuotes: [quote],
      pendingSend: { ...pendingSend, quoteIds: ['q1'], quotes: [quote] },
    })
    const stub = makeSessions({ blank: false })
    stub.state.entries.push({
      type: 'event',
      event: { type: 'user/message', seq: 1, data: { rpcId: 'req-1', source: { kind: 'user' }, content: [{ type: 'text', text: 'question' }] } },
    })
    const refs = useSideChatSessions(book, stub.sessions, stub.workspaces, 'parent-a', async () => {})
    await expect(refs.reconcile('chat-1')).resolves.toBe('delivered')
    expect(book.get('chat-1')?.pendingSend).toBeUndefined()
    expect(book.get('chat-1')?.pendingQuotes).toEqual([])
    expect(book.get('chat-1')?.sentQuotes.map(item => item.quote.id)).toEqual(['q1'])
    expect(book.get('chat-1')?.draftText).toBe('')
  })

  it('does not match the same question from a different request id', async () => {
    const book = hydratedBook({ id: 'chat-1', draftText: '', pendingSend })
    const stub = makeSessions({ blank: false })
    stub.state.entries.push({
      type: 'event',
      event: { type: 'user/message', seq: 1, data: { rpcId: 'req-other', source: { kind: 'user' }, content: [{ type: 'text', text: 'question' }] } },
    })
    const refs = useSideChatSessions(book, stub.sessions, stub.workspaces, 'parent-a', async () => {})
    await expect(refs.reconcile('chat-1')).resolves.toBe('absent')
    expect(book.get('chat-1')?.pendingSend?.requestId).toBe('req-1')
    expect(stub.prompts).toHaveLength(0)
  })
})
