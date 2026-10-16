// 内置浏览器的自检：不显示窗口，起一次 Electron，跑 src/probe-browser.mts（工具逐个调用、CDP 白名单、
// 按来源审批、回合收尾）。测试网页由自检自己在回环上起，用户数据目录是临时的，跑完删掉。
//   node scripts/check-browser.mjs          自检
//   node scripts/check-browser.mjs --v0     V0 ③ 实测：WebContentsView 在面板关着的各种挂法下截图、输入能不能用
//   加 --shown                             V0 那一项改成窗口透明度 0、不接鼠标地显示（对照窗口在屏幕上的情形）
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const require = createRequire(import.meta.url)
const electron = require('electron')
const appDir = fileURLToPath(new URL('..', import.meta.url))
const v0 = process.argv.includes('--v0')
const entry = v0 ? 'src/probe-browser-v0.mts' : 'src/probe-browser.mts'
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

const env = { ...process.env, LITCH_PROFILE: join(work, 'profile') }
if (process.argv.includes('--shown')) env.LITCH_V0_SHOWN = '1'
delete env.ELECTRON_RUN_AS_NODE

const child = spawn(electron, [outfile], { env, stdio: ['ignore', 'pipe', 'pipe'] })
let output = ''
child.stdout.on('data', (chunk) => {
  output += chunk
})
child.stderr.on('data', (chunk) => {
  output += chunk
})
// 到点没完就算没过：自检自己的每一步都有时限，这里是兜底
const limit = setTimeout(() => child.kill('SIGKILL'), 240_000)
const code = await new Promise((resolve) => child.on('exit', (exitCode) => resolve(exitCode)))
clearTimeout(limit)
rmSync(work, { recursive: true, force: true })

const line = output.split('\n').find((one) => one.startsWith(marker))
if (!line) {
  console.error(output.slice(-4000))
  console.error(`没有拿到结果（退出码 ${code}）`)
  process.exit(1)
}
const result = JSON.parse(line.slice(marker.length))
console.log(JSON.stringify(result, null, 1))
if (!v0 && !result.ok) process.exit(1)
