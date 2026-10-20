// 原生 codex 的开发者指令：建会话、恢复、分叉之前由设备进程补齐。
//
// codex 不保存 developerInstructions（实测 0.160.0，源码 rust-v0.155.1 到 0.162 相同）：它只在会话头一次放完整上下文时
// 作为一条开发者消息写进历史，之后只在压缩后重建上下文时按“这一次装载的配置”再放一次。会话从磁盘重新装载过
// （codex 重启、没人订阅空闲 60 秒被卸载），恢复、分叉又没带这段，下一次压缩之后就没了：命名空间的规则
// （比如 litch_sessions 的建议任务规则，dialect.mts 的 foldToolInstructions 折进来的）跟着没了。
// 另外，带了 developerInstructions 就整段替换 config.toml 的 developer_instructions，不是合并。
//
// 所以：
//   - thread/start：底子是客户端给的 developerInstructions；客户端没给时对 codex 调一次 config/read（带 cwd，项目层才算进去），
//     用实际生效的 developer_instructions 当底子，规则拼在后面，免得把用户 config.toml 里那段盖掉。
//   - 按会话记下（sessions.sqlite 的 thread_instructions）：客户端给的那段（没给是 null）、带规则的命名空间、目录。
//     分叉出来的会话用新的会话号再记一份，分叉的分叉也接得上。
//   - thread/resume、thread/fork：客户端没带 developerInstructions 时，底子是记下的客户端那段，没有就重新 config/read；
//     规则按这一版设备进程的重拼（规则改了，下一次压缩起生效）。客户端带了、里面没有规则的，规则拼在后面。
// 每次恢复、分叉都带上整段是安全的（实测）：恢复不马上重放；会话还装载着时 codex 忽略这个参数；压缩后只放一次，不叠加。
// 只管经设备服务的原生 codex：直连 codex 的用法没有设备进程替它记。
import { SESSION_TOOLS } from '../../protocol/src/client-tools-sessions.mjs'
import { type Ask, isEmptyNamespace } from './dialect.mjs'
import { isObject } from './wire.mjs'

/** 一个会话记下的：客户端给的开发者指令（没给是 null）、带规则的命名空间（建会话那时的原文）、目录 */
export interface ThreadInstructions {
  given: string | null
  namespaces: { name: string; instructions: string }[]
  cwd: string | null
}

export interface InstructionStore {
  instructions(threadId: string): ThreadInstructions | null
  setInstructions(threadId: string, record: ThreadInstructions): void
  /** 会话建的时候带的动态工具（更早的设备进程只记了这个） */
  tools(threadId: string): unknown[] | null
}

export interface InstructionContext {
  /** 向这个 codex 问一句 */
  ask: Ask
  store: InstructionStore
  log(line: string): void
}

/** 补好的参数，和应答回来之后要做的（记下这个会话） */
export interface PreparedInstructions {
  params: Record<string, unknown>
  remember(result: unknown): void
}

/** 设备进程这一版的规则原文：按命名空间。不在这里的照记下的原文 */
const CURRENT: Record<string, string | undefined> = {
  [SESSION_TOOLS.name]: SESSION_TOOLS.instructions,
}

const METHODS = new Set(['thread/start', 'thread/resume', 'thread/fork'])

/** 命名空间的规则拼成的一节（和 foldToolInstructions 一样的写法，客户端带回来的能认出是同一段） */
export const instructionSection = (name: string, instructions: string): string =>
  `# Tool instructions: ${name}\n${instructions.trim()}`

/** 动态工具里带规则的命名空间。一个工具都没有的不算：转发前整个去掉（dialect.mts 的 withoutEmptyNamespaces） */
function ruledNamespaces(tools: unknown): ThreadInstructions['namespaces'] {
  if (!Array.isArray(tools)) return []
  const out: ThreadInstructions['namespaces'] = []
  for (const spec of tools) {
    if (!isObject(spec) || spec.type !== 'namespace' || typeof spec.name !== 'string') continue
    if (isEmptyNamespace(spec)) continue
    const text = typeof spec.instructions === 'string' ? spec.instructions.trim() : ''
    if (text && !out.some((one) => one.name === spec.name))
      out.push({ name: spec.name, instructions: text })
  }
  return out
}

/** 底子在前，规则里底子还没有的拼在后面。都没有是 null */
export function composeInstructions(base: string | null, sections: string[]): string | null {
  const head = base?.trimEnd() ?? ''
  const missing = sections.filter((section) => !head.includes(section))
  const joined = [head, ...missing].filter(Boolean).join('\n\n')
  return joined || null
}

