import fs from 'node:fs'
import vm from 'node:vm'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'

// Exercise the built browser factory with DSH's module loader shape and the right
// Sidebar's registration APIs. The stub document covers module initialization and
// style injection; it does not render React output.
const requireFromPackage = createRequire(new URL('../package.json', import.meta.url))
const styles = []
const document = {
  createElement: () => ({ dataset: {}, style: {}, appendChild() {}, setAttribute() {} }),
  querySelector: () => null,
  head: { appendChild: tag => styles.push(tag) },
}
let registration
const window = {
  document,
  __ModuleLoader__: { load: value => { registration = value } },
}
const source = fs.readFileSync(process.argv[2] ?? new URL('../lib/client.js', import.meta.url), 'utf8')
vm.runInNewContext(source, { window, document, console, setTimeout, clearTimeout }, { filename: 'client.js' })

assert.ok(registration, 'The script must register a DSH module factory')
assert.equal(registration.id, 'dsh-side-chat')

const attempts = []
const exports = registration.factory(specifier => {
  attempts.push(specifier)
  if (!['react', 'react/jsx-runtime', 'react-dom'].includes(specifier)) {
    throw new Error(`Unsupported external: ${specifier}`)
  }
  return requireFromPackage(specifier)
})
assert.deepEqual([...new Set(attempts)].sort(), ['react', 'react/jsx-runtime'])
assert.ok(styles.length > 0, 'The entry must install its CSS without external files')
assert.equal(exports.name, 'side-chat')
assert.deepEqual([...exports.inject], ['locale', 'slots', 'sidebarRight', 'sidebarRightTabs', 'sessions', 'uiSession', 'workspaces'])

const dictionaries = new Map()
const tabTypes = []
const slotRegistrations = []
const disposers = []
const sessions = { create: async () => 'session-1', retain: () => { throw new Error('unused') } }
exports.apply({
  effect: run => { disposers.push(run()) },
  locale: {
    register: (namespace, value) => { dictionaries.set(namespace, value); return () => {} },
    bind: namespace => key => dictionaries.get(namespace)?.en[key] ?? key,
  },
  slots: {
    inject: (name, callback) => {
      assert.ok(['sidebar.right.pane.tab', 'shell.overlay', 'conversation.session.header.utilities'].includes(name), name)
      callback()
    },
    register: (registration, component) => {
      slotRegistrations.push({ registration, component })
      return () => {}
    },
  },
  sidebarRightTabs: {
    register: definition => { tabTypes.push(definition); return () => {} },
  },
  sessions,
  workspaces: { list: { getSnapshot: () => ({ items: [] }), subscribe: () => () => {} } },
  uiSession: { sessionStatus: { getSnapshot: () => new Map(), subscribe: () => () => {} } },
  sidebarRight: {
    mounted: { getSnapshot: () => 'parent-session-1', subscribe: () => () => {} },
    openTab: kind => kind,
  },
})
assert.deepEqual([...dictionaries.keys()], ['side-chat'])
assert.equal(dictionaries.get('side-chat').zh['panel.title'], '侧边对话')
assert.equal(dictionaries.get('side-chat').en['panel.title'], 'Side Chat')
assert.equal(disposers.length, 2)

const paneRegistration = slotRegistrations.find(entry => entry.registration.name === 'sidebar.right.pane.tab')
const overlayRegistration = slotRegistrations.find(entry => entry.registration.name === 'shell.overlay')
const launcherRegistration = slotRegistrations.find(entry => entry.registration.name === 'conversation.session.header.utilities')
assert.ok(paneRegistration)
assert.ok(overlayRegistration)
assert.ok(launcherRegistration)
assert.equal(paneRegistration.registration.key, 'dsh-side-chat')
assert.equal(typeof paneRegistration.registration.inject, 'function')
const injected = paneRegistration.registration.inject('parent-session-1')
assert.equal(injected.sessionId, 'parent-session-1')
assert.equal(injected.sessions, sessions)
assert.equal(typeof injected.workspaces.list.getSnapshot, 'function')
assert.equal(typeof injected.uiSession.sessionStatus.getSnapshot, 'function')
assert.equal(typeof injected.api.load, 'function')
assert.equal(typeof injected.api.save, 'function')
assert.equal(typeof injected.hub.deliverQuote, 'function')
assert.equal(injected.t('panel.empty'), 'No side chat yet.')
assert.equal(typeof paneRegistration.component, 'function')
assert.equal(overlayRegistration.registration.id, 'side-chat.selection-quote')
const overlayProps = overlayRegistration.registration.inject()
assert.equal(overlayProps.mounted.getSnapshot(), 'parent-session-1')
assert.equal(typeof overlayProps.hub.deliverQuote, 'function')
assert.equal(overlayProps.t('quote.ask'), 'Ask in side chat')
assert.equal(typeof overlayRegistration.component, 'function')
assert.equal(launcherRegistration.registration.id, 'side-chat.open')
assert.equal(typeof launcherRegistration.registration.inject, 'function')
const launcherProps = launcherRegistration.registration.inject('parent-session-1')
assert.equal(launcherProps.t('panel.title'), 'Side Chat')
assert.equal(typeof launcherProps.open, 'function')
assert.equal(typeof launcherRegistration.component, 'function')

const [tab] = tabTypes
assert.equal(tab.id, 'dsh-side-chat')
assert.equal(tab.kind, 'side-chat')
assert.equal(tab.keepMounted, true)
assert.equal(tab.title(''), 'Side Chat')
assert.equal(tab.guide.length, 1)
assert.equal(tab.guide[0].title(), 'Side Chat')
assert.equal(tab.guide[0].description(), 'Open a side conversation next to the main chat')
assert.equal(typeof tab.guide[0].order, 'number')

console.log(JSON.stringify({ factory: 'PASS', apply: 'PASS', tab: tab.kind, slot: paneRegistration.registration.key, inject: 'PASS' }))
