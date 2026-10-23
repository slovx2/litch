// 工作树用到的 git 操作（worktrees.mts）。一律不弹凭据提示、输出用英文，跑在设备所在的机器上。
import { execFileSync, spawn } from 'node:child_process'
import { existsSync, rmSync } from 'node:fs'
import { basename, dirname, isAbsolute, join } from 'node:path'
import type { WorktreeSyncBaseResponse } from '../../protocol/src/worktrees.mjs'
import { ProtocolError } from '../../shared/src/protocol-contract.mjs'

const GIT_ENV = {
  GIT_TERMINAL_PROMPT: '0',
  GIT_OPTIONAL_LOCKS: '0',
  LC_ALL: 'C',
} as const

/** 快照提交用的身份：不依赖用户有没有配 user.name */
const SNAPSHOT_IDENTITY = {
  GIT_AUTHOR_NAME: 'Litch',
  GIT_AUTHOR_EMAIL: 'litch@localhost',
  GIT_COMMITTER_NAME: 'Litch',
  GIT_COMMITTER_EMAIL: 'litch@localhost',
} as const

export class GitFailure extends ProtocolError {
  constructor(args: string[], detail: string) {
    super(-32603, `git ${args[0] ?? ''} 失败：${detail.trim().slice(0, 400)}`)
  }
}

interface RunOptions {
  input?: Buffer | string
  env?: Record<string, string>
  timeoutMs?: number
}

/** 跑一条 git，成功返回标准输出（原样的字节），失败抛 GitFailure */
export function gitBytes(cwd: string, args: string[], options: RunOptions = {}): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, {
      cwd,
      env: { ...process.env, ...GIT_ENV, ...options.env },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    const out: Buffer[] = []
    const err: Buffer[] = []
    const timer = setTimeout(() => child.kill('SIGKILL'), options.timeoutMs ?? 120_000)
    child.stdout.on('data', (chunk: Buffer) => out.push(chunk))
    child.stderr.on('data', (chunk: Buffer) => err.push(chunk))
    child.on('error', (error) => {
      clearTimeout(timer)
      reject(new GitFailure(args, error.message))
    })
    child.on('close', (code, signal) => {
      clearTimeout(timer)
      if (code === 0) resolve(Buffer.concat(out))
      else
        reject(
          new GitFailure(
            args,
            Buffer.concat(err).toString('utf8') ||
              (signal ? `被 ${signal} 结束` : `退出码 ${code}`),
          ),
        )
    })
    child.stdin.end(options.input ?? '')
  })
}

export async function git(cwd: string, args: string[], options: RunOptions = {}): Promise<string> {
  return (await gitBytes(cwd, args, options)).toString('utf8').trim()
}

/** 成功返回输出，失败返回 null（用来问“有没有”） */
export async function gitMaybe(cwd: string, args: string[]): Promise<string | null> {
  try {
    return await git(cwd, args)
  } catch {
    return null
  }
}

/** NUL 分隔的列表 */
export async function gitList(cwd: string, args: string[], input?: string): Promise<string[]> {
  const raw = (await gitBytes(cwd, args, input === undefined ? {} : { input })).toString('utf8')
  return raw.split('\0').filter((entry) => entry !== '')
}

/** 这台机器上的 git 版本；没有 git 是 null */
export function gitVersion(): string | null {
  try {
    const out = execFileSync('git', ['--version'], {
      env: { ...process.env, ...GIT_ENV },
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 10_000,
    })
    return (
      out
        .toString('utf8')
        .trim()
        .replace(/^git version\s*/, '') || null
    )
  } catch {
    return null
  }
}

export interface RepoInfo {
  /** 检出的根 */
  top: string
  /** cwd 相对 top 的子路径，带结尾的斜杠或空串 */
  prefix: string
  /** 仓库的主检出：cwd 在别的工作树（比如另一个会话的）里时是主仓库，不是那棵工作树；裸仓库等认不出时同 top */
  main: string
}

export async function repoOf(cwd: string): Promise<RepoInfo> {
  const top = await gitMaybe(cwd, ['rev-parse', '--show-toplevel'])
  if (!top) throw new ProtocolError(-32602, `${cwd} 不在 git 仓库里，建不了工作树`)
  const prefix = (await gitMaybe(cwd, ['rev-parse', '--show-prefix'])) ?? ''
  // 在别的工作树里时给的是绝对路径；相对路径只在主检出里出现，那时主检出就是 top
  const common = await gitMaybe(cwd, ['rev-parse', '--git-common-dir'])
  const main = common && isAbsolute(common) && basename(common) === '.git' ? dirname(common) : top
  return { top, prefix, main }
}

const exists = async (top: string, ref: string): Promise<boolean> =>
  (await gitMaybe(top, ['show-ref', '--verify', '--quiet', ref])) !== null

export const branchExists = (top: string, name: string): Promise<boolean> =>
  exists(top, `refs/heads/${name}`)

/** 仓库默认分支：origin/HEAD 指的，没有就 main、master 里有的那个 */
export async function defaultBranch(top: string): Promise<string | null> {
  const remote = await gitMaybe(top, [
    'symbolic-ref',
    '--quiet',
    '--short',
    'refs/remotes/origin/HEAD',
  ])
  if (remote?.startsWith('origin/')) return remote.slice('origin/'.length)
  for (const name of ['main', 'master']) {
    if ((await branchExists(top, name)) || (await exists(top, `refs/remotes/origin/${name}`)))
      return name
  }
  return null
}

