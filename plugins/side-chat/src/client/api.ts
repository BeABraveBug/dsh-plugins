import type { ArchivedChatSummary, PersistedState, SideChatRpcRequest, SideChatRpcResult } from '../shared/types.ts'

export const RPC_PATH = '/api/side-chat/rpc'

export class SideChatApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message)
    this.name = 'SideChatApiError'
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

async function rpc<T>(request: SideChatRpcRequest): Promise<T> {
  let response: Response
  try {
    response = await fetch(RPC_PATH, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(request),
    })
  } catch (error: unknown) {
    throw new SideChatApiError('side-chat/network', messageOf(error))
  }
  if (response.status === 401) throw new SideChatApiError('side-chat/unauthorized', '浏览器会话已失效，请刷新页面。')
  if (response.status === 403) throw new SideChatApiError('side-chat/forbidden', '当前连接无权访问侧聊记录。')
  let envelope: SideChatRpcResult<T>
  try {
    envelope = await response.json() as SideChatRpcResult<T>
  } catch (error: unknown) {
    throw new SideChatApiError('side-chat/bad-response', `Host 返回了无法解析的响应：${messageOf(error)}`)
  }
  if (!envelope.ok) throw new SideChatApiError(envelope.error.code, envelope.error.message)
  return envelope.value
}

export interface SideChatApi {
  load(parentId: string): Promise<PersistedState | null>
  save(parentId: string, state: PersistedState): Promise<void>
  listArchived(): Promise<ArchivedChatSummary[]>
}

/** Browser client for the Side Chat Host record. */
export function createSideChatApi(): SideChatApi {
  return {
    load: (parentId) => rpc<PersistedState | null>({ op: 'load', parentId }),
    save: async (parentId, state) => {
      await rpc<{ saved: true }>({ op: 'save', parentId, state })
    },
    listArchived: () => rpc<ArchivedChatSummary[]>({ op: 'listArchived' }),
  }
}
