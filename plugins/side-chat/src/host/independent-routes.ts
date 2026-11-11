import type { IndependentRpcRequest, ModelChoice } from '../shared/independent.ts'
import type { IndependentService } from './independent-service.ts'

export const INDEPENDENT_RPC_PATH = '/api/side-chat/independent'

interface FetchRoute {
  readonly path: string
  readonly methods: readonly ('GET' | 'HEAD' | 'POST')[]
  readonly requestBody: 'buffered' | 'streaming'
  readonly fetch: (request: Request) => Promise<Response>
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

async function dispatch(service: IndependentService, body: unknown): Promise<unknown> {
  if (!isRecord(body) || typeof body.op !== 'string') throw new Error('side-chat/bad-request')
  const request = body as unknown as IndependentRpcRequest
  switch (request.op) {
    case 'ind.list': return service.list(request.parentId)
    case 'ind.create': return service.create(request.parentId, request.title)
    case 'ind.get': return service.get(request.chatId)
    case 'ind.draft': service.draft(request.chatId, request.text); return { ok: true }
    case 'ind.quoteAdd': service.addQuote(request.chatId, request.quote); return { ok: true }
    case 'ind.quoteRemove': service.removeQuote(request.chatId, request.quoteId); return { ok: true }
    case 'ind.quotesClear': service.clearQuotes(request.chatId); return { ok: true }
    case 'ind.active': service.setActive(request.parentId, request.chatId); return { ok: true }
    case 'ind.status': service.setStatus(request.chatId, request.status, request.reason); return { ok: true }
    case 'ind.model': service.setModel(request.chatId, request.model); return { ok: true }
    case 'ind.send': return service.send(request.chatId, request)
    case 'ind.delete': service.delete(request.chatId); return { ok: true }
    case 'ind.archived': return service.archived()
    case 'ind.models': return service.models()
    default: throw new Error('side-chat/bad-request')
  }
}

export function registerIndependentRoutes(ctx: RouteContext, service: IndependentService): void {
  ctx.inject(['connection'], (injected: any) => {
    const connection = injected.get('connection') as { fetch?: { register(route: FetchRoute): () => void } } | undefined
    const register = connection?.fetch?.register
    if (register === undefined) return
    injected.effect(() => register({
      path: INDEPENDENT_RPC_PATH,
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: async (request: Request): Promise<Response> => {
        let body: unknown
        try {
          body = await request.json()
        } catch {
          return json({ ok: false, error: { code: 'side-chat/bad-request', message: '请求体不是有效的 JSON。' } }, 400)
        }
        try {
          return json({ ok: true, value: await dispatch(service, body) })
        } catch (error) {
          return json({ ok: false, error: { code: 'side-chat/internal', message: error instanceof Error ? error.message : String(error) } })
        }
      },
    }), 'side-chat: independent rpc route')
  })
}
