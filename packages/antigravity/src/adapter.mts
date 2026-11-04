#!/usr/bin/env node
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { CODEX_PROTOCOL_VERSION, codexCliVersion } from '../../shared/src/runtime-version.mjs'
import {
  normalizeListenUrl,
  parseProxySockArg,
  runProxy,
  startStdioTransport,
  startWebSocketTransport,
} from '../../shared/src/transports.mjs'
import type { RpcPeer } from '../../shared/src/types.mjs'
import { AntigravityRouter } from './router.mjs'

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  const home = resolve(
    process.env.CHA_ANTIGRAVITY_HOME ?? join(homedir(), '.codex-harness-adapter/agy'),
  )
  if (args[0] === '--version' || args[0] === '-V') {
    console.log(codexCliVersion(CODEX_PROTOCOL_VERSION, 'codex-harness-adapter-antigravity'))
    return
  }
  if (args[0] === '--runtime-info') {
    const router = new AntigravityRouter(home)
    const peer: RpcPeer = {
      id: 'info',
      close() {},
      send(message) {
        if (!('method' in message) && message.id === 2) {
          if (message.error) throw new Error(message.error.message)
          console.log(JSON.stringify(message.result))
        }
      },
    }
    try {
      await router.handle(peer, { id: 1, method: 'initialize', params: {} })
      await router.handle(peer, { id: 2, method: 'runtime/info' })
    } finally {
      await router.close()
    }
    return
  }
  if (args[0] !== 'app-server')
    throw new Error('用法: antigravity app-server [--listen stdio://|unix://PATH|ws://HOST:PORT]')
  if (args.includes('proxy')) {
    await runProxy(parseProxySockArg(args.slice(args.indexOf('proxy') + 1)))
    return
  }
  const at = args.indexOf('--listen')
  const listen = normalizeListenUrl(at < 0 ? 'stdio://' : (args[at + 1] ?? 'stdio://'))
  if (listen === 'off') return
  const server = new AntigravityRouter(home)
  let transport: Awaited<ReturnType<typeof startWebSocketTransport>> | undefined
  let closing: Promise<void> | undefined
  const close = () =>
    (closing ??= (async () => {
      await server.close()
      await transport?.close()
    })())
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
}
main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : 'Antigravity 启动失败'}\n`)
  process.exitCode = 1
})
