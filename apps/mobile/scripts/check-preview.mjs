// 查界面预览的代码有没有混进手机的包：分别导出安卓包和网页包（带 source map），按 source map 里列的模块路径判断。
//   安卓包里不许有：src/preview/ 下的文件、src/ 和 modules/ 下的 *.web.*、react-native-web、react-dom
//   网页包里必须有：预览首页、几个替身（对照，证明上面那条查得到东西）
// 用法（apps/mobile 里，Node 24）：npm run preview:check。导出到临时目录，查完删掉；有一条不符就返回非零。
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const mobile = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** 导出一个平台的包，返回 source map 里的全部模块路径（相对 apps/mobile；source map 里写的是 /src/App.tsx 这样以项目为根的） */
function modulesOf(platform, out) {
  const args = ['expo', 'export', '--platform', platform, '--output-dir', out]
  args.push('--no-minify', '--no-bytecode', '--source-maps', 'true', '--clear')
  const run = spawnSync('npx', args, { cwd: mobile, stdio: ['ignore', 'ignore', 'inherit'] })
  if (run.status !== 0) throw new Error(`导出 ${platform} 包失败（退出码 ${run.status}）`)
  const maps = readdirSync(out, { recursive: true }).filter((name) => String(name).endsWith('.map'))
  if (maps.length === 0) throw new Error(`${platform} 包没有 source map`)
  const sources = new Set()
  for (const name of maps) {
    const map = JSON.parse(readFileSync(join(out, String(name)), 'utf8'))
    for (const source of map.sources ?? []) sources.add(String(source).replace(/^\//, ''))
  }
  return [...sources]
}

const ours = (path) => path.startsWith('src/') || path.startsWith('modules/')
const forbidden = [
  ['src/preview/ 下的文件', (path) => path.startsWith('src/preview/')],
  ['src/、modules/ 下的 *.web.*', (path) => ours(path) && /\.web\.[cm]?[jt]sx?$/.test(path)],
  ['react-native-web', (path) => path.includes('node_modules/react-native-web/')],
  ['react-dom', (path) => path.includes('node_modules/react-dom/')],
]
const required = [
  'src/Root.web.tsx',
  'src/preview/Index.web.tsx',
  'src/preview/webview.web.tsx',
  'src/preview/markdown.web.tsx',
  'src/shell/json-file.web.ts',
  'modules/litch-ssh/src/native.web.ts',
]

const work = mkdtempSync(join(tmpdir(), 'litch-preview-check-'))
const problems = []
try {
  const android = modulesOf('android', join(work, 'android'))
  for (const [what, test] of forbidden) {
    const hits = android.filter(test)
    if (hits.length > 0) problems.push(`安卓包里有${what}：${hits.slice(0, 5).join('、')}`)
  }
  if (!android.includes('src/App.tsx'))
    problems.push('安卓包的 source map 里找不到 src/App.tsx，路径对不上')
  const web = modulesOf('web', join(work, 'web'))
  for (const path of required) if (!web.includes(path)) problems.push(`网页包里没有 ${path}`)
  console.log(`安卓包 ${android.length} 个模块，网页包 ${web.length} 个模块`)
} finally {
  rmSync(work, { recursive: true, force: true })
}
if (problems.length > 0) {
  for (const problem of problems) console.error(`✗ ${problem}`)
  process.exit(1)
}
console.log('✓ 预览的代码只在网页包里')
