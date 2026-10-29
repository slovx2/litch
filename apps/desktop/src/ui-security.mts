/** meta CSP 不管 Worker；策略必须随 app:// 响应送达执行上下文。 */
export function uiResourcePolicy(path: string): string {
  // PDF Worker 是独立的单文件构建，不需要 import；只有它可以编译随包的解码 WASM。
  if (
    /^\/assets\/pdf-worker-[\w-]+\.js$/.test(path) ||
    path === '/src/files/preview/pdf/pdf-worker.ts'
  )
    return "default-src 'none'; connect-src 'none'; script-src 'wasm-unsafe-eval'; worker-src 'none'"
  // 不额外约束图片/媒体/frame，保持主文档 meta 及 srcdoc 自身的策略生效。
  return "connect-src 'none'; script-src 'self'; worker-src 'self'"
}
