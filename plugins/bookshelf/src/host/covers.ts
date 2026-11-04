import { execFile } from 'node:child_process'
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, extname, join, posix } from 'node:path'
import { promisify } from 'node:util'
import JSZip from 'jszip'
import type { BookRecord } from '../shared/types.ts'

const MAX_COVER_BYTES = 10 * 1024 * 1024
const MAX_CACHE_ENTRIES = 32
const QUICK_LOOK_TIMEOUT_MS = 15000
const QUICK_LOOK_CONCURRENCY = 2
const execFileAsync = promisify(execFile)
const SIDECAR_EXTENSIONS = ['jpg', 'jpeg', 'png', 'webp', 'gif', 'svg', 'avif', 'bmp'] as const

/** One cover image and its media type. */
export interface CoverResult {
  readonly bytes: Uint8Array
  readonly contentType: string
}

interface CacheEntry {
  readonly stamp: string
  readonly result: CoverResult | null
}

const cache = new Map<string, CacheEntry>()
let activeQuickLook = 0
const waitingQuickLook: Array<() => void> = []

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object'
}

function contentTypeFor(filePath: string): string {
  switch (extname(filePath).toLowerCase()) {
    case '.jpg':
    case '.jpeg': return 'image/jpeg'
    case '.png': return 'image/png'
    case '.webp': return 'image/webp'
    case '.gif': return 'image/gif'
    case '.svg': return 'image/svg+xml'
    case '.avif': return 'image/avif'
    case '.bmp': return 'image/bmp'
    default: return 'application/octet-stream'
  }
}

function isImagePath(filePath: string): boolean {
  return contentTypeFor(filePath).startsWith('image/')
}

function stripQueryAndFragment(value: string): string {
  return value.split('#')[0]?.split('?')[0] ?? ''
}

