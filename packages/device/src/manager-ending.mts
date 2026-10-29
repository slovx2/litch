// 结束中只授予指定收尾回合写权限。事件、回合绑定落库，避免重启或迟到通知把普通回合当成收尾。
import type { Manager } from '../../protocol/src/manager.mjs'
import { type ManagerStore, managerNow } from './manager-store.mjs'
import type { SessionTree } from './session-tree.mjs'
import { isObject } from './wire.mjs'

export class ManagerEndings {
  private readonly store: ManagerStore
  private readonly tree: SessionTree
  private readonly changed: (id: string) => void
  /** 已核实不是收尾的在跑回合；保持同一订阅期间不每秒重读整段长对话。 */
  private readonly checked = new Map<string, string>()
  constructor(store: ManagerStore, tree: SessionTree, changed: (id: string) => void) {
    this.store = store
    this.tree = tree
    this.changed = changed
  }
  started(managerId: string, turnId: string): void {
    const ending = this.store.ending(managerId)
    if (!ending || this.store.manager(managerId)?.status !== 'ending') return
    this.store.transaction(() => {
      this.store.setEndingTurn(managerId, turnId)
      this.store.delivered(ending.eventId)
    })
  }
  completed(threadId: string, turnId: string): void {
    const manager = this.store.forThread(threadId)
    if (manager?.status === 'ending' && this.store.ending(manager.id)?.turnId === turnId)
      this.finish(manager)
  }
  private finish(manager: Manager): void {
    this.store.transaction(() => {
      const after: Manager = {
        ...manager,
        status: 'ended',
        endedAt: managerNow(),
        updatedAt: managerNow(),
      }
      this.store.saveManager(after)
      this.store.record(
        manager.id,
        'manager',
        'device',
        manager,
        after,
        'Manager finalization turn ended',
      )
      const ending = this.store.ending(manager.id)
      if (ending) this.store.delivered(ending.eventId)
    })
    this.changed(manager.id)
  }
  async recover(managerId: string): Promise<void> {
    const manager = this.store.manager(managerId)
    const ending = this.store.ending(managerId)
    if (manager?.status !== 'ending' || !ending) return
    const resumed = await this.tree.watch(manager.harness, manager.threadId)
    const running = this.tree.activeTurn(manager.threadId)
    if (
      resumed === null &&
      running &&
      (ending.turnId === running || this.checked.get(managerId) === running)
    )
      return
    const { thread } = await this.tree.read(manager.threadId, true)
    if (this.store.manager(managerId)?.status !== 'ending') return
    const turns = Array.isArray(thread.turns) ? thread.turns.filter(isObject) : []
    const turn = turns.find((one) =>
      ending.turnId ? one.id === ending.turnId : containsEvent(one, ending.text),
    )
    if (!turn || typeof turn.id !== 'string') {
      if (running) this.checked.set(managerId, running)
      return
    }
    this.started(managerId, turn.id)
    if (['completed', 'failed', 'interrupted'].includes(String(turn.status)))
      this.finish(this.store.manager(managerId) as Manager)
    else if (turn.status === 'inProgress')
      this.tree.turnEvent(manager.harness, 'turn/started', { threadId: manager.threadId, turn })
  }
  async canWrite(manager: Manager, turnId: string): Promise<boolean> {
    if (
      this.store.ending(manager.id)?.turnId !== turnId ||
      this.tree.activeTurn(manager.threadId) !== turnId
    )
      await this.recover(manager.id)
    return (
      this.store.manager(manager.id)?.status === 'ending' &&
      this.store.ending(manager.id)?.turnId === turnId &&
      this.tree.activeTurn(manager.threadId) === turnId
    )
  }
}

function containsEvent(turn: Record<string, unknown>, text: string): boolean {
  const items = Array.isArray(turn.items) ? turn.items : []
  return items.some(
    (item) =>
      isObject(item) &&
      item.type === 'userMessage' &&
      Array.isArray(item.content) &&
      item.content.some((part) => isObject(part) && part.type === 'text' && part.text === text),
  )
}
