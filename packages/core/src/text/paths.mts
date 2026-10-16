// 对面机器上的路径怎么拼、怎么比。核心没有 Node 的 path，而且路径是对面那台机器的，不是这台的。
// 只认用斜杠分隔的路径（macOS、Linux，以及适配器在 Windows 上用的 /C:/… 写法）；
// 原生的 Windows 路径（C:\…）不在这里处理，文件面板遇到会直接说不支持。
// 这里只做字面上的运算，不碰文件系统：符号链接指到哪儿，这里不知道（macOS 的三处系统链接除外，见下面）。

/** 是不是以斜杠分隔的绝对路径 */
export const isAbsolutePath = (path: string): boolean => path.startsWith('/')

/** 原生的 Windows 路径：盘符加冒号，或者带反斜杠 */
export const isWindowsPath = (path: string): boolean =>
  /^[A-Za-z]:[\\/]/.test(path) || path.startsWith('\\\\')

/**
 * 把路径理成最简的样子：去掉重复的斜杠、`.`，把 `..` 折掉，末尾不带斜杠。
 * 开头是什么就留什么（`/`、`~`、相对的）；`..` 折到头了还有剩的照样留着，由调用的一方去判断出没出界
 */
export function normalizePath(path: string): string {
  const absolute = path.startsWith('/')
  const out: string[] = []
  for (const part of path.split('/')) {
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
  const joined = out.join('/')
  return absolute ? `/${joined}` : joined
}

/** 把相对路径接到一个目录后面；已经是绝对路径（或者以 ~ 开头）的原样理一遍 */
export function joinPath(base: string, path: string): string {
  if (path.startsWith('/') || path === '~' || path.startsWith('~/')) return normalizePath(path)
  return normalizePath(`${base}/${path}`)
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

/** 只看字面：path 是不是 root 自己或者它里面的东西 */
const literallyInside = (root: string, path: string): boolean =>
  path === root || (root === '/' ? path.startsWith('/') : path.startsWith(`${root}/`))

/**
 * path 是 root 自己或者在它里面时，给出照 root 的写法写的它；不在里面是 null。两边都要先理过。
 * 给了 twin（见 pathTwin）时另一种写法也认：根是 /var/x，/private/var/x/a 给出 /var/x/a，反过来也一样。
 * 给出的路径字面上就在 root 里面，往下拼、比、去对面取都用它，不会出根
 */
export function withinRoot(root: string, path: string, twin: PathTwin = noTwin): string | null {
  if (literallyInside(root, path)) return path
  const other = twin(path)
  return other !== null && literallyInside(root, other) ? other : null
}

/** path 是不是 root 自己或者它里面的东西。两边都要先理过；twin 见 withinRoot */
export const insideRoot = (root: string, path: string, twin: PathTwin = noTwin): boolean =>
  withinRoot(root, path, twin) !== null

/** path 相对于 root 的写法。就是 root 自己时是空串；不在里面时原样返回。twin 见 withinRoot */
export function relativeTo(root: string, path: string, twin: PathTwin = noTwin): string {
  const inside = withinRoot(root, path, twin)
  if (inside === null) return path
  if (inside === root) return ''
  return inside.slice(root === '/' ? 1 : root.length + 1)
}

export function baseName(path: string): string {
  const at = path.lastIndexOf('/')
  return at < 0 ? path : path.slice(at + 1)
}

/** 上一级目录。已经到头了（根，或者只有一段的相对路径）返回 null */
export function parentPath(path: string): string | null {
  const at = path.lastIndexOf('/')
  if (at < 0) return null
  if (at === 0) return path.length > 1 ? '/' : null
  return path.slice(0, at)
}

/** 扩展名，小写、不带点。没有扩展名、或者是以点开头的隐藏文件（.gitignore）就是空串 */
export function extensionOf(name: string): string {
  const base = baseName(name)
  const at = base.lastIndexOf('.')
  return at <= 0 ? '' : base.slice(at + 1).toLowerCase()
}
