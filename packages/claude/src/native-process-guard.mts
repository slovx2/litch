import { execFile, execFileSync, spawn } from 'node:child_process'
import { writeSync } from 'node:fs'
import { Socket } from 'node:net'

// 守护进程夹在适配器与 CLI 之间，保证 CLI 无论怎么结束都不留下没人管的进程。
//
// CLI 把后台命令放在各自独立的会话与进程组里，杀 CLI 所在的进程组碰不到它们；
// CLI 被 SIGKILL 时来不及清理，这些命令会变成孤儿一直跑下去。所以停止分两步：
// 先只对 CLI 发 SIGTERM，让它自己停掉后台命令并退出；它没有及时退出，或者是自己崩溃的，
// 再由守护进程按之前记下的进程身份补杀。
//
// 父进程崩溃导致 EOF 时，CLI 可能把 MCP 断线当成工具错误继续请求模型；
// 守护进程保持 CLI 输入打开并立刻发 SIGTERM，CLI 在退出前不会再调用模型。
const [command, ...args] = process.argv.slice(2)
if (!command) throw new Error('缺少 Claude CLI 命令')
const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'] })
const GRACE_MS = 500
let closed = false
let stopping = false
let graceful = false
let inputEnded = false

// CLI 直接起的、不在本进程组里的子进程（后台命令的包装进程）。
// 身份用进程号加启动时间确认，进程号被别的进程复用时不会误杀。
interface Tracked {
  pid: number
  pgid: number
  started: string
}
let tracked: Tracked[] = []

type Row = Tracked & { ppid: number }
const PS_ARGS = ['-A', '-o', 'pid=,ppid=,pgid=,lstart=']

const parseTable = (output: string): Row[] =>
  output.split('\n').flatMap((line) => {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.+?)\s*$/.exec(line)
    if (!match) return []
    return [
      {
        pid: Number(match[1]),
        ppid: Number(match[2]),
        pgid: Number(match[3]),
        started: match[4] as string,
      },
    ]
  })

const table = (): Row[] => {
  try {
    return parseTable(execFileSync('ps', PS_ARGS, { encoding: 'utf8' }))
  } catch {
    // 没有 ps 的环境退回到只杀本进程组。
    return []
  }
}

// 只在 CLI 活着时有意义：这时它的后台命令都还是它的直接子进程。
const remember = (rows: Row[]): void => {
  if (closed || !child.pid || rows.length === 0) return
  const own = rows.find((row) => row.pid === process.pid)?.pgid ?? process.pid
  tracked = rows.filter((row) => row.ppid === child.pid && row.pgid !== own)
}

// 运行期间的快照不能阻塞：守护进程一停顿，CLI 与适配器之间的消息就跟着延迟，
// 会改变 CLI 内部事件的先后。只有停止时才同步取一次。
const snapshot = (): void => {
  if (closed || stopping || process.platform === 'win32') return
  execFile('ps', PS_ARGS, { encoding: 'utf8' }, (error, output) => {
    if (!error && !stopping) remember(parseTable(output))
  })
}

const killTracked = (): void => {
  if (tracked.length === 0) return
  const now = table()
  for (const row of tracked) {
    const current = now.find((entry) => entry.pid === row.pid && entry.started === row.started)
    if (!current) continue
    try {
      // 包装进程是自己那一组的组长时连同它起的命令一起结束。
      process.kill(current.pgid === current.pid ? -current.pid : current.pid, 'SIGKILL')
    } catch {}
  }
  tracked = []
}

const control = new Socket({ fd: 4, readable: true, writable: false })
control.on('data', (data: Buffer) => {
  for (const flag of data.toString()) {
    if (flag === 'g') {
      graceful = true
      if (inputEnded) child.stdin.end()
    } else if (flag === 's') snapshot()
  }
})

const finish = (): void => {
  killTracked()
  // NativeProcess 以 detached=true 启动守护进程，CLI 和同组的工具继承这一进程组。
  process.kill(-process.pid, 'SIGKILL')
}

const stop = (): void => {
  if (stopping) return
  stopping = true
  if (process.platform === 'win32') {
    if (closed || !child.pid) {
      process.exitCode = 1
      return
    }
    const killer = spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], { stdio: 'ignore' })
    killer.once('error', (error) => {
      process.stderr.write(String(error))
      process.exitCode = 1
    })
    return
  }
  if (closed) {
    finish()
    return
  }
  remember(table())
  try {
    child.kill('SIGTERM')
  } catch {}
  setTimeout(finish, GRACE_MS)
}

process.stdin.pipe(child.stdin, { end: false })
process.stdin.once('end', () => {
  inputEnded = true
  if (graceful) child.stdin.end()
})
// 这个管道由适配器持有，不受 SDK 关闭 stdin 影响；父进程死亡时一定收到 EOF。
control.once('end', stop)
control.once('error', stop)
process.stdin.once('error', stop)
process.stdout.once('error', stop)
process.stderr.once('error', stop)
// 宽限期内可能再收到一次信号：处理器要一直在，否则第二次信号按默认动作直接杀掉守护进程。
process.on('SIGTERM', stop)
process.on('SIGINT', stop)
child.stdin.once('error', stop)
child.stdout.pipe(process.stdout, { end: false })
child.stderr.pipe(process.stderr, { end: false })
child.once('spawn', () =>
  writeSync(3, JSON.stringify({ childPid: child.pid }) + String.fromCharCode(10)),
)
child.once('error', (error) => {
  closed = true
  process.stderr.write(String(error))
  process.stdin.destroy()
  control.destroy()
  process.exitCode = 1
})
child.once('close', (code, signal) => {
  closed = true
  if (stopping && process.platform !== 'win32') {
    finish()
    return
  }
  // CLI 自己退出（正常结束或崩溃）：它没来得及停掉的后台命令在这里补杀。
  killTracked()
  process.stdin.destroy()
  control.destroy()
  process.exitCode = code ?? (signal ? 1 : 0)
})
