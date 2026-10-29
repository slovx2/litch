// 无前台验收：生产构建和 CSP、隔离 Electron 隐藏离屏窗口，不连接用户设备。
import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from '../packages/ui/node_modules/vite/dist/node/index.js'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const out = join(root, '.local/preview-web-check', `${Date.now()}-${process.pid}`)
mkdirSync(out, { recursive: true })
await build({
  configFile: join(root, 'packages/ui/vite.config.ts'),
  root: join(root, 'packages/ui'),
  logLevel: 'warn',
  build: {
    outDir: join(out, 'assets'),
    rollupOptions: { input: join(root, 'packages/ui/test/preview-web/index.html') },
  },
})
const audio = ['-f', 'lavfi', '-i', 'sine=frequency=440:duration=1']
const video = ['-f', 'lavfi', '-i', 'color=c=blue:s=160x90:r=10:d=1']
for (const [name, args] of [
  ['tone.wav', [...audio, '-c:a', 'pcm_s16le']],
  ['tone.mp3', [...audio, '-c:a', 'libmp3lame']],
  [
    'clip.mp4',
    [...video, ...audio, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest'],
  ],
  ['clip.webm', [...video, ...audio, '-c:v', 'libvpx-vp9', '-c:a', 'libopus', '-shortest']],
])
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args, join(out, name)], {
    timeout: 30000,
  })
execFileSync(
  'ffmpeg',
  [
    '-hide_banner',
    '-loglevel',
    'error',
    '-y',
    '-f',
    'lavfi',
    '-i',
    'color=c=green:s=4000x4000',
    '-frames:v',
    '1',
    join(out, 'pixels.png'),
  ],
  { timeout: 30000 },
)
const home = mkdtempSync(join(tmpdir(), 'litch-preview-web-'))
const exe = join(
  root,
  'apps/desktop/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron',
)
const child = spawn(exe, [join(root, 'scripts/preview-web-electron.mjs'), out], {
  env: { PATH: process.env.PATH, HOME: home, TMPDIR: home, LITCH_PREVIEW_CHECK_HOME: home },
  stdio: ['ignore', 'pipe', 'pipe'],
})
let output = ''
for (const stream of [child.stdout, child.stderr])
  stream.on('data', (b) => {
    output += b
    process.stdout.write(b)
  })
const timer = setTimeout(() => child.kill('SIGTERM'), 90000)
const code = await new Promise((resolve) => child.on('exit', resolve))
clearTimeout(timer)
writeFileSync(join(out, 'run.log'), output)
assert.equal(code, 0, `验收失败，证据：${out}`)
const report = JSON.parse(readFileSync(join(out, 'report.json'), 'utf8'))
console.log(
  JSON.stringify(
    { output: out, checks: report.checks, electron: report.versions.electron, media: report.media },
    null,
    2,
  ),
)
