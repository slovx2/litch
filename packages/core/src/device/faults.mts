// 请求没做成时对人怎么说：把连接层的错误换成通道上的错误。
// 设备服务（聚合面）自己回的错误在 error.data.litch 里带着原因（packages/protocol/src/device.mts），
// 这几种核心说得出是哪一句；上游引擎回的错误没有这个字段，原话照给。
import { type DeviceErrorData, RPC_ERROR } from '../../../protocol/src/index.mjs'
import { ChannelError } from '../channel/protocol.mjs'
import { RpcAbortError, RpcError } from '../connection/rpc.mjs'
import type { HarnessId } from '../model.mjs'
import { phrase } from '../phrase.mjs'
import { bilingual } from '../projection/manage.mjs'

/** 这个错误是不是聚合面自己回的。是的话给出它带的原因；别的错误都是 null */
export function deviceFault(error: unknown): DeviceErrorData | null {
  if (!(error instanceof RpcError)) return null
  const data = error.data
  if (typeof data !== 'object' || data === null) return null
  return typeof (data as { litch?: unknown }).litch === 'string' ? (data as DeviceErrorData) : null
}

/** 请求要发给的 harness 现在不可用（或者等应答的时候它断开了）。这种不算失败到底：它回来之后可以再来 */
export const isHarnessDown = (error: unknown): boolean =>
  deviceFault(error)?.litch === 'harnessUnavailable'

/**
 * 这个会话正被别处的 codex 进程用着。原生 codex 同一个会话同一时间只许一个进程写，
 * 用户在终端里（或者官方桌面端里）开着它的时候，这边恢复、归档、删除都会被这样拒掉
 * （原话是 already has an active writer，对着 codex 0.160.0 实测）。
 * 这不是出了故障：那边用完了再来就行，所以对人要说清楚是怎么回事，不能只甩一句原话。
 */
export const isHeldElsewhere = (error: unknown): boolean =>
  error instanceof RpcError && /already has an active writer/i.test(error.message)

/**
 * 对面是不是在说“我不会这件事”，三种说法都认：
 * - 适配器的入口、聚合面自己：标准的“方法不存在”；
 * - 聚合面替原生 codex 说的：也是“方法不存在”，data 里写着 `litch: 'unsupported'` 和是哪个 harness；
 * - 原生 codex 自己的入口：“无效请求”，原因里写着它不认识这个变体。
 * “无效请求”还有别的意思（参数不对、会话不存在），所以那一种要看原因、不能只看错误码：
 * 这里一旦认定，那件事在这个 harness 上就停用到下次重连（或者它掉线又回来）。
 */
export const lacksMethod = (error: unknown): boolean =>
  error instanceof RpcError &&
  (deviceFault(error)?.litch === 'unsupported' ||
    error.code === RPC_ERROR.methodNotFound ||
    (error.code === RPC_ERROR.invalidRequest &&
      /unknown (variant|method)|method not found/i.test(error.message)))

/** harness 的标识怎么换成给人看的名字。不给就照标识说 */
export type HarnessNamer = (harness: HarnessId) => string

/** 给人看的一串名字。名字都是拉丁字母的，中英文里都用逗号隔开 */
export const listNames = (harnesses: HarnessId[], nameOf: HarnessNamer): string =>
  harnesses.map(nameOf).join(', ')

/** 某个 harness 现在用不了：还没发出请求就知道的时候，核心自己报这一句 */
export const harnessDownError = (name: string): ChannelError =>
  new ChannelError('remote', `${name} 现在不可用`, phrase('fault.harnessUnavailable', { name }))

function fromDevice(error: RpcError, fault: DeviceErrorData, nameOf: HarnessNamer): ChannelError {
  const reason: string = fault.litch
  if (reason === 'harnessUnavailable' && fault.harness) {
    const name = nameOf(fault.harness)
    return new ChannelError('remote', error.message, phrase('fault.harnessUnavailable', { name }))
  }
  if (reason === 'unknownHarness' && fault.harness) {
    const text = phrase('fault.unknownHarness', { name: fault.harness })
    return new ChannelError('remote', error.message, text)
  }
  if (reason === 'unknownThread') {
    // 有 harness 当时不可用、没问到：会话可能就在它那里
    const missed = fault.unavailable ?? []
    const text = missed.length
      ? phrase('fault.unknownThreadMaybe', { names: listNames(missed, nameOf) })
      : phrase('fault.unknownThread')
    return new ChannelError('remote', error.message, text)
  }
  // 聚合面不提供这个方法：和“对面不认识这个方法”是一回事
  if (reason === 'unsupported') return new ChannelError('unsupported', error.message)
  // 设备配置接口自己回的几种（packages/protocol/src/device-settings.mts）：说明的两种语言版本都带着，
  // 界面按当前的语言说
  const { text, key } = fault as { text?: unknown; key?: unknown }
  const said = typeof text === 'object' && text !== null ? { said: bilingual(text) } : {}
  // 版本号对不上：别处先改过了，这次什么都没写
  if (reason === 'settingsConflict') {
    return new ChannelError('conflict', error.message, undefined, said)
  }
  if (reason === 'invalidSetting') {
    const which = typeof key === 'string' ? { key } : {}
    return new ChannelError('invalid', error.message, undefined, { ...said, ...which })
  }
  if (reason === 'harnessBusy') return new ChannelError('busy', error.message, undefined, said)
  // 设置功能现在用不了、动作没做成，以及以后新加的、这一版还不认识的原因：照它的原话给
  return new ChannelError('remote', error.message, undefined, said)
}

/** 把连接层的错误换成通道上的错误码，界面按码决定怎么提示 */
export function channelFailure(error: unknown, nameOf: HarnessNamer = (id) => id): ChannelError {
  if (error instanceof ChannelError) return error
  if (error instanceof RpcError) {
    // 被别处的 codex 用着：现在做不了，不是出了故障
    if (isHeldElsewhere(error)) {
      return new ChannelError('rejected', error.message, phrase('fault.heldElsewhere'))
    }
    const fault = deviceFault(error)
    return fault ? fromDevice(error, fault, nameOf) : new ChannelError('remote', error.message)
  }
  if (error instanceof RpcAbortError) {
    if (error.reason === 'timeout') return new ChannelError('timeout', error.message)
    if (error.reason === 'cancelled') return new ChannelError('cancelled', error.message)
    return new ChannelError('offline', error.message)
  }
  return new ChannelError('internal', error instanceof Error ? error.message : String(error))
}
