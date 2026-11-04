import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Library } from '../src/host/library.ts'
import { createFileHandler, createRpcHandler } from '../src/host/routes.ts'

const roots: string[] = []

async function setup(content = 'hello bookshelf') {
  const root = await mkdtemp(join(tmpdir(), 'bookshelf-routes-'))
  roots.push(root)
  const path = join(root, 'book.txt')
  await writeFile(path, content, 'utf8')
  const library = new Library(join(root, 'library.json'))
  return { root, path, library }
}

function post(body: unknown): Request {
  return new Request('http://localhost/api/bookshelf/rpc', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('bookshelf RPC route', () => {
  it('lists, adds, saves progress, marks read, and removes through the JSON envelope', async () => {
    const { library, path } = await setup()
    const rpc = createRpcHandler(library)

    const add = await (await rpc(post({ op: 'addPaths', paths: [path] }))).json()
    expect(add.ok).toBe(true)
    expect(add.value.added).toHaveLength(1)
    const id = add.value.added[0].id

    const open = await (await rpc(post({ op: 'open', id }))).json()
    expect(open.ok).toBe(true)
    expect(open.value.lastOpenedAt).toEqual(expect.any(Number))

    const saved = await (await rpc(post({ op: 'saveProgress', id, position: { kind: 'scroll', ratio: 0.4 }, percent: 40 }))).json()
    expect(saved.ok).toBe(true)
    expect(saved.value.progress.percent).toBe(40)

    const marked = await (await rpc(post({ op: 'setRead', id, markedRead: true }))).json()
    expect(marked.ok).toBe(true)
    expect(marked.value.markedRead).toBe(true)

    const list = await (await rpc(post({ op: 'list' }))).json()
    expect(list.ok).toBe(true)
    expect(list.value.books[0].markedRead).toBe(true)

    const removed = await (await rpc(post({ op: 'remove', id }))).json()
    expect(removed).toEqual({ ok: true, value: { removed: true } })
  })

  it('rejects malformed JSON and unknown operations without touching the library', async () => {
    const { library } = await setup()
    const rpc = createRpcHandler(library)
    const bad = await rpc(new Request('http://localhost/api/bookshelf/rpc', { method: 'POST', body: '{' }))
    expect(bad.status).toBe(400)
    const unknown = await (await rpc(post({ op: 'nope' }))).json()
    expect(unknown).toMatchObject({ ok: false, error: { code: 'bookshelf/unknown-op' } })
  })

  it('returns domain failures as HTTP 200 envelopes', async () => {
    const { library } = await setup()
    const rpc = createRpcHandler(library)
    const missing = await rpc(post({ op: 'open', id: 'missing' }))
    expect(missing.status).toBe(200)
    expect(await missing.json()).toMatchObject({ ok: false, error: { code: 'bookshelf/not-found' } })
  })
})

describe('bookshelf file route', () => {
  it('serves the original bytes and honors byte ranges', async () => {
    const { library, path } = await setup('0123456789')
    const add = await library.addPaths([path])
    const id = add.added[0]!.id

    const whole = await createFileHandler(library, new Request(`http://localhost/api/bookshelf/file?id=${id}`))
    expect(whole.status).toBe(200)
    expect(whole.headers.get('content-type')).toContain('text/plain')
    expect(await whole.text()).toBe('0123456789')

    const range = await createFileHandler(library, new Request(`http://localhost/api/bookshelf/file?id=${id}`, { headers: { range: 'bytes=2-5' } }))
    expect(range.status).toBe(206)
    expect(range.headers.get('content-range')).toBe('bytes 2-5/10')
    expect(await range.text()).toBe('2345')

    const head = await createFileHandler(library, new Request(`http://localhost/api/bookshelf/file?id=${id}`, { method: 'HEAD' }))
    expect(head.status).toBe(200)
    expect(head.headers.get('content-length')).toBe('10')
    expect(await head.text()).toBe('')
  })

  it('rejects unknown ids and invalid ranges', async () => {
    const { library, path } = await setup('0123456789')
    const id = (await library.addPaths([path])).added[0]!.id
    const missing = await createFileHandler(library, new Request('http://localhost/api/bookshelf/file?id=nope'))
    expect(missing.status).toBe(404)
    const invalid = await createFileHandler(library, new Request(`http://localhost/api/bookshelf/file?id=${id}`, { headers: { range: 'bytes=99-100' } }))
    expect(invalid.status).toBe(416)
  })
})

describe('bookshelf RPC validation', () => {
  it('saves a per-book reading width and rejects invalid widths', async () => {
    const { library, path } = await setup()
    const rpc = createRpcHandler(library)
    const id = (await library.addPaths([path])).added[0]!.id
    const saved = await (await rpc(post({ op: 'saveReaderWidth', id, width: 1.4 }))).json()
    expect(saved).toMatchObject({ ok: true, value: { readerWidth: 1.4 } })
    const invalid = await (await rpc(post({ op: 'saveReaderWidth', id, width: 0.1 }))).json()
    expect(invalid).toMatchObject({ ok: false, error: { code: 'bookshelf/invalid-width' } })
  })

  it('rejects invalid progress values and malformed positions', async () => {
    const { library, path } = await setup()
    const rpc = createRpcHandler(library)
    const id = (await library.addPaths([path])).added[0]!.id
    const badPercent = await (await rpc(post({ op: 'saveProgress', id, position: { kind: 'scroll', ratio: 0.5 }, percent: 101 }))).json()
    expect(badPercent).toMatchObject({ ok: false, error: { code: 'bookshelf/invalid-percent' } })
    const badPosition = await (await rpc(post({ op: 'saveProgress', id, position: { kind: 'scroll', ratio: 2 }, percent: 50 }))).json()
    expect(badPosition).toMatchObject({ ok: false, error: { code: 'bookshelf/invalid-position' } })
  })

  it('rejects invalid add and browse payloads', async () => {
    const { library } = await setup()
    const rpc = createRpcHandler(library)
    expect(await (await rpc(post({ op: 'addPaths', paths: [42] }))).json()).toMatchObject({ ok: false, error: { code: 'bookshelf/bad-request' } })
    expect(await (await rpc(post({ op: 'addDirectory' }))).json()).toMatchObject({ ok: false, error: { code: 'bookshelf/bad-request' } })
    expect(await (await rpc(post({ op: 'setRead', id: 'x', markedRead: 'yes' }))).json()).toMatchObject({ ok: false, error: { code: 'bookshelf/bad-request' } })
  })
})
