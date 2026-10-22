// 远程设备没连上之后“该怎么办”：一步一步的说明，有的带一条可以复制去终端里运行的命令。
// 只有逻辑，不引组件和样式，能直接被测试引用（packages/ui/test/device-guide.test.mjs）。
// 这里只说明怎么办，不替用户在那台机器上装适配器。适配器太旧连不上时，设备详情“设备服务”一节另有一键升级
// （用户确认之后才做，service.ts 的 remoteButtonOf）。harness 本身可以按用户点的按钮由设备服务装
// （设备列了 harnessInstall 时，见 install/），那条路不经这里；设备不支持时这里的说明照旧。
import type { ConnectFailureView, RemoteTarget } from '@litch/core'
import type { MessageKey } from '../i18n/index.ts'

/**
 * 在远程机器上装（或者升级）适配器的那一句：独立安装的方式，装到用户目录，不要 root
 * （适配器说明 ADAPTER.md 的“安装与启动”一节）。重跑同一句就是升级
 */
/** 发布页。适配器的安装脚本和发布包都在这里（scripts/install.sh 的 RELEASES） */
export const RELEASES = 'https://github.com/slovx2/litch/releases'
export const INSTALL_SERVICE = `curl -fsSL ${RELEASES}/latest/download/install.sh | sh`
export const UPGRADE_SERVICE_BREW = 'brew upgrade codex-harness-adapter'
export const RESTART_SERVICE_BREW = 'brew services restart codex-harness-adapter'
const INSTALL_CODEX = 'npm install -g @openai/codex'
const UPGRADE_CODEX = 'npm install -g @openai/codex@latest'

export interface GuideStep {
  text: MessageKey
  /** 这一步要运行的命令。只是一句说明的没有 */
  command: string | null
}

/** 在终端里连这台主机该敲的那一句 */
export function sshCommand(target: RemoteTarget): string {
  if (target.kind === 'alias') return `ssh ${target.alias}`
  const parts = ['ssh']
  if (target.port) parts.push('-p', String(target.port))
  if (target.keyFile) parts.push('-i', target.keyFile)
  parts.push(target.user ? `${target.user}@${target.host}` : target.host)
  return parts.join(' ')
}

const step = (text: MessageKey, command: string | null = null): GuideStep => ({ text, command })

/**
 * 这种原因该怎么办。没有可说的就是空的。
 * 核心说了是哪一份（failure.guide）就给那一份；没说的按阶段给（主机密钥、认证）。
 */
export function guideOf(failure: ConnectFailureView, target: RemoteTarget | null): GuideStep[] {
  // 这几条说的都是经 ssh 连的那台机器该怎么办。本机没连上时不适用，原因那句话自己说清楚
  if (target === null) return []
  switch (failure.guide) {
    case 'install':
      // 两条路：设备服务排在前面，它是我们推荐的那一条
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
  }
  switch (failure.stage) {
    case 'hostKey':
      return [step('devices.guide.hostKey', sshCommand(target))]
    case 'auth':
      return [
        step(
          'devices.guide.auth',
          `ssh-add ${target.kind === 'host' && target.keyFile ? target.keyFile : '~/.ssh/id_ed25519'}`,
        ),
      ]
    default:
      return []
  }
}
