// 模拟核心的 harness 详情设置示例数据用的小工具：两种语言的字、配置项、选项、登录方式的简写。
// 示例本身在 sample-hc-codex.mts、sample-hc-claude.mts、sample-hc-others.mts。
import type { Bilingual } from '../model.mjs'
import type {
  HcAuthField,
  HcAuthMethod,
  HcAuthState,
  HcConfigView,
  HcEffect,
  HcInstructionsView,
  HcMcpServer,
  HcMcpView,
  HcModelsView,
  HcOption,
  HcProvider,
  HcProvidersView,
  HcSettingSpec,
  HcValue,
} from '../model-harness-config.mjs'

/** 一台示例设备上 harness 的东西放在哪：本机是 macOS 的主目录，远程是 Linux 的 */
export interface SampleHome {
  home: string
  /** 远程设备：浏览器登录要回调转发 */
  remote: boolean
}

/** 一个 harness 的全套示例。secrets 是模拟核心自己记着的密钥原文（界面只看得到“设没设过”） */
export interface SampleHc {
  config: HcConfigView
  providers: HcProvidersView
  mcp: HcMcpView
  instructions: HcInstructionsView
  /** 模型清单（只有 Codex 有；config 的 modelCatalog 跟着它） */
  models?: HcModelsView
  /** 配置项里密钥类的原文：键 → 值 */
  secrets: Record<string, string>
}

export const t = (zh: string, en: string): Bilingual => ({ 'zh-CN': zh, en })

export const opt = (value: string, zh?: string, en?: string, note?: Bilingual): HcOption => ({
  value,
  title: zh === undefined ? { 'zh-CN': value, en: value } : t(zh, en ?? zh),
  description: note ?? null,
})

/** 一项配置。没给的取最常见的样子：能清掉、不只读、立刻生效 */
export function spec(
  key: string,
  group: string,
  type: string,
  title: Bilingual,
  rest: Partial<Omit<HcSettingSpec, 'key' | 'group' | 'type' | 'title'>> = {},
): HcSettingSpec {
  return {
    key,
    group,
    type,
    title,
    description: null,
    default: null,
    effect: 'none',
    clearable: true,
    readOnly: false,
    readOnlyReason: null,
    minimum: null,
    maximum: null,
    options: [],
    allowCustom: false,
    placeholder: null,
    ...rest,
  }
}

export const field = (
  id: string,
  title: Bilingual,
  rest: Partial<Omit<HcAuthField, 'id' | 'title'>> = {},
): HcAuthField => ({
  id,
  title,
  secret: false,
  optional: false,
  placeholder: null,
  options: [],
  ...rest,
})

export const KEY_FIELD = (placeholder: string): HcAuthField =>
  field('apiKey', t('API key', 'API key'), { secret: true, placeholder })

export function method(
  id: string,
  kind: HcAuthMethod['kind'],
  title: Bilingual,
  rest: Partial<Omit<HcAuthMethod, 'id' | 'kind' | 'title'>> = {},
): HcAuthMethod {
  return {
    id,
    kind,
    title,
    description: null,
    fields: [],
    envName: null,
    effect: kind === 'env' ? ('harness' as HcEffect) : 'none',
    ...rest,
  }
}

export const signedOut: HcAuthState = { signedIn: false, kind: 'none', label: null, detail: null }

export function provider(
  id: string,
  title: Bilingual,
  methods: HcAuthMethod[],
  rest: Partial<Omit<HcProvider, 'id' | 'title' | 'methods'>> = {},
): HcProvider {
  return {
    id,
    title,
    kind: 'builtin',
    auth: signedOut,
    methods,
    active: false,
    definition: null,
    templateId: null,
    canLogout: false,
    ...rest,
  }
}

export function server(
  name: string,
  transport: HcMcpServer['transport'],
  rest: Partial<Omit<HcMcpServer, 'name' | 'transport'>> = {},
): HcMcpServer {
  return {
    name,
    transport,
    enabled: true,
    command: null,
    args: [],
    cwd: null,
    env: {},
    secretKeys: [],
    url: null,
    headers: {},
    bearerTokenEnvVar: null,
    extra: {},
    status: { state: 'connected', message: null },
    ...rest,
  }
}

/** 内容的哈希（示例里只要“内容一样哈希就一样”） */
export function hashOf(content: string): string {
  let hash = 5381
  for (let index = 0; index < content.length; index++) {
    hash = ((hash << 5) + hash + content.charCodeAt(index)) | 0
  }
  return `h${(hash >>> 0).toString(16)}`
}

export function instructions(
  path: string,
  content: string | null,
  overriddenBy: string | null = null,
): HcInstructionsView {
  const fileName = path.slice(path.lastIndexOf('/') + 1)
  return {
    path,
    fileName,
    exists: content !== null,
    content: content ?? '',
    hash: content === null ? '' : hashOf(content),
    linkTarget: null,
    overriddenBy,
  }
}

/** 常用分组的名字（各 harness 的设置页长得像） */
export const GROUPS = {
  defaults: { id: 'defaults', title: t('默认模型', 'Default model'), description: null },
  permissions: {
    id: 'permissions',
    title: t('权限与沙箱', 'Permissions & sandbox'),
    description: null,
  },
  behavior: { id: 'behavior', title: t('行为与输出', 'Behavior & output'), description: null },
  tools: {
    id: 'tools',
    title: t('技能、插件与 hooks', 'Skills, plugins & hooks'),
    description: null,
  },
  memory: { id: 'memory', title: t('记忆', 'Memory'), description: null },
  features: {
    id: 'features',
    title: t('实验特性', 'Experimental features'),
    description: t('改完要重启这个 harness 才生效', 'Restart the harness to apply'),
  },
  network: { id: 'network', title: t('网络与重试', 'Network & retries'), description: null },
  advanced: { id: 'advanced', title: t('其他', 'Other'), description: null },
} as const

/** 一份配置：没写进原生文件的项不出现在 values 里 */
export function configOf(
  groups: HcConfigView['groups'],
  settings: HcSettingSpec[],
  values: Record<string, HcValue>,
  rest: Partial<Pick<HcConfigView, 'overridden' | 'actions' | 'files'>> = {},
): HcConfigView {
  return {
    groups,
    settings,
    values,
    overridden: rest.overridden ?? {},
    actions: rest.actions ?? [],
    version: 'v1',
    files: rest.files ?? [],
    modelCatalog: false,
  }
}
