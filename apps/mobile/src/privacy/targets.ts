import {
  ChannelError,
  type CoreChannel,
  type DeviceView,
  type HarnessConfigTopicView,
  keys,
  type ManagerDraft,
  type ManagerView,
  type Replica,
  type SessionView,
  type TaskDraft,
  type TaskView,
} from '@litch/core'
import { providerOf } from '../../../../packages/ui/src/composer/provider-switch'
import type { ConsentTarget } from './consent'

// 读取一次权威快照，不用磁盘上的历史视图来决定接收数据的服务。
function firstValue<T>(
  subscribe: (accept: (value: T) => void, fail: (error: Error) => void) => () => void,
): Promise<T> {
  return new Promise((resolve, reject) => {
    let done = false
    let close = () => {}
    const timer = setTimeout(() => finish(undefined, new Error('consentTargetTimeout')), 12000)
    const finish = (value?: T, error?: Error) => {
      if (done) return
      done = true
      clearTimeout(timer)
      close()
      if (error) reject(error)
      else resolve(value as T)
    }
    close = subscribe(
      (value) => finish(value),
      (error) => finish(undefined, error),
    )
    if (done) close()
  })
}

const session = (base: CoreChannel, deviceId: string, sessionId: string): Promise<SessionView> =>
  firstValue((snapshot, error) =>
    base.subscribe({ kind: 'session', deviceId, sessionId }, { snapshot, delta() {}, error }),
  )

async function providers(base: CoreChannel, deviceId: string, harness: string) {
  try {
    // reload 不涉及用户内容；设备不支持详情配置时按未知服务处理，不假定为官方服务。
    await base.command('harnessConfig.reload', { deviceId, harness, part: 'providers' })
    return await firstValue<HarnessConfigTopicView>((accept, error) => {
      const put = (view: HarnessConfigTopicView) => {
        if (
          view.supported === false ||
          view.providers.error ||
          (view.providers.data && !view.providers.loading)
        )
          accept(view)
      }
      return base.subscribe(
        { kind: 'harnessConfig', deviceId, harness },
        {
          snapshot: put,
          delta: (ops) => {
            for (const op of ops) put(op.view)
          },
          error,
        },
      )
    })
  } catch {
    return null
  }
}

interface TargetInput {
  deviceId: string
  sessionId?: string
  parentId?: string
  harness?: string
  cwd?: string | null
  model?: string | null
  settings?: { model?: string | null }
  thenConfigure?: { model?: string | null }
  manager?: ManagerDraft
  managerId?: string
  patch?: Partial<ManagerView> & Partial<TaskDraft>
  proposalId?: string
  overrides?: { harness?: string; model?: string }
  task?: TaskDraft
  taskId?: string
}

