// 投影的第二步：协议里的会话和回合 → 界面看到的会话。纯函数。
import {
  PINNED_SECTION_ID,
  type Thread,
  type ThreadStatus,
  type Turn,
} from '../../../protocol/src/index.mjs'
import type {
  HarnessId,
  ItemView,
  SessionAbilities,
  SessionStatus,
  SessionSummary,
  SessionView,
  TurnView,
} from '../model.mjs'
import { phrase, type Text } from '../phrase.mjs'
import { projectItem } from './items.mjs'
import { NO_SETTINGS } from './settings.mjs'

const TITLE_MAX = 80

/** 没有声明可看、也没发现对面有什么不会的时候：都当它会 */
export const ALL_ABLE: SessionAbilities = {
  fork: true,
  rollback: true,
  rollbackRestoresFiles: false,
  compact: true,
  steer: true,
  steerImages: true,
  finalOnStart: false,
  declared: false,
}

/**
 * 协议里的时间是秒，界面用毫秒。
 * 但适配器的 Pi 入口给回合的开始时间填的是毫秒（0.5.1 实测），所以大得不像秒的数按毫秒收：
 * 一千亿秒是三千多年以后，不会误判。适配器那边改对之前，这里两种都要认。
 */
export const toMs = (value: number | null | undefined): number | null =>
  typeof value !== 'number' ? null : value > 1e11 ? value : value * 1000

/** 会话的标题：起过名字就用名字，否则取开头那句话的第一行 */
export function threadTitle(thread: Pick<Thread, 'name' | 'preview'>): Text {
  const named = thread.name?.trim()
  if (named) return named
  const line = (thread.preview ?? '')
    .split('\n')
    .map((part) => part.trim())
    .find((part) => part.length > 0)
  if (!line) return phrase('session.untitled')
  const chars = Array.from(line)
  return chars.length > TITLE_MAX ? `${chars.slice(0, TITLE_MAX).join('')}…` : line
}

export function sessionStatus(status: ThreadStatus | null | undefined): {
  status: SessionStatus
  waitingFor: SessionSummary['waitingFor']
} {
  if (status?.type === 'systemError') return { status: 'error', waitingFor: null }
  if (status?.type !== 'active') return { status: 'idle', waitingFor: null }
  const flags = status.activeFlags ?? []
  // 停下来等人的时候不算“进行中”：侧栏上要显示成醒目的等待，不再转圈
  if (flags.includes('waitingOnApproval')) return { status: 'waiting', waitingFor: 'approval' }
  if (flags.includes('waitingOnUserInput')) return { status: 'waiting', waitingFor: 'answer' }
  return { status: 'running', waitingFor: null }
}

/**
 * 条目在界面里的标识。协议只保证条目标识在一个回合里不重复，
 * 所以前面拼上回合标识；没有标识的条目用它在回合里的位置。
 */
export const itemKey = (turnId: string, itemId: string, index: number): string =>
  `${turnId}:${itemId || `#${index}`}`

/**
 * viewId 是这个回合在界面里的标识，默认就是协议里的。
 * 本机发出的回合先用临时标识显示出来，对面给了正式标识之后界面这边不换（见 device/live.mts）。
 */
export function projectTurn(turn: Turn, viewId = turn.id): { turn: TurnView; items: ItemView[] } {
  const running = turn.status === 'inProgress'
  const last = (turn.items?.length ?? 0) - 1
  const items = (turn.items ?? []).map((item, index) => {
    // 回合还在进行时，只有最后一个条目可能还在往外出字
    const view = projectItem(item, running && index === last)
    return { ...view, id: itemKey(viewId, view.id, index) }
  })
  return {
    turn: {
      id: viewId,
      status: turn.status === 'inProgress' ? 'running' : turn.status,
      itemIds: items.map((item) => item.id),
      startedAt: toMs(turn.startedAt),
      durationMs: turn.durationMs ?? null,
      error: turn.error?.message ?? null,
    },
    items,
  }
}

export function projectThread(
  thread: Thread,
  scope: { deviceId: string; harness: HarnessId },
): SessionView {
  const turns: TurnView[] = []
  const items: Record<string, ItemView> = {}
  for (const source of thread.turns ?? []) {
    const projected = projectTurn(source)
    turns.push(projected.turn)
    for (const item of projected.items) items[item.id] = item
  }
  return {
    deviceId: scope.deviceId,
    sessionId: thread.id,
    title: threadTitle(thread),
    harness: scope.harness,
    cwd: thread.cwd,
    live: true,
    note: null,
    turns,
    items,
    requests: [],
    queued: [],
    settings: { ...NO_SETTINGS },
    usage: null,
    can: { ...ALL_ABLE },
    forkedFrom: forkedFrom(thread),
  }
}

/**
 * 会话从哪个会话分叉出来的。子代理会话也可能带着 forkedFromId（照上一级的历史起的），
 * 和 parentThreadId 是同一个时那是子代理的来历，不当分叉
 */
function forkedFrom(thread: Thread): string | null {
  const source = thread.forkedFromId
  return source && source !== thread.parentThreadId ? source : null
}

/**
 * 会话放在侧栏的哪一处：置顶、某个自定义分区，或者都不在。
 * 协议里没有“置顶”这个字段：置顶就是会话在那个固定标识的分区里。
 * 对面没有分区这回事的（会话对象上没有这两个字段）一律是都不在。
 */
export function sessionPlace(
  thread: Pick<Thread, 'section' | 'sectionEnteredAt'>,
): Pick<SessionSummary, 'pinned' | 'section' | 'placedAt'> {
  const section = thread.section
  if (typeof section !== 'object' || section === null || typeof section.id !== 'string') {
    return { pinned: false, section: null, placedAt: null }
  }
  const pinned = section.id === PINNED_SECTION_ID
  return {
    pinned,
    section: pinned ? null : { id: section.id, name: section.name ?? '' },
    placedAt: toMs(thread.sectionEnteredAt),
  }
}

/** 会话的摘要，侧栏用。workspaceId 由调用方按工作区的规则算好再传进来 */
export function projectSummary(
  thread: Thread,
  scope: { harness: HarnessId; workspaceId: string | null },
): SessionSummary {
  return {
    ...sessionPlace(thread),
    id: thread.id,
    workspaceId: scope.workspaceId,
    harness: scope.harness,
    title: threadTitle(thread),
    ...sessionStatus(thread.status),
    unread: false,
    updatedAt: toMs(thread.updatedAt) ?? 0,
    cwd: thread.cwd,
  }
}
