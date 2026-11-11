import { SideChatStore, SideChatStoreError } from './store.ts'
import type { SideChatRpcRequest, SideChatRpcResult } from '../shared/types.ts'

export const RPC_PATH = '/api/side-chat/rpc'

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
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  })
}

function failure(code: string, message: string): SideChatRpcResult<never> {
  return { ok: false, error: { code, message } }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

async function dispatch(store: SideChatStore, body: unknown): Promise<SideChatRpcResult<unknown>> {
  if (!isRecord(body) || typeof body.op !== 'string') {
    return failure('side-chat/bad-request', '请求格式无效。')
  }
  const request = body as unknown as SideChatRpcRequest
  try {
    if (request.op === 'load') {
      if (typeof request.parentId !== 'string' || request.parentId === '') {
        return failure('side-chat/bad-request', '父会话 ID 无效。')
      }
      return { ok: true, value: await store.load(request.parentId) }
    }
    if (request.op === 'listArchived') {
      return { ok: true, value: await store.listArchived() }
    }
    if (request.op === 'save') {
      if (typeof request.parentId !== 'string' || request.parentId === '' || !isRecord(request.state)) {
        return failure('side-chat/bad-request', '侧聊记录无效。')
      }
      await store.save(request.parentId, request.state)
      return { ok: true, value: { saved: true } }
    }
    return failure('side-chat/bad-request', '未知操作。')
  } catch (error) {
    if (error instanceof SideChatStoreError) return failure(error.code, error.message)
    return failure('side-chat/internal', messageOf(error))
  }
}

/** Register the authenticated Side Chat RPC route on the Host connection. */
export function registerRoutes(ctx: RouteContext, store: SideChatStore): void {
  ctx.inject(['connection'], (injected: any) => {
    const connection = injected.get('connection') as ConnectionFace | undefined
    const register = connection?.fetch?.register
    if (register === undefined) return
    injected.effect(() => register({
      path: RPC_PATH,
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: async (request: Request): Promise<Response> => {
        let body: unknown
        try {
          body = await request.json()
        } catch {
          return json(failure('side-chat/bad-request', '请求体不是有效的 JSON。'), 400)
        }
        return json(await dispatch(store, body))
      },
    }), 'side-chat: rpc route')
  })
}
