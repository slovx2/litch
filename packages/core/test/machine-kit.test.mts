// litch_machine 执行器测试用的假机器和假调用上下文（这个文件没有用例，只给 machine-*.test.mts 引用；
// 名字带 .test 是因为测试目录里归甲线的只有 machine-*.test.mts）。
//
// 假机器照协议原有的 process/*、fs/* 应答，背后是内存里的文件树（支持符号链接）。执行器的小脚本按脚本原文认出来，
// 在内存里照它的意思做；exec 的外壳起的进程不真的跑，由测试喂输出、让它退出。时钟是假的。
import { RpcError } from '../src/connection/rpc.mjs'
import { scriptCommand } from '../src/device/machine/scripts.mjs'
import type {
  MachineApprovalRequest,
  MachineApprovalResult,
  MachineCallContext,
  MachineFacts,
  MachineLogNote,
  MachinePolicy,
  MachineTarget,
} from '../src/device/machine/types.mjs'
import { decodeBase64, decodeUtf8, encodeBase64, encodeUtf8 } from '../src/text/bytes.mjs'
import { normalizePath } from '../src/text/paths.mjs'

type Node =
  | { type: 'd' }
  | { type: 'f'; data: Uint8Array }
  | { type: 'l'; link: string }
  | { type: 'o' }

const join = (base: string, part: string) => (base === '/' ? `/${part}` : `${base}/${part}`)

export class VirtualFs {
  readonly nodes = new Map<string, Node>([['/', { type: 'd' }]])
  mtime = 1_700_000_000

  /** 解开符号链接。不存在的部分原样接在后面，node 为空 */
  resolve(path: string, followLast = true, depth = 0): { real: string; node: Node | undefined } {
    if (depth > 40) return { real: path, node: undefined }
    const parts = normalizePath(path).split('/').filter(Boolean)
    let cur = '/'
    for (let at = 0; at < parts.length; at++) {
      const next = join(cur, parts[at] ?? '')
      const node = this.nodes.get(next)
      if (!node) return { real: [next, ...parts.slice(at + 1)].join('/'), node: undefined }
      if (node.type === 'l' && (followLast || at < parts.length - 1)) {
        const target = node.link.startsWith('/') ? node.link : join(cur, node.link)
        const inner = this.resolve(target, true, depth + 1)
        if (!inner.node)
          return { real: [inner.real, ...parts.slice(at + 1)].join('/'), node: undefined }
        cur = inner.real
      } else cur = next
    }
    return { real: cur, node: this.nodes.get(cur) }
  }

  mkdirp(path: string): void {
    const parts = normalizePath(path).split('/').filter(Boolean)
    let cur = '/'
    for (const part of parts) {
      const next = join(cur, part)
      const found = this.resolve(next)
      if (!found.node) this.nodes.set(found.real, { type: 'd' })
      else if (found.node.type !== 'd') throw new Error(`not a directory: ${next}`)
      cur = found.real
    }
  }

  write(path: string, data: Uint8Array | string): void {
    const bytes = typeof data === 'string' ? encodeUtf8(data) : data
    const found = this.resolve(path)
    const parent = found.real.slice(0, found.real.lastIndexOf('/')) || '/'
    if (this.nodes.get(parent)?.type !== 'd')
      throw new RpcError(-32603, `No such file or directory: ${path}`)
    if (found.node?.type === 'd') throw new RpcError(-32603, `Is a directory: ${path}`)
    this.nodes.set(found.real, { type: 'f', data: bytes })
  }

  file(path: string, text: string | Uint8Array): void {
    this.mkdirp(path.slice(0, path.lastIndexOf('/')) || '/')
    this.write(path, text)
  }

  link(path: string, target: string): void {
    this.mkdirp(path.slice(0, path.lastIndexOf('/')) || '/')
    this.nodes.set(path, { type: 'l', link: target })
  }

  read(path: string): Uint8Array {
    const found = this.resolve(path)
    if (found.node?.type !== 'f') throw new RpcError(-32603, `No such file: ${path}`)
    return found.node.data
  }

  text(path: string): string {
    return decodeUtf8(this.read(path))
  }

  /** 一层的孩子（按名字排好） */
  children(dir: string): string[] {
    const prefix = dir === '/' ? '/' : `${dir}/`
    return [...this.nodes.keys()]
      .filter(
        (key) => key !== dir && key.startsWith(prefix) && !key.slice(prefix.length).includes('/'),
      )
      .sort()
  }
}

/** 测试里 exec 起的一个进程 */
export interface FakeProc {
  handle: string
  command: string[]
  cwd: string
  timeoutMs: number | null
  stdin: string
  stdinClosed: boolean
  done: boolean
  /** 外壳报的进程号 */
  pid: number
  emit(stream: 'stdout' | 'stderr', text: string): void
  exit(code: number): void
}

const SCRIPT = {
  probe: scriptCommand.probe('/', [])[2],
  list: scriptCommand.list('/', 1, false, [])[2],
  readRange: scriptCommand.readRange('/', 0, 1)[2],
  write: scriptCommand.write('/')[2],
  append: scriptCommand.append('/')[2],
  signal: scriptCommand.signal('SIGINT', 2)[2],
}

