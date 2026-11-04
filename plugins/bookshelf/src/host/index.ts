import { Library, defaultLibraryPath } from './library.ts'
import { registerRoutes } from './routes.ts'

export const name = 'bookshelf'

interface HostContext {
  readonly inject: (names: readonly string[], callback: (ctx: any) => void) => unknown
  readonly effect: (effect: () => () => void, label?: string) => unknown
  get(name: string): unknown
}

/**
 * Local management half: the only writer of the bookshelf JSON record.
 * The browser half reads records and original files through the authenticated
 * Connection routes registered below.
 */
export function apply(ctx: HostContext): void {
  const library = new Library(defaultLibraryPath())
  registerRoutes(ctx, library)
}
