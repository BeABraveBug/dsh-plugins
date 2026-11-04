import { randomUUID, createHash } from 'node:crypto'
import { mkdir, open, readFile, readdir, rename, rm, unlink } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { BookshelfError, resolveDshHome } from './library.ts'
import type {
  BookFormat,
  BookNote,
  NoteBook,
  NoteBookSummary,
  NoteList,
  ReadingPosition,
  SaveNoteRequest,
} from '../shared/types.ts'

const NOTES_VERSION = 1
const MAX_NOTE_BYTES = 2 * 1024 * 1024
const MAX_TITLE_LENGTH = 200
const FORMATS = new Set<BookFormat>(['pdf', 'epub', 'txt', 'markdown'])

interface NotesFile {
  version: number
  books: Record<string, NoteBook>
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object'
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function isPosition(value: unknown): value is ReadingPosition {
  if (!isRecord(value)) return false
  if (value.kind === 'pdf') {
    return Number.isInteger(value.page) && (value.page as number) >= 1
      && Number.isInteger(value.total) && (value.total as number) >= 1
      && typeof value.offset === 'number' && Number.isFinite(value.offset) && value.offset >= 0 && value.offset <= 1
  }
  if (value.kind === 'epub') return typeof value.cfi === 'string' && value.cfi !== ''
  if (value.kind === 'scroll') return typeof value.ratio === 'number' && Number.isFinite(value.ratio) && value.ratio >= 0 && value.ratio <= 1
  return false
}

function parseNote(value: unknown): BookNote | null {
  if (!isRecord(value)) return null
  if (typeof value.id !== 'string' || value.id === '') return null
  if (typeof value.title !== 'string' || value.title.length > MAX_TITLE_LENGTH) return null
  if (typeof value.markdown !== 'string' || Buffer.byteLength(value.markdown, 'utf8') > MAX_NOTE_BYTES) return null
  if (typeof value.createdAt !== 'number' || !Number.isFinite(value.createdAt)) return null
  if (typeof value.updatedAt !== 'number' || !Number.isFinite(value.updatedAt)) return null
  if (value.anchor !== null && !isPosition(value.anchor)) return null
  return {
    id: value.id,
    title: value.title,
    markdown: value.markdown,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
    anchor: value.anchor as ReadingPosition | null,
  }
}

function parseBook(value: unknown): NoteBook | null {
  if (!isRecord(value)) return null
  if (typeof value.bookId !== 'string' || value.bookId === '') return null
  if (typeof value.bookPath !== 'string' || value.bookPath === '') return null
  if (typeof value.bookTitle !== 'string') return null
  if (typeof value.bookFormat !== 'string' || !FORMATS.has(value.bookFormat as BookFormat)) return null
  if (!Array.isArray(value.notes)) return null
  if (value.lastEditedNoteId !== null && typeof value.lastEditedNoteId !== 'string') return null
  if (typeof value.updatedAt !== 'number' || !Number.isFinite(value.updatedAt)) return null
  const notes: BookNote[] = []
  for (const entry of value.notes) {
    const note = parseNote(entry)
    if (note === null) return null
    notes.push(note)
  }
  return {
    bookId: value.bookId,
    bookPath: value.bookPath,
    bookTitle: value.bookTitle,
    bookFormat: value.bookFormat as BookFormat,
    notes,
    lastEditedNoteId: value.lastEditedNoteId as string | null,
    updatedAt: value.updatedAt,
  }
}

export function defaultNotesPath(): string {
  return join(resolveDshHome(), 'bookshelf', 'notes.json')
}

/** Persistent notes store, deliberately separate from the bookshelf records. */
export class NoteStore {
  private data: NotesFile = { version: NOTES_VERSION, books: {} }
  private loaded = false
  private chain: Promise<unknown> = Promise.resolve()

  constructor(readonly filePath: string = defaultNotesPath()) {}

