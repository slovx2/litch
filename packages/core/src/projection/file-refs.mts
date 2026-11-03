// 会话设备上的路径与位置。这里只做字面解析；点击时由 files.resolve 核实候选和设备 home。
import {
  extensionOf,
  isAbsolutePath,
  joinPath,
  normalizePath,
  noTwin,
  type PathTwin,
  samePath,
  withinRoot,
} from '../text/paths.mjs'

export interface FileScope {
  /** 当前文件树的根；用于路径写法与候选排序，不是读取边界 */
  root: string
  /** 项目的全部根，按项目中的顺序 */
  roots?: readonly string[]
  /** 相对路径相对于谁：会话的工作目录 */
  cwd: string
  /**
   * 这台设备上路径的另一种写法（text/paths.mts 的 pathTwin）：macOS 上 harness 给的 /private/var/… 落在根 /var/… 里。
   * 认出来的路径一律换成根的写法。不给就只比字面
   */
  twin?: PathTwin
}

export interface FileRef {
  /** 明确的 Markdown 文件链接可携带文档标题锚点。 */
  fragment?: string
  /** 完整路径；~ 留给会话设备展开 */
  path: string
  /** 相对路径的全部候选（cwd 在先），超过两个时提供；alt 保留给单候选入口 */
  candidates?: string[]
  /** 工作目录不是根的时候，相对路径的另一种读法：相对于根。按 path 找不到文件时界面再试这个 */
  alt: string | null
  /** 从 1 起的行号。没写就是 null */
  line: number | null
}

/** 认路径时的松紧：code 是行内代码和链接的地址（整段就是一个路径），prose 是正文里扫出来的 */
export type FileRefMode = 'code' | 'prose'