export function consentTargets(
  base: CoreChannel,
  replica: Replica,
  lang: () => 'zh-CN' | 'en',
  unavailable: () => string,
) {
  return async (name: string, raw: unknown): Promise<ConsentTarget[]> => {
    const input = raw as TargetInput
    const deviceId = input.deviceId
    const device = replica.store.get<DeviceView>(keys.device(deviceId))
    if (!device) throw new ChannelError('offline', unavailable())
    if (name === 'files.uploadAttachment')
      return [
        {
          deviceId,
          device: typeof device.name === 'string' ? device.name : device.host,
          harness: 'SSH',
          provider: 'attachment-upload',
          label: device.host,
          model: null,
          revision: device.host,
          remember: false,
          delegated: false,
        },
      ]
    let sessionId = input.sessionId ?? input.parentId
    let harness = input.harness
    let model = input.settings?.model ?? input.model ?? null
    let cwd = input.cwd ?? null
    let delegated =
      name.startsWith('managers.') ||
      name === 'session.spawn' ||
      name.startsWith('session.proposal.') ||
      name.startsWith('tasks.')
    const manager =
      input.manager ??
      (input.managerId
        ? replica.store.get<ManagerView>(keys.manager(deviceId, input.managerId))
        : (replica.store.get<string[]>(keys.managerIds(deviceId)) ?? [])
            .map((id) => replica.store.get<ManagerView>(keys.manager(deviceId, id)))
            .find((value) => value?.threadId === sessionId))
    const managerSettings = manager ? { ...manager, ...input.patch } : null
    if (managerSettings) {
      delegated = true
      if (name.startsWith('managers.')) {
        sessionId = 'threadId' in managerSettings ? managerSettings.threadId : undefined
        harness = managerSettings.harness
        model = managerSettings.model
        cwd = managerSettings.cwd
      }
    }
    if (name.startsWith('tasks.')) {
      const task =
        input.task ??
        (input.taskId ? replica.store.get<TaskView>(keys.task(deviceId, input.taskId)) : undefined)
      const target = input.patch?.target ?? task?.target
      if (target?.kind === 'thread') sessionId = target.threadId
      else if (target) {
        harness = target.harness
        model = target.settings?.model ?? null
        cwd = target.cwd
      }
    }
    let view: SessionView | null = null
    if (sessionId) {
      view = await session(base, deviceId, sessionId)
      const sameHarness = !harness || harness === view.harness
      harness ??= view.harness
      if (sameHarness) model ??= view.settings.model
      cwd ??= view.cwd
      if (input.proposalId) {
        const proposal = view.proposals.find((p) => p.id === input.proposalId)
        if (name === 'session.proposal.accept') {
          harness = input.overrides?.harness ?? proposal?.harness ?? harness
          model =
            input.overrides?.model ?? proposal?.model ?? (harness === view.harness ? model : null)
        }
      }
    }
    harness ??= device.harnesses.find((h) => h.state === 'ready')?.id ?? device.harnesses[0]?.id
    if (!harness) throw new ChannelError('rejected', unavailable())
    if (!model && name !== 'files.uploadAttachment') {
      const defaults = await base.command('device.newSessionDefaults', { deviceId, harness, cwd })
      model = defaults.model
    }
    const describe = async (
      engine: string,
      selectedModel: string | null,
    ): Promise<ConsentTarget> => {
      const config = await providers(base, deviceId, engine)
      const list = config?.providers.data
      const prefix = providerOf(selectedModel)
      const active = list?.providers.filter((p) => p.active) ?? []
      const claudeDefault =
        !prefix && (engine === 'claude-code' || engine === 'claude') && list?.switchable === false
          ? (list.providers.find((p) => p.id === 'native') ??
            list.providers.find((p) => p.id === 'anthropic'))
          : null
      // Claude 的供应商按会话型号选择，全部 active=false；无前缀时遵循设备的 native/账号路由。
      const provider = prefix
        ? list?.providers.find((p) => p.id === prefix)
        : (claudeDefault ?? (active.length === 1 ? active[0] : null))
      // 只取公开服务地址，不存 definition（可能含账号或密钥状态）。
      const endpoints = Object.entries(provider?.definition ?? {})
        .flatMap(([key, value]) => {
          if (!/url|endpoint/i.test(key) || typeof value !== 'string') return []
          try {
            const url = new URL(value)
            return /^https?:$/.test(url.protocol) ? [url.origin] : []
          } catch {
            return []
          }
        })
        .sort()
      const label = provider?.title[lang()] ?? prefix ?? `${engine} / ${selectedModel ?? 'default'}`
      return {
        deviceId,
        device: typeof device.name === 'string' ? device.name : device.host,
        harness: engine,
        provider: provider?.id ?? prefix ?? 'unreported',
        label: [label, ...endpoints].join('\n'),
        model: selectedModel,
        revision: JSON.stringify([device.host, provider?.id, list?.version, endpoints]),
        // 未完整上报时也按设备、harness 和已知配置记忆；新供应商/配置指纹到达后重新询问。
        remember: true,
        incomplete: !provider || !list?.version,
        delegated,
      }
    }
    const targets = [await describe(harness, model)]
    if (input.thenConfigure?.model && providerOf(input.thenConfigure.model) !== providerOf(model))
      targets.push(await describe(harness, input.thenConfigure.model))
    if (managerSettings?.dispatch) {
      const dispatch = managerSettings.dispatch
      const childHarness = dispatch.harness ?? harness
      const childModel = dispatch.model ?? (childHarness === harness ? model : null)
      if (childHarness !== harness || providerOf(childModel) !== providerOf(model))
        targets.push(await describe(childHarness, childModel))
    }
    return targets
  }
}
