#!/usr/bin/env node
import { resolve } from 'node:path'
import { backgroundShellEnabled } from '../../shared/src/background-shell.mjs'
import { isVersionAtLeast } from '../../shared/src/min-version.mjs'
import { ProcessRpc } from '../../shared/src/process-rpc.mjs'
import { codexCliVersion } from '../../shared/src/runtime-version.mjs'
import {
  normalizeListenUrl,
  parseProxySockArg,
  runProxy,
  startStdioTransport,
  startWebSocketTransport,
} from '../../shared/src/transports.mjs'
import type { RpcPeer } from '../../shared/src/types.mjs'
import { agentId, agentSpec, BACKGROUND_SHELL_AGENTS } from './agent.mjs'
import { AcpRuntime } from './runtime.mjs'
import { AcpServer } from './server.mjs'
import { runtimeInfo, versions } from './versions.mjs'

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  if (args[0] === '--version' || args[0] === '-V') {
    process.stdout.write(
      `${codexCliVersion(versions.protocol, `codex-harness-adapter-${agentId()}`)}\n`,
    )
    return
  }
  if (args[0] === '--runtime-info') {
    if (!isVersionAtLeast(process.versions.node, versions.node))
      throw new Error(`需要 Node >= ${versions.node}`)
    await runtimeCheck()
    return
  }
  if (args[0] === '--pty-self-check') {
    await ptyCheck()
    return
  }
  if (args[0] !== 'app-server')
    throw new Error(
      '用法: codex-harness-adapter-acp app-server [--listen stdio://|unix://PATH|ws://HOST:PORT]',
    )
  if (args.includes('proxy')) {
    await runProxy(parseProxySockArg(args.slice(args.indexOf('proxy') + 1)))
    return
  }
  const listenIndex = args.indexOf('--listen')
  const listen = normalizeListenUrl(
    listenIndex < 0 ? 'stdio://' : (args[listenIndex + 1] ?? 'stdio://'),
  )
  if (listen === 'off') return
  const server = new AcpServer(resolve(agentSpec().home))
  let transport: Awaited<ReturnType<typeof startWebSocketTransport>>
  // 收场只做一遍：途中再被要求退出的（连接断了之后又来了结束信号）等的是同一遍，不半路退出。
  let closing: Promise<void> | null = null
  const close = (signalled = false): Promise<void> => {
    closing ??= (async () => {
      await server.close(signalled)
      await transport?.close()
    })()
    return closing
  }
  const onClose = (peer: RpcPeer) => {
    server.closePeer(peer)
    if (listen === 'stdio://') void close()
  }
  transport =
    listen === 'stdio://'
      ? startStdioTransport((peer, message) => server.handle(peer, message), onClose)
      : await startWebSocketTransport(
          listen,
          (peer, message) => server.handle(peer, message),
          onClose,
        )
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'])
    process.once(signal, () => void close(true).then(() => process.exit(0)))
  // 没走到收场就退出的（未捕获的异常等）：同步杀掉还在跑的后台命令，免得留下孤儿进程组
  process.once('exit', () => server.shells?.killAllSync())
}

/**
 * --runtime-info：起 agent 握一次手（只 initialize，不建会话、不发提示词），按它报的能力打出声明。
 * 没装、命令不对、协议版本不符都在这里报错（标准错误里的字样命令行的诊断要认，见 agent.mts、runtime.mts）。
 */
async function runtimeCheck(): Promise<void> {
  const id = agentId()
  const runtime = new AcpRuntime(resolve(agentSpec().home), {
    request: async () => null,
    notification: () => {},
    closed: () => {},
  })
  try {
    const agent = await runtime.agent()
    const shell = BACKGROUND_SHELL_AGENTS.has(id) && backgroundShellEnabled()
    process.stdout.write(`${JSON.stringify(runtimeInfo(id, agent.caps, shell))}\n`)
  } finally {
    await runtime.close()
  }
}

async function ptyCheck(): Promise<void> {
  const rpc = new ProcessRpc((command) => command)
  let output = ''
  let done: (value: any) => void = () => {}
  const ended = new Promise<any>((resolve) => {
    done = resolve
  })
  const peer: RpcPeer = {
    id: 'acp-pty-check',
    close() {},
    send(message) {
      if (!('method' in message)) return
      const p = message.params as any
      if (message.method === 'process/outputDelta')
        output += Buffer.from(p.deltaBase64, 'base64').toString()
      if (message.method === 'process/exited') done(p)
    },
  }
  const timeout = setTimeout(() => done({ exitCode: -1 }), 10000)
  try {
    await rpc.start(peer, 'process', {
      processHandle: 'check',
      cwd: process.cwd(),
      tty: true,
      size: { rows: 7, cols: 13 },
      command: [
        process.execPath,
        '-e',
        'if (!process.stdin.isTTY || !process.stdout.isTTY) process.exit(1); console.log(process.stdout.rows + " " + process.stdout.columns)',
      ],
    })
    const result = await ended
    if (result.exitCode !== 0 || !output.includes('7 13')) throw new Error('终端自检失败')
    process.stdout.write('pty-self-check ok\n')
  } finally {
    clearTimeout(timeout)
    await rpc.close()
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
})
