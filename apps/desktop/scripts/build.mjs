// 把外壳的三个入口各打成一个文件：主进程、承载核心的工具进程、预加载脚本。
// 界面不在这里打包，它由 packages/ui 自己构建，外壳运行时从那边的产物目录里取。
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const here = (path) => fileURLToPath(new URL(path, import.meta.url))

const common = {
  bundle: true,
  platform: 'node',
  target: 'node22',
  sourcemap: true,
  // ws 的这两个是可选的原生加速模块，没装也能跑，不打进来
  external: ['electron', 'bufferutil', 'utf-8-validate'],
  logLevel: 'warning',
  absWorkingDir: here('..'),
  alias: { '@litch/core': here('../../../packages/core/src/index.mts') },
}

await build({
  ...common,
  // ssh-check、adapter-check 是远程传输和本机内置适配器的自检工具，tools-check 是客户端工具的，都不随界面运行
  entryPoints: {
    main: 'src/main.mts',
    'core-host': 'src/core-host.mts',
    'ssh-check': 'src/ssh-check.mts',
    'adapter-check': 'src/adapter-check.mts',
    'tools-check': 'src/client-tools/check.mts',
    // 扫码绑定手机在外壳这一头的自检（scripts/check-pair.mjs）
    'pair-check': 'src/pair-check.mts',
  },
  outdir: 'dist',
  format: 'esm',
  outExtension: { '.js': '.mjs' },
  // 打进来的依赖里有 CommonJS 写的（ws），它们要用 require 取 Node 的内置模块；ESM 产物里得自己造一个
  banner: {
    js: "import { createRequire as __litchCreateRequire } from 'node:module'; const require = __litchCreateRequire(import.meta.url);",
  },
})

// 预加载脚本跑在开了沙箱的渲染进程里，那里只认 CommonJS
await build({
  ...common,
  entryPoints: ['src/preload.mts'],
  outfile: 'dist/preload.cjs',
  format: 'cjs',
})
