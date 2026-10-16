// 终端怎么起：发给对面的命令行，和记在进程上的标记。纯数据，不发请求。
import {
  DEVICE_PROCESS_TAG_MAX_BYTES,
  type DeviceProcessTag,
} from '../../../protocol/src/index.mjs'
import { encodeUtf8 } from '../text/bytes.mjs'

/**
 * 在对面执行的启动脚本，交给 /bin/sh。客户端不知道对面用户用的是哪个 shell、哪些目录还在，所以都在对面定：
 * - 工作目录：参数里给的目录依次试（请求的那个、工作区的根），都进不去就用主目录；
 * - shell：先看环境里的 SHELL，没有或者不能执行就去系统的用户库里查这个用户的登录 shell，再不行用 /bin/sh；
 * - 没有任何一项指明字符集时补上 UTF-8，不然中文在大多数 shell 里是一串转义；
 * - 最后以登录 shell 的方式换成它（-l），用户在自己的配置里写的东西照常生效。
 * 脚本里不放任何由客户端拼进去的内容：目录走的是位置参数。
 */
export const LAUNCH_SCRIPT = [
  'for d in "$@"; do',
  '  if [ -n "$d" ] && [ -d "$d" ] && cd "$d" 2>/dev/null; then ok=1; break; fi',
  'done',
  '[ -n "${ok:-}" ] || cd "${HOME:-/}" 2>/dev/null || cd /',
  's="${SHELL:-}"',
  'if [ -z "$s" ] || [ ! -x "$s" ]; then',
  '  u="$(id -un 2>/dev/null)"',
  '  case "$(uname -s 2>/dev/null)" in',
  '    Darwin) s="$(dscl . -read "/Users/$u" UserShell 2>/dev/null | sed -n \'s/^UserShell: *//p\')" ;;',
  '    *) s="$(getent passwd "$u" 2>/dev/null | cut -d: -f7)" ;;',
  '  esac',
  'fi',
  '[ -n "$s" ] && [ -x "$s" ] || s=/bin/sh',
  'SHELL="$s"; export SHELL',
  'if [ -z "${LC_ALL:-}${LC_CTYPE:-}${LANG:-}" ]; then',
  '  case "$(uname -s 2>/dev/null)" in Darwin) LANG=en_US.UTF-8 ;; *) LANG=C.UTF-8 ;; esac',
  '  export LANG',
  'fi',
  'exec "$s" -l',
].join('\n')

/** 带给终端里的程序的环境：终端类型、真彩色、是谁开的 */
export const TERMINAL_ENV: Record<string, string> = {
  TERM: 'xterm-256color',
  COLORTERM: 'truecolor',
  TERM_PROGRAM: 'Litch',
}

/** 路径最长收多少。再长的不带过去，也不记进标记：标记写成 JSON 之后有 4096 字节的上限 */
const PATH_MAX = 1024

/** 能交给对面当目录用的：绝对路径，里面没有控制字符，不太长。别的一律当没给 */
export function usableDir(value: unknown): string | null {
  if (typeof value !== 'string' || !value.startsWith('/')) return null
  if (value.length > PATH_MAX || /[\u0000-\u001f\u007f]/.test(value)) return null
  return value
}

/** 起一个终端的命令行。dirs 是要依次试的工作目录，不合用的自己滤掉 */
export function launchCommand(dirs: readonly (string | null | undefined)[]): string[] {
  const usable = dirs.map(usableDir).filter((dir): dir is string => dir !== null)
  return ['/bin/sh', '-c', LAUNCH_SCRIPT, 'litch-terminal', ...usable]
}

/**
 * 记在属于设备的进程上的标记：设备不看，列出来时原样带回。
 * 应用重新打开、或者另一台电脑连上同一台设备时，靠它把设备上活着的终端对回工作区、排回原来的位置。
 */
export interface TerminalTag {
  litch: 'terminal'
  v: 1
  /** 挂在哪个工作区上。null：设备主目录的那一组 */
  workspace: string | null
  /** 那个工作区的根目录：工作区的标识对不上了（设备上的工作区重建过）就按它找 */
  root: string | null
  /** 起的时候就有的名字。之后改的名字设备上记不了，记在各台电脑自己这里 */
  title: string | null
  /** 默认名字里的序号 */
  seq: number
  /** 标签按它从小到大排 */
  order: number
  /** 起的时候请求的目录 */
  cwd: string | null
}

const text = (value: unknown, max = PATH_MAX): string | null =>
  typeof value === 'string' && value.length > 0 && value.length <= max ? value : null

const count = (value: unknown, fallback: number): number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : fallback

export function makeTag(fields: Omit<TerminalTag, 'litch' | 'v'>): DeviceProcessTag {
  const tag: TerminalTag = {
    litch: 'terminal',
    v: 1,
    workspace: text(fields.workspace, 256),
    root: usableDir(fields.root),
    title: text(fields.title, 120),
    seq: fields.seq,
    order: fields.order,
    cwd: usableDir(fields.cwd),
  }
  // 路径里要是全是多字节的字，还是可能超：那就不带路径，别的照留
  if (encodeUtf8(JSON.stringify(tag)).length > DEVICE_PROCESS_TAG_MAX_BYTES) {
    return { ...tag, root: null, cwd: null }
  }
  return { ...tag }
}

/** 设备上的一个进程是不是我们开的终端。不是（别的客户端拿这个扩展干别的）就是 null */
export function parseTag(value: unknown): TerminalTag | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const raw = value as Record<string, unknown>
  if (raw.litch !== 'terminal') return null
  return {
    litch: 'terminal',
    v: 1,
    workspace: text(raw.workspace, 256),
    root: usableDir(raw.root),
    title: text(raw.title, 120),
    seq: Math.max(1, Math.floor(count(raw.seq, 1))),
    order: count(raw.order, 0),
    cwd: usableDir(raw.cwd),
  }
}

/** 记在这台电脑上、和设备上的终端有关的两样：改过的名字、留在设备上不看的 */
export interface TerminalNotes {
  /** 句柄 → 名字 */
  titles: Record<string, string>
  /** 留在设备上、这边没开成标签的句柄 */
  hidden: string[]
}

/** 存在哪由外壳定。存取失败不影响使用 */
export interface TerminalNotesStore {
  load(): TerminalNotes | null
  save(notes: TerminalNotes): void
}

/** 检查读回来的那份。读不懂的当作没记过 */
export function checkNotes(value: unknown): TerminalNotes | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const raw = value as Record<string, unknown>
  const titles: Record<string, string> = {}
  if (typeof raw.titles === 'object' && raw.titles !== null && !Array.isArray(raw.titles)) {
    for (const [handle, title] of Object.entries(raw.titles)) {
      const kept = text(title, 120)
      if (kept) titles[handle] = kept
    }
  }
  const hidden = Array.isArray(raw.hidden)
    ? raw.hidden.filter((entry): entry is string => typeof entry === 'string' && entry.length > 0)
    : []
  return { titles, hidden }
}

const HEX = '0123456789abcdef'

/**
 * 一个不会重复的句柄，写成 UUID 的样子。属于设备的进程，句柄在设备范围内要唯一。
 * 用不着密码学上的随机：只要两台电脑、两次运行不撞上
 */
export function randomHandle(random: () => number = Math.random): string {
  let out = ''
  for (let at = 0; at < 36; at++) {
    if (at === 8 || at === 13 || at === 18 || at === 23) out += '-'
    else if (at === 14) out += '4'
    else if (at === 19) out += HEX.charAt(8 + Math.floor(random() * 4))
    else out += HEX.charAt(Math.floor(random() * 16))
  }
  return out
}
