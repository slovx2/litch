// 原生 codex 的开发者指令怎么拼：设备进程（packages/device/src/codex-instructions.mts，经设备服务的）和
// 客户端核心（packages/core/src/device/codex-instructions.mts，直连原生 codex 的）共用这一份。
//
// codex 不保存 developerInstructions（实测 0.160.0、0.163.0，源码 rust-v0.155.1 到 0.163.0 相同）：thread/start、
// thread/resume、thread/fork 带的只是这一次装载的配置覆盖，没带就回落到 config.toml 的 developer_instructions，
// 带了就整段替换它，不是合并。它只在放完整上下文时作为一条开发者消息进历史：会话头一个回合，和每次压缩之后
// （手动、回合前自动、回合中途自动都一样，压缩后的历史里原来那条被丢掉，按当时装载的配置重放）。
// 所以会话从磁盘重新装载过（codex 重启、没人订阅空闲 60 秒被卸载）、恢复或分叉又没带这段，下一次压缩之后就没了。
// 动态工具的命名空间上带的规则（instructions）codex 不认，悄悄丢掉，到不了模型，也要并进这一段。
//
// 补的做法：建会话、恢复、分叉都带上整段（底子在前，规则拼在后面）。每次都带是安全的（实测）：恢复不马上重放，
// 会话还装载着时 codex 忽略这个参数，压缩后只放一次，不叠加。

/** 动态工具里带规则的一个命名空间 */
export interface RuledNamespace {
  name: string
  instructions: string
}

/** 向 codex 问一句 */
export type CodexAsk = (method: string, params: unknown) => Promise<unknown>

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** 一个工具都没有的命名空间（比如只带 instructions 的 litch_presentation）：codex 收到就报错，转发前整个去掉 */
export const isEmptyNamespace = (spec: unknown): boolean =>
  isRecord(spec) &&
  spec.type === 'namespace' &&
  Array.isArray(spec.tools) &&
  spec.tools.length === 0

/** 命名空间的规则拼成的一节。各处都用这一种写法，带回来的能认出是同一段 */
export const instructionSection = (name: string, instructions: string): string =>
  `# Tool instructions: ${name}\n${instructions.trim()}`

/** 动态工具里带规则的命名空间，按先后、同名只取头一个。一个工具都没有的不算 */
export function ruledNamespaces(tools: unknown): RuledNamespace[] {
  if (!Array.isArray(tools)) return []
  const out: RuledNamespace[] = []
  for (const spec of tools) {
    if (!isRecord(spec) || spec.type !== 'namespace' || typeof spec.name !== 'string') continue
    if (isEmptyNamespace(spec)) continue
    const text = typeof spec.instructions === 'string' ? spec.instructions.trim() : ''
    if (text && !out.some((one) => one.name === spec.name))
      out.push({ name: spec.name, instructions: text })
  }
  return out
}

/** 底子在前，规则里底子还没有的拼在后面；没什么要拼的，底子原样。都没有是 null */
export function composeInstructions(base: string | null, sections: string[]): string | null {
  const head = base?.trimEnd() ?? ''
  const missing = sections.filter((section) => !head.includes(section))
  if (missing.length === 0) return head ? base : null
  return [head, ...missing].filter(Boolean).join('\n\n')
}

/** 参数换上开发者指令（null 是不带），动态工具上的规则摘掉 */
export function withDeveloperInstructions(
  params: Record<string, unknown>,
  developerInstructions: string | null,
): Record<string, unknown> {
  const next: Record<string, unknown> = { ...params }
  if (developerInstructions) next.developerInstructions = developerInstructions
  if (Array.isArray(params.dynamicTools))
    next.dynamicTools = params.dynamicTools.map((spec) => {
      if (!isRecord(spec) || !('instructions' in spec)) return spec
      const { instructions: _rules, ...rest } = spec
      return rest
    })
  return next
}

/**
 * codex 在这个目录下实际生效的 developer_instructions（config.toml，带 cwd 项目层才算进去）。
 * 没配是 null；问不到也是 null，记一行日志：这时只放规则
 */
export async function configuredInstructions(
  ask: CodexAsk,
  cwd: string | null,
  log: (line: string) => void,
): Promise<string | null> {
  try {
    const result = await ask('config/read', cwd ? { cwd } : {})
    const config = isRecord(result) && isRecord(result.config) ? result.config : null
    const value = config?.developer_instructions
    return typeof value === 'string' && value.trim() ? value : null
  } catch (error) {
    log(
      `原生 codex 的 config/read 没成，开发者指令只放规则：${error instanceof Error ? error.message : String(error)}`,
    )
    return null
  }
}

/** thread/start、thread/fork 应答里新会话的号和目录 */
export function bornThread(result: unknown): { id: string; cwd: string | null } | null {
  const thread = isRecord(result) && isRecord(result.thread) ? result.thread : null
  if (typeof thread?.id !== 'string') return null
  const cwdOf = (value: unknown) => (typeof value === 'string' && value ? value : null)
  return { id: thread.id, cwd: cwdOf(isRecord(result) ? result.cwd : null) ?? cwdOf(thread.cwd) }
}
