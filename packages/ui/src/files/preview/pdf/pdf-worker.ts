import 'pdfjs-dist/build/pdf.worker.mjs'

// 正式 app:// 响应 CSP 禁止连接和 import。下面的覆盖只防误用，不是安全边界；开发 Worker 的响应策略相同。
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
