#!/usr/bin/env node
// 设备进程的入口。常驻，由 Go 层拉起；就绪后在标准输出打一行 LITCH_DEVICE_READY。
import { createHash } from 'node:crypto'
import { dirname, join, win32 } from 'node:path'
import { adapterCliPath } from '../../shared/src/adapter-cli.mjs'
import { setSharedLogger } from '../../shared/src/util.mjs'
import { parseArgs, USAGE } from './args.mjs'
import { SocketControl } from './control.mjs'
import { DeviceServer } from './device.mjs'
import { deviceVersion } from './harness-info.mjs'
import {
  defaultAuthorizedKeys,
  defaultHostKeysDir,
  detectSshdVersion,
  readHostKeys,
  windowsAdmin,
} from './pair-host.mjs'
import type { PairingConfig } from './pairing.mjs'
import { watchParent } from './parent-watch.mjs'
import { listenUnix, parseSocketUrl, socketExists, unixConnector } from './sockets.mjs'

/** 就绪标记。Go 层和测试等的就是这一行 */
const READY_LINE = 'LITCH_DEVICE_READY'

/**
 * 适配器主进程在状态目录里监听的控制通道。位置是定死的，不经启动参数给：
 * 启动时这个套接字在，就说明有带设置功能的主进程在管；不在（旧版的主进程，或者设备进程是单独起的）
 * 就没有设置功能，别的照常。
 */
const CONTROL_SOCKET = 'ctl.sock'

/**
 * 控制通道的位置。Windows 上是命名管道，名字和 Go 层一样由状态目录算出来
 * （hostplatform.ControlSocketPath：filepath.Clean 之后转小写，取 SHA-256）
 */
function controlSocketPath(stateDir: string): string {
  if (process.platform !== 'win32') return join(stateDir, CONTROL_SOCKET)
  let clean = win32.normalize(stateDir)
  if (clean.length > 3 && clean.endsWith('\\')) clean = clean.slice(0, -1)
  const digest = createHash('sha256').update(clean.toLowerCase()).digest('hex')
  return `\\\\.\\pipe\\codex-harness-adapter-control-${digest}`
}

/** 扫码绑定手机要的这台机器的配置：钥匙文件和主机钥匙目录可以用环境变量换（测试用，见 pair-host.mts） */
function pairingConfig(stateDir: string): PairingConfig {
  const hostKeysDir = defaultHostKeysDir()
  return {
    keysFile: defaultAuthorizedKeys(),
    hostKeys: () => readHostKeys(hostKeysDir),
    adapterCli: adapterCliPath(),
    adapterHome: dirname(stateDir),
    // OpenSSH for Windows 的管理员账号只认 administrators_authorized_keys，改它要管理员权限，第一版不支持
    unsupported:
      process.platform === 'win32' && windowsAdmin()
        ? 'Windows 的管理员账号的钥匙在 administrators_authorized_keys 里，请手动添加'
        : null,
    sshdVersion: () => detectSshdVersion(),
  }
}

/** 就绪之前等主进程把各 harness 的状态送过来，最多等这么久：第一个连进来的客户端就能看到完整的名单 */
const CONTROL_READY_MS = 2000

async function main(): Promise<void> {
  const argv = process.argv.slice(2)
  if (argv[0] === '--version' || argv[0] === '-V') {
    process.stdout.write(`${deviceVersion()}\n`)
    return
  }
  if (argv[0] === '--help' || argv[0] === '-h') {
    process.stdout.write(`${USAGE}\n`)
    return
  }
  const args = parseArgs(argv)
  // 标准输出是接到 Go 进程的管道，标准错误接在日志上。对面没了以后再写会报错，
  // 常驻的进程不能因为这个崩掉（那样就来不及清理套接字了）
  process.stdout.on('error', () => {})
  process.stderr.on('error', () => {})
  const log = (line: string) => process.stderr.write(`[litch-device] ${line}\n`)
  // 排障用：复用的设备层实现（终端、文件监听、找文件）的调试输出，平时不开
  if (process.env.LITCH_DEVICE_DEBUG === '1')
    setSharedLogger((event, data) =>
      process.stderr.write(`[litch-device] ${event} ${JSON.stringify(data)}\n`),
    )
  const controlPath = controlSocketPath(args.stateDir)
  const control = socketExists(controlPath) ? new SocketControl(controlPath, log) : undefined
  const device = new DeviceServer({
    stateDir: args.stateDir,
    log,
    ...(args.processes ? { processes: args.processes } : {}),
    ...(args.wrapUp === undefined ? {} : { wrapUp: args.wrapUp }),
    ...(args.wrapUpReminder === undefined ? {} : { wrapUpReminder: args.wrapUpReminder }),
    ...(control ? { control } : {}),
    pairing: pairingConfig(args.stateDir),
    dial: (socket) => unixConnector(parseSocketUrl(socket, '运行时的套接字')),
    upstreams: args.upstreams.map((upstream) => ({
      id: upstream.id,
      connect: unixConnector(upstream.path),
    })),
  })
  let listener: Awaited<ReturnType<typeof listenUnix>>
  try {
    if (control) {
      control.start()
      if (!(await control.ready(CONTROL_READY_MS)))
        log('适配器主进程还没有把各 harness 的状态送过来，先就绪，到了再补')
    }
    listener = await listenUnix(args.listen, (wire) => device.attach(wire))
  } catch (error) {
    control?.close()
    await device.close()
    throw error
  }
  let closing = false
  const close = async () => {
    if (closing) return
    closing = true
    await listener.close()
    control?.close()
    await device.close()
  }
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const)
    process.once(signal, () => void close().then(() => process.exit(0)))
  // 拉起它的进程被强杀时没有人来收它：自己退出，并把套接字清掉
  watchParent(() => {
    log('父进程不在了，退出')
    void close().then(() => process.exit(0))
  })
  log(
    `聚合面在 ${args.listen}，上游 ${args.upstreams.map((upstream) => upstream.id).join('、') || '（无）'}，${control ? '有' : '没有'}控制通道`,
  )
  // 到这里套接字已经在接受连接了：监听之前所有东西都已经备好，能连上就是能用。
  // Go 层和测试认这一行算就绪
  process.stdout.write(`${READY_LINE}\n`)
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
})