  private async ensureLoaded(): Promise<void> {
    if (this.loaded) return
    let raw: string
    try {
      raw = await readFile(this.filePath, 'utf8')
    } catch (error: unknown) {
      if (isRecord(error) && error.code === 'ENOENT') {
        const restored = await this.restoreBackup()
        if (restored === 'none') {
          this.loaded = true
          return
        }
        if (restored === 'failed') {
          throw new BookshelfError('bookshelf/notes-unreadable', '笔记记录缺失，且无法恢复最近一次有效备份。')
        }
        raw = await readFile(this.filePath, 'utf8')
      } else {
        throw new BookshelfError('bookshelf/notes-unreadable', `无法读取笔记记录：${messageOf(error)}`, error)
      }
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch (error: unknown) {
      throw new BookshelfError('bookshelf/notes-corrupt', '笔记记录不是有效的 JSON，未作任何覆盖。', error)
    }
    if (!isRecord(parsed) || parsed.version !== NOTES_VERSION || !isRecord(parsed.books)) {
      throw new BookshelfError('bookshelf/notes-invalid', '笔记记录格式不受支持，未作任何覆盖。')
    }
    const books: Record<string, NoteBook> = {}
    for (const [key, value] of Object.entries(parsed.books)) {
      const book = parseBook(value)
      if (book === null || book.bookId !== key) {
        throw new BookshelfError('bookshelf/notes-invalid', '笔记记录包含无效条目，未作任何覆盖。')
      }
      books[key] = book
    }
    this.data = { version: NOTES_VERSION, books }
    this.loaded = true
  }

  private async restoreBackup(): Promise<'none' | 'restored' | 'failed'> {
    const directory = dirname(this.filePath)
    const base = 'notes.json'
    let names: string[]
    try { names = await readdir(directory) } catch (error: unknown) {
      return isRecord(error) && error.code === 'ENOENT' ? 'none' : 'failed'
    }
    const candidates = names.filter((name) => name.startsWith(`${base}.bak-`)).sort().reverse()
    if (candidates.length === 0) return 'none'
    for (const name of candidates) {
      try {
        await rename(join(directory, name), this.filePath)
        return 'restored'
      } catch {
        // Try the next newest backup.
      }
    }
    return 'failed'
  }

  private async write(data: NotesFile): Promise<void> {
    const directory = dirname(this.filePath)
    await mkdir(directory, { recursive: true })
    const temporary = `${this.filePath}.tmp-${process.pid}-${randomUUID()}`
    try {
      const handle = await open(temporary, 'w', 0o600)
      try {
        await handle.writeFile(`${JSON.stringify(data, null, 2)}\n`, 'utf8')
        await handle.sync()
      } finally {
        await handle.close()
      }
      try {
        await rename(temporary, this.filePath)
      } catch (error: unknown) {
        if (!isRecord(error) || (error.code !== 'EEXIST' && error.code !== 'EPERM')) throw error
        const backup = `${this.filePath}.bak-${process.pid}-${randomUUID()}`
        await rename(this.filePath, backup)
        try {
          await rename(temporary, this.filePath)
        } catch (replaceError: unknown) {
          await rename(backup, this.filePath).catch(() => {})
          throw replaceError
        }
      }
    } catch (error: unknown) {
      await unlink(temporary).catch(() => {})
      throw new BookshelfError('bookshelf/notes-write-failed', `无法保存笔记记录：${messageOf(error)}`, error)
    }
  }

  private mutate<T>(operation: (draft: NotesFile) => T): Promise<T> {
    const run = this.chain.then(async () => {
      await this.ensureLoaded()
      const draft = structuredClone(this.data)
      const value = operation(draft)
      await this.write(draft)
      this.data = draft
      return value
    })
    this.chain = run.then(() => undefined, () => undefined)
    return run
  }

  async list(bookId: string): Promise<NoteList> {
    await this.ensureLoaded()
    const book = this.data.books[bookId]
    return book === undefined
      ? { notes: [], lastEditedNoteId: null }
      : { notes: structuredClone(book.notes), lastEditedNoteId: book.lastEditedNoteId }
  }

  async save(request: SaveNoteRequest): Promise<BookNote> {
    if (typeof request.bookId !== 'string' || request.bookId === '') throw new BookshelfError('bookshelf/bad-request', '书目 id 无效。')
    if (typeof request.bookPath !== 'string' || request.bookPath === '') throw new BookshelfError('bookshelf/bad-request', '书目路径无效。')
    if (typeof request.bookTitle !== 'string') throw new BookshelfError('bookshelf/bad-request', '书名无效。')
    if (!FORMATS.has(request.bookFormat)) throw new BookshelfError('bookshelf/bad-request', '书目格式无效。')
    if (typeof request.title !== 'string' || request.title.length > MAX_TITLE_LENGTH) throw new BookshelfError('bookshelf/bad-request', '笔记标题无效。')
    if (typeof request.markdown !== 'string' || Buffer.byteLength(request.markdown, 'utf8') > MAX_NOTE_BYTES) throw new BookshelfError('bookshelf/bad-request', '笔记内容过大。')
    if (request.anchor !== null && !isPosition(request.anchor)) throw new BookshelfError('bookshelf/bad-request', '笔记位置无效。')
    return this.mutate((draft) => {
      const now = Date.now()
      const existing = draft.books[request.bookId]
      const book: NoteBook = existing ?? {
        bookId: request.bookId,
        bookPath: request.bookPath,
        bookTitle: request.bookTitle,
        bookFormat: request.bookFormat,
        notes: [],
        lastEditedNoteId: null,
        updatedAt: now,
      }
      if (request.noteId === undefined) {
        const note: BookNote = {
          id: randomUUID(),
          title: request.title.trim() === '' ? '未命名笔记' : request.title.trim(),
          markdown: request.markdown,
          createdAt: now,
          updatedAt: now,
          anchor: request.anchor,
        }
        book.notes = [...book.notes, note]
        book.lastEditedNoteId = note.id
        book.updatedAt = now
        draft.books[request.bookId] = book
        return structuredClone(note)
      }
      const index = book.notes.findIndex((note) => note.id === request.noteId)
      if (index === -1) throw new BookshelfError('bookshelf/note-not-found', '笔记不存在。')
      const previous = book.notes[index]!
      const note: BookNote = {
        ...previous,
        title: request.title.trim() === '' ? '未命名笔记' : request.title.trim(),
        markdown: request.markdown,
        updatedAt: now,
      }
      const notes = book.notes.slice()
      notes[index] = note
      book.notes = notes
      book.lastEditedNoteId = note.id
      book.updatedAt = now
      draft.books[request.bookId] = book
      return structuredClone(note)
    })
  }

  async remove(bookId: string, noteId: string): Promise<{ deleted: boolean }> {
    return this.mutate((draft) => {
      const book = draft.books[bookId]
      if (book === undefined) return { deleted: false }
      const index = book.notes.findIndex((note) => note.id === noteId)
      if (index === -1) return { deleted: false }
      book.notes = book.notes.filter((note) => note.id !== noteId)
      if (book.lastEditedNoteId === noteId) book.lastEditedNoteId = book.notes[0]?.id ?? null
      book.updatedAt = Date.now()
      if (book.notes.length === 0) delete draft.books[bookId]
      return { deleted: true }
    })
  }

  async listBooks(): Promise<NoteBookSummary[]> {
    await this.ensureLoaded()
    return Object.values(this.data.books)
      .slice()
      .sort((left, right) => right.updatedAt - left.updatedAt)
      .map((book) => ({
        bookId: book.bookId,
        bookPath: book.bookPath,
        bookTitle: book.bookTitle,
        bookFormat: book.bookFormat,
        noteCount: book.notes.length,
        updatedAt: book.updatedAt,
      }))
  }

  async deleteBook(bookId: string): Promise<{ deleted: boolean }> {
    return this.mutate((draft) => {
      if (draft.books[bookId] === undefined) return { deleted: false }
      delete draft.books[bookId]
      return { deleted: true }
    })
  }
}

/** Kept for callers that need the same stable key as the library. */
export function bookKeyForPath(path: string): string {
  return createHash('sha256').update(path).digest('hex').slice(0, 16)
}
