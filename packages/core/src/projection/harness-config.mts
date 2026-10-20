// harness 详情设置：协议里的应答 → 界面看的形状（model-harness-config.mts）。
// 应答是对面发来的，不能只靠类型：缺的补默认值，形状不对的丢掉那一项，不让一项坏数据把整页弄坏。
import type {
  HarnessAuthField,
  HarnessAuthMethod,
  HarnessAuthStep,
  HarnessConfigReadResponse,
  HarnessInstructionsInfo,
  HarnessMcpReadResponse,
  HarnessMcpServer,
  HarnessModelBase,
  HarnessModelEntry,
  HarnessModelsReadResponse,
  HarnessProvider,
  HarnessProvidersReadResponse,
  HarnessSettingOption,
  HarnessSettingSpec,
} from '../../../protocol/src/harness-config.mjs'
import type { Bilingual } from '../model.mjs'
import type {
  HcAuthField,
  HcAuthMethod,
  HcAuthState,
  HcAuthStep,
  HcConfigView,
  HcEffect,
  HcFile,
  HcInstructionsView,
  HcMcpServer,
  HcMcpTransport,
  HcMcpView,
  HcModelBase,
  HcModelEntry,
  HcModelsView,
  HcOption,
  HcProvider,
  HcProvidersView,
  HcSettingSpec,
} from '../model-harness-config.mjs'
import { bilingual } from './manage.mjs'

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
const list = <T,>(value: unknown): T[] => (Array.isArray(value) ? (value as T[]) : [])
const str = (value: unknown): string | null => (typeof value === 'string' ? value : null)
const num = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null
const textOrNull = (value: unknown): Bilingual | null =>
  value === null || value === undefined ? null : bilingual(value)
const strings = (value: unknown): string[] =>
  list<unknown>(value).filter((entry): entry is string => typeof entry === 'string')
const stringMap = (value: unknown): Record<string, string> =>
  isRecord(value)
    ? Object.fromEntries(
        Object.entries(value).filter(
          (entry): entry is [string, string] => typeof entry[1] === 'string',
        ),
      )
    : {}

const EFFECTS: readonly HcEffect[] = ['none', 'newSession', 'harness']
const effectOf = (value: unknown): HcEffect =>
  EFFECTS.includes(value as HcEffect) ? (value as HcEffect) : 'none'

function option(raw: HarnessSettingOption): HcOption | null {
  if (!isRecord(raw) || typeof raw.value !== 'string') return null
  return {
    value: raw.value,
    title: raw.title ? bilingual(raw.title) : { 'zh-CN': raw.value, en: raw.value },
    description: textOrNull(raw.description),
  }
}

const options = (value: unknown): HcOption[] =>
  list<HarnessSettingOption>(value).flatMap((raw) => option(raw) ?? [])

export function projectSpec(raw: HarnessSettingSpec): HcSettingSpec | null {
  if (!isRecord(raw) || typeof raw.key !== 'string' || !raw.key) return null
  return {
    key: raw.key,
    group: str(raw.group) ?? '',
    type: str(raw.type) ?? 'string',
    title: raw.title ? bilingual(raw.title) : { 'zh-CN': raw.key, en: raw.key },
    description: textOrNull(raw.description),
    default: raw.default === undefined ? null : (raw.default as HcSettingSpec['default']),
    effect: effectOf(raw.effect),
    clearable: raw.clearable !== false,
    readOnly: raw.readOnly === true,
    readOnlyReason: textOrNull(raw.readOnlyReason),
    minimum: num(raw.minimum),
    maximum: num(raw.maximum),
    options: options(raw.options),
    allowCustom: raw.allowCustom === true,
    placeholder: str(raw.placeholder),
  }
}

const specs = (value: unknown): HcSettingSpec[] =>
  list<HarnessSettingSpec>(value).flatMap((raw) => projectSpec(raw) ?? [])

