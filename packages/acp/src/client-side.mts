// agent 反过来请我们做的事：读写文件（fs/read_text_file、fs/write_text_file）和终端（terminal/*）。
// 握手时我们声明了这两样（runtime.mts），agent 就会用它们，而不是自己去读写、自己起进程：
// 这样改文件的内容我们看得到（出成改文件条目），命令的输出能一段一段地转给客户端。
import { type ChildProcess, spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute } from 'node:path'
import { StringDecoder } from 'node:string_decoder'
import { HandlerError } from './connection.mjs'

const absolute = (value: unknown, name: string): string => {
  if (typeof value !== 'string' || !isAbsolute(value))
    throw new HandlerError(-32602, `${name} 必须是绝对路径`)
  return value
}

/** fs/read_text_file：line 从 1 数，limit 是最多几行 */
export async function readTextFile(params: any): Promise<{ content: string }> {
  const path = absolute(params?.path, 'path')
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch (error: any) {
    throw new HandlerError(
      error?.code === 'ENOENT' ? -32002 : -32603,
      `读不了 ${path}：${error?.message ?? error}`,
    )
  }
  const line = typeof params.line === 'number' && params.line > 1 ? params.line : 1
  const limit = typeof params.limit === 'number' && params.limit > 0 ? params.limit : null
  if (line === 1 && limit === null) return { content: text }
  const lines = text.split('\n')
  return {
    content: lines.slice(line - 1, limit === null ? undefined : line - 1 + limit).join('\n'),
  }
}

/** fs/write_text_file：写之前读一遍原来的内容，返回给调用方去出改文件条目；原来没有这个文件的是 null */
export async function writeTextFile(
  params: any,
): Promise<{ path: string; before: string | null; after: string }> {
  const path = absolute(params?.path, 'path')
  if (typeof params.content !== 'string') throw new HandlerError(-32602, 'content 必须是字符串')
  const before = await readFile(path, 'utf8').catch(() => null)
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, params.content)
  return { path, before, after: params.content }
}

/** 终端输出最多留这么多字节（agent 没给 outputByteLimit 时），多了丢掉开头的 */
const DEFAULT_OUTPUT_LIMIT = 16 * 1024 * 1024
const KILL_GRACE_MS = 2_000

interface Terminal {
  id: string
  sessionId: string
  child: ChildProcess
  output: string
  bytes: number
  limit: number
  truncated: boolean
  exit: { exitCode: number | null; signal: string | null } | null
  exited: Promise<void>
}

/** agent 用的终端：一个终端就是一个子进程，输出留在内存里，等 agent 来取 */
export class Terminals {
  private readonly terminals = new Map<string, Terminal>()
  private readonly onOutput: (sessionId: string, terminalId: string, delta: string) => void

  constructor(onOutput: (sessionId: string, terminalId: string, delta: string) => void) {
    this.onOutput = onOutput
  }

  soFar(terminalId: string): string {
    return this.terminals.get(terminalId)?.output ?? ''
  }

