import { createSideChatApi } from './api.ts'
import { SideChatHub } from './hub.ts'
import { DICT_EN, DICT_ZH, NAMESPACE } from './i18n.ts'
import { OpenSideChatButton } from './OpenSideChatButton.tsx'
import { SelectionQuoteLayer } from './SelectionQuoteLayer.tsx'
import type { Translate } from './i18n.ts'
import type { SessionsServiceLike, UiSessionServiceLike, WorkspacesServiceLike } from './host-api.ts'
import { SideChatPane } from './SideChatPane.tsx'
import './styles/panel.css'

export const name = 'side-chat'
export const inject = ['locale', 'slots', 'sidebarRight', 'sidebarRightTabs', 'sessions', 'uiSession', 'workspaces']

/** Stable identity of this plugin's single right-sidebar tab type. */
export const TAB_ID = 'dsh-side-chat'
/** Kind other plugins and shortcuts use to open the Side Chat page. */
export const TAB_KIND = 'side-chat'

interface ClientContext {
  readonly slots: {
    inject(name: string, callback: () => unknown): unknown
    register(registration: Record<string, unknown>, component: (props: any) => unknown): unknown
  }
  readonly locale: {
    register(namespace: string, dictionaries: { zh: Record<string, string>; en: Record<string, string> }): () => void
    bind(namespace: string): Translate
  }
  readonly sidebarRightTabs: {
    register(definition: {
      id: string
      kind: string
      keepMounted?: boolean
      title: (address: string) => string
      guide?: readonly {
        id: string
        order: number
        title: () => string
        description?: () => string
      }[]
    }): () => void
  }
  readonly sessions: SessionsServiceLike
  readonly workspaces: WorkspacesServiceLike
  readonly uiSession: UiSessionServiceLike
  readonly sidebarRight: {
    readonly mounted: { getSnapshot(): string | undefined; subscribe(listener: () => void): () => void }
    openTab(kind: string): unknown
  }
  readonly effect: (effect: () => () => void, label?: string) => unknown
}

/**
 * Browser half of the plugin. Registers one right-sidebar tab type and a body
 * that binds its own real Sessions as side chats.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NAMESPACE, { zh: DICT_ZH, en: DICT_EN }), 'side-chat: dictionaries')
  const t = ctx.locale.bind(NAMESPACE)
  const api = createSideChatApi()
  let counter = 0
  const hub = new SideChatHub({
    createId: () => `chat-${Date.now().toString(36)}-${(counter += 1)}`,
    now: () => Date.now(),
  })

  ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register(
    {
      name: 'sidebar.right.pane.tab',
      key: TAB_ID,
      inject: (sessionId: string) => ({ sessionId, t, sessions: ctx.sessions, workspaces: ctx.workspaces, uiSession: ctx.uiSession, api, hub }),
    },
    SideChatPane,
  ))

  ctx.slots.inject('conversation.session.header.utilities', () => ctx.slots.register(
    {
      name: 'conversation.session.header.utilities',
      id: 'side-chat.open',
      order: 20,
      locale: NAMESPACE,
      inject: () => ({
        t,
        open: () => {
          try {
            ctx.sidebarRight.openTab(TAB_KIND)
          } catch {
            // Opening can fail while the layout is disposing.
          }
        },
      }),
    },
    OpenSideChatButton,
  ))

  ctx.slots.inject('shell.overlay', () => ctx.slots.register(
    {
      name: 'shell.overlay',
      id: 'side-chat.selection-quote',
      locale: NAMESPACE,
      inject: () => ({
        t,
        hub,
        mounted: ctx.sidebarRight.mounted,
        openSideChat: () => {
          try {
            ctx.sidebarRight.openTab(TAB_KIND)
          } catch {
            // Opening can fail while the layout is disposing; the quote stays pending.
          }
        },
      }),
    },
    SelectionQuoteLayer,
  ))

  ctx.effect(() => ctx.sidebarRightTabs.register({
    id: TAB_ID,
    kind: TAB_KIND,
    keepMounted: true,
    title: () => t('panel.title'),
    guide: [{
      id: 'open',
      order: 10,
      title: () => t('panel.title'),
      description: () => t('panel.guide'),
    }],
  }), 'side-chat: tab type')
}
