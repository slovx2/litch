import { existsSync, realpathSync, statSync } from 'node:fs'
import { basename, dirname, isAbsolute, sep } from 'node:path'
import {
  type FileAccess,
  type FileSystemRule,
  type FileSystemRules,
  normalizedPath,
  pathAccess,
  withWritableRoots,
} from './permission-profiles.mjs'
import { ProtocolError } from './protocol-contract.mjs'

// 独立 command/exec 不经过 SDK 工具权限检查，必须在进程创建前应用操作系统沙箱。
export function sandboxCommand(
  command: string[],
  cwd: string,
  params: Record<string, unknown>,
  defaultRoot = process.cwd(),
  extraWriteRoots: readonly string[] = [],
  // 自定义权限档位的规则（permission-profiles.mts）：给了就按它挂载，不再看 sandboxPolicy 里的可写目录
  fileSystem?: FileSystemRules,
): string[] {
  if (params.permissionProfile != null && params.sandboxPolicy != null)
    throw new ProtocolError(-32602, 'permissionProfile 与 sandboxPolicy 不能同时使用')
  const profiles: Record<string, string> = {
    ':read-only': 'readOnly',
    ':workspace': 'workspaceWrite',
    ':danger-full-access': 'dangerFullAccess',
  }
  let policy = params.sandboxPolicy as Record<string, unknown> | undefined
  if (params.permissionProfile != null) {
    const type = profiles[String(params.permissionProfile)]
    if (!type) throw new ProtocolError(-32602, '未知 command 权限配置')
    policy = { type }
  }
  policy ??= { type: 'readOnly' }
  if (!['readOnly', 'workspaceWrite', 'dangerFullAccess'].includes(String(policy.type)))
    throw new ProtocolError(-32602, '不支持此 command sandboxPolicy')
  if (policy.type === 'dangerFullAccess') return command
  if (process.platform === 'win32')
    throw new ProtocolError(
      -32004,
      'Windows 原生宿主没有操作系统沙箱；请显式选择完全访问，或在 WSL2 内运行',
    )
  if (policy.networkAccess != null && typeof policy.networkAccess !== 'boolean')
    throw new ProtocolError(-32602, 'networkAccess 必须为布尔值')
  for (const key of ['excludeSlashTmp', 'excludeTmpdirEnvVar'])
    if (policy[key] != null && typeof policy[key] !== 'boolean')
      throw new ProtocolError(-32602, `${key} 必须为布尔值`)
  const roots: string[] = []
  // 有档位规则时可写目录全由规则定（工作目录、临时目录都在规则里），不再按 sandboxPolicy 补
  if (policy.type === 'workspaceWrite' && !fileSystem) {
    if (policy.writableRoots != null && !Array.isArray(policy.writableRoots))
      throw new ProtocolError(-32602, 'writableRoots 必须是绝对路径数组')
    // 工作目录不能隐式扩大服务器的工作区授权；额外写入位置必须显式列出。
    const requested = [defaultRoot, ...((policy.writableRoots as unknown[]) ?? [])]
    if (policy.excludeSlashTmp !== true) requested.push('/tmp')
    if (policy.excludeTmpdirEnvVar !== true && process.env.TMPDIR)
      requested.push(process.env.TMPDIR)
    for (const root of requested) {
      if (typeof root !== 'string' || !isAbsolute(root))
        throw new ProtocolError(-32602, 'writableRoots 必须是绝对路径数组')
      roots.push(realpathSync(root))
    }
  }
  // 内部权限 overlay 独立于沙箱模式：只读授予外部目录不隐式开放 cwd。
  for (const root of extraWriteRoots) {
    if (!isAbsolute(root)) throw new ProtocolError(-32602, '额外授权必须是绝对路径')
    if (realpathSync(root) !== root) throw new ProtocolError(-32602, '额外授权路径已变化，禁止执行')
    roots.push(root)
  }
  if (fileSystem) {
    const rules = withWritableRoots(fileSystem, extraWriteRoots)
    const network = policy.networkAccess === true
    if (process.platform === 'darwin')
      return ['/usr/bin/sandbox-exec', '-p', seatbeltProfile(rules, network), ...command]
    if (process.platform === 'linux') {
      const { args, placeholders } = bwrapFileSystemArgs(rules)
      const bwrap = [
        'bwrap',
        '--die-with-parent',
        '--new-session',
        '--unshare-pid',
        ...args,
        ...(network ? [] : ['--unshare-net']),
        '--chdir',
        cwd,
        '--',
        ...command,
      ]
      return placeholders.length > 0 ? withPlaceholderCleanup(bwrap, placeholders) : bwrap
    }
    throw new ProtocolError(-32004, '此宿主没有可用的 command 沙箱')
  }
  if (process.platform === 'darwin') {
    const profile = [
      '(version 1)',
      '(allow default)',
      '(deny file-write*)',
      '(allow file-write* (literal "/dev/null") (literal "/dev/tty") (regex #"^/dev/ttys[0-9]+$"))',
      ...roots.map((root) => `(allow file-write* (subpath ${JSON.stringify(root)}))`),
      ...(policy.networkAccess === true ? [] : ['(deny network*)']),
    ].join('\n')
    return ['/usr/bin/sandbox-exec', '-p', profile, ...command]
  }
  if (process.platform === 'linux') {
    return [
      'bwrap',
      '--die-with-parent',
      '--new-session',
      // 新的 PID 命名空间（照 codex）：不然 setuid 的 bwrap 下能经 /proc/<宿主进程>/root/ 绕过挂载
      '--unshare-pid',
      '--ro-bind',
      '/',
      '/',
      '--dev',
      '/dev',
      '--proc',
      '/proc',
      ...(policy.networkAccess === true ? [] : ['--unshare-net']),
      ...[...new Set(roots)].flatMap((root) => ['--bind', root, root]),
      '--chdir',
      cwd,
      '--',
      ...command,
    ]
  }
  throw new ProtocolError(-32004, '此宿主没有可用的 command 沙箱')
}

