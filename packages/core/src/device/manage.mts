// 一台设备的管理：设备配置接口（协议扩展 deviceSettings）在客户端这一头的样子。
// 读设置的结构和现在的值、按键写入、重启 harness、诊断、读日志末尾、取 ssh 配置片段。
// 核心在这件事上只做转运：有哪些设置由设备服务声明，这里一项都不认识。
//
// 数据流：界面开着设备详情时才读一份；之后对面的通知是唯一的来源；
// 重连之后重新读。不轮询。
import type {
  ClientRequestMethod,
  ClientRequests,
  DeviceSettingsChangedNotification,
  DeviceSettingsSnapshot,
} from '../../../protocol/src/index.mjs'
import { ChannelError, type ManageOp } from '../channel/protocol.mjs'
import type { HostSink } from '../channel/server.mjs'
import { RpcError, type RpcRequestOptions } from '../connection/rpc.mjs'
import type { HarnessId } from '../model.mjs'
import type {
  DiagnosticsView,
  HarnessRestartResult,
  LogSource,
  LogTailView,
  ManageView,
  SettingEditView,
  SettingsSnapshotView,
  SettingsWriteResult,
  SshConfigView,
} from '../model-manage.mjs'
import {
  bilingual,
  changedKeys,
  outgoingEdits,
  projectDiagnostics,
  projectLogTail,
  projectManage,
  projectSnapshot,
  projectSshConfig,
} from '../projection/manage.mjs'

export interface ManagementHost {
  deviceId: string
  online(): boolean
  /** 对面有没有设备配置接口：它是设备服务，而且设备信息的 extensions 里列了 deviceSettings */
  supported(): boolean
  request<M extends ClientRequestMethod>(
    method: M,
    params: ClientRequests[M]['params'],
    options?: RpcRequestOptions,
  ): Promise<ClientRequests[M]['result']>
  /** 请求没做成：换成给人看的错误 */
  fail(error: unknown): ChannelError
  /** 手上那份设置的值换了（null 是不留了：没人订阅、读不成）。设备的显示数据里任务卡的开关靠它 */
  viewed?(snapshot: SettingsSnapshotView | null): void
  log(line: string): void
}

export interface Management {
  /** 订阅这台设备的管理数据。先给快照，之后给增量；返回退订函数 */
  open(sink: HostSink): () => void
  /** 连上并认出对面是谁了：给开着的订阅读一份新的 */
  resync(): void
  /** 连接断了：在途的结果都不算数了 */
  offline(): void
  /** 对面说设置、待重启的名单或者 SSH 入口的状况变了 */
  changed(note: DeviceSettingsChangedNotification): void
  write(expectedVersion: number, edits: readonly SettingEditView[]): Promise<SettingsWriteResult>
  restart(harness: HarnessId, force: boolean): Promise<HarnessRestartResult>
  diagnostics(harness: HarnessId | undefined): Promise<DiagnosticsView>
  logs(
    source: LogSource,
    harness: HarnessId | undefined,
    maxBytes: number | undefined,
  ): Promise<LogTailView>
  sshConfig(): Promise<SshConfigView>
}

/**
 * 这几件事对面要做一阵才应答，默认的三十秒不够：
 * 写入之后设备服务可能顺手把 harness 重新起一遍；重启要等到它有结果，最长约一分半；诊断要把几个 harness 都查一遍。
 */
const WAIT = { write: 120_000, restart: 130_000, diagnostics: 180_000 }

const UNSUPPORTED = '这台设备没有设置接口'

const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((entry) => typeof entry === 'string') : []

/** 冲突的错误里带着的最新快照。别的错误没有 */
function conflictSnapshot(error: unknown): DeviceSettingsSnapshot | null {
  if (!(error instanceof RpcError)) return null
  const data = error.data as { litch?: unknown; snapshot?: unknown } | null | undefined
  if (data?.litch !== 'settingsConflict') return null
  return typeof data.snapshot === 'object' && data.snapshot !== null
    ? (data.snapshot as DeviceSettingsSnapshot)
    : null
}

