// 对话里哪些字是工作区里的一个文件路径（可以带行号），点了能在文件面板里打开。
// 这里只做字面上的判断，不去问文件在不在；所以规矩是“认不准的宁可不认”：
// - 只认落在工作区根之内的路径（相对路径按会话的工作目录接）；
// - 必须看得出是个文件：带扩展名，或者是 Makefile 这类名字；目录不认；
// - 光一个文件名（不带目录）的只认扩展名常见的：`console.log`、`.then` 这类不是文件；
// - 网址、域名开头的、带空白和引号的不认；
// - 正文里（不在行内代码里）的更严：必须有目录分隔，扩展名得是常见的源码或文本类型，或者后面跟着行号。
import {
  extensionOf,
  joinPath,
  normalizePath,
  noTwin,
  type PathTwin,
  withinRoot,
} from '../text/paths.mjs'

export interface FileScope {
  /** 工作区的根（不属于工作区的会话是它的工作目录）：只认它里面的路径 */
  root: string
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
  /** 完整路径，理过，在根之内，照根的写法 */
  path: string
  /** 工作目录不是根的时候，相对路径的另一种读法：相对于根。按 path 找不到文件时界面再试这个 */
  alt: string | null
  /** 从 1 起的行号。没写就是 null */
  line: number | null
}

/** 认路径时的松紧：code 是行内代码和链接的地址（整段就是一个路径），prose 是正文里扫出来的 */
export type FileRefMode = 'code' | 'prose'

/** 路径里许出现的字符：不许空白、引号、冒号和通配符这些 */
const PATH_CHARS = /^[^\s<>"'`|*?:;,{}$\\!]+$/
/** 结尾的位置：#L12、#L12-L20、:12、:12:5、:12-20 */
const LOCATION = /(?:#L(\d+)(?:C\d+)?(?:-L?\d+(?:C\d+)?)?|:(\d+)(?::\d+)?(?:-\d+)?)$/
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
    'cc cpp hpp cs css scss less html htm xml svg vue sql rb php lua txt lock csv gradle proto graphql'
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
  if (raw.length < 3 || raw.length > 400 || !scope.root) return null
  const location = LOCATION.exec(raw)
  const text = location ? raw.slice(0, location.index) : raw
  const number = location ? Number(location[1] ?? location[2]) : Number.NaN
  const line = Number.isInteger(number) && number >= 1 && number <= MAX_LINE ? number : null
  if (!PATH_CHARS.test(text) || text.includes('//') || text.startsWith('-')) return null
  const parts = text.split('/')
  const name = parts[parts.length - 1] ?? ''
  if (!name || !looksLikeFile(name)) return null
  const nested = parts.length > 1
  const known = KNOWN.has(extensionOf(name)) || BARE_NAMES.has(name.toLowerCase())
  if (mode === 'prose') {
    // 正文里：要有目录分隔；扩展名常见，或者明明白白带着行号
    if (!nested || !(known || line !== null)) return null
  } else if (!nested && !(known && extensionOf(name).length !== 1)) {
    // 光一个文件名：`console.log`、`a.b` 这类不是文件，只认扩展名常见的
    return null
  }
  // 开头那一段像域名的是网址的一截，不是路径
  const first = parts.find((part) => part !== '' && part !== '.' && part !== '..') ?? ''
  if (first !== name && DOMAIN.test(first)) return null

  const root = normalizePath(scope.root)
  const cwd = scope.cwd ? normalizePath(scope.cwd) : root
  const absolute = text.startsWith('/') || text.startsWith('~/')
  const twin = scope.twin ?? noTwin
  /** 在根里面（不是根自己）的照根的写法给出来，不在是 null */
  const within = (path: string): string | null => {
    const inside = withinRoot(root, path, twin)
    return inside === root ? null : inside
  }
  if (absolute) {
    const path = within(normalizePath(text))
    return path === null ? null : { path, alt: null, line }
  }
  const fromCwd = within(joinPath(cwd, text))
  const fromRoot = within(joinPath(root, text))
  if (fromCwd !== null) {
    return { path: fromCwd, alt: fromRoot !== fromCwd ? fromRoot : null, line }
  }
  return fromRoot === null ? null : { path: fromRoot, alt: null, line }
}

export interface FileRefSpan {
  /** 在原文里的起止位置（按 UTF-16 单位，能直接拿去切字符串） */
  start: number
  end: number
  ref: FileRef
}

/** 正文里一个可能是路径的片段：不含空白、括号、引号和中文标点 */
const TOKEN = /[^\s<>"'`|*?;,{}$\\!()[\]，。；：、（）【】「」“”‘’！？]+/g
/** 片段末尾跟着的句读不算路径的一部分 */
const TRAILING = /[.:]+$/

/** 正文里的文件路径，按出现的先后。一个都没有是空数组 */
export function findFileRefs(text: string, scope: FileScope): FileRefSpan[] {
  // 没有斜杠的正文里不会有要认的路径：绝大多数文字在这里就结束了
  if (!scope.root || !text.includes('/')) return []
  const spans: FileRefSpan[] = []
  for (const match of text.matchAll(TOKEN)) {
    const token = match[0]
    if (!token.includes('/') || token.includes('://')) continue
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
  if (!path || !scope.root || path.includes('\\')) return null
  const root = normalizePath(scope.root)
  const full = joinPath(scope.cwd ? normalizePath(scope.cwd) : root, path)
  const inside = withinRoot(root, full, scope.twin ?? noTwin)
  return inside !== null && inside !== root ? { path: inside, alt: null, line: null } : null
}

/** 明确的链接地址允许空格和二进制文件名，不扩宽正文的启发式识别。 */
export function explicitFileRef(href: string, scope: FileScope): FileRef | null {
  const hash = href.indexOf('#')
  let value: string, fragment: string
  try {
    value = decodeURIComponent(hash >= 0 ? href.slice(0, hash) : href)
    fragment = hash >= 0 ? decodeURIComponent(href.slice(hash + 1)) : ''
  } catch {
    return null
  }
  if (
    (/^[a-z][a-z0-9+.-]*:/i.test(value) && !/^[a-z]:\//i.test(value)) ||
    /^[\\/]{2}/.test(value) ||
    /[\0\r\n]/.test(value + fragment)
  )
    return null
  const normal = fileRefOf(value, scope)
  if (normal && !fragment) return normal
  const path = value
  if ((!normal && !EXTENSION.test(path)) || path.endsWith('/')) return null
  const ref = normal ?? knownFileRef(path, scope)
  if (!ref) return null
  const line = /^L(\d+)(?:-L?\d+)?$/.exec(fragment)
  return { ...ref, ...(line ? { line: Number(line[1]) } : fragment ? { fragment } : {}) }
}
