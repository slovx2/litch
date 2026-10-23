import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { isVersionAtLeast } from '../../shared/src/min-version.mjs'
import { CODEX_PROTOCOL_VERSION } from '../../shared/src/runtime-version.mjs'
import { harnessDeclaration } from './declaration.mjs'
import { type HostPi, locateHostPi } from './host-pi.mjs'

export const versions = {
  protocol: CODEX_PROTOCOL_VERSION,
  node: '24.0.0',
  cli: '0.99.1',
  plan: '0.58.3',
  tuiKit: '0.59.0',
  subagents: '21.8.1',
} as const

// 对用户安装的 Pi 只设下限；SDK 与 CLI 同属一个包，一次校验覆盖两者。
export function requireMinimumPi(pi: HostPi): HostPi {
  if (!isVersionAtLeast(pi.version, versions.cli))
    throw new Error(
      `需要用户安装的 Pi CLI >= ${versions.cli}，实际 ${pi.version}；请升级 Pi，或用 PI_CLI 指定路径`,
    )
  return pi
}

let host: HostPi | undefined
export function hostPi(): HostPi {
  host ??= requireMinimumPi(locateHostPi())
  return host
}

/**
 * approvals：这次运行打没打开审批，声明里的审批种类、权限预设的说明跟着它走；
 * backgroundShell：打没打开注入的后台 shell，声明里的 backgroundTasks 跟着它走
 */
export function runtimeInfo(approvals: boolean, backgroundShell = false) {
  const pi = hostPi()
  const installed = installedVersions()
  validateInstalledVersions(installed)
  return {
    engine: 'pi',
    protocolVersion: versions.protocol,
    nodeVersion: process.versions.node,
    sdkVersion: pi.version,
    cliBuild: pi.version,
    pluginVersions: {
      '@narumitw/pi-plan-mode': installed['@narumitw/pi-plan-mode'],
      '@gotgenes/pi-subagents': installed['@gotgenes/pi-subagents'],
      '@narumitw/pi-tui-kit': installed['@narumitw/pi-tui-kit'],
    },
    capabilities: [
      'history.pagination',
      'submission.idempotency',
      'dynamicTools',
      'nativeSession.rollback',
      'nativeSession.revert.paginated',
      'nativeSession.rollback.paginated',
    ],
    releaseReady: false,
    // 结构化的声明：显示名、徽标、能力位、权限预设、支持的扩展。上面那份字符串清单原样留着。
    ...harnessDeclaration(approvals, backgroundShell),
  }
}

// 随适配器分发的插件；Pi 本体不在其中。
const expectedPackages: Record<string, string> = {
  '@narumitw/pi-plan-mode': versions.plan,
  '@narumitw/pi-tui-kit': versions.tuiKit,
  '@gotgenes/pi-subagents': versions.subagents,
}

export function installedVersions(): Record<string, string> {
  return Object.fromEntries(
    Object.keys(expectedPackages).map((name) => {
      const entry = name === '@narumitw/pi-plan-mode' ? `${name}/package.json` : name
      let directory = dirname(fileURLToPath(import.meta.resolve(entry)))
      while (directory !== dirname(directory)) {
        const path = join(directory, 'package.json')
        if (existsSync(path)) {
          const pkg = JSON.parse(readFileSync(path, 'utf8'))
          if (pkg.name === name) return [name, pkg.version]
        }
        directory = dirname(directory)
      }
      throw new Error(`找不到已安装包的版本: ${name}`)
    }),
  )
}

export function validateInstalledVersions(installed = installedVersions()): void {
  for (const [name, minimum] of Object.entries(expectedPackages))
    if (!isVersionAtLeast(installed[name], minimum))
      throw new Error(`${name} 版本不符: 需要 >= ${minimum}，实际 ${installed[name] ?? '缺失'}`)
}
