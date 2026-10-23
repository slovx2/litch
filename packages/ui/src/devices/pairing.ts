// 出码对话框里不靠页面就能算的几样：地址表单和地址之间怎么换、界面这一侧先查哪几样、
// 倒计时和确认码怎么写、出码没成时说哪一句、状态一行说哪一句。
// 纯函数，不依赖 React 和页面，只类型引用核心：界面测试直接引（packages/ui/test/pairing-logic.test.mjs）。
// 核心那一头还会再查一遍地址（checkPairingAddress），这边先查出来是为了当场在那一栏下面说。
import type { PairingAddress, PairingStartFailure, PairState } from '@litch/core'
import type { MessageKey } from '../i18n/index.ts'

/** 表单上的四栏，都是输入框里的原样 */
export interface AddressDraft {
  name: string
  host: string
  port: string
  user: string
}

export type AddressField = keyof AddressDraft

export const ADDRESS_FIELDS: readonly AddressField[] = ['name', 'host', 'port', 'user']

/** 别名最长多少字，和核心的 PAIRING_NAME_MAX 一样 */
const NAME_MAX = 64

export const draftOf = (address: PairingAddress): AddressDraft => ({
  name: address.name,
  host: address.host,
  port: String(address.port),
  user: address.user,
})

/** 会原样交给 ssh 的值：不许空、不许有空白和控制字符、不许以减号开头 */
const plainWord = (text: string, max: number): boolean =>
  text.length > 0 &&
  text.length <= max &&
  !text.startsWith('-') &&
  !/[\s\u0000-\u001f\u007f]/.test(text)

/** 表单换成地址。哪一栏不对就说哪一栏；都对给出整理好的地址 */
export function checkDraft(
  draft: AddressDraft,
): { address: PairingAddress } | { field: AddressField; problem: MessageKey } {
  const name = draft.name.trim().replace(/[\u0000-\u001f\u007f]/g, '')
  if (!name || name.length > NAME_MAX) return { field: 'name', problem: 'pairing.bad.name' }
  const host = draft.host.trim()
  if (!plainWord(host, 255) || host.includes('@')) {
    return { field: 'host', problem: 'pairing.bad.host' }
  }
  const portText = draft.port.trim()
  const port = /^\d{1,5}$/.test(portText) ? Number(portText) : Number.NaN
  if (!(port >= 1 && port <= 65535)) return { field: 'port', problem: 'pairing.bad.port' }
  const user = draft.user.trim()
  if (!plainWord(user, 64)) return { field: 'user', problem: 'pairing.bad.user' }
  return { address: { name, host, port, user } }
}

export const sameAddress = (a: PairingAddress, b: PairingAddress): boolean =>
  a.name === b.name && a.host === b.host && a.port === b.port && a.user === b.user

/** 原配置写成一行：名字 · 用户@主机:端口 */
export const addressLine = (address: PairingAddress): string =>
  `${address.name} · ${address.user}@${address.host}:${address.port}`

/** 还剩多久，写成 分:秒（不到 0 写 0:00） */
export function countdown(remainingMs: number): string {
  const seconds = Math.max(0, Math.ceil(remainingMs / 1000))
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
}

/** 确认码三位一组，好对 */
export const codeText = (code: string): string =>
  code.length === 6 ? `${code.slice(0, 3)} ${code.slice(3)}` : code

const FAILURES: readonly PairingStartFailure[] = [
  'keysFile',
  'noHostKey',
  'hostKeyMismatch',
  'selfTest',
  'sshOff',
  'unsupported',
  'offline',
  'tailscale',
  'verify',
  'enrollTest',
]

/** 出码没成：核心的错误带着 key 的照 key 说；不认识的是 null，由调用方给一般的说法 */
export function failureOf(
  error: { key?: string | undefined } | null | undefined,
): PairingStartFailure | null {
  const key = error?.key
  return FAILURES.includes(key as PairingStartFailure) ? (key as PairingStartFailure) : null
}

/** 没开 SSH 服务时按这台电脑的系统给哪一句怎么开 */
export const sshOffHint = (os: string | null): MessageKey =>
  os === 'windows'
    ? 'pairing.fail.sshOff.windows'
    : os === 'linux'
      ? 'pairing.fail.sshOff.linux'
      : 'pairing.fail.sshOff.macos'

/** 这几种失败要把原话也摆出来：人要拿它去查 */
export const showsSaid = (failure: PairingStartFailure | null): boolean =>
  failure === null ||
  failure === 'selfTest' ||
  failure === 'keysFile' ||
  failure === 'hostKeyMismatch' ||
  failure === 'tailscale' ||
  failure === 'enrollTest'

/**
 * 表单里的地址换了主机或端口，要不要重新认一次方式：probed 是上一次认方式时的那个地址。
 * 别名、用户不影响连到哪台机器的哪个服务，不算
 */
export const redetects = (probed: { host: string; port: number } | null, address: PairingAddress) =>
  probed === null || probed.host !== address.host || probed.port !== address.port

/** 作废了的状态不会再变：到了这一步就不再倒计时、不再自动换码 */
export const finalState = (state: PairState): boolean =>
  state === 'done' || state === 'expired' || state === 'cancelled' || state === 'rejected'

/**
 * 到点了要不要自动换一张：等扫码、过期的换。手机已经来请求的不换——设备不因二维码到期打断它，
 * 这边一换（先作废旧的）手机就收到 expired；它等人表态，或者设备两分钟后自己判超时。
 * 完成、拒绝、被别处作废的也不换，等人点。
 */
export const refreshes = (state: PairState): boolean => state === 'waiting' || state === 'expired'

/** 主机下拉里一项是哪种写法：IP、MagicDNS 全名、短名（核心的 tailnetHosts 给的就是这三种） */
export type HostKind = 'ip' | 'long' | 'short'

export const hostKind = (host: string): HostKind =>
  host.includes(':') || /^\d{1,3}(\.\d{1,3}){3}$/.test(host)
    ? 'ip'
    : host.includes('.')
      ? 'long'
      : 'short'

export const HOST_KIND_LABEL: Record<HostKind, MessageKey> = {
  ip: 'pairing.host.ip',
  long: 'pairing.host.long',
  short: 'pairing.host.short',
}
