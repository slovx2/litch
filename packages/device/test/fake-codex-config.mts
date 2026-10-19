// 给假的原生 codex（fake-codex.mts）装上 harness 详情设置要用到的那几组方法，照真的 codex 0.160.0
// 在隔离的数据目录里跑出来的样子（2026-10-19 实测）：
//   - config/read 带 includeLayers：用户层一直在（文件没有时是空表），排在系统层前面；版本是 sha256:<内容的哈希>；
//   - config/batchWrite：版本对不上回 -32600，data.config_write_error_code = configVersionConflict；
//     只许写用户层的文件；值为 null 是删键；写 profiles.* 被拒；
//   - 新开一次 ChatGPT 登录会让进行中的那次以失败结束（account/login/completed success=false）；
//   - API key 登录当场成功，也发一条 loginId 为 null 的 account/login/completed。
import { createHash } from 'node:crypto'
import { splitKey } from '../src/codex-config-io.mjs'
import type { FakeCodex } from './fake-codex.mjs'
import { RpcFailure } from './fake-upstream.mjs'

export const USER_FILE = '/fake/codex-home/config.toml'
const SYSTEM = { type: 'system', file: '/etc/codex/config.toml' }

const hash = (value: unknown) =>
  `sha256:${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`

function setAt(root: Record<string, any>, path: string[], value: unknown): void {
  let node = root
  for (const part of path.slice(0, -1)) {
    if (typeof node[part] !== 'object' || node[part] === null) node[part] = {}
    node = node[part]
  }
  const last = path[path.length - 1] as string
  if (value === null) delete node[last]
  else node[last] = value
}

/** 摊平成 a.b.c 的键，算 origins 用 */
function flatten(value: unknown, prefix: string[] = [], out: string[] = []): string[] {
  if (typeof value === 'object' && value !== null && !Array.isArray(value))
    for (const [key, inner] of Object.entries(value)) flatten(inner, [...prefix, key], out)
  else out.push(prefix.join('.'))
  return out
}

export interface FakeCodexConfig {
  /** 用户层（config.toml）的内容 */
  user: Record<string, any>
  /** 比用户层更优先的一层（命令行参数），没有是 null */
  flags: Record<string, any> | null
  requirements: Record<string, unknown> | null
  account: Record<string, unknown> | null
  /** 进行中的 ChatGPT 登录 */
  login: string | null
  /** 每次写入的参数 */
  writes: any[]
  skillWrites: any[]
  memoryResets: number
  reloads: number
}

const MODELS = [
  {
    id: 'gpt-a',
    model: 'gpt-a',
    displayName: 'GPT-A',
    description: '默认的',
    hidden: false,
    isDefault: true,
    defaultReasoningEffort: 'low',
    supportedReasoningEfforts: [
      { reasoningEffort: 'low', description: '快' },
      { reasoningEffort: 'high', description: '深' },
    ],
    serviceTiers: [{ id: 'priority', name: 'Fast', description: '2x' }],
    defaultServiceTier: null,
  },
  { id: 'gpt-hidden', model: 'gpt-hidden', displayName: 'H', hidden: true, isDefault: false },
]

const FEATURES = [
  {
    name: 'shiny',
    stage: 'beta',
    displayName: 'Shiny',
    description: '试试看',
    enabled: false,
    defaultEnabled: false,
  },
  {
    name: 'memories',
    stage: 'underDevelopment',
    displayName: null,
    description: null,
    enabled: false,
    defaultEnabled: false,
  },
  {
    name: 'shell_tool',
    stage: 'stable',
    displayName: null,
    description: null,
    enabled: true,
    defaultEnabled: true,
  },
]

export const SKILL_PATH = '/fake/codex-home/skills/.system/imagegen/SKILL.md'
export const HOOK_KEY = '/fake/codex-home/hooks.json:pre_tool_use:0:0'