function depth(path: string): number {
  return path === '/' ? 0 : path.split(sep).length - 1
}

// 要写进沙箱的条目：按深度从浅到深，和上一级条目给的访问一样的省掉。sandbox-exec 的规则不要求路径存在，
// 全都写；bwrap 只能挂存在的路径，不存在的另外处理（bwrapFileSystemArgs）
function effectiveRules(rules: FileSystemRules): { root: FileAccess; entries: FileSystemRule[] } {
  const sorted = rules.entries
    .filter((entry) => entry.path !== '/')
    .sort((a, b) => depth(a.path) - depth(b.path) || a.path.localeCompare(b.path))
  const root = pathAccess(rules, '/')
  const entries = sorted.filter((entry) => {
    const above = { ...rules, entries: rules.entries.filter((other) => other.path !== entry.path) }
    return pathAccess(above, entry.path) !== entry.access
  })
  return { root, entries }
}

// 挂载条目里离 path 最近的上级条目
function parentEntry(entries: FileSystemRule[], path: string): FileSystemRule | undefined {
  let best: FileSystemRule | undefined
  for (const entry of entries)
    if (path.startsWith(entry.path + sep) && (!best || entry.path.length > best.path.length))
      best = entry
  return best
}

// 路径里第一个不存在的那一级（codex 的 find_first_non_existent_component）
function firstMissing(path: string): string | null {
  let current = '/'
  for (const part of path.split(sep).filter(Boolean)) {
    current = current === '/' ? `/${part}` : `${current}${sep}${part}`
    if (!existsSync(current)) return current
  }
  return null
}

const METADATA_NAMES = new Set(['.git', '.agents', '.codex', '.aws'])

