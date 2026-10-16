// MCP 服务经引擎转过来的征询（mcpServer/elicitation/request）→ 界面看到的请求。
// 三种情况：一次工具调用的审批（原生 codex 用征询的形式问，靠 _meta 里的标记认出来）、
// 一张要填的表、一个要去网页上办的事。表里只认 MCP 规定的几种简单栏目，认不全就整张不接。
import type {
  McpServerElicitationRequestParams,
  McpServerElicitationRequestResponse,
} from '../../../protocol/src/index.mjs'
import type { ApprovalOption, FormField, FormLimits } from '../model.mjs'
import type { PendingRequest, RequestChoice } from './requests.mjs'

type Json = Record<string, unknown>

const objectOf = (value: unknown): Json | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Json) : null
const textOf = (value: unknown): string => (typeof value === 'string' ? value : '')

const reply = (
  action: McpServerElicitationRequestResponse['action'],
  content: McpServerElicitationRequestResponse['content'] = null,
  meta: McpServerElicitationRequestResponse['_meta'] = null,
): McpServerElicitationRequestResponse => ({ action, content, _meta: meta })

/** 拒绝和取消对三种情况都一样 */
const refusal = (choice: RequestChoice): McpServerElicitationRequestResponse | null =>
  choice.optionId === 'decline' || choice.optionId === 'cancel' ? reply(choice.optionId) : null

/** 一栏能选的东西：enum（可带 enumNames），或者一组带 const 的备选 */
function optionsOf(schema: Json): FormField['options'] {
  if (Array.isArray(schema.enum)) {
    const names = Array.isArray(schema.enumNames) ? schema.enumNames : []
    return schema.enum
      .filter((value): value is string => typeof value === 'string')
      .map((value, index) => ({ value, label: textOf(names[index]) || value }))
  }
  const alternatives = schema.oneOf ?? schema.anyOf
  if (!Array.isArray(alternatives)) return []
  const options: FormField['options'] = []
  for (const entry of alternatives) {
    const choice = objectOf(entry)
    if (typeof choice?.const !== 'string') return []
    options.push({ value: choice.const, label: textOf(choice.title) || choice.const })
  }
  return options
}

const FORMATS = new Set(['email', 'uri', 'date', 'date-time'])

const NO_LIMITS: FormLimits = { min: null, max: null, minLength: null, maxLength: null }
const numberOf = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null
/** 长度的上下限：不是非负整数的当没定 */
const lengthOf = (value: unknown): number | null =>
  typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : null

function fieldOf(id: string, raw: unknown, required: boolean): FormField | null {
  const schema = objectOf(raw)
  if (!schema) return null
  const base = {
    id,
    label: textOf(schema.title) || id,
    note: textOf(schema.description),
    required,
    format: null,
    options: [],
    initial: null,
    limits: NO_LIMITS,
  } satisfies Partial<FormField>
  if (schema.type === 'array') {
    const options = optionsOf(objectOf(schema.items) ?? {})
    if (options.length === 0) return null
    const picked = Array.isArray(schema.default) ? schema.default : []
    return {
      ...base,
      kind: 'choices',
      options,
      initial: picked.filter((value): value is string => typeof value === 'string'),
    }
  }
  const options = optionsOf(schema)
  if (options.length > 0) {
    return { ...base, kind: 'choice', options, initial: textOf(schema.default) || null }
  }
  switch (schema.type) {
    case 'string':
      return {
        ...base,
        kind: 'text',
        format: FORMATS.has(textOf(schema.format)) ? (schema.format as FormField['format']) : null,
        initial: textOf(schema.default) || null,
        limits: {
          ...NO_LIMITS,
          minLength: lengthOf(schema.minLength),
          maxLength: lengthOf(schema.maxLength),
        },
      }
    case 'number':
    case 'integer':
      return {
        ...base,
        kind: schema.type,
        initial: typeof schema.default === 'number' ? schema.default : null,
        limits: { ...NO_LIMITS, min: numberOf(schema.minimum), max: numberOf(schema.maximum) },
      }
    case 'boolean':
      return { ...base, kind: 'boolean', initial: schema.default === true }
    default:
      return null
  }
}

const outside = (value: number, least: number | null, most: number | null): boolean =>
  (least !== null && value < least) || (most !== null && value > most)

/** 界面填的值对不对得上这一栏。对得上返回要发的值，没填返回 undefined，不对返回 null */
function checkedValue(field: FormField, value: unknown): unknown | null | undefined {
  const allowed = (entry: unknown) => field.options.some((option) => option.value === entry)
  switch (field.kind) {
    case 'boolean':
      return typeof value === 'boolean' ? value : field.required ? null : undefined
    case 'choices':
      if (!Array.isArray(value) || value.length === 0) return field.required ? null : undefined
      return value.every(allowed) ? value : null
    case 'choice':
      if (value === undefined || value === null || value === '')
        return field.required ? null : undefined
      return allowed(value) ? value : null
    case 'text':
      if (value === undefined || value === null || value === '')
        return field.required ? null : undefined
      if (typeof value !== 'string') return null
      // 长度按字数算（和 JSON Schema 一样数码点），不按 UTF-16 的单元数
      return outside([...value].length, field.limits.minLength, field.limits.maxLength)
        ? null
        : value
    default: {
      if (value === undefined || value === null || value === '')
        return field.required ? null : undefined
      if (typeof value !== 'number' || !Number.isFinite(value)) return null
      if (field.kind === 'integer' && !Number.isInteger(value)) return null
      return outside(value, field.limits.min, field.limits.max) ? null : value
    }
  }
}

