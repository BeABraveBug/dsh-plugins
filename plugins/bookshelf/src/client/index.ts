import './polyfills.ts'
import { createElement as h } from 'react'
import { createBookshelfApi } from './api.ts'
import { BookshelfApp } from './BookshelfApp.tsx'
import { DICT_EN, DICT_ZH, NAMESPACE } from './i18n.ts'
import { BookshelfIcon } from './icons.tsx'
import './styles/app.css'

export const name = 'bookshelf'
export const inject = ['slots', 'locale']

const PANEL_ID = 'bookshelf'

interface ClientContext {
  readonly slots: {
    inject(name: string, callback: () => unknown): unknown
    register(registration: Record<string, unknown>, component: (props: any) => unknown): unknown
  }
  readonly locale: {
    register(namespace: string, dictionaries: { zh: Record<string, string>; en: Record<string, string> }): () => void
    bind(namespace: string): (key: string, params?: Record<string, string | number>) => string
  }
  readonly effect: (effect: () => () => void, label?: string) => unknown
}

export function apply(ctx: ClientContext): void {
  const api = createBookshelfApi()
  ctx.effect(() => ctx.locale.register(NAMESPACE, { zh: DICT_ZH, en: DICT_EN }), 'bookshelf: dictionaries')
  const t = ctx.locale.bind(NAMESPACE)

  ctx.slots.inject('main', () => ctx.slots.register(
    { name: 'main', key: PANEL_ID, locale: NAMESPACE },
    () => h(BookshelfApp, { t, api }),
  ))

  ctx.slots.inject('sidebar.panellist', () => ctx.slots.register(
    { name: 'sidebar.panellist', id: PANEL_ID, order: 30, locale: NAMESPACE, label: () => t('panel') },
    (props: { size?: number }) => h(BookshelfIcon, { size: props.size ?? 20 }),
  ))
}
