// 远端 localhost 的端口转发：会话在 ssh 设备上、内置浏览器要打开远端的
// localhost:端口 时，用这台设备的 ssh 目标起一条 `ssh -N -L 127.0.0.1:<本机端口>:<远端地址>:<远端端口>`，
// 等本机端口能连上了再把网址改写过去（改写在 forward-url.mts）。
//
// 生命周期：
// - 按“设备 + 远端地址 + 远端端口”复用，同一个远端端口只起一条 ssh。
// - 本机端口记住（应用开着就一直记着，portsFile 给了还落盘）：同一个远端端口下次再起转发、ssh 退了重建，
//   都先试原来那个本机端口，网页的来源（协议 + 主机 + 端口）不变，站点存储和打开着的标签都还对得上。
// - ssh 自己退了：还有标签在用（或者刚用过）就退避着重起，接连起不来三次就放弃；放弃之后再有导航来要，从头再起。
// - 每半分钟看一遍：设备删了或者 ssh 目标改了的撤掉；没有标签在用、闲了 idleMs 的撤掉。应用退出时全部撤掉。
// - 只监听本机回环（127.0.0.1）。不经用户的连接复用（ControlMaster）：转发跟着我们自己的这条 ssh 进程走，
//   进程没了转发就没了；不然 ssh 可能把转发交给后台的主连接，或者自己变成后台主连接，撤不掉也看不住。
// - 应用被强行结束时不留孤儿：ssh 外面套一层 sh 看着我们给它的标准输入，管道一断（我们没了）就结束 ssh。
//
// 不碰 Electron，单元测试用假的 ssh（src/browser/test/remote-local.test.mts）。
import { type ChildProcess, spawn } from 'node:child_process'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { connect, createServer } from 'node:net'
import { dirname } from 'node:path'
import type { RemoteTarget } from '@litch/core'
import { sshBase } from './args.mjs'

/** 等转发就绪（本机端口能连上）的上限：ssh 自己的连接超时是 20 秒，留出认证的余量 */
const READY_MS = 30_000
/** 没有标签在用之后多久撤掉 */
const IDLE_MS = 5 * 60_000
/** 多久看一遍要不要撤 */
const SWEEP_MS = 30_000
/** 起来之后活不过这么久就退了，算“很快就退”：接连三次就不再自己重起 */
const QUICK_MS = 10_000
const MAX_QUICK_FAILS = 3
/** 本机端口被别人抢先占了时换一个再试几次 */
const BIND_ATTEMPTS = 3
/** ssh 报的“通道打不开”（远端那个端口上没人听、对面不许转发）记多久，给模型的说明里带上 */
const PROBLEM_MS = 15_000

/**
 * 包在 ssh 外面的看门狗：ssh 在后台跑，另一个子 shell 一直读标准输入（我们给的管道），读到头（我们关了管道，
 * 或者我们这个进程没了）就结束 ssh。退出码是 ssh 的。后台的命令默认标准输入是 /dev/null，所以先把它挪到 3 号
 */
export const WATCHDOG = [
  'exec 3<&0',
  '"$@" </dev/null &',
  'p=$!',
  '{ while read -r _ <&3; do :; done; kill "$p" 2>/dev/null; } &',
  'w=$!',
  'wait "$p"',
  'c=$?',
  'kill "$w" 2>/dev/null',
  'exit "$c"',
].join('\n')

export class ForwardError extends Error {}

export interface ForwardInfo {
  deviceId: string
  remoteHost: string
  remotePort: number
  localPort: number
  /** 外面那层 sh 的进程号（Windows 上直接是 ssh 的）；没在跑是 null */
  pid: number | null
  running: boolean
}

/** 一个本机端口对应的转发（只认这台设备的） */
export interface LocalHit {
  remoteHost: string
  remotePort: number
  running: boolean
  /** 最近 ssh 报的“通道打不开”，没有是 null */
  problem: string | null
}

export interface ForwarderOptions {
  /** 设备现在的 ssh 目标；设备删掉了是 null */
  targetOf(deviceId: string): RemoteTarget | null
  /** 这个本机端口上还有没有标签在用（宿主看得到标签） */
  inUse?(deviceId: string, localPort: number): boolean
  /** ssh 可执行文件，测试换成假的 */
  ssh?: string
  /** 记住本机端口的文件：应用重开之后同一个远端端口还用原来的本机端口（来源不变）。不给就只记在内存里 */
  portsFile?: string
  /**
   * 本机端口必须和远端端口同号：harness 登录时的 OAuth 回调地址写死了 localhost 的端口，浏览器回调到这台电脑的
   * 那个端口，要原样转到设备上。被占了不换，直接报错
   */
  samePort?: boolean
  readyMs?: number
  idleMs?: number
  sweepMs?: number
  log?(line: string): void
}

