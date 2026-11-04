import { createReadStream } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { basename, extname, join, resolve, sep } from 'node:path'
import { Readable } from 'node:stream'
import { fileURLToPath } from 'node:url'
import { BookshelfError, Library, browseDirectory, statBookFile } from './library.ts'
import { coverForBook } from './covers.ts'
import { NoteStore } from './notes.ts'
import { AiService } from './ai.ts'
import type { RpcRequest, RpcResult } from '../shared/types.ts'

interface FetchRoute {
  readonly path: string
  readonly methods: readonly ('GET' | 'HEAD' | 'POST')[]
  readonly requestBody: 'buffered' | 'streaming'
  readonly fetch: (request: Request) => Promise<Response>
}

interface ConnectionFace {
  readonly fetch?: { register(route: FetchRoute): () => void }
}

interface RouteContext {
  readonly inject: (names: readonly string[], callback: (ctx: any) => void) => unknown
  readonly effect: (effect: () => () => void, label?: string) => unknown
  get(name: string): unknown
}

export const RPC_PATH = '/api/bookshelf/rpc'
export const FILE_PATH = '/api/bookshelf/file'
export const COVER_PATH = '/api/bookshelf/cover'
export const PDFJS_ASSET_PATH = '/api/bookshelf/pdfjs'

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  })
}

function failure(code: string, message: string): RpcResult<never> {
  return { ok: false, error: { code, message } }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object'
}

function stringArray(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null
  const values: string[] = []
  for (const entry of value) {
    if (typeof entry !== 'string' || entry.trim() === '') return null
    values.push(entry)
  }
  return values
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

async function dispatch(library: Library, notes: NoteStore, getAi: () => AiService | null, body: unknown): Promise<RpcResult<unknown>> {
  if (!isRecord(body) || typeof body.op !== 'string') return failure('bookshelf/bad-request', '请求格式无效。')
  const request = body as unknown as RpcRequest
  switch (request.op) {
    case 'list':
      return { ok: true, value: { books: await library.listWithAvailability(), libraryPath: library.filePath } }
    case 'browse': {
      if (request.path !== undefined && typeof request.path !== 'string') return failure('bookshelf/bad-request', '目录路径无效。')
      return { ok: true, value: await browseDirectory(request.path) }
    }
    case 'addPaths': {
      const paths = stringArray(request.paths)
      if (paths === null) return failure('bookshelf/bad-request', '文件路径列表无效。')
      return { ok: true, value: await library.addPaths(paths) }
    }
    case 'addDirectory': {
      if (typeof request.path !== 'string' || request.path.trim() === '') return failure('bookshelf/bad-request', '目录路径无效。')
      return { ok: true, value: await library.addDirectory(request.path) }
    }
    case 'open': {
      if (typeof request.id !== 'string' || request.id === '') return failure('bookshelf/bad-request', '书目 id 无效。')
      const book = await library.markOpened(request.id)
      return { ok: true, value: book }
    }
    case 'saveProgress': {
      if (typeof request.id !== 'string' || request.id === '') return failure('bookshelf/bad-request', '书目 id 无效。')
      return { ok: true, value: await library.saveProgress(request.id, request.position, request.percent) }
    }
    case 'saveReaderWidth': {
      if (typeof request.id !== 'string' || request.id === '') return failure('bookshelf/bad-request', '书目 id 无效。')
      if (typeof request.width !== 'number') return failure('bookshelf/bad-request', '阅读宽度无效。')
      return { ok: true, value: await library.saveReaderWidth(request.id, request.width) }
    }
    case 'setRead': {
      if (typeof request.id !== 'string' || typeof request.markedRead !== 'boolean') return failure('bookshelf/bad-request', '已读状态无效。')
      return { ok: true, value: await library.setRead(request.id, request.markedRead) }
    }
    case 'remove': {
      if (typeof request.id !== 'string' || request.id === '') return failure('bookshelf/bad-request', '书目 id 无效。')
      return { ok: true, value: await library.remove(request.id) }
    }
    case 'listNotes': {
      if (typeof request.bookId !== 'string' || request.bookId === '') return failure('bookshelf/bad-request', '书目 id 无效。')
      return { ok: true, value: await notes.list(request.bookId) }
    }
    case 'saveNote':
      return { ok: true, value: await notes.save(request.note) }
    case 'deleteNote': {
      if (typeof request.bookId !== 'string' || typeof request.noteId !== 'string') return failure('bookshelf/bad-request', '笔记 id 无效。')
      return { ok: true, value: await notes.remove(request.bookId, request.noteId) }
    }
    case 'listNoteBooks':
      return { ok: true, value: await notes.listBooks() }
    case 'deleteNoteBook': {
      if (typeof request.bookId !== 'string' || request.bookId === '') return failure('bookshelf/bad-request', '书目 id 无效。')
      return { ok: true, value: await notes.deleteBook(request.bookId) }
    }
    case 'listAiModels': {
      const ai = getAi()
      if (ai === null) return failure('bookshelf/ai-unavailable', 'DSH 模型服务不可用。')
      return { ok: true, value: await ai.listModels() }
    }
    case 'getBookAiSelection': {
      if (typeof request.bookId !== 'string' || request.bookId === '') return failure('bookshelf/bad-request', '书目 id 无效。')
      return { ok: true, value: await notes.getAiSelection(request.bookId) }
    }
    case 'saveBookAiSelection': {
      if (typeof request.bookId !== 'string' || request.bookId === '') return failure('bookshelf/bad-request', '书目 id 无效。')
      return { ok: true, value: await notes.saveAiSelection(request.bookId, request.bookPath, request.bookTitle, request.bookFormat, request.selection) }
    }
    case 'askAi': {
      const ai = getAi()
      if (ai === null) return failure('bookshelf/ai-unavailable', 'DSH 模型服务不可用。')
      if (typeof request.question !== 'string' || typeof request.context !== 'string') return failure('bookshelf/bad-request', '问答内容无效。')
      return { ok: true, value: await ai.ask(request.question, request.context, request.selection ?? null) }
    }
    default:
      return failure('bookshelf/unknown-op', '未知的书架操作。')
  }
}

function parseRange(value: string | null, size: number): { start: number; end: number } | 'invalid' | null {
  if (value === null || value === '') return null
  const match = /^bytes=(\d*)-(\d*)$/.exec(value.trim())
  if (match === null) return 'invalid'
  const startText = match[1] ?? ''
  const endText = match[2] ?? ''
  if (startText === '' && endText === '') return 'invalid'
  let start: number
  let end: number
  if (startText === '') {
    const suffix = Number(endText)
    if (!Number.isSafeInteger(suffix) || suffix <= 0) return 'invalid'
    start = Math.max(0, size - suffix)
    end = size - 1
  } else {
    start = Number(startText)
    end = endText === '' ? size - 1 : Number(endText)
  }
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start > end || start >= size) return 'invalid'
  return { start, end: Math.min(end, size - 1) }
}

