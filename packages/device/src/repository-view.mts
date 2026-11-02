// 查询用独立 Git 元数据视图：不载入源仓库的 config/hooks，避免 clean/process 等过滤器执行代码。
// HEAD、refs、index 复制成有限快照；对象只从源仓库读。临时视图是设备运行状态，不是用户仓库。
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { ReadCommandError, runReadOnlyCommand } from '../../shared/src/read-only-command.mjs'

export const REPOSITORY_GIT =
  process.platform === 'win32' ? 'C:\\Program Files\\Git\\cmd\\git.exe' : '/usr/bin/git'
export function requireLocalRepositoryPath(path: string): void {
  if (/^[\\/]{2}/.test(path))
    throw new ReadCommandError(
      'path_denied',
      'UNC and device paths are not local repository paths.',
    )
}
export const insideRepository = (root: string, path: string): boolean => {
  const child = relative(root, path)
  return child !== '..' && !child.startsWith(`..${sep}`) && !isAbsolute(child)
}

export function repositoryEnvironment(): NodeJS.ProcessEnv {
  const windows = process.platform === 'win32'
  const empty = windows ? 'NUL' : '/dev/null'
  return {
    ...(windows
      ? { SystemRoot: process.env.SystemRoot || 'C:\\Windows', PATH: 'C:\\Windows\\System32' }
      : { PATH: '/usr/bin:/bin' }),
    LC_ALL: 'C',
    LANG: 'C',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: empty,
    GIT_CONFIG_SYSTEM: empty,
    GIT_TERMINAL_PROMPT: '0',
    GIT_OPTIONAL_LOCKS: '0',
    GIT_NO_LAZY_FETCH: '1',
    GIT_NO_REPLACE_OBJECTS: '1',
    GIT_ATTR_NOSYSTEM: '1',
    GIT_LITERAL_PATHSPECS: '1',
  }
}

export function repositoryLocation(directory: string): {
  root: string
  gitdir: string
  common: string
} {
  requireLocalRepositoryPath(directory)
  let root = realpathSync(directory)
  if (!lstatSync(root).isDirectory())
    throw new ReadCommandError('invalid', 'directory must be a directory.')
  while (!existsSync(join(root, '.git'))) {
    const parent = dirname(root)
    if (parent === root)
      throw new ReadCommandError(
        'not_repository',
        'This is not a repository. Select a repository subdirectory of the outer folder.',
      )
    root = parent
  }
  const marker = join(root, '.git')
  const entry = lstatSync(marker)
  if (entry.isSymbolicLink())
    throw new ReadCommandError('path_denied', 'Symbolic .git directories are not supported.')
  if (entry.isDirectory()) return { root, gitdir: marker, common: marker }
  if (!entry.isFile() || entry.size > 4096)
    throw new ReadCommandError('invalid', 'Invalid .git file.')
  const target = /^gitdir: (.+)\r?\n?$/.exec(readFileSync(marker, 'utf8'))?.[1]
  if (!target) throw new ReadCommandError('invalid', 'Invalid worktree .git file.')
  const targetDirectory = resolve(root, target)
  requireLocalRepositoryPath(target)
  const gitdir = realpathSync(targetDirectory)
  // 只接受可核对反向链接的工作树；不能让模型选择一个任意 gitdir 文件来改目标。
  const back = readFileSync(join(gitdir, 'gitdir'), 'utf8').trim()
  if (realpathSync(back) !== realpathSync(marker))
    throw new ReadCommandError('path_denied', 'Worktree backlink does not match.')
  const commonPath = readFileSync(join(gitdir, 'commondir'), 'utf8').trim()
  requireLocalRepositoryPath(commonPath)
  const common = realpathSync(resolve(gitdir, commonPath))
  return { root, gitdir, common }
}

export interface RepositoryView {
  root: string
  gitdir: string
  common: string
  at: string
  run(args: string[], maxBytes?: number): ReturnType<typeof runReadOnlyCommand>
  close(): void
}

