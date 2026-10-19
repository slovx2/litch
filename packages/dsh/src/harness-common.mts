// harness 详情设置（harnessConfig 扩展）几块共用的：错误、dsh 设置接口的薄封装、schemastery 结构的读法。
// dsh 的设置经它的 Web Remote 读写（settings/*、credentials/*），落在 $DSH_HOME/profiles/web/cordis.patch.yml
// 和 $DSH_HOME/.credentials.yaml，和用户自己开 dsh 的 Web、桌面端改的是同一份。
// 方法名和形状对着 dsh 0.2.0-rc.2 实测（test/harness-config.test.mts）。

import { createHash } from 'node:crypto'
import {
  HARNESS_CONFIG_ERROR_CODE,
  type HarnessConfigErrorReason,
  type HarnessText,
} from '../../protocol/src/harness-config.mjs'
import { ProtocolError } from '../../shared/src/protocol-contract.mjs'
import { RemoteError, type WebRemote } from './remote.mjs'

export const HARNESS_ID = 'dsh'

export const text = (zh: string, en: string): HarnessText => ({ 'zh-CN': zh, en })

/** harnessConfig 的错误：JSON-RPC 的 code 是 -32000，data 里 litch 说是哪一种（server.mts 的 handle 把 data 带上） */
export class HarnessConfigError extends ProtocolError {
  readonly data: {
    litch: HarnessConfigErrorReason
    harness: string
    key?: string
    message?: HarnessText
  }
  constructor(reason: HarnessConfigErrorReason, message: HarnessText, key?: string) {
    super(HARNESS_CONFIG_ERROR_CODE, message['zh-CN'])
    this.data = { litch: reason, harness: HARNESS_ID, ...(key ? { key } : {}), message }
  }
}

/** 把 dsh 报的失败换成 harnessConfig 的错误。key：是哪一项的写入 */
export function fromRemote(error: unknown, key?: string): Error {
  if (error instanceof HarnessConfigError) return error
  if (!(error instanceof RemoteError)) {
    const detail = error instanceof Error ? error.message : String(error)
    return new HarnessConfigError(
      'unavailable',
      text(`dsh 没起来或连不上：${detail}`, `dsh is not running or unreachable: ${detail}`),
      key,
    )
  }
  const said = text(error.message, error.message)
  if (error.code === 'settings/conflict')
    return new HarnessConfigError(
      'versionConflict',
      text('配置在读过之后被改了，请重读', 'The settings changed since they were read; reload'),
      key,
    )
  if (error.code === 'settings/rejected' || error.code === 'credential/rejected')
    return new HarnessConfigError(
      /overridden|read-only/i.test(error.message) ? 'readOnly' : 'invalidValue',
      said,
      key,
    )
  if (error.code === 'gateway/bad-request') return new HarnessConfigError('invalidValue', said, key)
  if (error.code === 'incompatible' || error.code === 'network' || error.code === 'socket')
    return new HarnessConfigError('unavailable', said, key)
  return new HarnessConfigError('invalidValue', said, key)
}

/** 不透明的版本号：参与的各样东西序列化后的摘要 */
export const versionOf = (value: unknown): string =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 16)

/** 一个设置命名空间（dsh 的 profile 里的一条插件配置）。值都是脱敏过的，role 为 secret 的字段不在里面 */
export interface NamespaceView {
  ns: string
  /** schemastery 的结构，{uid, refs} */
  schema: { uid: number; refs: Record<string, any> }
  /** 实际生效的值（默认 → 组合层 → 用户层） */
  value: any
  /** 用户层以下（默认和组合层）的值 */
  base?: any
  /** 用户层（补丁文件里写了的），没有是 undefined */
  user?: any
  revision: number
}

export interface SettingsSnapshot {
  writable: boolean
  namespaces: Map<string, NamespaceView>
}

export async function describeSettings(remote: WebRemote): Promise<SettingsSnapshot> {
  const described = await remote.rpc('settings/describe', {}, (value) =>
    Array.isArray(value?.namespaces),
  )
  return {
    writable: described.writable !== false,
    namespaces: new Map(described.namespaces.map((view: NamespaceView) => [view.ns, view])),
  }
}

export type PathOp = { op: 'set'; path: string[]; value: unknown } | { op: 'unset'; path: string[] }

/** 按路径改一个命名空间的用户层；revision 对不上 dsh 报 settings/conflict */
export async function mutateSettings(
  remote: WebRemote,
  ns: string,
  ops: PathOp[],
  expectedRevision: number | undefined,
  key?: string,
): Promise<NamespaceView> {
  try {
    return await remote.rpc('settings/mutate', { ns, ops, expectedRevision })
  } catch (error) {
    throw fromRemote(error, key)
  }
}

export interface CredentialInfo {
  configured: boolean
  /** file：存在 $DSH_HOME/.credentials.yaml；env：环境变量里有 */
  source?: string
  writable: boolean
}

/** 问几条凭据引用的情况（dsh 一次最多 64 条）；不返回密钥本身 */
export async function describeCredentials(
  remote: WebRemote,
  refs: string[],
): Promise<Record<string, CredentialInfo>> {
  const unique = [...new Set(refs)]
  const answers: Record<string, CredentialInfo> = {}
  for (let index = 0; index < unique.length; index += 64)
    Object.assign(
      answers,
      await remote.rpc('credentials/describe', { refs: unique.slice(index, index + 64) }),
    )
  return answers
}

/** dsh 官方设置页给没写 apiKeyEnv 的 provider 派生的凭据引用名（MINIMAX_CN_API_KEY 这种） */
export const derivedKeyRef = (provider: string): string =>
  `${provider.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}_API_KEY`

// ---------- schemastery 结构 ----------

/** 结构里某个路径上的节点（dict 逐层往下；dict 的通配项用 sKey 之外的 inner）；没有是 null */
export function schemaNode(schema: NamespaceView['schema'], path: string[]): any | null {
  const resolve = (node: any) => (typeof node === 'number' ? schema.refs[node] : node)
  let node = resolve(schema.uid)
  for (const part of path) {
    if (!node) return null
    if (node.type === 'object') node = resolve(node.dict?.[part])
    else if (node.type === 'dict') node = resolve(node.inner)
    else return null
  }
  return node ?? null
}

/** 结构里某个路径上声明的默认值；没声明是 null */
export function schemaDefault(schema: NamespaceView['schema'], path: string[]): any {
  return schemaNode(schema, path)?.meta?.default ?? null
}

/** 枚举（一串常量的 union）的可选值；不是枚举是 null */
export function schemaEnum(schema: NamespaceView['schema'], path: string[]): string[] | null {
  const node = schemaNode(schema, path)
  if (node?.type !== 'union') return null
  const values = (node.list ?? []).map((id: any) => schema.refs[id])
  return values.every((value: any) => value?.type === 'const')
    ? values.map((value: any) => String(value.value))
    : null
}

/** 对象里按路径取值；路径上断了是 undefined */
export function valueAt(value: any, path: string[]): any {
  let current = value
  for (const part of path) {
    if (current === null || typeof current !== 'object') return undefined
    current = current[part]
  }
  return current
}
