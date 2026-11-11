import { randomUUID } from 'node:crypto'
import { mkdir, open, readFile, rename } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import type { ArchivedChatSummary, ContextSnapshot, PendingCreate, PendingSend, PersistedChat, PersistedParent, PersistedState, Quote, SentQuote } from '../shared/types.ts'

export const STORE_VERSION = 2
export const READABLE_VERSIONS = [1, 2] as const
export const CONTEXT_MODES = ['none', 'summary'] as const
export const CHAT_STAGES = ['draft', 'real'] as const
export const CHAT_STATUSES = ['open', 'saved', 'archiving', 'archived'] as const
export const ARCHIVED_REASONS = ['manual', 'parent-removed'] as const

type ChatStage = (typeof CHAT_STAGES)[number]
type ChatStatus = (typeof CHAT_STATUSES)[number]
type ArchivedReason = (typeof ARCHIVED_REASONS)[number]
type ContextMode = (typeof CONTEXT_MODES)[number]

interface StoreDocument {
  readonly version: typeof STORE_VERSION
  readonly parents: Record<string, PersistedParent>
}

export class SideChatStoreError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly cause?: unknown,
  ) {
    super(message)
    this.name = 'SideChatStoreError'
  }
}

function resolveDshHome(): string {
  const configured = process.env.DSH_HOME?.trim()
  return configured === undefined || configured === '' ? join(homedir(), '.dsh') : configured
}

