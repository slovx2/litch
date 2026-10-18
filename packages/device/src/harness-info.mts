// `runtime/info` 里的设备信息和每个 harness 的声明。
import { readFileSync } from 'node:fs'
import { homedir, hostname } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  type DeviceInfo,
  EXTENSION,
  type ExtensionName,
  type HarnessInfo,
  type HarnessUnavailable,
} from '../../protocol/src/device.mjs'
import type { HarnessFeatures, PermissionPreset } from '../../protocol/src/harness-capabilities.mjs'
import { harnessIdentity } from '../../protocol/src/harness-identity.mjs'
import { CODEX_PROTOCOL_VERSION, platformOs } from '../../shared/src/runtime-version.mjs'
import type { UpstreamFacts } from './upstream.mjs'
import { isObject } from './wire.mjs'

/** 这一版设备服务支持的扩展 */
export const SUPPORTED_EXTENSIONS: readonly ExtensionName[] = [
  EXTENSION.harness,
  EXTENSION.deviceWorkspaces,
]

/** 聚合面要求客户端握手时必须声明的扩展 */
export const REQUIRED_EXTENSIONS: readonly ExtensionName[] = [EXTENSION.harness]

/** 设备服务的版本：取自本包的 package.json，和适配器一起发、同一个版本号 */
export function deviceVersion(): string {
  let directory = dirname(fileURLToPath(import.meta.url))
  while (directory !== dirname(directory)) {
    try {
      const pkg = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8'))
      if (pkg.name === '@codex-harness-adapter/device' && typeof pkg.version === 'string')
        return pkg.version
    } catch {
      // 这一层没有清单，接着往上找
    }
    directory = dirname(directory)
  }
  return 'unknown'
}

export function deviceInfo(version: string): DeviceInfo {
  return {
    hostname: hostname(),
    os: platformOs(),
    home: homedir(),
    version,
    protocolVersion: CODEX_PROTOCOL_VERSION,
    extensions: [...SUPPORTED_EXTENSIONS],
  }
}

const VERSION = /\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?/

const firstVersion = (value: unknown): string | null =>
  typeof value === 'string' ? (value.match(VERSION)?.[0] ?? null) : null

const nonEmpty = (value: unknown): string | null =>
  typeof value === 'string' && value.trim() ? value.trim() : null

/** 从标识凑两个字母：有分隔的取前两段的首字母（claude-code 是 CC），没有的取前两个字母 */
function badgeFromId(id: string): string {
  const parts = id.split(/[^0-9A-Za-z]+/).filter(Boolean)
  const letters =
    parts.length >= 2 ? `${parts[0]?.[0] ?? ''}${parts[1]?.[0] ?? ''}` : id.slice(0, 2)
  return letters.toUpperCase() || '??'
}

export function describeHarness(
  id: string,
  facts: UpstreamFacts,
  unavailable: HarnessUnavailable | null,
): HarnessInfo {
  const runtime = facts.runtime
  const engine = nonEmpty(runtime?.engine)
  // 上游没有自己报名字时（旧版的适配器、还没连上过）用仓库里登记的那一份（harness-identity.mts，
  // 引擎自报的也是从那里来的）。按运行时报的引擎名认：认的是“对面说自己是什么”；
  // 还没连上过的 harness 没有任何上游信息，只能拿标识去认
  const known = harnessIdentity(engine ?? id)
  const base = nonEmpty(runtime?.displayName) ?? known?.displayName ?? engine ?? id
  // 标识和引擎名不一样，说明同一种引擎配了不止一份：名字后面带上标识，徽标也从标识来，才分得开。
  // 这时候不能用引擎自报的徽标：两份报的是同一个（夹具里的 pi 和 pi-b 都报 PI）
  const alias = engine !== null && engine !== id
  // 结构化声明（能力位、权限预设、它支持的扩展）原样带上，报了哪项带哪项，不改不补。
  // 适配器的引擎是自己报的；原生 codex 报不了，facts.runtime 是设备进程替它整理的那一份（native-codex.mts）
  const declared: Pick<HarnessInfo, 'extensions' | 'features' | 'permissionPresets'> = {}
  if (Array.isArray(runtime?.extensions)) declared.extensions = runtime.extensions as string[]
  if (isObject(runtime?.features))
    declared.features = runtime.features as unknown as HarnessFeatures
  if (Array.isArray(runtime?.permissionPresets))
    declared.permissionPresets = runtime.permissionPresets as PermissionPreset[]
  return {
    id,
    displayName: alias ? `${base} (${id})` : base,
    badge: alias ? badgeFromId(id) : (nonEmpty(runtime?.badge) ?? known?.badge ?? badgeFromId(id)),
    // 适配器的运行时在握手应答里报的是协议版本，harness 本体的版本在 runtime/info 的 cliBuild 里
    // （原生 codex 的那一份里，cliBuild 是设备进程从它的握手应答里认出来的）；
    // 没有声明的上游（旧版的适配器、没标明是原生的 codex）才直接从握手应答里取
    version: runtime ? firstVersion(runtime.cliBuild) : firstVersion(facts.userAgent),
    engine,
    available: unavailable === null,
    unavailable,
    ...declared,
  }
}

/**
 * 进程里各个 harness 最近一次握手得到的信息。上游连接是每条客户端连接各有一组，
 * 新连进来的客户端如果一时连不上某个运行时，还能用别的连接见过的名字和版本来显示它。
 */
export class HarnessCatalog {
  private readonly facts = new Map<string, UpstreamFacts>()

  update(harness: string, facts: UpstreamFacts): void {
    this.facts.set(harness, facts)
  }

  latest(harness: string): UpstreamFacts {
    return this.facts.get(harness) ?? { userAgent: null, runtime: null }
  }
}
