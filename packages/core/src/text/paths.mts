// 对面机器上的路径怎么拼、怎么比。核心没有 Node 的 path，而且路径是对面那台机器的，不是这台的。
// 两种绝对路径：斜杠开头的（macOS、Linux），和盘符开头的（Windows：C:\…、C:/…）。
// 盘符开头的理过之后一律写成 C:/a/b：反斜杠换成斜杠、盘符大写。Node 在 Windows 上认这种写法，拿去对面读写照样能用；
// 在不在根里、是不是同一处，按 Windows 的规矩不分大小写。哪种规矩只看路径本身的样子，不看对面报的系统：
// 斜杠开头的不会是 Windows 的绝对路径，盘符开头的也不会是 POSIX 的绝对路径。
// 网络共享（\\server\share\…）不在这里处理，文件面板遇到会直接说不支持。
// 这里只做字面上的运算，不碰文件系统：符号链接指到哪儿，这里不知道（macOS 的三处系统链接除外，见下面）。

/** 盘符开头：C:、C:\…、C:/… */
const DRIVE = /^([A-Za-z]):(?=[\\/]|$)/

/** 理过的 Windows 绝对路径：C:/ 开头 */
const WINDOWS_ROOT = /^[A-Z]:\//

/** 是不是绝对路径：斜杠开头，或者盘符开头 */
export const isAbsolutePath = (path: string): boolean => path.startsWith('/') || DRIVE.test(path)

/** 原生的 Windows 路径：盘符加冒号，或者网络共享 */
export const isWindowsPath = (path: string): boolean =>
  /^[A-Za-z]:[\\/]/.test(path) || path.startsWith('\\\\')

/** 网络共享上的路径（\\server\share\…） */
export const isNetworkPath = (path: string): boolean => path.startsWith('\\\\')

/** 把一串段折成最简：去掉空的、`.`，把 `..` 折掉。absolute 时折到头的 `..` 丢掉 */
function fold(parts: readonly string[], absolute: boolean): string[] {
  const out: string[] = []
  for (const part of parts) {
    if (part === '' || part === '.') continue
    if (part === '..') {
      const last = out[out.length - 1]
      if (last !== undefined && last !== '..' && !(out.length === 1 && last === '~')) out.pop()
      else if (!absolute) out.push('..')
      // 绝对路径折到根上面去的 `..` 直接丢掉：根的上面还是根
      continue
    }
    out.push(part)
  }
  return out
}

/**
 * 把路径理成最简的样子：去掉重复的斜杠、`.`，把 `..` 折掉，末尾不带斜杠（根自己除外：`/`、`C:/`）。
 * 开头是什么就留什么（`/`、盘符、`~`、相对的）；`..` 折到头了还有剩的照样留着，由调用的一方去判断出没出界。
 * 盘符开头的反斜杠当分隔符，盘符写成大写
 */
export function normalizePath(path: string): string {
  const drive = DRIVE.exec(path)
  if (drive) {
    const rest = fold(path.slice(2).split(/[\\/]/), true)
    return `${(drive[1] ?? '').toUpperCase()}:/${rest.join('/')}`
  }
  const absolute = path.startsWith('/')
  const joined = fold(path.split('/'), absolute).join('/')
  return absolute ? `/${joined}` : joined
}

/**
 * 把相对路径接到一个目录后面；已经是绝对路径（或者以 ~ 开头）的原样理一遍。
 * 目录是 Windows 的，相对路径里的反斜杠也当分隔符
 */
export function joinPath(base: string, path: string): string {
  if (isAbsolutePath(path) || path === '~' || path.startsWith('~/')) return normalizePath(path)
  return normalizePath(`${base}/${path}`)
}

/** 两个路径是不是同一处：理过之后一样；Windows 的不分大小写 */
export function samePath(a: string, b: string): boolean {
  const left = normalizePath(a)
  const right = normalizePath(b)
  if (left === right) return true
  return WINDOWS_ROOT.test(left) && left.toLowerCase() === right.toLowerCase()
}

// ---------- 同一个目录的两种写法 ----------
// macOS 上 /var、/tmp、/etc 是系统自带的符号链接，分别指向 /private/var、/private/tmp、/private/etc，
// 同一个目录就有两种写法。工作区的根、会话的工作目录多半是用户给的那种（/var/folders/…、/tmp/…），
// harness 报的路径却可能是解析过链接的真实路径：Claude Code 的工作目录取自 process.cwd()，
// 模型照着它写出 /private/var/…/a.txt。只比字面的话，这个文件就“不在工作区里”了。
// 这里不碰文件系统，不能现查链接指到哪儿，所以只认这三处（macOS 定死的），别的链接一概不猜；
// Linux 上 /private 没有特殊含义，认不认按设备的系统定（pathTwin）。

