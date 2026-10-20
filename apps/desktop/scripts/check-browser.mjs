// 内置浏览器的自检：不显示窗口，起一次 Electron，跑 src/probe-browser.mts（工具逐个调用、CDP 白名单、
// 按来源审批、回合收尾）。测试网页由自检自己在回环上起，用户数据目录是临时的，跑完删掉。
//   node scripts/check-browser.mjs          自检
//   node scripts/check-browser.mjs --v0     实测：WebContentsView 在面板关着的各种挂法下截图、输入能不能用
//   node scripts/check-browser.mjs --ui     浏览器面板：真的界面（先构建 packages/ui）对着页面里的模拟核心，
//                                          量矩形、叠上去、收起摘下、浮层撤下、show 打开面板
//   加 --shown                             V0 那一项改成窗口透明度 0、不接鼠标地显示（对照窗口在屏幕上的情形）
//   node scripts/check-browser.mjs --autofill
//                                          用户标签的自动填充和代理读不到密码（src/probe-browser-autofill.mts）：窗口显示在屏幕上，
//                                          原生菜单换成桩；再加 --manual 弹真的菜单，等人去点（打出要点的屏幕坐标）。
//                                          safeStorage 在钥匙串里建的“Litch Autofill Probe Safe Storage”跑完删掉
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const require = createRequire(import.meta.url)
const electron = require('electron')
const appDir = fileURLToPath(new URL('..', import.meta.url))
const v0 = process.argv.includes('--v0')
const ui = process.argv.includes('--ui')
const autofill = process.argv.includes('--autofill')
const entry = v0
  ? 'src/probe-browser-v0.mts'
  : ui
    ? 'src/probe-browser-ui.mts'
    : autofill
      ? 'src/probe-browser-autofill.mts'
      : 'src/probe-browser.mts'
const uiRoot = fileURLToPath(new URL('../../../packages/ui/dist', import.meta.url))
if (ui && !existsSync(join(uiRoot, 'index.html'))) {
  console.error('没有界面的构建产物，先 npm run build --prefix packages/ui')
  process.exit(1)
}
const marker = v0 ? 'LITCH_V0 ' : 'LITCH_BROWSER '

const work = mkdtempSync(join(tmpdir(), 'litch-browser-check-'))
const outfile = join(work, 'probe.mjs')
await build({
  entryPoints: [entry],
  absWorkingDir: appDir,
  outfile,
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  external: ['electron'],
  logLevel: 'warning',
  banner: {
    js: "import { createRequire as __litchCreateRequire } from 'node:module'; const require = __litchCreateRequire(import.meta.url);",
  },
})

// 面板的自检要一份只给 litchBrowser 的预加载脚本（沙箱里只认 CommonJS）
const preload = join(work, 'preload.cjs')
if (ui) {
  await build({
    entryPoints: ['src/probe-browser-preload.mts'],
    absWorkingDir: appDir,
    outfile: preload,
    bundle: true,
    platform: 'node',
    target: 'node22',
    format: 'cjs',
    external: ['electron'],
    logLevel: 'warning',
  })
}

// 用户标签的自动填充预加载：宿主按主进程产物旁边的 autofill-preload.cjs 找，自检的产物在 work 里，放一份过去
await build({
  entryPoints: ['src/browser/passwords/preload.mts'],
  absWorkingDir: appDir,
  outfile: join(work, 'autofill-preload.cjs'),
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'cjs',
  external: ['electron'],
  logLevel: 'warning',
})

const env = {
  ...process.env,
  LITCH_PROFILE: join(work, 'profile'),
  LITCH_UI_ROOT: uiRoot,
  LITCH_PROBE_PRELOAD: preload,
}
if (process.argv.includes('--shown')) env.LITCH_V0_SHOWN = '1'
if (process.argv.includes('--manual')) env.LITCH_AUTOFILL_MANUAL = '1'
delete env.ELECTRON_RUN_AS_NODE

const child = spawn(electron, [outfile], { env, stdio: ['ignore', 'pipe', 'pipe'] })
let output = ''
child.stdout.on('data', (chunk) => {
  output += chunk
  // 手动的那一项：要点的坐标马上打出来
  for (const line of String(chunk).split('\n')) {
    if (line.startsWith('LITCH_AUTOFILL_CLICK ')) console.log(line)
  }
})
child.stderr.on('data', (chunk) => {
  output += chunk
})
// 到点没完就算没过：自检自己的每一步都有时限，这里是兜底
const limit = setTimeout(() => child.kill('SIGKILL'), 240_000)
const code = await new Promise((resolve) => child.on('exit', (exitCode) => resolve(exitCode)))
clearTimeout(limit)
rmSync(work, { recursive: true, force: true })
// 自动填充那一项用的 safeStorage 在 macOS 钥匙串里留下的那把钥匙（按自检的应用名起的名，不是 Litch 的）
if (autofill && process.platform === 'darwin') {
  spawnSync('security', [
    'delete-generic-password',
    '-s',
    'Litch Autofill Probe Safe Storage',
    '-a',
    'Litch Autofill Probe Key',
  ])
}

const line = output.split('\n').find((one) => one.startsWith(marker))
if (!line) {
  console.error(output.slice(-4000))
  console.error(`没有拿到结果（退出码 ${code}）`)
  process.exit(1)
}
const result = JSON.parse(line.slice(marker.length))
console.log(JSON.stringify(result, null, 1))
if (!v0 && !result.ok) process.exit(1)
