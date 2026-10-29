import { fileURLToPath } from 'node:url'
import react from '@vitejs/plugin-react'
import { defineConfig, type Plugin } from 'vite'

// 内容安全策略只在构建产物里加：开发服务器要往页面里插热更新的内联脚本，加了会被拦
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "font-src 'self'",
  "img-src 'self' data: blob:",
  "connect-src 'none'",
].join('; ')

const cspOnBuild = (): Plugin => ({
  name: 'litch:csp',
  apply: 'build',
  transformIndexHtml: () => [
    {
      tag: 'meta',
      attrs: { 'http-equiv': 'Content-Security-Policy', content: CSP },
      injectTo: 'head-prepend',
    },
  ],
})

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
