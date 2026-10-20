// 设备进程的启动参数。写法是定死的，Go 层（cmd/codex-harness-adapter/device_process.go）照这个拉起：
//   main.mjs --listen unix://<home>/device/device.sock --state <home>/device \
//     --upstream claude-code=unix://<home>/claude-code/runtime.sock --upstream pi=unix://...
// Windows 上套接字都是命名管道，地址写成 pipe://\\.\pipe\<名字>（internal/hostplatform/platform_windows.go）。
import { isAbsolute } from 'node:path'
import type { ProcessLimits } from './device-processes.mjs'
import { parseSocketUrl } from './sockets.mjs'

export interface DeviceArgs {
  /** 聚合面的套接字路径 */
  listen: string
  stateDir: string
  /** 按命令行里出现的顺序 */
  upstreams: { id: string; path: string }[]
  /** 属于设备的进程（可重连的终端）的上限和期限。命令行里没写的不在里面，用默认值；一项都没写就没有它 */
  processes?: Partial<ProcessLimits>
  /** --wrap-up-reminder：没有主进程在管设置时提不提醒收尾。没写就没有它（缺省提醒） */
  wrapUpReminder?: boolean
}

export const USAGE = [
  '用法: main.mjs --listen unix://PATH --state DIR [--upstream ID=unix://PATH]...',
  '属于设备的进程（可重连的终端），都可以不写：',
  '  --process-buffer-bytes N   每个进程留多少输出，字节（默认 2097152）',
  '  --process-limit N          设备上同时最多几个这类进程在跑（默认 32）',
  '  --process-idle-ms N        没有连接挂着的进程留多久，毫秒，到点结束它；0 是不过期（默认 0）',
  '  --process-exited-ms N      进程退出之后它的记录留多久，毫秒（默认 600000）',
  '没有适配器主进程管设置时（直接起设备进程）才看的，可以不写：',
  '  --wrap-up-reminder on|off  模型没调 litch_sessions.wrap_up 时要不要开回合提醒（默认 on）',
].join('\n')

const HARNESS_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

/** 定时器能等的最长时间（毫秒），再大就不是原来的意思了 */
const MAX_TIMER_MS = 2_147_483_647

/** 属于设备的进程的几个选项：对应哪一项、最大能写多少 */
const PROCESS_FLAGS: Record<string, { key: keyof ProcessLimits; max: number }> = {
  '--process-buffer-bytes': { key: 'bufferBytes', max: 1024 * 1024 * 1024 },
  '--process-limit': { key: 'maxProcesses', max: 4096 },
  '--process-idle-ms': { key: 'idleTimeoutMs', max: MAX_TIMER_MS },
  '--process-exited-ms': { key: 'exitedRetentionMs', max: MAX_TIMER_MS },
}

export function parseArgs(argv: string[]): DeviceArgs {
  let listen: string | null = null
  let stateDir: string | null = null
  const upstreams: { id: string; path: string }[] = []
  const processes: Partial<ProcessLimits> = {}
  let wrapUpReminder: boolean | undefined
  for (let index = 0; index < argv.length; index++) {
    const flag = argv[index]
    const value = argv[index + 1]
    const limit = flag === undefined ? undefined : PROCESS_FLAGS[flag]
    if (limit) {
      if (value === undefined || !/^\d+$/.test(value) || Number(value) > limit.max)
        throw new Error(`${flag} 要写 0 到 ${limit.max} 之间的整数，收到的是 ${value}\n${USAGE}`)
      processes[limit.key] = Number(value)
      index++
      continue
    }
    if (flag === '--wrap-up-reminder') {
      if (value !== 'on' && value !== 'off')
        throw new Error(`--wrap-up-reminder 要写 on 或 off，收到的是 ${value}\n${USAGE}`)
      wrapUpReminder = value === 'on'
      index++
      continue
    }
    if (flag !== '--listen' && flag !== '--state' && flag !== '--upstream')
      throw new Error(`不认识的参数 ${flag}\n${USAGE}`)
    if (value === undefined) throw new Error(`${flag} 后面缺少值\n${USAGE}`)
    index++
    if (flag === '--listen') listen = parseSocketUrl(value, '--listen')
    else if (flag === '--state') {
      if (!isAbsolute(value)) throw new Error(`--state 要写绝对路径，收到的是 ${value}`)
      stateDir = value
    } else {
      const split = value.indexOf('=')
      const id = split < 0 ? '' : value.slice(0, split)
      if (!HARNESS_ID.test(id))
        throw new Error(`--upstream 要写成 标识=unix://路径，收到的是 ${value}`)
      if (upstreams.some((upstream) => upstream.id === id))
        throw new Error(`--upstream 里 ${id} 出现了不止一次`)
      upstreams.push({ id, path: parseSocketUrl(value.slice(split + 1), `--upstream ${id}`) })
    }
  }
  if (listen === null || stateDir === null) throw new Error(`--listen 和 --state 都要给\n${USAGE}`)
  return {
    listen,
    stateDir,
    upstreams,
    ...(Object.keys(processes).length ? { processes } : {}),
    ...(wrapUpReminder === undefined ? {} : { wrapUpReminder }),
  }
}
