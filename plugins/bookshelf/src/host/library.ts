import { createHash } from 'node:crypto'
import { open, mkdir, readFile, rename, rm, stat, access, readdir, unlink } from 'node:fs/promises'
import { constants } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, extname, isAbsolute, join, normalize, resolve, sep } from 'node:path'
import { randomUUID } from 'node:crypto'
import type {
  AddResult,
  Availability,
  BookFormat,
  BookProgress,
  BookRecord,
  BookView,
  BrowseEntry,
  BrowseResult,
  ReadingPosition,
} from '../shared/types.ts'

const LIBRARY_VERSION = 1
const MAX_BROWSE_ENTRIES = 4000

/** A domain failure that can cross the HTTP bridge as a stable code and message. */
export class BookshelfError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly cause?: unknown,
  ) {
    super(message)
    this.name = 'BookshelfError'
  }
}

interface LibraryFile {
  version: 1
  books: BookRecord[]
}

/** Resolve the DeepSeek Harness home without importing harness packages. */
export function resolveDshHome(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.DSH_HOME?.trim()
  return configured === undefined || configured === '' ? join(homedir(), '.dsh') : configured
}

/** Default library file path under the harness data directory. */
export function defaultLibraryPath(): string {
  return join(resolveDshHome(), 'bookshelf', 'library.json')
}

/** Expand only a leading `~` or `~/`, matching the harness home-path convention. */
export function expandHome(input: string): string {
  if (input === '~') return homedir()
  if (input.startsWith(`~${sep}`) || input.startsWith('~/')) return join(homedir(), input.slice(2))
  return input
}

/** Normalize a user-supplied path to an absolute path without following symlinks. */
export function normalizeUserPath(input: string): string {
  const expanded = expandHome(input.trim())
  return normalize(isAbsolute(expanded) ? expanded : resolve(expanded))
}

/** Map a file extension to a supported format. */
export function formatOf(filePath: string): BookFormat | null {
  switch (extname(filePath).toLowerCase()) {
    case '.pdf': return 'pdf'
    case '.epub': return 'epub'
    case '.txt': return 'txt'
    case '.md':
    case '.markdown': return 'markdown'
    default: return null
  }
}

/** Stable id derived only from the normalized path. */
export function idForPath(filePath: string): string {
  return createHash('sha256').update(filePath).digest('hex').slice(0, 16)
}

/** Display title: the file name without its extension. */
export function titleForPath(filePath: string): string {
  const ext = extname(filePath)
  const title = basename(filePath, ext)
  return title === '' ? basename(filePath) : title
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object'
}

function isReadingPosition(value: unknown): value is ReadingPosition {
  if (!isRecord(value)) return false
  if (value.kind === 'pdf') {
    return typeof value.page === 'number' && Number.isInteger(value.page) && value.page >= 1
      && typeof value.total === 'number' && Number.isInteger(value.total) && value.total >= 1
      && typeof value.offset === 'number' && Number.isFinite(value.offset) && value.offset >= 0 && value.offset <= 1
  }
  if (value.kind === 'epub') return typeof value.cfi === 'string' && value.cfi !== ''
  if (value.kind === 'scroll') {
    return typeof value.ratio === 'number' && Number.isFinite(value.ratio) && value.ratio >= 0 && value.ratio <= 1
  }
  return false
}

function parseBook(value: unknown): BookRecord | null {
  if (!isRecord(value)) return null
  const { id, path, title, format, size, addedAt, lastOpenedAt, progress, readerWidth, markedRead } = value
  if (typeof id !== 'string' || id === '') return null
  if (typeof path !== 'string' || path === '' || !isAbsolute(path)) return null
  if (typeof title !== 'string' || title === '') return null
  if (format !== 'pdf' && format !== 'epub' && format !== 'txt' && format !== 'markdown') return null
  if (typeof size !== 'number' || !Number.isFinite(size) || size < 0) return null
  if (typeof addedAt !== 'number' || !Number.isFinite(addedAt)) return null
  if (lastOpenedAt !== null && (typeof lastOpenedAt !== 'number' || !Number.isFinite(lastOpenedAt))) return null
  if (typeof markedRead !== 'boolean') return null
  if (readerWidth !== undefined && readerWidth !== null && (typeof readerWidth !== 'number' || !Number.isFinite(readerWidth) || readerWidth < 0.4 || readerWidth > 3)) return null
  if (!isRecord(progress)) return null
  const position = progress.position
  if (position !== null && !isReadingPosition(position)) return null
  if (progress.percent !== null && (typeof progress.percent !== 'number' || !Number.isFinite(progress.percent) || progress.percent < 0 || progress.percent > 100)) return null
  if (progress.updatedAt !== null && (typeof progress.updatedAt !== 'number' || !Number.isFinite(progress.updatedAt))) return null
  return {
    id,
    path,
    title,
    format,
    size,
    addedAt,
    lastOpenedAt,
    progress: {
      position: position as ReadingPosition | null,
      percent: progress.percent,
      updatedAt: progress.updatedAt,
    },
    readerWidth: readerWidth === undefined || readerWidth === null ? null : readerWidth,
    markedRead,
  }
}

