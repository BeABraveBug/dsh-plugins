/** A supported book file format. */
export type BookFormat = 'pdf' | 'epub' | 'txt' | 'markdown'

/** Result of checking whether a recorded original file is readable. */
export type Availability = 'ok' | 'missing' | 'inaccessible'

/** PDF reading position: page number (1-based) plus fractional scroll offset inside the page. */
export interface PdfPosition {
  readonly kind: 'pdf'
  readonly page: number
  readonly total: number
  readonly offset: number
}

/** EPUB reading position: EPUB CFI of the relocated range start. */
export interface EpubPosition {
  readonly kind: 'epub'
  readonly cfi: string
}

/** TXT/Markdown reading position: fractional scroll offset of the document. */
export interface ScrollPosition {
  readonly kind: 'scroll'
  readonly ratio: number
}

/** Format-specific reading position. */
export type ReadingPosition = PdfPosition | EpubPosition | ScrollPosition

/** Persisted reading progress for one book. */
export interface BookProgress {
  position: ReadingPosition | null
  /** Display percentage (0-100), or null before the first progress report. */
  percent: number | null
  /** Epoch milliseconds of the last progress write, or null. */
  updatedAt: number | null
}


/** Text context captured from the current reader view for notes and Q&A. */
export interface ReaderTextContext {
  readonly format: BookFormat
  readonly anchor: ReadingPosition
  readonly excerpt: string
  readonly truncated: boolean
}

/** A user-triggered screenshot of the reading area. */
export interface ReaderScreenshot {
  readonly dataUrl: string
  readonly width: number
  readonly height: number
}

/** One persisted bookshelf record. This record never contains a copy of the book. */
export interface BookRecord {
  readonly id: string
  /** Normalized absolute path of the original file. */
  readonly path: string
  readonly title: string
  readonly format: BookFormat
  readonly size: number
  readonly addedAt: number
  lastOpenedAt: number | null
  progress: BookProgress
  /** PDF reading width as a multiple of fit-width (1 = fit width); null for default. */
  readerWidth: number | null
  markedRead: boolean
}


/** One Markdown note attached to a book. Notes survive removing the shelf entry. */
export interface BookNote {
  readonly id: string
  title: string
  markdown: string
  readonly createdAt: number
  updatedAt: number
  /** Reading position captured when the note was created. */
  readonly anchor: ReadingPosition | null
}

/** Note collection stored under one normalized book path. */
export interface NoteBook {
  readonly bookId: string
  readonly bookPath: string
  readonly bookTitle: string
  readonly bookFormat: BookFormat
  notes: BookNote[]
  lastEditedNoteId: string | null
  aiSelection: AiSelection | null
  updatedAt: number
}

/** Notes returned for the currently open book. */
export interface NoteList {
  notes: BookNote[]
  readonly lastEditedNoteId: string | null
}

/** Summary used by the shelf-level notes data manager. */
export interface NoteBookSummary {
  readonly bookId: string
  readonly bookPath: string
  readonly bookTitle: string
  readonly bookFormat: BookFormat
  readonly noteCount: number
  readonly updatedAt: number
}

/** Create or update one note. Omit noteId to create. */
export interface SaveNoteRequest {
  readonly bookId: string
  readonly bookPath: string
  readonly bookTitle: string
  readonly bookFormat: BookFormat
  readonly noteId?: string
  readonly title: string
  readonly markdown: string
  readonly anchor: ReadingPosition | null
}


/** Public model metadata returned by the bookshelf AI bridge. */
export interface AiModelInfo {
  readonly id: string
  readonly name: string
  readonly supportsImages: boolean
}

export interface AiProviderInfo {
  readonly id: string
  readonly name: string
  readonly models: readonly AiModelInfo[]
}

export interface AiSelection {
  readonly provider: string
  readonly model: string
}

export interface AiModelCatalog {
  readonly providers: readonly AiProviderInfo[]
  readonly defaultSelection: AiSelection | null
}

export interface ChatMessageView {
  readonly id: string
  readonly role: 'user' | 'assistant'
  readonly content: string
  readonly createdAt: number
}

export interface AiAskRequest {
  readonly question: string
  readonly context: string
  readonly selection?: AiSelection | null
}

export interface AiAskResult {
  readonly answer: string
  readonly selection: AiSelection
}

/** A book plus the latest availability check. Availability is never persisted. */
export interface BookView extends BookRecord {
  readonly availability: Availability
  /** Machine-readable reason for a non-ok availability. */
  readonly availabilityDetail: string | null
}

/** One entry returned by the host directory browser. */
export interface BrowseEntry {
  readonly name: string
  readonly path: string
  readonly kind: 'directory' | 'file'
  readonly format: BookFormat | null
  readonly size: number | null
}

/** Directory browser reply. */
export interface BrowseResult {
  readonly path: string
  readonly parent: string | null
  readonly entries: readonly BrowseEntry[]
  readonly truncated: boolean
}

/** Result of adding one or more paths. */
export interface AddResult {
  readonly added: readonly BookView[]
  readonly skipped: readonly string[]
  readonly invalid: readonly { readonly path: string; readonly message: string }[]
}

/** Remote operation request. */
export type RpcRequest =
  | { readonly op: 'list' }
  | { readonly op: 'browse'; readonly path?: string }
  | { readonly op: 'addPaths'; readonly paths: readonly string[] }
  | { readonly op: 'addDirectory'; readonly path: string }
  | { readonly op: 'open'; readonly id: string }
  | { readonly op: 'saveProgress'; readonly id: string; readonly position: ReadingPosition; readonly percent: number }
  | { readonly op: 'saveReaderWidth'; readonly id: string; readonly width: number }
  | { readonly op: 'setRead'; readonly id: string; readonly markedRead: boolean }
  | { readonly op: 'remove'; readonly id: string }
  | { readonly op: 'listNotes'; readonly bookId: string }
  | { readonly op: 'saveNote'; readonly note: SaveNoteRequest }
  | { readonly op: 'deleteNote'; readonly bookId: string; readonly noteId: string }
  | { readonly op: 'listNoteBooks' }
  | { readonly op: 'deleteNoteBook'; readonly bookId: string }
  | { readonly op: 'listAiModels' }
  | { readonly op: 'askAi'; readonly question: string; readonly context: string; readonly selection?: AiSelection | null }
  | { readonly op: 'getBookAiSelection'; readonly bookId: string }
  | { readonly op: 'saveBookAiSelection'; readonly bookId: string; readonly bookPath: string; readonly bookTitle: string; readonly bookFormat: BookFormat; readonly selection: AiSelection | null }
  | { readonly op: 'listConversation'; readonly bookId: string }
  | { readonly op: 'appendConversation'; readonly bookId: string; readonly bookPath: string; readonly bookTitle: string; readonly bookFormat: BookFormat; readonly role: 'user' | 'assistant'; readonly content: string }
  | { readonly op: 'clearConversation'; readonly bookId: string }

/** Successful RPC envelope. */
export interface RpcSuccess<T> {
  readonly ok: true
  readonly value: T
}

/** Failed RPC envelope. Domain failures still use HTTP 200. */
export interface RpcFailure {
  readonly ok: false
  readonly error: {
    readonly code: string
    readonly message: string
  }
}

export type RpcResult<T> = RpcSuccess<T> | RpcFailure