export async function openRepositoryView(
  directory: string,
  signal: AbortSignal,
): Promise<RepositoryView> {
  const source = repositoryLocation(directory)
  const objects = join(source.common, 'objects')
  if (realpathSync(objects) !== objects)
    throw new ReadCommandError('path_denied', 'Symbolic object directories are not supported.')
  for (const name of ['alternates', 'http-alternates']) {
    const path = join(objects, 'info', name)
    if (existsSync(path) && readFileSync(path, 'utf8').trim())
      throw new ReadCommandError(
        'path_denied',
        'Repositories with alternate object stores are not supported by controlled queries.',
      )
  }
  const temporary = mkdtempSync(join(tmpdir(), 'litch-git-read-'))
  const env = repositoryEnvironment()
  let size = 0
  let files = 0
  const copy = (from: string, to: string) => {
    signal.throwIfAborted()
    if (!existsSync(from)) return
    const stat = lstatSync(from)
    if (stat.isSymbolicLink())
      throw new ReadCommandError('path_denied', 'Symbolic repository metadata is not supported.')
    if (++files > 10000)
      throw new ReadCommandError('metadata_limit', 'Too many repository metadata entries.')
    if (stat.isDirectory()) {
      mkdirSync(to, { recursive: true })
      for (const name of readdirSync(from)) copy(join(from, name), join(to, name))
      return
    }
    if (!stat.isFile() || (size += stat.size) > 32 * 1024 * 1024)
      throw new ReadCommandError('metadata_limit', 'Repository metadata exceeds the 32 MiB limit.')
    mkdirSync(dirname(to), { recursive: true })
    writeFileSync(to, readFileSync(from))
  }
  try {
    // config 本身只读取这两个格式字段，忽略 include；从空临时目录执行，不使用源仓库配置。
    const format = await runReadOnlyCommand(
      [
        REPOSITORY_GIT,
        'config',
        '--no-includes',
        '--file',
        join(source.common, 'config'),
        '--get-regexp',
        '^extensions\\.(objectformat|refstorage)$',
      ],
      temporary,
      env,
      signal,
      4096,
    )
    if (format.truncated || (format.code !== 0 && format.code !== 1))
      throw new ReadCommandError(
        'query_failed',
        format.stderr || 'Cannot inspect repository format.',
      )
    const text = format.stdout.toString('utf8').toLowerCase()
    if (/extensions\.refstorage\s+(?!files\b)/.test(text))
      throw new ReadCommandError(
        'unsupported_repository',
        'Only the files reference backend is supported.',
      )
    const sha256 = /extensions\.objectformat\s+sha256\b/.test(text)
    writeFileSync(
      join(temporary, 'config'),
      `[core]\nrepositoryformatversion = ${sha256 ? 1 : 0}\nbare = false\n${sha256 ? '[extensions]\nobjectformat = sha256\n' : ''}`,
    )
    mkdirSync(join(temporary, 'objects'))
    mkdirSync(join(temporary, 'refs'))
    copy(join(source.common, 'refs'), join(temporary, 'refs'))
    if (source.gitdir !== source.common) copy(join(source.gitdir, 'refs'), join(temporary, 'refs'))
    for (const name of ['packed-refs', 'shallow'])
      copy(join(source.common, name), join(temporary, name))
    for (const name of ['HEAD', 'index']) copy(join(source.gitdir, name), join(temporary, name))
    for (const name of readdirSync(source.gitdir))
      if (/^sharedindex\.[0-9a-f]+$/.test(name))
        copy(join(source.gitdir, name), join(temporary, name))
    const settings = [
      'core.fsmonitor=false',
      'core.untrackedCache=false',
      'core.preloadIndex=false',
      'diff.autoRefreshIndex=false',
      'gc.auto=0',
      'maintenance.auto=false',
      'submodule.recurse=false',
      'core.hooksPath=' + (process.platform === 'win32' ? 'NUL' : '/dev/null'),
      'core.attributesFile=' + (process.platform === 'win32' ? 'NUL' : '/dev/null'),
      'protocol.allow=never',
    ]
    const prefix = [
      REPOSITORY_GIT,
      '--no-pager',
      '--no-lazy-fetch',
      '--no-replace-objects',
      `--git-dir=${temporary}`,
      `--work-tree=${source.root}`,
      ...settings.flatMap((value) => ['-c', value]),
    ]
    return {
      ...source,
      at: new Date().toISOString(),
      run: (args, maxBytes) =>
        runReadOnlyCommand(
          [...prefix, ...args],
          source.root,
          { ...env, GIT_OBJECT_DIRECTORY: objects },
          signal,
          maxBytes,
        ),
      close: () => rmSync(temporary, { recursive: true, force: true }),
    }
  } catch (error) {
    rmSync(temporary, { recursive: true, force: true })
    throw error
  }
}
