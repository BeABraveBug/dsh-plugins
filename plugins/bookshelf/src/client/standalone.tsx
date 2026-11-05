import './polyfills.ts'
import { createElement as h } from 'react'
import { createRoot } from 'react-dom/client'
import { createBookshelfApi } from './api.ts'
import { BookshelfApp } from './BookshelfApp.tsx'
import { DICT_EN, DICT_ZH } from './i18n.ts'
import './styles/app.css'
import './standalone.css'

const dictionary = navigator.language.toLowerCase().startsWith('zh') ? DICT_ZH : DICT_EN

function translate(key: string, params?: Record<string, string | number>): string {
  const template = dictionary[key] ?? key
  if (params === undefined) return template
  return template.replace(/\{(\w+)\}/g, (_, name: string) => String(params[name] ?? `{${name}}`))
}

const root = document.getElementById('bookshelf-root')
if (root !== null) {
  createRoot(root).render(h(BookshelfApp, { t: translate, api: createBookshelfApi() }))
}