export async function createFileHandler(library: Library, request: Request): Promise<Response> {
  const url = new URL(request.url)
  const id = url.searchParams.get('id')
  if (id === null || id === '') return json(failure('bookshelf/bad-request', '缺少书目 id。'), 400)
  const book = await library.find(id)
  if (book === undefined) return json(failure('bookshelf/not-found', '书目不存在。'), 404)
  let file: { size: number; contentType: string }
  try {
    file = await statBookFile(book.path)
  } catch (error: unknown) {
    const code = error instanceof BookshelfError ? error.code : 'bookshelf/file-unavailable'
    return json(failure(code, messageOf(error)), 404)
  }
  const range = parseRange(request.headers.get('range'), file.size)
  if (range === 'invalid') {
    return new Response(null, { status: 416, headers: { 'content-range': `bytes */${file.size}` } })
  }
  const headers = new Headers({
    'content-type': file.contentType,
    'accept-ranges': 'bytes',
    'cache-control': 'no-store',
    'content-disposition': `inline; filename*=UTF-8''${encodeURIComponent(book.title)}`,
  })
  if (range !== null) {
    headers.set('content-length', String(range.end - range.start + 1))
    headers.set('content-range', `bytes ${range.start}-${range.end}/${file.size}`)
  } else {
    headers.set('content-length', String(file.size))
  }
  if (request.method === 'HEAD') return new Response(null, { status: range === null ? 200 : 206, headers })
  const stream = createReadStream(book.path, range === null ? undefined : { start: range.start, end: range.end })
  const body = Readable.toWeb(stream) as unknown as ReadableStream<Uint8Array>
  return new Response(body, { status: range === null ? 200 : 206, headers })
}

export async function createCoverHandler(library: Library, request: Request): Promise<Response> {
  const url = new URL(request.url)
  const id = url.searchParams.get('id')
  if (id === null || id === '') return json(failure('bookshelf/bad-request', '缺少书目 id。'), 400)
  const book = await library.find(id)
  if (book === undefined) return json(failure('bookshelf/not-found', '书目不存在。'), 404)
  let cover
  try {
    cover = await coverForBook(book)
  } catch (error: unknown) {
    console.error('[bookshelf] cover lookup failed', error)
    return new Response(null, { status: 404, headers: { 'cache-control': 'no-store' } })
  }
  if (cover === null) return new Response(null, { status: 204, headers: { 'cache-control': 'no-store' } })
  const headers = new Headers({
    'content-type': cover.contentType,
    'content-length': String(cover.bytes.byteLength),
    'cache-control': 'no-store',
  })
  if (request.method === 'HEAD') return new Response(null, { status: 200, headers })
  return new Response(cover.bytes as unknown as BodyInit, { status: 200, headers })
}

