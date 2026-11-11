import { createCancel } from '../channel/cancel.mjs'
// 尚未保存的远程设备也能安装：计划绑定目标和应用版本，逐步命令只接受计划编号。
import { type AbortSignalLike, ChannelError } from '../channel/protocol.mjs'
import { ConnectError } from '../connection/transport.mjs'
import type { RemoteCheck, RemoteTarget } from '../model.mjs'
import { sameTarget } from './remote.mjs'
import { firstInstallCommand } from './remote-installer.mjs'

export type RemoteSetupStep = 'download' | 'install' | 'start' | 'connect'
export interface RemoteSetupPlan {
  id: string
  host: string
  version: string
  command: string
  blocked: 'system' | 'fetch' | 'inspect' | null
  detail?: string
}
export interface RemoteSetupRunner {
  inspect(signal: AbortSignalLike): Promise<'system' | 'fetch' | null>
  download(signal: AbortSignalLike): Promise<void>
  install(signal: AbortSignalLike): Promise<void>
  start(signal: AbortSignalLike): Promise<void>
  clean(): Promise<void>
}
export interface RemoteSetupPlatform {
  prepare(target: RemoteTarget, version: string): RemoteSetupRunner
}
const steps: RemoteSetupStep[] = ['download', 'install', 'start', 'connect']
export function createRemoteSetup(options: {
  version: string
  now(): number
  platform?: RemoteSetupPlatform | undefined
  check(target: RemoteTarget, signal: AbortSignalLike): Promise<RemoteCheck>
  connected(target: RemoteTarget): void
}) {
  let next = 0
  const plans = new Map<
    string,
    {
      target: RemoteTarget
      runner: RemoteSetupRunner
      plan: RemoteSetupPlan
      index: number
      busy: boolean
      expires: number
      dismissed: boolean
      cancel: ReturnType<typeof createCancel> | null
    }
  >()
  const drop = async (id: string) => {
    const entry = plans.get(id)
    if (!entry) return
    if (entry.busy) {
      entry.dismissed = true
      entry.cancel?.abort()
      return
    }
    plans.delete(id)
    await entry.runner.clean().catch(() => {})
  }
  return {
    async prepare(
      target: RemoteTarget,
      host: string,
      signal: AbortSignalLike,
    ): Promise<RemoteSetupPlan> {
      if (!options.platform) throw new ChannelError('unsupported', '此客户端不支持远程安装')
      for (const [id, entry] of plans) {
        if (entry.expires < options.now()) await drop(id)
      }
      if (plans.size >= 64) throw new ChannelError('busy', '安装计划过多，请关闭未使用的窗口')
      const runner = options.platform.prepare(target, options.version)
      let blocked: RemoteSetupPlan['blocked']
      let detail: string | undefined
      try {
        blocked = await runner.inspect(signal)
      } catch (error) {
        if (signal.aborted) throw error
        blocked = 'inspect'
        detail =
          error instanceof ConnectError
            ? `${error.message}\n${error.detail ?? ''}`
            : error instanceof Error
              ? error.message
              : String(error)
      }
      if (signal.aborted) throw new ChannelError('cancelled', '安装已取消')
      const plan: RemoteSetupPlan = {
        id: `install-${++next}`,
        host,
        version: options.version,
        command: firstInstallCommand(options.version),
        blocked,
        ...(detail ? { detail } : {}),
      }
      plans.set(plan.id, {
        target,
        runner,
        plan,
        index: 0,
        busy: false,
        expires: options.now() + 30 * 60_000,
        dismissed: false,
        cancel: null,
      })
      return plan
    },
    async step(
      id: string,
      step: RemoteSetupStep,
      signal: AbortSignalLike,
    ): Promise<RemoteCheck | null> {
      const entry = plans.get(id)
      if (!entry || entry.expires < options.now()) {
        await drop(id)
        throw new ChannelError('notFound', '安装计划已过期，请重新检查')
      }
      if (entry.plan.blocked || entry.busy || steps[entry.index] !== step)
        throw new ChannelError('rejected', '安装步骤无效')
      if (
        step === 'download' &&
        [...plans.values()].some(
          (other) =>
            other !== entry &&
            sameTarget(other.target, entry.target) &&
            (other.busy || other.index > 0),
        )
      ) {
        throw new ChannelError('busy', '此设备有安装任务尚未完成')
      }
      entry.busy = true
      const cancel = createCancel()
      entry.cancel = cancel
      signal.addEventListener('abort', () => cancel.abort(), { once: true })
      try {
        if (signal.aborted) throw new ChannelError('cancelled', '安装已取消')
        let result: RemoteCheck | null = null
        if (step === 'connect') {
          result = await options.check(entry.target, cancel.signal)
          if (!result.ok) return result
          if (
            result.peer !== 'service' ||
            !result.running ||
            result.harnesses === null ||
            result.version !== options.version
          ) {
            throw new ChannelError('remote', '设备服务未完成连接验证')
          }
          options.connected(entry.target)
        } else await entry.runner[step](cancel.signal)
        if (cancel.signal.aborted) throw new ChannelError('cancelled', '安装已取消')
        entry.index++
        return result
      } catch (error) {
        if (error instanceof ConnectError)
          throw new ChannelError(
            'remote',
            `${error.message}\n${error.detail ?? ''}`,
            typeof error.text === 'string' ? undefined : error.text,
          )
        throw error
      } finally {
        entry.busy = false
        // 每一步发生错误即结束计划，重试重新检查和确认。成功连接也不保留任务。
        if (entry.dismissed || entry.index !== steps.indexOf(step) + 1 || step === 'connect')
          await drop(id)
      }
    },
    drop,
    stop() {
      for (const id of plans.keys()) void drop(id)
    },
  }
}

/** 两端界面共用的顺序；更新进度后才发送下一步，关闭界面时取消后续步骤。 */
export async function runRemoteSetup(
  channel: { command: import('../channel/client.mjs').CoreChannel['command'] },
  id: string,
  progress: (step: RemoteSetupStep) => void,
  signal: AbortSignalLike = createCancel().signal,
): Promise<RemoteCheck> {
  try {
    for (const step of steps) {
      progress(step)
      const result = await channel.command('remote.setup.step', { id, step }, { signal })
      if (result) return result
    }
    throw new Error('安装未完成')
  } finally {
    await channel.command('remote.setup.dismiss', { id }).catch(() => {})
  }
}
