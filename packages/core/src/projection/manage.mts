// 设备配置接口的应答 → 界面看到的管理数据（model-manage.mts）。都是纯函数。
// 核心在这件事上只做转运：结构是设备服务声明的，这里不认识任何一项具体的设置，
// 只按类型把值整理成界面要的形状。
//
// 密钥只有“设没设过”：设备服务本来就不把已保存的密钥读回来，这里再守一遍——
// 密钥类的值只留 set；环境变量表里标了密钥的、名字看着像密钥的，一律不带值。
// 这样就算对面哪一版出了岔子，已保存的密钥也到不了界面、到不了界面这一侧的任何数据里。
import type {
  DeviceDiagnosticsResponse,
  DeviceLogsReadResponse,
  DeviceSettingsReadResponse,
  DeviceSettingsSnapshot,
  DeviceSshConfigResponse,
  SettingScope,
} from '../../../protocol/src/index.mjs'
import type { Bilingual } from '../model.mjs'
import type {
  DiagnosticsView,
  EnvEntryView,
  InheritedEnvView,
  LogTailView,
  ManageView,
  SettingEditView,
  SettingScopeView,
  SettingSpecView,
  SettingsSnapshotView,
  SettingValueView,
  SshConfigView,
} from '../model-manage.mjs'

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const text = (value: unknown): string => (typeof value === 'string' ? value : '')

/** 两种语言的一段话。对面只给了一种，或者给的是一段字，两种都用它 */
export function bilingual(value: unknown): Bilingual {
  if (typeof value === 'string') return { 'zh-CN': value, en: value }
  if (!isRecord(value)) return { 'zh-CN': '', en: '' }
  const zh = text(value['zh-CN'])
  const en = text(value.en)
  return { 'zh-CN': zh || en, en: en || zh }
}

const bilingualOrNull = (value: unknown): Bilingual | null =>
  value === null || value === undefined ? null : bilingual(value)

/**
 * 名字看着像密钥的环境变量。和设备服务用的是同一条规则（cmd/codex-harness-adapter/settings.go 的
 * secretLikeName）：它按这条规则不给值，这里按同一条规则不收值。
 */
const SECRET_NAME = /key|token|secret|passw|credential|auth/i

export const looksSecret = (name: string): boolean => SECRET_NAME.test(name)

function scopeOf(scope: SettingScope | undefined): SettingScopeView {
  if (scope?.kind === 'harness' && typeof scope.harness === 'string') {
    return { kind: 'harness', harness: scope.harness }
  }
  return { kind: 'device' }
}

/** 环境变量表读到的样子：密钥不带值 */
function envEntries(value: unknown): EnvEntryView[] {
  if (!Array.isArray(value)) return []
  const entries: EnvEntryView[] = []
  for (const entry of value) {
    if (!isRecord(entry) || typeof entry.name !== 'string') continue
    if (entry.secret === true || looksSecret(entry.name)) {
      entries.push({ name: entry.name, secret: true })
    } else {
      entries.push({ name: entry.name, value: text(entry.value) })
    }
  }
  return entries
}

/** 一项设置的值按它的类型整理。形状对不上的是 null */
function valueByType(type: string, raw: unknown): SettingValueView {
  switch (type) {
    case 'boolean':
      return typeof raw === 'boolean' ? raw : null
    case 'integer':
      return typeof raw === 'number' && Number.isFinite(raw) ? raw : null
    case 'string':
    case 'enum':
    case 'path':
      return typeof raw === 'string' ? raw : null
    case 'env':
      return envEntries(raw)
    case 'secret':
      // 对面要是把值给过来了，也只当它是“设过了”
      return { set: isRecord(raw) ? raw.set === true : typeof raw === 'string' && raw !== '' }
    default:
      // 这一版不认识的类型：简单的值照给，别的不知道里面有什么，不往界面上放
      return typeof raw === 'boolean' || typeof raw === 'number' || typeof raw === 'string'
        ? raw
        : null
  }
}

function specOf(raw: DeviceSettingsReadResponse['schema']['settings'][number]): SettingSpecView {
  const type = text(raw.type)
  return {
    key: raw.key,
    group: text(raw.group),
    type,
    title: bilingual(raw.title),
    description: bilingual(raw.description),
    scope: scopeOf(raw.scope),
    default: valueByType(type, raw.default),
    restart: raw.restart === 'harness' ? 'harness' : 'none',
    // 只认这一版知道的角色，别的当作没标
    role: raw.role === 'enable' ? 'enable' : null,
    minimum: typeof raw.minimum === 'number' ? raw.minimum : null,
    maximum: typeof raw.maximum === 'number' ? raw.maximum : null,
    options: (Array.isArray(raw.options) ? raw.options : [])
      .filter((option) => isRecord(option) && typeof option.value === 'string')
      .map((option) => ({ value: option.value, title: bilingual(option.title) })),
  }
}

