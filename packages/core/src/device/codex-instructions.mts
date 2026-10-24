// 直连原生 codex（单 harness 模式，对面不认识 runtime/info）时，开发者指令由核心补齐。经设备服务的由设备进程补
// （packages/device/src/codex-instructions.mts）；为什么要补、怎么拼，见 protocol/src/codex-developer-instructions.mts。
//
// 这条路上没有设备进程替 codex 摘命名空间上的规则：codex 悄悄丢掉，规则从头到尾到不了模型。所以：
//   - thread/start：带规则的命名空间摘下来，拼在 config.toml 实际生效的 developer_instructions（config/read，带 cwd）后面；
//     按会话在这台电脑上记下是哪几个命名空间（只记名字）。
//   - thread/resume、thread/fork：记过的会话，按这一版重新生成那几个命名空间的规则，底子重新问 config.toml，整段带上；
//     分叉出来的用新会话号再记一份。没记过的会话（别处建的，或者没带规则的）不动：它们没有这些工具，不该有这些规则。
// 核心自己不给 developerInstructions；调用方给了的当底子，不问 config.toml。
import {
  bornThread,
  type CodexAsk,
  composeInstructions,
  configuredInstructions,
  instructionSection,
  ruledNamespaces,
  withDeveloperInstructions,
} from '../../../protocol/src/codex-developer-instructions.mjs'
import type { Clock } from '../channel/protocol.mjs'

/** 这台电脑上记的：每个会话带规则的命名空间，和最近一次用到的时间 */
export interface CodexThreadNotes {
  threads: Record<string, { namespaces: string[]; at: number }>
}

/** 存在哪由外壳定。存取失败不影响使用（只记在内存里） */
export interface CodexThreadNotesStore {
  load(): CodexThreadNotes | null
  save(notes: CodexThreadNotes): void
}

/** 一台设备最多记这么多个会话，多了丢最久没用到的 */
export const CODEX_THREAD_NOTES_MAX = 500

/** 检查读回来的那份。读不懂的当作没记过 */
export function checkCodexThreadNotes(value: unknown): CodexThreadNotes | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const raw = (value as Record<string, unknown>).threads
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null
  const threads: CodexThreadNotes['threads'] = {}
  for (const [id, entry] of Object.entries(raw)) {
    if (typeof entry !== 'object' || entry === null) continue
    const { namespaces, at } = entry as Record<string, unknown>
    if (!Array.isArray(namespaces) || typeof at !== 'number') continue
    const names = namespaces.filter((name): name is string => typeof name === 'string' && !!name)
    if (names.length) threads[id] = { namespaces: names, at }
  }
  return { threads }
}

export interface DirectInstructionsOptions {
  clock: Clock
  store?: CodexThreadNotesStore
  /** 向对面的 codex 问一句（config/read） */
  ask: CodexAsk
  /** 这一版这几个命名空间的定义（dynamicTools 的形状），规则从里面取 */
  specs(namespaces: string[]): unknown[]
  /** 会话在哪个目录（侧栏里认得的）。不知道是 null */
  cwdOf(threadId: string): string | null
  log(line: string): void
}

/** 补好的参数，和应答回来之后要做的（记下这个会话） */
export interface PreparedDirect {
  params: Record<string, unknown>
  remember(result: unknown): void
}

export interface DirectInstructions {
  /** thread/start、thread/resume、thread/fork 转发前补齐。别的方法、不用补的是 null，照常转发 */
  prepare(method: string, params: unknown): Promise<PreparedDirect> | null
}

const METHODS = new Set(['thread/start', 'thread/resume', 'thread/fork'])

const textOr = (value: unknown): string | null =>
  typeof value === 'string' && value ? value : null

export function createDirectInstructions(options: DirectInstructionsOptions): DirectInstructions {
  let notes: CodexThreadNotes | null = null
  const loaded = (): CodexThreadNotes => {
    if (notes) return notes
    try {
      notes = options.store?.load() ?? null
    } catch (error) {
      options.log(`读原生 codex 会话的规则记录失败：${String(error)}`)
    }
    notes ??= { threads: {} }
    return notes
  }
  const note = (threadId: string, namespaces: string[]) => {
    const { threads } = loaded()
    threads[threadId] = { namespaces, at: options.clock.now() }
    const ids = Object.keys(threads)
    if (ids.length > CODEX_THREAD_NOTES_MAX) {
      ids.sort((a, b) => (threads[a]?.at ?? 0) - (threads[b]?.at ?? 0))
      for (const id of ids.slice(0, ids.length - CODEX_THREAD_NOTES_MAX)) delete threads[id]
    }
    try {
      options.store?.save(loaded())
    } catch (error) {
      options.log(`存原生 codex 会话的规则记录失败：${String(error)}`)
    }
  }
  const base = async (params: Record<string, unknown>, cwd: string | null) =>
    textOr(params.developerInstructions) ??
    (await configuredInstructions(options.ask, cwd, options.log))

  return {
    prepare(method, given) {
      if (!METHODS.has(method) || typeof given !== 'object' || given === null) return null
      const params = given as Record<string, unknown>
      if (method === 'thread/start') {
        const ruled = ruledNamespaces(params.dynamicTools)
        if (ruled.length === 0) return null
        const sections = ruled.map((one) => instructionSection(one.name, one.instructions))
        const names = ruled.map((one) => one.name)
        return (async () => ({
          params: withDeveloperInstructions(
            params,
            composeInstructions(await base(params, textOr(params.cwd)), sections),
          ),
          remember(result) {
            const born = bornThread(result)
            if (born) note(born.id, names)
          },
        }))()
      }
      const threadId = textOr(params.threadId)
      const names = threadId ? loaded().threads[threadId]?.namespaces : undefined
      if (!threadId || !names) return null
      // 规则按这一版的重拼：工具在建会话时就定了，规则跟着这一版的说明走（下一次压缩起生效）
      const sections = ruledNamespaces(options.specs(names)).map((one) =>
        instructionSection(one.name, one.instructions),
      )
      const cwd = textOr(params.cwd) ?? options.cwdOf(threadId)
      return (async () => ({
        params: withDeveloperInstructions(
          params,
          composeInstructions(await base(params, cwd), sections),
        ),
        remember(result) {
          const born = method === 'thread/fork' ? bornThread(result) : null
          note(born?.id ?? threadId, names)
        },
      }))()
    },
  }
}