const later = () => new Promise<void>((resolve) => setImmediate(resolve))

export class FakeMachine implements MachineTarget {
  readonly id: string
  readonly role: 'session' | 'desktop' | 'other'
  readonly fs = new VirtualFs()
  info: MachineFacts
  online = true
  /** 收到的请求（方法和参数） */
  readonly requests: { method: string; params: Record<string, unknown> }[] = []
  readonly procs = new Map<string, FakeProc>()
  /** exec 起的进程，按先后 */
  readonly execs: FakeProc[] = []
  readonly signals: { signal: string; pid: number }[] = []
  /** exec 的进程起来之后调它（测试在这里决定输出什么、什么时候退出） */
  onExec: ((proc: FakeProc) => void) | null = null
  private readonly handlers = new Set<(method: string, params: unknown) => boolean>()
  private pids = 4000
  /** 起过的脚本，按种类数 */
  readonly scripts: Record<string, number> = {}

  constructor(id: string, role: 'session' | 'desktop' | 'other', info: Partial<MachineFacts> = {}) {
    this.id = id
    this.role = role
    this.info = {
      name: info.name ?? `${id} machine`,
      hostname: info.hostname ?? `${id}.local`,
      system: info.system ?? 'macOS 26.5 arm64',
      user: info.user ?? 'song',
      home: info.home ?? '/Users/song',
      shell: info.shell ?? '/bin/zsh',
    }
    this.fs.mkdirp(this.info.home)
  }

  async facts(): Promise<MachineFacts> {
    if (!this.online) throw new Error('offline')
    return { ...this.info }
  }

  onProcessNotification(handler: (method: string, params: unknown) => boolean): () => void {
    this.handlers.add(handler)
    return () => this.handlers.delete(handler)
  }

  /** 注册着几个通知的接收者（进程收尾之后应该退订） */
  get listeners(): number {
    return this.handlers.size
  }

  private notify(method: string, params: unknown): void {
    for (const handler of [...this.handlers]) if (handler(method, params)) return
  }

  async request(method: any, params: any): Promise<any> {
    this.requests.push({ method, params })
    if (!this.online) throw new RpcError(-32000, 'offline')
    await Promise.resolve()
    switch (method) {
      case 'fs/readFile':
        return { dataBase64: encodeBase64(this.fs.read(params.path)) }
      case 'fs/writeFile':
        this.fs.write(params.path, decodeBase64(params.dataBase64))
        return {}
      case 'fs/createDirectory':
        this.fs.mkdirp(params.path)
        return {}
      case 'process/spawn':
        return this.spawn(params)
      case 'process/writeStdin': {
        const proc = this.procs.get(params.processHandle)
        if (!proc || proc.done)
          throw new RpcError(
            -32600,
            `no active process for process handle "${params.processHandle}"`,
          )
        if (params.deltaBase64) {
          if (proc.stdinClosed) throw new RpcError(-32600, 'stdin is already closed')
          proc.stdin += decodeUtf8(decodeBase64(params.deltaBase64))
          this.stdinBytes.set(proc.handle, [
            ...(this.stdinBytes.get(proc.handle) ?? []),
            decodeBase64(params.deltaBase64),
          ])
        }
        if (params.closeStdin) {
          proc.stdinClosed = true
          this.closed.get(proc.handle)?.()
        }
        return {}
      }
      case 'process/kill': {
        const proc = this.procs.get(params.processHandle)
        if (!proc || proc.done)
          throw new RpcError(
            -32600,
            `no active process for process handle "${params.processHandle}"`,
          )
        later().then(() => proc.exit(137))
        return {}
      }
      default:
        throw new RpcError(-32601, `unknown method ${method}`)
    }
  }

  private readonly stdinBytes = new Map<string, Uint8Array[]>()
  private readonly closed = new Map<string, () => void>()

