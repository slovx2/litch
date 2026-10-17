// 原生 codex 那几组用例共用的搭法：一台由主进程管着的设备，上面有一个适配器的假运行时（pi）
// 和一个假的原生 codex。是不是原生的由控制通道的名单说（和真的一样，Go 层在名单里标 native）。
import assert from 'node:assert/strict'
import type { ManagedHarnessState } from '../../protocol/src/device-settings.mjs'
import type { DeviceOptions } from '../src/device.mjs'
import { codexThread, FakeCodex } from './fake-codex.mjs'
import { FakeControl, managed } from './fake-control.mjs'
import { FakeUpstream } from './fake-upstream.mjs'
import { rig } from './helpers.mjs'

export const STATUS = 'litch/harness/status/changed'

export interface CodexRigOptions {
  /** 原生 codex 起始的状态。默认在跑 */
  codex?: ManagedHarnessState
  /** 假的原生 codex。不给就用一个带两个会话的 */
  fake?: FakeCodex
  /** 交给设备的别的选项（要不要导入现有的项目等） */
  device?: Partial<DeviceOptions>
}

export function codexRig(options: CodexRigOptions = {}) {
  const pi = new FakeUpstream('pi', [
    { id: 'p1', updatedAt: 300 },
    { id: 'p2', updatedAt: 100 },
  ])
  const codex = options.fake ?? new FakeCodex([codexThread(1, 400), codexThread(2, 200)])
  const fakes: Record<string, FakeUpstream> = { pi, codex }
  const control = new FakeControl([
    managed('pi'),
    { ...managed('codex', options.codex ?? 'running'), native: true },
  ])
  const logs: string[] = []
  const env = rig(
    {},
    {},
    {
      control,
      dial: (socket) => (fakes[socket.slice('fake://'.length)] as FakeUpstream).connector,
      log: (line) => logs.push(line),
      ...options.device,
    },
  )
  return {
    ...env,
    pi,
    codex,
    control,
    logs,
    /**
     * 收尾时顺便看一眼：经设备进程到 codex 手里的 thread/start、turn/start 里没有它不认识、悄悄丢掉的字段
     * （聚合面自己的参数该摘的都摘了，发了的都是它认的）
     */
    async close() {
      await env.close()
      assert.deepEqual(codex.ignored, [], 'codex 收到了它不认识、会悄悄丢掉的字段')
    },
  }
}

/** 等某个 harness 的状态变化通知。kind 为 null 是变成可用 */
export const statusOf =
  (harness: string, kind: string | null) =>
  (frame: { method?: string; params?: unknown }): boolean => {
    const params = frame.params as any
    return (
      frame.method === STATUS &&
      params.harness === harness &&
      (params.info.unavailable?.kind ?? null) === kind
    )
  }

/** 假的 codex 收到过的某种请求的参数 */
export const sentTo = (upstream: FakeUpstream, method: string): any[] =>
  upstream.seen.filter((entry) => entry.method === method).map((entry) => entry.params)
