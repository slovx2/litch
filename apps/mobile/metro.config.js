// 手机端直接引用仓库里核心和协议的源码（packages/core、packages/protocol），不另外编一份。
// 那边的源码是 .mts，互相引用时写的是 .mjs（TypeScript 的 NodeNext 写法），这里把它对回 .mts。
const { getDefaultConfig } = require('expo/metro-config')
const fs = require('node:fs')
const path = require('node:path')

const repo = path.resolve(__dirname, '../..')
const config = getDefaultConfig(__dirname)

config.watchFolders = [
  path.join(repo, 'packages/core/src'),
  path.join(repo, 'packages/protocol/src'),
  // 界面的文案和桌面界面共用（src/ui/i18n.ts）
  path.join(repo, 'packages/ui/src/i18n'),
]
const CORE_ENTRY = path.join(repo, 'packages/core/src/index.mts')
config.resolver.sourceExts = [...config.resolver.sourceExts, 'mts']
// 核心那边没有 node_modules，它引用的第三方包（没有）和这边共用一份
config.resolver.nodeModulesPaths = [path.join(__dirname, 'node_modules')]

const fallback = config.resolver.resolveRequest
config.resolver.resolveRequest = (context, moduleName, platform) => {
  // 共用的界面代码按包名引用核心
  if (moduleName === '@litch/core') return { type: 'sourceFile', filePath: CORE_ENTRY }
  if (moduleName.startsWith('.') && moduleName.endsWith('.mjs')) {
    const candidate = path.resolve(
      path.dirname(context.originModulePath),
      moduleName.replace(/\.mjs$/, '.mts'),
    )
    if (fs.existsSync(candidate)) return { type: 'sourceFile', filePath: candidate }
  }
  return (fallback ?? context.resolveRequest)(context, moduleName, platform)
}

// .mts 交给 Expo 的转换器之前改个名（metro.transformer.js）。原来的转换器路径经环境变量带过去：转换在工作进程里跑
process.env.LITCH_UPSTREAM_TRANSFORMER = config.transformer.babelTransformerPath
config.transformer.babelTransformerPath = require.resolve('./metro.transformer.js')

module.exports = config
