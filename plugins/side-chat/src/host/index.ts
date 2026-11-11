import { mkdirSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { registerRoutes } from './routes.ts'
import { registerIndependentRoutes } from './independent-routes.ts'
import { SideChatStore, defaultStorePath } from './store.ts'
import { IndependentStore } from './independent-store.ts'
import { IndependentService } from './independent-service.ts'

export const name = 'side-chat'

interface HostContext {
  readonly inject: (names: readonly string[], callback: (ctx: any) => void) => unknown
  readonly effect: (effect: () => () => void, label?: string) => unknown
  get(name: string): unknown
}

/**
 * Host half of the plugin. Independent SQLite sessions are authoritative; the
 * legacy JSON record is only kept for the old client while it is being replaced.
 */
export function apply(ctx: HostContext): void {
  const legacyPath = defaultStorePath()
  const dataDir = dirname(legacyPath)
  mkdirSync(dataDir, { recursive: true })
  void rm(legacyPath, { force: true }).catch(() => undefined)
  registerRoutes(ctx, new SideChatStore(legacyPath))

  ctx.inject(['llm', 'agentDefaultModel'], (scope: any) => {
    const store = new IndependentStore(join(dataDir, 'sessions.sqlite'))
    const service = new IndependentService(store, scope.get('llm'), scope.get('agentDefaultModel'))
    scope.effect(() => () => store.close(), 'side-chat: close independent store')
    registerIndependentRoutes(ctx, service)
  })
}
