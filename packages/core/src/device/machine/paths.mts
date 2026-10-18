// 路径：展开 ~、理成最简、和禁止位置比。
// 只做字面上的运算；符号链接由 scripts.mts 的 probe 在目标机器上解开，这里拿解开之后的真实路径来比。
// macOS 的文件系统默认不分大小写：~/.SSH 就是 ~/.ssh，所以那边一律按不分大小写比。
import { normalizePath } from '../../text/paths.mjs'

/** 把以 ~ 开头的展开成主目录下的，理成最简（`..` 按字面折掉，之后读写用的也是这个样子）。不是绝对路径的是 null */
export function expandPath(path: string, home: string): string | null {
  const trimmed = path.trim()
  let full: string
  if (trimmed === '~') full = home
  else if (trimmed.startsWith('~/')) full = `${home}/${trimmed.slice(2)}`
  else full = trimmed
  if (!full.startsWith('/') || full.includes('\0')) return null
  return normalizePath(full)
}

/** 脚本给回来的真实路径可能带重复的斜杠，理一遍 */
export const cleanReal = (path: string): string => normalizePath(path) || '/'

export const foldCase = (system: string): boolean => /^mac ?os|^darwin/i.test(system)

/** path 是不是 base 本身或者在它里面 */
export function inside(base: string, path: string, icase: boolean): boolean {
  const a = icase ? base.toLowerCase() : base
  const b = icase ? path.toLowerCase() : path
  if (a === '/') return true
  return b === a || b.startsWith(`${a}/`)
}

/** 一条生效的禁止位置：设置里的写法、展开之后的、解开符号链接之后的 */
export interface DeniedRule {
  rule: string
  expanded: string
  real: string
}

/** 落在哪条禁止位置里（展开的写法和真实路径都比）。没有是 null */
export function blockedBy(
  real: string,
  rules: readonly DeniedRule[],
  icase: boolean,
): DeniedRule | null {
  for (const rule of rules) {
    if (inside(rule.real, real, icase) || inside(rule.expanded, real, icase)) return rule
  }
  return null
}

/** 禁止位置展开成绝对路径（展不开的，比如相对路径，直接丢掉：设置那边该拦住它） */
export function expandRules(
  denied: readonly string[],
  home: string,
): { rule: string; expanded: string }[] {
  const out: { rule: string; expanded: string }[] = []
  for (const rule of denied) {
    const expanded = expandPath(rule, home)
    if (expanded && expanded !== '/') out.push({ rule, expanded })
  }
  return out
}

const escapeRegex = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * exec 的命令文字里提到了哪些禁止位置（命令的文字挡不住，只让卡片再弹一次并标红）。
 * 认这几种写法：设置里的原样（~/.ssh）、展开的（/Users/me/.ssh）、解开链接的、$HOME/…、${HOME}/…，
 * 以及工作目录就在它上面时的相对写法（.ssh）。返回设置里的写法
 */
export function flaggedIn(
  command: string,
  cwd: string,
  home: string,
  rules: readonly DeniedRule[],
  icase: boolean,
): string[] {
  const text = icase ? command.toLowerCase() : command
  const out: string[] = []
  for (const rule of rules) {
    const forms = new Set<string>([rule.expanded, rule.real])
    if (inside(home, rule.expanded, false) && rule.expanded !== home) {
      const rest = rule.expanded.slice(home.length + 1)
      forms.add(`~/${rest}`)
      forms.add(`$HOME/${rest}`)
      forms.add(`\${HOME}/${rest}`)
    }
    if (rule.rule.startsWith('~')) forms.add(rule.rule)
    // 相对写法只在前面是空白、引号、等号或者开头时才算，免得 foo.ssh 这种也算进去
    let relative: string | null = null
    if (cwd !== rule.expanded && inside(cwd, rule.expanded, icase)) {
      relative = rule.expanded.slice(cwd === '/' ? 1 : cwd.length + 1)
    }
    let hit = false
    for (const form of forms) {
      if (!form) continue
      const needle = icase ? form.toLowerCase() : form
      // 后面得是路径的边界：结尾、斜杠、空白、引号这些，免得 ~/.sshx 也算
      const pattern = new RegExp(`${escapeRegex(needle)}(?=$|[/\\s'"\`;|&)<>])`)
      if (pattern.test(text)) {
        hit = true
        break
      }
    }
    if (!hit && relative) {
      const needle = icase ? relative.toLowerCase() : relative
      const pattern = new RegExp(
        `(?:^|[\\s'"=\`(])(?:\\./)?${escapeRegex(needle)}(?=$|[/\\s'"\`;|&)<>])`,
      )
      hit = pattern.test(text)
    }
    if (hit && !out.includes(rule.rule)) out.push(rule.rule)
  }
  return out
}

/** 路径的最后一段 */
export const lastPart = (path: string): string => path.slice(path.lastIndexOf('/') + 1)

/** 父目录（根的父目录是根） */
export const parentOf = (path: string): string => {
  const at = path.lastIndexOf('/')
  return at <= 0 ? '/' : path.slice(0, at)
}
