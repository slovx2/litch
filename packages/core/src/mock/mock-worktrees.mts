// 模拟核心的工作树（32 号设计）：列表从示例会话里带着 worktree 的那几个起头；新建会话可以要一个新工作树
// （建要一会儿，工作区根之外的目录不算 git 仓库）；删、恢复改状态，主人会话上的 worktree 跟着变。
// 行为照真的核心和设备服务：没声明 worktrees 的设备以 unsupported 结束、没连上的以 offline 结束。
import { ChannelError, type Clock, type Commands, type WorktreesOp } from '../channel/protocol.mjs'
import type { HostSink } from '../channel/server.mjs'
import type { DeviceView, SessionSummary } from '../model.mjs'
import type {
  SessionWorktreeView,
  WorktreeBranchesView,
  WorktreeFrom,
  WorktreesTopicView,
  WorktreeView,
} from '../model-worktrees.mjs'

export interface MockWorktreesHost {
  clock: Clock
  /** 每一步隔多久的基数；0 表示不拖时间 */
  stepMs: number
  device(deviceId: string): DeviceView | undefined
  /** 这台设备上的会话摘要（起头时从里面找带着 worktree 的） */
  sessions(deviceId: string): SessionSummary[]
  /** 工作区的根目录：只有它们算 git 仓库 */
  roots(deviceId: string): string[]
  /** 主人会话上的 worktree 变了 */
  owned(deviceId: string, sessionId: string, worktree: SessionWorktreeView | null): void
}

export interface MockWorktrees {
  subscribe(deviceId: string, sink: HostSink): () => void
  /** 是工作树的命令就处理；不是就返回 undefined，交给别处 */
  command(name: string, params: unknown): Promise<unknown> | undefined
  /** 新建会话要的工作树：建好返回它（还没有主人），会话的目录是 path 加 subPath */
  create(
    deviceId: string,
    cwd: string,
    from: WorktreeFrom | undefined,
    title: string,
  ): Promise<WorktreeView>
  /** 会话建好了：记成主人 */
  own(deviceId: string, id: string, sessionId: string): void
}

/** 示例仓库的分支 */
const SAMPLE_BRANCHES: WorktreeBranchesView = {
  current: 'main',
  defaultBranch: 'main',
  local: ['main', 'release/0.18', 'litch/sidebar-tweaks-3f2a1c'],
  remote: ['origin/main', 'origin/release/0.18'],
}

const WORKTREE_ROOT = '~/.codex-harness-adapter/worktrees'

const slugOf = (title: string) =>
  title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/g, '')

export const shownOf = (row: WorktreeView): SessionWorktreeView => ({
  id: row.id,
  path: row.path,
  branch: row.branch,
  baseRef: row.baseRef,
  baseCommit: row.baseCommit,
  state: row.state,
  sourceRoot: row.sourceRoot,
})