export function createManagement(host: ManagementHost): Management {
  const sinks = new Set<HostSink>()
  /** 最新的一份。只在有人订阅的时候留着、跟着通知改；没人看就不留，下次订阅重新读 */
  let view: ManageView | null = null
  /** 每次断开换一个代号，在途的读取回来时对不上就作废 */
  let epoch = 0
  let loading = false
  /** 读取途中到的通知：结构还没到，投影不了，先攒着 */
  let early: DeviceSettingsChangedNotification[] = []
  /** 自己有几次写入还没等到应答 */
  let writing = 0
  /**
   * 写入途中到的通知先攒着。设备服务是先把写入广播出去、再去重启该重启的 harness、最后才应答：
   * 中间那几条通知里，harness 会先被标成“待重启”再摘掉。等应答到了按它的快照一次到位，界面不跟着闪。
   * 应答之后还要看一眼攒着的里面和它同版本的最后一条：见 write。
   */
  let held: DeviceSettingsChangedNotification[] = []

  const publish = (ops: ManageOp[]) => {
    for (const sink of sinks) sink.delta(ops)
  }

  /** 换上一份新的值。比手上这份旧的不要；没有变化就不打扰界面 */
  const apply = (raw: DeviceSettingsSnapshot, keys: readonly string[]) => {
    if (!view) return
    const next = projectSnapshot(view.settings, raw)
    if (next.version < view.snapshot.version) return
    const declared = new Set(view.settings.map((spec) => spec.key))
    const touched = new Set([
      ...keys.filter((key) => declared.has(key)),
      ...changedKeys(view.snapshot, next),
    ])
    if (touched.size === 0 && JSON.stringify(next) === JSON.stringify(view.snapshot)) return
    view = { ...view, snapshot: next }
    publish([{ op: 'settings.set', snapshot: next, keys: [...touched] }])
    host.viewed?.(next)
  }

  const end = (error: ChannelError) => {
    const closing = [...sinks]
    sinks.clear()
    view = null
    host.viewed?.(null)
    for (const sink of closing) sink.error(error)
  }

  const load = async () => {
    if (loading) return
    loading = true
    early = []
    const mine = epoch
    try {
      const raw = await host.request('litch/device/settings/read', {})
      if (mine !== epoch) return
      view = projectManage(host.deviceId, raw)
      for (const sink of sinks) sink.snapshot(view)
      host.viewed?.(view.snapshot)
      // 读的这一会儿里到的通知：比读到的新才用得上
      for (const note of early) apply(note.snapshot, strings(note.keys))
    } catch (error) {
      if (mine !== epoch) return
      host.log(`读设备的设置失败：${String(error)}`)
      end(host.fail(error))
    } finally {
      if (mine === epoch) {
        loading = false
        early = []
      }
    }
  }

  /** 写入有了结果之后，把攒着的通知放出来。floor：这个版本号及更早的已经包含在写入的结果里了 */
  const release = (floor: number) => {
    const pending = held
    held = []
    for (const note of pending) {
      if (note.snapshot.version > floor) apply(note.snapshot, strings(note.keys))
    }
  }

  const reachable = () => {
    if (!host.online()) throw new ChannelError('offline', '设备没有连上')
    if (!host.supported()) throw new ChannelError('unsupported', UNSUPPORTED)
  }

  return {
    open(sink) {
      if (host.online() && !host.supported()) throw new ChannelError('unsupported', UNSUPPORTED)
      sinks.add(sink)
      if (view) sink.snapshot(view)
      else if (host.online()) void load()
      return () => {
        sinks.delete(sink)
        // 没人看了：不再留着，免得之后拿一份没跟上通知的旧数据当新的给出去
        if (sinks.size === 0 && view) {
          view = null
          host.viewed?.(null)
        }
      }
    },

    resync() {
      loading = false
      if (sinks.size === 0) return
      if (!host.supported()) {
        end(new ChannelError('unsupported', UNSUPPORTED))
        return
      }
      void load()
    },

    offline() {
      epoch++
      loading = false
      early = []
      held = []
      writing = 0
    },

    changed(note) {
      if (typeof note?.snapshot !== 'object' || note.snapshot === null) return
      if (loading) early.push(note)
      else if (writing > 0) held.push(note)
      else apply(note.snapshot, strings(note.keys))
    },

    async write(expectedVersion, edits) {
      reachable()
      const mine = epoch
      writing++
      try {
        const result = await host.request(
          'litch/device/settings/write',
          { expectedVersion, edits: outgoingEdits(edits) },
          { timeoutMs: WAIT.write },
        )
        if (mine === epoch) {
          // 攒着的通知里，这次写入自己引出来的那些（版本号不比结果新）只取“动了哪些键”
          const own = held
            .filter((note) => note.snapshot.version <= result.snapshot.version)
            .flatMap((note) => strings(note.keys))
          apply(result.snapshot, [...strings(result.changed), ...own])
          // 版本号只管设置的值。SSH 入口的状况、待重启的名单在同一个版本号下还会接着变，应答里的可能是中间的样子：
          // 设备服务把最后的样子另外广播一条（别的客户端也靠它），和应答挨得很近时那条还攒在这里。取最后一条再对一遍
          const last = held.findLast((note) => note.snapshot.version === result.snapshot.version)
          if (last) apply(last.snapshot, [])
          if (writing === 1) release(result.snapshot.version)
        }
        return {
          changed: strings(result.changed),
          restarted: strings(result.restarted),
          pendingRestart: strings(result.snapshot.pendingRestart),
        }
      } catch (error) {
        if (mine === epoch) {
          if (writing === 1) release(-1)
          // 别处先改过了：什么都没写。把对面给的最新的值换上，让用户看着它再决定
          const latest = conflictSnapshot(error)
          if (latest) apply(latest, [])
        }
        throw host.fail(error)
      } finally {
        if (mine === epoch) writing = Math.max(0, writing - 1)
      }
    },

    async restart(harness, force) {
      reachable()
      const mine = epoch
      try {
        const result = await host.request(
          'litch/device/harness/restart',
          { harness, ...(force ? { force: true } : {}) },
          { timeoutMs: WAIT.restart },
        )
        if (mine === epoch) apply(result.snapshot, [])
        return {
          running: result.state === 'running',
          text: result.text ? bilingual(result.text) : null,
        }
      } catch (error) {
        throw host.fail(error)
      }
    },

    async diagnostics(harness) {
      reachable()
      try {
        const result = await host.request(
          'litch/device/diagnostics/run',
          harness ? { harness } : {},
          { timeoutMs: WAIT.diagnostics },
        )
        return projectDiagnostics(result)
      } catch (error) {
        throw host.fail(error)
      }
    },

    async logs(source, harness, maxBytes) {
      reachable()
      try {
        const result = await host.request('litch/device/logs/read', {
          source,
          ...(harness ? { harness } : {}),
          ...(maxBytes === undefined ? {} : { maxBytes }),
        })
        return projectLogTail(result)
      } catch (error) {
        throw host.fail(error)
      }
    },

    async sshConfig() {
      reachable()
      try {
        return projectSshConfig(await host.request('litch/device/sshConfig/read', {}))
      } catch (error) {
        throw host.fail(error)
      }
    },
  }
}
