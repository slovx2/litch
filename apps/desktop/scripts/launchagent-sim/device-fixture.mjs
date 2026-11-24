// LaunchAgent 换版本模拟里的“设备进程”：顶替 packages/device，放在假内置适配器的设备入口位置（经一个只有一行 import 的入口）。
// 只做换版本要用到的：聚合面和给 device-proxy 用的套接字上答握手和列会话（照 fake-adapter.mjs 的假聚合面），
// 接上主进程的控制通道答 activity 和 restart.prepare。忙不忙看状态目录里的 sim-activity.json（不存在就是闲）；
// 收到 restart.prepare 时在 sim-resume.log 记一行。放在 apps/desktop 下面是为了能用这里的 ws。
import fs from 'node:fs'
import { createServer } from 'node:http'
import net from 'node:net'
import path from 'node:path'
import { WebSocketServer } from 'ws'

const args = process.argv.slice(2)
const value = (name) => args[args.indexOf(name) + 1]
const state = value('--state')

const IDLE = {
  turns: [],
  processes: 0,
  background: 0,
  backgroundNames: [],
  tasks: 0,
  connections: 0,
}
function activity() {
  try {
    return {
      ...IDLE,
      ...JSON.parse(fs.readFileSync(path.join(state, 'sim-activity.json'), 'utf8')),
    }
  } catch {
    return IDLE
  }
}

function answer(method) {
  if (method === 'activity') return activity()
  if (method === 'restart.prepare') {
    fs.appendFileSync(path.join(state, 'sim-resume.log'), `${process.pid}\n`)
    return { prepared: true }
  }
  throw new Error(`unknown ask ${method}`)
}

const control = net.connect(path.join(state, 'ctl.sock'))
let buffer = ''
control.on('error', () => {})
control.on('data', (chunk) => {
  buffer += chunk
  for (let at = buffer.indexOf('\n'); at >= 0; at = buffer.indexOf('\n')) {
    const line = buffer.slice(0, at)
    buffer = buffer.slice(at + 1)
    let frame
    try {
      frame = JSON.parse(line)
    } catch {
      continue
    }
    if (typeof frame.ask !== 'number') continue
    let reply
    try {
      reply = { reply: frame.ask, result: answer(frame.method) }
    } catch (error) {
      reply = { reply: frame.ask, error: String(error) }
    }
    control.write(`${JSON.stringify(reply)}\n`)
  }
})

/** 一个只答握手和列会话的假聚合面 */
function serve(socket, ready) {
  fs.rmSync(socket, { force: true })
  const server = createServer()
  new WebSocketServer({ server }).on('connection', (peer) => {
    peer.on('message', (data) => {
      const message = JSON.parse(data.toString())
      if (message.id === undefined) return
      const reply = (body) => peer.send(JSON.stringify({ id: message.id, ...body }))
      if (message.method === 'initialize') {
        reply({
          result: {
            userAgent: 'litch-launchagent-sim/0.0.0',
            codexHome: state,
            platformFamily: 'unix',
            platformOs: 'macos',
          },
        })
      } else if (message.method === 'thread/list') {
        reply({ result: { data: [], nextCursor: null } })
      } else {
        reply({ error: { code: -32601, message: `Method not found: ${message.method}` } })
      }
    })
  })
  server.listen(socket, ready)
}

const proxy = process.env.LITCH_DEVICE_PROXY_SOCKET
if (proxy) serve(proxy)
serve(value('--listen').slice('unix://'.length), () => console.log('LITCH_DEVICE_READY'))
