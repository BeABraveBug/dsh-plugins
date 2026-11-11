import { registerRoutes } from './routes.ts'
import { SideChatStore } from './store.ts'

export const name = 'side-chat'

interface HostContext {
  readonly inject: (names: readonly string[], callback: (ctx: any) => void) => unknown
  readonly effect: (effect: () => () => void, label?: string) => unknown
  get(name: string): unknown
}

/**
 * Host half of the plugin: the only writer of the side-chat JSON record. The
 * browser half reads and updates the record through the authenticated route.
 */
export function apply(ctx: HostContext): void {
  registerRoutes(ctx, new SideChatStore())
}
