// litch_machine 的接线（接口见 device/machine/types.mts）：远程设备上的会话要操作这台电脑时，
// 各台设备把调用交到这里（device/tool-calls.mts → device.mts → 这里），这里
// - 查这台设备的开关（默认关），关着先请用户在桌面端确认开启，再按原审批规则继续；
// - 把“能操作的机器”交给执行器：desktop 是本机设备的连接，session 是会话所在那台远程设备的连接；
// - 按审批方式决定 approve 弹不弹卡片：“本会话都允许”按 mutate、read 两类各记；命令里提到禁止位置
//   （ask.flagged）时除了“不确认”都再弹；同一回合里被拒的同一件事不再问；卡片 10 分钟没人答作废；
// - 卡片放哪：找得到会话的放进那个会话的对话（设备给的 showAsk）；找不到的放进全局待处理（主题 machine），
//   并请主进程发一条系统通知；
// - 主题 machine（还在跑的进程、全局待处理）、操作记录（只存本机、按设备、条数有上限）。
// 执行器只有一个，所有设备共用：进程表是全局的，顶栏标记看的就是它。
import { type ClientToolCallResponse, clientToolFailure } from '../../protocol/src/client-tools.mjs'
import type { Clock } from './channel/protocol.mjs'
import type { HostSink } from './channel/server.mjs'
import { SENSITIVE_PRESETS } from './device/machine/presets.mjs'
import type {
  MachineCallContext,
  MachineExecutor,
  MachineFacts,
  MachineLogNote,
  MachinePolicy,
  MachineTarget,
} from './device/machine/types.mjs'
import type { MachineLogStore } from './device/remote.mjs'
import type { MachineCallInput } from './device/tool-calls.mjs'
import type { ApprovalOption } from './model.mjs'
import type { MachineNotice, ToolAnswer } from './model-client-tools.mjs'
import type {
  MachineAccessMode,
  MachineActivityView,
  MachineApproval,
  MachineAskView,
  MachineLogEntry,
  MachineOp,
  MachinePendingView,
} from './model-machine.mjs'
import type { Text } from './phrase.mjs'

/** 卡片挂多久没人答就作废（当作拒绝） */
export const MACHINE_ASK_EXPIRES_MS = 10 * 60_000
/** 每台设备的操作记录最多留多少条 */
export const MACHINE_LOG_LIMIT = 500

/** 开关关着时给模型的话：告诉它让用户去哪里打开 */
export const MACHINE_DISABLED =
  '"Operate this computer" is off for this device. Only the user can enable it in Litch (Devices → this device). Until they do, do not retry repeatedly or use other tools to bypass this restriction.\n“允许远程设备操作本机”尚未开启。请用户在 Litch 的设备设置中开启；开启之前不要反复重试，也不要换用其他工具绕过限制。'

/** 已展示卡片但未获允许；不把拒绝或超时说成仍在等待 */
export const MACHINE_ENABLE_DECLINED = `${MACHINE_DISABLED}\nAn enable card was shown in the calling conversation (or Litch’s global pending requests). It was declined, cancelled or expired. Tell the user to enable access in Litch if they still want to proceed; do not request approval again in this turn.\nLitch 已在调用会话（或全局待处理）展示开启卡，但卡片已被拒绝、取消或超时。若用户仍需继续，请提示用户在 Litch 中开启；本回合不要再次请求。`

/** 一台设备上“操作这台电脑”的设置（存在桌面端，按设备） */
export interface MachineSettings {
  enabled: boolean
  approval: MachineApproval
  access: { mode: MachineAccessMode; custom: readonly string[] }
}

/** 一台设备的连接里，litch_machine 要用的那几样 */
export interface MachineDeviceLink {
  online(): boolean
  request: MachineTarget['request']
  onProcessNotification: MachineTarget['onProcessNotification']
}

