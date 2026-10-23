// 设备层的工作树（扩展 worktrees，protocol/extensions/worktrees.json）：在会话所在的这台机器上跑 git 建工作树，
// 新会话的 cwd 换成工作树里对应的子目录再交给引擎，所以七个 harness 一套做法、引擎不用改。
// 记录存在 <状态目录>/worktrees.sqlite（和引擎、索引无关，删了就认不回这些工作树，所以不放进能重建的 device.sqlite）；
// 工作树自己的 git 目录里另写一份 litch-worktree.json（标识和主人会话）。
// 建、删、恢复排成一条队做：同一个仓库上同时跑两个 git worktree 会抢锁。
// 目录 <根>/<仓库目录名>/<短名>，分支 <前缀><短名>，短名是标题转的短串加 6 位随机数；根和前缀来自设备设置。
// 被忽略的文件只复制两类：仓库根 .worktreeinclude 列出的（Codex、Claude 都认这个文件名），和各 harness 的本地配置。
import { randomBytes } from 'node:crypto'
import {
  closeSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { EXTENSION } from '../../protocol/src/device.mjs'
import {
  type ThreadWorktree,
  WORKTREE_CHANGED,
  WORKTREE_METHOD,
  WORKTREE_SNAPSHOT_REF,
  type Worktree,
  type WorktreeBranchesResponse,
  type WorktreeFrom,
  type WorktreeState,
} from '../../protocol/src/worktrees.mjs'
import { ProtocolError, requiredString } from '../../shared/src/protocol-contract.mjs'
import { assertStoreFormat, initializeStoreFormat } from '../../shared/src/store-format.mjs'
import { ensureParent } from '../../shared/src/util.mjs'
import { isObject } from './wire.mjs'
import {
  applySnapshot,
  branchExists,
  commitOf,
  defaultBranch,
  defaultStart,
  dirty,
  git,
  gitBytes,
  gitDirOf,
  gitList,
  gitMaybe,
  repoOf,
  snapshot,
} from './worktree-git.mjs'

const SCHEMA_VERSION = 1

/** 各 harness 被 git 忽略的本地配置：新工作树里也要有，不然权限、MCP、本地指令都变了 */
const HARNESS_LOCAL_FILES = [
  '.claude/settings.local.json',
  '.mcp.json',
  'CLAUDE.local.md',
  'AGENTS.override.md',
]

/** 复制被忽略文件的上限：个数、总大小 */
const COPY_LIMIT = { files: 2000, bytes: 200 * 1024 * 1024 }

export interface WorktreeSettings {
  root: string
  branchPrefix: string
  fetchFirst: boolean
}

export interface WorktreeHost {
  settings(): WorktreeSettings
  announce(method: string, params: unknown, extension: string): void
  log(line: string): void
}

export function openWorktreeDatabase(stateDir: string): DatabaseSync {
  const path = join(stateDir, 'worktrees.sqlite')
  ensureParent(path)
  if (existsSync(path) && statSync(path).size > 0) assertStoreFormat(path)
  if (!existsSync(path)) closeSync(openSync(path, 'a', 0o600))
  const db = new DatabaseSync(path)
  initializeStoreFormat(db)
  db.exec(`PRAGMA journal_mode=WAL;
    CREATE TABLE IF NOT EXISTS worktrees(
      id TEXT PRIMARY KEY,
      source_root TEXT NOT NULL,
      path TEXT NOT NULL,
      sub_path TEXT NOT NULL DEFAULT '',
      branch TEXT NOT NULL,
      base_ref TEXT NOT NULL,
      base_commit TEXT NOT NULL,
      owner_thread_id TEXT,
      state TEXT NOT NULL,
      snapshot_ref TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    ) WITHOUT ROWID;
    CREATE INDEX IF NOT EXISTS worktrees_owner ON worktrees(owner_thread_id);
    PRAGMA user_version=${SCHEMA_VERSION};`)
  return db
}

type Row = Record<string, unknown>

function rowOf(row: Row): Worktree {
  return {
    id: String(row.id),
    sourceRoot: String(row.source_root),
    path: String(row.path),
    subPath: String(row.sub_path ?? ''),
    branch: String(row.branch),
    baseRef: String(row.base_ref),
    baseCommit: String(row.base_commit),
    ownerThreadId: typeof row.owner_thread_id === 'string' ? row.owner_thread_id : null,
    state: String(row.state) as WorktreeState,
    snapshotRef: typeof row.snapshot_ref === 'string' ? row.snapshot_ref : null,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  }
}

/** 标题转成目录和分支能用的短串：小写字母数字和短横线，最多 40 个字符；转不出（比如全是中文）是空串 */
export function slugOf(title: string | undefined): string {
  return (title ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/g, '')
}

const now = () => Math.floor(Date.now() / 1000)

export class Worktrees {
  private readonly db: DatabaseSync
  private readonly host: WorktreeHost
  /** 建、删、恢复排成一条 */
  private queue: Promise<unknown> = Promise.resolve()

  constructor(db: DatabaseSync, host: WorktreeHost) {
    this.db = db
    this.host = host
  }

  private serial<T>(work: () => Promise<T>): Promise<T> {
    const next = this.queue.then(work, work)
    this.queue = next.catch(() => null)
    return next
  }

  get(id: string): Worktree | null {
    const row = this.db.prepare('SELECT * FROM worktrees WHERE id = ?').get(id)
    return row ? rowOf(row) : null
  }

  list(): Worktree[] {
    return this.db
      .prepare('SELECT * FROM worktrees ORDER BY created_at DESC')
      .all()
      .map((row) => rowOf(row))
  }

  /** 这个会话是哪个工作树的主人；不是是 null */
  forThread(threadId: string): Worktree | null {
    const row = this.db
      .prepare('SELECT * FROM worktrees WHERE owner_thread_id = ? ORDER BY created_at DESC LIMIT 1')
      .get(threadId)
    return row ? rowOf(row) : null
  }

  /** 会话对象经过聚合面、发给声明了 worktrees 的连接时：是工作树主人的挂上 litchWorktree */
  decorate(thread: Record<string, unknown>): void {
    if (typeof thread.id !== 'string') return
    const worktree = this.forThread(thread.id)
    if (!worktree) return
    const shown: ThreadWorktree = {
      id: worktree.id,
      path: worktree.path,
      branch: worktree.branch,
      baseRef: worktree.baseRef,
      baseCommit: worktree.baseCommit,
      state: worktree.state,
      sourceRoot: worktree.sourceRoot,
    }
    thread.litchWorktree = shown
  }

  private save(worktree: Worktree): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO worktrees(id, source_root, path, sub_path, branch, base_ref, base_commit,
          owner_thread_id, state, snapshot_ref, created_at, updated_at) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        worktree.id,
        worktree.sourceRoot,
        worktree.path,
        worktree.subPath,
        worktree.branch,
        worktree.baseRef,
        worktree.baseCommit,
        worktree.ownerThreadId,
        worktree.state,
        worktree.snapshotRef,
        worktree.createdAt,
        worktree.updatedAt,
      )
  }

  private changed(worktree: Worktree, deleted = false): void {
    this.host.announce(
      WORKTREE_CHANGED,
      deleted ? { worktree, deleted: true } : { worktree },
      EXTENSION.worktrees,
    )
  }

  private update(worktree: Worktree, patch: Partial<Worktree>): Worktree {
    const next = { ...worktree, ...patch, updatedAt: now() }
    this.save(next)
    this.changed(next)
    return next
  }

  // ---------- 建 ----------

  /**
   * 为 cwd 所在的仓库建一个新工作树，返回它（state 为 ready、还没有主人）。新会话的目录是 path 加 subPath。
   * 建一半失败的删干净（目录、分支、记录）再抛
   */
  create(spec: { cwd: string; from?: WorktreeFrom; title?: string }): Promise<Worktree> {
    return this.serial(() => this.build(spec))
  }

  private async build(spec: {
    cwd: string
    from?: WorktreeFrom
    title?: string
  }): Promise<Worktree> {
    const settings = this.host.settings()
    const from = spec.from ?? { kind: 'default' }
    // 记在主仓库下（从另一个会话的工作树里再开也是）；起点、当前本地状态、被忽略的文件按 cwd 所在的检出算
    const { top, prefix, main } = await repoOf(spec.cwd)
    const start = await this.startOf(top, from, settings.fetchFirst)
    const slug = slugOf(spec.title)
    let picked: { name: string; path: string; branch: string } | null = null
    for (let attempt = 0; attempt < 8 && !picked; attempt++) {
      const random = randomBytes(3).toString('hex')
      const name = slug ? `${slug}-${random}` : random
      const path = join(settings.root, basename(main), name)
      const branch = `${settings.branchPrefix}${name}`
      if (!existsSync(path) && !(await branchExists(main, branch))) picked = { name, path, branch }
    }
    if (!picked) throw new ProtocolError(-32603, '起不出不重名的工作树名字')
    const stamp = now()
    let worktree: Worktree = {
      id: picked.name,
      sourceRoot: main,
      path: picked.path,
      subPath: prefix.replace(/\/+$/, ''),
      branch: picked.branch,
      baseRef: start.ref,
      baseCommit: start.commit,
      ownerThreadId: null,
      state: 'creating',
      snapshotRef: null,
      createdAt: stamp,
      updatedAt: stamp,
    }
    this.save(worktree)
    try {
      mkdirSync(dirname(worktree.path), { recursive: true })
      await git(main, [
        'worktree',
        'add',
        '--no-track',
        '-b',
        worktree.branch,
        worktree.path,
        start.commit,
      ])
      if (from.kind === 'working-tree') await this.carryWorkingTree(top, worktree.path)
      await this.copyIgnored(top, worktree.path)
      this.ownerFile(worktree)
    } catch (error) {
      await this.discard(worktree, true).catch(() => null)
      this.db.prepare('DELETE FROM worktrees WHERE id = ?').run(worktree.id)
      throw error
    }
    worktree = this.update(worktree, { state: 'ready' })
    this.host.log(`建了工作树 ${worktree.path}（${worktree.branch}，从 ${worktree.baseRef}）`)
    return worktree
  }

  private async startOf(
    top: string,
    from: WorktreeFrom,
    fetch: boolean,
  ): Promise<{ ref: string; commit: string }> {
    if (from.kind === 'default') return defaultStart(top, fetch)
    if (from.kind === 'branch') {
      const branch = requiredString(from.branch, 'from.branch')
      const commit = await commitOf(top, branch)
      if (!commit) throw new ProtocolError(-32602, `没有分支 ${branch}`)
      return { ref: branch, commit }
    }
    const commit = await commitOf(top, 'HEAD')
    if (!commit) throw new ProtocolError(-32602, '仓库里还没有提交，建不了工作树')
    return { ref: from.kind === 'head' ? 'HEAD' : 'working-tree', commit }
  }

  /** 当前本地状态：未提交的改动打成补丁应用过去，未跟踪（没被忽略）的文件复制过去 */
  private async carryWorkingTree(top: string, path: string): Promise<void> {
    const diff = await gitBytes(top, ['diff', '--binary', 'HEAD'])
    if (diff.length > 0)
      await gitBytes(path, ['apply', '--binary', '--whitespace=nowarn'], { input: diff })
    const untracked = await gitList(top, ['ls-files', '-z', '--others', '--exclude-standard'])
    this.copyFiles(top, path, untracked)
  }

  /** 被忽略的文件里，.worktreeinclude 列出的和各 harness 的本地配置复制过去 */
  private async copyIgnored(top: string, path: string): Promise<void> {
    const include = join(top, '.worktreeinclude')
    const args = [
      'ls-files',
      '-z',
      '--others',
      '--ignored',
      ...HARNESS_LOCAL_FILES.map((pattern) => `--exclude=${pattern}`),
      ...(existsSync(include) ? [`--exclude-from=${include}`] : []),
    ]
    const candidates = await gitList(top, args)
    if (candidates.length === 0) return
    // 只要同时被仓库自己的规矩忽略的（没被忽略的未跟踪文件不归这里管）
    const ignored = await gitList(
      top,
      ['check-ignore', '-z', '--stdin'],
      `${candidates.join('\0')}\0`,
    ).catch(() => [])
    this.copyFiles(top, path, ignored)
  }

  private copyFiles(from: string, to: string, files: string[]): void {
    let count = 0
    let bytes = 0
    for (const file of files) {
      const source = join(from, file)
      let info: ReturnType<typeof lstatSync>
      try {
        info = lstatSync(source)
      } catch {
        continue
      }
      if (!info.isFile() && !info.isSymbolicLink()) continue
      if (++count > COPY_LIMIT.files || (bytes += info.size) > COPY_LIMIT.bytes) {
        this.host.log(`工作树 ${to}：要复制的被忽略文件太多，后面的没复制`)
        return
      }
      const target = join(to, file)
      if (existsSync(target)) continue
      mkdirSync(dirname(target), { recursive: true })
      cpSync(source, target, { verbatimSymlinks: true, preserveTimestamps: true })
    }
  }

  /** 工作树自己的 git 目录里记一份标识和主人：设备库丢了也认得回来 */
  private ownerFile(worktree: Worktree): void {
    const gitDir = join(worktree.path, '.git')
    void gitDirOf(worktree.path)
      .then((dir) =>
        writeFileSync(
          join(dir, 'litch-worktree.json'),
          `${JSON.stringify({ version: 1, id: worktree.id, ownerThreadId: worktree.ownerThreadId })}\n`,
        ),
      )
      .catch((error: unknown) => this.host.log(`写 ${gitDir} 的工作树记录没成：${String(error)}`))
  }

  /** 会话在这个工作树里起来了：记成主人 */
  own(id: string, threadId: string): void {
    const worktree = this.get(id)
    if (!worktree) return
    const next = this.update(worktree, { ownerThreadId: threadId })
    this.ownerFile(next)
  }

  /** 新会话没起来：刚建的工作树没用了，删干净（没主人的才删） */
  abandon(id: string): Promise<void> {
    return this.serial(async () => {
      const worktree = this.get(id)
      if (!worktree || worktree.ownerThreadId) return
      await this.discard(worktree, true)
      this.db.prepare('DELETE FROM worktrees WHERE id = ?').run(id)
    })
  }

  // ---------- 删、恢复 ----------

  /** 删目录：git worktree remove，不行再自己删（只删在工作树根下面的） */
  private async discard(worktree: Worktree, withBranch: boolean): Promise<void> {
    if (existsSync(worktree.path))
      await git(worktree.sourceRoot, ['worktree', 'remove', '--force', worktree.path]).catch(
        () => null,
      )
    if (existsSync(worktree.path) && this.inRoot(worktree.path))
      rmSync(worktree.path, { recursive: true, force: true })
    await gitMaybe(worktree.sourceRoot, ['worktree', 'prune'])
    if (withBranch && (await branchExists(worktree.sourceRoot, worktree.branch)))
      await git(worktree.sourceRoot, ['branch', '-D', worktree.branch])
  }

  private inRoot(path: string): boolean {
    const root = resolve(this.host.settings().root)
    const rel = relative(root, resolve(path))
    return rel !== '' && !rel.startsWith('..') && !rel.startsWith(sep) && rel.split(sep).length >= 2
  }

  remove(id: string, options: { discard?: boolean; withBranch?: boolean; reason?: string } = {}) {
    return this.serial(async () => {
      const worktree = this.need(id)
      let snapshotRef = worktree.snapshotRef
      if (worktree.state !== 'removed' && existsSync(worktree.path)) {
        if (!options.discard && (await dirty(worktree.path))) {
          snapshotRef = `${WORKTREE_SNAPSHOT_REF}${worktree.id}`
          await snapshot(worktree.path, snapshotRef, options.reason ?? 'removed')
        }
      }
      await this.discard(worktree, options.withBranch === true)
      if (options.withBranch) {
        if (snapshotRef) await gitMaybe(worktree.sourceRoot, ['update-ref', '-d', snapshotRef])
        this.db.prepare('DELETE FROM worktrees WHERE id = ?').run(id)
        const gone = { ...worktree, state: 'removed' as const, snapshotRef: null, updatedAt: now() }
        this.changed(gone, true)
        this.host.log(`删了工作树 ${worktree.path} 和分支 ${worktree.branch}`)
        return gone
      }
      this.host.log(`删了工作树 ${worktree.path}${snapshotRef ? '（改动留了快照）' : ''}`)
      return this.update(worktree, { state: 'removed', snapshotRef })
    })
  }

  restore(id: string): Promise<Worktree> {
    return this.serial(async () => {
      const worktree = this.need(id)
      if (worktree.state !== 'removed') {
        if (!existsSync(worktree.path))
          throw new ProtocolError(-32603, `工作树目录 ${worktree.path} 不在了，记录却不是已删除`)
        return worktree.state === 'ready' ? worktree : this.update(worktree, { state: 'ready' })
      }
      if (existsSync(worktree.path))
        throw new ProtocolError(-32602, `${worktree.path} 已经有东西了，建不回去`)
      const snap = worktree.snapshotRef
        ? await commitOf(worktree.sourceRoot, worktree.snapshotRef)
        : null
      if (!(await branchExists(worktree.sourceRoot, worktree.branch))) {
        if (!snap) throw new ProtocolError(-32602, `分支 ${worktree.branch} 已经删了，恢复不了`)
        await git(worktree.sourceRoot, ['branch', worktree.branch, `${snap}^`])
      }
      mkdirSync(dirname(worktree.path), { recursive: true })
      await git(worktree.sourceRoot, ['worktree', 'add', worktree.path, worktree.branch])
      if (snap) {
        await applySnapshot(worktree.path, snap)
        await gitMaybe(worktree.sourceRoot, ['update-ref', '-d', worktree.snapshotRef ?? ''])
      }
      this.ownerFile(worktree)
      this.host.log(`恢复了工作树 ${worktree.path}`)
      return this.update(worktree, { state: 'ready', snapshotRef: null })
    })
  }

  private need(id: string): Worktree {
    const worktree = this.get(id)
    if (!worktree) throw new ProtocolError(-32602, `没有工作树 ${id}`)
    return worktree
  }

  // ---------- 分支、方法 ----------

  async branches(cwd: string): Promise<WorktreeBranchesResponse> {
    const { top } = await repoOf(cwd)
    const current = await gitMaybe(top, ['symbolic-ref', '--quiet', '--short', 'HEAD'])
    const refs = (
      await git(top, ['for-each-ref', '--format=%(refname)', 'refs/heads', 'refs/remotes/origin'])
    )
      .split('\n')
      .filter(Boolean)
    return {
      current: current || null,
      defaultBranch: await defaultBranch(top),
      local: refs.filter((ref) => ref.startsWith('refs/heads/')).map((ref) => ref.slice(11)),
      remote: refs
        .filter(
          (ref) => ref.startsWith('refs/remotes/origin/') && ref !== 'refs/remotes/origin/HEAD',
        )
        .map((ref) => ref.slice('refs/remotes/'.length)),
    }
  }

  /** litch/worktree/* 由设备进程自己答 */
  async call(method: string, params: unknown): Promise<unknown> {
    const fields = isObject(params) ? params : {}
    switch (method) {
      case WORKTREE_METHOD.list:
        return { data: this.list() }
      case WORKTREE_METHOD.branches:
        return this.branches(requiredString(fields.cwd, 'cwd'))
      case WORKTREE_METHOD.remove:
        return {
          worktree: await this.remove(requiredString(fields.id, 'id'), {
            discard: fields.discard === true,
            withBranch: fields.withBranch === true,
          }),
        }
      case WORKTREE_METHOD.restore:
        return { worktree: await this.restore(requiredString(fields.id, 'id')) }
      default:
        throw new ProtocolError(-32601, `没有方法 ${method}`)
    }
  }
}

/** 会话在工作树里的目录：工作树根加子路径 */
export function worktreeCwd(worktree: Worktree): string {
  return worktree.subPath ? join(worktree.path, worktree.subPath) : worktree.path
}

/** thread/start 里 litchWorktree.from 的值：认得的几种之外按 default 算 */
export function worktreeFrom(value: Record<string, unknown>): WorktreeFrom {
  const kind = value.kind
  if (kind === 'branch')
    return { kind, branch: requiredString(value.branch, 'litchWorktree.from.branch') }
  if (kind === 'head' || kind === 'working-tree') return { kind }
  return { kind: 'default' }
}
