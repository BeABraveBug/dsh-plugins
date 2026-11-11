import { mkdirSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { registerIndependentRoutes } from './independent-routes.ts'
import { defaultStorePath } from './paths.ts'
import { IndependentStore } from './independent-store.ts'
import { IndependentService } from './independent-service.ts'

export const name = 'side-chat'

interface HostContext {
  readonly inject: (names: readonly string[], callback: (ctx: any) => void) => unknown
  readonly effect: (effect: () => () => void, label?: string) => unknown
  get(name: string): unknown
}

/** Host half: SQLite-backed independent side chats plus the model gateway. */
export function apply(ctx: HostContext): void {
  const dataDir = dirname(defaultStorePath())
  mkdirSync(dataDir, { recursive: true })
  void rm(defaultStorePath(), { force: true }).catch(() => undefined)

  ctx.inject(['llm', 'agentDefaultModel'], (scope: any) => {
    const store = new IndependentStore(join(dataDir, 'sessions.sqlite'))
    const service = new IndependentService(store, scope.get('llm'), scope.get('agentDefaultModel'))
    scope.effect(() => () => store.close(), 'side-chat: close independent store')
    registerIndependentRoutes(ctx, service)
  })
}
