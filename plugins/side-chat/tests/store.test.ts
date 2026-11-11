import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { SideChatStore, SideChatStoreError } from '../src/host/store.ts'
import type { PersistedChat, PersistedState } from '../src/shared/types.ts'

const roots: string[] = []

async function workspace(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'side-chat-store-'))
  roots.push(root)
  return root
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

function chat(id: string, overrides: Partial<PersistedChat> = {}): PersistedChat {
  return {
    id,
    title: id,
    stage: 'draft',
    status: 'open',
    draftText: '',
    contextMode: 'summary',
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  }
}

function state(chats: readonly PersistedChat[], activeId?: string): PersistedState {
  return { ...(activeId === undefined ? {} : { activeId }), chats }
}

describe('SideChatStore', () => {
  it('persists each parent separately and keeps the active pointer', async () => {
    const root = await workspace()
    const path = join(root, 'state.json')
    const store = new SideChatStore(path)
    await store.save('parent-a', state([chat('a1', { draftText: 'hello' })], 'a1'))
    await store.save('parent-b', state([chat('b1')], 'b1'))

    const reopened = new SideChatStore(path)
    expect(await reopened.load('parent-a')).toMatchObject({ activeId: 'a1', chats: [{ id: 'a1', draftText: 'hello' }] })
    expect(await reopened.load('parent-b')).toMatchObject({ activeId: 'b1', chats: [{ id: 'b1' }] })
    expect(await reopened.load('parent-c')).toBeNull()
  })

  it('serializes concurrent saves without losing either parent', async () => {
    const root = await workspace()
    const store = new SideChatStore(join(root, 'state.json'))
    await Promise.all([
      store.save('parent-a', state([chat('a1')], 'a1')),
      store.save('parent-b', state([chat('b1')], 'b1')),
    ])
    const reopened = new SideChatStore(join(root, 'state.json'))
    expect((await reopened.load('parent-a'))?.chats.map(entry => entry.id)).toEqual(['a1'])
    expect((await reopened.load('parent-b'))?.chats.map(entry => entry.id)).toEqual(['b1'])
  })

  it('rejects invalid state without writing it', async () => {
    const root = await workspace()
    const path = join(root, 'state.json')
    const store = new SideChatStore(path)
    await expect(store.save('parent-a', state([chat('a1')], 'missing'))).rejects.toBeInstanceOf(SideChatStoreError)
    await expect(store.save('parent-a', state([chat('a1', { stage: 'real' })]))).rejects.toBeInstanceOf(SideChatStoreError)
    expect(await store.load('parent-a')).toBeNull()
  })

  it('refuses to overwrite a corrupt record', async () => {
    const root = await workspace()
    const path = join(root, 'state.json')
    await writeFile(path, '{ not json', 'utf8')
    const store = new SideChatStore(path)
    await expect(store.save('parent-a', state([chat('a1')]))).rejects.toMatchObject({ code: 'side-chat/store-corrupt' })
    expect(await readFile(path, 'utf8')).toBe('{ not json')
  })

  it('reads a version 1 record and defaults missing status to open', async () => {
    const root = await workspace()
    const path = join(root, 'state.json')
    await writeFile(path, JSON.stringify({
      version: 1,
      parents: {
        'parent-a': {
          activeId: 'a1',
          chats: [{ id: 'a1', title: '旧记录', stage: 'draft', draftText: 'x', contextMode: 'summary', createdAt: 1, updatedAt: 1 }],
        },
      },
    }), 'utf8')
    const store = new SideChatStore(path)
    expect((await store.load('parent-a'))?.chats[0]).toMatchObject({ status: 'open' })
    await store.save('parent-b', state([chat('b1')]))
    const written = JSON.parse(await readFile(path, 'utf8'))
    expect(written.version).toBe(2)
    expect(written.parents['parent-a'].chats[0].status).toBe('open')
  })

  it('persists the saved management status', async () => {
    const root = await workspace()
    const path = join(root, 'state.json')
    const store = new SideChatStore(path)
    await store.save('parent-a', state([chat('a1', { status: 'saved' }), chat('a2')], 'a2'))
    const reopened = new SideChatStore(path)
    expect((await reopened.load('parent-a'))?.chats.map(entry => entry.status)).toEqual(['saved', 'open'])
  })

  it('persists a context snapshot and rejects a malformed one', async () => {
    const root = await workspace()
    const path = join(root, 'state.json')
    const store = new SideChatStore(path)
    await store.save('parent-a', state([chat('a1', {
      contextSnapshot: { text: 'summary', createdAt: 5, sourceSessionId: 'parent-a' },
      contextDelivered: true,
    })], 'a1'))
    const reopened = new SideChatStore(path)
    expect((await reopened.load('parent-a'))?.chats[0]).toMatchObject({
      contextSnapshot: { text: 'summary', sourceSessionId: 'parent-a' },
      contextDelivered: true,
    })
    await expect(store.save('parent-a', state([chat('a2', { contextSnapshot: { text: 'x' } as never })])))
      .rejects.toBeInstanceOf(SideChatStoreError)
  })

  it('persists archived status and reason', async () => {
    const root = await workspace()
    const path = join(root, 'state.json')
    const store = new SideChatStore(path)
    await store.save('parent-a', state([chat('a1', { status: 'archived', archivedReason: 'parent-removed' })], 'a1'))
    const reopened = new SideChatStore(path)
    expect((await reopened.load('parent-a'))?.chats[0]).toMatchObject({
      status: 'archived',
      archivedReason: 'parent-removed',
    })
  })

  it('persists the archiving status', async () => {
    const root = await workspace()
    const path = join(root, 'state.json')
    const store = new SideChatStore(path)
    await store.save('parent-a', state([chat('a1', { status: 'archiving' })], undefined))
    const reopened = new SideChatStore(path)
    expect((await reopened.load('parent-a'))?.chats[0]?.status).toBe('archiving')
  })

  it('accepts real chats with a side session id', async () => {
    const root = await workspace()
    const path = join(root, 'state.json')
    const store = new SideChatStore(path)
    await store.save('parent-a', state([chat('a1', { stage: 'real', sideSessionId: 'session-1' })], 'a1'))
    const reopened = new SideChatStore(path)
    expect((await reopened.load('parent-a'))?.chats[0]).toMatchObject({ stage: 'real', sideSessionId: 'session-1' })
  })
})

