#!/usr/bin/env node
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
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
import { OpencodeServer } from './server.mjs'
import { runtimeInfo, versions } from './versions.mjs'

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  if (args[0] === '--version' || args[0] === '-V') {
    process.stdout.write(
      `${codexCliVersion(versions.protocol, 'codex-harness-adapter-opencode')}\n`,
    )
    return
  }
  if (args[0] === '--runtime-info') {
    // runtimeInfo 会定位用户安装的 OpenCode 并核对版本下限，找不到或过低时在这里报错。
    if (!isVersionAtLeast(process.versions.node, versions.node))
      throw new Error(`需要 Node >= ${versions.node}`)
    process.stdout.write(`${JSON.stringify(runtimeInfo(backgroundShellEnabled()))}\n`)
    return
  }
  if (args[0] === '--pty-self-check') {
    await ptyCheck()
    return
  }
  if (args[0] !== 'app-server')
    throw new Error(
      '用法: codex-harness-adapter-opencode app-server [--listen stdio://|unix://PATH|ws://HOST:PORT]',
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
  // 带不带后台 shell 在这里定下：环境变量由命令行那一层按设置 harness.opencode.backgroundShell 给出
  const server = new OpencodeServer(
    resolve(process.env.CHA_OPENCODE_HOME ?? join(homedir(), '.codex-harness-adapter/opencode')),
    { backgroundShell: backgroundShellEnabled() },
  )
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
}

async function ptyCheck(): Promise<void> {
  const rpc = new ProcessRpc((command) => command)
  let output = ''
  let done: (value: any) => void = () => {}
  const ended = new Promise<any>((resolve) => {
    done = resolve
  })
  const peer: RpcPeer = {
    id: 'opencode-pty-check',
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
