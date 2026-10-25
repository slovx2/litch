// 把画 mermaid 的两页拼成 HTML，写成 src/web/mermaid-html.generated.ts（不进仓库，.gitignore）：
//   - 画图页（MERMAID_HTML）：mermaid 的单文件构建加 src/web/mermaid-page.js，藏在应用根上，画出 SVG 和缩略图
//     （src/detail/mermaid/MermaidHost.tsx）；
//   - 全屏页（VIEWER_HTML）：只有 src/web/mermaid-viewer.js，放大看画好的 SVG（src/detail/mermaid/MermaidViewer.tsx）。
// mermaid 取桌面界面包装好的那一份（packages/ui/node_modules），版本和桌面端一致；全部内联，离线可用，不从网络加载。
//
// 画图页的脚本（mermaid 约 5.4 MB 加 mermaid-page.js）先 gzip 再 base64 放进页面，页面里用 DecompressionStream 解开再执行：
// JS 包里的字符串只要有一个非 ASCII 字就整串按 UTF-16 存（mermaid 里有 ₀、ß 这类字），原样内联会让 JS 包大约 11 MB；
// 压过以后是约 2 MB 的纯 ASCII。安卓的 JS 包在安装包里不压缩（要直接映射进内存），省下的就是安装包的大小。
//
// 用法：node apps/mobile/scripts/build-webview-mermaid.mjs（先 npm ci --prefix packages/ui 装好界面包的依赖）。
// 改了两个页面脚本要重跑，再重新打 JS 包（release 包要重新 assembleRelease）。
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { gzipSync } from 'node:zlib'

const mobile = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const mermaid = resolve(mobile, '../../packages/ui/node_modules/mermaid')
const read = (path) => readFileSync(path, 'utf8')

/**
 * 内联进 <script> 里的代码：不能出现 </script（会提前结束）；也不能出现 <script，
 * 前面若有 <!-- 会进 HTML 解析的“双重转义”状态，后面真的 </script> 就收不住了。后一样替换不了（可能在正则里），只查
 */
function inline(code, name) {
  if (/<script/i.test(code)) throw new Error(`${name} 里有 <script，不能原样内联`)
  return code.replaceAll('</script', '<\\/script')
}

const version = JSON.parse(read(join(mermaid, 'package.json'))).version
const page = (style, scripts) =>
  [
    '<!doctype html><html><head><meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no">',
    `<style>${style}</style>`,
    '</head><body>',
    ...scripts.map(([code, name]) => `<script>${inline(code, name)}</script>`),
    '</body></html>',
  ].join('\n')

// 解压、执行压着的脚本。这一段必须是纯 ASCII（见开头）；出错交给 RN 记日志
const loader = (packed) =>
  `(async()=>{const r=await fetch('data:application/gzip;base64,${packed}');` +
  "const code=await new Response(r.body.pipeThrough(new DecompressionStream('gzip'))).text();" +
  "const s=document.createElement('script');s.textContent=code;document.body.append(s)})()" +
  ".catch((e)=>window.ReactNativeWebView&&window.ReactNativeWebView.postMessage(JSON.stringify({t:'error',message:String(e)})))"
const packed = gzipSync(
  [
    // 解开后经 textContent 交给 <script>，不过 HTML 解析，不用管 </script
    read(join(mermaid, 'dist/mermaid.min.js')),
    read(join(mobile, 'src/web/mermaid-page.js')),
  ].join('\n;\n'),
  { level: 9 },
).toString('base64')
const drawHtml = page('html,body{margin:0;background:transparent}', [[loader(packed), 'loader']])
if (!/^[\x00-\x7f]*$/.test(drawHtml)) throw new Error('画图页里有非 ASCII 字')
// 手势都由页面自己管（touch-action:none），系统的缩放、滚动、长按选字都关掉
const viewerHtml = page(
  'html,body{margin:0;height:100%;overflow:hidden;touch-action:none;-webkit-user-select:none;user-select:none}' +
    '#stage{position:absolute;left:0;top:0;transform-origin:0 0}#stage svg{display:block;max-width:none}',
  [[read(join(mobile, 'src/web/mermaid-viewer.js')), 'mermaid-viewer.js']],
)

const out = join(mobile, 'src/web/mermaid-html.generated.ts')
writeFileSync(
  out,
  `// 生成的文件，别手改：node apps/mobile/scripts/build-webview-mermaid.mjs\n` +
    `export const MERMAID_VERSION = ${JSON.stringify(version)}\n` +
    `export const MERMAID_HTML = ${JSON.stringify(drawHtml)}\n` +
    `export const VIEWER_HTML = ${JSON.stringify(viewerHtml)}\n`,
)
console.log(
  `写好了：${out}（mermaid ${version}，画图页 ${Math.round(drawHtml.length / 1024)} KB，全屏页 ${Math.round(viewerHtml.length / 1024)} KB）`,
)
