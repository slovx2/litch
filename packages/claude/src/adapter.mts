#!/usr/bin/env node
import { chmodSync, existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { ProcessRpc } from '../../shared/src/process-rpc.mjs'
import {
  normalizeListenUrl,
  parseProxySockArg,
  runProxy,
  startStdioTransport,
  startWebSocketTransport,
} from '../../shared/src/transports.mjs'
import { buildInfo } from './build-info.mjs'
import { sandboxCommand } from './command-sandbox.mjs'
import { createRuntime } from './runtime-factory.mjs'
import { CodexClaudeAppServer } from './server.mjs'
import { loadRuntimeModelCatalog } from './server-helpers.mjs'
import { SessionStore } from './store.mjs'
import type { RpcPeer } from './types.mjs'
import { debugLog, defaultSocketPath, ensureParent } from './util.mjs'

// Install global crash guards FIRST, before anything else can fail. Without
// these, a single uncaught rejection or a synchronous EPIPE from a write to a
// half-closed peer (Codex App's SSH stream blipping mid-stream) silently kills
// the daemon — observed as pid churn (one daemon process per few minutes)
// with no error trace in debug.jsonl. Logging here puts the cause on disk
// AND keeps the daemon alive so the App's reconnect is a no-op.
process.on('uncaughtException', (error: unknown) => {
  const err = error as NodeJS.ErrnoException
  const code = err?.code ?? null
  const isExpected = code === 'EPIPE' || code === 'ECONNRESET' || code === 'EBADF'
  debugLog('adapter.uncaughtException', {
    code,
    message: err?.message ?? String(error),
    stack: err?.stack ?? null,
    swallowed: isExpected,
  })
  // EPIPE/ECONNRESET from peer disconnects are routine; swallow them so the
  // daemon keeps serving other peers. Anything else keeps normal crash
  // semantics: exit so the host restarts the runtime. Re-throwing here would
  // re-enter this handler forever and spin the event loop.
  if (!isExpected) {
    process.exitCode = 1
    setImmediate(() => process.exit(1))
  }
})
process.on('unhandledRejection', (reason: unknown) => {
  const err = reason as NodeJS.ErrnoException
  debugLog('adapter.unhandledRejection', {
    code: err?.code ?? null,
    message: err?.message ?? String(reason),
    stack: err?.stack ?? null,
  })
  // Node ≥ 15 defaults to crashing on unhandled rejection. Keep the daemon
  // up; we have logging now, so silent death is no longer a risk.
})

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  if (args[0] === '--runtime-info') {
    process.stdout.write(`${JSON.stringify(buildInfo())}\n`)
    return
  }
  if (args[0] === '--pty-self-check') {
    await ptySelfCheck()
    return
  }
  if (args[0] !== 'app-server') {
    usage(1)
    return
  }

  const proxyIndex = args.indexOf('proxy')
  if (proxyIndex >= 0) {
    await runProxy(parseProxySockArg(args.slice(proxyIndex + 1)))
    return
  }

  if (args.includes('--help') || args.includes('-h')) {
    usage(0)
    return
  }

  const listen = getArg(args, '--listen') ?? 'stdio://'
  if (listen === 'off') return
  const isUnixDaemon = listen.startsWith('unix://')
  let pidFile: string | null = null
  if (isUnixDaemon) {
    pidFile = ensureSingleUnixDaemon(listen)
  }

  const store = new SessionStore()
  // 流式的字是先记着、要读写回合时才写进库的。没经 server.stop() 就退出时（没接住的异常走的是
  // process.exit）在这里补写一次；正常停止时库已经关了、也没有记着的，这里什么都不做。
  process.once('exit', () => {
    try {
      store.flushAll()
    } catch {}
  })
  // Codex cc normally launches the app-server over stdio, so a crashed or
  // force-quit adapter leaves its last turn persisted as `inProgress`. The
  // next stdio process is the recovery boundary just like the unix daemon;
  // only recovering unix transports leaves the App's subagent view stuck on
  // "loading" forever after a restart.
  const recovered = store.recoverStaleInProgressTurns()
  if (recovered > 0) {
    process.stderr.write(
      `[codex-harness-adapter] recovered ${recovered} stale in-progress turn(s)\n`,
    )
  }
  const runtime = createRuntime()
  // 持久化模型的校验与首个 model/list 都依赖原生目录，须在构造服务前读取。
  await loadRuntimeModelCatalog(runtime)
  const server = new CodexClaudeAppServer(store, runtime)
  let shuttingDown = false
  const shutdown = async (reason: string) => {
    if (shuttingDown) return
    shuttingDown = true
    debugLog('adapter.shutdown', { reason, pid: process.pid })
    await server.stop()
    if (pidFile) {
      try {
        unlinkSync(pidFile)
      } catch {}
    }
    process.exit(0)
  }
  process.once('SIGINT', () => void shutdown('SIGINT'))
  process.once('SIGTERM', () => void shutdown('SIGTERM'))
  process.once('SIGHUP', () => void shutdown('SIGHUP'))
  debugLog('adapter.start', { pid: process.pid, listen, isUnixDaemon })

  const onMessage = server.handle.bind(server)
  const normalized = normalizeListenUrl(listen)
  const isStdio = normalized === 'stdio://'

  // When the Codex client (app-server proxy) disconnects, a `unix://` daemon
  // would otherwise linger forever and keep its Claude runtime sidecar alive.
  // Exit once the last peer is gone so the runtime socket closes and the
  // sidecar is reclaimed. Codex App re-probes and restarts the daemon on
  // reconnect. Set CHA_CLAUDE_IDLE_EXIT_MS=0 to keep the legacy persistent
  // behavior.
  const idleExitMs = Number(process.env.CHA_CLAUDE_IDLE_EXIT_MS ?? 15000)
  const idleExitEnabled = isUnixDaemon && Number.isFinite(idleExitMs) && idleExitMs > 0
  let activePeers = 0
  let everConnected = false
  let idleTimer: NodeJS.Timeout | null = null
  const cancelIdleExit = () => {
    if (idleTimer) {
      clearTimeout(idleTimer)
      idleTimer = null
    }
  }
  const armIdleExit = () => {
    if (
      !idleExitEnabled ||
      activePeers > 0 ||
      !everConnected ||
      idleTimer ||
      server.hasActiveTurns()
    )
      return
    idleTimer = setTimeout(() => {
      debugLog('adapter.idleExit', { idleExitMs, pid: process.pid })
      process.stderr.write(
        `[codex-harness-adapter] no active peers for ${idleExitMs}ms, shutting down\n`,
      )
      void shutdown('idleExit')
    }, idleExitMs)
    idleTimer.unref()
  }
  server.setIdleCheckHandler(armIdleExit)
  const onConnect = (_peer: RpcPeer) => {
    everConnected = true
    activePeers += 1
    cancelIdleExit()
  }
  const onClose = (peer: RpcPeer) => {
    activePeers = Math.max(0, activePeers - 1)
    server.closePeer(peer, isStdio)
    if (isStdio) {
      // A stdio peer is the process lifetime. If Codex closes its pipe during
      // reconnect, stop the runtime and terminalize all child turns before the
      // process exits; otherwise the old in-memory subagent can remain active
      // while the replacement adapter is already serving the same database.
      void shutdown('stdioClose')
      return
    }
    armIdleExit()
  }

  if (normalized === 'stdio://') {
    startStdioTransport(onMessage, onClose)
    return
  }
  await startWebSocketTransport(normalized, onMessage, onClose, onConnect)
}