export function defaultStorePath(): string {
  return join(resolveDshHome(), 'side-chat', 'state.json')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function isStage(value: unknown): value is ChatStage {
  return typeof value === 'string' && (CHAT_STAGES as readonly string[]).includes(value)
}

function isContextMode(value: unknown): value is ContextMode {
  return typeof value === 'string' && (CONTEXT_MODES as readonly string[]).includes(value)
}

function isStatus(value: unknown): value is ChatStatus {
  return typeof value === 'string' && (CHAT_STATUSES as readonly string[]).includes(value)
}

function parseChat(value: unknown): PersistedChat | null {
  if (!isRecord(value)) return null
  const { id, title, stage, status, archivedReason, sideSessionId, draftText, pendingQuotes, contextSnapshot, contextDelivered, pendingSend, pendingCreate, sentQuotes, firstSendDone, contextMode, createdAt, updatedAt } = value
  if (typeof id !== 'string' || id === '') return null
  if (typeof title !== 'string') return null
  if (!isStage(stage)) return null
  if (sideSessionId !== undefined && typeof sideSessionId !== 'string') return null
  if (typeof draftText !== 'string') return null
  const quotes = parseQuotes(pendingQuotes)
  if (quotes === null) return null
  const snapshot = parseContextSnapshot(contextSnapshot)
  if (snapshot === null) return null
  if (contextDelivered !== undefined && typeof contextDelivered !== 'boolean') return null
  const pending = parsePendingSend(pendingSend)
  if (pending === null) return null
  const create = parsePendingCreate(pendingCreate)
  if (create === null) return null
  const sent = parseSentQuotes(sentQuotes)
  if (sent === null) return null
  if (!isContextMode(contextMode)) return null
  if (status !== undefined && !isStatus(status)) return null
  if (archivedReason !== undefined && (typeof archivedReason !== 'string' || !(ARCHIVED_REASONS as readonly string[]).includes(archivedReason))) return null
  if (firstSendDone !== undefined && typeof firstSendDone !== 'boolean') return null
  if (!Number.isFinite(createdAt) || !Number.isFinite(updatedAt)) return null
  if (stage === 'draft' && sideSessionId !== undefined) return null
  if (stage === 'real' && (typeof sideSessionId !== 'string' || sideSessionId === '')) return null
  return {
    id,
    title,
    stage,
    status: status === undefined ? 'open' : status,
    ...(archivedReason === undefined ? {} : { archivedReason: archivedReason as ArchivedReason }),
    ...(sideSessionId === undefined ? {} : { sideSessionId }),
    draftText,
    pendingQuotes: quotes,
    ...(snapshot === undefined ? {} : { contextSnapshot: snapshot }),
    ...(contextDelivered === undefined ? {} : { contextDelivered }),
    ...(pending === undefined ? {} : { pendingSend: pending }),
    ...(create === undefined ? {} : { pendingCreate: create }),
    sentQuotes: sent,
    ...(firstSendDone === undefined ? {} : { firstSendDone }),
    contextMode,
    createdAt: createdAt as number,
    updatedAt: updatedAt as number,
  }
}

function parseQuotes(value: unknown): Quote[] | null {
  if (value === undefined) return []
  if (!Array.isArray(value)) return null
  const quotes: Quote[] = []
  for (const entry of value) {
    if (!isRecord(entry)) return null
    const { id, text, createdAt, sourceSessionId, sourceNodeKey } = entry
    if (typeof id !== 'string' || id === '') return null
    if (typeof text !== 'string' || text.trim() === '') return null
    if (!Number.isFinite(createdAt)) return null
    if (sourceSessionId !== undefined && typeof sourceSessionId !== 'string') return null
    if (sourceNodeKey !== undefined && typeof sourceNodeKey !== 'string') return null
    quotes.push({
      id,
      text,
      createdAt: createdAt as number,
      ...(sourceSessionId === undefined ? {} : { sourceSessionId }),
      ...(sourceNodeKey === undefined ? {} : { sourceNodeKey }),
    })
  }
  return quotes
}

function parseContextSnapshot(value: unknown): ContextSnapshot | null | undefined {
  if (value === undefined) return undefined
  if (!isRecord(value)) return null
  const { text, createdAt, sourceSessionId, sourceFromSeq, sourceToSeq, truncated, budget } = value
  if (typeof text !== 'string') return null
  if (!Number.isFinite(createdAt)) return null
  if (typeof sourceSessionId !== 'string' || sourceSessionId === '') return null
  for (const seq of [sourceFromSeq, sourceToSeq]) {
    if (seq !== undefined && !Number.isFinite(seq)) return null
  }
  if (truncated !== undefined && typeof truncated !== 'boolean') return null
  if (budget !== undefined && !Number.isFinite(budget)) return null
  return {
    text,
    createdAt: createdAt as number,
    sourceSessionId,
    ...(sourceFromSeq === undefined ? {} : { sourceFromSeq: sourceFromSeq as number }),
    ...(sourceToSeq === undefined ? {} : { sourceToSeq: sourceToSeq as number }),
    ...(truncated === undefined ? {} : { truncated }),
    ...(budget === undefined ? {} : { budget: budget as number }),
  }
}

function parsePendingSend(value: unknown): PendingSend | null | undefined {
  if (value === undefined) return undefined
  if (!isRecord(value)) return null
  const { requestId, text, quoteIds, quotes, contextInjected, createdAt } = value
  if (typeof requestId !== 'string' || requestId === '') return null
  if (typeof text !== 'string') return null
  if (!Number.isFinite(createdAt)) return null
  if (quoteIds !== undefined) {
    if (!Array.isArray(quoteIds) || quoteIds.some(id => typeof id !== 'string')) return null
  }
  if (contextInjected !== undefined && typeof contextInjected !== 'boolean') return null
  const parsed = parseQuotes(quotes)
  if (parsed === null) return null
  return {
    requestId,
    text,
    quoteIds: (quoteIds as string[] | undefined) ?? [],
    ...(parsed.length === 0 ? {} : { quotes: parsed }),
    ...(contextInjected === undefined ? {} : { contextInjected }),
    createdAt: createdAt as number,
  }
}

function parsePendingCreate(value: unknown): PendingCreate | null | undefined {
  if (value === undefined) return undefined
  if (!isRecord(value)) return null
  const { sessionId, createdAt } = value
  if (typeof sessionId !== 'string' || sessionId === '') return null
  if (!Number.isFinite(createdAt)) return null
  return { sessionId, createdAt: createdAt as number }
}

function parseSentQuotes(value: unknown): SentQuote[] | null {
  if (value === undefined) return []
  if (!Array.isArray(value)) return null
  const sent: SentQuote[] = []
  for (const entry of value) {
    if (!isRecord(entry)) return null
    const { quote, requestId, sentAt } = entry
    const parsed = parseQuotes([quote])
    if (parsed === null || parsed.length !== 1) return null
    if (requestId !== undefined && typeof requestId !== 'string') return null
    if (!Number.isFinite(sentAt)) return null
    sent.push({
      quote: parsed[0],
      ...(requestId === undefined ? {} : { requestId }),
      sentAt: sentAt as number,
    })
  }
  return sent
}

function parseDocument(raw: string): StoreDocument {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    throw new SideChatStoreError('side-chat/store-corrupt', '侧聊记录不是有效的 JSON，未作任何覆盖。', error)
  }
  if (!isRecord(parsed) || !(READABLE_VERSIONS as readonly unknown[]).includes(parsed.version) || !isRecord(parsed.parents)) {
    throw new SideChatStoreError('side-chat/store-invalid', '侧聊记录格式不受支持，未作任何覆盖。')
  }
  const parents: Record<string, PersistedParent> = {}
  for (const [parentId, value] of Object.entries(parsed.parents)) {
    if (!isRecord(value) || !Array.isArray(value.chats)) {
      throw new SideChatStoreError('side-chat/store-invalid', '侧聊记录包含无效的父会话条目，未作任何覆盖。')
    }
    const chats: PersistedChat[] = []
    for (const entry of value.chats) {
      const chat = parseChat(entry)
      if (chat === null) {
        throw new SideChatStoreError('side-chat/store-invalid', '侧聊记录包含无效条目，未作任何覆盖。')
      }
      chats.push(chat)
    }
    parents[parentId] = {
      ...(typeof value.activeId === 'string' ? { activeId: value.activeId } : {}),
      chats,
    }
  }
  return { version: STORE_VERSION, parents }
}

