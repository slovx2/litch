// 设备没连上时怎么说、该怎么办。只有逻辑，不引组件。
// 原因的话大多直接用核心给的（桌面端的那几句）。主机钥匙、登录这两种手机上做法不一样
// （主机钥匙在应用里确认，没有终端和 known_hosts；登录用应用里的钥匙，没有密钥代理），换成手机自己的说法；
// SSH 模块报的原话在详情里，开头的方括号是种类（src/platform/ssh-errors.ts）。
import type { ConnectFailureView, DeviceView, RemoteTarget } from '@litch/core'
import { type GuideStep, guideOf } from '../../../../../packages/ui/src/devices/guide.ts'
import type { Key, Translator } from '../../ui/i18n'

export type ShownState = DeviceView['connection']

/** 连不上、正在隔一阵再试的设备说成“离线”（和桌面端一样，packages/ui/src/devices/status.tsx） */
export const shownState = (device: DeviceView): ShownState =>
  device.connection === 'reconnecting' && device.failure ? 'offline' : device.connection

const phraseKey = (failure: ConnectFailureView): string | null =>
  typeof failure.text === 'string' ? null : failure.text.key

/** 手机上要换掉的那几种。别的照核心给的说 */
export function mobileReason(failure: ConnectFailureView): Key | null {
  const detail = failure.detail ?? ''
  if (failure.stage === 'hostKey') {
    return phraseKey(failure) === 'ssh.hostKeyChanged'
      ? 'devices.why.hostKeyChanged'
      : 'devices.why.hostKeyUnknown'
  }
  if (failure.stage === 'auth') {
    if (/没有该密钥/.test(detail)) return 'devices.why.keyMissing'
    if (/^\[(key|keyLocked)\]/.test(detail)) return 'devices.why.keyBroken'
    return 'devices.why.auth'
  }
  return null
}

export function reasonText(failure: ConnectFailureView, t: Translator): string {
  const mobile = mobileReason(failure)
  return mobile ? t(mobile) : t.text(failure.text)
}

/**
 * 该怎么办的那几步：对面没装、版本低、旧服务在跑，用桌面端的那一份（packages/ui/src/devices/guide.ts）。
 * 主机钥匙和登录桌面端给的是终端里的命令，手机上换成页面上的按钮和公钥卡，所以核心没说是哪一份的这里不给
 */
export const stepsOf = (failure: ConnectFailureView, target: RemoteTarget | null): GuideStep[] =>
  failure.guide ? guideOf(failure, target) : []

/** 在那台机器上把公钥加进 authorized_keys 的那一句 */
export const authorizeCommand = (publicKey: string): string =>
  `mkdir -p ~/.ssh && chmod 700 ~/.ssh && echo '${publicKey.replaceAll("'", '')}' >> ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys`

/** 在那台机器上核对主机钥匙指纹的那一句 */
export function hostKeyCommand(keyType: string): string {
  const short = keyType.startsWith('ecdsa')
    ? 'ecdsa'
    : keyType === 'ssh-rsa' || keyType.startsWith('rsa')
      ? 'rsa'
      : 'ed25519'
  return `ssh-keygen -lf /etc/ssh/ssh_host_${short}_key.pub`
}
