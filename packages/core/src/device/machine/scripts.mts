// 执行器在目标机器上跑的几段小脚本（POSIX sh，macOS 和 Linux 都能跑）。
// 协议的 fs/* 不够用：读文件只能整个读、元数据里没有大小、没有“解开符号链接之后的真实路径”、写文件不能接在后面，
// 所以这几样借 process/spawn 跑脚本来做。参数一律经位置参数交给脚本（sh -c 脚本 litch 参数…），
// 脚本里不拼任何外面来的字。Windows 的机器（第二期以后）不在这里。
import { decodeUtf8 } from '../../text/bytes.mjs'
import type { Runner } from './runner.mjs'
import type { MachineTarget } from './types.mjs'

/** 解真实路径：不存在的部分去掉，解开最近存在的祖先（连同中间和末尾的符号链接），再把去掉的接回去 */
const REAL = `real() {
  p=$1; rest=; n=0
  while :; do
    while [ ! -e "$p" ] && [ ! -L "$p" ]; do
      [ "$p" = / ] && break
      rest=/\${p##*/}$rest
      p=\${p%/*}
      [ -n "$p" ] || p=/
    done
    if [ -L "$p" ] && [ "$n" -lt 40 ]; then
      n=$((n+1))
      t=$(readlink "$p") || break
      case $t in /*) ;; *) d=\${p%/*}; t=$d/$t;; esac
      p=$t$rest
      rest=
      continue
    fi
    break
  done
  if [ -d "$p" ]; then r=$(cd -P "$p" 2>/dev/null && pwd -P) || r=$p
  else d=\${p%/*}; r=$(cd -P "\${d:-/}" 2>/dev/null && pwd -P) && r=$r/\${p##*/} || r=$p; fi
  printf '%s%s\\000' "$r" "$rest"
}`

/**
 * 看一个路径：真实路径、种类（d 目录、f 普通文件、o 别的、l 断了的链接、m 不存在）、大小（读不了是 -）；
 * 后面的参数各解一个真实路径（禁止位置）。输出各项以 NUL 结尾。
 * sh 的函数里没有局部变量：real 会改掉 p、d、t 这些，所以要看的路径放在 real 不碰的 x 里
 */
const PROBE = `CDPATH=
${REAL}
x=$1; shift
real "$x"
if [ -d "$x" ]; then t=d; s=0
elif [ -f "$x" ]; then t=f; s=-; if [ -r "$x" ] && v=$(wc -c < "$x" 2>/dev/null); then s=$v; fi
elif [ -e "$x" ]; then t=o; s=0
elif [ -L "$x" ]; then t=l; s=0
else t=m; s=0; fi
printf '%s\\000%s\\000' "$t" $s
for d do real "$d"; done`

/**
 * 列目录：根（真实路径）、深度（空的是不限）、是否不分大小写（1/0），后面是不往下走的路径（禁止位置，已转义成 find 的模式）。
 * 每条：种类、大小、修改时间（秒）、链接指向、路径，以制表符分开；GNU 的以 NUL 结尾，BSD（macOS）的以 0x1e 结尾
 */
const LIST = `root=$1; depth=$2; icase=$3; shift 3
n=$#
if [ "$icase" = 1 ]; then m=-ipath; else m=-path; fi
for d do set -- "$@" "$m" "$d" -o; done
shift $n
set -- "$@" -false
if [ -n "$depth" ]; then lim="-maxdepth $depth"; else lim=; fi
if find / -maxdepth 0 -printf '' >/dev/null 2>&1; then
  f='%y\\t%s\\t%T@\\t%l\\t%p\\0'
  find "$root" -mindepth 1 $lim \\( "$@" \\) -prune -printf "$f" -o -printf "$f"
else
  f=$(printf '%%HT\\t%%z\\t%%m\\t%%Y\\t%%N\\036')
  find "$root" -mindepth 1 $lim \\( "$@" \\) -prune -exec stat -n -f "$f" {} + -o -exec stat -n -f "$f" {} +
fi`

/** 从第几个字节（从 1 起）读多少字节 */
const READ_RANGE = `tail -c "+$2" "$1" | head -c "$3"`
/** 标准输入写进文件：覆盖、接在后面 */
const WRITE = `cat > "$1"`
const APPEND = `cat >> "$1"`
/** 给一个进程组发信号 */
const SIGNAL = `kill -s "$1" -- "-$2"`

/**
 * exec 的外壳：先在标准错误上报自己的进程号（对面把它起成新的进程组，组号就是它），再换成用户的登录 shell 执行命令。
 * 发 SIGINT 这类信号要用组号（协议的 process/kill 只会 SIGKILL）
 */
export const PID_MARK = '\u001elitch-pid '
export const execCommand = (shell: string, command: string): string[] => [
  '/bin/sh',
  '-c',
  `printf '\\036litch-pid %s\\n' "$$" >&2; exec "$0" -lc "$1"`,
  shell || '/bin/sh',
  command,
]

