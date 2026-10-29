import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import react from '@vitejs/plugin-react'
import { defineConfig, type Plugin } from 'vite'
import { uiResourcePolicy } from '../../apps/desktop/src/ui-security.mts'

// 正式构建不含开发放开项；开发只额外允许 React refresh 的内联前言和本机 HMR 连接。
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "worker-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "font-src 'self'",
  "img-src 'self' data: blob:",
  "connect-src 'none'",
  'media-src blob:',
].join('; ')

const cspOnBuild = (): Plugin => {
  let devConnect = ''
  const pagePolicy = () =>
    devConnect
      ? CSP.replace("script-src 'self'", "script-src 'self' 'unsafe-inline'").replace(
          "connect-src 'none'",
          `connect-src ${devConnect}`,
        )
      : CSP
  return {
    name: 'litch:csp',
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        const path = new URL(request.url ?? '/', 'http://local').pathname
        const address = server.httpServer?.address()
        const port =
          typeof address === 'object' && address ? address.port : server.config.server.port
        devConnect = `http://127.0.0.1:${port} ws://127.0.0.1:${port}`
        const policy = uiResourcePolicy(path)
        response.setHeader(
          'Content-Security-Policy',
          policy.includes('wasm-unsafe-eval')
            ? policy
            : policy
                .replace("script-src 'self'", "script-src 'self' 'unsafe-inline'")
                .replace("connect-src 'none'", `connect-src ${devConnect}`),
        )
        if (path === '/src/files/preview/pdf/pdf-worker.ts') {
          // 开发期也交付单文件 Worker，不能用静态 import 绕过正式 Worker 的禁止导入策略。
          response.setHeader('Content-Type', 'text/javascript')
          response.end(
            readFileSync(
              new URL('./node_modules/pdfjs-dist/build/pdf.worker.min.mjs', import.meta.url),
            ),
          )
        } else next()
      })
    },
    transformIndexHtml: () => [
      {
        tag: 'meta',
        attrs: { 'http-equiv': 'Content-Security-Policy', content: pagePolicy() },
        injectTo: 'head-prepend',
      },
    ],
  }
}

export default defineConfig({
  // 相对路径：桌面外壳用自己的协议从安装目录里取这些文件
  base: './',
  plugins: [react(), cspOnBuild()],
  resolve: {
    alias: {
      '@litch/core': fileURLToPath(new URL('../core/src/index.mts', import.meta.url)),
    },
  },
  server: {
    host: '127.0.0.1',
    port: 5199,
    strictPort: true,
    // 核心包在界面包的目录之外，要显式放行
    fs: { allow: ['..'] },
  },
  preview: { host: '127.0.0.1', port: 5198, strictPort: true },
  build: {
    outDir: 'dist',
    target: 'es2023',
    sourcemap: true,
    // 小文件默认会被内联成 data: 地址，字体的小分片正好中招，而内容安全策略只许字体来自本应用
    assetsInlineLimit: 0,
  },
})
