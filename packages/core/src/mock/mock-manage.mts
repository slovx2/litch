// 模拟核心的设备与 harness 管理：订阅设置、改设置、重启 harness、诊断、日志、ssh 配置片段。
// 行为照真的设备服务：一次写入全有或全无、版本号对不上就拒绝、改了要重启才生效的设置时
// 那个 harness 有回合在跑就标成“待重启”。别的客户端的动静由模拟核心按对话里的关键字来演（见 mock-core.mts）。

import { taskCardsSettingKey } from '../../../protocol/src/session-tree.mjs'
import { ChannelError, type Clock, type Commands, type ManageOp } from '../channel/protocol.mjs'
import type { HostSink } from '../channel/server.mjs'
import type { DeviceView, HarnessView } from '../model.mjs'
import type {
  DiagnosticsView,
  EnvEntryView,
  HarnessRestartResult,
  ManageView,
  SettingsWriteResult,
} from '../model-manage.mjs'
import { phrase } from '../phrase.mjs'
import {
  addSetting,
  commit,
  currentValue,
  editElsewhere,
  type MockSettings,
  snapshotOf,
} from './mock-settings.mjs'
import { sampleChecks, sampleLog, sampleSshConfig } from './sample-diagnostics.mjs'
import { both, sampleSettings } from './sample-manage.mjs'

export interface MockManageHost {
  clock: Clock
  /** 流式回答每一小块之间隔多久。这里的“过一会儿”都是它的倍数；0 表示不拖时间 */
  stepMs: number
  device(deviceId: string): DeviceView | undefined
  setHarness(deviceId: string, harnessId: string, patch: Partial<HarnessView>): void
  /** 一开始就有的那几台设备 */
  devices(): DeviceView[]
  /** 这个 harness 上有没有回合在跑，或者停着在等人 */
  busy(deviceId: string, harnessId: string): boolean
  /** 把这个 harness 上在跑的回合都打断：强行重启时用 */
  interrupt(deviceId: string, harnessId: string): void
  /** 这台设备上有 harness 的任务卡开关（harness.<id>.taskCards）变了 */
  taskCardsChanged?(deviceId: string): void
}

export interface MockManagement {
  subscribe(deviceId: string, sink: HostSink): () => void
  /** 这个 harness 的任务卡开着没有。设备没连着、没有设置接口的是 null */
  taskCards(deviceId: string, harness: string): boolean | null
  /** 是管理的命令就处理；不是就返回 undefined，交给别处 */
  command(name: string, params: unknown): Promise<unknown> | undefined
  /** 别的客户端改两项设置：等这台设备的详情有人看着之后过一会儿再改，改完这边会收到通知 */
  editElsewhere(deviceId: string, harness: string): void
  /** 别的客户端抢在这边下一次保存之前改了设置，通知又没到这边：这边下一次保存会冲突 */
  raceNextWrite(deviceId: string, harness: string): void
  /** 设备服务多了一项设置（相当于它升级了）：订阅着的重新拿到一份结构 */
  addSetting(deviceId: string, harness: string): void
  /** 这个 harness 刚装好（mock-install.mts）：之后重启它回到的是可用的样子，不再是“没装” */
  installed(deviceId: string, harness: HarnessView): void
  /**
   * 详情设置的 env 方式（mock-harness-config.mts）：往这个 harness 的环境变量表里写一项密钥（value 是 null 是去掉）。
   * 和界面保存一样走一次写入：没有回合在跑就顺手重启（restarted），有就等着（pending）
   */
  writeEnv(
    deviceId: string,
    harness: string,
    name: string,
    value: string | null,
  ): { restarted: boolean; pending: boolean }
}

const NAMES: readonly string[] = [
  'device.settings.write',
  'device.harness.restart',
  'device.diagnostics.run',
  'device.logs.read',
  'device.sshConfig.read',
]

