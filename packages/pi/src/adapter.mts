#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { backgroundShellEnabled } from '../../shared/src/background-shell.mjs'
import { cliCommand } from '../../shared/src/host-cli.mjs'
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
import { approvalsEnabled } from './approvals.mjs'
import { hostPi, runtimeInfo, validateInstalledVersions, versions } from './versions.mjs'

async function main(): Promise<void> {
  validateInstalledVersions()
  const args = process.argv.slice(2)
  if (args[0] === '--version' || args[0] === '-V') {
    process.stdout.write(`${codexCliVersion(versions.protocol, 'codex-harness-adapter-pi')}\n`)
    return
  }
  if (args[0] === '--runtime-info') {
    if (!isVersionAtLeast(process.versions.node, versions.node))
      throw new Error(`需要 Node >= ${versions.node}`)
    const info = runtimeInfo(approvalsEnabled(), backgroundShellEnabled())
    // 实际加载一次，接口不兼容的 Pi 在检测阶段就报出来，而不是等到启动后崩溃。
    await import('./sdk.mjs')
    const [command, ...cliArgs] = cliCommand(hostPi().cli, ['--version'])
    const cli = spawnSync(command!, cliArgs, {
      encoding: 'utf8',
      timeout: 10000,
    })
    if (cli.error || cli.status !== 0 || !isVersionAtLeast(cli.stdout.trim(), versions.cli))
      throw new Error(`需要用户安装的 Pi CLI >= ${versions.cli}；可用 PI_CLI 指定路径`)
    process.stdout.write(
      `${JSON.stringify({ ...info, cliBuild: cli.stdout.trim(), cliPath: hostPi().cli })}\n`,
    )
    return
  }
  if (args[0] === '--pty-self-check') {
    await ptyCheck()
    return
  }
  if (args[0] !== 'app-server')
    throw new Error(
      '用法: codex-harness-adapter-pi app-server [--listen stdio://|unix://PATH|ws://HOST:PORT]',
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
  // 加载用户安装的 Pi 可能失败；放在入口内部，错误只输出可操作的提示，--version 也不依赖 Pi。
  const { PiServer } = await import('./server.mjs')
  // 照 Pi 命令行把设置里的 httpProxy 补进环境变量（环境里已有的不动）
  ;(await import('./http-proxy.mjs')).applyHttpProxy()
  // 问不问用户、带不带后台 shell 在这里定下：环境变量由命令行那一层按设置 harness.pi.approvals、
  // harness.pi.backgroundShell 给出，改了要重启运行时。
  const server = new PiServer(
    resolve(process.env.CHA_PI_HOME ?? join(homedir(), '.codex-harness-adapter/pi')),
    { approvals: approvalsEnabled(), backgroundShell: backgroundShellEnabled() },
  )
  let transport: Awaited<ReturnType<typeof startWebSocketTransport>>
  let closing = false
  const close = async () => {
    if (closing) return
    closing = true
    await server.close()
    await transport?.close()
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
    process.once(signal, () => void close().then(() => process.exit(0)))
  // 没走到收场就退出的（未捕获的异常等）：同步杀掉还在跑的后台命令，免得留下孤儿进程组
  process.once('exit', () => server.shells?.killAllSync())
}
async function ptyCheck(): Promise<void> {
  const rpc = new ProcessRpc((command) => command)
  let output = '',
    done: (value: any) => void = () => {}
  const ended = new Promise<any>((resolve) => {
    done = resolve
  })
  const peer: RpcPeer = {
    id: 'pi-pty-check',
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
    if (result.exitCode !== 0 || !output.includes('7 13')) throw new Error('Pi PTY 自检失败')
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
