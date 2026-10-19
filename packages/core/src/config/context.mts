// litch_config 执行器的骨架：执行器要用的那几样（ConfigHost）、每个操作拿到的上下文（OpContext）、操作的说明（OpSpec）。
// 执行器只经 CoreHost 的两个入口（command、subscribe）用核心现有的命令和主题，和界面点按钮走的是同一条路，
// 所以真的核心和模拟核心都能接它；界面那几项经 bridge，主进程那几项经 main。
import type { ClientToolFailureKind } from '../../../protocol/src/client-tools.mjs'
import type {
  AbortSignalLike,
  Clock,
  CommandName,
  Commands,
  Topic,
  TopicData,
  TopicKind,
} from '../channel/protocol.mjs'
import type { CoreHost, HostSink } from '../channel/server.mjs'
import type { DeviceView, Said } from '../model.mjs'
import type {
  ConfigConfirmItem,
  ConfigMainRequest,
  ConfigMainResult,
  ConfigUiRequest,
} from '../model-config.mjs'
import type { ArgSpec, ParsedCommand } from './argv.mjs'
import type { ConfigBridge } from './bridge.mjs'

export type Lang = 'zh-CN' | 'en'

export interface ConfigHost {
  /** 核心自己：命令和订阅，和界面用的是同一份 */
  core: CoreHost
  clock: Clock
  /** 应用的版本 */
  version: string
  /** 界面现在的语言。命令行没说语言时用它 */
  lang(): Lang
  bridge: ConfigBridge
  /** 交给主进程做（浏览器网站、Computer Use）。没有外壳时回 ok:false */
  main(request: ConfigMainRequest): Promise<ConfigMainResult>
  log?(line: string): void
}

/** 谁在调：命令行在哪个会话里、是哪个 harness 的进程 */
export interface ConfigCaller {
  threadId: string | null
  harness: string | null
  /** 有确认卡挂着、在等长的事时调：停掉调用的超时表。返回“不等了” */
  hold(): () => void
}

/** 执行没做成。kind 是给模型看的那一行开头（[litch:kind]） */
export class ConfigFailure extends Error {
  readonly kind: ClientToolFailureKind
  readonly data: unknown
  constructor(kind: ClientToolFailureKind, message: string, data?: unknown) {
    super(message)
    this.name = 'ConfigFailure'
    this.kind = kind
    this.data = data
  }
}

export interface OpResult {
  /** 给模型读的简短文字 */
  text: string
  /** --json 时给的结构化结果 */
  data?: unknown
}

export interface OpContext {
  cmd: ParsedCommand
  lang: Lang
  host: ConfigHost
  caller: ConfigCaller
  /** litch config 之后原样的参数（确认卡上给人核对） */
  argv: readonly string[]
  /** 按语言挑一句 */
  say(zh: string, en: string): string
  /** 调核心的一条命令 */
  run<N extends CommandName>(name: N, params: Commands[N]['params']): Promise<Commands[N]['result']>
  /** 订阅一个主题，拿到第一份快照就退订 */
  first<K extends TopicKind>(topic: Extract<Topic, { kind: K }>, ms?: number): Promise<TopicData[K]>
  /** 现在的设备 */
  devices(): Promise<DeviceView[]>
  /** 按名字、标识、local 认一台设备。认不出抛 invalid，说明里列出有哪些 */
  device(arg: string | undefined): Promise<DeviceView>
  /** 设备的显示名 */
  nameOf(device: DeviceView): string
  /** 设备服务的话按语言取 */
  said(value: Said | null | undefined): string
  /** 放宽安全的事先弹确认卡：人点了允许才回，不然抛 declined */
  confirm(items: ConfigConfirmItem[]): Promise<void>
  /** 请界面做一件事 */
  ui(request: ConfigUiRequest): Promise<unknown>
  /** 请主进程做一件事 */
  main(request: ConfigMainRequest): Promise<unknown>
  /** 开关值（on/off）。给了却认不出抛 invalid；没给是 undefined */
  switchOf(name: string): boolean | undefined
}

/** 一个操作：要什么参数、怎么用、一句话说明、怎么做 */
export interface OpSpec extends ArgSpec {
  /** 用法（两种语言一样） */
  usage: string
  summary: { zh: string; en: string }
  run(ctx: OpContext): Promise<OpResult>
}

const NEVER: AbortSignalLike = { aborted: false, addEventListener() {} }

/** 订阅一个主题，拿到第一份快照就退订。到点没给、订阅出错都抛错 */
export function firstSnapshot<T>(
  core: CoreHost,
  clock: Clock,
  topic: Topic,
  ms: number,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let done = false
    let stop: (() => void) | null = null
    let stopTimer: (() => void) | null = null
    const finish = () => {
      done = true
      stopTimer?.()
      stop?.()
    }
    const sink: HostSink = {
      snapshot(data) {
        if (done) return
        finish()
        resolve(data as T)
      },
      delta() {},
      error(error) {
        if (done) return
        finish()
        reject(error)
      },
    }
    stopTimer = clock.setTimer(() => {
      if (done) return
      finish()
      reject(new ConfigFailure('failed', 'Timed out waiting for Litch data.'))
    }, ms)
    try {
      stop = core.subscribe(topic, sink)
    } catch (error) {
      stopTimer()
      reject(error)
      return
    }
    // 快照当场就给了：那时退订函数还没拿到
    if (done) stop()
  })
}

/** 调核心的一条命令（不取消） */
export const runCommand = <N extends CommandName>(
  core: CoreHost,
  name: N,
  params: Commands[N]['params'],
): Promise<Commands[N]['result']> =>
  core.command(name, params, NEVER) as Promise<Commands[N]['result']>

/** 一段字的开头几行，太长截掉 */
export const clip = (text: string, max = 160): string =>
  text.length > max ? `${text.slice(0, max - 1)}…` : text
