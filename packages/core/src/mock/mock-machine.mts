// 模拟核心里“远程设备操作这台电脑”：各台远程设备的设置、主题 machine（顶栏里在跑的进程和
// 全局待处理）、操作记录，以及这些的命令。改了就推增量，和真的核心一样：设置走 app 主题里的设备，
// 主题 machine 整份换（MachineOp 只有 machine.set 一种）。
// 会话里的卡片归 mock-core.mts（它管会话），答完了经 record、start 把结果记到这里。
// 话里带“命令行来的”（英文 from the command line）时在全局待处理里加一张：找不到会话的那种调用。
import { ChannelError, type Clock, type Commands } from '../channel/protocol.mjs'
import type { HostSink } from '../channel/server.mjs'
import type { DeviceView } from '../model.mjs'
import type {
  MachineAccessView,
  MachineActivityView,
  MachineAskView,
  MachineLogEntry,
  MachinePendingView,
  MachineProcessView,
} from '../model-machine.mjs'
import {
  machineSummary,
  PENDING_OPTIONS,
  sampleMachineActivity,
  sampleMachineLog,
} from './sample-machine.mjs'

export interface MockMachineHost {
  clock: Clock
  device(deviceId: string): DeviceView | undefined
  patch(deviceId: string, patch: Partial<DeviceView>): void
}

export interface MockMachine {
  subscribe(sink: HostSink): () => void
  /** 是这一项的命令就处理；不是就返回 undefined，交给别处 */
  command(name: string, params: unknown): unknown
  /** device.tools.set 带了 machine：开或关。关掉时结束这台设备起的进程、撤掉它的待处理卡片 */
  toggle(deviceId: string, on: boolean): void
  /** 记一条操作记录（会话里的卡片答完、不用问就做了） */
  record(entry: Omit<MachineLogEntry, 'at'>): void
  /** 会话里允许了一条不会自己结束的命令：顶栏里多一个进程。返回进程号 */
  start(process: Omit<MachineProcessView, 'id' | 'startedAt'>): string
  /** 话里带着关键字就在全局待处理里加一张，返回 true */
  stage(deviceId: string, text: string): boolean
}

/** 话里带这些字样：在全局待处理里加一张卡片（命令行调用、找不到会话） */
export const MACHINE_CLI = /命令行来的|from the command line/i

/** “命令行来的”那一出轮流用的两张卡片：一段很长的命令、读一个文件 */
const LONG_EXEC: MachineAskView = {
  kind: 'machine',
  action: 'exec',
  command: [
    'set -euo pipefail',
    'cd ~/work/litch',
    'git fetch origin && git status --short',
    'npm ci --prefix apps/desktop',
    'npm run client:typecheck',
    'npm run client:test -- --reporter=dot',
    'npm run client:pack 2>&1 | tee /tmp/litch-pack.log',
    'ls -lh apps/desktop/out',
  ].join('\n'),
  cwd: '~/work/litch',
  path: null,
  copy: null,
  flagged: [],
}
const READ_FILE: MachineAskView = {
  kind: 'machine',
  action: 'read',
  command: null,
  cwd: null,
  path: '~/work/litch/apps/desktop/package.json',
  copy: null,
  flagged: [],
}

/** 全局待处理的卡片多久作废（10 分钟） */
const EXPIRES_MS = 10 * 60_000

/** 一台设备的操作记录最多留多少条 */
const LOG_LIMIT = 200

