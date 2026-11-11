import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { isBuiltin } from 'node:module'
import { createRequire } from 'node:module'
import { defineConfig } from 'tsdown'

const requireFromPackage = createRequire(import.meta.url)

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as {
  name: string
  version: string
}

const PLATFORM_MODULES = new Set(['react', 'react/jsx-runtime', 'react-dom'])
const isPlatformModule = (specifier: string): boolean => PLATFORM_MODULES.has(specifier)

const NODE_ENV = process.env.NODE_ENV ?? 'production'
const WATCH = process.env.SIDE_CHAT_WATCH === '1'
const CSS_PREFIX = '\0side-chat-css:'
const CSS_SUFFIX = '.mjs'

function styleModule(id: string, file: string, css: string): string {
  return [
    `const css = ${JSON.stringify(css)};`,
    `const tagId = ${JSON.stringify(`${id}/${file}`)};`,
    "if (typeof document !== 'undefined') {",
    "  const selector = 'style[data-plugin-css=' + JSON.stringify(tagId) + ']';",
    '  const existing = document.querySelector(selector);',
    "  const tag = existing ?? document.createElement('style');",
    `  tag.dataset.plugin = ${JSON.stringify(id)};`,
    '  tag.dataset.pluginCss = tagId;',
    '  tag.textContent = css;',
    '  if (existing === null) document.head.appendChild(tag);',
    '}',
    'export {};',
  ].join('\n')
}

function cssChannel(id: string) {
  return {
    name: 'side-chat-css',
    resolveId(source: string, importer: string | undefined) {
      if (!source.endsWith('.css')) return null
      const file = source.startsWith('.') || source.startsWith('/')
        ? (importer === undefined ? source : resolve(dirname(importer), source))
        : requireFromPackage.resolve(source)
      return CSS_PREFIX + file + CSS_SUFFIX
    },
    load(this: { addWatchFile(file: string): void }, virtualId: string) {
      if (!virtualId.startsWith(CSS_PREFIX)) return null
      const file = virtualId.slice(CSS_PREFIX.length, -CSS_SUFFIX.length)
      this.addWatchFile(file)
      return styleModule(id, file, readFileSync(file, 'utf8'))
    },
  }
}

export default defineConfig([
  {
    name: pkg.name,
    entry: { index: 'src/host/index.ts' },
    outDir: 'lib',
    format: ['esm'],
    platform: 'node',
    target: 'es2022',
    fixedExtension: false,
    minify: !WATCH,
    sourcemap: false,
    dts: !WATCH,
    clean: true,
    outputOptions: { comments: { legal: true, annotation: false, jsdoc: false } },
    deps: {
      neverBundle: (specifier: string) => isBuiltin(specifier) || specifier.startsWith('node:'),
    },
  },
  {
    name: `${pkg.name}/client`,
    entry: { client: 'src/client/index.ts' },
    outDir: 'lib',
    format: 'cjs',
    platform: 'browser',
    target: 'es2022',
    dts: false,
    sourcemap: false,
    clean: false,
    minify: !WATCH,
    deps: {
      neverBundle: (specifier: string) => isPlatformModule(specifier),
      alwaysBundle: (specifier: string) => !isPlatformModule(specifier) && !isBuiltin(specifier),
    },
    define: {
      'process.env': '{}',
      'process.env.NODE_ENV': JSON.stringify(NODE_ENV),
      'import.meta.env.MODE': JSON.stringify(NODE_ENV),
      'import.meta.env': JSON.stringify({ MODE: NODE_ENV }),
    },
    plugins: [cssChannel(pkg.name)],
    outputOptions: {
      // DSH loads one registered factory; relative CommonJS chunks are not modules.
      codeSplitting: false,
      comments: { legal: true, annotation: false, jsdoc: false },
      entryFileNames: 'client.js',
      banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(pkg.name)}, factory: (require) => {`,
      intro: 'var module = { exports: {} }; var exports = module.exports;',
      footer: 'return module.exports; } });',
    },
  },
])