/** 设置现在的值。只留结构里声明了的那些键：没声明的界面画不出来 */
export function projectSnapshot(
  settings: readonly SettingSpecView[],
  raw: DeviceSettingsSnapshot,
): SettingsSnapshotView {
  const given = isRecord(raw.values) ? raw.values : {}
  const values: Record<string, SettingValueView> = {}
  for (const spec of settings) {
    values[spec.key] = valueByType(spec.type, given[spec.key]) ?? spec.default
  }
  const strings = (list: unknown): string[] =>
    Array.isArray(list) ? list.filter((entry) => typeof entry === 'string') : []
  return {
    version: typeof raw.version === 'number' ? raw.version : 0,
    values,
    explicit: strings(raw.explicit),
    pendingRestart: strings(raw.pendingRestart),
    sshEntries: (Array.isArray(raw.sshEntries) ? raw.sshEntries : [])
      .filter((entry) => isRecord(entry) && typeof entry.harness === 'string')
      .map((entry) => ({
        harness: entry.harness,
        enabled: entry.enabled === true,
        port: typeof entry.port === 'number' ? entry.port : 0,
        state: text(entry.state),
        reason: isRecord(entry.reason)
          ? {
              kind: text(entry.reason.kind),
              text: bilingual(entry.reason.text),
              detail: text(entry.reason.detail),
            }
          : null,
      })),
  }
}

function inheritedOf(list: unknown): InheritedEnvView[] {
  if (!Array.isArray(list)) return []
  const entries: InheritedEnvView[] = []
  for (const entry of list) {
    if (!isRecord(entry) || typeof entry.name !== 'string') continue
    const secret = entry.secret === true || looksSecret(entry.name)
    entries.push(
      secret
        ? { name: entry.name, secret: true }
        : { name: entry.name, value: text(entry.value), secret: false },
    )
  }
  return entries
}

export function projectManage(deviceId: string, raw: DeviceSettingsReadResponse): ManageView {
  const declared = Array.isArray(raw.schema?.settings) ? raw.schema.settings : []
  const settings = declared
    .filter((spec) => isRecord(spec) && typeof spec.key === 'string' && spec.key !== '')
    .map(specOf)
  const groups = (Array.isArray(raw.schema?.groups) ? raw.schema.groups : [])
    .filter((group) => isRecord(group) && typeof group.id === 'string')
    .map((group) => ({
      id: group.id,
      title: bilingual(group.title),
      description: bilingualOrNull(group.description),
      scope: scopeOf(group.scope),
    }))
  return {
    deviceId,
    groups,
    settings,
    snapshot: projectSnapshot(settings, raw.snapshot),
    inheritedEnv: inheritedOf(raw.inheritedEnv),
  }
}

/** 两份快照之间哪些键的值不一样 */
export function changedKeys(before: SettingsSnapshotView, after: SettingsSnapshotView): string[] {
  const keys = new Set([...Object.keys(before.values), ...Object.keys(after.values)])
  return [...keys].filter(
    (key) => JSON.stringify(before.values[key]) !== JSON.stringify(after.values[key]),
  )
}

/**
 * 界面交来的改动整理成发给对面的形状。合不合规矩由设备服务判断，这里只保证形状：
 * 环境变量表里每一项只带名字、值、是不是密钥这三样。
 */
export function outgoingEdits(edits: readonly SettingEditView[]): SettingEditView[] {
  return edits.map(({ key, value }) => {
    if (!Array.isArray(value)) return { key, value }
    const entries: EnvEntryView[] = value.map((entry) => ({
      name: entry.name,
      ...(typeof entry.value === 'string' ? { value: entry.value } : {}),
      ...(entry.secret === true ? { secret: true } : {}),
    }))
    return { key, value: entries }
  })
}

export function projectDiagnostics(raw: DeviceDiagnosticsResponse): DiagnosticsView {
  const ranAt = Date.parse(text(raw.ranAt))
  return {
    ranAt: Number.isNaN(ranAt) ? null : ranAt,
    checks: (Array.isArray(raw.checks) ? raw.checks : [])
      .filter((check) => isRecord(check))
      .map((check) => ({
        id: text(check.id),
        scope: scopeOf(check.scope),
        status: text(check.status),
        title: bilingual(check.title),
        detail: bilingualOrNull(check.detail),
        logPath: typeof check.logPath === 'string' && check.logPath ? check.logPath : null,
      })),
  }
}

export function projectLogTail(raw: DeviceLogsReadResponse): LogTailView {
  return {
    path: text(raw.path),
    text: text(raw.text),
    truncated: raw.truncated === true,
    size: typeof raw.size === 'number' ? raw.size : 0,
    directory: typeof raw.directory === 'string' && raw.directory ? raw.directory : null,
  }
}

export function projectSshConfig(raw: DeviceSshConfigResponse): SshConfigView {
  return {
    entries: (Array.isArray(raw.entries) ? raw.entries : [])
      .filter((entry) => isRecord(entry) && typeof entry.harness === 'string')
      .map((entry) => ({
        harness: entry.harness,
        alias: text(entry.alias),
        port: typeof entry.port === 'number' ? entry.port : 0,
        config: typeof entry.config === 'string' && entry.config ? entry.config : null,
        unavailable: bilingualOrNull(entry.unavailable),
      })),
    text: text(raw.text),
  }
}