  private spawn(params: Record<string, unknown>): Record<string, never> {
    const command = params.command as string[]
    const handle = params.processHandle as string
    const proc: FakeProc = {
      handle,
      command,
      cwd: params.cwd as string,
      timeoutMs: (params.timeoutMs as number | null) ?? null,
      stdin: '',
      stdinClosed: false,
      done: false,
      pid: ++this.pids,
      emit: (stream, text) => {
        if (proc.done) return
        this.notify('process/outputDelta', {
          processHandle: handle,
          stream,
          deltaBase64: encodeBase64(encodeUtf8(text)),
          capReached: false,
        })
      },
      exit: (code) => {
        if (proc.done) return
        proc.done = true
        this.notify('process/exited', {
          processHandle: handle,
          exitCode: code,
          stdout: '',
          stderr: '',
          stdoutCapReached: false,
          stderrCapReached: false,
        })
      },
    }
    this.procs.set(handle, proc)
    const script = command[2] ?? ''
    if (script.includes('litch-pid')) {
      this.execs.push(proc)
      later().then(() => {
        proc.emit('stderr', `\u001elitch-pid ${proc.pid}\n`)
        this.onExec?.(proc)
      })
      return {}
    }
    const kind = Object.entries(SCRIPT).find(([, text]) => text === script)?.[0]
    if (!kind)
      throw new RpcError(-32603, `fake machine does not know this command: ${command.join(' ')}`)
    this.scripts[kind] = (this.scripts[kind] ?? 0) + 1
    const args = command.slice(4)
    const run = async () => {
      await later()
      const bytes = (data: Uint8Array) =>
        this.notify('process/outputDelta', {
          processHandle: handle,
          stream: 'stdout',
          deltaBase64: encodeBase64(data),
          capReached: false,
        })
      try {
        if (kind === 'probe') bytes(encodeUtf8(this.probe(args)))
        else if (kind === 'list') bytes(encodeUtf8(this.list(args)))
        else if (kind === 'readRange') {
          const data = this.fs.read(args[0] ?? '')
          const from = Number(args[1]) - 1
          bytes(data.subarray(from, from + Number(args[2])))
        } else if (kind === 'write' || kind === 'append') {
          if (!proc.stdinClosed)
            await new Promise<void>((resolve) => this.closed.set(handle, resolve))
          const chunks = this.stdinBytes.get(handle) ?? []
          const before = kind === 'append' ? this.fs.read(args[0] ?? '') : new Uint8Array(0)
          const total = [before, ...chunks].reduce((sum, chunk) => sum + chunk.length, 0)
          const all = new Uint8Array(total)
          let at = 0
          for (const chunk of [before, ...chunks]) {
            all.set(chunk, at)
            at += chunk.length
          }
          this.fs.write(args[0] ?? '', all)
        } else if (kind === 'signal')
          this.signals.push({
            signal: args[0] ?? '',
            pid: Number((args[1] ?? '').replace('-', '')),
          })
        proc.exit(0)
      } catch (error) {
        proc.emit('stderr', error instanceof Error ? error.message : String(error))
        proc.exit(1)
      }
    }
    run()
    return {}
  }

  private probe(args: string[]): string {
    const [path = '/', ...denied] = args
    const found = this.fs.resolve(path)
    const node = found.node
    const type = !node ? 'm' : node.type
    const size = node?.type === 'f' ? String(node.data.length) : '0'
    return [found.real, type, size, ...denied.map((one) => this.fs.resolve(one).real)]
      .map((one) => `${one}\0`)
      .join('')
  }

  private list(args: string[]): string {
    const [root = '/', depthText = '', icase = '0', ...prune] = args
    const patterns = prune.map((one) => one.replace(/\\(.)/g, '$1'))
    const matches = (path: string) =>
      patterns.some((one) =>
        icase === '1' ? one.toLowerCase() === path.toLowerCase() : one === path,
      )
    const depth = depthText ? Number(depthText) : Number.POSITIVE_INFINITY
    const out: string[] = []
    const walk = (dir: string, level: number) => {
      for (const child of this.fs.children(dir)) {
        const node = this.fs.nodes.get(child)
        if (!node) continue
        const size = node.type === 'f' ? node.data.length : node.type === 'd' ? 64 : 0
        const link = node.type === 'l' ? node.link : ''
        out.push(`${node.type}\t${size}\t${this.fs.mtime}\t${link}\t${child}\0`)
        if (node.type === 'd' && level < depth && !matches(child)) walk(child, level + 1)
      }
    }
    walk(root, 1)
    return out.join('')
  }
}

/** 假的调用上下文：审批按 answers 依次答，记下问了什么、记了什么 */
export function fakeContext(
  machines: FakeMachine[],
  options: {
    denied?: string[]
    answers?: MachineApprovalResult[]
    deviceId?: string
    signal?: { aborted: boolean; addEventListener(type: 'abort', listener: () => void): void }
  } = {},
) {
  const asks: MachineApprovalRequest[] = []
  const logs: MachineLogNote[] = []
  const answers = [...(options.answers ?? [])]
  const policy: MachinePolicy = {
    mode: options.denied?.length ? 'custom' : 'open',
    denied: options.denied ?? [],
  }
  const controller = new AbortController()
  const context: MachineCallContext = {
    owner: { deviceId: options.deviceId ?? 'dev-a', threadId: 'thread-1', harness: 'codex' },
    target: (id) => machines.find((one) => one.id === id || one.role === id) ?? null,
    targets: () => machines,
    policy,
    settings: { approval: 'session', access: policy.mode },
    async approve(request) {
      asks.push(request)
      return answers.shift() ?? { kind: 'allowed' }
    },
    log: (note) => logs.push(note),
    signal: options.signal ?? controller.signal,
  }
  return { context, asks, logs, abort: () => controller.abort() }
}

/** 答复里的文字合起来 */
export const textOf = (response: { contentItems: { type: string; text?: string }[] }) =>
  response.contentItems.map((item) => item.text ?? '').join('\n')

export { later }
