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
  // 桌面界面里不依赖 React 和浏览器的纯逻辑（文案、时间与原因的说法、计划确认、提问草稿、差异模型等）和手机共用；
  // 只能引这类文件，引到带 React 或 DOM 的会出两份 React
  path.join(repo, 'packages/ui/src'),
  // 两端的 Markdown 验收使用同一份语料；只有网页预览引用。
  path.join(repo, 'packages/ui/test/fixtures'),
]
const CORE_ENTRY = path.join(repo, 'packages/core/src/index.mts')
config.resolver.sourceExts = [...config.resolver.sourceExts, 'mts']
// 核心那边没有 node_modules，它引用的第三方包（没有）和这边共用一份
config.resolver.nodeModulesPaths = [path.join(__dirname, 'node_modules')]

// 网页上的界面预览（src/preview/）：react-native-webview 没有网页版，换成 iframe 的替身；
// react-native-enriched-markdown 的网页版补上 onLayout。只在打网页包时换
const WEB_STANDINS = {
  'react-native-webview': path.join(__dirname, 'src/preview/webview.web.tsx'),
  'react-native-enriched-markdown': path.join(__dirname, 'src/preview/markdown.web.tsx'),
}

const fallback = config.resolver.resolveRequest
config.resolver.resolveRequest = (context, moduleName, platform) => {
  // 共用的界面代码按包名引用核心
  if (moduleName === '@litch/core') return { type: 'sourceFile', filePath: CORE_ENTRY }
  if (platform === 'web' && Object.hasOwn(WEB_STANDINS, moduleName))
    return { type: 'sourceFile', filePath: WEB_STANDINS[moduleName] }
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
