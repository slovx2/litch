// 原生 codex 的 provider 怎么改（litch/harness/providers/upsert|remove|activate）。
// 都是改 config.toml：`model_providers.<id>` 整张表替换、删掉，或者改 `model_provider`。
import type {
  HarnessProvidersWriteResponse,
  HarnessSettingValue,
} from '../../protocol/src/harness-config.mjs'
import { type Ask, batchWrite, type CodexEdit, readSnapshot } from './codex-config-io.mjs'
import {
  activeProvider,
  customProviders,
  OPENAI,
  providerKey,
  RESERVED,
  TEMPLATE,
  TEMPLATE_FIELDS,
} from './codex-providers.mjs'
import { HarnessConfigError, text } from './harness-config.mjs'
import { isObject } from './wire.mjs'

const ID = /^[A-Za-z0-9_-]+$/

function versionOf(params: Record<string, unknown>, harness: string): string {
  if (typeof params.expectedVersion === 'string') return params.expectedVersion
  throw new HarnessConfigError(
    'invalidValue',
    harness,
    text('缺少 expectedVersion', 'expectedVersion is required'),
  )
}

function providerIdOf(params: Record<string, unknown>, harness: string): string {
  const id = params.providerId
  if (typeof id === 'string' && ID.test(id)) return id
  throw new HarnessConfigError(
    'invalidValue',
    harness,
    text(
      'providerId 只能用字母、数字和 - _',
      'providerId may only contain letters, digits, - and _',
    ),
    'providerId',
  )
}

function notFound(harness: string, id: string): HarnessConfigError {
  return new HarnessConfigError(
    'notFound',
    harness,
    text(`没有这个 provider：${id}`, `No such provider: ${id}`),
  )
}

/** 只在用户层里的自定义 provider 能改能删：别的层（项目、管理员）写的这里动不了 */
function userTable(snapshot: Awaited<ReturnType<typeof readSnapshot>>, id: string) {
  const tables = isObject(snapshot.user.model_providers) ? snapshot.user.model_providers : {}
  const table = tables[id]
  return isObject(table) ? table : null
}

/** 照模板核对定义里的字段，合进原来的表（模板以外的字段原样留着）。密钥类字段这个模板里没有 */
function merged(
  harness: string,
  previous: Record<string, unknown> | null,
  definition: unknown,
): Record<string, unknown> {
  if (!isObject(definition))
    throw new HarnessConfigError(
      'invalidValue',
      harness,
      text('definition 要是一个对象', 'definition must be an object'),
    )
  const table: Record<string, unknown> = { ...(previous ?? {}) }
  for (const [key, value] of Object.entries(definition)) {
    const spec = TEMPLATE_FIELDS.find((item) => item.key === key)
    if (!spec)
      throw new HarnessConfigError(
        'invalidValue',
        harness,
        text(`模板里没有 ${key}`, `Unknown field ${key}`),
        key,
      )
    const empty = value === null || value === ''
    if (empty) {
      delete table[key]
      continue
    }
    const fits =
      spec.type === 'boolean'
        ? typeof value === 'boolean'
        : typeof value === 'string' &&
          (spec.type !== 'enum' || (spec.options ?? []).some((item) => item.value === value))
    if (!fits)
      throw new HarnessConfigError(
        'invalidValue',
        harness,
        text(`${key} 的值不对`, `Invalid value for ${key}`),
        key,
      )
    table[key] = value as HarnessSettingValue
  }
  if (typeof table.name !== 'string' || !table.name)
    throw new HarnessConfigError(
      'invalidValue',
      harness,
      text('provider 要有名字', 'The provider needs a name'),
      'name',
    )
  table.wire_api ??= 'responses'
  // 不写的话 codex 默认 false；写出来让文件里看得明白：它不用 ChatGPT 的凭据
  table.requires_openai_auth ??= false
  return table
}