const files = (value: unknown): HcFile[] =>
  list<unknown>(value).flatMap((raw) =>
    isRecord(raw) && typeof raw.path === 'string'
      ? [{ role: str(raw.role) ?? 'settings', path: raw.path }]
      : [],
  )

export function projectConfig(raw: HarnessConfigReadResponse): HcConfigView {
  const overridden: HcConfigView['overridden'] = {}
  for (const [key, entry] of Object.entries(isRecord(raw?.overridden) ? raw.overridden : {})) {
    if (isRecord(entry) && 'value' in entry) {
      overridden[key] = { value: entry.value, by: bilingual(entry.by) }
    }
  }
  return {
    groups: list<unknown>(raw?.groups).flatMap((group) =>
      isRecord(group) && typeof group.id === 'string'
        ? [
            {
              id: group.id,
              title: group.title ? bilingual(group.title) : { 'zh-CN': group.id, en: group.id },
              description: textOrNull(group.description),
            },
          ]
        : [],
    ),
    settings: specs(raw?.settings),
    values: isRecord(raw?.values) ? { ...raw.values } : {},
    overridden,
    actions: list<unknown>(raw?.actions).flatMap((action) =>
      isRecord(action) && typeof action.id === 'string'
        ? [
            {
              id: action.id,
              group: str(action.group) ?? '',
              title: action.title ? bilingual(action.title) : { 'zh-CN': action.id, en: action.id },
              description: textOrNull(action.description),
              confirm: textOrNull(action.confirm),
              danger: action.danger === true,
            },
          ]
        : [],
    ),
    version: String(raw?.version ?? ''),
    files: files(raw?.files),
    modelCatalog: raw?.modelCatalog === true,
  }
}

function field(raw: HarnessAuthField): HcAuthField | null {
  if (!isRecord(raw) || typeof raw.id !== 'string' || !raw.id) return null
  return {
    id: raw.id,
    title: raw.title ? bilingual(raw.title) : { 'zh-CN': raw.id, en: raw.id },
    secret: raw.secret === true,
    optional: raw.optional === true,
    placeholder: str(raw.placeholder),
    options: options(raw.options),
  }
}

const fields = (value: unknown): HcAuthField[] =>
  list<HarnessAuthField>(value).flatMap((raw) => field(raw) ?? [])

function method(raw: HarnessAuthMethod): HcAuthMethod | null {
  if (!isRecord(raw) || typeof raw.id !== 'string' || typeof raw.kind !== 'string') return null
  return {
    id: raw.id,
    kind: raw.kind,
    title: raw.title ? bilingual(raw.title) : { 'zh-CN': raw.id, en: raw.id },
    description: textOrNull(raw.description),
    fields: fields(raw.fields),
    envName: str(raw.envName),
    effect: raw.kind === 'env' && raw.effect === undefined ? 'harness' : effectOf(raw.effect),
  }
}

const AUTH_KINDS: readonly HcAuthState['kind'][] = ['oauth', 'apiKey', 'env', 'none']

export function projectAuthState(raw: unknown): HcAuthState {
  if (!isRecord(raw)) return { signedIn: false, kind: 'none', label: null, detail: null }
  return {
    signedIn: raw.signedIn === true,
    kind: AUTH_KINDS.includes(raw.kind as HcAuthState['kind'])
      ? (raw.kind as HcAuthState['kind'])
      : 'none',
    label: str(raw.label),
    detail: textOrNull(raw.detail),
  }
}

function provider(raw: HarnessProvider): HcProvider | null {
  if (!isRecord(raw) || typeof raw.id !== 'string' || !raw.id) return null
  return {
    id: raw.id,
    title: raw.title ? bilingual(raw.title) : { 'zh-CN': raw.id, en: raw.id },
    kind: raw.kind === 'custom' ? 'custom' : 'builtin',
    auth: projectAuthState(raw.auth),
    methods: list<HarnessAuthMethod>(raw.methods).flatMap((entry) => method(entry) ?? []),
    active: raw.active === true,
    definition: isRecord(raw.definition) ? { ...raw.definition } : null,
    templateId: str(raw.templateId),
    canLogout: raw.canLogout === true,
  }
}

