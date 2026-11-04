import * as pdfjsLib from 'pdfjs-dist'
import workerSource from 'pdfjs-dist/build/pdf.worker.min.mjs?raw'
import { PROMISE_POLYFILL_SOURCE } from './polyfills.ts'

let workerPort: Worker | null = null

/** Create the single shared PDF.js worker used by the reader and cover thumbnails. */
export function ensurePdfWorker(): void {
  if (workerPort !== null) return
  const blob = new Blob([PROMISE_POLYFILL_SOURCE, '\n', workerSource], { type: 'text/javascript' })
  const url = URL.createObjectURL(blob)
  workerPort = new Worker(url, { type: 'module' })
  pdfjsLib.GlobalWorkerOptions.workerPort = workerPort
}

export { pdfjsLib }