/** 会话所在的那台远程设备 */
export interface MachineSessionDevice {
  /** 给人看的名字（卡片、顶栏弹层用） */
  name: Text
  /** 给人看的主机标识 */
  host: string
  link: MachineDeviceLink
  /** 现查这台设备的情况（会缓存一会儿）。连接不在时抛错 */
  facts(): Promise<MachineFacts>
}

/** 设备给的“在这个会话的对话里出一张卡片”。答了调 answer（撤了是 null）；返回的函数撤掉卡片 */
export type MachineSessionAsk = (
  ask: MachineAskView,
  answer: (pick: ToolAnswer | null, note: string | null) => void,
) => () => void

export interface MachineWiringHost {
  clock: Clock
  executor: MachineExecutor
  /** 桌面端这台的情况：外壳给的（核心就住在这台电脑上） */
  desktop: MachineFacts
  /** 本机设备的连接（desktop 这台背后的那条）。没有本机设备是 null */
  local(): MachineDeviceLink | null
  /** 一台远程设备。不认识（去掉了、是本机）是 null */
  device(deviceId: string): MachineSessionDevice | null
  settings(deviceId: string): MachineSettings
  /** 只能在本地确认卡获得允许后调用；存最保守的范围与逐条审批 */
  enable(deviceId: string): void
  notify(notice: MachineNotice): void
  /** 一台设备的操作记录存在哪。不给就只记在内存里 */
  logStore?(deviceId: string): MachineLogStore | null
  log(line: string): void
}

export interface MachineWiring {
  /** 一次调用。session 是“放进会话对话里的卡片”，找不到会话是 null（卡片进全局待处理） */
  call(
    deviceId: string,
    input: MachineCallInput,
    session: MachineSessionAsk | null,
  ): Promise<ClientToolCallResponse>
  /** 回合结束：这个回合里被拒的记录不要了 */
  turnEnded(deviceId: string, threadId: string, turnId: string): void
  /** 这台设备的开关关掉了：停它发起的进程、撤它的待处理卡片、忘掉“本会话都允许” */
  disabled(deviceId: string): void
  /** 会话所在的设备断开、连回来（断开 10 分钟后执行器收拾它的进程） */
  presence(deviceId: string, online: boolean): void
  /** 设备去掉了：同 disabled，操作记录也不要了 */
  forget(deviceId: string): void
  /** 主题 machine */
  subscribe(sink: HostSink): () => void
  /** 答全局待处理里的一张卡片。已经不在了返回 false */
  answer(pendingId: string, optionId: string, note: string | null): boolean
  kill(processId: string): boolean
  /** 全部停：结束进程、撤掉待处理卡片。给了设备只停它的 */
  stopAll(deviceId?: string): void
  logOf(deviceId: string): MachineLogEntry[]
  clearLog(deviceId: string): void
  dispose(): void
}

/** 全局待处理卡片上的选项：和对话里的一样，没有“始终允许” */
const PENDING_OPTIONS: ApprovalOption[] = [
  { id: 'once', role: 'accept' },
  { id: 'session', role: 'acceptSession' },
  { id: 'decline', role: 'decline', note: true },
]

/** 卡片的结局 */
type AskOutcome =
  | { kind: 'answered'; pick: ToolAnswer; note: string | null }
  | { kind: 'expired' }
  | { kind: 'cancelled' }

interface Pending {
  view: MachinePendingView
  settle(outcome: AskOutcome): void
}

const LOG_RESULTS = new Set<MachineLogEntry['result']>([
  'ok',
  'failed',
  'declined',
  'blocked',
  'expired',
  'disabled',
])

