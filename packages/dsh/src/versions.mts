import { CODEX_PROTOCOL_VERSION } from '../../shared/src/runtime-version.mjs'
import { declaration } from './declaration.mjs'
import { hostDshExecutable, hostDshVersion } from './host-dsh.mjs'

// dshMinimum：用户安装的 dsh 的版本下限，只判断"不低于"。dsh 还没有稳定版，下限落在预发布号上。
// dshVerified：Web Remote 接口实际验证过的版本。Web Remote 是 dsh 的私有接口、没有版本协商，
// 高于下限的新版本可能不兼容；这份清单只用于报错与告警时告诉用户哪些版本确认可用，不参与放行判断。
export const versions = {
  protocol: CODEX_PROTOCOL_VERSION,
  node: '24.0.0',
  dshMinimum: '0.2.0-rc.2',
  dshVerified: ['0.2.0-rc.2'],
} as const

export interface HostDsh {
  cli: string
  version: string
  verified: boolean
}

// 定位并核对用户安装的 dsh；找不到或低于下限时抛出带原因的错误。
export function detectHostDsh(env: NodeJS.ProcessEnv = process.env): HostDsh {
  const cli = hostDshExecutable(env)
  const version = hostDshVersion(cli, versions.dshMinimum)
  return { cli, version, verified: (versions.dshVerified as readonly string[]).includes(version) }
}

// 接口与预期不一致时统一用这段话收尾，让用户知道当前版本与确认可用的版本。
export function compatibilityHint(version: string): string {
  return `当前 dsh ${version}，适配器验证过的版本：${versions.dshVerified.join('、')}；dsh 的 Web Remote 接口没有版本协商，请换用验证过的版本或升级适配器`
}

export function runtimeInfo() {
  const { version } = detectHostDsh()
  return {
    engine: 'dsh',
    protocolVersion: versions.protocol,
    nodeVersion: process.versions.node,
    // dsh 没有独立的 SDK，只报 CLI 版本；它可能是预发布号。
    cliBuild: version,
    capabilities: ['submission.idempotency'],
    releaseReady: false,
    ...declaration,
  }
}