/** litch/harness/providers/upsert */
export async function upsertCodexProvider(
  ask: Ask,
  harness: string,
  params: Record<string, unknown>,
): Promise<HarnessProvidersWriteResponse> {
  const id = providerIdOf(params, harness)
  const expected = versionOf(params, harness)
  if (params.templateId !== TEMPLATE)
    throw new HarnessConfigError(
      'invalidValue',
      harness,
      text(`不认识这个模板：${String(params.templateId)}`, 'Unknown template'),
      'templateId',
    )
  if (RESERVED.has(id))
    throw new HarnessConfigError(
      'readOnly',
      harness,
      text(`${id} 是 codex 自带的 provider，不能改`, `${id} is built into codex`),
    )
  const snapshot = await readSnapshot(ask, harness)
  const previous = userTable(snapshot, id)
  if (!previous && customProviders(snapshot).some(([known]) => known === id))
    throw new HarnessConfigError(
      'readOnly',
      harness,
      text(`${id} 不是写在用户配置里的，这里改不了`, `${id} is defined outside the user config`),
    )
  const table = merged(harness, previous, params.definition)
  const { version } = await batchWrite(
    ask,
    harness,
    snapshot,
    [{ keyPath: providerKey(id), value: table, mergeStrategy: 'replace' }],
    expected,
  )
  // codex 每个新会话都重读配置；在用的 provider 的定义改了，已经开着的会话不变
  return { version, restartRequired: false }
}

/** litch/harness/providers/remove。删的正是在用的那个时一并切回 openai，免得 codex 读不了配置 */
export async function removeCodexProvider(
  ask: Ask,
  harness: string,
  params: Record<string, unknown>,
): Promise<HarnessProvidersWriteResponse> {
  const id = providerIdOf(params, harness)
  const snapshot = await readSnapshot(ask, harness)
  if (RESERVED.has(id))
    throw new HarnessConfigError(
      'readOnly',
      harness,
      text(`${id} 是 codex 自带的 provider，不能删`, `${id} is built into codex`),
    )
  if (!userTable(snapshot, id)) {
    if (customProviders(snapshot).some(([known]) => known === id))
      throw new HarnessConfigError(
        'readOnly',
        harness,
        text(`${id} 不是写在用户配置里的，这里删不了`, `${id} is defined outside the user config`),
      )
    throw notFound(harness, id)
  }
  const edits: CodexEdit[] = [{ keyPath: providerKey(id), value: null, mergeStrategy: 'replace' }]
  if (snapshot.user.model_provider === id)
    edits.push({ keyPath: 'model_provider', value: null, mergeStrategy: 'replace' })
  // remove 的参数里没有 expectedVersion（约定如此），按刚读到的版本写，并发的改动由 codex 那头的版本核对拦下
  const { version } = await batchWrite(ask, harness, snapshot, edits, snapshot.version)
  return { version, restartRequired: false }
}

/** litch/harness/providers/activate */
export async function activateCodexProvider(
  ask: Ask,
  harness: string,
  params: Record<string, unknown>,
): Promise<HarnessProvidersWriteResponse> {
  const id = providerIdOf(params, harness)
  const expected = versionOf(params, harness)
  const snapshot = await readSnapshot(ask, harness)
  const known =
    id === OPENAI ||
    id === 'ollama' ||
    id === 'lmstudio' ||
    customProviders(snapshot).some(([name]) => name === id)
  if (!known) throw notFound(harness, id)
  const forced = snapshot.requirements?.modelProvider
  if (typeof forced === 'string' && forced && forced !== id)
    throw new HarnessConfigError(
      'readOnly',
      harness,
      text(`管理员要求只能用 ${forced}`, `Managed requirements pin the provider to ${forced}`),
      'model_provider',
    )
  if (activeProvider(snapshot) === id && snapshot.user.model_provider === id)
    return { version: snapshot.version, restartRequired: false }
  const { version } = await batchWrite(
    ask,
    harness,
    snapshot,
    [{ keyPath: 'model_provider', value: id, mergeStrategy: 'replace' }],
    expected,
  )
  return { version, restartRequired: false }
}