/** 认读回来的操作记录：不合形状的那一条丢掉 */
export function checkMachineLog(raw: unknown, deviceId: string): MachineLogEntry[] {
  if (!Array.isArray(raw)) return []
  const entries: MachineLogEntry[] = []
  for (const one of raw) {
    if (!one || typeof one !== 'object') continue
    const entry = one as Record<string, unknown>
    if (typeof entry.at !== 'number' || typeof entry.tool !== 'string') continue
    if (typeof entry.summary !== 'string') continue
    if (!LOG_RESULTS.has(entry.result as MachineLogEntry['result'])) continue
    entries.push({
      at: entry.at,
      deviceId,
      sessionId: typeof entry.sessionId === 'string' ? entry.sessionId : null,
      harness: typeof entry.harness === 'string' ? entry.harness : null,
      tool: entry.tool,
      summary: entry.summary,
      result: entry.result as MachineLogEntry['result'],
      flagged: entry.flagged === true,
    })
    if (entries.length >= MACHINE_LOG_LIMIT) break
  }
  return entries
}

/** 关着时记一条记录用：从参数里拣出命令、路径或者“从哪到哪” */
export function summarizeCall(tool: string, args: unknown): string {
  const raw = (args && typeof args === 'object' ? args : {}) as Record<string, unknown>
  const text = (value: unknown) => (typeof value === 'string' ? value : '')
  if (typeof raw.command === 'string') return raw.command
  if (typeof raw.path === 'string') return raw.path
  if (raw.from && raw.to && typeof raw.from === 'object' && typeof raw.to === 'object') {
    const from = raw.from as Record<string, unknown>
    const to = raw.to as Record<string, unknown>
    return `${text(from.machine)}:${text(from.path)} → ${text(to.machine)}:${text(to.path)}`
  }
  if (typeof raw.process_id === 'string') return `${text(raw.action)} ${raw.process_id}`.trim()
  return tool
}

/** 卡片要做的事的摘要（通知、记录用） */
const askSummary = (ask: MachineAskView): string => {
  if (ask.command !== null) return ask.command
  if (ask.path !== null) return ask.path
  if (ask.copy) {
    const { from, to } = ask.copy
    return `${from.machine}:${from.path} → ${to.machine}:${to.path}`
  }
  return ask.action
}

/** 同一回合里“同一件事”的键：哪个工具、做什么、哪条命令、哪个路径 */
const sameAsk = (tool: string, ask: MachineAskView): string =>
  JSON.stringify([tool, ask.action, ask.command, ask.cwd, ask.path, ask.copy])

