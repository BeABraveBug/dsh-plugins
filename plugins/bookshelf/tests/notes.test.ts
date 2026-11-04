import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { NoteStore } from '../src/host/notes.ts'
import { createRpcHandler } from '../src/host/routes.ts'
import { Library } from '../src/host/library.ts'
import type { SaveNoteRequest } from '../src/shared/types.ts'

const roots: string[] = []

async function workspace(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'bookshelf-notes-test-'))
  roots.push(root)
  return root
}

function request(bookId: string, markdown: string, title = 'Note'): SaveNoteRequest {
  return {
    bookId,
    bookPath: `/tmp/${bookId}.pdf`,
    bookTitle: 'Test book',
    bookFormat: 'pdf',
    title,
    markdown,
    anchor: { kind: 'pdf', page: 3, total: 10, offset: 0.2 },
  }
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('NoteStore', () => {
  it('creates, updates, lists, and deletes multiple notes for one book', async () => {
    const root = await workspace()
    const store = new NoteStore(join(root, 'notes.json'))
    const first = await store.save(request('book-a', '# First'))
    const second = await store.save(request('book-a', '# Second', 'Second'))
    expect((await store.list('book-a')).notes.map((note) => note.markdown)).toEqual(['# First', '# Second'])
    const updated = await store.save({ ...request('book-a', '# Updated'), noteId: first.id })
    expect(updated.title).toBe('Note')
    expect((await store.list('book-a')).notes.find((note) => note.id === first.id)?.markdown).toBe('# Updated')
    expect(await store.remove('book-a', second.id)).toEqual({ deleted: true })
    expect((await store.list('book-a')).notes).toHaveLength(1)
    expect((await store.listBooks())[0]).toMatchObject({ bookId: 'book-a', noteCount: 1 })
  })

  it('persists notes and keeps them independent from another book', async () => {
    const root = await workspace()
    const path = join(root, 'notes.json')
    const store = new NoteStore(path)
    await store.save(request('book-a', 'A'))
    await store.save(request('book-b', 'B'))
    const reopened = new NoteStore(path)
    expect((await reopened.list('book-a')).notes[0]?.markdown).toBe('A')
    expect((await reopened.list('book-b')).notes[0]?.markdown).toBe('B')
    expect(await reopened.deleteBook('book-a')).toEqual({ deleted: true })
    expect((await reopened.list('book-a')).notes).toEqual([])
    expect((await reopened.list('book-b')).notes).toHaveLength(1)
  })

  it('serves note operations through the authenticated RPC handler', async () => {
    const root = await workspace()
    const store = new NoteStore(join(root, 'notes.json'))
    const library = new Library(join(root, 'library.json'))
    const rpc = createRpcHandler(library, store)
    const post = (body: unknown) => new Request('http://localhost/api/bookshelf/rpc', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    const saved = await (await rpc(post({ op: 'saveNote', note: request('book-a', 'RPC note') }))).json()
    expect(saved).toMatchObject({ ok: true, value: { markdown: 'RPC note' } })
    const listed = await (await rpc(post({ op: 'listNotes', bookId: 'book-a' }))).json()
    expect(listed).toMatchObject({ ok: true, value: { notes: [{ markdown: 'RPC note' }] } })
    const books = await (await rpc(post({ op: 'listNoteBooks' }))).json()
    expect(books).toMatchObject({ ok: true, value: [{ bookId: 'book-a', noteCount: 1 }] })
    await rpc(post({ op: 'deleteNoteBook', bookId: 'book-a' }))
    expect((await store.list('book-a')).notes).toEqual([])
  })
})

describe('per-book AI selection', () => {
  it('persists a selected DSH model without deleting notes', async () => {
    const root = await workspace()
    const store = new NoteStore(join(root, 'notes.json'))
    await store.save(request('book-a', 'note'))
    await store.saveAiSelection('book-a', '/tmp/book-a.pdf', 'Book A', 'pdf', { provider: 'p', model: 'm' })
    const reopened = new NoteStore(join(root, 'notes.json'))
    expect(await reopened.getAiSelection('book-a')).toEqual({ provider: 'p', model: 'm' })
    expect((await reopened.list('book-a')).notes).toHaveLength(1)
    await reopened.saveAiSelection('book-a', '/tmp/book-a.pdf', 'Book A', 'pdf', null)
    expect(await reopened.getAiSelection('book-a')).toBeNull()
  })
})