const givenOf = (params: Record<string, unknown>): string | null =>
  typeof params.developerInstructions === 'string' ? params.developerInstructions : null

const cwdOf = (value: unknown): string | null => (typeof value === 'string' && value ? value : null)

/** codex 在这个目录下实际生效的 developer_instructions（config.toml，含项目层）。问不到、没配是 null */
async function configured(context: InstructionContext, cwd: string | null): Promise<string | null> {
  try {
    const result = await context.ask('config/read', cwd ? { cwd } : {})
    const config = isObject(result) && isObject(result.config) ? result.config : null
    const value = config?.developer_instructions
    return typeof value === 'string' && value.trim() ? value : null
  } catch (error) {
    context.log(
      `原生 codex 的 config/read 没成，开发者指令只放规则：${error instanceof Error ? error.message : String(error)}`,
    )
    return null
  }
}

/** 应答里的新会话号和目录 */
function bornThread(result: unknown): { id: string; cwd: string | null } | null {
  const thread = isObject(result) && isObject(result.thread) ? result.thread : null
  if (typeof thread?.id !== 'string') return null
  return { id: thread.id, cwd: cwdOf(isObject(result) ? result.cwd : null) ?? cwdOf(thread.cwd) }
}

/**
 * 原生 codex 的 thread/start、thread/resume、thread/fork 转发前补齐 developerInstructions，命名空间上的规则一并摘掉。
 * 别的方法、不需要补的（没有规则）返回 null，照常同步转发。不会失败：问不到 config.toml 时底子当作没有
 */
export function prepareInstructions(
  method: string,
  params: Record<string, unknown>,
  context: InstructionContext,
): Promise<PreparedInstructions> | null {
  if (!METHODS.has(method)) return null
  const given = givenOf(params)
  if (method === 'thread/start') {
    const namespaces = ruledNamespaces(params.dynamicTools)
    if (namespaces.length === 0) return null
    const sections = namespaces.map((one) => instructionSection(one.name, one.instructions))
    return (async () => {
      const base = given ?? (await configured(context, cwdOf(params.cwd)))
      return {
        params: withInstructions(params, composeInstructions(base, sections)),
        remember(result) {
          const born = bornThread(result)
          if (born)
            context.store.setInstructions(born.id, {
              given,
              namespaces,
              cwd: cwdOf(params.cwd) ?? born.cwd,
            })
        },
      }
    })()
  }
  const threadId = typeof params.threadId === 'string' ? params.threadId : null
  if (!threadId) return null
  const record = recorded(context.store, threadId)
  if (!record) return null
  // 规则按这一版的重拼；这一版不认识的命名空间照记下的原文
  const sections = record.namespaces.map((one) =>
    instructionSection(one.name, CURRENT[one.name] ?? one.instructions),
  )
  const cwd = cwdOf(params.cwd) ?? record.cwd
  return (async () => {
    const base = given ?? record.given ?? (await configured(context, cwd))
    return {
      params: withInstructions(params, composeInstructions(base, sections)),
      remember(result) {
        if (method === 'thread/resume') {
          // 客户端这次带了自己的那段：以后恢复照它
          if (given !== null && given !== record.given)
            context.store.setInstructions(threadId, { ...record, given })
          return
        }
        const born = bornThread(result)
        if (born)
          context.store.setInstructions(born.id, {
            given: given ?? record.given,
            namespaces: record.namespaces,
            cwd: cwdOf(params.cwd) ?? born.cwd ?? record.cwd,
          })
      },
    }
  })()
}

/** 记下的；更早的设备进程只记了动态工具的，从那里认出带规则的命名空间（客户端那段当作没给） */
function recorded(store: InstructionStore, threadId: string): ThreadInstructions | null {
  const known = store.instructions(threadId)
  if (known) return known.namespaces.length ? known : null
  const namespaces = ruledNamespaces(store.tools(threadId))
  return namespaces.length ? { given: null, namespaces, cwd: null } : null
}

/** 参数换上开发者指令，动态工具上的规则摘掉（codex 不认，悄悄丢掉也到不了模型） */
function withInstructions(
  params: Record<string, unknown>,
  developerInstructions: string | null,
): Record<string, unknown> {
  const next: Record<string, unknown> = { ...params }
  if (developerInstructions) next.developerInstructions = developerInstructions
  if (Array.isArray(params.dynamicTools))
    next.dynamicTools = params.dynamicTools.map((spec) => {
      if (!isObject(spec) || !('instructions' in spec)) return spec
      const { instructions: _rules, ...rest } = spec
      return rest
    })
  return next
}
