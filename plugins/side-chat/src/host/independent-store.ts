import { DatabaseSync } from 'node:sqlite'
import { randomUUID } from 'node:crypto'
import type {
  IndependentChat,
  IndependentMessage,
  IndependentParentState,
  IndependentQuote,
  IndependentStatus,
  ModelChoice,
} from '../shared/independent.ts'

interface ChatRow {
  id: string
  parent_id: string
  title: string
  status: string
  archived_reason: string | null
  draft_text: string
  pending_quotes: string
  model_provider: string | null
  model_id: string | null
  model_reasoning: string | null
  background_text: string | null
  background_from_seq: number | null
  background_to_seq: number | null
  background_created_at: number | null
  first_send_done: number
  created_at: number
  updated_at: number
}

interface MessageRow {
  id: number
  chat_id: string
  role: string
  text: string
  quotes: string
  background_text: string | null
  status: string
  error: string | null
  request_id: string | null
  created_at: number
}

const STATUSES: readonly IndependentStatus[] = ['open', 'saved', 'archiving', 'archived']

function quotesOf(raw: string): readonly IndependentQuote[] {
  try {
    const value = JSON.parse(raw) as unknown
    return Array.isArray(value) ? value as IndependentQuote[] : []
  } catch {
    return []
  }
}

function chatOf(row: ChatRow): IndependentChat {
  const status = STATUSES.includes(row.status as IndependentStatus) ? row.status as IndependentStatus : 'open'
  const model: ModelChoice | undefined = row.model_provider === null || row.model_id === null
    ? undefined
    : {
        provider: row.model_provider,
        model: row.model_id,
        ...(row.model_reasoning === null ? {} : { reasoningEffort: row.model_reasoning }),
      }
  return {
    id: row.id,
    parentSessionId: row.parent_id,
    title: row.title,
    status,
    ...(row.archived_reason === null ? {} : { archivedReason: row.archived_reason as 'manual' | 'parent-removed' }),
    draftText: row.draft_text,
    pendingQuotes: quotesOf(row.pending_quotes),
    ...(model === undefined ? {} : { model }),
    ...(row.background_text === null ? {} : { backgroundText: row.background_text }),
    ...(row.background_from_seq === null ? {} : { backgroundFromSeq: row.background_from_seq }),
    ...(row.background_to_seq === null ? {} : { backgroundToSeq: row.background_to_seq }),
    ...(row.background_created_at === null ? {} : { backgroundCreatedAt: row.background_created_at }),
    firstSendDone: row.first_send_done === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function messageOf(row: MessageRow): IndependentMessage {
  const role = row.role === 'assistant' ? 'assistant' : 'user'
  const status = row.status === 'pending' || row.status === 'error' ? row.status : 'complete'
  return {
    id: row.id,
    chatId: row.chat_id,
    role,
    text: row.text,
    quotes: quotesOf(row.quotes),
    ...(row.background_text === null ? {} : { backgroundText: row.background_text }),
    status,
    ...(row.error === null ? {} : { error: row.error }),
    ...(row.request_id === null ? {} : { requestId: row.request_id }),
    createdAt: row.created_at,
  }
}

/** SQLite owner of independent side-chat sessions and messages. */
export class IndependentStore {
  private readonly db: DatabaseSync
  private readonly now: () => number

  constructor(path: string, options: { now?: () => number } = {}) {
    this.db = new DatabaseSync(path)
    this.now = options.now ?? (() => Date.now())
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;')
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS parents (
        parent_id TEXT PRIMARY KEY,
        active_id TEXT,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS chats (
        id TEXT PRIMARY KEY,
        parent_id TEXT NOT NULL,
        title TEXT NOT NULL,
        status TEXT NOT NULL,
        archived_reason TEXT,
        draft_text TEXT NOT NULL DEFAULT '',
        pending_quotes TEXT NOT NULL DEFAULT '[]',
        model_provider TEXT,
        model_id TEXT,
        model_reasoning TEXT,
        background_text TEXT,
        background_from_seq INTEGER,
        background_to_seq INTEGER,
        background_created_at INTEGER,
        first_send_done INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS chats_parent ON chats(parent_id, created_at);
      CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        chat_id TEXT NOT NULL,
        role TEXT NOT NULL,
        text TEXT NOT NULL,
        quotes TEXT NOT NULL DEFAULT '[]',
        background_text TEXT,
        status TEXT NOT NULL,
        error TEXT,
        request_id TEXT,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS messages_chat ON messages(chat_id, id);
    `)
    this.db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO NOTHING')
      .run('schema_version', '1')
    this.recoverPending()
  }

  close(): void {
    this.db.close()
  }

  private recoverPending(): void {
    this.db.prepare("UPDATE messages SET status = 'error', error = COALESCE(error, '上次生成未完成') WHERE status = 'pending'").run()
  }

  private touch(chatId: string): void {
    this.db.prepare('UPDATE chats SET updated_at = ? WHERE id = ?').run(this.now(), chatId)
  }

  private row(id: string): ChatRow | undefined {
    return this.db.prepare('SELECT * FROM chats WHERE id = ?').get(id) as ChatRow | undefined
  }

  listParent(parentId: string): IndependentParentState {
    const chats = this.db.prepare('SELECT * FROM chats WHERE parent_id = ? ORDER BY created_at ASC').all(parentId) as unknown as ChatRow[]
    const parent = this.db.prepare('SELECT active_id FROM parents WHERE parent_id = ?').get(parentId) as { active_id: string | null } | undefined
    const mapped = chats.map(chatOf)
    const activeId = parent?.active_id === null || parent?.active_id === undefined
      ? undefined
      : mapped.find(chat => chat.id === parent.active_id)?.id
    return {
      ...(activeId === undefined ? {} : { activeId }),
      chats: mapped,
    }
  }

  getChat(chatId: string): IndependentChat | undefined {
    const row = this.row(chatId)
    return row === undefined ? undefined : chatOf(row)
  }

  createChat(parentId: string, options: { id?: string; title?: string } = {}): IndependentChat {
    const id = options.id ?? `side-chat-${randomUUID()}`
    const now = this.now()
    const title = options.title ?? '新侧聊'
    this.db.prepare(`INSERT INTO chats
      (id, parent_id, title, status, draft_text, pending_quotes, first_send_done, created_at, updated_at)
      VALUES (?, ?, ?, 'open', '', '[]', 0, ?, ?)`).run(id, parentId, title, now, now)
    this.db.prepare(`INSERT INTO parents (parent_id, active_id, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(parent_id) DO UPDATE SET active_id = excluded.active_id, updated_at = excluded.updated_at`).run(parentId, id, now)
    return this.getChat(id)!
  }

  setActive(parentId: string, chatId?: string): void {
    this.db.prepare(`INSERT INTO parents (parent_id, active_id, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(parent_id) DO UPDATE SET active_id = excluded.active_id, updated_at = excluded.updated_at`)
      .run(parentId, chatId ?? null, this.now())
  }

  updateDraft(chatId: string, text: string): void {
    this.db.prepare('UPDATE chats SET draft_text = ?, updated_at = ? WHERE id = ?').run(text, this.now(), chatId)
  }

  setStatus(chatId: string, status: IndependentStatus, reason?: 'manual' | 'parent-removed'): void {
    this.db.prepare('UPDATE chats SET status = ?, archived_reason = ?, updated_at = ? WHERE id = ?')
      .run(status, reason ?? null, this.now(), chatId)
    if (status !== 'open') {
      this.db.prepare('UPDATE parents SET active_id = NULL WHERE active_id = ?').run(chatId)
    }
  }

  setModel(chatId: string, model?: ModelChoice): void {
    this.db.prepare('UPDATE chats SET model_provider = ?, model_id = ?, model_reasoning = ?, updated_at = ? WHERE id = ?')
      .run(model?.provider ?? null, model?.model ?? null, model?.reasoningEffort ?? null, this.now(), chatId)
  }

  setBackground(chatId: string, background: { text: string; fromSeq?: number; toSeq?: number }): void {
    this.db.prepare(`UPDATE chats SET background_text = ?, background_from_seq = ?, background_to_seq = ?,
      background_created_at = ?, updated_at = ? WHERE id = ?`)
      .run(background.text, background.fromSeq ?? null, background.toSeq ?? null, this.now(), this.now(), chatId)
  }

  addQuote(chatId: string, quote: IndependentQuote): void {
    const chat = this.getChat(chatId)
    if (chat === undefined) throw new Error('side-chat/not-found')
    const next = [...chat.pendingQuotes.filter(item => item.id !== quote.id), quote]
    this.db.prepare('UPDATE chats SET pending_quotes = ?, updated_at = ? WHERE id = ?')
      .run(JSON.stringify(next), this.now(), chatId)
  }

  removeQuote(chatId: string, quoteId: string): void {
    const chat = this.getChat(chatId)
    if (chat === undefined) throw new Error('side-chat/not-found')
    const next = chat.pendingQuotes.filter(item => item.id !== quoteId)
    this.db.prepare('UPDATE chats SET pending_quotes = ?, updated_at = ? WHERE id = ?')
      .run(JSON.stringify(next), this.now(), chatId)
  }

  clearQuotes(chatId: string): void {
    this.db.prepare("UPDATE chats SET pending_quotes = '[]', updated_at = ? WHERE id = ?").run(this.now(), chatId)
  }

  messages(chatId: string): readonly IndependentMessage[] {
    return (this.db.prepare('SELECT * FROM messages WHERE chat_id = ? ORDER BY id ASC').all(chatId) as unknown as MessageRow[])
      .map(messageOf)
  }

  view(chatId: string): { chat: IndependentChat; messages: readonly IndependentMessage[] } | undefined {
    const chat = this.getChat(chatId)
    return chat === undefined ? undefined : { chat, messages: this.messages(chatId) }
  }

  archived(): readonly IndependentChat[] {
    return (this.db.prepare("SELECT * FROM chats WHERE status IN ('archiving','archived') ORDER BY updated_at DESC").all() as unknown as ChatRow[])
      .map(chatOf)
  }

  deleteChat(chatId: string): void {
    this.db.exec('BEGIN')
    try {
      this.db.prepare('DELETE FROM messages WHERE chat_id = ?').run(chatId)
      this.db.prepare('DELETE FROM chats WHERE id = ?').run(chatId)
      this.db.prepare('UPDATE parents SET active_id = NULL WHERE active_id = ?').run(chatId)
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  beginSend(chatId: string, input: {
    requestId: string
    text: string
    quoteIds?: readonly string[]
    background?: { text: string; fromSeq?: number; toSeq?: number }
  }): IndependentMessage {
    const existing = this.db.prepare('SELECT * FROM messages WHERE request_id = ?').get(input.requestId) as MessageRow | undefined
    if (existing !== undefined) return messageOf(existing)
    const chat = this.getChat(chatId)
    if (chat === undefined) throw new Error('side-chat/not-found')
    const wanted = input.quoteIds === undefined ? chat.pendingQuotes : chat.pendingQuotes.filter(quote => input.quoteIds!.includes(quote.id))
    const now = this.now()
    const result = this.db.prepare(`INSERT INTO messages (chat_id, role, text, quotes, background_text, status, request_id, created_at)
      VALUES (?, 'user', ?, ?, ?, 'pending', ?, ?)`)
      .run(chatId, input.text, JSON.stringify(wanted), input.background?.text ?? null, input.requestId, now)
    if (input.background !== undefined) this.setBackground(chatId, input.background)
    return messageOf(this.db.prepare('SELECT * FROM messages WHERE id = ?').get(Number(result.lastInsertRowid)) as unknown as MessageRow)
  }

  completeSend(chatId: string, requestId: string, text: string): IndependentMessage {
    const now = this.now()
    this.db.prepare("UPDATE messages SET status = 'complete' WHERE request_id = ? AND role = 'user'").run(requestId)
    const result = this.db.prepare(`INSERT INTO messages (chat_id, role, text, quotes, status, request_id, created_at)
      VALUES (?, 'assistant', ?, '[]', 'complete', ?, ?)`).run(chatId, text, requestId, now)
    this.db.prepare('UPDATE chats SET first_send_done = 1, updated_at = ? WHERE id = ?').run(now, chatId)
    return messageOf(this.db.prepare('SELECT * FROM messages WHERE id = ?').get(Number(result.lastInsertRowid)) as unknown as MessageRow)
  }

  failSend(requestId: string, error: string): void {
    this.db.prepare("UPDATE messages SET status = 'error', error = ? WHERE request_id = ? AND role = 'user'").run(error, requestId)
  }
}
