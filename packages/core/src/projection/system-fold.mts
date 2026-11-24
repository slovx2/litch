// 跨回合收起：连续几个不是用户发起的回合（子会话回报、会话间消息、后台任务结束、定时任务、外部事件提醒……），
// 连同触发它们的系统消息，在对话区收成一个块（“已处理 1 分 52 秒 · 16 步 · 4 条回报”），点开按时间看每条消息和过程。
// 纯函数，桌面和手机共用。
//
// 切法：
// - 只收已完成的系统回合。正在跑的照常实时画；出错、被打断的照旧单独画（错误和写了一半的东西要看得见）；
//   还有子代理没做完的也先不收。回合结束后并进前面的收起块。
// - 连续的系统回合（中间没有用户的话等切分点）合成一块：块里所有回合的系统消息、过程、中途的文字，
//   以及除最后一段之外各回合的结尾文字都收进去，整串只露最后一段结尾文字（Claude 这类经理每个事件回合
//   结尾都写一句，逐个露出来就又碎成一长串）。计划、待办、压缩、露在外面的卡片、收尾区照旧在原位露着，不切块。
// - 对用户透明的提醒收尾回合不打断。
// - 只有用户本人在对话里说话才切开：用户打的字（含附着回报的）、回合中途插的话、答题的话，这样的回合照旧单独画。
//   不是用户本人在对话里说的（回报、别的会话的消息、看板答复与规矩、议题动态、经理开始与结束、子会话简报、
//   “在这里做”、确认后继续、目标续做、定时任务、后台任务结束……）一律算系统消息。

import type { ItemView, TurnStatus, TurnView } from '../model.mjs'
import { type Block, processSegments } from './blocks.mjs'

/**
 * 系统消息的几种：子会话回报、别的会话发来的消息、后台任务结束、定时任务、看板动态（答复、忽略、规矩、议题、
 * 经理开始与结束、工作线建议、外部事件）、目标续做、其他（唤醒、简报、在这里做、确认后继续、重启续跑）
 */
export type SystemMessageKind =
  | 'report'
  | 'message'
  | 'background'
  | 'schedule'
  | 'board'
  | 'goal'
  | 'other'

export interface SystemMessageCount {
  kind: SystemMessageKind
  n: number
}

/**
 * 一条用户消息是不是系统消息；是就给它算哪一种、几条。原则：不是用户本人在对话里说的话，一律算系统消息。
 * 用户自己打的字（哪怕前面附着回报）、回合中途插的话、答题的话都是 null。
 * 没调收尾时的提醒另算（对用户透明，见 FoldTurn.hidden）
 */
export function systemMessageOf(item: ItemView | undefined): SystemMessageCount | null {
  if (item?.kind !== 'userMessage') return null
  const event = item.event
  if (event?.kind === 'remind') return null
  const reports = event?.notes.length ?? 0
  if (item.peer) return reports > 0 ? { kind: 'report', n: reports } : { kind: 'message', n: 1 }
  if (item.system)
    return { kind: item.system.kind === 'scheduledTask' ? 'schedule' : 'other', n: 1 }
  if (!event) return null
  // 事件后面跟着用户自己打的字：用户在说话，回报只是附带的
  if (item.text.trim() !== '' || item.attachments.length > 0) return null
  if (event.kind === 'background-completed') return { kind: 'background', n: 1 }
  if (reports > 0) return { kind: 'report', n: reports }
  if (event.kind.startsWith('manager-')) return { kind: 'board', n: 1 }
  return { kind: 'other', n: 1 }
}

/** 一个回合在跨回合收起里要知道的 */
export interface FoldTurn {
  id: string
  status: TurnStatus
  durationMs: number | null
  /** 系统回合：各种系统消息几条（没有开场消息的自发回合也算一条）。用户参与的是 null */
  messages: SystemMessageCount[] | null
  /** 整个回合不画（提醒收尾、什么都没带出来）：不打断前后的收起块 */
  hidden: boolean
  /** 收起块管着的条目：系统消息和各段过程的全部条目（不含正文） */
  itemIds: string[]
  /** 正文（bucketItems 的 answer 块），按先后 */
  texts: string[]
  /** 结尾文字：最后一块正文，连同紧挨在它前面的正文块（旧顺序“长回答、收尾、短话”会是几条） */
  ending: string[]
  /** 还有没做完的子代理 */
  agentsRunning: boolean
}

/** 按种类累加，种类按第一次出现的先后 */
function addCount(counts: SystemMessageCount[], add: SystemMessageCount): void {
  const same = counts.find((entry) => entry.kind === add.kind)
  if (same) same.n += add.n
  else counts.push({ ...add })
}