  create(params: any): { terminalId: string } {
    if (typeof params?.command !== 'string' || !params.command)
      throw new HandlerError(-32602, 'command 必须是非空字符串')
    const args: string[] = Array.isArray(params.args) ? params.args.map(String) : []
    const env = { ...process.env }
    for (const entry of Array.isArray(params.env) ? params.env : [])
      if (typeof entry?.name === 'string') env[entry.name] = String(entry.value ?? '')
    // 会话号交给命令（litch-machine 按它把确认卡片放进这个会话，08 号设计 V3）：这里的会话号就是 ACP 的 sessionId。
    // 只有经客户端终端跑的命令有；agent 自己起的 shell 不经这里，给不了
    const sessionId = typeof params.sessionId === 'string' ? params.sessionId : ''
    if (sessionId) env.LITCH_THREAD_ID = sessionId
    else delete env.LITCH_THREAD_ID
    const cwd = typeof params.cwd === 'string' && isAbsolute(params.cwd) ? params.cwd : undefined
    // 只给了命令、没给参数的，多半是一整行 shell 命令：交给 sh 去解释
    const [command, argv] =
      args.length || process.platform === 'win32'
        ? [params.command, args]
        : ['/bin/sh', ['-c', params.command]]
    // 自成一个进程组：结束时连它起的子进程一起结束
    const child = spawn(command, argv, {
      cwd,
      env,
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: process.platform === 'win32' && !args.length,
    })
    const id = `term-${randomUUID()}`
    let done: () => void = () => {}
    const terminal: Terminal = {
      id,
      sessionId: String(params.sessionId ?? ''),
      child,
      output: '',
      bytes: 0,
      limit:
        typeof params.outputByteLimit === 'number' && params.outputByteLimit >= 0
          ? params.outputByteLimit
          : DEFAULT_OUTPUT_LIMIT,
      truncated: false,
      exit: null,
      exited: new Promise<void>((resolve) => {
        done = resolve
      }),
    }
    for (const stream of [child.stdout, child.stderr]) {
      const decoder = new StringDecoder('utf8')
      stream?.on('data', (chunk: Buffer) => this.append(terminal, decoder.write(chunk)))
      stream?.on('end', () => this.append(terminal, decoder.end()))
    }
    child.once('error', (error) => {
      this.append(terminal, `${error.message}\n`)
      terminal.exit ??= { exitCode: 127, signal: null }
      done()
    })
    child.once('close', (code, signal) => {
      terminal.exit ??= { exitCode: code, signal: signal ?? null }
      done()
    })
    this.terminals.set(id, terminal)
    return { terminalId: id }
  }

  private append(terminal: Terminal, text: string): void {
    if (!text) return
    this.onOutput(terminal.sessionId, terminal.id, text)
    terminal.output += text
    terminal.bytes += Buffer.byteLength(text)
    if (terminal.bytes <= terminal.limit) return
    // 超了上限：从开头丢，切在字符边界上
    const buffer = Buffer.from(terminal.output)
    let start = buffer.length - terminal.limit
    while (start < buffer.length && ((buffer[start] as number) & 0xc0) === 0x80) start++
    terminal.output = buffer.subarray(start).toString()
    terminal.bytes = buffer.length - start
    terminal.truncated = true
  }

  private get(params: any): Terminal {
    const terminal = this.terminals.get(String(params?.terminalId ?? ''))
    if (!terminal) throw new HandlerError(-32602, `没有这个终端：${params?.terminalId}`)
    return terminal
  }

  output(params: any): any {
    const terminal = this.get(params)
    return {
      output: terminal.output,
      truncated: terminal.truncated,
      ...(terminal.exit ? { exitStatus: terminal.exit } : {}),
    }
  }

  async waitForExit(params: any): Promise<any> {
    const terminal = this.get(params)
    await terminal.exited
    return terminal.exit
  }

  async kill(params: any): Promise<Record<string, never>> {
    await this.stop(this.get(params))
    return {}
  }

  async release(params: any): Promise<Record<string, never>> {
    const terminal = this.get(params)
    this.terminals.delete(terminal.id)
    await this.stop(terminal)
    return {}
  }

  private async stop(terminal: Terminal): Promise<void> {
    if (terminal.exit) return
    const signal = (name: NodeJS.Signals) => {
      try {
        if (process.platform !== 'win32' && terminal.child.pid)
          process.kill(-terminal.child.pid, name)
        else terminal.child.kill(name)
      } catch {}
    }
    signal('SIGTERM')
    let timer: NodeJS.Timeout | undefined
    const quit = await Promise.race([
      terminal.exited.then(() => true),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(resolve, KILL_GRACE_MS, false)
      }),
    ])
    clearTimeout(timer)
    if (!quit) signal('SIGKILL')
  }

  /** 适配器收场、agent 退出：结束这些终端 */
  async closeAll(sessionId?: string): Promise<void> {
    const chosen = [...this.terminals.values()].filter(
      (terminal) => sessionId === undefined || terminal.sessionId === sessionId,
    )
    for (const terminal of chosen) this.terminals.delete(terminal.id)
    await Promise.all(chosen.map((terminal) => this.stop(terminal)))
  }
}