/** 原生 codex 问“要不要让这个 MCP 工具跑”时在 _meta 里带的标记 */
const APPROVAL_KIND = 'codex_approval_kind'

type Persisting = ApprovalOption & { persist?: 'session' | 'always' }

/** 一次 MCP 工具调用的审批：能不能“这个会话里都允许”“以后都允许”，看请求里声明了哪些 */
function toolApproval(
  params: McpServerElicitationRequestParams & { message: string },
  meta: Json,
  id: string,
): PendingRequest {
  const offered = Array.isArray(meta.persist) ? meta.persist : [meta.persist]
  const options: Persisting[] = [
    { id: 'accept', role: 'accept' },
    ...(offered.includes('session')
      ? [{ id: 'acceptSession', role: 'acceptSession', persist: 'session' } satisfies Persisting]
      : []),
    ...(offered.includes('always')
      ? [{ id: 'acceptAlways', role: 'acceptAlways', persist: 'always' } satisfies Persisting]
      : []),
    { id: 'decline', role: 'decline' },
    { id: 'cancel', role: 'cancel' },
  ]
  return {
    threadId: params.threadId,
    turnId: params.turnId,
    itemId: null,
    view: {
      id,
      kind: 'approval',
      subject: 'tool',
      itemId: null,
      command: null,
      cwd: null,
      reason: params.message || null,
      permissions: null,
      tool: {
        server: params.serverName,
        title: textOf(meta.tool_title) || null,
        note: textOf(meta.tool_description) || null,
        params: meta.tool_params === undefined ? null : JSON.stringify(meta.tool_params, null, 2),
      },
      options: options.map(({ id: optionId, role }) => ({ id: optionId, role })),
    },
    answer(choice) {
      const refused = refusal(choice)
      if (refused) return refused
      const option = options.find((entry) => entry.id === choice.optionId)
      if (!option) return null
      // 记不记住这次的决定放在 _meta 里带回去
      return reply('accept', {}, option.persist ? { persist: option.persist } : null)
    },
  }
}

/**
 * 只有普通的网页地址才给打开：别的协议、主机名前带着用户名密码的都不给。
 * 核心不依赖运行环境里的 URL 解析，这里按最保守的写法认：认不准的一律不给打开。
 */
const openable = (url: string): boolean => /^https?:\/\/[^\s/?#@\\]+(?:[/?#]\S*)?$/i.test(url)

/** 认不出的征询返回 null，调用方据此回“方法不存在” */
export function projectElicitation(
  params: McpServerElicitationRequestParams,
  id: string,
): PendingRequest | null {
  const base = { threadId: params.threadId, turnId: params.turnId, itemId: null }
  const form = { id, kind: 'form', itemId: null, server: params.serverName } as const
  if (params.mode === 'url') {
    return {
      ...base,
      view: {
        ...form,
        message: params.message,
        fields: [],
        link: { url: params.url, openable: openable(params.url) },
      },
      // “办好了”只是告诉对面用户说办完了，真办没办成由那个网页自己告诉服务
      answer: (choice) =>
        refusal(choice) ?? (choice.optionId === 'accept' ? reply('accept') : null),
    }
  }
  if (params.mode !== 'form') return null
  const meta = objectOf(params._meta) ?? {}
  if (meta[APPROVAL_KIND] === 'mcp_tool_call') return toolApproval(params, meta, id)
  // 别的带特权标记的征询（登录、推荐工具）不是普通的表，不当成表来填
  if (meta[APPROVAL_KIND] !== undefined) return null

  const schema = objectOf(params.requestedSchema)
  const required = Array.isArray(schema?.required) ? schema.required : []
  const fields: FormField[] = []
  for (const [name, raw] of Object.entries(objectOf(schema?.properties) ?? {})) {
    const field = fieldOf(name, raw, required.includes(name))
    if (!field) return null
    fields.push(field)
  }
  return {
    ...base,
    view: { ...form, message: params.message, fields, link: null },
    answer(choice) {
      const refused = refusal(choice)
      if (refused) return refused
      if (choice.optionId !== 'accept') return null
      const content: Record<string, unknown> = {}
      for (const field of fields) {
        const value = checkedValue(field, choice.values?.[field.id])
        if (value === null) return null
        if (value !== undefined) content[field.id] = value
      }
      return reply('accept', content as McpServerElicitationRequestResponse['content'])
    },
  }
}