export interface Forwarder {
  /** 要一个转发，等它就绪，回本机端口。复用已有的；ssh 退了的当场重起 */
  open(deviceId: string, remoteHost: string, remotePort: number): Promise<number>
  /** 这台设备上这个本机端口是不是某个转发的（正在跑的，或者记着的） */
  local(deviceId: string, localPort: number): LocalHit | null
  list(): ForwardInfo[]
  /** 撤掉一台设备的（不给就是全部）。同步把进程都叫停 */
  close(deviceId?: string): void
}

interface Entry {
  key: string
  deviceId: string
  remoteHost: string
  remotePort: number
  /** 起它时用的 ssh 目标，设备的目标改了要撤掉重起 */
  target: string
  localPort: number | null
  child: ChildProcess | null
  /** 正在起：等它的人共用这一个 */
  starting: Promise<number> | null
  running: boolean
  startedAt: number
  lastUsed: number
  quickFails: number
  restart: ReturnType<typeof setTimeout> | null
  problem: { line: string; at: number } | null
  closed: boolean
}

const keyOf = (deviceId: string, remoteHost: string, remotePort: number) =>
  `${deviceId}\n${remoteHost}\n${remotePort}`

/** -L 里的远端地址：IPv6 要加方括号 */
const hostSpec = (host: string) => (host.includes(':') ? `[${host}]` : host)

/** 试着在回环上占一下这个端口（0 是让系统挑），成了就放开、回这个端口；占不了是 null */
function tryPort(port: number): Promise<number | null> {
  return new Promise((resolve) => {
    const probe = createServer()
    probe.once('error', () => resolve(null))
    probe.listen({ port, host: '127.0.0.1', exclusive: true }, () => {
      const address = probe.address()
      const got = typeof address === 'object' && address ? address.port : null
      probe.close(() => resolve(got))
    })
  })
}

const canConnect = (port: number) =>
  new Promise<boolean>((resolve) => {
    const socket = connect({ port, host: '127.0.0.1' })
    const done = (ok: boolean) => {
      socket.destroy()
      resolve(ok)
    }
    socket.once('connect', () => done(true))
    socket.once('error', () => done(false))
    socket.setTimeout(2000, () => done(false))
  })

/** ssh 的报错里认出“本机端口没占上”：换一个端口再试 */
const BIND_FAILED =
  /Address already in use|cannot listen to port|Could not request local forwarding/i

/** 报错末尾几行，给模型和日志看 */
const tail = (stderr: string) =>
  stderr
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !/^Warning: Permanently added/.test(line))
    .slice(-4)
    .join(' | ')
    .slice(-600)

function readPorts(file: string | undefined): Map<string, number> {
  const ports = new Map<string, number>()
  if (!file) return ports
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>
    for (const [key, value] of Object.entries(raw.ports ?? {})) {
      if (Number.isInteger(value) && (value as number) > 0 && (value as number) < 65536) {
        ports.set(key, value as number)
      }
    }
  } catch {
    // 没有，或者坏了：当作没记过
  }
  return ports
}

