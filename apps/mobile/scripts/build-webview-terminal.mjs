// 把终端页拼成一页 HTML（xterm 和三个插件的 UMD 构建、样式、src/web/terminal-page.js 全部内联），
// 写成 src/web/terminal-html.generated.ts 给终端页（src/screens/tools/terminal/TerminalView.tsx）用。
// 生成的文件不进仓库（.gitignore）。xterm 取桌面界面包装好的那一份（packages/ui/node_modules），版本和桌面端一致。
//
// 用法：node apps/mobile/scripts/build-webview-terminal.mjs（先 npm ci --prefix packages/ui 装好界面包的依赖）。
// 改了 terminal-page.js 要重跑，再重新打 JS 包（release 包要重新 assembleRelease）。
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const mobile = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const xterm = resolve(mobile, '../../packages/ui/node_modules/@xterm')
const read = (path) => readFileSync(path, 'utf8')
// 内联进 <script> 里的代码不能出现 </script
const inline = (code) => code.replaceAll('</script', '<\\/script')

const version = JSON.parse(read(join(xterm, 'xterm/package.json'))).version
const html = [
  '<!doctype html><html><head><meta charset="utf-8">',
  '<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no">',
  `<style>${read(join(xterm, 'xterm/css/xterm.css'))}`,
  // 四周留一点边，字不贴着屏幕边；长按不弹系统的选字菜单（xterm 自己管选区）
  'html,body{margin:0;height:100%;overflow:hidden;-webkit-user-select:none;user-select:none}',
  '#term{position:absolute;inset:4px 4px 0 6px}</style>',
  '</head><body><div id="term"></div>',
  `<script>${inline(read(join(xterm, 'xterm/lib/xterm.js')))}</script>`,
  `<script>${inline(read(join(xterm, 'addon-fit/lib/addon-fit.js')))}</script>`,
  `<script>${inline(read(join(xterm, 'addon-unicode11/lib/addon-unicode11.js')))}</script>`,
  `<script>${inline(read(join(xterm, 'addon-web-links/lib/addon-web-links.js')))}</script>`,
  `<script>${inline(read(join(mobile, 'src/web/terminal-page.js')))}</script>`,
  '</body></html>',
].join('\n')
const out = join(mobile, 'src/web/terminal-html.generated.ts')
writeFileSync(
  out,
  `// 生成的文件，别手改：node apps/mobile/scripts/build-webview-terminal.mjs\n` +
    `export const XTERM_VERSION = ${JSON.stringify(version)}\n` +
    `export const TERMINAL_HTML = ${JSON.stringify(html)}\n`,
)
console.log(`写好了：${out}（xterm ${version}，${Math.round(html.length / 1024)} KB）`)
