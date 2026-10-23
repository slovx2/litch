// 后台任务的投影（backgroundTasks 扩展，model-background.mts）。
// 报集合的：会话对象上的 litchBackground（变化通知 litch/thread/background/changed 也打到会话对象上）。
// 不报的（harness 没声明 features.backgroundTasks）：从打开着的会话里派生——已结束的回合里还 inProgress 的命令条目
// 就是还在后台跑的（Claude、原生 codex 都这么表示）。派生的只认得出还在跑的，跑完的那条命令就不算了。
import {
  BACKGROUND_ENDED_LIMIT,
  type LitchBackground,
  type LitchTurnOrigin,
} from '../../../protocol/src/background-tasks.mjs'
import type { ItemView, TurnView } from '../model.mjs'
import type {
  BackgroundTaskKind,
  BackgroundTaskStatus,
  BackgroundTaskView,
  SessionBackgroundView,
  TurnOrigin,
} from '../model-background.mjs'

const KINDS: readonly string[] = ['shell', 'agent', 'monitor', 'workflow', 'remote', 'other']
const STATUSES: readonly string[] = ['running', 'completed', 'failed', 'stopped']
const ORIGINS: readonly string[] = ['user', 'backgroundTask', 'schedule', 'goal', 'queue', 'peer']

const text = (value: unknown): string | null => (typeof value === 'string' && value ? value : null)
const time = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null

const summed = (tasks: BackgroundTaskView[], wakesOnFinish: boolean | null) => ({
  tasks,
  running: tasks.filter((task) => task.status === 'running').length,
  wakesOnFinish,
})

/** 会话对象上入口加的集合（只发给声明了 backgroundTasks 的连接）。没有、形状不对、一个任务也没有的是 null */
export function projectBackground(raw: unknown): SessionBackgroundView | null {
  if (!raw || typeof raw !== 'object') return null
  const { tasks, wakesOnFinish } = raw as Partial<LitchBackground>
  if (!Array.isArray(tasks)) return null
  const views: BackgroundTaskView[] = []
  for (const task of tasks as unknown[]) {
    if (!task || typeof task !== 'object') continue
    const one = task as Record<string, unknown>
    const id = text(one.id)
    if (!id) continue
    views.push({
      id,
      kind: (KINDS.includes(one.kind as string) ? one.kind : 'other') as BackgroundTaskKind,
      title: typeof one.title === 'string' ? one.title : '',
      status: (STATUSES.includes(one.status as string)
        ? one.status
        : 'completed') as BackgroundTaskStatus,
      itemId: text(one.itemId),
      turnId: text(one.turnId),
      startedAt: time(one.startedAt),
      endedAt: time(one.endedAt),
    })
  }
  if (views.length === 0) return null
  return summed(views, typeof wakesOnFinish === 'boolean' ? wakesOnFinish : null)
}

/** 回合上的 litchOrigin。没有、不认识的、user 都当用户发的，是 undefined（TurnView 上不带） */
export function projectOrigin(raw: unknown): Exclude<TurnOrigin, 'user'> | undefined {
  return typeof raw === 'string' && raw !== 'user' && ORIGINS.includes(raw)
    ? (raw as Exclude<LitchTurnOrigin, 'user'>)
    : undefined
}

/**
 * 显示条目的标识是“回合的显示标识:协议条目标识”（session.mts 的 itemKey）。取回协议里的那一截。
 * 回合的显示标识自己也可能带冒号（本机先起的 local:N），所以按回合去掉前缀
 */
const protocolItemId = (turnId: string, viewItemId: string): string =>
  viewItemId.startsWith(`${turnId}:`) ? viewItemId.slice(turnId.length + 1) : viewItemId

/**
 * 不报集合的连接：从会话里派生。已结束的回合里还 inProgress 的命令条目算在跑；
 * 回合还在进行的不算（那是前台工作），最后一个回合正在进行时它之前的照算
 */
export function deriveBackground(
  turns: readonly TurnView[],
  items: Readonly<Record<string, ItemView | undefined>>,
): SessionBackgroundView | null {
  const tasks: BackgroundTaskView[] = []
  for (const turn of turns) {
    if (turn.status === 'running') continue
    for (const itemId of turn.itemIds) {
      const item = items[itemId]
      if (item?.kind !== 'command' || item.status !== 'inProgress') continue
      tasks.push({
        id: itemId,
        kind: 'shell',
        title: item.command,
        status: 'running',
        itemId: protocolItemId(turn.id, itemId),
        turnId: turn.id,
        startedAt: item.startedAt ?? turn.startedAt,
        endedAt: null,
      })
    }
  }
  return tasks.length > 0 ? summed(tasks.slice(0, BACKGROUND_ENDED_LIMIT), null) : null
}

/**
 * 界面上一个会话的后台任务：报集合的照集合（侧栏摘要上的那份），不报的从打开着的会话里派生。
 * reports：这个会话的 harness 报不报集合（SessionAbilities.backgroundTasks）
 */
export function sessionBackground(
  reports: boolean,
  reported: SessionBackgroundView | null,
  turns: readonly TurnView[],
  items: Readonly<Record<string, ItemView | undefined>>,
): SessionBackgroundView | null {
  return reports ? reported : deriveBackground(turns, items)
}

/**
 * 输入框上方那一行写几个（0 就不出）：在跑的后台任务个数。和回合进不进行无关——人接着说话、
 * 新回合在跑时，上一回合留在后台的任务照样在跑，这一行照样在（“正在工作”说的是前台）
 */
export const backgroundHint = (background: SessionBackgroundView | null): number =>
  background?.running ?? 0

/** 这个回合发起的、还在跑的后台任务有几个（收起行末尾的“· N 个在后台运行”） */
export function runningFromTurn(background: SessionBackgroundView | null, turn: TurnView): number {
  if (!background || background.running === 0) return 0
  const mine = new Set(turn.itemIds.map((itemId) => protocolItemId(turn.id, itemId)))
  let count = 0
  for (const task of background.tasks)
    if (task.status === 'running' && task.itemId && mine.has(task.itemId)) count++
  return count
}

/** 显示条目对应的那个后台任务（展开后命令行尾写“运行中”用）。不是后台任务的是 null */
export function taskOfItem(
  background: SessionBackgroundView | null,
  viewItemId: string,
): BackgroundTaskView | null {
  if (!background) return null
  return (
    background.tasks.find((task) => task.itemId && viewItemId.endsWith(`:${task.itemId}`)) ?? null
  )
}

/**
 * 自发回合（后台任务结束后 harness 接着做的）是被哪个任务叫醒的：这一回合开始前最后结束的那个。
 * 找不到（集合里已经没有了、不知道时间）是 null
 */
export function wokenBy(
  background: SessionBackgroundView | null,
  turn: Pick<TurnView, 'startedAt'>,
): BackgroundTaskView | null {
  if (!background || turn.startedAt === null) return null
  let best: BackgroundTaskView | null = null
  for (const task of background.tasks) {
    if (task.status === 'running' || task.endedAt === null) continue
    if (task.endedAt > turn.startedAt + 1000) continue
    if (!best || (best.endedAt ?? 0) < task.endedAt) best = task
  }
  return best
}