// bwrap：根按 `:root` 只读或可写挂上；禁读的目录盖一层空 tmpfs（里面要挂回的子目录先建好挂载点，
// 有要挂回的给 111 只许穿过、没有的给 000），文件用 /dev/null 盖住；可读、可写的子目录按真实路径挂回。
// 挂回的都挂完以后再把各层 tmpfs 改成只读，免得沙箱里的进程在里面建文件。
// 不存在的禁读、只读路径照 codex：落在可写范围里时，在第一个不存在的那一级放占位（元数据目录放只读的
// 空目录，其余放 /dev/null），沙箱里就建不出它。占位是 bwrap 在宿主上建的挂载点，命令结束后要删掉
export function bwrapFileSystemArgs(rules: FileSystemRules): {
  args: string[]
  placeholders: string[]
} {
  const { root, entries: all } = effectiveRules(rules)
  const entries = all.filter((entry) => existsSync(entry.path))
  const args = [
    root === 'write' ? '--bind' : '--ro-bind',
    '/',
    '/',
    '--dev',
    '/dev',
    '--proc',
    '/proc',
  ]
  const masked: string[] = []
  for (const entry of entries) {
    if (entry.access === 'deny') {
      if (!statSync(entry.path).isDirectory()) {
        args.push('--ro-bind', '/dev/null', entry.path)
        continue
      }
      const reopened = entries.filter(
        (other) => other.access !== 'deny' && parentEntry(entries, other.path) === entry,
      )
      args.push('--perms', reopened.length > 0 ? '111' : '000', '--tmpfs', entry.path)
      const dirs = new Set<string>()
      for (const child of reopened) {
        // 文件的挂载点由 bwrap 挂载时自己建，这里只建它所在的目录
        const target = statSync(child.path).isDirectory() ? child.path : dirname(child.path)
        const parts = target
          .slice(entry.path.length + 1)
          .split(sep)
          .filter(Boolean)
        for (let index = 1; index <= parts.length; index += 1)
          dirs.add([entry.path, ...parts.slice(0, index)].join(sep))
      }
      for (const dir of dirs) args.push('--dir', dir)
      masked.push(entry.path)
    } else args.push(entry.access === 'write' ? '--bind' : '--ro-bind', entry.path, entry.path)
  }
  const placeholders = new Set<string>()
  const workspaceRoots = new Set(rules.workspaceRoots.map(normalizedPath))
  for (const entry of all) {
    if (entry.access === 'write' || existsSync(entry.path)) continue
    const missing = firstMissing(entry.path)
    if (!missing || placeholders.has(missing) || pathAccess(rules, dirname(missing)) !== 'write')
      continue
    const metadata =
      entry.access === 'read' && missing === entry.path && METADATA_NAMES.has(basename(missing))
    // 元数据目录照 codex 只在工作区根下面放占位（/tmp 之类的可写目录下不每条命令都建一遍），
    // 别处不存在的元数据目录靠文件类工具的检查拦
    if (metadata && !workspaceRoots.has(dirname(missing))) continue
    placeholders.add(missing)
    if (metadata) args.push('--perms', '555', '--tmpfs', missing, '--remount-ro', missing)
    else args.push('--ro-bind', '/dev/null', missing)
  }
  for (const path of masked) args.push('--remount-ro', path)
  return { args, placeholders: [...placeholders] }
}

// 命令结束后删掉 bwrap 在宿主上建的占位：只删空目录和空文件，命令的退出码照原样带出来
function withPlaceholderCleanup(bwrap: string[], placeholders: string[]): string[] {
  const quote = (value: string) => "'" + value.replaceAll("'", "'\"'\"'") + "'"
  const cleanup = placeholders
    .map(
      (path) =>
        `if [ -d ${quote(path)} ]; then rmdir ${quote(path)} 2>/dev/null; ` +
        `elif [ -f ${quote(path)} ] && [ ! -s ${quote(path)} ]; then rm -f ${quote(path)}; fi`,
    )
    .join('; ')
  return ['/bin/sh', '-c', `"$@"; status=$?; ${cleanup}; exit $status`, 'sh', ...bwrap]
}

// sandbox-exec：同一操作命中多条规则时后写的为准，所以按深度从浅到深写，最深的条目说了算。
// 不存在的路径也写进去：之后被建出来同样受管
export function seatbeltProfile(rules: FileSystemRules, network: boolean): string {
  const { root, entries } = effectiveRules(rules)
  const subpath = (path: string) => `(subpath ${JSON.stringify(path)})`
  return [
    '(version 1)',
    '(allow default)',
    ...(root === 'write'
      ? []
      : [
          '(deny file-write*)',
          '(allow file-write* (literal "/dev/null") (literal "/dev/tty") (regex #"^/dev/ttys[0-9]+$"))',
        ]),
    ...entries.flatMap((entry) =>
      entry.access === 'write'
        ? [`(allow file-read* file-write* ${subpath(entry.path)})`]
        : entry.access === 'read'
          ? [
              `(allow file-read* ${subpath(entry.path)})`,
              `(deny file-write* ${subpath(entry.path)})`,
            ]
          : [`(deny file-read* file-write* ${subpath(entry.path)})`],
    ),
    ...(network ? [] : ['(deny network*)']),
  ].join('\n')
}
