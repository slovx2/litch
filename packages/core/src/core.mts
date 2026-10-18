// 真正的核心：管着各台设备，对通道实现“命令”和“订阅”两个入口。
// 它和模拟核心实现的是同一个接口，界面分不出对面是哪一个。
import { clientToolFailure } from '../../protocol/src/client-tools.mjs'
import type { ClientInfo } from '../../protocol/src/index.mjs'
import { ChannelError, type Clock, type Commands } from './channel/protocol.mjs'
import type { CoreHost, HostSink } from './channel/server.mjs'
import { ConnectError } from './connection/transport.mjs'
import {
  createDevice,
  DEFAULT_TOOL_SWITCHES,
  type Device,
  type DeviceConfig,
} from './device/device.mjs'
import { channelFailure } from './device/faults.mjs'
import { createMachineExecutor, type MachineExecutorOptions } from './device/machine/executor.mjs'
import { SENSITIVE_PRESETS } from './device/machine/presets.mjs'
import type { MachineExecutor, MachineFacts } from './device/machine/types.mjs'
import {
  checkTarget,
  cleanDeniedPaths,
  type DeviceStore,
  defaultName,
  hostLabel,
  type RemotePlatform,
  type SavedRemote,
  sameTarget,
  WIRES,
} from './device/remote.mjs'
import {
  createMachineWiring,
  MACHINE_DISABLED,
  type MachineSettings,
  type MachineWiring,
} from './machine-wiring.mjs'
import type { AppView, RemoteCheck, WireColor } from './model.mjs'
import type { ClientToolPort } from './model-client-tools.mjs'
import type { MachineAccessMode, MachineAccessView, MachineApproval } from './model-machine.mjs'
import type { TerminalsAlive } from './model-terminal.mjs'
import { phrase } from './phrase.mjs'
import { outgoing } from './projection/outgoing.mjs'
import { createToolHub } from './tool-hub.mjs'

export interface CoreOptions {
  clock: Clock
  /** 客户端自己的版本号，握手时报给对面，也显示在界面上 */
  version: string
  /** 一直都在、去不掉的设备：现在就是本机 */
  devices: DeviceConfig[]
  /** 远程设备怎么连。不给就加不了远程设备 */
  remote?: RemotePlatform
  /** 设备配置和侧栏快照存在哪。不给就什么都不记 */
  store?: DeviceStore
  /** 通往主进程的客户端工具那一头（内置浏览器、Computer Use）。不给就是这台桌面什么都执行不了 */
  clientTools?: ClientToolPort
  /**
   * 远程设备上的会话操作这台电脑（litch_machine）。不给就不声明这个命名空间（测试、没有外壳的核心）
   */
  machine?: CoreMachineOptions
  log?(line: string): void
}

export interface CoreMachineOptions {
  /** 这台桌面端自己的情况，外壳现查的（核心就住在这台电脑上） */
  desktop: MachineFacts
  /** 造执行器。不给就用真的（device/machine/executor.mts）；测试里换成假的 */
  executor?(options: MachineExecutorOptions): MachineExecutor
}

const APPROVALS: readonly MachineApproval[] = ['session', 'each', 'never']
const ACCESS_MODES: readonly MachineAccessMode[] = ['sensitive', 'open', 'custom']

export interface Core extends CoreHost {
  /** 开始连接各台设备。各连各的，谁连不上都不耽误别人 */
  start(): void
  stop(): void
  /** 各台设备上还活着的终端一共有多少。外壳在退出应用之前问 */
  terminalsAlive(): TerminalsAlive
  /** 把开着的、属于设备的终端都结束掉：退出应用时用户选了“结束”才调。等各台设备应答，或者到点 */
  endTerminals(): Promise<void>
}

/**
 * 把连接层的错误换成通道上的错误码，界面按码决定怎么提示。
 * 设备自己已经换好的（它知道 harness 叫什么，说得更清楚）原样过去，这里兜的是剩下的
 */
const toChannelFailure = (error: unknown): ChannelError => channelFailure(error)