export function projectProviders(raw: HarnessProvidersReadResponse): HcProvidersView {
  return {
    providers: list<HarnessProvider>(raw?.providers).flatMap((entry) => provider(entry) ?? []),
    switchable: raw?.switchable === true,
    templates: list<unknown>(raw?.templates).flatMap((template) =>
      isRecord(template) && typeof template.id === 'string'
        ? [
            {
              id: template.id,
              title: template.title
                ? bilingual(template.title)
                : { 'zh-CN': template.id, en: template.id },
              description: textOrNull(template.description),
              fields: specs(template.fields),
            },
          ]
        : [],
    ),
    version: String(raw?.version ?? ''),
  }
}

/** 登录的一步。认不出的当作失败，免得界面一直等 */
export function projectStep(raw: HarnessAuthStep | unknown): HcAuthStep {
  const step = isRecord(raw) ? raw : {}
  switch (step.kind) {
    case 'openUrl':
      if (typeof step.url === 'string') {
        const port = num(step.callbackPort)
        return {
          kind: 'openUrl',
          url: step.url,
          callbackPort:
            port !== null && Number.isInteger(port) && port > 0 && port < 65536 ? port : null,
          message: textOrNull(step.message),
          prompt: fields(step.prompt),
        }
      }
      break
    case 'deviceCode':
      if (typeof step.url === 'string' && typeof step.userCode === 'string') {
        return {
          kind: 'deviceCode',
          url: step.url,
          userCode: step.userCode,
          message: textOrNull(step.message),
        }
      }
      break
    case 'prompt':
      return { kind: 'prompt', fields: fields(step.fields), message: textOrNull(step.message) }
    case 'done':
      return { kind: 'done', auth: projectAuthState(step.auth) }
    case 'failed':
      return { kind: 'failed', message: bilingual(step.message ?? '') }
  }
  return {
    kind: 'failed',
    message: {
      'zh-CN': '对面给了一个认不出的登录步骤',
      en: 'The device sent an unrecognized login step',
    },
  }
}

const TRANSPORTS: readonly HcMcpTransport[] = ['stdio', 'http', 'sse']
const MCP_STATES = ['connected', 'failed', 'needsAuth', 'disabled', 'unknown'] as const

function mcpServer(raw: HarnessMcpServer): HcMcpServer | null {
  if (!isRecord(raw) || typeof raw.name !== 'string' || !raw.name) return null
  const status = isRecord(raw.status) ? raw.status : null
  return {
    name: raw.name,
    transport: TRANSPORTS.includes(raw.transport as HcMcpTransport)
      ? (raw.transport as HcMcpTransport)
      : 'stdio',
    enabled: raw.enabled !== false,
    command: str(raw.command),
    args: strings(raw.args),
    cwd: str(raw.cwd),
    env: stringMap(raw.env),
    secretKeys: strings(raw.secretKeys),
    url: str(raw.url),
    headers: stringMap(raw.headers),
    bearerTokenEnvVar: str(raw.bearerTokenEnvVar),
    extra: isRecord(raw.extra) ? { ...raw.extra } : {},
    status: status
      ? {
          state: MCP_STATES.includes(status.state as (typeof MCP_STATES)[number])
            ? (status.state as (typeof MCP_STATES)[number])
            : 'unknown',
          message: str(status.message),
        }
      : null,
  }
}

export function projectMcp(raw: HarnessMcpReadResponse): HcMcpView {
  const transports = strings(raw?.transports).filter((entry): entry is HcMcpTransport =>
    TRANSPORTS.includes(entry as HcMcpTransport),
  )
  return {
    servers: list<HarnessMcpServer>(raw?.servers).flatMap((entry) => mcpServer(entry) ?? []),
    transports: transports.length > 0 ? transports : ['stdio'],
    oauth: raw?.oauth === true,
    extraFields: specs(raw?.extraFields),
    version: String(raw?.version ?? ''),
    files: files(raw?.files),
  }
}

