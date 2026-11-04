import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import JSZip from 'jszip'
import { afterEach, describe, expect, it } from 'vitest'
import { Library } from '../src/host/library.ts'
import { coverForBook } from '../src/host/covers.ts'
import { createCoverHandler } from '../src/host/routes.ts'

const roots: string[] = []
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64')

async function workspace(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'bookshelf-cover-'))
  roots.push(root)
  return root
}

async function recordFor(root: string, name: string, content: string | Buffer): Promise<{ library: Library; path: string; id: string }> {
  const path = join(root, name)
  await writeFile(path, content)
  const library = new Library(join(root, 'library.json'))
  const added = await library.addPaths([path])
  return { library, path, id: added.added[0]!.id }
}

async function epub(root: string, name: string, opf: string, extra: Record<string, Buffer>, opfPath = 'OEBPS/content.opf'): Promise<string> {
  const path = join(root, name)
  const zip = new JSZip()
  zip.file('mimetype', 'application/epub+zip')
  zip.file('META-INF/container.xml', `<?xml version="1.0"?><container><rootfiles><rootfile full-path="${opfPath}" media-type="application/oebps-package+xml"/></rootfiles></container>`)
  zip.file(opfPath, opf)
  for (const [entryPath, bytes] of Object.entries(extra)) zip.file(entryPath, bytes)
  await writeFile(path, await zip.generateAsync({ type: 'nodebuffer' }))
  return path
}

function opf3(): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>Cover</dc:title></metadata>
  <manifest>
    <item id="cover" href="images/cover.png" media-type="image/png" properties="cover-image"/>
    <item id="c1" href="text/ch1.xhtml" media-type="application/xhtml+xml"/>
  </manifest>
  <spine><itemref idref="c1"/></spine>
</package>`
}

function opf2(): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="2.0">
  <metadata><meta name="cover" content="cover-id"/></metadata>
  <manifest>
    <item id="cover-id" href="images/cover.png" media-type="image/png"/>
  </manifest>
  <spine/>
</package>`
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('coverForBook', () => {
  it('extracts an EPUB 3 cover-image', async () => {
    const root = await workspace()
    const path = await epub(root, 'cover.epub', opf3(), { 'OEBPS/images/cover.png': PNG, 'OEBPS/text/ch1.xhtml': Buffer.from('<html><body>Hello</body></html>') })
    const record = (await new Library(join(root, 'library.json')).addPaths([path])).added[0]!
    const cover = await coverForBook(record)
    expect(cover?.contentType).toBe('image/png')
    expect(cover?.bytes).toEqual(new Uint8Array(PNG))
  })

  it('extracts an EPUB 2 meta cover reference', async () => {
    const root = await workspace()
    const path = await epub(root, 'cover2.epub', opf2(), { 'OEBPS/images/cover.png': PNG })
    const record = (await new Library(join(root, 'library.json')).addPaths([path])).added[0]!
    const cover = await coverForBook(record)
    expect(cover?.contentType).toBe('image/png')
    expect(cover?.bytes.byteLength).toBe(PNG.byteLength)
  })

  it('uses a sidecar image for TXT and PDF books', async () => {
    const root = await workspace()
    const txt = await recordFor(root, 'notes.txt', 'hello')
    await writeFile(join(root, 'notes.cover.png'), PNG)
    const txtCover = await coverForBook((await txt.library.find(txt.id))!)
    expect(txtCover?.contentType).toBe('image/png')

    const pdf = await recordFor(root, 'paper.pdf', '%PDF-1.4\n')
    await writeFile(join(root, 'paper.jpg'), PNG)
    const pdfCover = await coverForBook((await pdf.library.find(pdf.id))!)
    expect(pdfCover?.contentType).toBe('image/jpeg')
  })

  it('returns null when a book has no embedded or sidecar cover', async () => {
    const root = await workspace()
    const record = await recordFor(root, 'plain.txt', 'hello')
    expect(await coverForBook((await record.library.find(record.id))!)).toBeNull()
  })

  it('returns null for an unreadable EPUB instead of failing the shelf', async () => {
    const root = await workspace()
    const record = await recordFor(root, 'broken.epub', 'not a zip')
    expect(await coverForBook((await record.library.find(record.id))!)).toBeNull()
  })
})

describe('cover route', () => {
  it('serves the cover bytes and supports HEAD', async () => {
    const root = await workspace()
    const path = await epub(root, 'cover.epub', opf3(), { 'OEBPS/images/cover.png': PNG })
    const library = new Library(join(root, 'library.json'))
    const id = (await library.addPaths([path])).added[0]!.id
    const response = await createCoverHandler(library, new Request(`http://localhost/api/bookshelf/cover?id=${id}`))
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('image/png')
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(new Uint8Array(PNG))
    const head = await createCoverHandler(library, new Request(`http://localhost/api/bookshelf/cover?id=${id}`, { method: 'HEAD' }))
    expect(head.status).toBe(200)
    expect(head.headers.get('content-length')).toBe(String(PNG.byteLength))
    expect(await head.arrayBuffer()).toEqual(new ArrayBuffer(0))
  })

  it('returns 204 when there is no cover and 400 without an id', async () => {
    const root = await workspace()
    const record = await recordFor(root, 'plain.txt', 'hello')
    const missing = await createCoverHandler(record.library, new Request(`http://localhost/api/bookshelf/cover?id=${record.id}`))
    expect(missing.status).toBe(204)
    const bad = await createCoverHandler(record.library, new Request('http://localhost/api/bookshelf/cover'))
    expect(bad.status).toBe(400)
  })
})
