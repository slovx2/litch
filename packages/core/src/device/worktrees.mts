// 一台设备上设备层建的工作树（协议扩展 worktrees，32 号设计）在客户端这一头的样子。
// 建、删、恢复都在设备进程里，核心只是转运：
// - worktrees 主题开着（设置页“工作树”一块）才去读列表，之后跟着 litch/worktree/changed 更新；
// - 变化通知同时交给会话目录：主人会话对象上的 litchWorktree 跟着换（侧栏的图标、信息栏的卡片）；
// - 列分支、删、恢复是现问现答的命令。
import type { ClientRequestMethod, ClientRequests } from '../../../protocol/src/index.mjs'
import {
  type ThreadWorktree,
  WORKTREE_CHANGED,
  WORKTREE_METHOD,
  type Worktree,
  type WorktreeChangedNotification,
} from '../../../protocol/src/worktrees.mjs'
import { ChannelError, type WorktreesOp } from '../channel/protocol.mjs'
import type { HostSink } from '../channel/server.mjs'
import type { RpcRequestOptions } from '../connection/rpc.mjs'
import { RpcError } from '../connection/rpc.mjs'
import type { WorktreeBranchesView, WorktreesTopicView, WorktreeView } from '../model-worktrees.mjs'

export interface WorktreesHost {
  deviceId: string
  online(): boolean
  /** 对面支不支持：它是设备服务，而且设备信息的 extensions 里列了 worktrees */
  supported(): boolean
  request<M extends ClientRequestMethod>(
    method: M,
    params: ClientRequests[M]['params'],
    options?: RpcRequestOptions,
  ): Promise<ClientRequests[M]['result']>
  /** 请求没做成：换成给人看的错误 */
  fail(error: unknown): ChannelError
  /** 一个会话所在的工作树变了（null：不再是哪个工作树的主人） */
  owned(threadId: string, worktree: ThreadWorktree | null): void
  log(line: string): void
}

export interface Worktrees {
  open(sink: HostSink): () => void
  resync(): void
  offline(): void
  /** 是工作树的通知就处理掉并返回 true */
  notification(method: string, params: unknown): boolean
  branches(cwd: string): Promise<WorktreeBranchesView | null>
  remove(id: string, options: { discard?: boolean; withBranch?: boolean }): Promise<WorktreeView>
  restore(id: string): Promise<WorktreeView>
}

/** 删、恢复要跑 git，大仓库慢 */
const GIT_TIMEOUT_MS = 120_000

export const projectWorktreeRow = (row: Worktree): WorktreeView => ({
  id: row.id,
  path: row.path,
  branch: row.branch,
  baseRef: row.baseRef,
  baseCommit: row.baseCommit,
  state: row.state,
  sourceRoot: row.sourceRoot,
  subPath: row.subPath ?? '',
  ownerSessionId: row.ownerThreadId ?? null,
  snapshotRef: row.snapshotRef ?? null,
  createdAt: row.createdAt * 1000,
  updatedAt: row.updatedAt * 1000,
})

const shownOf = (row: Worktree): ThreadWorktree => ({
  id: row.id,
  path: row.path,
  branch: row.branch,
  baseRef: row.baseRef,
  baseCommit: row.baseCommit,
  state: row.state,
  sourceRoot: row.sourceRoot,
})

export function createWorktrees(host: WorktreesHost): Worktrees {
  const sinks = new Set<HostSink>()
  let available: boolean | null = null
  let list: WorktreeView[] | null = null
  let loading = false
  let error: WorktreesTopicView['error'] = null
  let epoch = 0

  const view = (): WorktreesTopicView => ({
    deviceId: host.deviceId,
    available,
    list,
    loading,
    error,
  })

  const emit = () => {
    const ops: WorktreesOp[] = [{ op: 'worktrees.set', view: view() }]
    for (const sink of sinks) sink.delta(ops)
  }

  const reachable = () => {
    if (!host.online()) throw new ChannelError('offline', '设备未连接')
    if (!host.supported()) throw new ChannelError('unsupported', '此设备的服务不支持工作树')
  }

  const load = async () => {
    const mine = epoch
    loading = true
    emit()
    try {
      const response = await host.request(WORKTREE_METHOD.list, {})
      if (mine !== epoch) return
      list = (Array.isArray(response?.data) ? response.data : []).map(projectWorktreeRow)
      error = null
    } catch (thrown) {
      if (mine !== epoch) return
      error = host.fail(thrown).toShape()
    }
    loading = false
    emit()
  }

  /** 列表里换上（或去掉）一项：新建的在前 */
  const place = (row: WorktreeView, gone: boolean) => {
    if (list === null) return
    const rest = list.filter((entry) => entry.id !== row.id)
    list = gone ? rest : [row, ...rest].sort((a, b) => b.createdAt - a.createdAt)
    emit()
  }

  /** 设备回的一行：进列表，主人会话上的 litchWorktree 跟着换 */
  const changed = (raw: Worktree, gone: boolean) => {
    place(projectWorktreeRow(raw), gone)
    if (raw.ownerThreadId) host.owned(raw.ownerThreadId, gone ? null : shownOf(raw))
  }

  const run = async (
    work: () => Promise<{ worktree: Worktree }>,
    gone: (row: Worktree) => boolean,
  ): Promise<WorktreeView> => {
    reachable()
    try {
      const { worktree } = await work()
      changed(worktree, gone(worktree))
      return projectWorktreeRow(worktree)
    } catch (thrown) {
      throw host.fail(thrown)
    }
  }

  return {
    open(sink) {
      sinks.add(sink)
      sink.snapshot(view())
      if (list === null && !loading && host.online() && host.supported()) void load()
      return () => {
        sinks.delete(sink)
      }
    },

    resync() {
      epoch++
      available = host.supported()
      list = null
      loading = false
      error = null
      emit()
      if (available && sinks.size > 0) void load()
    },

    offline() {
      epoch++
      loading = false
      emit()
    },

    notification(method, params) {
      if (method !== WORKTREE_CHANGED) return false
      const { worktree: raw, deleted } = (params ?? {}) as Partial<WorktreeChangedNotification>
      if (!raw || typeof raw.id !== 'string') return true
      // 连分支一起删掉的：设备上已经没有这条记录了，列表里也去掉
      changed(raw, deleted === true)
      return true
    },

    async branches(cwd) {
      reachable()
      try {
        const response = await host.request(WORKTREE_METHOD.branches, { cwd })
        return {
          current: response.current ?? null,
          defaultBranch: response.defaultBranch ?? null,
          local: Array.isArray(response.local) ? response.local : [],
          remote: Array.isArray(response.remote) ? response.remote : [],
        }
      } catch (thrown) {
        // 目录不在 git 仓库里：设备回参数错误
        if (thrown instanceof RpcError && thrown.code === -32602) return null
        throw host.fail(thrown)
      }
    },

    remove(id, options) {
      return run(
        () =>
          host.request(
            WORKTREE_METHOD.remove,
            {
              id,
              ...(options.discard ? { discard: true } : {}),
              ...(options.withBranch ? { withBranch: true } : {}),
            },
            { timeoutMs: GIT_TIMEOUT_MS },
          ),
        () => options.withBranch === true,
      )
    },

    restore(id) {
      return run(
        () => host.request(WORKTREE_METHOD.restore, { id }, { timeoutMs: GIT_TIMEOUT_MS }),
        () => false,
      )
    },
  }
}
