import 'pdfjs-dist/build/pdf.worker.mjs'

// PDF 字节和库资源由主线程传入；即使解析库走到备用加载路径，也不准访问网络。
globalThis.fetch = async () => {
  throw new Error('PDF worker network is disabled')
}
Object.defineProperty(globalThis, 'XMLHttpRequest', {
  value: class {
    constructor() {
      throw new Error('PDF worker network is disabled')
    }
  },
})
