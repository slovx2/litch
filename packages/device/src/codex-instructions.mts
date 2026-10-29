// 原生 codex 的开发者指令：经设备服务的建会话、恢复、分叉之前由设备进程补齐。为什么要补、怎么拼，见
// protocol/src/codex-developer-instructions.mts（直连原生 codex 的由客户端核心补，用的是同一份拼法）。
//
//   - thread/start：底子是客户端给的 developerInstructions；客户端没给时对 codex 调一次 config/read（带 cwd，项目层才算进去），
//     用实际生效的 developer_instructions 当底子，规则拼在后面，免得把用户 config.toml 里那段盖掉。
//   - 按会话记下（sessions.sqlite 的 thread_instructions）：客户端给的那段（没给是 null）、带规则的命名空间、目录。
//     两样都没有的不记：那样的会话 codex 每次装载都重读 config.toml，压缩后放回来的就是它，不会丢。
//     分叉出来的会话用新的会话号再记一份，分叉的分叉也接得上。
//   - thread/resume、thread/fork：客户端没带 developerInstructions 时，底子是记下的客户端那段，没有就重新 config/read；
//     规则按这一版设备进程的重拼（规则改了，下一次压缩起生效）。客户端带了、里面没有规则的，规则拼在后面；
//     带了的记下来，以后恢复照它（没记过的会话也记）。
import {
  SESSION_TOOL,
  SESSION_TOOLS,
  sessionProposalRules,
} from '../../protocol/src/client-tools-sessions.mjs'
import {
  bornThread,
  composeInstructions,
  configuredInstructions,
  instructionSection,
  type RuledNamespace,
  ruledNamespaces,
  withDeveloperInstructions,
} from '../../protocol/src/codex-developer-instructions.mjs'
import type { Ask } from './dialect.mjs'
import { refreshManagerRules } from './manager-rules.mjs'
import { isObject } from './wire.mjs'

/** 一个会话记下的：客户端给的开发者指令（没给是 null）、带规则的命名空间（建会话那时的原文）、目录 */
export interface ThreadInstructions {
  given: string | null
  namespaces: RuledNamespace[]
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

/** 任务卡关着的那份规则的头一句：没记下工具时靠它认 */
const PLAIN_HEAD = `${sessionProposalRules(false, false).split('. ')[0]}.`

/**
 * 设备进程这一版的规则原文：按命名空间，给的是记下的原文和会话建的时候带的动态工具。不在这里的照记下的原文。
 * litch_sessions 分三份：“每回合收尾”开着、关着，和这个 harness 的“任务卡”关着（没有建议的那份）。会话的工具是
 * 建会话时定下的，恢复、分叉时照那时的工具挑这一版的哪一份（有 wrap_up 是收尾那份；start 收不收 propose 看任务卡），
 * 不看现在的开关；没记下工具的（分叉出来的）看原文：任务卡那份的头一句；是建议规则却没提 wrap_up 的是收尾关着那份，
 * 认不出来的按收尾开着
 */
const CURRENT: Record<string, ((recorded: string, tools: unknown[] | null) => string) | undefined> =
  {
    litch_manager: (recorded) => refreshManagerRules('litch_manager', recorded) ?? recorded,
    [SESSION_TOOLS.name]: (recorded, tools) => {
      const manager = refreshManagerRules(SESSION_TOOLS.name, recorded)
      if (manager) return manager
      const spec = tools?.find((one) => isObject(one) && one.name === SESSION_TOOLS.name)
      if (!isObject(spec)) {
        if (recorded.startsWith(PLAIN_HEAD)) return sessionProposalRules(false, false)
        const off = sessionProposalRules(false)
        const unwrapped =
          recorded === off ||
          (recorded.startsWith(off.split('. ')[0] as string) &&
            !recorded.includes(`litch_sessions.${SESSION_TOOL.wrapUp}`))
        return sessionProposalRules(!unwrapped)
      }
      const functions = Array.isArray(spec.tools) ? spec.tools.filter(isObject) : []
      const wrapUp = functions.some((tool) => tool.name === SESSION_TOOL.wrapUp)
      const start = functions.find((tool) => tool.name === SESSION_TOOL.start)
      const schema = isObject(start?.inputSchema) ? start.inputSchema : null
      const properties = isObject(schema?.properties) ? schema.properties : null
      const initiation = isObject(properties?.initiation) ? properties.initiation : null
      const cards = !Array.isArray(initiation?.enum) || initiation.enum.includes('propose')
      return sessionProposalRules(wrapUp, cards)
    },
  }

const METHODS = new Set(['thread/start', 'thread/resume', 'thread/fork'])

const givenOf = (params: Record<string, unknown>): string | null =>
  typeof params.developerInstructions === 'string' ? params.developerInstructions : null

const cwdOf = (value: unknown): string | null => (typeof value === 'string' && value ? value : null)

const configured = (context: InstructionContext, cwd: string | null) =>
  configuredInstructions(context.ask, cwd, context.log)

/**
 * 原生 codex 的 thread/start、thread/resume、thread/fork 转发前补齐 developerInstructions，命名空间上的规则一并摘掉。
 * 别的方法、不需要补的（没有规则、客户端没给、也没记过的）返回 null，照常同步转发。不会失败：问不到 config.toml 时底子当作没有
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
    if (namespaces.length === 0 && given === null) return null
    const sections = namespaces.map((one) => instructionSection(one.name, one.instructions))
    const cwd = cwdOf(params.cwd)
    return (async () => {
      const base = given ?? (await configured(context, cwd))
      return {
        params: withDeveloperInstructions(params, composeInstructions(base, sections)),
        remember(result) {
          const born = bornThread(result)
          if (born)
            context.store.setInstructions(born.id, { given, namespaces, cwd: cwd ?? born.cwd })
        },
      }
    })()
  }
  const threadId = typeof params.threadId === 'string' ? params.threadId : null
  if (!threadId) return null
  const record = recorded(context.store, threadId)
  if (!record) {
    // 没记过、客户端这次带了自己的那段：照转，记下来，以后恢复、分叉没带时照它
    if (given === null) return null
    return Promise.resolve({
      params,
      remember(result) {
        const born = method === 'thread/fork' ? bornThread(result) : null
        if (method === 'thread/resume' || born)
          context.store.setInstructions(born?.id ?? threadId, {
            given,
            namespaces: [],
            cwd: cwdOf(params.cwd) ?? born?.cwd ?? null,
          })
      },
    })
  }
  // 规则按这一版的重拼；这一版不认识的命名空间照记下的原文
  const sections = record.namespaces.map((one) =>
    instructionSection(
      one.name,
      CURRENT[one.name]?.(one.instructions, context.store.tools(threadId)) ?? one.instructions,
    ),
  )
  const cwd = cwdOf(params.cwd) ?? record.cwd
  return (async () => {
    const base = given ?? record.given ?? (await configured(context, cwd))
    return {
      params: withDeveloperInstructions(params, composeInstructions(base, sections)),
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
  if (known) return known.namespaces.length || known.given !== null ? known : null
  const namespaces = ruledNamespaces(store.tools(threadId))
  return namespaces.length ? { given: null, namespaces, cwd: null } : null
}
