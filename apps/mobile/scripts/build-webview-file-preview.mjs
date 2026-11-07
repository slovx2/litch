// 预览页完全离线：复用桌面锁定的 PDF.js 和预算/图片核对函数，不新增原生依赖。
// 主模块、worker、CMap、标准字体和两个解码器 gzip 后内联；不打包通用 viewer、示例或地图文件。
import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { gzipSync } from 'node:zlib'
import { PREVIEW_LIMIT } from '../../../packages/protocol/src/file-preview.mts'

const mobile = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const ui = resolve(mobile, '../../packages/ui')
const pdf = join(ui, 'node_modules/pdfjs-dist')
// 模拟器 WebView 124 实测缺 Promise.try / Map.getOrInsertComputed，现代构建无法读取 PDF。
// 用上游为旧浏览器提供的整套主模块/worker，不在应用里补运行时 API。
const pdfBuild = join(pdf, 'legacy/build')
const read = (path) => readFileSync(path, 'utf8')
const source = (name) => read(join(mobile, 'src/web', name))
const gestures = [
  stripTypeScriptTypes(read(join(mobile, 'src/detail/media/image-taps.ts'))),
  source('file-preview-gestures.js').replace(/^import .*\n/gm, ''),
].join('\n')
const shared = (name) => stripTypeScriptTypes(read(join(ui, 'src/files/preview', name)))
const inline = (code) => code.replaceAll(/<\//g, '<\\/')
const styles =
  'html,body{margin:0;height:100%;overflow:hidden;touch-action:none;user-select:none;-webkit-user-select:none}#stage{position:absolute;left:0;top:0;transform-origin:0 0;max-width:none}'
// 不允许联网、外链、表单、嵌套页面；只放行离线脚本、worker、图像和内嵌字体。
const csp =
  "default-src 'none'; script-src 'unsafe-inline' blob: 'wasm-unsafe-eval'; worker-src blob:; connect-src 'none'; img-src blob: data:; font-src blob: data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-src 'none'"
const page = (code, module = false) =>
  `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${csp}"><meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no"><style>${styles}</style></head><body><script${module ? ' type="module"' : ''}>${inline(code)}</script></body></html>`

const imageHtml = page(
  [
    `const IMAGE_BYTES = ${PREVIEW_LIMIT.image};`,
    stripTypeScriptTypes(read(resolve(ui, '../core/src/image-info.mts'))),
    shared('image-info.ts').replace(/^import .*\n|^export \{ imageInfo \}.*\n/gm, ''),
    gestures,
    source('file-preview-image.js'),
  ].join('\n'),
  true,
)
const assets = {}
for (const folder of ['cmaps', 'standard_fonts', 'wasm']) {
  for (const name of readdirSync(join(pdf, folder))) {
    if (
      !(folder === 'cmaps'
        ? name.endsWith('.bcmap')
        : folder === 'standard_fonts'
          ? /\.(pfb|ttf)$/.test(name)
          : /^(openjpeg|jbig2)\.wasm$/.test(name))
    )
      continue
    assets[`${folder}/${name}`] = readFileSync(join(pdf, folder, name)).toString('base64')
  }
}
const payload = {
  worker: read(join(pdfBuild, 'pdf.worker.min.mjs')),
  assets,
  main: [
    read(join(pdfBuild, 'pdf.min.mjs')),
    shared('pdf/policy.ts'),
    gestures,
    source('file-preview-pdf.js'),
  ].join('\n'),
}
const packed = gzipSync(JSON.stringify(payload), { level: 9 }).toString('base64')
// 从内存流解压，不用 fetch(data:)；connect-src 始终为 none。配置和文件数据不拼进 PDF.js 源码。
const loader = `(async()=>{try{const bytes=Uint8Array.from(atob('${packed}'),c=>c.charCodeAt(0));const data=JSON.parse(await new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'))).text());window.__litchPdf=data;const script=document.createElement('script');script.type='module';script.textContent=data.main;delete data.main;document.body.append(script)}catch{window.ReactNativeWebView?.postMessage(JSON.stringify({kind:'failed',reason:'invalid'}))}})()`
const pdfHtml = page(loader)
const out = join(mobile, 'src/web/file-preview-html.generated.ts')
writeFileSync(
  out,
  `// 自动生成：node apps/mobile/scripts/build-webview-file-preview.mjs\nexport const IMAGE_HTML = ${JSON.stringify(imageHtml)}\nexport const PDF_HTML = ${JSON.stringify(pdfHtml)}\n`,
)
console.log(
  `文件预览：图片 ${Math.round(imageHtml.length / 1024)} KiB；PDF（含离线 worker/字体）${Math.round(pdfHtml.length / 1024)} KiB`,
)