/** 路径里许出现的字符：不许空白、引号、冒号和通配符这些 */
const PATH_CHARS = /^[^<>"'`|*?:;,{}$!\0\r\n]+$/
/** 结尾的位置：#L12、#L12-L20、:12、:12:5、:12-20 */
const LOCATION = /(?:#L(\d+)(?:C\d+)?(?:-L?\d+(?:C\d+)?)?|:(\d+)(?::\d+)?(?:-\d+(?::\d+)?)?)$/
/** 扩展名：字母开头，最多十个字母数字 */
const EXTENSION = /\.[A-Za-z][A-Za-z0-9]{0,9}$/
/** 像域名的一段：最后一节是两个以上的字母 */
const DOMAIN = /^[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}$/
/** 没有扩展名也认得出是文件的名字 */
const BARE_NAMES = new Set([
  'makefile',
  'dockerfile',
  'license',
  'readme',
  'changelog',
  'gemfile',
  'rakefile',
  'procfile',
  'justfile',
])
/** 常见的源码和文本类型。正文里的路径、没有目录的文件名要落在这里面才认 */
const KNOWN = new Set(
  (
    'ts mts cts tsx js mjs cjs jsx json jsonc md mdx yml yaml toml ini sh bash zsh py go rs java kt swift ' +
    'cc cpp hpp cs css scss less html htm xml svg vue sql rb php lua txt lock csv gradle proto graphql ' +
    'pdf png jpg jpeg gif webp docx xlsx'
  ).split(' '),
)
const MAX_LINE = 10_000_000

const looksLikeFile = (name: string): boolean =>
  // 以点开头的（.gitignore、.env）、带扩展名的、几个不带扩展名的常见名字
  (name.startsWith('.') && name.length > 1 && !name.startsWith('..')) ||
  EXTENSION.test(name) ||
  BARE_NAMES.has(name.toLowerCase())

/**
 * 一整段字是不是工作区里的一个文件路径。不是、或者认不准，就是 null。
 * mode 是 prose 时按正文的规矩，更严
 */
export function fileRefOf(
  raw: string,
  scope: FileScope,
  mode: FileRefMode = 'code',
): FileRef | null {
  return parseFileRef(raw, scope, mode)
}

/** 先剥离位置，再判断协议和盘符；明确链接与自动识别共用同一条解析路线。 */
function parseFileRef(
  raw: string,
  scope: FileScope,
  mode: FileRefMode | 'explicit',
): FileRef | null {
  if (raw.length < 1 || raw.length > 4096 || !scope.root) return null
  const location = LOCATION.exec(raw)
  let address = location ? raw.slice(0, location.index) : raw
  const hash = address.indexOf('#')
  let fragment = ''
  let text: string
  try {
    if (hash >= 0) {
      fragment = decodeURIComponent(address.slice(hash + 1))
      address = address.slice(0, hash)
    }
    text = decodeURIComponent(address)
  } catch {
    return null
  }
  const number = location ? Number(location[1] ?? location[2]) : Number.NaN
  const line = Number.isInteger(number) && number >= 1 && number <= MAX_LINE ? number : null
  // 反斜杠只在 Windows 路径中作分隔符，UNC 不在本轮支持范围。
  if (/^[\\/]{2}/.test(text)) return null
  const windows = /^[a-z]:[\\/]/i.test(text) || /^[a-z]:[\\/]/i.test(scope.cwd)
  if (windows) text = text.replaceAll('\\', '/')
  const chars = /^[a-z]:\//i.test(text) ? text.slice(2) : text
  if (
    !PATH_CHARS.test(chars) ||
    chars.includes('\\') ||
    text.includes('//') ||
    text.startsWith('-')
  )
    return null
  if (mode === 'prose' && /\s/.test(text)) return null
  const parts = text.split('/')
  const name = parts[parts.length - 1] ?? ''
  if (!name || !looksLikeFile(name)) return null
  const nested = parts.length > 1
  const known = KNOWN.has(extensionOf(name)) || BARE_NAMES.has(name.toLowerCase())
  if (mode === 'prose') {
    // 正文里：要有目录分隔；扩展名常见，或者明明白白带着行号
    if (!nested || !(known || line !== null)) return null
  } else if (mode !== 'explicit' && !nested && !(known && extensionOf(name).length !== 1)) {
    // 光一个文件名：`console.log`、`a.b` 这类不是文件，只认扩展名常见的
    return null
  }
  // 开头那一段像域名的是网址的一截，不是路径
  const first = parts.find((part) => part !== '' && part !== '.' && part !== '..') ?? ''
  if (mode !== 'explicit' && first !== name && DOMAIN.test(first)) return null

  return { ...addressRef(text, scope), line, ...(fragment ? { fragment } : {}) }
}

function addressRef(text: string, scope: FileScope): FileRef {
  const roots = (scope.roots ?? [scope.root]).map(normalizePath)
  const canonical = (path: string) => {
    const full = normalizePath(path)
    for (const root of roots) {
      const inside = withinRoot(root, full, scope.twin ?? noTwin)
      if (inside !== null) return inside
    }
    return full
  }
  const candidates =
    isAbsolutePath(text) || text === '~' || text.startsWith('~/')
      ? [canonical(text)]
      : [scope.cwd || scope.root, ...roots].map((base) => canonical(joinPath(base, text)))
  const unique = candidates.filter(
    (path, index) => !candidates.slice(0, index).some((other) => samePath(path, other)),
  )
  return {
    path: unique[0] ?? '',
    alt: unique[1] ?? null,
    line: null,
    ...(unique.length > 2 ? { candidates: unique } : {}),
  }
}

/** 两端共享根的选择：工作树作为文件树默认根，项目各根仍参与相对路径寻址。 */
export function sessionFileScope(
  summary: { cwd: string; worktree?: { state: string; path: string } | null },
  roots: readonly string[] = [],
  twin: PathTwin = noTwin,
): FileScope | null {
  const cwd = normalizePath(summary.cwd)
  const tree = summary.worktree
  const root =
    tree && tree.state !== 'removed'
      ? tree.path
      : (roots.find((entry) => withinRoot(normalizePath(entry), cwd, twin) !== null) ??
        roots[0] ??
        cwd)
  return root ? { root: normalizePath(root), cwd: cwd || root, roots, twin } : null
}

export interface FileRefSpan {
  /** 在原文里的起止位置（按 UTF-16 单位，能直接拿去切字符串） */
  start: number
  end: number
  ref: FileRef
}

/** 正文里一个可能是路径的片段：不含空白、括号、引号和中文标点 */
const TOKEN = /[^\s<>"'`|*?;,{}$!()[\]，。；：、（）【】「」“”‘’！？]+/g
/** 片段末尾跟着的句读不算路径的一部分 */
const TRAILING = /[.:]+$/

/** 正文里的文件路径，按出现的先后。一个都没有是空数组 */
export function findFileRefs(text: string, scope: FileScope): FileRefSpan[] {
  // 没有斜杠的正文里不会有要认的路径：绝大多数文字在这里就结束了
  if (!scope.root || !/[\\/]/.test(text)) return []
  const spans: FileRefSpan[] = []
  for (const match of text.matchAll(TOKEN)) {
    const token = match[0]
    if (!/[\\/]/.test(token) || token.includes('://')) continue
    const trimmed = token.replace(TRAILING, '')
    const ref = fileRefOf(trimmed, scope, 'prose')
    if (ref) spans.push({ start: match.index, end: match.index + trimmed.length, ref })
  }
  return spans
}

/**
 * 明知道是个文件路径的（工具调用里改动的文件，是引擎给的，不是从文字里猜的）：不用看它像不像，
 * 只核对在不在根之内。在就给出完整路径，不在是 null
 */
export function knownFileRef(path: string, scope: FileScope): FileRef | null {
  if (!path || !scope.root || /^[\\/]{2}/.test(path) || /[\0\r\n]/.test(path)) return null
  return addressRef(path, scope)
}

/** 明确的链接地址允许空格和二进制文件名，不扩宽正文的启发式识别。 */
export function explicitFileRef(href: string, scope: FileScope): FileRef | null {
  return parseFileRef(href, scope, 'explicit')
}
