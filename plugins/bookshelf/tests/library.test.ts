import { mkdtemp, mkdir, writeFile, readFile, rename, rm, chmod, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  Library,
  availabilityOf,
  browseDirectory,
  formatOf,
  idForPath,
  normalizeUserPath,
  titleForPath,
} from '../src/host/library.ts'

const roots: string[] = []

async function workspace(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'bookshelf-test-'))
  roots.push(root)
  return root
}

async function book(root: string, name: string, content = 'hello'): Promise<string> {
  const path = join(root, name)
  await writeFile(path, content, 'utf8')
  return path
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('path helpers', () => {
  it('maps supported extensions case-insensitively', () => {
    expect(formatOf('A.PDF')).toBe('pdf')
    expect(formatOf('B.epub')).toBe('epub')
    expect(formatOf('C.txt')).toBe('txt')
    expect(formatOf('D.md')).toBe('markdown')
    expect(formatOf('E.markdown')).toBe('markdown')
    expect(formatOf('F.mobi')).toBeNull()
  })

  it('derives a stable id and display title from the normalized path', () => {
    const path = normalizeUserPath('/tmp/example/My Book.pdf')
    expect(titleForPath(path)).toBe('My Book')
    expect(idForPath(path)).toBe(idForPath(path))
    expect(idForPath(path)).not.toBe(idForPath('/tmp/example/Other.pdf'))
  })
})

describe('Library', () => {
  it('adds supported files, skips duplicate paths, and keeps different paths separate', async () => {
    const root = await workspace()
    const first = await book(root, 'one.pdf', 'same')
    const second = await book(root, 'two.pdf', 'same')
    const library = new Library(join(root, 'data', 'library.json'))

    const result = await library.addPaths([first, second])
    expect(result.added.map((entry) => entry.path)).toEqual([first, second])

    const again = await library.addPaths([first])
    expect(again.added).toEqual([])
    expect(again.skipped).toEqual([first])

    const duplicateInRequest = await library.addPaths([second, second])
    expect(duplicateInRequest.added).toEqual([])
    expect(duplicateInRequest.skipped).toContain(second)

    const all = await library.listWithAvailability()
    expect(all).toHaveLength(2)
    expect(all.map((entry) => entry.progress.position)).toEqual([null, null])
  })

  it('does not reset progress or the finished mark when the same path is re-added', async () => {
    const root = await workspace()
    const path = await book(root, 'one.txt', 'hello')
    const library = new Library(join(root, 'library.json'))
    const added = await library.addPaths([path])
    const id = added.added[0]!.id
    await library.saveProgress(id, { kind: 'scroll', ratio: 0.5 }, 50)
    await library.setRead(id, true)
    await library.addPaths([path])
    const record = await library.find(id)
    expect(record?.progress.percent).toBe(50)
    expect(record?.markedRead).toBe(true)
  })

  it('adds only direct files from a directory and never recurses', async () => {
    const root = await workspace()
    const direct = await book(root, 'direct.epub')
    await writeFile(join(root, 'skip.mobi'), 'x')
    await mkdir(join(root, 'nested'))
    const nested = await book(join(root, 'nested'), 'nested.pdf')
    const library = new Library(join(root, 'library.json'))
    const result = await library.addDirectory(root)
    expect(result.added.map((entry) => entry.path)).toEqual([direct])
    expect(result.added.map((entry) => entry.path)).not.toContain(nested)
  })

  it('reports a missing file without deleting the record', async () => {
    const root = await workspace()
    const path = await book(root, 'gone.pdf')
    const library = new Library(join(root, 'library.json'))
    const id = (await library.addPaths([path])).added[0]!.id
    await rm(path)
    const books = await library.listWithAvailability()
    expect(books[0]?.availability).toBe('missing')
    expect(await library.find(id)).toBeDefined()
  })

  it('reports an unreadable existing file as inaccessible, not missing', async () => {
    if (process.getuid?.() === 0) return
    const root = await workspace()
    const path = await book(root, 'locked.pdf')
    await chmod(path, 0o000)
    try {
      const result = await availabilityOf(path)
      expect(result.availability).toBe('inaccessible')
    } finally {
      await chmod(path, 0o644)
    }
  })

  it('saves progress and the finished mark independently', async () => {
    const root = await workspace()
    const path = await book(root, 'book.pdf')
    const library = new Library(join(root, 'library.json'))
    const id = (await library.addPaths([path])).added[0]!.id

    await library.saveProgress(id, { kind: 'pdf', page: 7, total: 20, offset: 0.25 }, 31.2)
    await library.setRead(id, true)
    let record = await library.find(id)
    expect(record?.progress.position).toMatchObject({ kind: 'pdf', page: 7, total: 20, offset: 0.25 })
    expect(record?.progress.percent).toBe(31.2)
    expect(record?.markedRead).toBe(true)

    await library.setRead(id, false)
    record = await library.find(id)
    expect(record?.markedRead).toBe(false)
    expect(record?.progress.percent).toBe(31.2)
  })

  it('removes only the record, leaves the original file, and re-adds as new', async () => {
    const root = await workspace()
    const path = await book(root, 'keep.pdf')
    const library = new Library(join(root, 'library.json'))
    const id = (await library.addPaths([path])).added[0]!.id
    await library.saveProgress(id, { kind: 'pdf', page: 2, total: 10, offset: 0 }, 10)
    await library.setRead(id, true)

    expect(await library.remove(id)).toEqual({ removed: true })
    expect((await stat(path)).isFile()).toBe(true)
    expect(await library.find(id)).toBeUndefined()

    const again = await library.addPaths([path])
    expect(again.added[0]?.progress.position).toBeNull()
    expect(again.added[0]?.markedRead).toBe(false)
  })

  it('serializes concurrent mutations without dropping records', async () => {
    const root = await workspace()
    const paths = await Promise.all(Array.from({ length: 12 }, (_, index) => book(root, `book-${index}.txt`, String(index))))
    const library = new Library(join(root, 'library.json'))
    await Promise.all(paths.map((path) => library.addPaths([path])))
    const all = await library.listWithAvailability()
    expect(all).toHaveLength(12)
    expect(new Set(all.map((entry) => entry.id)).size).toBe(12)
  })

  it('refuses to overwrite a corrupt library and keeps the file unchanged', async () => {
    const root = await workspace()
    const libraryPath = join(root, 'library.json')
    await writeFile(libraryPath, '{ not json', 'utf8')
    const library = new Library(libraryPath)
    await expect(library.snapshot()).rejects.toMatchObject({ code: 'bookshelf/store-corrupt' })
    await expect(library.addPaths([await book(root, 'x.txt')])).rejects.toMatchObject({ code: 'bookshelf/store-corrupt' })
    expect(await readFile(libraryPath, 'utf8')).toBe('{ not json')
  })

  it('writes valid JSON with only records, not book bytes', async () => {
    const root = await workspace()
    const path = await book(root, 'small.txt', 'the original content')
    const libraryPath = join(root, 'library.json')
    const library = new Library(libraryPath)
    await library.addPaths([path])
    const raw = await readFile(libraryPath, 'utf8')
    expect(raw).toContain('"version": 1')
    expect(raw).not.toContain('the original content')
    expect(JSON.parse(raw).books[0].path).toBe(path)
  })
})

describe('browseDirectory', () => {
  it('lists directories and supported files without hidden entries', async () => {
    const root = await workspace()
    await mkdir(join(root, 'folder'))
    await book(root, 'a.pdf')
    await writeFile(join(root, 'ignore.doc'), 'x')
    await writeFile(join(root, '.hidden.pdf'), 'x')
    const result = await browseDirectory(root)
    expect(result.entries.map((entry) => entry.name)).toEqual(['folder', 'a.pdf'])
    expect(result.entries[0]?.kind).toBe('directory')
    expect(result.entries[1]?.kind).toBe('file')
    expect(result.parent).not.toBeNull()
  })
})

describe('durability and failure boundaries', () => {
  it('leaves the last valid record in place when a write fails', async () => {
    if (process.getuid?.() === 0) return
    const root = await workspace()
    const first = await book(root, 'first.txt')
    const second = await book(root, 'second.txt')
    const library = new Library(join(root, 'library.json'))
    await library.addPaths([first])
    await chmod(root, 0o500)
    try {
      await expect(library.addPaths([second])).rejects.toMatchObject({ code: 'bookshelf/store-write-failed' })
    } finally {
      await chmod(root, 0o755)
    }
    const books = await library.listWithAvailability()
    expect(books.map((entry) => entry.path)).toEqual([first])
    expect(JSON.parse(await readFile(join(root, 'library.json'), 'utf8')).books).toHaveLength(1)
  })

  it('recovers the last valid library from a backup when the record file is missing', async () => {
    const root = await workspace()
    const path = await book(root, 'recover.txt')
    const libraryPath = join(root, 'library.json')
    const library = new Library(libraryPath)
    await library.addPaths([path])
    await rename(libraryPath, `${libraryPath}.bak`)
    const reopened = new Library(libraryPath)
    const books = await reopened.listWithAvailability()
    expect(books.map((entry) => entry.path)).toEqual([path])
  })

  it('never writes, truncates, or removes the original file', async () => {
    const root = await workspace()
    const path = await book(root, 'original.md', '# Original\n\nDo not touch.\n')
    const before = await readFile(path)
    const library = new Library(join(root, 'library.json'))
    const id = (await library.addPaths([path])).added[0]!.id
    await library.saveProgress(id, { kind: 'scroll', ratio: 0.5 }, 50)
    await library.setRead(id, true)
    await library.remove(id)
    expect(await readFile(path)).toEqual(before)
  })

  it('refuses a library file with an invalid record instead of discarding it', async () => {
    const root = await workspace()
    const libraryPath = join(root, 'library.json')
    await writeFile(libraryPath, JSON.stringify({ version: 1, books: [{ id: 'x' }] }), 'utf8')
    const library = new Library(libraryPath)
    await expect(library.snapshot()).rejects.toMatchObject({ code: 'bookshelf/store-invalid' })
    expect(JSON.parse(await readFile(libraryPath, 'utf8')).books).toEqual([{ id: 'x' }])
  })

  it('sorts recently opened books first', async () => {
    const root = await workspace()
    const first = await book(root, 'first.pdf')
    const second = await book(root, 'second.pdf')
    const library = new Library(join(root, 'library.json'))
    const firstId = (await library.addPaths([first])).added[0]!.id
    await library.addPaths([second])
    await library.markOpened(firstId)
    const books = await library.listWithAvailability()
    expect(books[0]?.id).toBe(firstId)
  })
})

describe('reader width', () => {
  it('saves a per-book PDF width without touching progress or the finished mark', async () => {
    const root = await workspace()
    const first = await book(root, 'first.pdf')
    const second = await book(root, 'second.pdf')
    const library = new Library(join(root, 'library.json'))
    const firstId = (await library.addPaths([first])).added[0]!.id
    const secondId = (await library.addPaths([second])).added[0]!.id
    await library.saveProgress(firstId, { kind: 'pdf', page: 3, total: 10, offset: 0.2 }, 22)
    await library.saveReaderWidth(firstId, 1.7)
    const firstRecord = await library.find(firstId)
    const secondRecord = await library.find(secondId)
    expect(firstRecord?.readerWidth).toBe(1.7)
    expect(firstRecord?.progress.percent).toBe(22)
    expect(firstRecord?.markedRead).toBe(false)
    expect(secondRecord?.readerWidth).toBeNull()
    expect((await library.saveReaderWidth(firstId, 1))?.readerWidth).toBe(1)
  })

  it('rejects widths outside the supported range', async () => {
    const root = await workspace()
    const path = await book(root, 'book.pdf')
    const library = new Library(join(root, 'library.json'))
    const id = (await library.addPaths([path])).added[0]!.id
    await expect(library.saveReaderWidth(id, 0.2)).rejects.toMatchObject({ code: 'bookshelf/invalid-width' })
    await expect(library.saveReaderWidth(id, 4)).rejects.toMatchObject({ code: 'bookshelf/invalid-width' })
  })

  it('reads old records without a width as the default', async () => {
    const root = await workspace()
    const path = await book(root, 'legacy.pdf')
    const library = new Library(join(root, 'library.json'))
    await library.addPaths([path])
    const libraryPath = join(root, 'library.json')
    const stored = JSON.parse(await readFile(libraryPath, 'utf8'))
    delete stored.books[0].readerWidth
    await writeFile(libraryPath, JSON.stringify(stored), 'utf8')
    const reopened = new Library(libraryPath)
    expect((await reopened.snapshot())[0]?.readerWidth).toBeNull()
  })
})