export function createCore(options: CoreOptions): Core {
  const clientInfo: ClientInfo = { name: 'litch', title: 'Litch', version: options.version }
  const devices = new Map<string, Device>()
  const appSinks = new Set<HostSink>()
  const sidebarSinks = new Map<string, Set<HostSink>>()

  const deviceOf = (deviceId: string): Device => {
    const device = devices.get(deviceId)
    if (!device) throw new ChannelError('notFound', `没有这台设备：${deviceId}`)
    return device
  }

  const { remote, store } = options
  let saved = store?.load() ?? { localWire: null, remotes: [] }
  let started = false
  const hub = createToolHub(options.clientTools, (line) => options.log?.(line))
  /** 一台设备的两个开关现在是什么：改过的按改的，没改过的按默认 */
  const switchesOf = (deviceId: string) => {
    const kept = saved.tools?.[deviceId] ?? {}
    return {
      browser: kept.browser ?? DEFAULT_TOOL_SWITCHES.browser,
      computer: kept.computer ?? DEFAULT_TOOL_SWITCHES.computer,
    }
  }

  // —— litch_machine：远程设备上的会话操作这台电脑 ——

  /** 一台远程设备上“操作这台电脑”的设置：开关默认关，每个会话确认一次，禁止常用敏感位置 */
  const machineSettingsOf = (deviceId: string): MachineSettings => {
    const kept = saved.machine?.[deviceId] ?? {}
    return {
      enabled: saved.tools?.[deviceId]?.machine === true,
      approval: kept.approval ?? 'session',
      access: { mode: kept.access ?? 'sensitive', custom: kept.custom ?? [] },
    }
  }
  const machineView = (deviceId: string): MachineAccessView => {
    const settings = machineSettingsOf(deviceId)
    return {
      enabled: settings.enabled,
      approval: settings.approval,
      access: { mode: settings.access.mode, custom: [...settings.access.custom] },
      presets: [...SENSITIVE_PRESETS],
    }
  }
  const machineOptions = options.machine
  const wiring: MachineWiring | null = machineOptions
    ? createMachineWiring({
        clock: options.clock,
        executor: (machineOptions.executor ?? createMachineExecutor)({
          clock: options.clock,
          ...(options.log ? { log: options.log } : {}),
        }),
        desktop: machineOptions.desktop,
        local: () =>
          [...devices.values()].find((device) => device.view.kind === 'local')?.machineLink ?? null,
        device(deviceId) {
          const device = devices.get(deviceId)
          if (device?.view.kind !== 'ssh') return null
          return {
            name: device.view.name,
            host: device.view.host,
            link: device.machineLink,
            facts: () => device.machineFacts(),
          }
        },
        settings: machineSettingsOf,
        notify: (notice) => hub.notify(notice),
        ...(store?.machineLog
          ? { logStore: (deviceId: string) => store.machineLog?.(deviceId) ?? null }
          : {}),
        log: (line) => options.log?.(line),
      })
    : null
  /** 握手时报的这台桌面端 */
  const desktopInfo = machineOptions
    ? {
        hostname: machineOptions.desktop.hostname,
        name: machineOptions.desktop.name,
        system: machineOptions.desktop.system,
      }
    : null

  const build = (config: DeviceConfig): Device => {
    // 已经换掉或者去掉的设备再报什么都不理
    const current = () => devices.get(config.id) === device
    const device: Device = createDevice(config, {
      clock: options.clock,
      clientInfo,
      ...(options.log ? { log: options.log } : {}),
      ...(store ? { snapshot: store.snapshot(config.id) } : {}),
      ...(store?.terminals ? { terminalNotes: store.terminals(config.id) } : {}),
      tools: hub,
      toolSwitches: () => switchesOf(config.id),
      // 只有远程设备有“操作这台电脑”
      ...(wiring && desktopInfo && config.kind === 'ssh'
        ? {
            machine: {
              view: () => machineView(config.id),
              desktop: desktopInfo,
              call: (input, session) => wiring.call(config.id, input, session),
              turnEnded: (threadId, turnId) => wiring.turnEnded(config.id, threadId, turnId),
              presence(online) {
                if (current()) wiring.presence(config.id, online)
              },
            },
          }
        : {}),
      hooks: {
        device(view) {
          if (!current()) return
          for (const sink of appSinks) sink.delta([{ op: 'device.upsert', device: view }])
        },
        sidebar(view) {
          if (!current()) return
          for (const sink of sidebarSinks.get(config.id) ?? []) sink.snapshot(view)
        },
        sidebarOps(ops) {
          if (!current()) return
          for (const sink of sidebarSinks.get(config.id) ?? []) sink.delta(ops)
        },
      },
    })
    return device
  }

  /** 没有外壳给的远程能力时，远程设备只能摆在那里，连不了 */
  const openerOf = (entry: SavedRemote) =>
    remote
      ? remote.opener(entry.target)
      : async () => {
          throw new ConnectError('unreachable', phrase('ssh.noClient'), false)
        }

  const remoteConfig = (entry: SavedRemote): DeviceConfig => ({
    id: entry.id,
    name: entry.name,
    host: hostLabel(entry.target),
    kind: 'ssh',
    target: entry.target,
    wire: entry.wire,
    open: openerOf(entry),
  })

  for (const config of options.devices) {
    const wire = config.id === 'local' ? (saved.localWire ?? config.wire) : config.wire
    devices.set(config.id, build({ ...config, wire }))
  }
  for (const entry of saved.remotes) {
    if (!devices.has(entry.id)) devices.set(entry.id, build(remoteConfig(entry)))
  }

  const persist = () => {
    try {
      store?.save(saved)
    } catch (error) {
      options.log?.(`存设备配置失败：${String(error)}`)
    }
  }

  const announce = (device: Device) => {
    for (const sink of appSinks) sink.delta([{ op: 'device.upsert', device: device.view }])
  }

  /** 挑一个还没有设备在用的线色；都用过了就从头轮 */
  const freeWire = (): WireColor => {
    const used = new Set([...devices.values()].map((device) => device.view.wire))
    return WIRES.find((wire) => !used.has(wire)) ?? WIRES[devices.size % WIRES.length] ?? 'slate'
  }

  const newId = (): string => {
    for (let n = saved.remotes.length + 1; ; n++) {
      const id = `ssh-${n}`
      if (!devices.has(id)) return id
    }
  }

  const savedRemote = (deviceId: string): SavedRemote => {
    const entry = saved.remotes.find((remote) => remote.id === deviceId)
    if (!entry) throw new ChannelError('rejected', '本机设备不能这样改')
    return entry
  }

  /** “操作这台电脑”只有远程设备有，这台桌面端也得执行得了 */
  const machineDevice = (deviceId: string): void => {
    const device = deviceOf(deviceId)
    if (device.view.kind !== 'ssh') throw new ChannelError('invalid', '本机设备没有这一项')
    if (!wiring) throw new ChannelError('unsupported', '这台桌面端执行不了 litch_machine')
  }

  const wireOf = (value: unknown): WireColor => {
    if (!WIRES.includes(value as WireColor)) throw new ChannelError('rejected', '没有这种线色')
    return value as WireColor
  }

  return {
    start() {
      started = true
      for (const device of devices.values()) device.start()
    },

    stop() {
      started = false
      for (const device of devices.values()) device.stop()
    },

    terminalsAlive() {
      const total: TerminalsAlive = { durable: 0, ephemeral: 0 }
      for (const device of devices.values()) {
        const alive = device.terminals.alive()
        total.durable += alive.durable
        total.ephemeral += alive.ephemeral
      }
      return total
    },

    async endTerminals() {
      await Promise.all([...devices.values()].map((device) => device.terminals.endAll()))
    },

    async command(name, params, signal) {
      switch (name) {
        case 'core.info':
          return { version: options.version, mock: false }
        case 'session.markRead': {
          const { deviceId, sessionId } = params as Commands['session.markRead']['params']
          deviceOf(deviceId).markRead(sessionId)
          return {}
        }
        case 'session.send': {
          const { deviceId, sessionId, text, images, extras } =
            params as Commands['session.send']['params']
          try {
            await deviceOf(deviceId).send(sessionId, outgoing(text, images, extras))
          } catch (error) {
            throw toChannelFailure(error)
          }
          return {}
        }
        case 'session.create': {
          const { deviceId, harness, workspaceId, cwd, text, images, extras, settings } =
            params as Commands['session.create']['params']
          try {
            const message = outgoing(text, images, extras)
            const device = deviceOf(deviceId)
            return {
              sessionId: await device.create(cwd, message, settings ?? {}, harness, workspaceId),
            }
          } catch (error) {
            throw toChannelFailure(error)
          }
        }
        case 'session.configure': {
          const { deviceId, sessionId, settings } =
            params as Commands['session.configure']['params']
          deviceOf(deviceId).configure(sessionId, settings)
          return {}
        }
        case 'session.rename': {
          const { deviceId, sessionId, title } = params as Commands['session.rename']['params']
          try {
            await deviceOf(deviceId).rename(sessionId, title)
          } catch (error) {
            throw toChannelFailure(error)
          }
          return {}
        }
        case 'session.archive':
        case 'session.delete': {
          const { deviceId, sessionId } = params as Commands['session.archive']['params']
          const device = deviceOf(deviceId)
          try {
            await (name === 'session.archive'
              ? device.archive(sessionId)
              : device.remove(sessionId))
          } catch (error) {
            throw toChannelFailure(error)
          }
          return {}
        }
        case 'session.unarchive': {
          const { deviceId, sessionId } = params as Commands['session.unarchive']['params']
          try {
            await deviceOf(deviceId).unarchive(sessionId)
          } catch (error) {
            throw toChannelFailure(error)
          }
          return {}
        }
        // 整理侧栏。出错的原因设备自己已经换成给人看的了，原样过去
        case 'session.place': {
          const { deviceId, sessionId, place } = params as Commands['session.place']['params']
          await deviceOf(deviceId).organize.placeSession(
            sessionId,
            place === 'pinned' ? place : null,
          )
          return {}
        }
        case 'session.move': {
          const { deviceId, sessionId, workspaceId } = params as Commands['session.move']['params']
          await deviceOf(deviceId).organize.moveSession(sessionId, workspaceId)
          return {}
        }
        case 'workspace.create': {
          const { deviceId, name, root, color } = params as Commands['workspace.create']['params']
          const workspaceId = await deviceOf(deviceId).organize.createWorkspace({
            name: String(name ?? ''),
            root: String(root ?? ''),
            color: color == null ? null : wireOf(color),
          })
          return { workspaceId }
        }
        case 'workspace.update': {
          const { deviceId, workspaceId, name, color } =
            params as Commands['workspace.update']['params']
          await deviceOf(deviceId).organize.updateWorkspace(workspaceId, {
            ...(name === undefined ? {} : { name: String(name) }),
            ...(color === undefined ? {} : { color: color === null ? null : wireOf(color) }),
          })
          return {}
        }
        case 'workspace.move': {
          const { deviceId, workspaceId, before } = params as Commands['workspace.move']['params']
          await deviceOf(deviceId).organize.moveWorkspace(workspaceId, before ?? null)
          return {}
        }
        case 'workspace.delete': {
          const { deviceId, workspaceId } = params as Commands['workspace.delete']['params']
          await deviceOf(deviceId).organize.deleteWorkspace(workspaceId)
          return {}
        }
        case 'workspace.candidates': {
          const { deviceId } = params as Commands['workspace.candidates']['params']
          return { roots: deviceOf(deviceId).rootCandidates() }
        }
        case 'device.loadArchived': {
          const { deviceId } = params as Commands['device.loadArchived']['params']
          try {
            await deviceOf(deviceId).loadArchived()
          } catch (error) {
            throw toChannelFailure(error)
          }
          return {}
        }
        case 'device.composeOptions': {
          const { deviceId, harness } = params as Commands['device.composeOptions']['params']
          try {
            return await deviceOf(deviceId).composeOptions(harness)
          } catch (error) {
            throw toChannelFailure(error)
          }
        }
        case 'device.newSessionDefaults': {
          const { deviceId, harness, cwd } =
            params as Commands['device.newSessionDefaults']['params']
          try {
            return await deviceOf(deviceId).newSessionDefaults(harness, cwd)
          } catch (error) {
            throw toChannelFailure(error)
          }
        }
        case 'device.skills': {
          const { deviceId, harness, cwd } = params as Commands['device.skills']['params']
          // 没问成的原因设备自己已经换成给人看的了，原样过去
          return await deviceOf(deviceId).skills(harness, cwd ?? null)
        }
        case 'session.steer': {
          const { deviceId, sessionId, messageId } = params as Commands['session.steer']['params']
          try {
            await deviceOf(deviceId).steer(sessionId, messageId)
          } catch (error) {
            throw toChannelFailure(error)
          }
          return {}
        }
        case 'session.interrupt': {
          const { deviceId, sessionId } = params as Commands['session.interrupt']['params']
          try {
            await deviceOf(deviceId).interrupt(sessionId)
          } catch (error) {
            throw toChannelFailure(error)
          }
          return {}
        }
        case 'session.unqueue': {
          const { deviceId, sessionId, messageId } = params as Commands['session.unqueue']['params']
          deviceOf(deviceId).unqueue(sessionId, messageId)
          return {}
        }
        case 'session.respond': {
          const { deviceId, sessionId, requestId, ...choice } =
            params as Commands['session.respond']['params']
          deviceOf(deviceId).respond(sessionId, requestId, choice)
          return {}
        }
        case 'session.fork': {
          const { deviceId, sessionId, turnId } = params as Commands['session.fork']['params']
          try {
            return { sessionId: await deviceOf(deviceId).fork(sessionId, turnId) }
          } catch (error) {
            throw toChannelFailure(error)
          }
        }
        case 'session.rollback': {
          const { deviceId, sessionId, turnId } = params as Commands['session.rollback']['params']
          try {
            await deviceOf(deviceId).rollback(sessionId, turnId)
          } catch (error) {
            throw toChannelFailure(error)
          }
          return {}
        }
        case 'session.implementPlan': {
          const { deviceId, sessionId, text } =
            params as Commands['session.implementPlan']['params']
          try {
            await deviceOf(deviceId).implementPlan(sessionId, text)
          } catch (error) {
            throw toChannelFailure(error)
          }
          return {}
        }
        case 'session.compact': {
          const { deviceId, sessionId } = params as Commands['session.compact']['params']
          try {
            await deviceOf(deviceId).compact(sessionId)
          } catch (error) {
            throw toChannelFailure(error)
          }
          return {}
        }
        case 'device.add': {
          const { name, target, wire } = params as Commands['device.add']['params']
          const checked = checkTarget(target)
          if (saved.remotes.some((entry) => sameTarget(entry.target, checked))) {
            throw new ChannelError('rejected', '这台设备已经加过了')
          }
          const entry: SavedRemote = {
            id: newId(),
            name: (typeof name === 'string' ? name.trim() : '') || defaultName(checked),
            target: checked,
            wire: wire === undefined ? freeWire() : wireOf(wire),
          }
          saved = { ...saved, remotes: [...saved.remotes, entry] }
          persist()
          const device = build(remoteConfig(entry))
          devices.set(entry.id, device)
          announce(device)
          if (started) device.start()
          return { deviceId: entry.id }
        }
        case 'device.update': {
          const { deviceId, name, wire, target } = params as Commands['device.update']['params']
          const device = deviceOf(deviceId)
          if (deviceId === 'local') {
            if (name !== undefined || target !== undefined) {
              throw new ChannelError('rejected', '本机设备只能改线色')
            }
            if (wire !== undefined) {
              saved = { ...saved, localWire: wireOf(wire) }
              persist()
              device.update({ wire: saved.localWire ?? 'green' })
            }
            return {}
          }
          const before = savedRemote(deviceId)
          const next: SavedRemote = {
            ...before,
            ...(name === undefined ? {} : { name: name.trim() || defaultName(before.target) }),
            ...(wire === undefined ? {} : { wire: wireOf(wire) }),
            ...(target === undefined ? {} : { target: checkTarget(target) }),
          }
          const moved = !sameTarget(before.target, next.target)
          if (
            moved &&
            saved.remotes.some(
              (entry) => entry.id !== deviceId && sameTarget(entry.target, next.target),
            )
          ) {
            throw new ChannelError('rejected', '这台设备已经加过了')
          }
          saved = {
            ...saved,
            remotes: saved.remotes.map((entry) => (entry.id === deviceId ? next : entry)),
          }
          persist()
          if (!moved) {
            device.update({ name: next.name, wire: next.wire })
            return {}
          }
          // 换了一台机器：原来那条连接和它的侧栏都不要了，按新的配置重新来；
          // 原来那台在这台电脑上起的进程、挂着的卡片、操作记录也不要了
          device.stopMachine(clientToolFailure('disabled', MACHINE_DISABLED))
          wiring?.forget(deviceId)
          device.stop()
          device.terminals.dispose()
          store?.forget(deviceId)
          const fresh = build(remoteConfig(next))
          devices.set(deviceId, fresh)
          announce(fresh)
          for (const sink of sidebarSinks.get(deviceId) ?? []) sink.snapshot(fresh.sidebar)
          if (started) fresh.start()
          return {}
        }
        case 'device.tools.set': {
          const { deviceId, browser, computer, machine } =
            params as Commands['device.tools.set']['params']
          const device = deviceOf(deviceId)
          if (typeof machine === 'boolean') machineDevice(deviceId)
          const before = saved.tools?.[deviceId] ?? {}
          const next = {
            ...before,
            ...(typeof browser === 'boolean' ? { browser } : {}),
            ...(typeof computer === 'boolean' ? { computer } : {}),
            ...(typeof machine === 'boolean' ? { machine } : {}),
          }
          saved = { ...saved, tools: { ...(saved.tools ?? {}), [deviceId]: next } }
          persist()
          // 关掉“操作这台电脑”的那一刻（08 号 3.1）：进行中的调用回失败、卡片撤掉、它起的进程都结束
          if (machine === false && before.machine === true) {
            device.stopMachine(clientToolFailure('disabled', MACHINE_DISABLED))
            wiring?.disabled(deviceId)
          }
          // 开关只在执行时查：已经建好的会话里的调用，下一次就按新的来
          device.update({})
          return {}
        }
        case 'device.machine.set': {
          const { deviceId, approval, access } = params as Commands['device.machine.set']['params']
          const device = deviceOf(deviceId)
          machineDevice(deviceId)
          const before = saved.machine?.[deviceId] ?? {}
          const next = { ...before }
          if (approval !== undefined) {
            if (!APPROVALS.includes(approval)) throw new ChannelError('invalid', '没有这种审批方式')
            next.approval = approval
          }
          if (access !== undefined) {
            if (!access || !ACCESS_MODES.includes(access.mode)) {
              throw new ChannelError('invalid', '没有这种访问范围')
            }
            next.access = access.mode
            if (Array.isArray(access.custom)) next.custom = cleanDeniedPaths(access.custom)
            else if (access.mode === 'custom' && before.custom === undefined) {
              // 第一次切到自定义：从内置名单起步
              next.custom = [...SENSITIVE_PRESETS]
            }
          }
          saved = { ...saved, machine: { ...(saved.machine ?? {}), [deviceId]: next } }
          persist()
          device.update({})
          return {}
        }
        case 'machine.answer': {
          const { pendingId, optionId, note } = params as Commands['machine.answer']['params']
          if (!wiring?.answer(String(pendingId), String(optionId), note ?? null)) {
            throw new ChannelError('notFound', '这张卡片已经不在了')
          }
          return {}
        }
        case 'machine.process.kill': {
          const { processId } = params as Commands['machine.process.kill']['params']
          if (!wiring?.kill(String(processId))) {
            throw new ChannelError('notFound', '这个进程已经不在了')
          }
          return {}
        }
        case 'machine.stopAll': {
          const { deviceId } = params as Commands['machine.stopAll']['params']
          wiring?.stopAll(typeof deviceId === 'string' ? deviceId : undefined)
          return {}
        }
        case 'machine.log': {
          const { deviceId } = params as Commands['machine.log']['params']
          deviceOf(deviceId)
          return { entries: wiring?.logOf(deviceId) ?? [] }
        }
        case 'machine.log.clear': {
          const { deviceId } = params as Commands['machine.log.clear']['params']
          deviceOf(deviceId)
          wiring?.clearLog(deviceId)
          return {}
        }
        case 'device.remove': {
          const { deviceId } = params as Commands['device.remove']['params']
          const device = deviceOf(deviceId)
          savedRemote(deviceId)
          // 它的两个开关、“操作这台电脑”的设置也不留
          const tools = { ...(saved.tools ?? {}) }
          delete tools[deviceId]
          const machine = { ...(saved.machine ?? {}) }
          delete machine[deviceId]
          saved = {
            localWire: saved.localWire,
            remotes: saved.remotes.filter((entry) => entry.id !== deviceId),
            ...(Object.keys(tools).length > 0 ? { tools } : {}),
            ...(Object.keys(machine).length > 0 ? { machine } : {}),
          }
          persist()
          devices.delete(deviceId)
          device.stopMachine(clientToolFailure('disabled', MACHINE_DISABLED))
          wiring?.forget(deviceId)
          device.stop()
          device.terminals.dispose()
          store?.forget(deviceId)
          sidebarSinks.delete(deviceId)
          for (const sink of appSinks) sink.delta([{ op: 'device.remove', deviceId }])
          return {}
        }
        case 'remote.discover':
          if (!remote) return { hosts: [] }
          return { hosts: await remote.discover() }
        case 'remote.check': {
          const { target } = params as Commands['remote.check']['params']
          const checked = checkTarget(target)
          if (!remote) {
            return {
              ok: false,
              failure: {
                stage: 'unreachable',
                text: phrase('ssh.noClient'),
                detail: null,
                retrying: false,
              },
            } satisfies RemoteCheck
          }
          return await remote.check(checked, signal)
        }
        case 'device.settings.write': {
          const { deviceId, expectedVersion, edits } =
            params as Commands['device.settings.write']['params']
          // 出错的原因设备自己已经换成给人看的了（冲突、哪一项不合规矩），原样过去
          return await deviceOf(deviceId).writeSettings(expectedVersion, edits)
        }
        case 'device.harness.restart': {
          const { deviceId, harness, force } =
            params as Commands['device.harness.restart']['params']
          return await deviceOf(deviceId).restartHarness(harness, force === true)
        }
        case 'device.diagnostics.run': {
          const { deviceId, harness } = params as Commands['device.diagnostics.run']['params']
          return await deviceOf(deviceId).runDiagnostics(harness)
        }
        case 'device.logs.read': {
          const { deviceId, source, harness, maxBytes } =
            params as Commands['device.logs.read']['params']
          return await deviceOf(deviceId).readLogs(source, harness, maxBytes)
        }
        case 'device.sshConfig.read': {
          const { deviceId } = params as Commands['device.sshConfig.read']['params']
          return await deviceOf(deviceId).readSshConfig()
        }
        case 'device.reconnect':
          deviceOf((params as { deviceId: string }).deviceId).retry()
          return {}
        case 'terminal.open': {
          const { deviceId, workspaceId, cwd, rows, cols } =
            params as Commands['terminal.open']['params']
          // 没起来的原因终端那一层已经换成给人看的了，原样过去
          const { terminals } = deviceOf(deviceId)
          return { terminalId: await terminals.open(workspaceId ?? null, cwd ?? null, rows, cols) }
        }
        case 'terminal.write': {
          const { deviceId, terminalId, data } = params as Commands['terminal.write']['params']
          deviceOf(deviceId).terminals.write(terminalId, data)
          return {}
        }
        case 'terminal.resize': {
          const { deviceId, terminalId, rows, cols } =
            params as Commands['terminal.resize']['params']
          deviceOf(deviceId).terminals.resize(terminalId, rows, cols)
          return {}
        }
        case 'terminal.redraw': {
          const { deviceId, terminalId } = params as Commands['terminal.redraw']['params']
          deviceOf(deviceId).terminals.redraw(terminalId)
          return {}
        }
        case 'terminal.rename': {
          const { deviceId, terminalId, title } = params as Commands['terminal.rename']['params']
          deviceOf(deviceId).terminals.rename(terminalId, title)
          return {}
        }
        case 'terminal.close': {
          const { deviceId, terminalId, mode } = params as Commands['terminal.close']['params']
          await deviceOf(deviceId).terminals.close(terminalId, mode === 'leave' ? 'leave' : 'end')
          return {}
        }
        case 'terminal.show': {
          const { deviceId, terminalId } = params as Commands['terminal.show']['params']
          deviceOf(deviceId).terminals.show(terminalId)
          return {}
        }
        case 'terminal.restart': {
          const { deviceId, terminalId, rows, cols } =
            params as Commands['terminal.restart']['params']
          await deviceOf(deviceId).terminals.restart(terminalId, rows, cols)
          return {}
        }
        case 'terminal.ack': {
          const { deviceId, terminalId, viewer, epoch, offset } =
            params as Commands['terminal.ack']['params']
          deviceOf(deviceId).terminals.ack(terminalId, viewer, epoch, offset)
          return {}
        }
        // 文件面板。没做成的原因文件那一层已经换成给人看的了，原样过去
        case 'files.list': {
          const { deviceId, root, path, fresh } = params as Commands['files.list']['params']
          return await deviceOf(deviceId).files.list(root, path, fresh === true, signal)
        }
        case 'files.read': {
          const { deviceId, root, path } = params as Commands['files.read']['params']
          return await deviceOf(deviceId).files.read(root, path, signal)
        }
        case 'files.search': {
          const { deviceId, root, query } = params as Commands['files.search']['params']
          return await deviceOf(deviceId).files.search(root, query, signal)
        }
        case 'files.requests': {
          const { deviceId } = params as Commands['files.requests']['params']
          return deviceOf(deviceId).files.requests()
        }
        // 差异面板。没做成的原因差异那一层已经换成给人看的了，原样过去
        case 'diff.files': {
          const { deviceId, root, scope, sessionId } = params as Commands['diff.files']['params']
          return await deviceOf(deviceId).diffs.files(root, scope, sessionId ?? null, signal)
        }
        case 'diff.file': {
          const { deviceId, root, scope, sessionId, path, full } =
            params as Commands['diff.file']['params']
          const { diffs } = deviceOf(deviceId)
          return await diffs.file(root, scope, sessionId ?? null, path, full === true, signal)
        }
        case 'diff.refresh': {
          const { deviceId, root } = params as Commands['diff.refresh']['params']
          await deviceOf(deviceId).diffs.refresh(root)
          return {}
        }
        case 'diff.stage':
        case 'diff.unstage': {
          const { deviceId, root, paths } = params as Commands['diff.stage']['params']
          const { diffs } = deviceOf(deviceId)
          const list = Array.isArray(paths) ? paths : []
          await (name === 'diff.stage' ? diffs.stage(root, list) : diffs.unstage(root, list))
          return {}
        }
        case 'diff.discard': {
          const { deviceId, root, scope, path, expect } =
            params as Commands['diff.discard']['params']
          await deviceOf(deviceId).diffs.discard(root, scope, path, expect)
          return {}
        }
        case 'diff.requests': {
          const { deviceId } = params as Commands['diff.requests']['params']
          return deviceOf(deviceId).diffs.requests()
        }
        case 'device.refresh':
          try {
            await deviceOf((params as { deviceId: string }).deviceId).refresh()
          } catch (error) {
            throw toChannelFailure(error)
          }
          return {}
        default:
          throw new ChannelError('unknownCommand', `不认识的命令：${name}`)
      }
    },

    subscribe(topic, sink) {
      if (topic.kind === 'app') {
        const view: AppView = { devices: [...devices.values()].map((device) => device.view) }
        sink.snapshot(view)
        appSinks.add(sink)
        return () => {
          appSinks.delete(sink)
        }
      }
      // 远程会话在这台电脑上的动静（08 号 3.4、4.2）。这台桌面端执行不了 litch_machine 时一直是空的
      if (topic.kind === 'machine') {
        if (wiring) return wiring.subscribe(sink)
        sink.snapshot({ running: [], pending: [] })
        return () => {}
      }
      const device = deviceOf(topic.deviceId)
      if (topic.kind === 'sidebar') {
        sink.snapshot(device.sidebar)
        const set = sidebarSinks.get(topic.deviceId) ?? new Set<HostSink>()
        sidebarSinks.set(topic.deviceId, set)
        set.add(sink)
        return () => {
          set.delete(sink)
        }
      }
      // 管理数据：对面没有设置接口时这里直接抛 unsupported
      if (topic.kind === 'manage') return device.openManage(sink)
      if (topic.kind === 'terminals') return device.terminals.openList(sink)
      if (topic.kind === 'terminal') {
        return device.terminals.openStream(topic.terminalId, topic.have, sink)
      }
      // 根不认识的话这里直接抛 rejected
      if (topic.kind === 'diff') {
        return device.diffs.open(topic.root, topic.scope, topic.sessionId ?? null, sink)
      }
      // 设备还没连上时订阅照样成立，连上之后才有快照
      return device.openSession(topic.sessionId, sink)
    },
  }
}
