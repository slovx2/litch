import { existsSync, realpathSync } from 'node:fs'
import { dirname, isAbsolute, resolve } from 'node:path'
import type { RepositoryMethod } from '../../protocol/src/client-tools-repository.mjs'
import { ReadCommandError, type ReadCommandResult } from '../../shared/src/read-only-command.mjs'
import { insideRepository, openRepositoryView, type RepositoryView } from './repository-view.mjs'

export const QUERY_KEYS: Record<RepositoryMethod, string[]> = {
  log: ['directory', 'ref', 'path', 'limit', 'skip'],
  show: ['directory', 'ref', 'path'],
  diff: ['directory', 'base', 'head', 'path', 'staged'],
  blame: ['directory', 'ref', 'path', 'start_line', 'end_line'],
  status: ['directory', 'path'],
}
const invalid = (message: string): never => {
  throw new ReadCommandError('invalid', message)
}
function string(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key]
  if (value === undefined) return undefined
  if (typeof value !== 'string' || !value || value.includes('\0') || value.length > 4096)
    return invalid(`Invalid ${key}.`)
  return value
}
function integer(
  args: Record<string, unknown>,
  key: string,
  fallback: number,
  min: number,
  max: number,
): number {
  const value = args[key] ?? fallback
  if (!Number.isSafeInteger(value) || Number(value) < min || Number(value) > max)
    return invalid(`Invalid ${key}.`)
  return Number(value)
}
export function literalRepositoryPath(root: string, value: string | undefined): string | undefined {
  if (value === undefined) return undefined
  if (
    isAbsolute(value) ||
    value.includes('\\') ||
    value.split('/').some((part) => part === '..' || part === '.git')
  )
    return invalid('path must be a literal repository-relative path, outside Git metadata.')
  let target = resolve(root, value)
  if (!insideRepository(root, target)) return invalid('path is outside the repository.')
  while (!existsSync(target) && dirname(target) !== target) target = dirname(target)
  if (!insideRepository(root, realpathSync(target)))
    throw new ReadCommandError('path_denied', 'Symbolic link escapes the repository.')
  return value
}
async function checked(
  view: RepositoryView,
  args: string[],
  maxBytes?: number,
): Promise<ReadCommandResult> {
  const result = await view.run(args, maxBytes)
  if (result.code !== 0 && !result.truncated)
    throw new ReadCommandError(
      'query_failed',
      result.stderr || 'Local Git query failed; no objects were fetched.',
    )
  return result
}
async function commit(view: RepositoryView, ref: string): Promise<string> {
  if (ref.length > 256 || !/^[A-Za-z0-9_][A-Za-z0-9_./@{}~^+-]*$/.test(ref))
    return invalid('Invalid local revision.')
  const result = await view.run(
    ['rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`],
    256,
  )
  const hash = result.stdout.toString('utf8').trim()
  if (result.code !== 0 || result.truncated || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(hash))
    throw new ReadCommandError(
      'missing_object',
      'Cannot resolve this local commit; missing objects are never fetched.',
    )
  return hash
}
const DIFF_OPTIONS = [
  '--no-ext-diff',
  '--no-textconv',
  '--no-renames',
  '--ignore-submodules=all',
  '--no-color',
  '--src-prefix=a/',
  '--dst-prefix=b/',
  '--unified=3',
]

export interface RepositoryQueryResult {
  repository: string
  captured_at: string
  head: string | null
  revisions: Record<string, string>
  boundary: 'sandboxed' | 'controlled-methods'
  content: string
  truncated: boolean
  binary?: boolean
  file_bytes?: number
}

export async function queryRepository(
  method: RepositoryMethod,
  args: Record<string, unknown>,
  signal: AbortSignal,
): Promise<RepositoryQueryResult> {
  if (Object.keys(args).some((key) => !QUERY_KEYS[method].includes(key)))
    return invalid(
      'Unknown query argument; arbitrary options and environment overrides are not accepted.',
    )
  const directory = string(args, 'directory')
  if (!directory || !isAbsolute(directory)) return invalid('directory must be absolute.')
  const view = await openRepositoryView(directory, signal)
  try {
    const path = literalRepositoryPath(view.root, string(args, 'path'))
    const suffix = ['--', ...(path === undefined ? [] : [path])]
    const revisions: Record<string, string> = {}
    let head: string | null = null
    try {
      head = await commit(view, 'HEAD')
    } catch (error) {
      if (!(error instanceof ReadCommandError) || error.code !== 'missing_object') throw error
    }
    let result: ReadCommandResult
    let fileBytes: number | undefined
    switch (method) {
      case 'log': {
        revisions.ref = await commit(view, string(args, 'ref') ?? 'HEAD')
        result = await checked(view, [
          'log',
          '--no-notes',
          '--no-decorate',
          '--format=medium',
          '--no-color',
          `--max-count=${integer(args, 'limit', 20, 1, 100)}`,
          `--skip=${integer(args, 'skip', 0, 0, 10000)}`,
          revisions.ref,
          ...suffix,
        ])
        break
      }
      case 'show': {
        revisions.ref = await commit(view, string(args, 'ref') ?? 'HEAD')
        if (path === undefined)
          result = await checked(view, [
            'show',
            ...DIFF_OPTIONS,
            '--no-notes',
            '--format=fuller',
            revisions.ref,
            '--',
          ])
        else {
          const object = `${revisions.ref}:${path}`
          const size = await checked(view, ['cat-file', '-s', object], 128)
          fileBytes = Number(size.stdout.toString('utf8').trim())
          if (!Number.isSafeInteger(fileBytes) || fileBytes < 0)
            return invalid('Invalid blob size.')
          result =
            fileBytes > 512 * 1024
              ? { ...size, stdout: Buffer.alloc(0), truncated: true }
              : await checked(view, ['cat-file', 'blob', object])
        }
        break
      }
      case 'diff': {
        if (args.staged !== undefined && typeof args.staged !== 'boolean')
          return invalid('staged must be boolean.')
        const base = string(args, 'base')
        const target = string(args, 'head')
        if (target && (!base || args.staged === true))
          return invalid('head requires base and cannot be combined with staged.')
        if (base || args.staged) revisions.base = await commit(view, base ?? 'HEAD')
        if (target) revisions.head = await commit(view, target)
        result = await checked(view, [
          'diff',
          ...DIFF_OPTIONS,
          ...(args.staged ? ['--cached'] : []),
          ...Object.values(revisions),
          ...suffix,
        ])
        break
      }
      case 'blame': {
        if (path === undefined) return invalid('blame requires path.')
        revisions.ref = await commit(view, string(args, 'ref') ?? 'HEAD')
        const range: string[] = []
        if (args.start_line !== undefined || args.end_line !== undefined) {
          const start = integer(args, 'start_line', 0, 1, 10000000)
          const end = integer(args, 'end_line', 0, start, Math.min(10000000, start + 999))
          range.push('-L', `${start},${end}`)
        }
        result = await checked(view, [
          'blame',
          '--no-textconv',
          '--line-porcelain',
          ...range,
          revisions.ref,
          '--',
          path,
        ])
        break
      }
      case 'status':
        result = await checked(view, [
          'status',
          '--porcelain=v1',
          '--untracked-files=all',
          '--ignore-submodules=all',
          ...suffix,
        ])
        break
    }
    const binary = result.stdout.includes(0)
    return {
      repository: view.root,
      captured_at: view.at,
      head,
      revisions,
      boundary: result.boundary,
      content: binary ? '' : result.stdout.toString('utf8'),
      truncated: result.truncated,
      ...(fileBytes !== undefined ? { file_bytes: fileBytes } : {}),
      ...(binary ? { binary: true } : {}),
    }
  } finally {
    view.close()
  }
}
