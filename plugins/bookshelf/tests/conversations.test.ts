import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ConversationStore } from '../src/host/conversations.ts'

const roots: string[] = []
async function workspace(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'bookshelf-conversations-'))
  roots.push(root)
  return root
}
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))) })

describe('ConversationStore', () => {
  it('persists ordered messages per book and clears only that book', async () => {
    const root = await workspace()
    const path = join(root, 'conversations.json')
    const store = new ConversationStore(path)
    await store.append('a', '/tmp/a.pdf', 'A', 'pdf', 'user', 'question')
    await store.append('a', '/tmp/a.pdf', 'A', 'pdf', 'assistant', 'answer')
    await store.append('b', '/tmp/b.pdf', 'B', 'pdf', 'user', 'other')
    const reopened = new ConversationStore(path)
    expect((await reopened.list('a')).map((message) => message.content)).toEqual(['question', 'answer'])
    expect(await reopened.clear('a')).toEqual({ cleared: true })
    expect(await reopened.list('a')).toEqual([])
    expect((await reopened.list('b')).map((message) => message.content)).toEqual(['other'])
  })
})