describe('pending send', () => {
  it('persists an unknown submission and rejects malformed records', async () => {
    const root = await workspace()
    const path = join(root, 'state.json')
    const store = new SideChatStore(path)
    await store.save('parent-a', state([chat('a1', {
      stage: 'real',
      sideSessionId: 'session-1',
      pendingSend: { requestId: 'req-1', text: 'hello', quoteIds: ['q1'], createdAt: 5 },
    })], 'a1'))
    const reopened = new SideChatStore(path)
    expect((await reopened.load('parent-a'))?.chats[0]).toMatchObject({
      pendingSend: { requestId: 'req-1', text: 'hello', quoteIds: ['q1'] },
    })
    await expect(store.save('parent-a', state([chat('a2', { pendingSend: { requestId: '' } as never })])))
      .rejects.toBeInstanceOf(SideChatStoreError)
  })
})

describe('archived list', () => {
  it('returns archived chats across parents without drafts or open chats', async () => {
    const root = await workspace()
    const store = new SideChatStore(join(root, 'state.json'))
    await store.save('parent-a', state([
      chat('a1', { status: 'archived', archivedReason: 'manual', title: '归档 A' }),
      chat('a2', { status: 'open' }),
    ], 'a2'))
    await store.save('parent-b', state([
      chat('b1', { status: 'archived', archivedReason: 'parent-removed', title: '归档 B' }),
    ], 'b1'))
    const archived = await store.listArchived()
    expect(archived.map(item => item.chatId).sort()).toEqual(['a1', 'b1'])
    expect(archived.find(item => item.chatId === 'b1')).toMatchObject({
      parentSessionId: 'parent-b',
      archivedReason: 'parent-removed',
    })
  })

  it('lists archiving chats with their waiting status', async () => {
    const root = await workspace()
    const store = new SideChatStore(join(root, 'state.json'))
    await store.save('parent-a', state([chat('a1', { status: 'archiving' })], undefined))
    expect(await store.listArchived()).toEqual([
      expect.objectContaining({ chatId: 'a1', status: 'archiving' }),
    ])
  })
})
