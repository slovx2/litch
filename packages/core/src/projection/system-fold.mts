// 跨回合收起：连续几个不是用户发起的回合（子会话回报、会话间消息、后台任务结束、定时任务、外部事件提醒……），
// 连同触发它们的系统消息，在对话区收成一个块（“已处理 1 分 52 秒 · 16 步 · 4 条回报”），点开按时间看每条消息和过程。
// 纯函数，桌面和手机共用。
//
// 切法：
// - 只收已完成的系统回合。正在跑的照常实时画；出错、被打断的照旧单独画（错误和写了一半的东西要看得见）；
//   还有子代理没做完的也先不收。回合结束后并进前面的收起块。
// - 一个系统回合开头能并进来的是“领头”：系统消息（含跑着时插进来的回报）和过程，遇到别的块（正文、露在外面的卡片、
//   计划、待办、压缩、收尾区、用户自己的话）就停。正文照常露在外面，正文之后的回合另起一块。
// - 整个回合都是领头（没写正文）时，后面紧挨着的系统回合接着并进来；对用户透明的提醒收尾回合不打断。
// - 用户自己发的消息（含看板答复、规矩、议题这类用户的动作）不算系统消息，照旧把前后切开；
//   回合里有用户插的话、答题的话，整个回合照旧单独画。目标续跑是模型接着做用户的目标，也照旧单独画。

import type { ItemView, TurnStatus, TurnView } from '../model.mjs'
import { type Block, processSegments } from './blocks.mjs'

/** 系统消息的几种：子会话回报、别的会话发来的消息、后台任务结束、定时任务、其他（唤醒、外部事件、重启续跑） */
export type SystemMessageKind = 'report' | 'message' | 'background' | 'schedule' | 'other'

export interface SystemMessageCount {
  kind: SystemMessageKind
  n: number
}

/**
 * 设备进程注入的事件里，不是用户亲手做的那些。经理的看板答复、忽略决策、规矩更新、议题动态、开始和结束
 * 都是用户的动作（看板上点的、写的），照用户消息切开；没调收尾时的提醒另算（对用户透明，见 hidden）
 */
const SYSTEM_EVENTS: ReadonlySet<string> = new Set([
  'notes',
  'wake',
  // 后台任务跑完、引擎自己接着做时开头那条（核心按 litchOrigin 认出来的）
  'background-completed',
  'manager-suggestions',
  'manager-external-triage',
  'manager-external-bound',
])

/** 一条用户消息是不是系统消息；是就给它算哪一种、几条。用户自己说的话（哪怕前面附了回报）是 null */
export function systemMessageOf(item: ItemView | undefined): SystemMessageCount | null {
  if (item?.kind !== 'userMessage') return null
  const event = item.event
  const reports = event && SYSTEM_EVENTS.has(event.kind) ? event.notes.length : 0
  if (item.peer) return reports > 0 ? { kind: 'report', n: reports } : { kind: 'message', n: 1 }
  if (item.system) {
    if (item.system.kind === 'scheduledTask') return { kind: 'schedule', n: 1 }
    if (item.system.kind === 'restart') return { kind: 'other', n: 1 }
    // 子会话的简报、提案卡上的“在这里做”、用户确认后的继续：都是用户这一边发起的
    return null
  }
  if (!event || !SYSTEM_EVENTS.has(event.kind)) return null
  if (item.text.trim() !== '' || item.attachments.length > 0) return null
  if (event.kind === 'background-completed') return { kind: 'background', n: 1 }
  return reports > 0 ? { kind: 'report', n: reports } : { kind: 'other', n: 1 }
}

/** 一个回合在跨回合收起里要知道的 */
export interface FoldTurn {
  id: string
  status: TurnStatus
  durationMs: number | null
  /** 系统回合：领头里各种系统消息几条（没有开场消息的自发回合也算一条）。用户发起的是 null */
  messages: SystemMessageCount[] | null
  /** 领头占回合开头几块（bucketItems 的块） */
  lead: number
  /** 整个回合都是领头 */
  whole: boolean
  /** 整个回合不画（提醒收尾、什么都没带出来）：不打断前后的收起块 */
  hidden: boolean
  /** 收起块管着的条目：领头里的系统消息，和从领头里开始的各段过程的全部条目（含越过领头、排在正文后面的部分） */
  itemIds: string[]
  /** 还有没做完的子代理 */
  agentsRunning: boolean
}

/** 按种类累加，种类按第一次出现的先后 */
function addCount(counts: SystemMessageCount[], add: SystemMessageCount): void {
  const same = counts.find((entry) => entry.kind === add.kind)
  if (same) same.n += add.n
  else counts.push({ ...add })
}

/**
 * 一个回合的收起样子。blocks 是这个回合 bucketItems 的结果，item 按标识取条目。
 * 后台任务结束、目标续跑开的回合没有开场的系统消息时（开头那一行写来历），回合本身算一条
 */
