import { decodeBase64 } from '@litch/core'
import { getDocument, type PDFDocumentProxy, PDFWorker, TextLayer } from 'pdfjs-dist'
import type { PreviewData } from '../contract.ts'
import { LocalPdfData } from './assets.ts'
import { pdfDom } from './dom.ts'
import { type PageSize, PDF_BYTES, PDF_PAGES, PDF_TIMEOUT, validSize } from './policy.ts'

export type PdfFailure = 'invalid' | 'encrypted' | 'pages' | 'size' | 'timeout'
export interface PdfDocument {
  document: PDFDocumentProxy
  sizes: PageSize[]
}
/** 每份文档独占 worker；不使用 PDF.js fake-worker 回退，也不安装 scripting/annotation manager。 */
export function loadPdf(
  data: PreviewData,
  ready: (pdf: PdfDocument) => void,
  fail: (error: PdfFailure) => void,
): () => void {
  if (data.bytes > PDF_BYTES || data.dataBase64.length > Math.ceil(PDF_BYTES / 3) * 4) {
    fail('size')
    return () => {}
  }
  let bytes: Uint8Array
  try {
    bytes = decodeBase64(data.dataBase64)
    if (!bytes.length || bytes.length > PDF_BYTES) throw new Error('Invalid PDF size')
  } catch {
    fail('invalid')
    return () => {}
  }
  const port = new Worker(new URL('./worker.ts', import.meta.url), {
    type: 'module',
    name: 'litch-pdf',
  })
  const worker = PDFWorker.create({ port })
  const dom = pdfDom()
  const loading = getDocument({
    data: bytes,
    worker,
    ownerDocument: dom.ownerDocument,
    BinaryDataFactory: LocalPdfData,
    useWorkerFetch: false,
    useSystemFonts: false,
    enableXfa: false,
    disableAutoFetch: true,
    disableStream: true,
    disableRange: true,
    stopAtErrors: true,
    maxImageSize: 8_000_000,
    canvasMaxAreaInBytes: 16_000_000,
    isOffscreenCanvasSupported: true,
    isImageDecoderSupported: false,
    // v6 已移除 JS eval 画字路径；WASM 只接收上面白名单内的本地编译产物。
    useWasm: true,
    verbosity: 0,
  })
  let closed = false
  const timer = window.setTimeout(() => reject('timeout'), PDF_TIMEOUT)
  function dispose() {
    if (closed) return
    closed = true
    window.clearTimeout(timer)
    // 立即停 worker，不等待损坏文件的解析协程回信。
    void loading.destroy().catch(() => {})
    worker.destroy()
    port.terminate()
    dom.dispose()
    // 子页先 cancel，再清文字层的共享测量缓存；库会保留仍在渲染的其他文档。
    queueMicrotask(() => TextLayer.cleanup())
  }
  function reject(reason: PdfFailure) {
    if (closed) return
    fail(reason)
    dispose()
  }
  loading.onPassword = () => reject('encrypted')
  port.addEventListener('error', () => reject('invalid'))
  void loading.promise
    .then(async (document) => {
      if (closed) return
      if (document.numPages > PDF_PAGES) return reject('pages')
      const sizes: PageSize[] = []
      for (let index = 1; index <= document.numPages; index++) {
        if (closed) return
        const page = await document.getPage(index)
        const viewport = page.getViewport({ scale: 1 })
        if (!validSize(viewport)) return reject('size')
        sizes.push({ width: viewport.width, height: viewport.height })
        page.cleanup()
      }
      if (closed) return
      window.clearTimeout(timer)
      ready({ document, sizes })
    })
    .catch((error: unknown) =>
      reject(
        error instanceof Error && error.name === 'PasswordException' ? 'encrypted' : 'invalid',
      ),
    )
  return dispose
}
