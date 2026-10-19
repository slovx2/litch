// litch config 的参数怎么拆：`<组> <动作> [位置参数] [--键 值|--键=值|--开关]`。
// 命令行（适配器的 config 子命令）只把参数原样交过来，怎么认全在这里，加操作不用改 Go。
// 哪些选项带值、哪些是开关、要几个位置参数由每个操作自己说（ArgSpec），拆的时候照它来，认不出的当场报出来。
import { CONFIG_OPS } from '../../../protocol/src/config-ops.mjs'

/** 一个操作要的参数 */
export interface ArgSpec {
  /** 位置参数最少、最多几个 */
  args: readonly [number, number]
  /** 带值的选项（不带前面的 --） */
  options?: readonly string[]
  /** 不带值的开关 */
  flags?: readonly string[]
}

export interface ParsedCommand {
  group: string
  /** 整组只有一个动作的是空串 */
  action: string
  positionals: string[]
  options: Map<string, string>
  flags: Set<string>
}

/** 拆不出来的原因，执行器按语言说 */
export type ArgProblem =
  | { kind: 'empty' }
  | { kind: 'group'; group: string }
  | { kind: 'action'; group: string; action: string | null }
  | { kind: 'option'; name: string; known: string[] }
  | { kind: 'value'; name: string }
  | { kind: 'count'; min: number; max: number; got: number }

/** 第一遍：认出组和动作，剩下的词原样留着；要帮助的另说 */
export type Head =
  | { kind: 'help'; group: string | null }
  | { kind: 'op'; group: string; action: string; rest: string[] }
  | { kind: 'problem'; problem: ArgProblem }

const GLOBAL_FLAGS = new Set(['--json'])
const isHelp = (word: string) => word === '--help' || word === '-h'

/** 这个组有哪些动作（只有一个空动作的组返回 ['']） */
export const actionsOf = (group: string): string[] =>
  CONFIG_OPS.filter((op) => op.group === group).map((op) => op.action)

export const groups = (): string[] => [...new Set(CONFIG_OPS.map((op) => op.group))]

export function parseHead(argv: readonly string[]): Head {
  // 命令行自己会拿掉 --json；万一还在里面，这里也不当成参数
  const words = argv.filter((word) => !GLOBAL_FLAGS.has(word))
  const [group, ...rest] = words
  if (group === undefined) return { kind: 'help', group: null }
  if (isHelp(group)) return { kind: 'help', group: null }
  if (group === 'help') {
    const asked = rest[0]
    if (asked === undefined) return { kind: 'help', group: null }
    return groups().includes(asked)
      ? { kind: 'help', group: asked }
      : { kind: 'problem', problem: { kind: 'group', group: asked } }
  }
  const actions = actionsOf(group)
  if (actions.length === 0) return { kind: 'problem', problem: { kind: 'group', group } }
  if (rest.some(isHelp)) return { kind: 'help', group }
  // 整组只有一个动作（status、open）：后面的词都是参数
  if (actions.length === 1 && actions[0] === '') return { kind: 'op', group, action: '', rest }
  const [action, ...tail] = rest
  if (action === undefined || !actions.includes(action)) {
    return { kind: 'problem', problem: { kind: 'action', group, action: action ?? null } }
  }
  return { kind: 'op', group, action, rest: tail }
}

/** 第二遍：按这个操作要的参数拆剩下的词 */
export function parseRest(
  head: { group: string; action: string; rest: readonly string[] },
  spec: ArgSpec,
): { ok: true; command: ParsedCommand } | { ok: false; problem: ArgProblem } {
  const options = new Map<string, string>()
  const flags = new Set<string>()
  const positionals: string[] = []
  const valued = new Set(spec.options ?? [])
  const switches = new Set(spec.flags ?? [])
  const known = [...valued, ...switches].map((name) => `--${name}`)
  const words = head.rest.filter((word) => !GLOBAL_FLAGS.has(word))
  for (let at = 0; at < words.length; at++) {
    const word = words[at] as string
    // 单独一个 -- 之后都是位置参数（名字以减号开头的时候用）
    if (word === '--') {
      positionals.push(...words.slice(at + 1))
      break
    }
    if (!word.startsWith('--') || word.length === 2) {
      positionals.push(word)
      continue
    }
    const eq = word.indexOf('=')
    const name = eq === -1 ? word.slice(2) : word.slice(2, eq)
    if (switches.has(name)) {
      if (eq !== -1) return { ok: false, problem: { kind: 'value', name } }
      flags.add(name)
      continue
    }
    if (!valued.has(name)) return { ok: false, problem: { kind: 'option', name, known } }
    if (eq !== -1) {
      options.set(name, word.slice(eq + 1))
      continue
    }
    const value = words[at + 1]
    if (value === undefined) return { ok: false, problem: { kind: 'value', name } }
    options.set(name, value)
    at++
  }
  const [min, max] = spec.args
  if (positionals.length < min || positionals.length > max) {
    return { ok: false, problem: { kind: 'count', min, max, got: positionals.length } }
  }
  return {
    ok: true,
    command: { group: head.group, action: head.action, positionals, options, flags },
  }
}

/** on/off 一类的开关值。认不出是 null */
export function parseSwitch(value: string | undefined): boolean | null {
  if (value === undefined) return null
  const word = value.trim().toLowerCase()
  if (['on', 'true', 'yes', '1', 'enable', 'enabled'].includes(word)) return true
  if (['off', 'false', 'no', '0', 'disable', 'disabled'].includes(word)) return false
  return null
}

/**
 * 把一行命令拆成词（模拟核心里“配置：…”那一句用；真的命令行由 shell 拆好了再交来）。
 * 认单引号、双引号和反斜杠转义，别的照空白切
 */
export function splitWords(line: string): string[] {
  const words: string[] = []
  let current = ''
  let quote: '"' | "'" | null = null
  let started = false
  for (let at = 0; at < line.length; at++) {
    const char = line[at] as string
    if (quote) {
      if (char === quote) quote = null
      else if (char === '\\' && quote === '"' && at + 1 < line.length) current += line[++at]
      else current += char
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      started = true
    } else if (char === '\\' && at + 1 < line.length) {
      current += line[++at]
      started = true
    } else if (/\s/.test(char)) {
      if (started) words.push(current)
      current = ''
      started = false
    } else {
      current += char
      started = true
    }
  }
  if (started) words.push(current)
  return words
}
