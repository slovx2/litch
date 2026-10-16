import { realpathSync } from 'node:fs'
import { isAbsolute } from 'node:path'
import { ProtocolError } from './protocol-contract.mjs'

// 独立 command/exec 不经过 SDK 工具权限检查，必须在进程创建前应用操作系统沙箱。
export function sandboxCommand(
  command: string[],
  cwd: string,
  params: Record<string, unknown>,
  defaultRoot = process.cwd(),
  extraWriteRoots: readonly string[] = [],
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
  if (policy.type === 'workspaceWrite') {
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