function emptyProgress(): BookProgress {
  return { position: null, percent: null, updatedAt: null }
}

/** Availability of one recorded original file. Errors other than confirmed absence stay inaccessible. */
export async function availabilityOf(filePath: string): Promise<{ availability: Availability; detail: string | null }> {
  try {
    const info = await stat(filePath)
    if (!info.isFile()) return { availability: 'missing', detail: 'not-a-file' }
    await access(filePath, constants.R_OK)
    return { availability: 'ok', detail: null }
  } catch (error: unknown) {
    const code = isRecord(error) && typeof error.code === 'string' ? error.code : ''
    if (code === 'ENOENT' || code === 'ENOTDIR' || code === 'EISDIR' || code === 'ELOOP') {
      return { availability: 'missing', detail: code.toLowerCase() }
    }
    return { availability: 'inaccessible', detail: code === '' ? 'unavailable' : code.toLowerCase() }
  }
}

/** Serialized, atomically persisted JSON library. */
export class Library {
  private books: BookRecord[] = []
  private loaded = false
  private chain: Promise<unknown> = Promise.resolve()
  private progressOwners = new Map<string, { clientId: string; activityAt: number }>()

  constructor(readonly filePath: string = defaultLibraryPath()) {}

  private async ensureLoaded(): Promise<void> {
    if (this.loaded) return
    let raw: string
    try {
      raw = await readFile(this.filePath, 'utf8')
    } catch (error: unknown) {
      if (isRecord(error) && error.code === 'ENOENT') {
        // A replacement may have moved the last valid file aside before a
        // crash or a failed rename. Recover it instead of treating the shelf
        // as empty. A truly absent backup still means a new empty library.
        const recovery = await this.restoreBackup()
        if (recovery === 'none') {
          this.books = []
          this.loaded = true
          return
        }
        if (recovery === 'failed') {
          throw new BookshelfError('bookshelf/store-unreadable', '书架记录缺失，且无法恢复最近一次有效备份。')
        }
        raw = await readFile(this.filePath, 'utf8')
      } else {
        throw new BookshelfError('bookshelf/store-unreadable', `无法读取书架记录：${messageOf(error)}`, error)
      }
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch (error: unknown) {
      throw new BookshelfError('bookshelf/store-corrupt', '书架记录不是有效的 JSON，未作任何覆盖。', error)
    }
    if (!isRecord(parsed) || parsed.version !== LIBRARY_VERSION || !Array.isArray(parsed.books)) {
      throw new BookshelfError('bookshelf/store-invalid', '书架记录格式不受支持，未作任何覆盖。')
    }
    const books: BookRecord[] = []
    for (const entry of parsed.books) {
      const book = parseBook(entry)
      if (book === null) throw new BookshelfError('bookshelf/store-invalid', '书架记录包含无效条目，未作任何覆盖。')
      books.push(book)
    }
    this.books = books
    this.loaded = true
  }

  /** Restore a record file that was moved aside during a replacement. */
  private async restoreBackup(): Promise<'none' | 'restored' | 'failed'> {
    const directory = dirname(this.filePath)
    const base = basename(this.filePath)
    let names: string[]
    try {
      names = await readdir(directory)
    } catch (error: unknown) {
      if (isRecord(error) && error.code === 'ENOENT') return 'none'
      return 'failed'
    }
    const candidates: string[] = []
    if (names.includes(`${base}.bak`)) candidates.push(`${base}.bak`)
    candidates.push(...names.filter((name) => name.startsWith(`${base}.bak-`)).sort())
    if (candidates.length === 0) return 'none'
    for (const name of candidates) {
      try {
        await rename(join(directory, name), this.filePath)
        return 'restored'
      } catch {
        // Try the next valid backup.
      }
    }
    return 'failed'
  }

  /** Ensure a write never starts with the only valid copy sitting in a backup. */
  private async ensureRecordFile(): Promise<void> {
    try {
      await stat(this.filePath)
      return
    } catch (error: unknown) {
      if (!(isRecord(error) && error.code === 'ENOENT')) throw error
    }
    if ((await this.restoreBackup()) === 'failed') {
      throw new Error('书架记录缺失，且无法恢复最近一次有效备份。')
    }
  }

  private async write(books: readonly BookRecord[]): Promise<void> {
    const directory = dirname(this.filePath)
    await mkdir(directory, { recursive: true })
    const temporary = `${this.filePath}.tmp-${process.pid}-${randomUUID()}`
    const payload = `${JSON.stringify({ version: LIBRARY_VERSION, books }, null, 2)}\n`
    try {
      await this.ensureRecordFile()
      const handle = await open(temporary, 'w', 0o600)
      try {
        await handle.writeFile(payload, 'utf8')
        await handle.sync()
      } finally {
        await handle.close()
      }
      try {
        await rename(temporary, this.filePath)
      } catch (error: unknown) {
        // Windows cannot replace an existing file with rename(). Move the old
        // file aside instead of deleting it, so a failed second rename can
        // restore the last valid library (or leave its backup for recovery).
        if (isRecord(error) && (error.code === 'EEXIST' || error.code === 'EPERM')) {
          // Never remove an existing backup here: after a failed restore it
          // may be the only valid copy. Each attempt gets its own backup.
          const backup = `${this.filePath}.bak-${process.pid}-${randomUUID()}`
          let moved = false
          try {
            await rename(this.filePath, backup)
            moved = true
          } catch (moveError: unknown) {
            if (!(isRecord(moveError) && moveError.code === 'ENOENT')) throw moveError
          }
          try {
            await rename(temporary, this.filePath)
          } catch (replaceError: unknown) {
            if (moved) {
              // If this restore also fails, the unique backup remains on disk
              // and is picked up by ensureRecordFile/ensureLoaded next time.
              await rename(backup, this.filePath).catch(() => {})
            }
            throw replaceError
          }
          if (moved) await unlink(backup).catch(() => {})
        } else {
          throw error
        }
      }
    } catch (error: unknown) {
      await unlink(temporary).catch(() => {})
      throw new BookshelfError('bookshelf/store-write-failed', `无法保存书架记录：${messageOf(error)}`, error)
    }
  }

  /** Apply one mutation on a copy, persist it, then publish it to readers. */
  private mutate<T>(operation: (draft: BookRecord[]) => T): Promise<T> {
    const run = this.chain.then(async () => {
      await this.ensureLoaded()
      const draft = structuredClone(this.books)
      const value = operation(draft)
      await this.write(draft)
      this.books = draft
      return value
    })
    this.chain = run.then(() => undefined, () => undefined)
    return run
  }

  /** Read the current records. */
  async snapshot(): Promise<BookRecord[]> {
    await this.ensureLoaded()
    return this.books.slice()
  }

  /** Read records with a fresh availability check. */
  async listWithAvailability(): Promise<BookView[]> {
    const books = await this.snapshot()
    const checked = await Promise.all(books.map(async (book) => {
      const result = await availabilityOf(book.path)
      return { ...book, availability: result.availability, availabilityDetail: result.detail }
    }))
    checked.sort((left, right) => {
      const recent = (right.lastOpenedAt ?? 0) - (left.lastOpenedAt ?? 0)
      if (recent !== 0) return recent
      const added = right.addedAt - left.addedAt
      if (added !== 0) return added
      return left.title.localeCompare(right.title)
    })
    return checked
  }

  /** Add concrete files and return added, duplicate, and invalid paths. */
  async addPaths(paths: readonly string[]): Promise<AddResult> {
    const normalized = paths.map(normalizeUserPath).filter((path) => path !== '')
    const seen = new Set<string>()
    const duplicatePaths = new Set<string>()
    const unique: string[] = []
    for (const path of normalized) {
      if (seen.has(path)) duplicatePaths.add(path)
      else { seen.add(path); unique.push(path) }
    }
    const inspected: { path: string; format: BookFormat; size: number; title: string }[] = []
    const invalid: { path: string; message: string }[] = []
    for (const path of unique) {
      const format = formatOf(path)
      if (format === null) {
        invalid.push({ path, message: '不支持的格式' })
        continue
      }
      try {
        const info = await stat(path)
        if (!info.isFile()) {
          invalid.push({ path, message: '不是文件' })
          continue
        }
        inspected.push({ path, format, size: info.size, title: titleForPath(path) })
      } catch (error: unknown) {
        invalid.push({ path, message: messageOf(error) })
      }
    }
    if (inspected.length === 0) return { added: [], skipped: [], invalid }
    const validPaths = new Set(inspected.map((item) => item.path))
    const added = await this.mutate((draft) => {
      const result: BookRecord[] = []
      const skipped: string[] = []
      const now = Date.now()
      for (const item of inspected) {
        const existing = draft.find((book) => book.path === item.path)
        if (existing !== undefined) {
          skipped.push(item.path)
          continue
        }
        const record: BookRecord = {
          id: idForPath(item.path),
          path: item.path,
          title: item.title,
          format: item.format,
          size: item.size,
          addedAt: now,
          lastOpenedAt: null,
          progress: emptyProgress(),
          readerWidth: null,
          markedRead: false,
        }
        draft.push(record)
        result.push(record)
      }
      return { records: result, skipped }
    })
    const views: BookView[] = []
    for (const record of added.records) {
      const availability = await availabilityOf(record.path)
      views.push({ ...record, availability: availability.availability, availabilityDetail: availability.detail })
    }
    const skipped = [...new Set([...added.skipped, ...[...duplicatePaths].filter((path) => validPaths.has(path))])]
    return { added: views, skipped, invalid }
  }

  /** Add only the supported files directly inside a directory; never recurses. */
  async addDirectory(directory: string): Promise<AddResult & { directory: string }> {
    const path = normalizeUserPath(directory)
    let entries
    try {
      const info = await stat(path)
      if (!info.isDirectory()) throw new BookshelfError('bookshelf/not-a-directory', '所选路径不是目录。')
      entries = await readdir(path, { withFileTypes: true })
    } catch (error: unknown) {
      if (error instanceof BookshelfError) throw error
      throw new BookshelfError('bookshelf/directory-unreadable', `无法读取目录：${messageOf(error)}`, error)
    }
    const files = entries
      .filter((entry) => entry.isFile() && formatOf(entry.name) !== null)
      .map((entry) => join(path, entry.name))
    const result = await this.addPaths(files)
    return { ...result, directory: path }
  }

  /** Record that a book was opened without changing reading progress. */
  async markOpened(id: string): Promise<BookRecord> {
    return this.mutate((draft) => {
      const book = draft.find((entry) => entry.id === id)
      if (book === undefined) throw new BookshelfError('bookshelf/not-found', '书目不存在。')
      book.lastOpenedAt = Date.now()
      return structuredClone(book)
    })
  }

  /** Save a reading position and display percentage; markedRead is untouched. */
  async saveProgress(id: string, position: ReadingPosition, percent: number, clientId?: string, clientStartedAt?: number): Promise<BookRecord> {
    if (!isReadingPosition(position)) throw new BookshelfError('bookshelf/invalid-position', '阅读位置无效。')
    if (!Number.isFinite(percent) || percent < 0 || percent > 100) {
      throw new BookshelfError('bookshelf/invalid-percent', '阅读进度无效。')
    }
    let claim: { clientId: string; activityAt: number } | null = null
    const result = await this.mutate((draft) => {
      const book = draft.find((entry) => entry.id === id)
      if (book === undefined) throw new BookshelfError('bookshelf/not-found', '书目不存在。')
      if (clientId !== undefined && clientStartedAt !== undefined) {
        const owner = this.progressOwners.get(id)
        if (owner !== undefined && (owner.activityAt > clientStartedAt || (owner.activityAt === clientStartedAt && owner.clientId > clientId))) {
          throw new BookshelfError('bookshelf/stale-progress', '另一个阅读窗口的位置更新较新，已忽略旧位置。')
        }
        claim = { clientId, activityAt: clientStartedAt }
      }
      book.progress = { position: structuredClone(position), percent, updatedAt: Date.now() }
      book.lastOpenedAt = Date.now()
      return structuredClone(book)
    })
    if (claim !== null) this.progressOwners.set(id, claim)
    return result
  }

  /** Save the per-book PDF reading width; progress and the finished mark are untouched. */
  async saveReaderWidth(id: string, width: number): Promise<BookRecord> {
    if (!Number.isFinite(width) || width < 0.4 || width > 3) {
      throw new BookshelfError('bookshelf/invalid-width', '阅读宽度无效。')
    }
    return this.mutate((draft) => {
      const book = draft.find((entry) => entry.id === id)
      if (book === undefined) throw new BookshelfError('bookshelf/not-found', '书目不存在。')
      book.readerWidth = width
      return structuredClone(book)
    })
  }

  /** Set or clear the manual read mark; progress is untouched. */
  async setRead(id: string, markedRead: boolean): Promise<BookRecord> {
    return this.mutate((draft) => {
      const book = draft.find((entry) => entry.id === id)
      if (book === undefined) throw new BookshelfError('bookshelf/not-found', '书目不存在。')
      book.markedRead = markedRead
      return structuredClone(book)
    })
  }

  /** Remove one record. The original file is never touched. */
  async remove(id: string): Promise<{ removed: boolean }> {
    return this.mutate((draft) => {
      const index = draft.findIndex((entry) => entry.id === id)
      if (index === -1) return { removed: false }
      draft.splice(index, 1)
      return { removed: true }
    })
  }

  /** Look up one record without changing it. */
  async find(id: string): Promise<BookRecord | undefined> {
    const books = await this.snapshot()
    return books.find((entry) => entry.id === id)
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** List directories and supported files directly inside one directory. */
export async function browseDirectory(input: string | undefined): Promise<BrowseResult> {
  const path = normalizeUserPath(input === undefined || input.trim() === '' ? homedir() : input)
  let info
  try {
    info = await stat(path)
  } catch (error: unknown) {
    throw new BookshelfError('bookshelf/directory-unreadable', `无法访问目录：${messageOf(error)}`, error)
  }
  if (!info.isDirectory()) throw new BookshelfError('bookshelf/not-a-directory', '所选路径不是目录。')
  let dirents
  try {
    dirents = await readdir(path, { withFileTypes: true })
  } catch (error: unknown) {
    throw new BookshelfError('bookshelf/directory-unreadable', `无法读取目录：${messageOf(error)}`, error)
  }
  const entries: BrowseEntry[] = []
  let truncated = false
  for (const dirent of dirents.sort((left, right) => left.name.localeCompare(right.name))) {
    if (dirent.name.startsWith('.')) continue
    const child = join(path, dirent.name)
    if (dirent.isDirectory()) {
      entries.push({ name: dirent.name, path: child, kind: 'directory', format: null, size: null })
    } else if (dirent.isFile()) {
      const format = formatOf(dirent.name)
      if (format === null) continue
      let size: number | null = null
      try { size = (await stat(child)).size } catch {}
      entries.push({ name: dirent.name, path: child, kind: 'file', format, size })
    }
    if (entries.length >= MAX_BROWSE_ENTRIES) {
      truncated = true
      break
    }
  }
  entries.sort((left, right) => (left.kind === right.kind ? left.name.localeCompare(right.name) : left.kind === 'directory' ? -1 : 1))
  const parent = dirname(path)
  return { path, parent: parent === path ? null : parent, entries, truncated }
}

/** Read file metadata for serving the original file. */
export async function statBookFile(path: string): Promise<{ size: number; contentType: string }> {
  const info = await stat(path).catch((error: unknown) => {
    throw new BookshelfError('bookshelf/file-unavailable', `无法读取原文件：${messageOf(error)}`, error)
  })
  if (!info.isFile()) throw new BookshelfError('bookshelf/file-unavailable', '原文件不是普通文件。')
  const format = formatOf(path)
  const contentType = format === 'pdf' ? 'application/pdf'
    : format === 'epub' ? 'application/epub+zip'
      : 'text/plain; charset=utf-8'
  return { size: info.size, contentType }
}