export const commitOf = (top: string, ref: string): Promise<string | null> =>
  gitMaybe(top, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`])

/**
 * 默认分支的起点：本地与 origin 上那份哪个新用哪个（本地是 origin 的祖先就用 origin 的，否则用本地的）。
 * fetch 为真时先拉一次那个分支，拉不到不算错
 */
export async function defaultStart(
  top: string,
  fetch: boolean,
): Promise<{ ref: string; commit: string }> {
  const branch = await defaultBranch(top)
  if (!branch) {
    const head = await commitOf(top, 'HEAD')
    if (!head) throw new ProtocolError(-32602, '仓库里还没有提交，建不了工作树')
    return { ref: 'HEAD', commit: head }
  }
  if (fetch && (await gitMaybe(top, ['remote', 'get-url', 'origin'])) !== null)
    await gitBytes(top, ['fetch', '--quiet', 'origin', branch], { timeoutMs: 30_000 }).catch(
      () => null,
    )
  const local = await commitOf(top, `refs/heads/${branch}`)
  const remote = await commitOf(top, `refs/remotes/origin/${branch}`)
  if (local && remote && local !== remote) {
    const behind = (await gitMaybe(top, ['merge-base', '--is-ancestor', local, remote])) !== null
    return behind ? { ref: `origin/${branch}`, commit: remote } : { ref: branch, commit: local }
  }
  const commit = local ?? remote
  if (!commit) throw new ProtocolError(-32602, `找不到默认分支 ${branch} 的提交`)
  return { ref: local ? branch : `origin/${branch}`, commit }
}

/** 工作区有没有未提交的改动或未跟踪的文件 */
export async function dirty(path: string): Promise<boolean> {
  const out = await git(path, ['status', '--porcelain=v1', '--untracked-files=all'])
  return out !== ''
}

/** 合并、变基、拣选做到一半时 git 目录里留下的记号 */
const HALFWAY = ['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'rebase-merge', 'rebase-apply']

/**
 * 把 ref 合进 path 这个检出（worktrees 的 syncBase）。ref 是 origin/ 的先 fetch 那一支（拉不到不算错）。
 * 有未提交的改动、别的 git 操作做到一半的拒绝；冲突时停在冲突状态、列出冲突的文件，别的失败先 merge --abort 再抛
 */
export async function mergeBase(path: string, ref: string): Promise<WorktreeSyncBaseResponse> {
  if (await dirty(path))
    throw new ProtocolError(-32602, '工作树里有未提交的改动或未跟踪的文件，先提交再合入')
  const dir = await gitDirOf(path)
  if (HALFWAY.some((name) => existsSync(join(dir, name))))
    throw new ProtocolError(-32602, '工作树里有合并、变基或拣选做到一半，先做完或放弃')
  if (ref.startsWith('origin/'))
    await gitMaybe(path, ['fetch', '--quiet', 'origin', ref.slice('origin/'.length)])
  if ((await gitMaybe(path, ['merge-base', '--is-ancestor', ref, 'HEAD'])) !== null)
    return { status: 'upToDate', files: [] }
  try {
    await git(path, ['merge', '--no-edit', ref])
    return { status: 'merged', files: [] }
  } catch (error) {
    const files = await gitList(path, ['diff', '-z', '--name-only', '--diff-filter=U']).catch(
      () => [],
    )
    if (files.length > 0) return { status: 'conflicts', files }
    await gitMaybe(path, ['merge', '--abort'])
    throw error
  }
}

/** 这个工作树的 git 目录（.git/worktrees/<名字>） */
export const gitDirOf = (path: string): Promise<string> =>
  git(path, ['rev-parse', '--path-format=absolute', '--git-dir'])

/**
 * 把工作区（含未跟踪的文件，不含被忽略的）做成一个挂在 HEAD 上的提交，记在 ref 上。用临时索引，不碰用户的暂存区
 */
export async function snapshot(path: string, ref: string, reason: string): Promise<string> {
  const index = join(await gitDirOf(path), 'litch-snapshot-index')
  const env = { GIT_INDEX_FILE: index }
  try {
    await git(path, ['read-tree', 'HEAD'], { env })
    await git(path, ['add', '-A', '--', '.'], { env })
    const tree = await git(path, ['write-tree'], { env })
    const commit = await git(
      path,
      [
        'commit-tree',
        '--no-gpg-sign',
        tree,
        '-p',
        'HEAD',
        '-m',
        `Litch worktree snapshot: ${reason}`,
      ],
      {
        env: SNAPSHOT_IDENTITY,
      },
    )
    await git(path, ['update-ref', ref, commit])
    return commit
  } finally {
    rmSync(index, { force: true })
  }
}

/**
 * 把快照里的文件放回刚检出的工作树：快照有的写回去，快照里删掉的删掉，最后清掉暂存（改动回到未提交的样子）
 */
export async function applySnapshot(path: string, commit: string): Promise<void> {
  await git(path, ['checkout', commit, '--', '.'])
  const gone = await gitList(path, ['diff', '--name-only', '-z', '--diff-filter=D', 'HEAD', commit])
  if (gone.length) await git(path, ['rm', '-q', '-f', '--', ...gone])
  await git(path, ['reset', '-q'])
}
