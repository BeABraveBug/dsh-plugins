import type {
  AddResult,
  BookRecord,
  BookView,
  AiAskResult,
  AiModelCatalog,
  AiSelection,
  BookNote,
  BrowseResult,
  NoteBookSummary,
  NoteList,
  ReadingPosition,
  SaveNoteRequest,
  RpcRequest,
  RpcResult,
} from '../shared/types.ts'

/** Stable browser-side failure raised from a domain error envelope. */
export class BookshelfApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message)
    this.name = 'BookshelfApiError'
  }
}

async function rpc<T>(request: RpcRequest): Promise<T> {
  let response: Response
  try {
    response = await fetch('/api/bookshelf/rpc', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(request),
    })
  } catch (error: unknown) {
    throw new BookshelfApiError('bookshelf/network', messageOf(error))
  }
  if (response.status === 401) throw new BookshelfApiError('bookshelf/unauthorized', '浏览器会话已失效，请刷新页面。')
  if (response.status === 403) throw new BookshelfApiError('bookshelf/forbidden', '当前连接无权访问书架。')
  let envelope: RpcResult<T>
  try {
    envelope = await response.json() as RpcResult<T>
  } catch (error: unknown) {
    throw new BookshelfApiError('bookshelf/bad-response', `Host 返回了无法解析的响应：${messageOf(error)}`)
  }
  if (!envelope.ok) throw new BookshelfApiError(envelope.error.code, envelope.error.message)
  return envelope.value
}

/** Browser client for the bookshelf Host routes. */
export interface BookshelfApi {
  list(): Promise<{ books: BookView[]; libraryPath: string }>
  browse(path?: string): Promise<BrowseResult>
  addPaths(paths: readonly string[]): Promise<AddResult>
  addDirectory(path: string): Promise<AddResult & { directory?: string }>
  open(id: string): Promise<BookRecord>
  saveProgress(id: string, position: ReadingPosition, percent: number): Promise<BookRecord>
  saveReaderWidth(id: string, width: number): Promise<BookRecord>
  setRead(id: string, markedRead: boolean): Promise<BookRecord>
  remove(id: string): Promise<{ removed: boolean }>
  listNotes(bookId: string): Promise<NoteList>
  saveNote(note: SaveNoteRequest): Promise<BookNote>
  deleteNote(bookId: string, noteId: string): Promise<{ deleted: boolean }>
  listNoteBooks(): Promise<NoteBookSummary[]>
  deleteNoteBook(bookId: string): Promise<{ deleted: boolean }>
  listAiModels(): Promise<AiModelCatalog>
  askAi(question: string, context: string, selection: AiSelection | null): Promise<AiAskResult>
  fileBytes(id: string): Promise<ArrayBuffer>
  fileText(id: string): Promise<string>
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function fileUrl(id: string): string {
  return `/api/bookshelf/file?id=${encodeURIComponent(id)}`
}

/** Authenticated URL for a book's optional cover image. */
export function coverUrl(id: string): string {
  return `/api/bookshelf/cover?id=${encodeURIComponent(id)}`
}

/** Authenticated base URL for PDF.js CMaps or standard font data. */
export function pdfjsAssetUrl(kind: 'cmap' | 'font' | 'wasm'): string {
  // PDF.js requires its factory URL to end with a slash before appending the file name.
  return new URL(`/api/bookshelf/pdfjs?kind=${kind}&name=./`, window.location.href).href
}

async function readFileResponse(id: string): Promise<Response> {
  let response: Response
  try {
    response = await fetch(fileUrl(id), { credentials: 'same-origin', cache: 'no-store' })
  } catch (error: unknown) {
    throw new BookshelfApiError('bookshelf/network', messageOf(error))
  }
  if (response.status === 401) throw new BookshelfApiError('bookshelf/unauthorized', '浏览器会话已失效，请刷新页面。')
  if (!response.ok) throw new BookshelfApiError('bookshelf/file-unavailable', `无法读取原文件（HTTP ${response.status}）。`)
  return response
}

/** Build the API object once in apply and hand plain callbacks to components. */
export function createBookshelfApi(): BookshelfApi {
  return {
    list: () => rpc({ op: 'list' }),
    browse: (path) => rpc({ op: 'browse', ...(path === undefined ? {} : { path }) }),
    addPaths: (paths) => rpc({ op: 'addPaths', paths: [...paths] }),
    addDirectory: (path) => rpc({ op: 'addDirectory', path }),
    open: (id) => rpc({ op: 'open', id }),
    saveProgress: (id, position, percent) => rpc({ op: 'saveProgress', id, position, percent }),
    saveReaderWidth: (id, width) => rpc({ op: 'saveReaderWidth', id, width }),
    setRead: (id, markedRead) => rpc({ op: 'setRead', id, markedRead }),
    remove: (id) => rpc({ op: 'remove', id }),
    listNotes: (bookId) => rpc({ op: 'listNotes', bookId }),
    saveNote: (note) => rpc({ op: 'saveNote', note }),
    deleteNote: (bookId, noteId) => rpc({ op: 'deleteNote', bookId, noteId }),
    listNoteBooks: () => rpc({ op: 'listNoteBooks' }),
    deleteNoteBook: (bookId) => rpc({ op: 'deleteNoteBook', bookId }),
    listAiModels: () => rpc({ op: 'listAiModels' }),
    askAi: (question, context, selection) => rpc({ op: 'askAi', question, context, selection }),
    fileBytes: async (id) => (await readFileResponse(id)).arrayBuffer(),
    fileText: async (id) => (await readFileResponse(id)).text(),
  }
}