const PDFJS_ASSET_TYPES: Record<string, { directory: string; extensions: ReadonlySet<string>; contentType: (name: string) => string }> = {
  cmap: {
    directory: 'cmaps',
    extensions: new Set(['.bcmap']),
    contentType: () => 'application/octet-stream',
  },
  font: {
    directory: 'standard_fonts',
    extensions: new Set(['.ttf', '.otf', '.pfb', '.ttc']),
    contentType: (name) => {
      switch (extname(name).toLowerCase()) {
        case '.ttf': return 'font/ttf'
        case '.otf': return 'font/otf'
        case '.ttc': return 'font/collection'
        default: return 'application/octet-stream'
      }
    },
  },
  wasm: {
    directory: 'wasm',
    extensions: new Set(['.wasm', '.js']),
    contentType: (name) => extname(name).toLowerCase() === '.wasm' ? 'application/wasm' : 'text/javascript',
  },
}

export async function createPdfAssetHandler(assetRoot: string, request: Request): Promise<Response> {
  const url = new URL(request.url)
  const kind = url.searchParams.get('kind')
  const rawName = url.searchParams.get('name')
  const name = rawName?.startsWith('./') === true ? rawName.slice(2) : rawName
  if (kind === null || name === null || name === '' || basename(name) !== name || name.includes('..')) {
    return new Response(null, { status: 400 })
  }
  const type = PDFJS_ASSET_TYPES[kind]
  if (type === undefined || !type.extensions.has(extname(name).toLowerCase())) {
    return new Response(null, { status: 400 })
  }
  const directory = resolve(assetRoot, type.directory)
  const file = resolve(directory, name)
  if (!file.startsWith(`${directory}${sep}`)) return new Response(null, { status: 400 })
  let bytes: Buffer
  try {
    bytes = await readFile(file)
  } catch {
    return new Response(null, { status: 404 })
  }
  const headers = new Headers({
    'content-type': type.contentType(name),
    'content-length': String(bytes.byteLength),
    'cache-control': 'private, max-age=3600',
  })
  if (request.method === 'HEAD') return new Response(null, { status: 200, headers })
  return new Response(bytes as unknown as BodyInit, { status: 200, headers })
}

export function createRpcHandler(library: Library, notes: NoteStore = new NoteStore(), getAi: () => AiService | null = () => null): (request: Request) => Promise<Response> {
  return async (request: Request): Promise<Response> => {
    let body: unknown
    try {
      body = await request.json()
    } catch {
      return json(failure('bookshelf/bad-request', '请求体不是有效的 JSON。'), 400)
    }
    try {
      const result = await dispatch(library, notes, getAi, body)
      return json(result)
    } catch (error: unknown) {
      if (error instanceof BookshelfError) return json(failure(error.code, error.message))
      console.error('[bookshelf] request failed', error)
      return json(failure('bookshelf/internal', messageOf(error)), 500)
    }
  }
}

/** Register the authenticated Host routes once Connection is available. */
export function registerRoutes(ctx: RouteContext, library: Library): void {
  ctx.inject(['connection'], (injected) => {
    const connection = injected.get('connection') as ConnectionFace | undefined
    const register = connection?.fetch?.register
    if (register === undefined) return
    const notes = new NoteStore()
    let ai: AiService | null = null
    ctx.inject(['llm', 'agentDefaultModel'], (injected: any) => {
      try {
        const llm = injected.get('llm')
        const defaultModel = injected.get('agentDefaultModel')
        if (llm !== undefined && defaultModel !== undefined) ai = new AiService(llm, defaultModel)
      } catch {
        ai = null
      }
    })
    const rpc = createRpcHandler(library, notes, () => ai)
    injected.effect(() => register({
      path: RPC_PATH,
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: rpc,
    }), 'bookshelf: rpc route')
    injected.effect(() => register({
      path: FILE_PATH,
      methods: ['GET', 'HEAD'],
      requestBody: 'buffered',
      fetch: (request) => createFileHandler(library, request),
    }), 'bookshelf: file route')
    injected.effect(() => register({
      path: COVER_PATH,
      methods: ['GET', 'HEAD'],
      requestBody: 'buffered',
      fetch: (request) => createCoverHandler(library, request),
    }), 'bookshelf: cover route')
    const assetRoot = fileURLToPath(new URL('./pdfjs', import.meta.url))
    injected.effect(() => register({
      path: PDFJS_ASSET_PATH,
      methods: ['GET', 'HEAD'],
      requestBody: 'buffered',
      fetch: (request) => createPdfAssetHandler(assetRoot, request),
    }), 'bookshelf: pdfjs asset route')
  })
}
