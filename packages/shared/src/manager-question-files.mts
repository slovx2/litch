// 文件工具的补充防线，不是进程沙箱：未知备份、硬链接和检查后的路径替换仍需单独隔离。
import { realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

function real(path: string): string {
  try {
    return realpathSync(path)
  } catch {
    const parent = dirname(path)
    return parent === path ? path : join(real(parent), relative(parent, path))
  }
}

function inside(root: string, path: string): boolean {
  const child = relative(root, path)
  return child !== '..' && !child.startsWith(`..${sep}`) && !isAbsolute(child)
}

export function questionStorageRoots(extra: string[] = []): string[] {
  const home = homedir()
  const env = process.env
  return [
    ...new Set(
      [
        join(home, '.codex'),
        join(home, '.claude'),
        join(home, '.pi'),
        join(home, '.codex-harness-adapter'),
        join(home, 'Library', 'Application Support', 'Litch'),
        join(home, 'Library', 'Application Support', 'Claude', 'claude-code-sessions'),
        join(env.XDG_DATA_HOME || join(home, '.local', 'share'), 'opencode'),
        join(env.XDG_DATA_HOME || join(home, '.local', 'share'), 'litch'),
        ...[
          'CODEX_HOME',
          'CLAUDE_CONFIG_DIR',
          'PI_CODING_AGENT_DIR',
          'PI_CODING_AGENT_SESSION_DIR',
          'CHA_CLAUDE_HOME',
          'CHA_PI_HOME',
          'CHA_OPENCODE_HOME',
          'CHA_CLAUDE_DESKTOP_DATA',
        ]
          .map((key) => env[key])
          .filter((path): path is string => !!path && path !== '0'),
        ...extra,
      ].flatMap((path) => [resolve(path), real(resolve(path))]),
    ),
  ]
}

export function deniedQuestionFile(
  cwd: string,
  name: string,
  input: Record<string, unknown>,
  extra: string[] = [],
): string | null {
  const search = ['Glob', 'Grep', 'find', 'grep', 'ls'].includes(name)
  const raw = input.file_path ?? input.path ?? (search ? '.' : undefined)
  // 文件工具缺路径时交给其自身参数校验。
  if (typeof raw !== 'string') return null
  const targets = [resolve(cwd, raw)]
  if (name === 'Glob' || name === 'find') {
    const pattern = input.pattern
    if (typeof pattern === 'string') {
      if (pattern.split(/[\\/]/).includes('..')) return '旁问搜索不能通过 .. 扩大读取范围'
      if (isAbsolute(pattern)) targets.push(pattern.split(/[*?[{]/)[0] || sep)
    }
  }
  const roots = questionStorageRoots(extra)
  for (const target of targets.flatMap((path) => [path, real(path)])) {
    if (roots.some((root) => inside(root, target) || (search && inside(target, root))))
      return '旁问不能直接读取会话存储；请使用 litch_sessions.list/read 查询所属经理和工作线'
    if (
      process.platform === 'linux' &&
      ['/proc', '/sys', '/dev'].some((root) => inside(root, target))
    )
      return '旁问不能通过进程或设备文件读取会话数据'
  }
  return null
}
