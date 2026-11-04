import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  rename: vi.fn(),
  actual: null as null | ((from: string, to: string) => Promise<void>),
}))

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  state.actual = actual.rename
  state.rename.mockImplementation(actual.rename)
  return {
    ...actual,
    rename: (from: string, to: string) => state.rename(from, to),
  }
})

const { Library } = await import('../src/host/library.ts')

const roots: string[] = []

async function workspace(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'bookshelf-write-test-'))
  roots.push(root)
  return root
}

function code(error: string): Error & { code: string } {
  return Object.assign(new Error(error), { code: error })
}

beforeEach(() => {
  state.rename.mockImplementation(state.actual!)
})

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('Library replacement fallback', () => {
  it('restores the old library when the second replacement fails', async () => {
    const root = await workspace()
    const path = join(root, 'book.txt')
    await writeFile(path, 'hello', 'utf8')
    const libraryPath = join(root, 'library.json')
    const library = new Library(libraryPath)
    const id = (await library.addPaths([path])).added[0]!.id

    let calls = 0
    state.rename.mockImplementation(async (from, to) => {
      calls += 1
      // 1: replace fails on Windows; 2: old file moves to backup;
      // 3: second replace fails; 4: backup restore must succeed.
      if (calls === 1) throw code('EPERM')
      if (calls === 3) throw code('EIO')
      await state.actual!(from, to)
    })

    await expect(library.setRead(id, true)).rejects.toMatchObject({ code: 'bookshelf/store-write-failed' })
    const parsed = JSON.parse(await readFile(libraryPath, 'utf8'))
    expect(parsed.books).toHaveLength(1)
    expect(parsed.books[0].markedRead).toBe(false)
  })

  it('keeps a backup that the next open can recover after a failed restore', async () => {
    const root = await workspace()
    const path = join(root, 'book.txt')
    await writeFile(path, 'hello', 'utf8')
    const libraryPath = join(root, 'library.json')
    const library = new Library(libraryPath)
    const id = (await library.addPaths([path])).added[0]!.id

    let calls = 0
    state.rename.mockImplementation(async (from, to) => {
      calls += 1
      if (calls === 1) throw code('EPERM')
      if (calls === 3 || calls === 4) throw code('EIO')
      await state.actual!(from, to)
    })

    await expect(library.setRead(id, true)).rejects.toMatchObject({ code: 'bookshelf/store-write-failed' })
    state.rename.mockImplementation(state.actual!)
    const reopened = new Library(libraryPath)
    const books = await reopened.listWithAvailability()
    expect(books.map((entry) => entry.path)).toEqual([path])
    expect(books[0]?.markedRead).toBe(false)
  })
})

  it('does not delete the only backup when the same instance retries after a failed restore', async () => {
    const root = await workspace()
    const path = join(root, 'book.txt')
    await writeFile(path, 'hello', 'utf8')
    const libraryPath = join(root, 'library.json')
    const library = new Library(libraryPath)
    const id = (await library.addPaths([path])).added[0]!.id

    let calls = 0
    state.rename.mockImplementation(async (from, to) => {
      calls += 1
      if (calls === 1) throw code('EPERM')
      if (calls === 3 || calls === 4) throw code('EIO')
      await state.actual!(from, to)
    })
    await expect(library.setRead(id, true)).rejects.toMatchObject({ code: 'bookshelf/store-write-failed' })

    // The target is gone and the unique backup is the only valid copy.
    await expect(readFile(libraryPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    const beforeRetry = await readdir(root)
    expect(beforeRetry.some((name) => name.startsWith('library.json.bak-'))).toBe(true)

    // A new write must fail closed without deleting that backup.
    state.rename.mockImplementation(async () => { throw code('EPERM') })
    await expect(library.setRead(id, true)).rejects.toMatchObject({ code: 'bookshelf/store-write-failed' })
    const afterRetry = await readdir(root)
    expect(afterRetry.filter((name) => name.startsWith('library.json.bak-'))).toHaveLength(1)

    state.rename.mockImplementation(state.actual!)
    const reopened = new Library(libraryPath)
    const books = await reopened.listWithAvailability()
    expect(books.map((entry) => entry.path)).toEqual([path])
    expect(books[0]?.markedRead).toBe(false)
  })