// 打包后的自检：用假 peer 驱动 ProcessRpc 跑一次真实 PTY，确认伪终端桥（命令行的 pty-bridge 子命令）随包可用。
async function ptySelfCheck(): Promise<void> {
  const processes = new ProcessRpc(sandboxCommand)
  let output = ''
  let notify: (params: Record<string, unknown>) => void = () => {}
  const exited = new Promise<Record<string, unknown>>((resolve) => {
    notify = resolve
  })
  const peer: RpcPeer = {
    id: 'pty-self-check',
    send: (message) => {
      if (!('method' in message)) return
      // tty 的输出只能通过流式通知拿到。
      if (message.method === 'process/outputDelta')
        output += Buffer.from(
          String((message.params as Record<string, unknown>).deltaBase64 ?? ''),
          'base64',
        ).toString('utf8')
      else if (message.method === 'process/exited')
        notify(message.params as Record<string, unknown>)
    },
    close: () => {},
  }
  let timer: NodeJS.Timeout | undefined
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error('PTY 自检超时：没有收到 process/exited')), 10_000)
  })
  try {
    await processes.start(peer, 'process', {
      processHandle: 'pty-self-check',
      cwd: process.cwd(),
      tty: true,
      size: { rows: 7, cols: 13 },
      command: [
        process.execPath,
        '-e',
        'if (!process.stdin.isTTY || !process.stdout.isTTY) process.exit(1); console.log(process.stdout.rows + " " + process.stdout.columns)',
      ],
    })
    const result = await Promise.race([exited, timeout])
    if (result.exitCode !== 0) throw new Error(`PTY 自检退出码为 ${result.exitCode}`)
    if (!output.includes('7 13'))
      throw new Error(`PTY 自检输出不含尺寸 7 13：${JSON.stringify(output)}`)
    process.stdout.write('pty-self-check ok\n')
  } finally {
    clearTimeout(timer)
    await processes.close()
  }
}

function getArg(args: string[], name: string): string | null {
  const index = args.indexOf(name)
  if (index >= 0) return args[index + 1] ?? null
  const prefix = `${name}=`
  const inline = args.find((arg) => arg.startsWith(prefix))
  return inline ? inline.slice(prefix.length) : null
}

function ensureSingleUnixDaemon(listen: string): string {
  const socketPath = listen === 'unix://' ? defaultSocketPath() : listen.slice('unix://'.length)
  const pidFile = `${socketPath}.pid`
  ensureParent(socketPath)
  if (existsSync(pidFile)) {
    const pid = Number(readFileSync(pidFile, 'utf8'))
    if (Number.isFinite(pid) && processIsAlive(pid)) {
      process.stderr.write(
        `[codex-harness-adapter] app-server already running at ${socketPath} (pid ${pid})\n`,
      )
      process.exit(0)
    }
  }
  try {
    if (existsSync(socketPath)) unlinkSync(socketPath)
  } catch {}
  writeFileSync(pidFile, `${process.pid}\n`, { mode: 0o600 })
  try {
    chmodSync(dirname(socketPath), 0o700)
  } catch {}
  return pidFile
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function usage(code: number): never {
  const text = `Usage:
  codex-harness-adapter app-server --listen stdio://
  codex-harness-adapter app-server --listen unix://
  codex-harness-adapter app-server --listen ws://127.0.0.1:8788
  codex-harness-adapter app-server proxy [--sock PATH]
`
  ;(code === 0 ? process.stdout : process.stderr).write(text)
  process.exit(code)
}

main().catch((error) => {
  process.stderr.write(
    `[codex-harness-adapter] ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
  )
  process.exit(1)
})
