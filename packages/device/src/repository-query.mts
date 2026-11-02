import type { RepositoryMethod } from '../../protocol/src/client-tools-repository.mjs'
import { RepositoryCommandError, runGit } from './repository-command.mjs'

function string(args: Record<string, unknown>, key: string, fallback?: string): string | undefined {
  const value = args[key] ?? fallback
  if (value === undefined) return undefined
  if (typeof value !== 'string' || value.includes('\0'))
    throw new RepositoryCommandError('invalid', `${key} must be a string without NUL.`)
  return value
}

function integer(args: Record<string, unknown>, key: string, fallback: number): number {
  const value = args[key] ?? fallback
  if (!Number.isSafeInteger(value) || Number(value) < 0)
    throw new RepositoryCommandError('invalid', `${key} must be a non-negative integer.`)
  return Number(value)
}

function command(method: RepositoryMethod, args: Record<string, unknown>): string[] {
  if (method === 'run') {
    if (
      !Array.isArray(args.argv) ||
      !args.argv.length ||
      !args.argv.every((arg) => typeof arg === 'string' && !arg.includes('\0'))
    )
      throw new RepositoryCommandError(
        'invalid',
        'argv must be a nonempty array of strings without NUL.',
      )
    return args.argv as string[]
  }
  // 已发布的五个方法保留参数形状，作为普通 Git argv 的快捷入口。
  const path = string(args, 'path')
  const suffix = ['--', ...(path === undefined ? [] : [path])]
  switch (method) {
    case 'log':
      return [
        'log',
        `--max-count=${integer(args, 'limit', 20)}`,
        `--skip=${integer(args, 'skip', 0)}`,
        string(args, 'ref') ?? 'HEAD',
        ...suffix,
      ]
    case 'show':
      return path === undefined
        ? ['show', string(args, 'ref') ?? 'HEAD', '--']
        : ['cat-file', 'blob', `${string(args, 'ref', 'HEAD')}:${path}`]
    case 'diff':
      return [
        'diff',
        ...(args.staged === true ? ['--cached'] : []),
        ...[string(args, 'base'), string(args, 'head')].filter(
          (value): value is string => value !== undefined,
        ),
        ...suffix,
      ]
    case 'blame':
      if (path === undefined) throw new RepositoryCommandError('invalid', 'blame requires path.')
      return [
        'blame',
        '--line-porcelain',
        ...(args.start_line === undefined && args.end_line === undefined
          ? []
          : ['-L', `${integer(args, 'start_line', 1)},${integer(args, 'end_line', 1)}`]),
        string(args, 'ref') ?? 'HEAD',
        ...suffix,
      ]
    case 'status':
      return ['status', '--porcelain=v1', '--untracked-files=all', ...suffix]
  }
}

export interface RepositoryQueryResult {
  repository: string
  captured_at: string
  head: string | null
  revisions: Record<string, string>
  boundary: 'controlled-methods'
  content: string
  truncated: boolean
  binary?: boolean
  exit_code: number | null
}

// directory 已在工具处理器内按经理/工作线归属及真实仓库根目录授权。
export async function queryRepository(
  method: RepositoryMethod,
  args: Record<string, unknown>,
  signal: AbortSignal,
): Promise<RepositoryQueryResult> {
  const directory = string(args, 'directory')
  if (!directory) throw new RepositoryCommandError('invalid', 'directory is required.')
  const result = await runGit(command(method, args), directory, signal)
  const binary = result.stdout.includes(0)
  return {
    repository: directory,
    captured_at: new Date().toISOString(),
    head: null,
    revisions: {},
    boundary: 'controlled-methods',
    content: [binary ? '' : result.stdout.toString('utf8'), result.stderr].filter(Boolean).join(''),
    truncated: result.truncated,
    exit_code: result.code,
    ...(binary ? { binary: true } : {}),
  }
}
