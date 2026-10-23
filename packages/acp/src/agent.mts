// 这个 ACP 引擎扮演哪一个 harness、起哪个命令。
//
// 一个引擎包管三个标识（gemini、qwen、acp），由命令行用 CHA_ACP_AGENT 告诉它这一次是哪一个。
// 命令和参数先看用户给的 CHA_<标识>_CLI、CHA_<标识>_ARGS，
// 没给的用 packages/protocol/src/acp-agents.json 里的预设；acp 这一项没有预设命令，必须由用户给。
// agent 本体不随适配器分发，一律用用户自己装的。
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import presets from '../../protocol/src/acp-agents.json' with { type: 'json' }
import { HARNESS_IDENTITY } from '../../protocol/src/harness-identity.mjs'
import { cliCommand, resolveHostCli } from '../../shared/src/host-cli.mjs'

export type AcpAgentId = keyof typeof presets

/** 认识的三个标识，顺序就是文档里写的顺序 */
export const AGENT_IDS = Object.keys(presets) as AcpAgentId[]

export interface AgentSpec {
  id: AcpAgentId
  displayName: string
  /** 用户写的或预设的命令，还没解析成路径；空串表示没有命令（acp 没配时） */
  command: string
  args: string[]
  /** 命令和参数各是从哪来的，报错时告诉用户该改哪个变量 */
  source: { command: 'env' | 'preset'; args: 'env' | 'preset' }
  /** 适配器给这个 harness 的状态目录（命令行经 CHA_<标识>_HOME 传，不是 agent 自己的数据目录） */
  home: string
}

/** 环境变量的前缀：CHA_GEMINI、CHA_QWEN、CHA_ACP */
export const envPrefix = (id: string): string => `CHA_${id.toUpperCase()}`

/** 当前扮演的标识。没设时按 acp 算；设了不认识的值直接报错，不猜 */
export function agentId(env: NodeJS.ProcessEnv = process.env): AcpAgentId {
  const value = env.CHA_ACP_AGENT?.trim() || 'acp'
  if (!Object.hasOwn(presets, value))
    throw new Error(`CHA_ACP_AGENT 只能是 ${AGENT_IDS.join('、')} 之一，实际是 ${value}`)
  return value as AcpAgentId
}

/**
 * 把一行参数按空白切开，双引号里的空白不切；引号本身去掉，`\"` 是字面的引号。
 * 没配对的引号把后面的都算进同一个参数。单引号不特殊（只约定了双引号）。
 */
export function splitArgs(line: string): string[] {
  const args: string[] = []
  let current = ''
  let started = false
  let quoted = false
  for (let index = 0; index < line.length; index++) {
    const char = line[index] as string
    if (char === '\\' && line[index + 1] === '"') {
      current += '"'
      started = true
      index++
    } else if (char === '"') {
      quoted = !quoted
      started = true
    } else if (!quoted && /\s/.test(char)) {
      if (started) args.push(current)
      current = ''
      started = false
    } else {
      current += char
      started = true
    }
  }
  if (started) args.push(current)
  return args
}

export function agentSpec(env: NodeJS.ProcessEnv = process.env): AgentSpec {
  const id = agentId(env)
  const prefix = envPrefix(id)
  const preset = presets[id]
  const cli = env[`${prefix}_CLI`]?.trim()
  const args = env[`${prefix}_ARGS`]
  return {
    id,
    displayName: HARNESS_IDENTITY[id].displayName,
    command: cli || preset.command,
    // 设了 CHA_<标识>_ARGS 就整个用它（设成空串就是不带参数），没设才用预设
    args: args === undefined ? [...preset.args] : splitArgs(args),
    source: { command: cli ? 'env' : 'preset', args: args === undefined ? 'preset' : 'env' },
    home: resolve(env[`${prefix}_HOME`] ?? join(homedir(), '.codex-harness-adapter', id)),
  }
}

/** 解析好的、可以直接起的命令：argv[0] 是可执行文件（脚本由当前的 node 来跑） */
export interface ResolvedAgent {
  spec: AgentSpec
  /** 解析出来的可执行文件 */
  cli: string
  argv: string[]
}

/**
 * 找到用户装的 agent。找不到、不可执行时报“CLI 不可执行或未找到”：命令行的诊断按这几个字认成“没装”
 *（cmd/codex-harness-adapter/diagnostics.go），改这句话要两边一起改。
 */
export function resolveAgent(env: NodeJS.ProcessEnv = process.env): ResolvedAgent {
  const spec = agentSpec(env)
  const variable = `${envPrefix(spec.id)}_CLI`
  if (!spec.command)
    throw new Error(
      `${spec.displayName} 的 CLI 不可执行或未找到：没有配置命令；请在设置里填命令行路径，或配置 ${variable}`,
    )
  let cli: string
  try {
    cli = resolveHostCli(spec.command, spec.command, '', env)
  } catch {
    throw new Error(
      `${spec.displayName} 的 CLI 不可执行或未找到: ${spec.command}；请先安装，或配置 ${variable} 或当前用户 PATH`,
    )
  }
  return { spec, cli, argv: cliCommand(cli, spec.args) }
}

/** 注入后台 shell 的 agent：只有通用入口 acp。gemini、qwen 自己有后台命令（用户定：不带） */
export const BACKGROUND_SHELL_AGENTS: ReadonlySet<AcpAgentId> = new Set(['acp'])
