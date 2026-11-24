// 系统自启换版本模拟里的“设备进程”：顶替 packages/device，放在每一版安装目录的 device 入口位置。
// 只做换版本要用到的三样：开聚合面（device.sock 和代理用的那一个，回显）、接上主进程的控制通道答 activity 和 restart.prepare。
// 忙不忙看状态目录里的 sim-activity.json（不存在就是闲）；收到 restart.prepare 时在 sim-resume.log 记一行，
// 模拟器据此确认“立即重启”前确实为续跑做了准备。只用 node 自带的模块，Node 18 也能跑。
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'

const args = process.argv.slice(2)
const value = (name) => args[args.indexOf(name) + 1]
const state = value('--state')

function activity() {
  try {
    return JSON.parse(fs.readFileSync(path.join(state, 'sim-activity.json'), 'utf8'))
  } catch {
    return { turns: [], processes: 0, background: 0, backgroundNames: [], tasks: 0, connections: 0 }
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

// 记下服务给设备进程的 PATH：模拟器据此确认自启环境里找得到标准位置（/usr/local/bin）的命令行
fs.writeFileSync(path.join(state, 'sim-path.txt'), process.env.PATH ?? '')

const control = net.connect(path.join(state, 'ctl.sock'))
let buffer = ''
control.on('error', () => {})
control.on('data', (chunk) => {
  buffer += chunk
  let at = buffer.indexOf('\n')
  while (at >= 0) {
    const line = buffer.slice(0, at)
    buffer = buffer.slice(at + 1)
    at = buffer.indexOf('\n')
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

// 聚合面和给 device-proxy 用的那一个（LITCH_DEVICE_PROXY_SOCKET）都开，回显就够：探测只看连不连得上
const echo = () =>
  net.createServer((socket) => {
    socket.on('error', () => {})
    socket.pipe(socket)
  })
const proxy = process.env.LITCH_DEVICE_PROXY_SOCKET
if (proxy) echo().listen(proxy)
echo().listen(value('--listen').slice('unix://'.length), () => console.log('LITCH_DEVICE_READY'))
