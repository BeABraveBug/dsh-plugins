/** The subset of the DSH client session contracts the panel relies on. */

export interface Observable<T> {
  getSnapshot(): T
  subscribe(listener: () => void): () => void
}

export interface RemoteFailureLike {
  readonly code?: string
  readonly message?: string
}

export type RemoteResultLike<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: RemoteFailureLike }

export interface SessionSnapshotLike {
  readonly running: boolean
  readonly openState: string
  readonly promptError: {
    readonly op: string
    readonly error: RemoteFailureLike
  } | null
  readonly lastAgentError: string | null
  readonly openError: RemoteFailureLike | null
  readonly removed: boolean
  readonly blank?: boolean
}

export interface SessionEventWindowLike {
  readonly entries: readonly unknown[]
  readonly hasMore: boolean
  readonly revision: number
}

export interface SubmissionHandleLike {
  readonly requestId: string
  abandon(): void
}

export interface SessionFaceLike extends Observable<SessionSnapshotLike> {
  beginSubmission?(input: {
    readonly mode: 'queue' | 'steer'
    readonly text: string
    readonly attachments: readonly unknown[]
  }): SubmissionHandleLike
  prompt(
    content: readonly { readonly type: 'text'; readonly text: string }[],
    mode: 'queue' | 'steer',
    signal?: AbortSignal,
    requestId?: string,
  ): Promise<RemoteResultLike<{ readonly accepted: true }>>
  loadOlder?(): Promise<void>
}

export interface SessionBindingLike {
  readonly sessionId: string
  readonly session: SessionFaceLike
  readonly eventSource: Observable<SessionEventWindowLike>
}

export interface SessionReferenceLike {
  readonly sessionId: string
  readonly binding: SessionBindingLike
  readonly ready: Promise<SessionBindingLike>
  release(): void
}

export interface SessionSummaryLike {
  readonly id: string
  readonly cwd?: string
}

export interface WorkspaceLike {
  readonly workspaceId: string
  readonly path: string
  readonly sessionIds: readonly string[]
}

export interface WorkspaceListLike {
  readonly items: readonly WorkspaceLike[]
}

export interface SessionStatusLike {
  readonly running?: boolean
  readonly pendingInteraction?: unknown
}

export interface UiSessionServiceLike {
  readonly sessionStatus: Observable<ReadonlyMap<string, SessionStatusLike>>
}

export interface WorkspacesServiceLike {
  readonly list: Observable<WorkspaceListLike>
}

export interface SessionListLike {
  readonly ids: readonly string[]
  readonly byId: Readonly<Record<string, SessionSummaryLike>>
}

export interface SessionsServiceLike {
  readonly list?: Observable<SessionListLike>
  create(options?: { workspaceId?: string; cwd?: string; sessionId?: string }): Promise<string>
  retain(sessionId: string, options: { source: string }): SessionReferenceLike
  binding(sessionId: string): SessionBindingLike | undefined
}