const sh = (script: string, args: readonly string[]) => ['/bin/sh', '-c', script, 'litch', ...args]

export const scriptCommand = {
  probe: (path: string, denied: readonly string[]) => sh(PROBE, [path, ...denied]),
  list: (root: string, depth: number | null, icase: boolean, prune: readonly string[]) =>
    sh(LIST, [root, depth == null ? '' : String(depth), icase ? '1' : '0', ...prune]),
  readRange: (path: string, offset: number, length: number) =>
    sh(READ_RANGE, [path, String(offset + 1), String(length)]),
  write: (path: string) => sh(WRITE, [path]),
  append: (path: string) => sh(APPEND, [path]),
  signal: (signal: string, pid: number) => sh(SIGNAL, [signal.replace(/^SIG/, ''), String(pid)]),
}

/** 脚本跑出来的结果有问题：说明给模型看 */
export class ScriptError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ScriptError'
  }
}

const SCRIPT_TIMEOUT_MS = 60_000

/** 跑一段脚本，攒下标准输出。退出码不是 0 就抛 ScriptError，带上标准错误 */
export async function runScript(
  runner: Runner,
  target: MachineTarget,
  command: readonly string[],
  options: { collect: number; timeoutMs?: number; stdin?: Uint8Array; allowFail?: boolean },
): Promise<{ stdout: Uint8Array; overflow: boolean; exitCode: number; stderr: string }> {
  const running = await runner.run(target, command, {
    cwd: '/',
    stdin: options.stdin !== undefined,
    timeoutMs: options.timeoutMs ?? SCRIPT_TIMEOUT_MS,
    collect: options.collect,
  })
  if (options.stdin !== undefined) {
    try {
      await running.write(options.stdin, true)
    } catch {
      // 进程已经结束了：结果里会说
    }
  }
  const exit = await running.done
  const stderr = decodeUtf8(exit.stderr)
  if (exit.kind === 'lost') throw new ScriptError('the machine stopped answering')
  if (exit.kind === 'exited' && exit.exitCode !== 0 && !exit.overflow && !options.allowFail)
    throw new ScriptError(stderr.trim() || `exit code ${exit.exitCode}`)
  return { stdout: exit.stdout, overflow: exit.overflow, exitCode: exit.exitCode, stderr }
}

/** 按某个字节切开（最后一段没有结尾的不要） */
export function splitBytes(bytes: Uint8Array, separators: readonly number[]): Uint8Array[] {
  const out: Uint8Array[] = []
  let start = 0
  for (let at = 0; at < bytes.length; at++) {
    if (separators.includes(bytes[at] ?? -1)) {
      out.push(bytes.subarray(start, at))
      start = at + 1
    }
  }
  return out
}

export interface ProbeResult {
  real: string
  type: 'd' | 'f' | 'o' | 'l' | 'm'
  /** 普通文件的大小，读不了是 null */
  size: number | null
  /** 各个禁止位置的真实路径，和给的顺序一样 */
  denied: string[]
}

export function parseProbe(fields: string[], deniedCount: number): ProbeResult {
  const [real, type, size, ...denied] = fields
  if (real === undefined || type === undefined || size === undefined || denied.length < deniedCount)
    throw new ScriptError('unexpected answer from the machine')
  if (!['d', 'f', 'o', 'l', 'm'].includes(type)) throw new ScriptError('unexpected answer')
  return {
    real,
    type: type as ProbeResult['type'],
    size: size === '-' ? null : Number.parseInt(size, 10),
    denied: denied.slice(0, deniedCount),
  }
}

export interface ListedEntry {
  type: 'd' | 'f' | 'l' | 'o'
  size: number
  /** 毫秒 */
  modifiedMs: number
  /** 链接指向哪儿，不是链接是空的 */
  link: string
  path: string
}

const BSD_TYPES: Record<string, ListedEntry['type']> = {
  Directory: 'd',
  'Regular File': 'f',
  'Symbolic Link': 'l',
}

export function parseListed(record: string): ListedEntry | null {
  const parts = record.split('\t')
  if (parts.length < 5) return null
  const [kind = '', size = '0', time = '0', link = '', ...rest] = parts
  const type: ListedEntry['type'] =
    kind.length === 1
      ? kind === 'd' || kind === 'f' || kind === 'l'
        ? kind
        : 'o'
      : (BSD_TYPES[kind] ?? 'o')
  return {
    type,
    size: Number.parseInt(size, 10) || 0,
    modifiedMs: Math.round((Number.parseFloat(time) || 0) * 1000),
    link: type === 'l' ? link : '',
    path: rest.join('\t'),
  }
}

/** find 的 -path 模式里通配符要转义 */
export const findPattern = (path: string): string => path.replace(/[*?[\]\\]/g, '\\$&')