export function createForwarder(options: ForwarderOptions): Forwarder {
  const ssh = options.ssh ?? 'ssh'
  const readyMs = options.readyMs ?? READY_MS
  const idleMs = options.idleMs ?? IDLE_MS
  const sweepMs = options.sweepMs ?? SWEEP_MS
  const log = options.log ?? (() => {})
  const entries = new Map<string, Entry>()
  /** 记住的本机端口：键同 entries */
  const ports = readPorts(options.portsFile)
  let sweeper: ReturnType<typeof setInterval> | null = null

  const savePorts = () => {
    if (!options.portsFile) return
    try {
      mkdirSync(dirname(options.portsFile), { recursive: true, mode: 0o700 })
      const next = `${options.portsFile}.${process.pid}.tmp`
      writeFileSync(
        next,
        `${JSON.stringify({ version: 1, ports: Object.fromEntries(ports) }, null, 2)}\n`,
        { mode: 0o600 },
      )
      renameSync(next, options.portsFile)
    } catch (error) {
      log(`记不下转发的本机端口：${String(error)}`)
    }
  }

  const targetKey = (target: RemoteTarget) => JSON.stringify(target)

  /** 起一次 ssh，等本机端口能连上。成了回端口；ssh 先退了就抛（带它的报错） */
  function launch(entry: Entry, target: RemoteTarget, localPort: number): Promise<number> {
    const { options: base, destination } = sshBase(target)
    const args = [
      ...base,
      '-N',
      '-o',
      'ExitOnForwardFailure=yes',
      '-o',
      'ControlMaster=no',
      '-o',
      'ControlPath=none',
      '-L',
      `127.0.0.1:${localPort}:${hostSpec(entry.remoteHost)}:${entry.remotePort}`,
      '--',
      destination,
    ]
    const child =
      process.platform === 'win32'
        ? spawn(ssh, args, { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true })
        : spawn('/bin/sh', ['-c', WATCHDOG, 'litch-forward', ssh, ...args], {
            stdio: ['pipe', 'ignore', 'pipe'],
          })
    child.stdin?.on('error', () => {})
    let stderr = ''
    child.stderr?.setEncoding('utf8').on('data', (chunk: string) => {
      stderr = (stderr + chunk).slice(-8000)
      // 通道打不开（远端那个端口上没人听、对面不许转发）：记下最近的一句
      for (const line of chunk.split('\n')) {
        if (/open failed/i.test(line)) entry.problem = { line: line.trim(), at: Date.now() }
      }
    })
    entry.child = child
    entry.localPort = localPort
    return new Promise<number>((resolve, reject) => {
      let settled = false
      const until = Date.now() + readyMs
      const fail = (error: ForwardError) => {
        if (settled) return
        settled = true
        reject(error)
      }
      child.once('error', (error) => fail(new ForwardError(`could not run ssh: ${error.message}`)))
      child.once('exit', (code, signal) => {
        if (entry.child === child) {
          entry.child = null
          entry.running = false
        }
        if (!settled) {
          const why = tail(stderr) || `ssh exited (${code ?? signal})`
          const error = new ForwardError(why)
          ;(error as ForwardError & { bind?: boolean }).bind = BIND_FAILED.test(stderr)
          fail(error)
          return
        }
        died(entry, child)
      })
      const poll = async () => {
        while (!settled) {
          if (entry.closed) return fail(new ForwardError('the forward was closed'))
          if (await canConnect(localPort)) {
            if (settled) return
            settled = true
            entry.running = true
            entry.startedAt = Date.now()
            return resolve(localPort)
          }
          if (Date.now() > until) {
            stop(child)
            return fail(new ForwardError(`ssh did not open the forward within ${readyMs} ms`))
          }
          await new Promise((done) => setTimeout(done, 100))
        }
      }
      void poll()
    })
  }

  /** 叫停一个 ssh：关掉看门狗的标准输入，它会结束 ssh；不理人的再发信号 */
  function stop(child: ChildProcess) {
    child.stdin?.end()
    if (process.platform === 'win32') child.kill('SIGTERM')
    const term = setTimeout(() => child.kill('SIGTERM'), 2000)
    const kill = setTimeout(() => child.kill('SIGKILL'), 5000)
    term.unref()
    kill.unref()
    child.once('exit', () => {
      clearTimeout(term)
      clearTimeout(kill)
    })
  }

  /** 起（或重起）一个转发：先试记住的本机端口，被占了换一个 */
  function start(entry: Entry): Promise<number> {
    if (entry.starting) return entry.starting
    const run = async () => {
      const target = options.targetOf(entry.deviceId)
      if (!target) throw new ForwardError('this device is no longer configured in Litch')
      entry.target = targetKey(target)
      let last: Error | null = null
      for (let attempt = 0; attempt < BIND_ATTEMPTS; attempt++) {
        const remembered = ports.get(entry.key)
        if (options.samePort) {
          const port = await tryPort(entry.remotePort)
          if (!port) throw new ForwardError(`local port ${entry.remotePort} on 127.0.0.1 is in use`)
          return await launch(entry, target, port)
        }
        const port =
          (attempt === 0 && remembered ? await tryPort(remembered) : null) ?? (await tryPort(0))
        if (!port) throw new ForwardError('no free local port on 127.0.0.1')
        try {
          const ready = await launch(entry, target, port)
          if (ports.get(entry.key) !== ready) {
            ports.set(entry.key, ready)
            savePorts()
          }
          log(
            `转发就绪：${entry.deviceId} ${hostSpec(entry.remoteHost)}:${entry.remotePort} → 127.0.0.1:${ready}`,
          )
          return ready
        } catch (error) {
          last = error as Error
          if (!(error as { bind?: boolean }).bind) throw error
        }
      }
      throw last ?? new ForwardError('could not open the forward')
    }
    entry.starting = run().finally(() => {
      entry.starting = null
    })
    return entry.starting
  }

  const wanted = (entry: Entry) =>
    entry.localPort !== null &&
    (options.inUse?.(entry.deviceId, entry.localPort) === true ||
      Date.now() - entry.lastUsed < idleMs)

  /** 就绪之后 ssh 自己退了：还有人用就退避着重起 */
  function died(entry: Entry, child: ChildProcess) {
    if (entry.closed || entry.child !== null || entry.starting) return
    const lived = Date.now() - entry.startedAt
    entry.quickFails = lived < QUICK_MS ? entry.quickFails + 1 : 0
    log(`转发的 ssh 退了：${entry.deviceId} :${entry.remotePort}（进程 ${child.pid}）`)
    retry(entry)
  }

  function retry(entry: Entry) {
    if (!wanted(entry)) return drop(entry)
    if (entry.quickFails >= MAX_QUICK_FAILS) {
      log(`转发接连起不来，先不重起：${entry.deviceId} :${entry.remotePort}`)
      return drop(entry)
    }
    const delay = Math.min(500 * 2 ** entry.quickFails, 10_000)
    entry.restart = setTimeout(() => {
      entry.restart = null
      if (entry.closed) return
      start(entry).then(
        () => {},
        (error: unknown) => {
          log(`转发重起失败：${String(error)}`)
          entry.quickFails++
          retry(entry)
        },
      )
    }, delay)
    entry.restart.unref()
  }

  /** 撤掉一个转发（记住的本机端口留着） */
  function drop(entry: Entry) {
    entry.closed = true
    if (entry.restart) clearTimeout(entry.restart)
    entry.restart = null
    if (entry.child) stop(entry.child)
    entry.child = null
    entry.running = false
    if (entries.get(entry.key) === entry) entries.delete(entry.key)
    if (entries.size === 0 && sweeper) {
      clearInterval(sweeper)
      sweeper = null
    }
  }

  function sweep() {
    const now = Date.now()
    for (const entry of [...entries.values()]) {
      const target = options.targetOf(entry.deviceId)
      if (!target || (entry.target && targetKey(target) !== entry.target)) {
        log(`设备没了或者换了 ssh 目标，撤掉转发：${entry.deviceId} :${entry.remotePort}`)
        drop(entry)
        continue
      }
      if (entry.localPort !== null && options.inUse?.(entry.deviceId, entry.localPort)) {
        entry.lastUsed = now
      } else if (!entry.starting && now - entry.lastUsed >= idleMs) {
        log(`转发闲置了，撤掉：${entry.deviceId} :${entry.remotePort}`)
        drop(entry)
      }
    }
  }

  return {
    async open(deviceId, remoteHost, remotePort) {
      const key = keyOf(deviceId, remoteHost, remotePort)
      let entry = entries.get(key)
      const target = options.targetOf(deviceId)
      if (!target) throw new ForwardError('this device is not an ssh device configured in Litch')
      if (entry?.target && entry.target !== targetKey(target)) {
        drop(entry)
        entry = undefined
      }
      if (!entry) {
        entry = {
          key,
          deviceId,
          remoteHost,
          remotePort,
          target: '',
          localPort: null,
          child: null,
          starting: null,
          running: false,
          startedAt: 0,
          lastUsed: Date.now(),
          quickFails: 0,
          restart: null,
          problem: null,
          closed: false,
        }
        entries.set(key, entry)
        if (!sweeper) {
          sweeper = setInterval(sweep, sweepMs)
          sweeper.unref()
        }
      }
      entry.lastUsed = Date.now()
      if (entry.running && entry.localPort !== null && entry.child) return entry.localPort
      // 在退避着等重起：不等了，当场起
      if (entry.restart) {
        clearTimeout(entry.restart)
        entry.restart = null
      }
      const mine = entry
      try {
        return await start(mine)
      } catch (error) {
        // 这一次没起来：不留着它，下一次从头再起
        if (!mine.running) drop(mine)
        throw error instanceof ForwardError ? error : new ForwardError(String(error))
      }
    },

    local(deviceId, localPort) {
      for (const entry of entries.values()) {
        if (entry.deviceId === deviceId && entry.localPort === localPort) {
          const problem =
            entry.problem && Date.now() - entry.problem.at < PROBLEM_MS ? entry.problem.line : null
          return {
            remoteHost: entry.remoteHost,
            remotePort: entry.remotePort,
            running: entry.running,
            problem,
          }
        }
      }
      // 撤掉了、但本机端口还记着：打开着的标签刷新时按它重起
      for (const [key, port] of ports) {
        if (port !== localPort) continue
        const [owner, remoteHost, remotePort] = key.split('\n')
        if (owner === deviceId && remoteHost) {
          return { remoteHost, remotePort: Number(remotePort), running: false, problem: null }
        }
      }
      return null
    },

    list() {
      return [...entries.values()]
        .filter((entry) => entry.localPort !== null)
        .map((entry) => ({
          deviceId: entry.deviceId,
          remoteHost: entry.remoteHost,
          remotePort: entry.remotePort,
          localPort: entry.localPort as number,
          pid: entry.child?.pid ?? null,
          running: entry.running,
        }))
    },

    close(deviceId) {
      for (const entry of [...entries.values()]) {
        if (deviceId === undefined || entry.deviceId === deviceId) drop(entry)
      }
    },
  }
}