/**
 * Atomically persisted per-parent Side Chat metadata. One file holds every
 * parent's chat list, drafts and active pointer; sessions themselves stay with
 * the host Session storage.
 */
export class SideChatStore {
  private document: StoreDocument | null = null
  private chain: Promise<unknown> = Promise.resolve()

  constructor(readonly filePath: string = defaultStorePath()) {}

  async load(parentId: string): Promise<PersistedParent | null> {
    await this.ensureLoaded()
    return this.document?.parents[parentId] ?? null
  }

  async listArchived(): Promise<ArchivedChatSummary[]> {
    await this.ensureLoaded()
    const summaries: ArchivedChatSummary[] = []
    for (const [parentSessionId, parent] of Object.entries(this.document?.parents ?? {})) {
      for (const chat of parent.chats) {
        if (chat.status !== 'archived' && chat.status !== 'archiving') continue
        summaries.push({
          status: chat.status,
          chatId: chat.id,
          parentSessionId,
          title: chat.title,
          ...(chat.sideSessionId === undefined ? {} : { sideSessionId: chat.sideSessionId }),
          ...(chat.archivedReason === undefined ? {} : { archivedReason: chat.archivedReason }),
          ...(chat.contextSnapshot?.text === undefined || chat.contextSnapshot.text === ''
            ? {}
            : { backgroundText: chat.contextSnapshot.text }),
          updatedAt: chat.updatedAt,
        })
      }
    }
    return summaries.sort((left, right) => right.updatedAt - left.updatedAt)
  }

  async save(parentId: string, state: PersistedState): Promise<void> {
    const parsed = state.chats.map(chat => parseChat(chat))
    if (parsed.some(chat => chat === null)) {
      throw new SideChatStoreError('side-chat/store-invalid', '拒绝写入无效的侧聊记录。')
    }
    const activeId = state.activeId
    if (activeId !== undefined && !parsed.some(chat => chat?.id === activeId)) {
      throw new SideChatStoreError('side-chat/store-invalid', '活动侧聊必须属于同一父会话。')
    }
    await this.ensureLoaded()
    await this.enqueue(async () => {
      const next: StoreDocument = {
        version: STORE_VERSION,
        parents: {
          ...(this.document?.parents ?? {}),
          [parentId]: {
            ...(activeId === undefined ? {} : { activeId }),
            chats: parsed as PersistedChat[],
          },
        },
      }
      await this.write(next)
      this.document = next
    })
  }

  private async ensureLoaded(): Promise<void> {
    if (this.document !== null) return
    let raw: string
    try {
      raw = await readFile(this.filePath, 'utf8')
    } catch (error: unknown) {
      if (isRecord(error) && error.code === 'ENOENT') {
        this.document = { version: STORE_VERSION, parents: {} }
        return
      }
      throw new SideChatStoreError('side-chat/store-unreadable', '无法读取侧聊记录。', error)
    }
    this.document = parseDocument(raw)
  }

  private enqueue(operation: () => Promise<void>): Promise<void> {
    const run = this.chain.then(operation)
    this.chain = run.catch(() => undefined)
    return run
  }

  private async write(document: StoreDocument): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true })
    const temporary = `${this.filePath}.tmp-${process.pid}-${randomUUID()}`
    const payload = `${JSON.stringify(document, null, 2)}\n`
    const handle = await open(temporary, 'w', 0o600)
    try {
      await handle.writeFile(payload, 'utf8')
      await handle.sync()
    } finally {
      await handle.close()
    }
    await rename(temporary, this.filePath)
  }
}