export function createMockMachine(host: MockMachineHost): MockMachine {
  const { clock } = host
  const activity: MachineActivityView = sampleMachineActivity(clock.now())
  const logs = new Map<string, MachineLogEntry[]>([['build', sampleMachineLog(clock.now())]])
  const sinks = new Set<HostSink>()
  /** 待处理卡片的作废定时器 */
  const timers = new Map<string, () => void>()
  let seq = 0
  /** “命令行来的”演过几次 */
  let staged = 0

  const push = () => {
    // 整份换：交出去的是拷贝，之后这边再改不影响已经发出去的
    const view: MachineActivityView = {
      running: [...activity.running],
      pending: [...activity.pending],
    }
    for (const sink of sinks) sink.delta([{ op: 'machine.set', view }])
  }

  const access = (deviceId: string): { device: DeviceView; machine: MachineAccessView } => {
    const device = host.device(deviceId)
    if (!device) throw new ChannelError('notFound', `没有这台设备：${deviceId}`)
    if (!device.machine) throw new ChannelError('rejected', '本机设备没有这一项')
    return { device, machine: device.machine }
  }

  const record = (entry: Omit<MachineLogEntry, 'at'>) => {
    const list = logs.get(entry.deviceId) ?? []
    list.unshift({ ...entry, at: clock.now() })
    list.length = Math.min(list.length, LOG_LIMIT)
    logs.set(entry.deviceId, list)
  }

  const expire = (pending: MachinePendingView) => {
    timers.set(
      pending.id,
      clock.setTimer(
        () => {
          timers.delete(pending.id)
          if (!drop(pending.id)) return
          record(logOf(pending, 'expired'))
          push()
        },
        Math.max(0, pending.expiresAt - clock.now()),
      ),
    )
  }
  /** 从待处理里拿掉一张，返回它 */
  const drop = (pendingId: string): MachinePendingView | undefined => {
    const at = activity.pending.findIndex((entry) => entry.id === pendingId)
    if (at < 0) return undefined
    const [pending] = activity.pending.splice(at, 1)
    timers.get(pendingId)?.()
    timers.delete(pendingId)
    return pending
  }

  const logOf = (
    pending: MachinePendingView,
    result: MachineLogEntry['result'],
  ): Omit<MachineLogEntry, 'at'> => ({
    deviceId: pending.deviceId,
    sessionId: null,
    harness: pending.harness,
    tool: pending.ask.action === 'exec' ? 'exec' : pending.ask.action,
    summary: machineSummary(pending.ask),
    result,
    flagged: pending.ask.flagged.length > 0,
  })

  /**
   * 给还没有作废定时器的卡片都定上。有人订阅了才定：没人看主题 machine 的时候（核心的单元测试）
   * 不留着定时器
   */
  const arm = () => {
    for (const pending of activity.pending) if (!timers.has(pending.id)) expire(pending)
  }

  const start = (process: Omit<MachineProcessView, 'id' | 'startedAt'>): string => {
    const id = `mp-x${++seq}`
    activity.running.unshift({ ...process, id, startedAt: clock.now() })
    push()
    return id
  }

  /** 停掉一台设备（不给就是全部）起的进程、撤掉它的待处理卡片 */
  const stop = (deviceId?: string) => {
    const mine = (entry: { deviceId: string }) =>
      deviceId === undefined || entry.deviceId === deviceId
    activity.running = activity.running.filter((entry) => !mine(entry))
    for (const pending of activity.pending.filter(mine)) {
      drop(pending.id)
      record(logOf(pending, 'declined'))
    }
    push()
  }

  return {
    subscribe(sink) {
      sinks.add(sink)
      arm()
      sink.snapshot({ running: [...activity.running], pending: [...activity.pending] })
      return () => {
        sinks.delete(sink)
      }
    },

    command(name, params) {
      if (name === 'device.machine.set') {
        const {
          deviceId,
          approval,
          access: next,
        } = params as Commands['device.machine.set']['params']
        const { machine } = access(deviceId)
        const custom =
          next?.custom ??
          // 第一次切到自定义：从内置名单抄一份起步
          (next?.mode === 'custom' && machine.access.custom.length === 0
            ? [...machine.presets]
            : machine.access.custom)
        host.patch(deviceId, {
          machine: {
            ...machine,
            approval: approval ?? machine.approval,
            access: next ? { mode: next.mode, custom } : machine.access,
          },
        })
        return {}
      }
      if (name === 'machine.answer') {
        const { pendingId, optionId } = params as Commands['machine.answer']['params']
        const pending = activity.pending.find((entry) => entry.id === pendingId)
        if (!pending) throw new ChannelError('notFound', '这张卡片已经答过或者作废了')
        const option = pending.options.find((entry) => entry.id === optionId)
        if (!option) throw new ChannelError('rejected', '这张卡片没有这样的选项')
        drop(pendingId)
        const declined = option.role === 'decline' || option.role === 'cancel'
        record(logOf(pending, declined ? 'declined' : 'ok'))
        push()
        return {}
      }
      if (name === 'machine.process.kill') {
        const { processId } = params as Commands['machine.process.kill']['params']
        const before = activity.running.length
        activity.running = activity.running.filter((entry) => entry.id !== processId)
        if (activity.running.length === before) {
          throw new ChannelError('notFound', '这个进程已经不在了')
        }
        push()
        return {}
      }
      if (name === 'machine.stopAll') {
        const { deviceId } = params as Commands['machine.stopAll']['params']
        stop(deviceId)
        return {}
      }
      if (name === 'machine.log') {
        const { deviceId } = params as Commands['machine.log']['params']
        access(deviceId)
        return { entries: [...(logs.get(deviceId) ?? [])] }
      }
      if (name === 'machine.log.clear') {
        const { deviceId } = params as Commands['machine.log.clear']['params']
        access(deviceId)
        logs.delete(deviceId)
        return {}
      }
      return undefined
    },

    toggle(deviceId, on) {
      const { machine } = access(deviceId)
      host.patch(deviceId, { machine: { ...machine, enabled: on } })
      if (!on) stop(deviceId)
    },

    record,
    start,

    stage(deviceId, text) {
      if (!MACHINE_CLI.test(text)) return false
      const device = host.device(deviceId)
      if (!device?.machine?.enabled) return false
      const pending: MachinePendingView = {
        id: `mq-x${++seq}`,
        deviceId,
        deviceName: device.name,
        host: device.host,
        harness: 'dsh',
        // 单数次是一段很长的命令（卡片上先折起来），双数次是读一个文件
        ask: ++staged % 2 === 1 ? LONG_EXEC : READ_FILE,
        options: PENDING_OPTIONS,
        expiresAt: clock.now() + EXPIRES_MS,
      }
      // 不确认那一档：不出卡片，直接做了，只记一笔
      if (device.machine.approval === 'never') {
        record(logOf(pending, 'ok'))
        return true
      }
      activity.pending.push(pending)
      if (sinks.size > 0) arm()
      push()
      return true
    },
  }
}
