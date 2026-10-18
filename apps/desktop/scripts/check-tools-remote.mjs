// 客户端工具的远程端到端（补上 client:check:tools 只经“只装了 codex”的假远程跑 echo 的缺口）：
// 假远程机器（scripts/client-ssh-fixture.mjs）上的完整设备服务，经系统的 ssh 连过去；桌面这一头起一次不开窗口的
// Electron（src/probe-tools-remote.mts），真的内置浏览器和 litch_echo。模型调 echo、用浏览器打开远端的
// localhost 页面（经 ssh -L 转发），见那份探针开头。
// 远端的网页在这里起（假远程机器和这台电脑是同一台，网页只在回环上听），记下每个请求的路径和 Host 头。
// 要先 npm run build（根目录，要有 go）和 npm run build --prefix packages/pi。
//   npm run check:tools:remote
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { WebSocketServer } from 'ws'

const require = (await import('node:module')).createRequire(import.meta.url)
const electron = require('electron')
const appDir = fileURLToPath(new URL('..', import.meta.url))
const repo = fileURLToPath(new URL('../../..', import.meta.url))

// ---------- 远端的网页：一个重定向、一页带 WebSocket 的页面 ----------
const requests = []
const web = createServer((req, res) => {
  if (req.url === '/__log') {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(requests))
    return
  }
  requests.push({ path: req.url, host: req.headers.host })
  if (req.url === '/go') {
    // 很多开发服务器按自己配置的地址拼绝对网址，而不是按 Host 头
    res.writeHead(302, { Location: `http://localhost:${port}/second` })
    res.end()
    return
  }
  if (req.url === '/second') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    res.end(`<!doctype html><title>LITCH-REMOTE-PAGE</title>
<h1>LITCH-REMOTE-PAGE</h1>
<p id="ws">ws: waiting</p>
<script>
const socket = new WebSocket('ws://' + location.host + '/hmr')
socket.onmessage = (event) => { document.getElementById('ws').textContent = 'ws: ' + event.data }
</script>`)
    return
  }
  res.writeHead(404)
  res.end()
})
const sockets = new WebSocketServer({ noServer: true })
web.on('upgrade', (req, socket, head) => {
  requests.push({ path: req.url, host: req.headers.host })
  sockets.handleUpgrade(req, socket, head, (ws) => ws.send('HMR-OK'))
})
await new Promise((done) => web.listen(0, '127.0.0.1', done))
const port = web.address().port

// ---------- 假远程机器 ----------
function startFixture() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['scripts/client-ssh-fixture.mjs'], {
      cwd: repo,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const exited = new Promise((done) => child.on('exit', done))
    let output = ''
    let ready = false
    const onData = (chunk) => {
      output += chunk
      if (ready) return
      const line = output.split('\n').find((entry) => entry.startsWith('LITCH_SSH_FIXTURE '))
      if (!line) return
      ready = true
      resolve({
        info: JSON.parse(line.slice('LITCH_SSH_FIXTURE '.length)),
        stop() {
          child.kill('SIGTERM')
          return Promise.race([exited, new Promise((done) => setTimeout(done, 60_000))])
        },
      })
    }
    child.stdout.on('data', onData)
    child.stderr.on('data', onData)
    child.on('exit', (code) => {
      if (!ready) reject(new Error(`夹具没起来（退出码 ${code}）：\n${output}`))
    })
  })
}

const scratch = mkdtempSync(join(tmpdir(), 'litch-tools-remote-'))
const outfile = join(scratch, 'probe.mjs')
await build({
  entryPoints: ['src/probe-tools-remote.mts'],
  absWorkingDir: appDir,
  outfile,
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  external: ['electron', 'bufferutil', 'utf-8-validate'],
  alias: { '@litch/core': join(repo, 'packages/core/src/index.mts') },
  logLevel: 'warning',
  banner: {
    js: "import { createRequire as __litchCreateRequire } from 'node:module'; const require = __litchCreateRequire(import.meta.url);",
  },
})

let fixture = null
let result = null
try {
  fixture = await startFixture()
  const { info } = fixture
  const env = {
    ...process.env,
    LITCH_PROFILE: join(scratch, 'profile'),
    LITCH_SSH_CONFIG: info.config,
    LITCH_REMOTE_CODEX: info.codex,
    LITCH_REMOTE_ADAPTER: info.adapter,
    LITCH_FX_ALIAS: info.aliases.svc,
    LITCH_FX_WORK: info.work,
    LITCH_FX_WEB: String(port),
  }
  delete env.ELECTRON_RUN_AS_NODE
  result = await new Promise((resolve) => {
    const child = spawn(electron, [outfile], { env, stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''
    child.stdout.on('data', (chunk) => {
      output += chunk
    })
    child.stderr.on('data', (chunk) => process.stderr.write(chunk))
    const timer = setTimeout(() => child.kill('SIGKILL'), 300_000)
    child.on('exit', (code) => {
      clearTimeout(timer)
      const line = output.split('\n').find((entry) => entry.startsWith('LITCH_TOOLS_REMOTE '))
      resolve(
        line
          ? JSON.parse(line.slice('LITCH_TOOLS_REMOTE '.length))
          : { ok: false, error: `探针没给结果（退出码 ${code}）`, output },
      )
    })
  })
} catch (error) {
  result = { ok: false, error: String(error) }
} finally {
  await fixture?.stop()
  sockets.close()
  web.close()
  rmSync(scratch, { recursive: true, force: true })
}

for (const one of result.checks ?? []) {
  console.log(
    `${one.ok ? '过  ' : '没过'} ${one.name}${one.ok ? '' : `：${JSON.stringify(one.detail)}`}`,
  )
}
if (result.error) console.log(`出错：${result.error}`)
console.log(`客户端工具远程端到端：${result.ok ? '过' : '没过'}`)
process.exit(result.ok ? 0 : 1)
