// 在电脑上验手机端的 SSH 模块（mobile/sshtransport）：不装到手机上，直接对着测试夹具走一遍
// 探测、启动、开流、WebSocket 握手、初始化、列会话。脚本用的是手机端那一份（src/core/script.ts）。
//
// 用法：先起 node apps/mobile/scripts/fixture.mjs --out <配置>，再 node apps/mobile/scripts/ssh-smoke.mjs <配置>
import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import { parsePairs, probeScript, proxyScript, startScript } from '../src/core/script.ts'

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
// 用仓库根目录那一份 ws（移动端目录下的是 RN 自带的旧版本）
const { WebSocket } = createRequire(join(repo, 'package.json'))('ws')
const config = JSON.parse(readFileSync(process.argv[2], 'utf8'))
const names = { adapter: config.adapter, randomHex: () => randomBytes(16).toString('hex') }

const tool = spawn('go', ['run', './sshtransport/smoke'], { cwd: join(repo, 'mobile'), stdio: ['pipe', 'pipe', 'inherit'] })
const lines = createInterface({ input: tool.stdout })
const waiting = []
lines.on('line', (line) => waiting.shift()?.(JSON.parse(line)))
const call = (command) =>
  new Promise((done) => {
    waiting.push(done)
    tool.stdin.write(`${JSON.stringify({ target: config.target, ...command })}\n`)
  })

const step = (name, ok, detail = '') => {
  console.log(`${ok ? '通过' : '失败'}  ${name}${detail ? `  ${detail}` : ''}`)
  if (!ok) {
    tool.kill()
    process.exit(1)
  }
}

const probe = probeScript(names)
let said = await call({ op: 'run', script: probe.text, marker: probe.marker })
let pairs = parsePairs(said.output ?? '')
step('探测', said.marked && pairs.adapter === 'yes', JSON.stringify(pairs))

const start = startScript(names)
const t0 = Date.now()
said = await call({ op: 'run', script: start.text, marker: start.marker })
pairs = parsePairs(said.output ?? '')
step('启动设备服务', pairs.code === '0', `${Date.now() - t0}ms ${pairs.said ?? ''}`.slice(0, 200))

const proxy = proxyScript(names)
const opened = await call({ op: 'open', id: 'smoke', script: proxy.text, marker: proxy.marker })
step('开流', typeof opened.url === 'string', opened.url ?? opened.error)

const socket = new WebSocket(opened.url, { perMessageDeflate: false })
const pending = new Map()
let nextId = 1
const request = (method, params) =>
  new Promise((done, fail) => {
    const id = nextId++
    pending.set(id, { done, fail })
    socket.send(JSON.stringify({ id, method, params }))
  })
socket.on('message', (data) => {
  const message = JSON.parse(String(data))
  if (message.id != null && pending.has(message.id)) {
    const { done, fail } = pending.get(message.id)
    pending.delete(message.id)
    if (message.error) fail(new Error(JSON.stringify(message.error)))
    else done(message.result)
  }
})
await new Promise((done, fail) => {
  socket.once('open', done)
  socket.once('error', fail)
})
const state = await call({ op: 'state', id: 'smoke' })
step('WebSocket 握手', true, `对面是 ${state.peer}`)

const init = await request('initialize', {
  clientInfo: { name: 'litch-mobile-smoke', title: 'Litch mobile smoke', version: '0.0.0' },
  capabilities: { experimentalApi: true, litchExtensions: ['harness', 'deviceWorkspaces'] },
})
socket.send(JSON.stringify({ method: 'initialized' }))
step('初始化', Boolean(init), JSON.stringify(init).slice(0, 160))

const listed = await request('thread/list', {})
step('列会话', Array.isArray(listed?.data), `${listed?.data?.length ?? '?'} 个会话`)

socket.close()
await call({ op: 'close', id: 'smoke' })
tool.stdin.end()
console.log('全部通过')
process.exit(0)
