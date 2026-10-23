import { declareBackgroundTasks } from '../../shared/src/background-report.mjs'
import { CODEX_PROTOCOL_VERSION } from '../../shared/src/runtime-version.mjs'
import { declaration } from './declaration.mjs'
import { hostOpencodeExecutable, hostOpencodeVersion } from './host-opencode.mjs'

// opencodeMinimum：用户安装的 OpenCode 的版本下限，只判断“不低于”（与 protocol/versions.json 的登记一致，有测试核对）。
// opencodeVerified：实际验证过的版本。适配器只用 OpenCode 的 v1 HTTP 接口（根路径那一组，不用标着实验的 /api/*），
// 1.18.0 到 1.18.33 这一组路径没有变过；高于下限的新版本照样放行，这份清单只用于告警时告诉用户哪些版本确认可用。
export const versions = {
  protocol: CODEX_PROTOCOL_VERSION,
  node: '24.0.0',
  opencodeMinimum: '1.18.0',
  opencodeVerified: ['1.18.33'],
} as const

export interface HostOpencode {
  cli: string
  version: string
  verified: boolean
}

// 定位并核对用户安装的 OpenCode；找不到或低于下限时抛出带原因的错误。
export function detectHostOpencode(env: NodeJS.ProcessEnv = process.env): HostOpencode {
  const cli = hostOpencodeExecutable(env)
  const version = hostOpencodeVersion(cli, versions.opencodeMinimum)
  return {
    cli,
    version,
    verified: (versions.opencodeVerified as readonly string[]).includes(version),
  }
}

// 接口与预期不一致时统一用这段话收尾，让用户知道当前版本与确认可用的版本。
export function compatibilityHint(version: string): string {
  return `当前 OpenCode ${version}，适配器验证过的版本：${versions.opencodeVerified.join('、')}；请换用验证过的版本或升级适配器`
}

/** backgroundShell：这次运行打没打开注入的后台 shell，声明里的 backgroundTasks 跟着它走 */
export function runtimeInfo(backgroundShell = false) {
  const { version } = detectHostOpencode()
  return {
    engine: 'opencode',
    protocolVersion: versions.protocol,
    nodeVersion: process.versions.node,
    // OpenCode 的 SDK 与 CLI 同版本号，只报 CLI 的。
    cliBuild: version,
    capabilities: ['submission.idempotency'],
    releaseReady: false,
    ...(backgroundShell ? declareBackgroundTasks(declaration) : declaration),
  }
}