export function createMachineWiring(host: MachineWiringHost): MachineWiring {
  const { clock, executor } = host
  const sinks = new Set<HostSink>()
  const pending = new Map<string, Pending>()
  let pendingSeq = 0
  /** “本会话都允许”：设备、会话（找不到会话的是空串）、类别 */
  const grants = new Set<string>()
  /** 同一回合里被拒的：键 → 用户附的那句话 */
  const declined = new Map<string, string | null>()
  /** 各台设备的操作记录（新的在前），用到时才从存储里读 */
  const logs = new Map<string, MachineLogEntry[]>()

  const grantKey = (deviceId: string, threadId: string | null, kind: 'mutate' | 'read') =>
    `${deviceId}\u0000${threadId ?? ''}\u0000${kind}`
  const turnPrefix = (deviceId: string, threadId: string, turnId: string) =>
    `${deviceId}\u0000${threadId}\u0000${turnId}\u0000`

  const nameOf = (deviceId: string): Text => host.device(deviceId)?.name ?? deviceId

  const activity = (): MachineActivityView => ({
    running: executor
      .processes()
      .map((record) => ({
        id: record.id,
        deviceId: record.owner.deviceId,
        deviceName: nameOf(record.owner.deviceId),
        sessionId: record.owner.threadId,
        harness: record.owner.harness,
        command: record.command,
        cwd: record.cwd,
        startedAt: record.startedAt,
      }))
      .sort((a, b) => a.startedAt - b.startedAt),
    pending: [...pending.values()].map((entry) => entry.view),
  })

  const push = () => {
    if (sinks.size === 0) return
    const op: MachineOp = { op: 'machine.set', view: activity() }
    for (const sink of sinks) sink.delta([op])
  }
  const unlisten = executor.onProcessesChanged(push)

  // —— 操作记录 ——

  const logList = (deviceId: string): MachineLogEntry[] => {
    let list = logs.get(deviceId)
    if (!list) {
      let raw: unknown = null
      try {
        raw = host.logStore?.(deviceId)?.load() ?? null
      } catch (error) {
        host.log(`读操作记录失败：${String(error)}`)
      }
      list = checkMachineLog(raw, deviceId)
      logs.set(deviceId, list)
    }
    return list
  }

  const saveLog = (deviceId: string, list: MachineLogEntry[]) => {
    try {
      host.logStore?.(deviceId)?.save(list)
    } catch (error) {
      host.log(`存操作记录失败：${String(error)}`)
    }
  }

  const addLog = (
    deviceId: string,
    owner: { threadId: string | null; harness: string | null },
    note: Omit<MachineLogEntry, 'at' | 'deviceId' | 'sessionId' | 'harness'>,
  ) => {
    const list = logList(deviceId)
    list.unshift({
      at: clock.now(),
      deviceId,
      sessionId: owner.threadId,
      harness: owner.harness,
      tool: note.tool,
      summary: note.summary,
      result: note.result,
      flagged: note.flagged,
    })
    if (list.length > MACHINE_LOG_LIMIT) list.length = MACHINE_LOG_LIMIT
    saveLog(deviceId, list)
  }

  // —— 能操作的机器 ——

  const desktopTarget = (): MachineTarget | null => {
    const link = host.local()
    if (!link?.online()) return null
    return {
      id: 'desktop',
      role: 'desktop',
      async facts() {
        if (!link.online()) throw new Error('Litch 本机的设备服务没有连着')
        return { ...host.desktop }
      },
      request: (method, params, options) => link.request(method, params, options),
      onProcessNotification: (handler) => link.onProcessNotification(handler),
    }
  }

  const sessionTarget = (deviceId: string): MachineTarget | null => {
    const device = host.device(deviceId)
    if (!device?.link.online()) return null
    return {
      id: 'session',
      role: 'session',
      facts: () => device.facts(),
      request: (method, params, options) => device.link.request(method, params, options),
      onProcessNotification: (handler) => device.link.onProcessNotification(handler),
    }
  }

  const policyOf = (settings: MachineSettings): MachinePolicy => ({
    mode: settings.access.mode,
    denied:
      settings.access.mode === 'sensitive'
        ? SENSITIVE_PRESETS
        : settings.access.mode === 'custom'
          ? [...settings.access.custom]
          : [],
  })

  // —— 卡片 ——

  /** 出一张卡片，等它有结局。卡片挂着时停表（input.hold），10 分钟没人答作废，调用被中止就撤 */
  const askUser = (
    deviceId: string,
    input: MachineCallInput,
    ask: MachineAskView,
    session: MachineSessionAsk | null,
  ): Promise<AskOutcome> =>
    new Promise<AskOutcome>((resolve) => {
      let over = false
      const release = input.hold()
      let drop: () => void = () => {}
      let stopExpiry: () => void = () => {}
      const abort = () => settle({ kind: 'cancelled' })
      const settle = (outcome: AskOutcome) => {
        if (over) return
        over = true
        stopExpiry()
        drop()
        release()
        resolve(outcome)
      }
      if (input.signal.aborted) {
        settle({ kind: 'cancelled' })
        return
      }
      if (session) {
        drop = session(ask, (pick, note) =>
          settle(pick ? { kind: 'answered', pick, note } : { kind: 'cancelled' }),
        )
      }
      // 开启设置的确认同时出现在现有全局待处理中，窗口没打开会话时也能找到。
      if (!session || ask.enable) {
        const id = `machine-pending:${++pendingSeq}`
        const device = host.device(deviceId)
        const view: MachinePendingView = {
          id,
          deviceId,
          deviceName: device?.name ?? deviceId,
          host: device?.host ?? '',
          harness: input.harness,
          ask,
          options: PENDING_OPTIONS.filter(
            (option) => !((ask.perCall || ask.enable) && option.role === 'acceptSession'),
          ).map((option) => ({ ...option })),
          expiresAt: clock.now() + MACHINE_ASK_EXPIRES_MS,
        }
        pending.set(id, { view, settle })
        const dropSession = drop
        drop = () => {
          dropSession()
          if (pending.delete(id)) push()
        }
        push()
        host.notify({
          pendingId: id,
          deviceName: typeof view.deviceName === 'string' ? view.deviceName : view.host,
          host: view.host,
          action: ask.action,
          summary: askSummary(ask),
          ...(ask.enable ? { enable: ask.enable } : {}),
        })
      }
      stopExpiry = clock.setTimer(() => settle({ kind: 'expired' }), MACHINE_ASK_EXPIRES_MS)
      input.signal.addEventListener('abort', abort, { once: true })
    })

  /** MachineCallContext.approve：按审批方式决定弹不弹，命令里提到禁止位置时再弹 */
  const approver =
    (deviceId: string, input: MachineCallInput, session: MachineSessionAsk | null) =>
    async (request: { class: 'mutate' | 'read'; ask: MachineAskView }) => {
      if (input.signal.aborted) return { kind: 'cancelled' } as const
      const settings = host.settings(deviceId)
      if (!settings.enabled) return { kind: 'cancelled' } as const
      if (settings.approval === 'never') return { kind: 'allowed' } as const
      const turnKey =
        input.threadId && input.turnId
          ? turnPrefix(deviceId, input.threadId, input.turnId) + sameAsk(input.tool, request.ask)
          : null
      // 同一回合里拒过的同一件事：不再问
      if (turnKey !== null && declined.has(turnKey)) {
        return { kind: 'declined', note: declined.get(turnKey) ?? null } as const
      }
      const grant = grantKey(deviceId, input.threadId, request.class)
      const flagged = request.ask.flagged.length > 0
      const each = settings.approval === 'each' && request.class === 'mutate'
      if (!flagged && !each && grants.has(grant)) return { kind: 'allowed' } as const
      const ask = each ? { ...request.ask, perCall: true } : request.ask
      const outcome = await askUser(deviceId, input, ask, session)
      if (outcome.kind !== 'answered') return outcome
      if (outcome.pick === 'decline') {
        if (turnKey !== null) declined.set(turnKey, outcome.note)
        return { kind: 'declined', note: outcome.note } as const
      }
      if (outcome.pick === 'session') grants.add(grant)
      return { kind: 'allowed' } as const
    }

  /** 撤掉全局待处理里的卡片（这台设备的，不给就是全部），调用那边当作被取消 */
  const dropPending = (deviceId?: string) => {
    for (const entry of [...pending.values()]) {
      if (deviceId === undefined || entry.view.deviceId === deviceId) {
        entry.settle({ kind: 'cancelled' })
      }
    }
  }

  const forgetGrants = (deviceId: string) => {
    const prefix = `${deviceId}\u0000`
    for (const key of [...grants]) if (key.startsWith(prefix)) grants.delete(key)
    for (const key of [...declined.keys()]) if (key.startsWith(prefix)) declined.delete(key)
  }

  return {
    async call(deviceId, input, session) {
      const owner = { deviceId, threadId: input.threadId, harness: input.harness }
      let settings = host.settings(deviceId)
      if (!settings.enabled && host.device(deviceId) && !input.signal.aborted) {
        const key =
          input.threadId && input.turnId
            ? `${turnPrefix(deviceId, input.threadId, input.turnId)}enable`
            : null
        if (key === null || !declined.has(key)) {
          const outcome = await askUser(
            deviceId,
            input,
            {
              kind: 'machine',
              enable: { sessionId: input.threadId },
              action: 'exec',
              command: `${input.tool}: ${summarizeCall(input.tool, input.arguments)}`,
              cwd: null,
              path: null,
              copy: null,
              flagged: [],
              perCall: true,
            },
            session,
          )
          if (
            outcome.kind === 'answered' &&
            outcome.pick === 'once' &&
            !input.signal.aborted &&
            host.device(deviceId)
          ) {
            // 用户已在另一张卡或设置页开启时保留其设置，不覆盖后续选择。
            if (!host.settings(deviceId).enabled) host.enable(deviceId)
          } else {
            if (key !== null) declined.set(key, null)
            addLog(deviceId, owner, {
              tool: input.tool,
              summary: summarizeCall(input.tool, input.arguments),
              result: 'disabled',
              flagged: false,
            })
            return clientToolFailure('disabled', MACHINE_ENABLE_DECLINED)
          }
        }
        settings = host.settings(deviceId)
      }
      if (!settings.enabled || !host.device(deviceId) || input.signal.aborted) {
        addLog(deviceId, owner, {
          tool: input.tool,
          summary: summarizeCall(input.tool, input.arguments),
          result: 'disabled',
          flagged: false,
        })
        return clientToolFailure('disabled', MACHINE_DISABLED)
      }
      const context: MachineCallContext = {
        owner,
        target(id) {
          if (id === 'desktop') return desktopTarget()
          if (id === 'session') return sessionTarget(deviceId)
          return null
        },
        targets: () =>
          [desktopTarget(), sessionTarget(deviceId)].filter(
            (target): target is MachineTarget => target !== null,
          ),
        policy: policyOf(settings),
        settings: { approval: settings.approval, access: settings.access.mode },
        approve: approver(deviceId, input, session),
        log: (note: MachineLogNote) => addLog(deviceId, owner, note),
        signal: input.signal,
      }
      try {
        return await executor.call(input.tool, input.arguments, context)
      } catch (error) {
        // 执行器说好了不抛错；真抛了也不能让引擎那头干等
        host.log(`litch_machine 执行器出错：${String(error)}`)
        return clientToolFailure('failed', 'The desktop failed to run this tool call.')
      }
    },

    turnEnded(deviceId, threadId, turnId) {
      const prefix = turnPrefix(deviceId, threadId, turnId)
      for (const key of [...declined.keys()]) if (key.startsWith(prefix)) declined.delete(key)
    },

    disabled(deviceId) {
      executor.stopAll(deviceId)
      dropPending(deviceId)
      forgetGrants(deviceId)
    },

    presence(deviceId, online) {
      executor.ownerPresence(deviceId, online)
    },

    forget(deviceId) {
      executor.stopAll(deviceId)
      dropPending(deviceId)
      forgetGrants(deviceId)
      logs.delete(deviceId)
    },

    subscribe(sink) {
      sink.snapshot(activity())
      sinks.add(sink)
      return () => {
        sinks.delete(sink)
      }
    },

    answer(pendingId, optionId, note) {
      const entry = pending.get(pendingId)
      if (!entry) return false
      const option = entry.view.options.find((one) => one.id === optionId)
      if (!option) return false
      const pick: ToolAnswer =
        option.role === 'accept' ? 'once' : option.role === 'acceptSession' ? 'session' : 'decline'
      entry.settle({
        kind: 'answered',
        pick,
        note: option.note ? note?.trim() || null : null,
      })
      return true
    },

    kill: (processId) => executor.kill(processId),

    stopAll(deviceId) {
      executor.stopAll(deviceId)
      dropPending(deviceId)
    },

    logOf: (deviceId) => logList(deviceId).map((entry) => ({ ...entry })),

    clearLog(deviceId) {
      logs.set(deviceId, [])
      saveLog(deviceId, [])
    },

    dispose() {
      unlisten()
      dropPending()
      sinks.clear()
      executor.dispose()
    },
  }
}