/** 一个路径的另一种写法，没有是 null。给的路径要先理过 */
export type PathTwin = (path: string) => string | null

/** 不认另一种写法：只比字面 */
export const noTwin: PathTwin = () => null

const PRIVATE_DIRS = ['/var', '/tmp', '/etc'] as const

/** macOS 上的另一种写法：/private/var/x ↔ /var/x，/tmp、/etc 一样；不在这三处下面的是 null */
export const privateTwin: PathTwin = (path) => {
  for (const short of PRIVATE_DIRS) {
    const long = `/private${short}`
    if (path === long || path.startsWith(`${long}/`)) return short + path.slice(long.length)
    if (path === short || path.startsWith(`${short}/`)) return long + path.slice(short.length)
  }
  return null
}

/**
 * 这台设备上的路径认不认另一种写法。os 是对面报的系统（握手应答的 platformOs：macos、linux、windows）。
 * macOS 认那三处。还不知道是什么系统时（这次运行里还没连上过）也认：认了也出不了根（见 withinRoot），
 * Linux 上本来没有 /private 这个目录，误认的情形碰不上；不认的话 macOS 上连上之前和之后看到的不一样。
 * 确定是别的系统时不认
 */
export const pathTwin = (os: string | null | undefined): PathTwin =>
  os === null || os === undefined || os === 'macos' ? privateTwin : noTwin

/** 根自己以斜杠结尾（`/`、`C:/`）时它就是里面的东西的开头，别的根后面还要跟一个斜杠 */
const prefixOf = (root: string): string => (root.endsWith('/') ? root : `${root}/`)

/**
 * path 是 root 自己或者它里面的东西时，给出照 root 的写法写的它；不是就是 null。
 * Windows 的根不分大小写：c:/Work/App/a 在根 C:/work/app 里，给出 C:/work/app/a
 */
function literallyWithin(root: string, path: string): string | null {
  if (path === root) return path
  const prefix = prefixOf(root)
  if (path.startsWith(prefix)) return path
  if (!WINDOWS_ROOT.test(root)) return null
  // 先切成一样长再比：有的字换了大小写长度会变
  if (path.length === root.length && path.toLowerCase() === root.toLowerCase()) return root
  const head = path.slice(0, prefix.length)
  return head.toLowerCase() === prefix.toLowerCase() ? prefix + path.slice(prefix.length) : null
}

/**
 * path 是 root 自己或者在它里面时，给出照 root 的写法写的它；不在里面是 null。两边都要先理过。
 * 给了 twin（见 pathTwin）时另一种写法也认：根是 /var/x，/private/var/x/a 给出 /var/x/a，反过来也一样。
 * Windows 的路径不分大小写，给出的那一截根照根的大小写写。
 * 给出的路径字面上就在 root 里面，往下拼、比、去对面取都用它，不会出根
 */
export function withinRoot(root: string, path: string, twin: PathTwin = noTwin): string | null {
  const inside = literallyWithin(root, path)
  if (inside !== null) return inside
  const other = twin(path)
  return other === null ? null : literallyWithin(root, other)
}

/** path 是不是 root 自己或者它里面的东西。两边都要先理过；twin 见 withinRoot */
export const insideRoot = (root: string, path: string, twin: PathTwin = noTwin): boolean =>
  withinRoot(root, path, twin) !== null

/** path 相对于 root 的写法。就是 root 自己时是空串；不在里面时原样返回。twin 见 withinRoot */
export function relativeTo(root: string, path: string, twin: PathTwin = noTwin): string {
  const inside = withinRoot(root, path, twin)
  if (inside === null) return path
  if (inside === root) return ''
  return inside.slice(prefixOf(root).length)
}

export function baseName(path: string): string {
  const at = path.lastIndexOf('/')
  return at < 0 ? path : path.slice(at + 1)
}

/** 上一级目录。已经到头了（根，或者只有一段的相对路径）返回 null。给的路径要先理过 */
export function parentPath(path: string): string | null {
  const at = path.lastIndexOf('/')
  if (at < 0) return null
  if (at === 0) return path.length > 1 ? '/' : null
  // 盘符下面的第一层，上一级是盘符的根 C:/；C:/ 自己到头了
  if (at === 2 && WINDOWS_ROOT.test(path)) return path.length > 3 ? path.slice(0, 3) : null
  return path.slice(0, at)
}

/** 扩展名，小写、不带点。没有扩展名、或者是以点开头的隐藏文件（.gitignore）就是空串 */
export function extensionOf(name: string): string {
  const base = baseName(name)
  const at = base.lastIndexOf('.')
  return at <= 0 ? '' : base.slice(at + 1).toLowerCase()
}