function resolveArchivePath(baseFile: string, href: string): string | null {
  const clean = stripQueryAndFragment(href).trim()
  if (clean === '' || clean.startsWith('/') || /^[a-z][a-z0-9+.-]*:/i.test(clean) || clean.startsWith('//')) return null
  let decoded: string
  try { decoded = decodeURIComponent(clean) } catch { decoded = clean }
  const base = posix.dirname(baseFile)
  const joined = posix.normalize(base === '.' ? decoded : `${base}/${decoded}`)
  if (joined === '..' || joined.startsWith('../') || joined.startsWith('/')) return null
  return joined
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function attrInTag(tag: string, name: string): string | null {
  const pattern = new RegExp(`\\b${escapeRegExp(name)}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, 'i')
  const match = pattern.exec(tag)
  return match === null ? null : match[1] ?? match[2] ?? null
}

function tagsOf(xml: string, tag: string): string[] {
  return xml.match(new RegExp(`<(?:[A-Za-z_][\\w.-]*:)?${tag}\\b[^>]*>`, 'gi')) ?? []
}

function decodeEntities(value: string): string {
  return value
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
}

interface ManifestItem {
  readonly id: string | null
  readonly href: string | null
  readonly mediaType: string | null
  readonly properties: string | null
}

function manifestOf(opf: string): ManifestItem[] {
  return tagsOf(opf, 'item').map((tag) => ({
    id: attrInTag(tag, 'id'),
    href: attrInTag(tag, 'href'),
    mediaType: attrInTag(tag, 'media-type'),
    properties: attrInTag(tag, 'properties'),
  })).filter((item) => item.href !== null)
}

function customMediaType(item: ManifestItem | undefined): string | null {
  const value = item?.mediaType?.toLowerCase() ?? ''
  if (value === 'image/jpg') return 'image/jpeg'
  return value.startsWith('image/') ? value : null
}

class EpubArchive {
  constructor(private readonly zip: JSZip) {}

  private findEntry(name: string): JSZip.JSZipObject | null {
    const normalized = posix.normalize(name.replace(/^\.\//, ''))
    const direct = this.zip.file(normalized)
    if (direct !== null) return direct
    const lower = normalized.toLowerCase()
    for (const [key, entry] of Object.entries(this.zip.files)) {
      if (!entry.dir && key.toLowerCase() === lower) return entry
    }
    return null
  }

  async text(name: string): Promise<string | null> {
    const entry = this.findEntry(name)
    if (entry === null) return null
    try { return decodeEntities(await entry.async('string')) } catch { return null }
  }

  async bytes(name: string): Promise<{ bytes: Uint8Array; contentType: string } | null> {
    const entry = this.findEntry(name)
    if (entry === null) return null
    try {
      const bytes = await entry.async('uint8array')
      if (bytes.byteLength === 0 || bytes.byteLength > MAX_COVER_BYTES) return null
      return { bytes, contentType: contentTypeFor(name) }
    } catch {
      return null
    }
  }

  has(name: string): boolean {
    return this.findEntry(name) !== null
  }

  names(): string[] {
    return Object.keys(this.zip.files).filter((name) => this.zip.files[name]?.dir !== true)
  }
}

async function coverFromArchive(archive: EpubArchive): Promise<CoverResult | null> {
  const container = await archive.text('META-INF/container.xml')
  let opfPath: string | null = null
  if (container !== null) {
    const rootfile = tagsOf(container, 'rootfile')[0]
    const fullPath = rootfile === undefined ? null : attrInTag(rootfile, 'full-path')
    if (fullPath !== null && fullPath.trim() !== '') opfPath = resolveArchivePath('', fullPath)
  }
  if (opfPath === null) {
    opfPath = archive.names().find((name) => name.toLowerCase().endsWith('.opf')) ?? null
    if (opfPath !== null) opfPath = posix.normalize(opfPath)
  }
  if (opfPath === null) return null
  const opf = await archive.text(opfPath)
  if (opf === null) return null
  const items = manifestOf(opf)
  const byId = new Map<string, ManifestItem>()
  for (const item of items) if (item.id !== null) byId.set(item.id, item)

  const candidates: ManifestItem[] = []
  const coverImage = items.find((item) => item.properties?.split(/\s+/).some((value) => value.toLowerCase() === 'cover-image') ?? false)
  if (coverImage !== undefined) candidates.push(coverImage)

  const metaCover = tagsOf(opf, 'meta').find((tag) => attrInTag(tag, 'name')?.toLowerCase() === 'cover')
  const metaCoverId = metaCover === undefined ? null : attrInTag(metaCover, 'content')
  if (metaCoverId !== null) {
    const item = byId.get(metaCoverId)
    if (item !== undefined) candidates.push(item)
  }

  const guideCover = tagsOf(opf, 'reference').find((tag) => attrInTag(tag, 'type')?.toLowerCase() === 'cover')
  const guideHref = guideCover === undefined ? null : attrInTag(guideCover, 'href')
  if (guideHref !== null) {
    const pagePath = resolveArchivePath(opfPath, guideHref)
    if (pagePath !== null) {
      if (isImagePath(pagePath)) {
        const direct = await archive.bytes(pagePath)
        if (direct !== null) return direct
      } else if (archive.has(pagePath)) {
        const page = await archive.text(pagePath)
        if (page !== null) {
          const img = tagsOf(page, 'img')[0] ?? tagsOf(page, 'image')[0]
          const src = img === undefined ? null : attrInTag(img, 'src') ?? attrInTag(img, 'href') ?? attrInTag(img, 'xlink:href')
          if (src !== null) {
            const imagePath = resolveArchivePath(pagePath, src)
            if (imagePath !== null) {
              const image = await archive.bytes(imagePath)
              if (image !== null) return image
            }
          }
        }
      }
    }
  }

  const inferred = items.find((item) => isImagePath(item.href ?? '') && /cover/i.test(`${item.id ?? ''} ${item.href ?? ''}`))
  if (inferred !== undefined) candidates.push(inferred)

  for (const item of candidates) {
    if (item.href === null) continue
    const itemPath = resolveArchivePath(opfPath, item.href)
    if (itemPath === null) continue
    const declared = customMediaType(item)
    if (declared === null && !isImagePath(itemPath)) continue
    const image = await archive.bytes(itemPath)
    if (image === null) continue
    return declared === null ? image : { ...image, contentType: declared }
  }
  return null
}

async function epubCover(filePath: string): Promise<CoverResult | null> {
  let data: Buffer
  try { data = await readFile(filePath) } catch { return null }
  try {
    const zip = await JSZip.loadAsync(data)
    return await coverFromArchive(new EpubArchive(zip))
  } catch {
    return null
  }
}

async function sidecarCover(filePath: string): Promise<CoverResult | null> {
  const directory = dirname(filePath)
  const base = basename(filePath, extname(filePath))
  let names: string[]
  try { names = await readdir(directory) } catch { return null }
  const existing = new Map(names.map((name) => [name.toLowerCase(), name]))
  const candidates: string[] = []
  for (const extension of SIDECAR_EXTENSIONS) {
    candidates.push(`${base}.cover.${extension}`)
    candidates.push(`${base}.${extension}`)
  }
  for (const candidate of candidates) {
    const actual = existing.get(candidate.toLowerCase())
    if (actual === undefined) continue
    const candidatePath = join(directory, actual)
    try {
      const info = await stat(candidatePath)
      if (!info.isFile() || info.size === 0 || info.size > MAX_COVER_BYTES) continue
      const bytes = new Uint8Array(await readFile(candidatePath))
      if (bytes.byteLength === 0) continue
      return { bytes, contentType: contentTypeFor(actual) }
    } catch {
      // Try the next candidate.
    }
  }
  return null
}


async function withQuickLookSlot<T>(task: () => Promise<T>): Promise<T> {
  if (activeQuickLook >= QUICK_LOOK_CONCURRENCY) {
    await new Promise<void>((resolve) => waitingQuickLook.push(resolve))
  }
  activeQuickLook += 1
  try {
    return await task()
  } finally {
    activeQuickLook = Math.max(0, activeQuickLook - 1)
    const next = waitingQuickLook.shift()
    if (next !== undefined) next()
  }
}

/** macOS Quick Look first-page thumbnail; other platforms fall back to the browser PDF.js cover. */
async function quickLookCover(filePath: string): Promise<CoverResult | null> {
  if (process.platform !== 'darwin') return null
  return withQuickLookSlot(async () => {
    let directory: string | null = null
    try {
      directory = await mkdtemp(join(tmpdir(), 'bookshelf-ql-'))
      await execFileAsync('qlmanage', ['-t', '-s', '400', '-o', directory, filePath], {
        timeout: QUICK_LOOK_TIMEOUT_MS,
        maxBuffer: 1024 * 1024,
      })
      const names = await readdir(directory)
      const thumbnail = names.find((name) => name.toLowerCase().endsWith('.png'))
      if (thumbnail === undefined) return null
      const target = join(directory, thumbnail)
      const info = await stat(target)
      if (!info.isFile() || info.size === 0 || info.size > MAX_COVER_BYTES) return null
      return { bytes: new Uint8Array(await readFile(target)), contentType: 'image/png' }
    } catch {
      return null
    } finally {
      if (directory !== null) await rm(directory, { recursive: true, force: true }).catch(() => {})
    }
  })
}

function storeCover(bookId: string, stamp: string, result: CoverResult): CoverResult {
  if (result.bytes.byteLength > MAX_COVER_BYTES) return result
  cache.set(bookId, { stamp, result })
  while (cache.size > MAX_CACHE_ENTRIES) {
    const oldest = cache.keys().next().value
    if (oldest === undefined) break
    cache.delete(oldest)
  }
  return result
}

/** Resolve the optional cover of one recorded book. Never writes or copies the original book. */
export async function coverForBook(book: BookRecord): Promise<CoverResult | null> {
  let stamp: string
  try {
    const info = await stat(book.path)
    stamp = `${info.size}:${info.mtimeMs}`
  } catch {
    stamp = 'missing'
  }
  const cached = cache.get(book.id)
  if (cached !== undefined && cached.stamp === stamp) return cached.result

  if (book.format === 'epub') {
    const embedded = await epubCover(book.path)
    if (embedded !== null) return storeCover(book.id, stamp, embedded)
  }
  // Sidecars are read on demand: adding or replacing one should show up without
  // waiting for the book file's own timestamp to change.
  const sidecar = await sidecarCover(book.path)
  if (sidecar !== null) return sidecar
  if (book.format === 'pdf') {
    const quickLook = await quickLookCover(book.path)
    if (quickLook !== null) return storeCover(book.id, stamp, quickLook)
  }
  return null
}
