// 设备没连上时怎么说、该怎么办。只有逻辑，不引组件。
// 原因的话大多直接用核心给的（桌面端的那几句）。主机钥匙、登录这两种手机上做法不一样
// （主机钥匙在应用里确认，没有终端和 known_hosts；登录用应用里的钥匙，没有密钥代理），换成手机自己的说法；
// SSH 模块报的原话在详情里，开头的方括号是种类（src/platform/ssh-errors.ts）。
import type { ConnectFailureView, DeviceView, RemoteTarget } from '@litch/core'
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
    if (/没有这把钥匙/.test(detail)) return 'devices.why.keyMissing'
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
 * 在远程机器上装、升级适配器和 codex 的那几句，和桌面端一样（packages/ui/src/devices/guide.ts；
 * Metro 只看得到桌面界面的文案目录，引不到那一份，这里照抄命令，文字用桌面端现成的那几句）
 */
const INSTALL_SERVICE =
  'curl -fsSL https://github.com/slovx2/litch/releases/latest/download/install.sh | sh'
const UPGRADE_SERVICE_BREW = 'brew upgrade codex-harness-adapter'
const RESTART_SERVICE_BREW = 'brew services restart codex-harness-adapter'
const INSTALL_CODEX = 'npm install -g @openai/codex'
const UPGRADE_CODEX = 'npm install -g @openai/codex@latest'

export interface GuideStep {
  text: Key
  /** 这一步要在那台机器上运行的命令。只是一句说明的没有 */
  command: string | null
}

const step = (text: Key, command: string | null = null): GuideStep => ({ text, command })

/**
 * 该怎么办的那几步：对面没装、版本低、旧服务在跑。主机钥匙和登录桌面端给的是终端里的命令，
 * 手机上换成页面上的按钮和公钥卡，这里不给
 */
export function stepsOf(failure: ConnectFailureView, target: RemoteTarget | null): GuideStep[] {
  if (target === null) return []
  switch (failure.guide) {
    case 'install':
      return [
        step('devices.guide.install'),
        step('devices.guide.install.service', INSTALL_SERVICE),
        step('devices.guide.install.codex', INSTALL_CODEX),
      ]
    case 'installCodex':
      return [step('devices.guide.installCodex', INSTALL_CODEX)]
    case 'upgradeCodex':
      return [step('devices.guide.upgradeCodex', UPGRADE_CODEX)]
    case 'upgradeService':
      return [
        step('devices.guide.upgradeService', INSTALL_SERVICE),
        step('devices.guide.upgradeService.brew', UPGRADE_SERVICE_BREW),
        step('devices.guide.upgradeService.after'),
      ]
    case 'restartService':
      return [
        step('devices.guide.restartService', RESTART_SERVICE_BREW),
        step('devices.guide.restartService.manual'),
      ]
    default:
      return []
  }
}

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

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

/** 多久以前：现在、12分、3时、5天，更早的写月和日（和桌面端 packages/ui/src/app/format.ts 一样） */
export function ago(timestamp: number, now: number, t: Translator): string {
  const diff = Math.max(0, now - timestamp)
  if (diff < MINUTE) return t('time.now')
  if (diff < HOUR) return t('time.minutes', { n: Math.floor(diff / MINUTE) })
  if (diff < DAY) return t('time.hours', { n: Math.floor(diff / HOUR) })
  if (diff < 7 * DAY) return t('time.days', { n: Math.floor(diff / DAY) })
  const date = new Date(timestamp)
  return `${date.getMonth() + 1}/${date.getDate()}`
}