export function installConfig(codex: FakeCodex): FakeCodexConfig {
  const state: FakeCodexConfig = {
    user: {},
    flags: null,
    requirements: null,
    account: null,
    login: null,
    writes: [],
    skillWrites: [],
    memoryResets: 0,
    reloads: 0,
  }
  const layers = () => {
    const list: any[] = []
    if (state.flags)
      list.push({ name: { type: 'sessionFlags' }, version: hash(state.flags), config: state.flags })
    list.push({
      name: { type: 'user', file: USER_FILE, profile: null },
      version: hash(state.user),
      config: state.user,
    })
    list.push({ name: SYSTEM, version: hash({}), config: {} })
    return list
  }
  const h = codex.handlers
  h['config/read'] = () => {
    const all = layers()
    const config: Record<string, any> = structuredClone(state.user)
    for (const key of flatten(state.flags ?? {}))
      setAt(
        config,
        key.split('.'),
        key.split('.').reduce((node: any, part) => node[part], state.flags),
      )
    const origins: Record<string, unknown> = {}
    for (const layer of [...all].reverse())
      for (const key of flatten(layer.config))
        if (key) origins[key] = { name: layer.name, version: layer.version }
    return { config, origins, layers: all }
  }
  h['configRequirements/read'] = () => ({ requirements: state.requirements })
  h['config/batchWrite'] = (params) => {
    state.writes.push(params)
    if (params.filePath && params.filePath !== USER_FILE)
      throw new RpcFailure(-32600, 'Only writes to the user config are allowed', {
        config_write_error_code: 'configLayerReadonly',
      })
    if (params.expectedVersion != null && params.expectedVersion !== hash(state.user))
      throw new RpcFailure(
        -32600,
        'Configuration was modified since last read. Fetch latest version and retry.',
        {
          config_write_error_code: 'configVersionConflict',
        },
      )
    const next = structuredClone(state.user)
    for (const edit of params.edits) {
      const path = splitKey(edit.keyPath)
      if (path[0] === 'profiles')
        throw new RpcFailure(-32600, '`profiles` can no longer be written', {
          config_write_error_code: 'configValidationError',
        })
      setAt(next, path, edit.value)
    }
    state.user = next
    return {
      status: 'ok',
      version: hash(state.user),
      filePath: USER_FILE,
      overriddenMetadata: null,
    }
  }
  h['model/list'] = () => ({ data: MODELS, nextCursor: null })
  h['experimentalFeature/list'] = () => ({ data: FEATURES, nextCursor: null })
  h['skills/list'] = (params) => ({
    data: [
      {
        cwd: params.cwds?.[0] ?? '/',
        skills: [
          {
            name: 'imagegen',
            description: '出图',
            path: SKILL_PATH,
            scope: 'system',
            enabled: true,
            pluginId: null,
          },
          {
            name: 'repo-skill',
            description: '项目的',
            path: '/work/.codex/skills/x/SKILL.md',
            scope: 'repo',
            enabled: true,
            pluginId: null,
          },
        ],
        errors: [],
      },
    ],
  })
  h['skills/config/write'] = (params) => {
    state.skillWrites.push(params)
    const list = (state.user.skills?.config ?? []).filter((item: any) => item.path !== params.path)
    list.push({ path: params.path, enabled: params.enabled })
    setAt(state.user, ['skills', 'config'], list)
    return { effectiveEnabled: params.enabled }
  }
  h['plugin/list'] = () => ({
    marketplaces: [
      {
        name: 'm',
        path: null,
        interface: null,
        plugins: [{ id: 'docs@m', name: 'docs', installed: true, enabled: true }],
      },
    ],
    marketplaceLoadErrors: [],
    featuredPluginIds: [],
  })
  h['hooks/list'] = (params) => ({
    data: [
      {
        cwd: params.cwds?.[0] ?? '/',
        hooks: [
          {
            key: HOOK_KEY,
            eventName: 'preToolUse',
            handlerType: 'command',
            command: 'python3 pre.py',
            sourcePath: '/fake/codex-home/hooks.json',
            isManaged: false,
            currentHash: 'sha256:hook',
            trustStatus: state.user.hooks?.state?.[HOOK_KEY]?.trusted_hash
              ? 'trusted'
              : 'untrusted',
            enabled: true,
          },
        ],
        warnings: [],
        errors: [],
      },
    ],
  })
  h['memory/reset'] = () => {
    state.memoryResets++
    return {}
  }
  h['account/read'] = () => ({
    account: state.account,
    requiresOpenaiAuth: true,
    workspaceRouting: null,
  })
  h['account/login/start'] = (params) => {
    // 新开的一次让进行中的那次结束（实测）
    if (state.login) {
      const old = state.login
      queueMicrotask(() =>
        codex.notify('account/login/completed', {
          loginId: old,
          success: false,
          error: 'Login was not completed',
        }),
      )
    }
    state.login = null
    if (params.type === 'apiKey') {
      state.account = { type: 'apiKey' }
      queueMicrotask(() =>
        codex.notify('account/login/completed', { loginId: null, success: true, error: null }),
      )
      return { type: 'apiKey' }
    }
    const loginId = `login-${state.writes.length}-${Math.random().toString(16).slice(2, 8)}`
    state.login = loginId
    if (params.type === 'chatgpt')
      return {
        type: 'chatgpt',
        loginId,
        authUrl:
          'https://auth.openai.com/oauth/authorize?response_type=code&redirect_uri=http%3A%2F%2F127.0.0.1%3A1455%2Fauth%2Fcallback&state=x',
      }
    if (params.type === 'chatgptDeviceCode')
      return {
        type: 'chatgptDeviceCode',
        loginId,
        verificationUrl: 'https://auth.openai.com/codex/device',
        userCode: 'ABCD-EFGH',
      }
    throw new RpcFailure(-32600, `Invalid request: unknown variant \`${params.type}\``)
  }
  h['account/login/cancel'] = (params) => {
    if (state.login === params.loginId) state.login = null
    return { status: 'canceled' }
  }
  h['account/logout'] = () => {
    state.account = null
    return {}
  }
  h['mcpServerStatus/list'] = () => ({
    data: Object.keys(state.user.mcp_servers ?? {}).map((name) => ({
      name,
      authStatus: state.user.mcp_servers[name].url ? 'notLoggedIn' : 'unsupported',
      toolsError: null,
      tools: {},
    })),
    nextCursor: null,
  })
  h['config/mcpServer/reload'] = () => {
    state.reloads++
    return {}
  }
  h['mcpServer/oauth/login'] = (params) => {
    if (!state.user.mcp_servers?.[params.name])
      throw new RpcFailure(-32600, `No MCP server named '${params.name}' found.`)
    return {
      authorizationUrl: `http://127.0.0.1:7777/authorize?client_id=x&redirect_uri=http%3A%2F%2F127.0.0.1%3A49210%2Fcallback%2Fabc`,
    }
  }
  return state
}

/** 这一刻用户层的版本（测试拿它和应答对） */
export const userVersion = (state: FakeCodexConfig) => hash(state.user)
