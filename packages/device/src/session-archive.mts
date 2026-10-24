// 会话归档在设备层要做的事，照 Claude 桌面端：
// - 一个会话归档了，它已经停下的 Litch 子孙会话跟着归档；还在干活的、置顶的（连同它们底下的）留在列表里。
//   客户端发的 thread/archive（侧栏、手机）和模型的 litch_sessions.archive 都走这里。放回来时不带子会话。
// - 模型的 litch_sessions.archive、unarchive，以及跟着归档的子会话：用设备进程自己的连接发 thread/archive、
//   thread/unarchive，再补上客户端的请求经过设备时会做的几件事：索引记下归档没有、工作树照归档规则处理
//  （worktree-life.mts：干净的删目录留分支、有改动的留着、有共用的转给它）、告诉每条客户端连接。
// - 谁归档的：跟着用户归档的父会话一起归档的算用户归档（会话树把它的回报注明“被用户归档”、不唤醒）；
//   模型归档的不算用户停的（SessionTree.modelArchived），回报照常。
import type { SessionTree } from './session-tree.mjs'
import { isObject } from './wire.mjs'
import type { WorktreeLife } from './worktree-life.mjs'

export interface SessionArchiveHost {
  tree: SessionTree
  /** 工作树跟着会话走（没有 git 时是 null）。比这里晚建好，用的时候再取 */
  worktreeLife(): WorktreeLife | null
  /** 置顶着 */
  pinned(threadId: string): boolean
  /** 告诉每条客户端连接：这个会话归档了、放回来了（标准的 thread/archived、thread/unarchived） */
  shelved(threadId: string, archived: boolean): void
  log(line: string): void
}

/** 谁归档的：用户（客户端发的，或者跟着用户归档的父会话一起）还是模型 */
export type ArchivedBy = 'user' | 'model'

/** 一次归档带走了哪些子孙会话、留下了哪些（留下的只列最上面那一层） */
export interface Cascade {
  archived: string[]
  left: string[]
}

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error))

export class SessionArchives {
  private readonly host: SessionArchiveHost
  /** 模型要在这个回合结束时归档的会话自己（litch_sessions.archive 的 self） */
  private readonly afterTurn = new Set<string>()

  constructor(host: SessionArchiveHost) {
    this.host = host
  }

  private get tree(): SessionTree {
    return this.host.tree
  }

  /** 会话还在干活：有回合在跑、在等用户答、有后台任务在跑 */
  async working(threadId: string): Promise<boolean> {
    const tree = this.tree
    if (tree.isActive(threadId) || tree.waitingOnUser(threadId)) return true
    if (tree.host.backgroundRunning(threadId) > 0) return true
    const found = await tree.read(threadId, false).catch(() => null)
    const status = isObject(found?.thread.status) ? found.thread.status : null
    const flags = Array.isArray(status?.activeFlags) ? status.activeFlags : []
    return status?.type === 'active' || flags.length > 0
  }

  pinned(threadId: string): boolean {
    return this.host.pinned(threadId)
  }

  /** 客户端发来 thread/archive：用户归档。先告诉会话树，归档打断的回合结束时认得出是用户停的 */
  userArchiving(threadId: string): void {
    this.tree.modelArchived.delete(threadId)
    this.tree.archived(threadId)
  }

  /** 客户端发来 thread/unarchive：放回来以后再归档就看那一次是谁做的了 */
  userUnarchiving(threadId: string): void {
    this.tree.modelArchived.delete(threadId)
  }

  /** 一个会话归档成了（客户端的请求应答回来、或者设备进程自己归档的）：先收拾工作树，再带上子会话 */
  async archived(threadId: string, by: ArchivedBy): Promise<Cascade> {
    await this.host.worktreeLife()?.archived(threadId)
    return this.cascade(threadId, by)
  }

  /**
   * 子会话跟着归档：直接子会话里没置顶、自己和整棵子树都停下了的，归档（各自再往下带）；别的留在列表里。
   * 已经归档了的不管
   */
  async cascade(parentId: string, by: ArchivedBy): Promise<Cascade> {
    const result: Cascade = { archived: [], left: [] }
    for (const child of this.tree.store.childrenOf(parentId)) {
      const id = child.threadId
      if (this.tree.host.index.archived(id)) continue
      if (!(await this.settled(id))) {
        result.left.push(id)
        continue
      }
      try {
        const more = await this.archive(id, by)
        result.archived.push(id, ...more.archived)
        result.left.push(...more.left)
      } catch (error) {
        this.host.log(`子会话 ${id} 跟着 ${parentId} 归档没成：${messageOf(error)}`)
        result.left.push(id)
      }
    }
    if (result.archived.length || result.left.length)
      this.host.log(
        `会话 ${parentId} 归档了：子会话跟着归档 ${result.archived.length} 个，留在列表里 ${result.left.length} 个`,
      )
    return result
  }

  /** 能跟着父会话归档：没置顶、没在干活，没归档的子孙也都这样 */
  private async settled(threadId: string): Promise<boolean> {
    if (this.pinned(threadId) || (await this.working(threadId))) return false
    for (const child of this.tree.store.childrenOf(threadId)) {
      if (this.tree.host.index.archived(child.threadId)) continue
      if (!(await this.settled(child.threadId))) return false
    }
    return true
  }

  /** 设备进程自己的连接归档一个会话，补上经过设备时会做的事，再带上它的子会话 */
  async archive(threadId: string, by: ArchivedBy): Promise<Cascade> {
    const tree = this.tree
    const harness = await tree.owner(threadId)
    const link = await tree.link(harness)
    // 引擎的 thread/archived 通知可能比应答先到：先记下是模型归档的
    if (by === 'model') tree.modelArchived.add(threadId)
    try {
      await link.request('thread/archive', { threadId })
    } catch (error) {
      tree.modelArchived.delete(threadId)
      throw error
    }
    if (by === 'user') tree.archived(threadId)
    tree.host.index.setArchived(threadId, true)
    this.host.shelved(threadId, true)
    return this.archived(threadId, by)
  }

  /** 模型归档这个会话自己（self）：等它这个回合结束再归档 */
  archiveAfterTurn(threadId: string): void {
    if (this.afterTurn.has(threadId)) return
    this.afterTurn.add(threadId)
    const off = this.tree.onTurnEnded((ended) => {
      if (ended !== threadId) return
      off()
      this.afterTurn.delete(threadId)
      this.archive(threadId, 'model').catch((error: unknown) =>
        this.host.log(`会话 ${threadId} 回合结束后归档自己没成：${messageOf(error)}`),
      )
    })
  }

  /** 设备进程自己的连接把归档了的会话放回来，补上经过设备时会做的事（工作树建回或接着用） */
  async unarchive(threadId: string): Promise<void> {
    const tree = this.tree
    const harness = await tree.owner(threadId)
    const link = await tree.link(harness)
    await link.request('thread/unarchive', { threadId })
    tree.modelArchived.delete(threadId)
    tree.host.index.setArchived(threadId, false)
    this.host.shelved(threadId, false)
    await this.host.worktreeLife()?.reopen(threadId)
  }
}
