import fs from 'node:fs'
import vm from 'node:vm'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { webcrypto } from 'node:crypto'

// Exercise the built factory with DSH's platform seeds. The minimal DOM supports
// module initialization and style injection; it does not test rendering or layout.
const requireFromPackage = createRequire(new URL('../package.json', import.meta.url))
const injectedStyles = []
const document = {
  compatMode: 'CSS1Compat',
  createElement: () => ({ dataset: {}, style: {}, appendChild() {}, setAttribute() {} }),
  querySelector: () => null,
  head: { appendChild: tag => injectedStyles.push(tag) },
  documentElement: { style: {} },
  addEventListener() {},
}
let factory
const window = {
  document,
  __ModuleLoader__: {
    load: registration => {
      assert.equal(registration.id, 'dsh-bookshelf')
      factory = registration.factory
    },
  },
  matchMedia: () => ({ matches: false, addEventListener() {} }),
  addEventListener() {},
}
const source = fs.readFileSync(process.argv[2] ?? new URL('../lib/client.js', import.meta.url), 'utf8')
vm.runInNewContext(source, {
  window, document, navigator: { language: 'zh-CN', userAgent: 'Chromium' },
  console, URL, URLSearchParams, TextEncoder, TextDecoder, AbortController,
  setTimeout, clearTimeout, performance, crypto: webcrypto,
  DOMMatrix: class {}, Path2D: class {}, atob, btoa, Response, ReadableStream, structuredClone,
}, { filename: 'client.js' })
assert.equal(typeof factory, 'function', 'The script must register a DSH module factory')
const attempts = []
const unsupported = []
const exports = factory(specifier => {
  attempts.push(specifier)
  if (!['react', 'react/jsx-runtime', 'react-dom'].includes(specifier)) {
    unsupported.push(specifier)
    throw new Error(`Unsupported external: ${specifier}`)
  }
  return requireFromPackage(specifier)
})
assert.deepEqual(unsupported.filter(specifier => specifier.startsWith('.')), [])
assert.equal(typeof exports.apply, 'function')
const registrations = []
exports.apply({
  effect: run => run(),
  locale: { register: () => () => {}, bind: () => key => key },
  slots: { inject: (_, callback) => callback(), register: registration => registrations.push(registration) },
})
assert.deepEqual(registrations.map(registration => registration.name), ['main', 'sidebar.panellist'])
assert.ok(injectedStyles.length > 0, 'The entry must install its CSS without external files')
console.log(JSON.stringify({
  factory: 'PASS', apply: 'PASS', slots: registrations.map(registration => registration.name),
  styleTags: injectedStyles.length, attempts, unsupportedOptional: unsupported,
}))