export function createMockWorktrees(host: MockWorktreesHost): MockWorktrees {
  const lists = new Map<string, WorktreeView[]>()
  const sinks = new Map<string, Set<HostSink>>()
  let serial = 0

  const listOf = (deviceId: string): WorktreeView[] => {
    let list = lists.get(deviceId)
    if (!list) {
      list = host.sessions(deviceId).flatMap((session) =>
        session.worktree
          ? [
              {
                ...session.worktree,
                subPath: '',
                ownerSessionId: session.id,
                snapshotRef: null,
                createdAt: session.updatedAt,
                updatedAt: session.updatedAt,
              },
            ]
          : [],
      )
      lists.set(deviceId, list)
    }
    return list
  }

  const view = (deviceId: string): WorktreesTopicView => {
    const device = host.device(deviceId)
    const available = device ? device.worktrees : null
    return {
      deviceId,
      available,
      list: available ? listOf(deviceId) : null,
      loading: false,
      error: null,
    }
  }

  const emit = (deviceId: string) => {
    const ops: WorktreesOp[] = [{ op: 'worktrees.set', view: view(deviceId) }]
    for (const sink of sinks.get(deviceId) ?? []) sink.delta(ops)
  }

  const reachable = (deviceId: string): DeviceView => {
    const device = host.device(deviceId)
    if (!device) throw new ChannelError('notFound', `没有这台设备：${deviceId}`)
    if (device.connection !== 'online') throw new ChannelError('offline', '设备未连接')
    if (!device.worktrees) throw new ChannelError('unsupported', '此设备的服务不支持工作树')
    return device
  }

  const wait = (steps: number) =>
    host.stepMs > 0
      ? new Promise<void>((resolve) => {
          host.clock.setTimer(resolve, host.stepMs * steps)
        })
      : Promise.resolve()

  const isRepo = (deviceId: string, cwd: string) =>
    host.roots(deviceId).some((root) => cwd === root || cwd.startsWith(`${root}/`))

  /** 换掉一项，主人会话跟着变 */
  const put = (deviceId: string, row: WorktreeView, gone = false) => {
    const rest = listOf(deviceId).filter((entry) => entry.id !== row.id)
    lists.set(deviceId, gone ? rest : [row, ...rest].sort((a, b) => b.createdAt - a.createdAt))
    if (row.ownerSessionId) host.owned(deviceId, row.ownerSessionId, gone ? null : shownOf(row))
    emit(deviceId)
  }

  const need = (deviceId: string, id: string): WorktreeView => {
    const row = listOf(deviceId).find((entry) => entry.id === id)
    if (!row) throw new ChannelError('notFound', `没有工作树 ${id}`)
    return row
  }

  return {
    subscribe(deviceId, sink) {
      let set = sinks.get(deviceId)
      if (!set) sinks.set(deviceId, (set = new Set()))
      set.add(sink)
      sink.snapshot(view(deviceId))
      return () => {
        set.delete(sink)
      }
    },

    async create(deviceId, cwd, from, title) {
      reachable(deviceId)
      if (!isRepo(deviceId, cwd))
        throw new ChannelError('rejected', `${cwd} 不在 git 仓库里，建不了工作树`)
      // 检出、复制被忽略的文件要一会儿
      await wait(6)
      const slug = slugOf(title)
      const random = (0x3a1000 + ++serial * 4099).toString(16).slice(-6)
      const id = slug ? `${slug}-${random}` : random
      const root =
        host.roots(deviceId).find((entry) => cwd === entry || cwd.startsWith(`${entry}/`)) ?? cwd
      const name = root.split('/').pop() ?? 'repo'
      const now = host.clock.now()
      const baseRef =
        from?.kind === 'branch'
          ? (from.branch ?? 'main')
          : from?.kind === 'working-tree'
            ? 'working-tree'
            : from?.kind === 'head'
              ? 'HEAD'
              : 'main'
      const row: WorktreeView = {
        id,
        path: `${WORKTREE_ROOT}/${name}/${id}`,
        branch: `litch/${id}`,
        baseRef,
        baseCommit: '4c1d9e2a7b03f5e6d8c1a2b3c4d5e6f708192a3b',
        state: 'ready',
        sourceRoot: root,
        subPath: cwd === root ? '' : cwd.slice(root.length + 1),
        ownerSessionId: null,
        snapshotRef: null,
        createdAt: now,
        updatedAt: now,
      }
      put(deviceId, row)
      return row
    },

    own(deviceId, id, sessionId) {
      const row = listOf(deviceId).find((entry) => entry.id === id)
      if (row) put(deviceId, { ...row, ownerSessionId: sessionId, updatedAt: host.clock.now() })
    },

    command(name, params) {
      if (name === 'worktree.branches') {
        const { deviceId, cwd } = params as Commands['worktree.branches']['params']
        reachable(deviceId)
        return Promise.resolve({ branches: isRepo(deviceId, cwd) ? SAMPLE_BRANCHES : null })
      }
      if (name === 'worktree.remove') {
        const { deviceId, id, discard, withBranch } =
          params as Commands['worktree.remove']['params']
        reachable(deviceId)
        return (async () => {
          const row = need(deviceId, id)
          await wait(2)
          // 示例里当它有改动：不丢弃的留快照
          const next: WorktreeView = {
            ...row,
            state: 'removed',
            snapshotRef: discard || withBranch ? null : `refs/litch/snapshots/${row.id}`,
            updatedAt: host.clock.now(),
          }
          put(deviceId, next, withBranch === true)
          return { worktree: next }
        })()
      }
      if (name === 'worktree.restore') {
        const { deviceId, id } = params as Commands['worktree.restore']['params']
        reachable(deviceId)
        return (async () => {
          const row = need(deviceId, id)
          if (row.state !== 'removed') return { worktree: row }
          await wait(3)
          const next: WorktreeView = {
            ...row,
            state: 'ready',
            snapshotRef: null,
            updatedAt: host.clock.now(),
          }
          put(deviceId, next)
          return { worktree: next }
        })()
      }
      return undefined
    },
  }
}