/** 回合的结尾文字：最后一块正文，连同紧挨在它前面的正文块。最后一块正文后面还有工具的，也取它 */
function endingOf(blocks: readonly Block[]): string[] {
  const ending: string[] = []
  for (let i = blocks.length - 1; i >= 0; i--) {
    const block = blocks[i]
    if (block?.type === 'answer') ending.unshift(block.itemId)
    else if (ending.length > 0) break
  }
  return ending
}

/**
 * 一个回合的收起样子。blocks 是这个回合 bucketItems 的结果，item 按标识取条目。
 * 后台任务结束、目标续做开的回合没有开场的系统消息时（开头那一行写来历），回合本身算一条
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
  const lead = blocks[0]
  const opener = lead?.type === 'user' ? systemMessageOf(item(lead.itemId)) : null
  // 后台任务结束、目标续做开的回合没有看得见的开场消息（目标续做的代发输入投影时藏起来了）：回合本身算一条
  if (!opener && turn.origin === 'backgroundTask') messages.push({ kind: 'background', n: 1 })
  if (!opener && turn.origin === 'goal') messages.push({ kind: 'goal', n: 1 })
  const segments = processSegments(blocks as Block[])
  const governed = new Set<string>()
  const ids: string[] = []
  const texts: string[] = []
  // 回合里有用户自己的话（开头的、跑着时插的、答题的）就是用户参与的回合，照旧单独画
  let userSaid = false
  for (const block of blocks) {
    if (block.type === 'user') {
      const message = systemMessageOf(item(block.itemId))
      if (!message) userSaid = true
      else {
        addCount(messages, message)
        ids.push(block.itemId)
      }
    } else if (block.type === 'process') {
      // 一段过程只记一次：同一段被露在外面的块隔开时会分成几块
      const segment = segments.get(block.key)
      if (segment && !governed.has(segment.key)) {
        governed.add(segment.key)
        ids.push(...segment.itemIds)
      }
    } else if (block.type === 'answer') texts.push(block.itemId)
  }
  const system = messages.length > 0 && !remind && !userSaid
  return {
    id: turn.id,
    status: turn.status,
    durationMs: turn.durationMs,
    messages: system ? messages : null,
    hidden: remind && blocks.length === 0 && turn.status !== 'failed',
    itemIds: system ? ids : [],
    texts: system ? texts : [],
    ending: system ? endingOf(blocks) : [],
    agentsRunning,
  }
}

/** 一个收起块：并进来的回合、管着的条目、各种系统消息几条、总用时 */
export interface SystemRun {
  /** 第一个回合的标识 */
  key: string
  turnIds: string[]
  /** 标题行统计的条目：系统消息、过程，和收进去的正文 */
  itemIds: string[]
  /**
   * 收着时露在外面的正文：块里最后一个写了字的回合的结尾文字（一般是最后一个回合的）。
   * 最后几个回合一句话都没写时，露的是之前最近说的那一段，免得整串只剩一行
   */
  shown: string[]
  messages: SystemMessageCount[]
  /** 各回合用时之和；都没报用时是 null */
  durationMs: number | null
}

/** 一个回合在收起块里的位置 */
export interface RunRole {
  run: SystemRun
  /** 收起块的标题行画在这个回合（第一个回合）的开头 */
  head: boolean
}

/**
 * 按先后把回合分进收起块。null 表示中间隔着没画出来的回合（查找时的跳行）：前后不并。
 * 只返回在收起块里的回合
 */
export function systemRuns(turns: readonly (FoldTurn | null)[]): Map<string, RunRole> {
  const runs: FoldTurn[][] = []
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
  }
  const roles = new Map<string, RunRole>()
  for (const members of runs) {
    const messages: SystemMessageCount[] = []
    for (const member of members)
      for (const count of member.messages ?? []) addCount(messages, count)
    const timed = members.filter((member) => member.durationMs !== null)
    const shown = members.findLast((member) => member.ending.length > 0)?.ending ?? []
    const run: SystemRun = {
      key: members[0]?.id ?? '',
      turnIds: members.map((member) => member.id),
      itemIds: members.flatMap((member) => [
        ...member.itemIds,
        ...member.texts.filter((id) => !shown.includes(id)),
      ]),
      shown,
      messages,
      durationMs: timed.length
        ? timed.reduce((sum, member) => sum + (member.durationMs ?? 0), 0)
        : null,
    }
    members.forEach((member, index) => {
      roles.set(member.id, { run, head: index === 0 })
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
    a.shown.join(' ') === b.shown.join(' ') &&
    JSON.stringify(a.messages) === JSON.stringify(b.messages)
  )
}
