// Computer Use 自检的 Windows 分支（check-computer-use.mjs 在 Windows 上走这里）：照主进程的做法把助手当子进程拉起来，
// 经标准输入输出说主进程那套协议（4 字节大端长度 + JSON-RPC，方法和形状见 src/computer-use/wire.mts），调不动界面的几样：
//   hello（协议号、平台、进程号）、diagnostics、listApps（有没有界面都只要求回一个列表：流水线的机器上可能一个窗口都没有）；
//   shutdown 之后进程自己退出；再起一次，关掉它的标准输入，它也自己退出。不点、不截图、不打字。
// 不用主进程里接助手的那一层（src/computer-use），这里只验助手本身和打包约定，主进程那边有自己的测试。
//
// 用哪一份助手：--helper 路径，再不然 LITCH_COMPUTER_USE_WIN_HELPER，再不然仓库里 cargo 的产物（win-helper.mjs）。
// 找不到时跳过并说明；带 --require（流水线）时找不到算失败。
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { WIN_HELPER_BUILD, winHelperPath } from './win-helper.mjs'

/** 每一步最多等多久 */
const STEP_MS = 15_000
/** 协议版本，和 src/computer-use/wire.mts 的 HELPER_PROTOCOL_WIN 一致 */
const PROTOCOL = 1

const withTimeout = (promise, what) =>
  Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`${what}：${STEP_MS / 1000} 秒没有结果`)), STEP_MS),
    ),
  ])

/** 起一份助手，给出调方法、等退出的几样 */
function launch(helper) {
  const child = spawn(helper, ['--parent-pid', String(process.pid)], {
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  })
  let stderr = ''
  child.stderr.on('data', (chunk) => {
    stderr += chunk
  })
  const exited = new Promise((resolve) => child.once('exit', (code) => resolve(code)))
  const pending = new Map()
  let buffer = Buffer.alloc(0)
  child.stdout.on('data', (chunk) => {
    buffer = Buffer.concat([buffer, chunk])
    while (buffer.length >= 4) {
      const length = buffer.readUInt32BE(0)
      if (buffer.length < 4 + length) break
      const message = JSON.parse(buffer.subarray(4, 4 + length).toString('utf8'))
      buffer = buffer.subarray(4 + length)
      const waiter = pending.get(message.id)
      if (!waiter) continue
      pending.delete(message.id)
      if (message.error)
        waiter.reject(
          new Error(
            `${message.error.message}（${message.error.data?.kind ?? message.error.code}）`,
          ),
        )
      else waiter.resolve(message.result)
    }
  })
  let nextId = 0
  const request = (method, params = {}) => {
    const id = ++nextId
    const body = Buffer.from(JSON.stringify({ jsonrpc: '2.0', id, method, params }), 'utf8')
    const head = Buffer.alloc(4)
    head.writeUInt32BE(body.length, 0)
    child.stdin.write(Buffer.concat([head, body]))
    return withTimeout(
      new Promise((resolve, reject) => pending.set(id, { resolve, reject })),
      `${method} 没有回应`,
    )
  }
  return { child, request, exited, stderr: () => stderr }
}

/** 跑一遍。返回给人看的几行；不过就抛错 */
export async function checkWindowsHelper({ helper, require }) {
  const path = helper ?? winHelperPath()
  if (!existsSync(path)) {
    const why = `没有找到 Windows 的 Computer Use 助手 ${path}（先在 apps/computer-use-win 里 ${WIN_HELPER_BUILD.join(' ')}，或用 --helper、LITCH_COMPUTER_USE_WIN_HELPER 指过去）`
    if (require) throw new Error(why)
    return [`${why}，跳过`]
  }
  const lines = [`助手：${path}`]
  const first = launch(path)
  try {
    const hello = await first.request('hello', { protocol: PROTOCOL, lang: 'zh-CN' })
    if (
      hello?.platform !== 'win32' ||
      hello?.protocol !== PROTOCOL ||
      hello?.pid !== first.child.pid
    ) {
      throw new Error(`hello 的结果不对：${JSON.stringify(hello)}（进程号应为 ${first.child.pid}）`)
    }
    lines.push(
      `hello：协议 ${hello.protocol}，版本 ${hello.version}，完整性 ${hello.integrity}，UAC ${hello.uacEnabled ? '开' : '关'}`,
    )
    const diagnostics = await first.request('diagnostics')
    if (diagnostics?.pid !== first.child.pid) {
      throw new Error(`diagnostics 的结果不对：${JSON.stringify(diagnostics)}`)
    }
    const flags = ['uia', 'wgc', 'borderlessCapture'].map((key) => `${key} ${diagnostics[key]}`)
    lines.push(
      `diagnostics：系统 ${diagnostics.osVersion}，输入桌面 ${diagnostics.inputDesktop}，${flags.join('，')}`,
    )
    const listed = await first.request('listApps')
    if (!Array.isArray(listed?.apps))
      throw new Error(`listApps 没有回列表：${JSON.stringify(listed)}`)
    const names = listed.apps.map((app) => app.name).slice(0, 8)
    lines.push(
      `listApps：${listed.apps.length} 个应用${names.length ? `（${names.join('、')}…）` : ''}`,
    )
    await first.request('shutdown')
    const code = await withTimeout(first.exited, 'shutdown 之后进程没有退出')
    lines.push(`shutdown 之后退出了（退出码 ${code}）`)
  } catch (error) {
    first.child.kill()
    const stderr = first.stderr().trim()
    throw new Error(`${error.message}${stderr ? `\n助手的标准错误：\n${stderr}` : ''}`)
  }

  const second = launch(path)
  try {
    await second.request('hello', { protocol: PROTOCOL })
    second.child.stdin.end()
    const code = await withTimeout(second.exited, '关掉标准输入之后进程没有退出')
    lines.push(`关掉标准输入之后退出了（退出码 ${code}）`)
  } catch (error) {
    second.child.kill()
    throw error
  }
  return lines
}
