import { randomUUID } from 'node:crypto'
import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { BookshelfError, resolveDshHome } from './library.ts'
import type { BookFormat } from '../shared/types.ts'

export interface ChatMessage {
  readonly id: string
  readonly role: 'user' | 'assistant'
  readonly content: string
  readonly createdAt: number
}

interface Conversation {
  bookId: string
  bookPath: string
  bookTitle: string
  bookFormat: BookFormat
  messages: ChatMessage[]
  updatedAt: number
}

interface ConversationFile {
  version: number
  books: Record<string, Conversation>
}

export function defaultConversationsPath(): string {
  return join(resolveDshHome(), 'bookshelf', 'conversations.json')
}

/** Per-book Q&A history, separate from notes and the bookshelf records. */
export class ConversationStore {
  private data: ConversationFile = { version: 1, books: {} }
  private loaded = false
  private chain: Promise<unknown> = Promise.resolve()

  constructor(readonly filePath: string = defaultConversationsPath()) {}

  private async ensureLoaded(): Promise<void> {
    if (this.loaded) return
    let raw: string
    try {
      raw = await readFile(this.filePath, 'utf8')
    } catch (error: unknown) {
      if ((error as { code?: string }).code === 'ENOENT') { this.loaded = true; return }
      throw new BookshelfError('bookshelf/conversations-unreadable', `无法读取问答记录：${String(error)}`, error)
    }
    let parsed: unknown
    try { parsed = JSON.parse(raw) } catch (error: unknown) {
      throw new BookshelfError('bookshelf/conversations-corrupt', '问答记录不是有效的 JSON，未作任何覆盖。', error)
    }
    if (parsed === null || typeof parsed !== 'object' || (parsed as { version?: unknown }).version !== 1 || typeof (parsed as { books?: unknown }).books !== 'object') {
      throw new BookshelfError('bookshelf/conversations-invalid', '问答记录格式不受支持。')
    }
    this.data = parsed as ConversationFile
    this.loaded = true
  }

  private async write(): Promise<void> {
    const directory = dirname(this.filePath)
    await mkdir(directory, { recursive: true })
    const temporary = `${this.filePath}.tmp-${process.pid}-${randomUUID()}`
    try {
      const handle = await open(temporary, 'w', 0o600)
      try {
        await handle.writeFile(`${JSON.stringify(this.data, null, 2)}\n`, 'utf8')
        await handle.sync()
      } finally { await handle.close() }
      await rename(temporary, this.filePath)
    } catch (error: unknown) {
      await unlink(temporary).catch(() => {})
      throw new BookshelfError('bookshelf/conversations-write-failed', `无法保存问答记录：${String(error)}`, error)
    }
  }

  private mutate<T>(operation: () => T): Promise<T> {
    const run = this.chain.then(async () => {
      await this.ensureLoaded()
      const value = operation()
      await this.write()
      return value
    })
    this.chain = run.then(() => undefined, () => undefined)
    return run
  }

  async list(bookId: string): Promise<readonly ChatMessage[]> {
    await this.ensureLoaded()
    return this.data.books[bookId]?.messages.slice() ?? []
  }

  async append(bookId: string, bookPath: string, bookTitle: string, bookFormat: BookFormat, role: 'user' | 'assistant', content: string): Promise<ChatMessage> {
    if (content.trim() === '') throw new BookshelfError('bookshelf/bad-request', '消息不能为空。')
    return this.mutate(() => {
      const now = Date.now()
      const existing = this.data.books[bookId]
      const book = existing ?? { bookId, bookPath, bookTitle, bookFormat, messages: [], updatedAt: now }
      const message: ChatMessage = { id: randomUUID(), role, content, createdAt: now }
      book.messages.push(message)
      book.updatedAt = now
      this.data.books[bookId] = book
      return message
    })
  }

  async clear(bookId: string): Promise<{ cleared: boolean }> {
    return this.mutate(() => {
      if (this.data.books[bookId] === undefined) return { cleared: false }
      delete this.data.books[bookId]
      return { cleared: true }
    })
  }
}
