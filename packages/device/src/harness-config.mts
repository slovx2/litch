// harness 详情设置（harnessConfig 扩展，protocol/extensions/harness-config.json）在设备进程里共用的几样：
// 错误、方法归属、给原生 codex 的翻译器要用的上下文。
//   - `litch/harness/*`：带 harness 参数，适配器的引擎自己实现，聚合面原样转过去（harness 参数也带着，
//     这几个方法的参数里本来就有它）；原生 codex 不认识，由设备进程翻译（codex-harness-config.mts）。
//   - `litch/device/instructions/*`：设备进程自己做（instructions.mts）。
//   - 通知 `litch/harness/config/changed`、`litch/harness/auth/updated` 只发给握手时声明了 harnessConfig 的连接。
import {
  HARNESS_CONFIG_ERROR_CODE,
  HARNESS_CONFIG_METHOD,
  HARNESS_CONFIG_NOTIFICATION,
  type HarnessConfigChangedNotification,
  type HarnessConfigErrorData,
  type HarnessConfigErrorReason,
  type HarnessText,
} from '../../protocol/src/harness-config.mjs'

/** 引擎实现的方法都在这个前缀下 */
export const HARNESS_CONFIG_PREFIX = 'litch/harness/'

const NOTIFICATIONS = new Set<string>(Object.values(HARNESS_CONFIG_NOTIFICATION))

/** 设备进程自己处理的两个方法（统一模式） */
export const INSTRUCTIONS_METHODS = new Set<string>([
  HARNESS_CONFIG_METHOD.instructionsUnify,
  HARNESS_CONFIG_METHOD.instructionsSeparate,
])

/** 是这个扩展里由引擎（或者替原生 codex 翻译的设备进程）答的请求。`litch/harness/status/changed` 之类的通知不算 */
export function isHarnessConfigMethod(method: string): boolean {
  return method.startsWith(HARNESS_CONFIG_PREFIX) && !NOTIFICATIONS.has(method)
}

/** 这条通知属于 harnessConfig：只发给声明过它的连接 */
export function isHarnessConfigNotification(method: string): boolean {
  return NOTIFICATIONS.has(method)
}

export const text = (zh: string, en: string): HarnessText => ({ 'zh-CN': zh, en })

/** 这个扩展自己回的错误：JSON-RPC 的 code 是 -32000，原因在 data.litch */
export class HarnessConfigError extends Error {
  readonly code = HARNESS_CONFIG_ERROR_CODE
  readonly data: HarnessConfigErrorData

  constructor(
    reason: HarnessConfigErrorReason,
    harness: string,
    message: HarnessText,
    key?: string,
  ) {
    super(message['zh-CN'])
    this.data = { litch: reason, harness, message, ...(key === undefined ? {} : { key }) }
  }
}

/**
 * 翻译器（替不认识 `litch/harness/*` 的上游答这些方法）。每条客户端连接、每个 harness 一个：
 * 登录这类有来有往的事记在发起它的那条连接名下，进展只告诉它。
 */
export interface HarnessConfigTranslator {
  /** 答一个 `litch/harness/*` 请求 */
  call(method: string, params: Record<string, unknown>): Promise<unknown>
  /** 上游发来一条通知（翻译器要从里面看登录有没有结果）。不拦，照常转给客户端 */
  notification(method: string, params: Record<string, unknown>): void
  /** 这条连接关了：进行中的登录不用再跟了 */
  close(): void
}

export interface TranslatorContext {
  harness: string
  /** 向这个上游问一句，等它的应答（默认等探测的时限）。上游回的错误抛 UpstreamRpcError */
  ask(method: string, params: unknown, timeoutMs?: number): Promise<unknown>
  /** 握手应答里的 codexHome（原生 codex 的数据目录）；不知道是 null */
  home(): string | null
  /** 设备设置里 `harness.<id>.env` 填了哪些变量名（只要名字，值是密钥读不到） */
  envNames(): string[]
  /**
   * codex 自带的模型目录：`{executable, catalog}`，catalog 是 `codex debug models --bundled` 印出的 ModelsResponse。
   * 由主进程用起 app-server 的那个可执行文件和环境跑（控制命令 codex.models）。问不到抛错
   */
  bundledCatalog(): Promise<unknown>
  /** 发给这条连接（声明过 harnessConfig 才发） */
  notify(method: string, params: unknown): void
  /** 经这套接口改了配置：告诉所有声明过 harnessConfig 的连接，发起的这条也收 */
  changed(part: HarnessConfigChangedNotification['part']): void
}