/** 界面交回来的 MCP 服务 → 协议的形状。空的可选项不带 */
export function outgoingMcp(server: HcMcpServer): HarnessMcpServer {
  const remote = server.transport !== 'stdio'
  return {
    name: server.name,
    transport: server.transport,
    enabled: server.enabled,
    ...(!remote && server.command ? { command: server.command } : {}),
    ...(!remote && server.args.length > 0 ? { args: server.args } : {}),
    ...(!remote && server.cwd ? { cwd: server.cwd } : {}),
    ...(Object.keys(server.env).length > 0 ? { env: server.env } : {}),
    ...(server.secretKeys.length > 0 ? { secretKeys: server.secretKeys } : {}),
    ...(remote && server.url ? { url: server.url } : {}),
    ...(remote && Object.keys(server.headers).length > 0 ? { headers: server.headers } : {}),
    ...(remote && server.bearerTokenEnvVar ? { bearerTokenEnvVar: server.bearerTokenEnvVar } : {}),
    ...(Object.keys(server.extra).length > 0 ? { extra: server.extra } : {}),
  }
}

export function projectInstructions(raw: HarnessInstructionsInfo): HcInstructionsView {
  return {
    path: str(raw?.path) ?? '',
    fileName: str(raw?.fileName) ?? 'AGENTS.md',
    exists: raw?.exists === true,
    content: str(raw?.content) ?? '',
    hash: str(raw?.hash) ?? '',
    linkTarget: str(raw?.linkTarget),
    overriddenBy: str(raw?.overriddenBy),
  }
}

/** 上下文窗口只认正整数，别的当没给 */
const windowOf = (value: unknown): number | null =>
  typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : null

function modelEntry(raw: HarnessModelEntry): HcModelEntry | null {
  if (!isRecord(raw) || typeof raw.id !== 'string' || !raw.id) return null
  return {
    id: raw.id,
    displayName: str(raw.displayName) || null,
    contextWindow: windowOf(raw.contextWindow),
    base: str(raw.base) || raw.id,
  }
}

function modelBase(raw: HarnessModelBase): HcModelBase | null {
  if (!isRecord(raw) || typeof raw.id !== 'string' || !raw.id) return null
  return {
    id: raw.id,
    displayName: str(raw.displayName) || raw.id,
    contextWindow: windowOf(raw.contextWindow),
    description: str(raw.description) || null,
  }
}

/** 同一个 id 只留头一个（清单里模型名唯一，底稿也按 id 找） */
const unique = <T extends { id: string }>(items: T[]): T[] => {
  const seen = new Set<string>()
  return items.filter((item) => !seen.has(item.id) && seen.add(item.id))
}

export function projectModels(raw: HarnessModelsReadResponse): HcModelsView {
  const custom = raw?.custom === true
  return {
    custom,
    entries: custom
      ? unique(list<HarnessModelEntry>(raw?.entries).flatMap((entry) => modelEntry(entry) ?? []))
      : [],
    bases: unique(list<HarnessModelBase>(raw?.bases).flatMap((entry) => modelBase(entry) ?? [])),
    path: str(raw?.path) || null,
    version: String(raw?.version ?? ''),
    effect: effectOf(raw?.effect),
    note: textOrNull(raw?.note),
    readOnlyReason: textOrNull(raw?.readOnlyReason),
  }
}

/** 界面交回来的清单 → 协议的形状：显示名去掉首尾空白，空的当没给 */
export function outgoingModels(entries: readonly HcModelEntry[]): HarnessModelEntry[] {
  return entries.map((entry) => ({
    id: entry.id.trim(),
    displayName: entry.displayName?.trim() || null,
    contextWindow: windowOf(entry.contextWindow),
    base: entry.base,
  }))
}