export function foldTurnOf(
  turn: TurnView,
  blocks: readonly Block[],
  item: (id: string) => ItemView | undefined,
  agentsRunning = false,
): FoldTurn {
  const first = item(turn.itemIds[0] ?? '')
  const remind = first?.kind === 'userMessage' && first.event?.kind === 'remind'
  const messages: SystemMessageCount[] = []
  const head = blocks[0]
  const opener = head?.type === 'user' ? systemMessageOf(item(head.itemId)) : null
  // 目标续跑不算：那是模型接着做用户定的目标，开头一行写着第几轮，照旧单独画
  if (!opener && turn.origin === 'backgroundTask') messages.push({ kind: 'background', n: 1 })
  const segments = processSegments(blocks as Block[])
  const governed = new Set<string>()
  const ids: string[] = []
  let lead = 0
  for (const block of blocks) {
    if (block.type === 'user') {
      const message = systemMessageOf(item(block.itemId))
      if (!message) break
      addCount(messages, message)
      ids.push(block.itemId)
    } else if (block.type === 'process') {
      // 一段过程只记一次：同一段被露在外面的块隔开时，后面那几块也归这个收起块管
      const segment = segments.get(block.key)
      if (segment && !governed.has(segment.key)) {
        governed.add(segment.key)
        ids.push(...segment.itemIds)
      }
    } else break
    lead++
  }
  // 回合里有用户自己的话（开头的、跑着时插的、答题的）就是用户参与的回合，照旧单独画：
  // 用户的话把前后切开，插话前后各段过程也照旧各有各的“已处理”
  const userSaid = blocks.some(
    (block) => block.type === 'user' && !systemMessageOf(item(block.itemId)),
  )
  const system = messages.length > 0 && !remind && !userSaid
  return {
    id: turn.id,
    status: turn.status,
    durationMs: turn.durationMs,
    messages: system ? messages : null,
    lead: system ? lead : 0,
    whole: system && lead === blocks.length,
    hidden: remind && blocks.length === 0 && turn.status !== 'failed',
    itemIds: system ? ids : [],
    agentsRunning,
  }
}

/** 领头里开始的各段过程（段的键）：这些段没有自己的“已处理”，开合跟着收起块走，排在正文后面的那部分也一样 */
export function governedSegments(blocks: readonly Block[], lead: number): Set<string> {
  const segments = processSegments(blocks as Block[])
  const keys = new Set<string>()
  for (const block of blocks.slice(0, lead)) {
    if (block.type !== 'process') continue
    const segment = segments.get(block.key)
    if (segment) keys.add(segment.key)
  }
  return keys
}

/** 一个收起块：并进来的回合、管着的条目、各种系统消息几条、总用时 */
export interface SystemRun {
  /** 第一个回合的标识 */
  key: string
  turnIds: string[]
  itemIds: string[]
  messages: SystemMessageCount[]
  /** 各回合用时之和；都没报用时是 null */
  durationMs: number | null
}

/** 一个回合在收起块里的位置 */
export interface RunRole {
  run: SystemRun
  /** 收起块的标题行画在这个回合（第一个回合）的开头 */
  head: boolean
  /** 回合开头几块归收起块（FoldTurn.lead） */
  lead: number
  /** 整个回合都在收起块里：收着时连回合尾那一行也不画 */
  whole: boolean
}

/**
 * 按先后把回合分进收起块。null 表示中间隔着没画出来的回合（查找时的跳行）：前后不并。
 * 只返回在收起块里的回合
 */
export function systemRuns(turns: readonly (FoldTurn | null)[]): Map<string, RunRole> {
  const runs: FoldTurn[][] = []
  /** 还能往后接的那一块：最后一个回合整个都在块里 */
  let open: FoldTurn[] | null = null
  for (const turn of turns) {
    if (turn?.hidden) continue
    const joinable =
      turn !== null && turn.messages !== null && turn.status === 'completed' && !turn.agentsRunning
    if (!joinable) {
      open = null
      continue
    }
    if (!open) {
      open = []
      runs.push(open)
    }
    open.push(turn)
    if (!turn.whole) open = null
  }
  const roles = new Map<string, RunRole>()
  for (const members of runs) {
    const messages: SystemMessageCount[] = []
    for (const member of members)
      for (const count of member.messages ?? []) addCount(messages, count)
    const timed = members.filter((member) => member.durationMs !== null)
    const run: SystemRun = {
      key: members[0]?.id ?? '',
      turnIds: members.map((member) => member.id),
      itemIds: members.flatMap((member) => member.itemIds),
      messages,
      durationMs: timed.length
        ? timed.reduce((sum, member) => sum + (member.durationMs ?? 0), 0)
        : null,
    }
    members.forEach((member, index) => {
      roles.set(member.id, { run, head: index === 0, lead: member.lead, whole: member.whole })
    })
  }
  return roles
}

/**
 * 收起块开没开。每个回合各记一个开关（查找、跳到原文时只开命中的那个回合的），picks 是它们现在的值：
 * 有一个开着就开；都没开、有一个点成收起就收；都没点过照默认（没手动展开过里面的东西就收着）。
 * 点标题行时把所有成员一起设成同一个值，后来并进来的回合没点过，跟着前面的走
 */
export function runOpen(picks: readonly (boolean | undefined)[], fallback: boolean): boolean {
  if (picks.includes(true)) return true
  if (picks.includes(false)) return false
  return fallback
}

/** 两次分出来的收起块一样不一样（客户端拿它沿用上一次的对象，没变的回合不重画） */
export function sameRun(a: SystemRun, b: SystemRun): boolean {
  return (
    a.key === b.key &&
    a.durationMs === b.durationMs &&
    a.turnIds.join(' ') === b.turnIds.join(' ') &&
    a.itemIds.join(' ') === b.itemIds.join(' ') &&
    JSON.stringify(a.messages) === JSON.stringify(b.messages)
  )
}
