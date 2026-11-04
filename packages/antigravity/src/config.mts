import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type {
  HarnessConfigReadResponse,
  HarnessProvidersReadResponse,
} from '../../protocol/src/harness-config.mjs'
import { ProtocolError } from '../../shared/src/protocol-contract.mjs'

export type Authentication = { kind: 'apiKey'; key: string } | { kind: 'subscription' }
export function modelEndpoint(auth: Authentication, baseUrl: string): Record<string, unknown> {
  if (auth.kind === 'subscription')
    throw new ProtocolError(
      -32004,
      'SDK localharness 0.1.23 没有可用的订阅登录接口；请配置 Gemini API key',
    )
  if (!auth.key.trim())
    throw new ProtocolError(
      -32001,
      '缺少 Gemini API key；请在引擎详情的账号设置中配置 GEMINI_API_KEY',
    )
  return { apiKey: auth.key, baseUrl }
}
const DEFAULT_MODEL = 'gemini-2.5-flash'
const DEFAULT_URL = 'https://generativelanguage.googleapis.com'
const title = (zh: string, en: string) => ({ 'zh-CN': zh, en })
interface Values {
  model: string
  baseUrl: string
}
export class Configuration {
  readonly path: string
  readonly env: NodeJS.ProcessEnv
  constructor(home: string, env = process.env) {
    this.path = join(home, 'config.json')
    this.env = env
  }
  values(): Values {
    try {
      const value = JSON.parse(readFileSync(this.path, 'utf8')) as Values
      this.validate(value)
      return value
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT')
        return { model: DEFAULT_MODEL, baseUrl: DEFAULT_URL }
      throw error
    }
  }
  private validate(value: Values): void {
    if (typeof value.model !== 'string' || !/^[\w.:-]{1,150}$/.test(value.model))
      throw new ProtocolError(-32602, '模型名无效')
    const url = new URL(value.baseUrl)
    if (
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      (url.protocol !== 'https:' &&
        !(url.protocol === 'http:' && ['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname)))
    )
      throw new ProtocolError(
        -32602,
        '模型地址必须使用 HTTPS；回环假服务允许 HTTP，地址不能包含凭据或查询参数',
      )
  }
  endpoint(): Record<string, unknown> {
    return modelEndpoint(
      { kind: 'apiKey', key: this.env.GEMINI_API_KEY ?? '' },
      this.values().baseUrl,
    )
  }
  version(): string {
    return createHash('sha256').update(JSON.stringify(this.values())).digest('hex')
  }
  read(): HarnessConfigReadResponse {
    return {
      groups: [{ id: 'defaults', title: title('默认', 'Defaults'), description: null }],
      settings: [
        {
          key: 'model',
          group: 'defaults',
          type: 'string',
          title: title('模型', 'Model'),
          description: null,
          default: DEFAULT_MODEL,
          effect: 'newSession',
        },
        {
          key: 'baseUrl',
          group: 'defaults',
          type: 'string',
          title: title('Gemini API 地址', 'Gemini API URL'),
          description: title(
            '此地址会收到 API key；更改后新会话生效',
            'This endpoint receives your API key. Applies to new sessions',
          ),
          default: DEFAULT_URL,
          effect: 'newSession',
        },
      ],
      values: { ...this.values() },
      actions: [],
      version: this.version(),
      files: [{ role: 'settings', path: this.path }],
    }
  }
  write(params: any): any {
    if (params.expectedVersion !== this.version())
      throw new ProtocolError(-32000, '配置已变化，请重新读取')
    const next = this.values()
    if (!Array.isArray(params.edits)) throw new ProtocolError(-32602, 'edits 必须是数组')
    for (const edit of params.edits) {
      if (!['model', 'baseUrl'].includes(edit.key)) throw new ProtocolError(-32602, '未知配置项')
      next[edit.key as keyof Values] =
        edit.value ?? (edit.key === 'model' ? DEFAULT_MODEL : DEFAULT_URL)
    }
    this.validate(next)
    const directory = join(this.path, '..')
    mkdirSync(directory, { recursive: true, mode: 0o700 })
    writeFileSync(`${this.path}.tmp`, `${JSON.stringify(next)}\n`, { mode: 0o600 })
    renameSync(`${this.path}.tmp`, this.path)
    return { version: this.version(), overriddenKeys: [], restartRequired: false }
  }
  providers(): HarnessProvidersReadResponse {
    return {
      providers: [
        {
          id: 'gemini',
          title: title('Gemini API', 'Gemini API'),
          kind: 'builtin',
          active: true,
          canLogout: false,
          auth: {
            signedIn: !!this.env.GEMINI_API_KEY,
            kind: this.env.GEMINI_API_KEY ? 'env' : 'none',
            label: null,
          },
          methods: [
            {
              id: 'apiKey',
              kind: 'env',
              title: title('API key', 'API key'),
              description: title(
                'SDK 不支持 Antigravity 订阅登录',
                'The SDK does not support Antigravity subscription sign-in',
              ),
              envName: 'GEMINI_API_KEY',
              effect: 'harness',
            },
          ],
        },
      ],
      templates: [],
      switchable: false,
      version: this.version(),
    }
  }
}