export function createMockManagement(host: MockManageHost): MockManagement {
  const { clock } = host
  const states = new Map<string, MockSettings>()
  const sinks = new Map<string, Set<HostSink>>()
  /** harness 一开始的样子：重启之后回到它（本来就用不了的，重启完还是用不了） */
  const origins = new Map<string, HarnessView>()
  for (const device of host.devices()) {
    for (const harness of device.harnesses) origins.set(`${device.id}:${harness.id}`, harness)
  }
  /** 等着“别处改设置”的设备，和要动的是哪个 harness 的入口 */
  const elsewhere = new Map<string, string>()
  const racing = new Map<string, string>()
  const later = (run: () => void, steps: number) =>
    clock.setTimer(run, Math.max(host.stepMs * steps, 1))

  /** 这台设备能管理、而且连着，才有设置可说 */
  const reach = (deviceId: string): { device: DeviceView; state: MockSettings } => {
    const device = host.device(deviceId)
    if (!device) throw new ChannelError('notFound', `没有这台设备：${deviceId}`)
    if (!device.manageable) throw new ChannelError('unsupported', '这台设备没有设置接口')
    if (device.connection !== 'online') throw new ChannelError('offline', '设备没有连上')
    let state = states.get(deviceId)
    if (!state) {
      const sample = sampleSettings(deviceId, device.harnesses)
      state = { ...sample, version: 12, pending: new Set(sample.pendingRestart) }
      states.set(deviceId, state)
    }
    return { device, state }
  }

  const viewOf = (deviceId: string): ManageView => {
    const { device, state } = reach(deviceId)
    return {
      deviceId,
      groups: state.groups,
      settings: state.settings,
      snapshot: snapshotOf(state, device.harnesses),
      inheritedEnv: state.inheritedEnv,
    }
  }

  /** 把现在的值发给订阅着的。keys 是这一次动了的键 */
  const publish = (deviceId: string, keys: string[]) => {
    const { device, state } = reach(deviceId)
    const ops: ManageOp[] = [
      { op: 'settings.set', snapshot: snapshotOf(state, device.harnesses), keys },
    ]
    for (const sink of sinks.get(deviceId) ?? []) sink.delta(ops)
    if (keys.some((key) => key.endsWith('.taskCards'))) host.taskCardsChanged?.(deviceId)
  }

  /** 这个 harness 停稳之后是什么样：设置里停用了就是停用，否则回到它一开始的样子 */
  const settled = (deviceId: string, harnessId: string): Partial<HarnessView> => {
    const { state } = reach(deviceId)
    if (currentValue(state, `harness.${harnessId}.enabled`) === false) {
      return {
        state: 'disabled',
        reason: phrase('harness.disabled'),
        detail: both('已在设置里停用', 'Turned off in settings'),
        down: 'disabled',
      }
    }
    const origin = origins.get(`${deviceId}:${harnessId}`)
    return {
      state: origin?.state ?? 'ready',
      reason: origin?.reason ?? null,
      detail: origin?.detail ?? null,
      down: origin?.down ?? null,
    }
  }

  /**
   * 把一个 harness 按现在的设置重新起一遍：停用的直接停；别的先是“正在启动”，过一会儿停稳。
   * done 在它停稳的时候叫
   */
  const bounce = (deviceId: string, harnessId: string, done?: () => void) => {
    const { state } = reach(deviceId)
    state.pending.delete(harnessId)
    const finish = () => {
      host.setHarness(deviceId, harnessId, settled(deviceId, harnessId))
      // 入口跟着运行时起落，状况变了
      publish(deviceId, [])
      done?.()
    }
    if (settled(deviceId, harnessId).state === 'disabled' || host.stepMs <= 0) {
      finish()
      return
    }
    host.setHarness(deviceId, harnessId, {
      state: 'unavailable',
      reason: phrase('harness.starting'),
      detail: null,
      down: 'starting',
    })
    publish(deviceId, [])
    later(finish, 20)
  }

  const write = (params: Commands['device.settings.write']['params']): SettingsWriteResult => {
    const { deviceId, expectedVersion, edits } = params
    const { state } = reach(deviceId)
    const raced = racing.get(deviceId)
    racing.delete(deviceId)
    // 别处抢先改了，而通知没到这边
    const stolen = raced === undefined ? [] : editElsewhere(state, raced)
    if (expectedVersion !== state.version) {
      // 什么都没写。把最新的值给过去，让用户看着它再决定
      publish(deviceId, stolen)
      const said = both(
        '设置已经在别处被改过了，请按最新的内容再改',
        'The settings were changed elsewhere; make the change again on the latest version',
      )
      throw new ChannelError('conflict', said['zh-CN'], undefined, { said })
    }
    const changed = commit(state, edits)
    const affected = new Set<string>()
    for (const spec of state.settings) {
      if (
        changed.includes(spec.key) &&
        spec.restart === 'harness' &&
        spec.scope.kind === 'harness'
      ) {
        affected.add(spec.scope.harness)
      }
    }
    const restarted: string[] = []
    for (const harness of affected) {
      // 有回合在跑的不去打断：标成待重启，由用户决定什么时候重启
      if (host.busy(deviceId, harness)) state.pending.add(harness)
      else restarted.push(harness)
    }
    publish(deviceId, changed)
    for (const harness of restarted) bounce(deviceId, harness)
    return { changed, restarted, pendingRestart: [...state.pending] }
  }

  const restart = (
    params: Commands['device.harness.restart']['params'],
  ): Promise<HarnessRestartResult> => {
    const { deviceId, harness, force } = params
    const { device } = reach(deviceId)
    const entry = device.harnesses.find((item) => item.id === harness)
    if (!entry) {
      throw new ChannelError(
        'remote',
        `没有 ${harness}`,
        phrase('fault.unknownHarness', { name: harness }),
      )
    }
    if (host.busy(deviceId, harness)) {
      if (!force) {
        const said = both(
          `${entry.name} 有回合在跑。等它结束再重启，或者明确要求照做`,
          `${entry.name} has a turn in progress. Restart it once the turn ends, or explicitly ask to restart anyway`,
        )
        throw new ChannelError('busy', said['zh-CN'], undefined, { said })
      }
      host.interrupt(deviceId, harness)
    }
    // 等到它有了结果才应答
    return new Promise((resolve) => {
      bounce(deviceId, harness, () => {
        const now = settled(deviceId, harness)
        const running = now.state === 'ready'
        const why = typeof now.detail === 'string' ? both(now.detail, now.detail) : now.detail
        resolve({ running, text: running ? null : (why ?? null) })
      })
    })
  }

  const diagnostics = (
    params: Commands['device.diagnostics.run']['params'],
  ): Promise<DiagnosticsView> => {
    // 够不着的设备当场就说，不等
    reach(params.deviceId)
    return new Promise((resolve, reject) => {
      // 检查要跑一会儿
      later(() => {
        try {
          const view = viewOf(params.deviceId)
          const { device } = reach(params.deviceId)
          const checks = sampleChecks(device.harnesses, view.snapshot, params.harness)
          resolve({ ranAt: clock.now(), checks })
        } catch (error) {
          reject(error)
        }
      }, 15)
    })
  }

  /** 别处的那次改动落下来，并通知这边 */
  const arm = (deviceId: string) => {
    const harness = elsewhere.get(deviceId)
    if (harness === undefined) return
    elsewhere.delete(deviceId)
    later(() => {
      const state = states.get(deviceId)
      if (state) publish(deviceId, editElsewhere(state, harness))
    }, 50)
  }

  return {
    taskCards(deviceId, harness) {
      const device = host.device(deviceId)
      if (!device?.manageable || device.connection !== 'online') return null
      const value = currentValue(reach(deviceId).state, taskCardsSettingKey(harness))
      return typeof value === 'boolean' ? value : null
    },

    subscribe(deviceId, sink) {
      const device = host.device(deviceId)
      if (!device) throw new ChannelError('notFound', `没有这台设备：${deviceId}`)
      if (!device.manageable) throw new ChannelError('unsupported', '这台设备没有设置接口')
      // 没连上的设备：订阅成立，但等不到快照（示例里它不会连上）
      if (device.connection === 'online') sink.snapshot(viewOf(deviceId))
      const set = sinks.get(deviceId) ?? new Set<HostSink>()
      sinks.set(deviceId, set)
      set.add(sink)
      arm(deviceId)
      return () => {
        set.delete(sink)
      }
    },

    command(name, params) {
      if (!NAMES.includes(name)) return undefined
      // 这几个命令没做成时都以拒绝的方式结束，不在调用的地方当场抛出来
      return (async () => {
        if (name === 'device.settings.write') {
          return write(params as Commands['device.settings.write']['params'])
        }
        if (name === 'device.harness.restart') {
          return restart(params as Commands['device.harness.restart']['params'])
        }
        if (name === 'device.diagnostics.run') {
          return diagnostics(params as Commands['device.diagnostics.run']['params'])
        }
        const { deviceId } = params as { deviceId: string }
        const view = viewOf(deviceId)
        const { device } = reach(deviceId)
        if (name === 'device.logs.read') {
          const { source, harness } = params as Commands['device.logs.read']['params']
          return sampleLog(clock.now(), device.harnesses, source, harness)
        }
        return sampleSshConfig(device.harnesses, view.snapshot)
      })()
    },

    editElsewhere(deviceId, harness) {
      if (!host.device(deviceId)?.manageable) return
      elsewhere.set(deviceId, harness)
      if ((sinks.get(deviceId)?.size ?? 0) > 0) arm(deviceId)
    },

    raceNextWrite(deviceId, harness) {
      if (host.device(deviceId)?.manageable) racing.set(deviceId, harness)
    },

    installed(deviceId, harness) {
      origins.set(`${deviceId}:${harness.id}`, harness)
    },

    writeEnv(deviceId, harness, name, value) {
      const view = viewOf(deviceId)
      // 认的是这个 harness 的、环境变量表类型的那一项，不认键名
      const spec = view.settings.find(
        (one) =>
          one.type === 'env' && one.scope.kind === 'harness' && one.scope.harness === harness,
      )
      if (!spec) throw new ChannelError('unsupported', '设备设置里没有这个 harness 的环境变量')
      const current = view.snapshot.values[spec.key]
      const table: EnvEntryView[] = (Array.isArray(current) ? current : [])
        .filter((entry) => entry.name !== name)
        .map((entry) => (entry.secret ? { name: entry.name, secret: true } : entry))
      if (value !== null) table.push({ name, value, secret: true })
      const result = write({
        deviceId,
        expectedVersion: view.snapshot.version,
        edits: [{ key: spec.key, value: table }],
      })
      return {
        restarted: result.restarted.includes(harness),
        pending: result.pendingRestart.includes(harness),
      }
    },

    addSetting(deviceId, harness) {
      if (!host.device(deviceId)?.manageable) return
      const { state } = reach(deviceId)
      if (!addSetting(state, harness)) return
      const view = viewOf(deviceId)
      for (const sink of sinks.get(deviceId) ?? []) sink.snapshot(view)
    },
  }
}
