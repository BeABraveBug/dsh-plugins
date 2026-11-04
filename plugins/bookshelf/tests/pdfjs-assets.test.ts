import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createPdfAssetHandler } from '../src/host/routes.ts'

const roots: string[] = []

async function assetRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'bookshelf-pdfjs-'))
  roots.push(root)
  await mkdir(join(root, 'cmaps'))
  await mkdir(join(root, 'standard_fonts'))
  await mkdir(join(root, 'wasm'))
  await writeFile(join(root, 'cmaps', 'Test.bcmap'), Buffer.from('cmap'))
  await writeFile(join(root, 'standard_fonts', 'Test.ttf'), Buffer.from('font'))
  await writeFile(join(root, 'wasm', 'jbig2.wasm'), Buffer.from('wasm'))
  return root
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

function request(path: string, method = 'GET'): Request {
  return new Request(`http://localhost${path}`, { method })
}

describe('PDF.js asset route', () => {
  it('serves CMaps, standard fonts, and WASM with their media types', async () => {
    const root = await assetRoot()
    const cmap = await createPdfAssetHandler(root, request('/api/bookshelf/pdfjs?kind=cmap&name=./Test.bcmap'))
    expect(cmap.status).toBe(200)
    expect(cmap.headers.get('content-type')).toBe('application/octet-stream')
    expect(await cmap.text()).toBe('cmap')

    const font = await createPdfAssetHandler(root, request('/api/bookshelf/pdfjs?kind=font&name=./Test.ttf'))
    expect(font.status).toBe(200)
    expect(font.headers.get('content-type')).toBe('font/ttf')

    const wasm = await createPdfAssetHandler(root, request('/api/bookshelf/pdfjs?kind=wasm&name=./jbig2.wasm'))
    expect(wasm.status).toBe(200)
    expect(wasm.headers.get('content-type')).toBe('application/wasm')
    expect(new Uint8Array(await wasm.arrayBuffer())).toEqual(new Uint8Array(Buffer.from('wasm')))
  })

  it('supports HEAD and rejects unknown kinds, traversal, and missing assets', async () => {
    const root = await assetRoot()
    const head = await createPdfAssetHandler(root, request('/api/bookshelf/pdfjs?kind=cmap&name=./Test.bcmap', 'HEAD'))
    expect(head.status).toBe(200)
    expect(head.headers.get('content-length')).toBe('4')
    expect(await head.arrayBuffer()).toEqual(new ArrayBuffer(0))

    expect((await createPdfAssetHandler(root, request('/api/bookshelf/pdfjs?kind=other&name=./Test.bcmap'))).status).toBe(400)
    expect((await createPdfAssetHandler(root, request('/api/bookshelf/pdfjs?kind=cmap&name=../secret.bcmap'))).status).toBe(400)
    expect((await createPdfAssetHandler(root, request('/api/bookshelf/pdfjs?kind=cmap&name=./missing.bcmap'))).status).toBe(404)
  })
})
