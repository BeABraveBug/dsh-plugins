import { cpSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { createRequire, isBuiltin } from 'node:module'
import { defineConfig } from 'tsdown'

const requireFromPackage = createRequire(import.meta.url)

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as {
  name: string
  version: string
}

const PLATFORM_MODULES = new Set(['react', 'react/jsx-runtime', 'react-dom'])
const isPlatformModule = (specifier: string): boolean => PLATFORM_MODULES.has(specifier)

const PDFJS_DIR = dirname(requireFromPackage.resolve('pdfjs-dist/package.json'))
const KATEX_DIR = dirname(requireFromPackage.resolve('katex/package.json'))
const NODE_ENV = process.env.NODE_ENV ?? 'production'
const WATCH = process.env.BOOKSHELF_WATCH === '1'
const CSS_PREFIX = '\0bookshelf-css:'
const CSS_SUFFIX = '.mjs'

function styleModule(id: string, file: string, css: string): string {
  const rewritten = css.replace(/url\(fonts\/([^)]+)\)/g, 'url(/api/bookshelf/katex-font?name=$1)')
  return [
    `const css = ${JSON.stringify(rewritten)};`,
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

function copyKatexAssets(): void {
  const target = resolve('lib/katex/fonts')
  rmSync(resolve('lib/katex'), { recursive: true, force: true })
  mkdirSync(target, { recursive: true })
  cpSync(join(KATEX_DIR, 'dist/fonts'), target, { recursive: true })
}

function copyPdfjsAssets(): void {
  const target = resolve('lib/pdfjs')
  rmSync(target, { recursive: true, force: true })
  mkdirSync(target, { recursive: true })
  cpSync(join(PDFJS_DIR, 'cmaps'), join(target, 'cmaps'), { recursive: true })
  cpSync(join(PDFJS_DIR, 'standard_fonts'), join(target, 'standard_fonts'), { recursive: true })
  cpSync(join(PDFJS_DIR, 'wasm'), join(target, 'wasm'), { recursive: true })
}

function cssChannel(id: string) {
  return {
    name: 'bookshelf-css',
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

function rawChannel() {
  return {
    name: 'bookshelf-raw',
    resolveId(source: string, importer: string | undefined) {
      if (!source.endsWith('?raw')) return null
      const clean = source.slice(0, -'?raw'.length)
      const file = clean.startsWith('.') || clean.startsWith('/')
        ? (importer === undefined ? clean : resolve(dirname(importer), clean))
        : requireFromPackage.resolve(clean)
      return file + '?raw'
    },
    load(id: string) {
      if (!id.endsWith('?raw')) return null
      return `export default ${JSON.stringify(readFileSync(id.slice(0, -'?raw'.length), 'utf8'))};`
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
    onSuccess: () => { copyPdfjsAssets(); copyKatexAssets() },
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
    plugins: [rawChannel(), cssChannel(pkg.name)],
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
  {
    name: `${pkg.name}/standalone`,
    entry: { standalone: 'src/client/standalone.tsx' },
    outDir: 'lib',
    format: ['iife'],
    platform: 'browser',
    target: 'es2022',
    dts: false,
    sourcemap: false,
    clean: false,
    minify: !WATCH,
    define: {
      'process.env': '{}',
      'process.env.NODE_ENV': JSON.stringify(NODE_ENV),
      'import.meta.env.MODE': JSON.stringify(NODE_ENV),
      'import.meta.env': JSON.stringify({ MODE: NODE_ENV }),
    },
    deps: { alwaysBundle: () => true },
    plugins: [rawChannel(), cssChannel(pkg.name)],
    outputOptions: {
      codeSplitting: false,
      comments: { legal: true, annotation: false, jsdoc: false },
      entryFileNames: 'standalone.js',
    },
  },
])

