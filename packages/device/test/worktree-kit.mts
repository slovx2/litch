// 工作树测试共用的：在临时目录里建真的 git 仓库，搭一个只有工作树的 Worktrees（不起设备进程）。
import { execFileSync } from 'node:child_process'
import { mkdirSync, realpathSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { Worktree } from '../../protocol/src/worktrees.mjs'
import { openWorktreeDatabase, type WorktreeSettings, Worktrees } from '../src/worktrees.mjs'

// 不读这台机器上用户自己的 git 配置（签名、钩子模板之类）：设备进程里跑的 git 也继承这个进程的环境
process.env.GIT_CONFIG_GLOBAL = '/dev/null'
process.env.GIT_CONFIG_NOSYSTEM = '1'

/** 测试自己提交时用的身份 */
export const GIT_TEST_ENV = {
  GIT_AUTHOR_NAME: 'Test',
  GIT_AUTHOR_EMAIL: 'test@example.com',
  GIT_COMMITTER_NAME: 'Test',
  GIT_COMMITTER_EMAIL: 'test@example.com',
}

export function sh(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    env: { ...process.env, ...GIT_TEST_ENV },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
    .toString('utf8')
    .trim()
}

export function write(root: string, file: string, content: string): void {
  mkdirSync(dirname(join(root, file)), { recursive: true })
  writeFileSync(join(root, file), content)
}

/** 在 parent 下建一个仓库：main 上一个提交（README.md、src/app.txt），返回仓库根（真实路径） */
export function makeRepo(parent: string, name = 'app'): string {
  const repo = join(parent, name)
  mkdirSync(repo, { recursive: true })
  sh(repo, 'init', '-q', '-b', 'main')
  write(repo, 'README.md', 'hello\n')
  write(repo, 'src/app.txt', 'v1\n')
  commitAll(repo, 'init')
  return realpathSync(repo)
}

export function commitAll(repo: string, message: string): string {
  sh(repo, 'add', '-A')
  sh(repo, 'commit', '-q', '-m', message)
  return sh(repo, 'rev-parse', 'HEAD')
}

export interface WorktreeWorld {
  worktrees: Worktrees
  settings: WorktreeSettings
  /** 发过的变化通知 */
  changed: Worktree[]
  close(): void
}

export function worktreeWorld(stateDir: string, settings: Partial<WorktreeSettings> = {}) {
  const db = openWorktreeDatabase(stateDir)
  const world: WorktreeWorld = {
    settings: {
      root: join(stateDir, 'worktrees'),
      branchPrefix: 'litch/',
      fetchFirst: false,
      ...settings,
    },
    changed: [],
    worktrees: null as unknown as Worktrees,
    close: () => db.close(),
  }
  world.worktrees = new Worktrees(db, {
    settings: () => world.settings,
    announce: (_method, params) => world.changed.push((params as { worktree: Worktree }).worktree),
    log: () => {},
  })
  return world
}
