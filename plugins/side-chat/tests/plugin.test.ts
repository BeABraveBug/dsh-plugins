import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { apply, name } from '../src/host/index.ts'

const root = new URL('..', import.meta.url)
const readJson = (path: string): Record<string, any> =>
  JSON.parse(readFileSync(new URL(path, root), 'utf8'))

describe('plugin manifest', () => {
  const pkg = readJson('package.json')

  it('names the host entry and declares both halves', () => {
    expect(name).toBe('side-chat')
    expect(pkg.name).toBe('dsh-side-chat')
    expect(pkg.main).toBe('lib/index.js')
    expect(pkg.exports['.'].default).toBe('./lib/index.js')
    expect(pkg.exports['./client']).toBe('./lib/client.js')
    expect(pkg.dsh.bundle.patch).toBe('./cordis.patch.yml')
    expect(pkg.dsh.client.platform).toBe('web')
    expect(pkg.dsh.client.inject).toEqual([
      '@deepseek-ai/dsh-api-session-controller',
      '@deepseek-ai/dsh-api-workspace-controller',
      '@deepseek-ai/dsh-client-locale',
      '@deepseek-ai/dsh-client-ui-session',
      '@deepseek-ai/dsh-client-ui-sidebar-right',
    ])
  })

  it('ships every file the runtime loads', () => {
    const files: string[] = pkg.files
    for (const expected of ['lib/index.js', 'lib/index.d.ts', 'lib/client.js', 'cordis.patch.yml', 'README.md', 'icon.svg']) {
      expect(files).toContain(expected)
    }
  })
})

describe('host entry', () => {
  it('waits for the connection and registers the side-chat route', () => {
    const routes: any[] = []
    const injected: string[] = []
    expect(apply({
      inject: (names, callback) => {
        injected.push(...names)
        callback({
          get: (name: string) => name === 'connection'
            ? { fetch: { register: (route: any) => { routes.push(route); return () => {} } } }
            : undefined,
          effect: (run: () => () => void) => run(),
        })
        return undefined
      },
      effect: (run) => run(),
      get: () => undefined,
    })).toBeUndefined()
    expect(injected).toEqual(['llm', 'agentDefaultModel', 'connection'])
    expect(routes.map(route => route.path)).toEqual(['/api/side-chat/independent'])
    expect(routes[0].methods).toEqual(['POST'])
  })
})

describe('locale resources', () => {
  it('describes the plugin in both languages', () => {
    const zh = readJson('locale/zh.json')
    const en = readJson('locale/en.json')
    expect(Object.keys(zh)).toEqual(Object.keys(en))
    for (const dictionary of [zh, en]) {
      expect(typeof dictionary.meta.title).toBe('string')
      expect(dictionary.meta.title.length).toBeGreaterThan(0)
      expect(typeof dictionary.meta.description).toBe('string')
      expect(dictionary.meta.description.length).toBeGreaterThan(0)
    }
  })
})
