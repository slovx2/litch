// 投影的第三步：一个回合里的显示条目 → 块。纯函数。
// 一个回合画成：用户消息 → 过程 → 最终回答。过程按时间排三种东西：说明段（助手的中间说明，和回答同一套正文样式）、
// 步骤组（两段说明之间连续的工具调用、思考、提示，收成一行汇总）、启动子代理的那一行。
// 计划、待办、上下文压缩、派出的子会话露在过程外面，位置不变。有最终回答的回合结束后整段过程再收成一行（被打断的不收）。
// 收尾（wrap_up）带的建议任务卡片连同留给用户的问题，固定画在回合最下方（最终回答下面）的收尾区里，
// 原来调用的位置在过程里只留一行；等回合结束才进收尾区：规矩是先收尾、再写最终回答，收到就画的话卡片比回答先出来，
// 没头没尾（照 Claude 桌面端：下一步框在回合结束前藏着）。
// 回合中途 start 提的提案、offer 卡露在调用的位置，跟着对话往上走，后面的过程和回答接着往下长。

import { CLIENT_TOOL_NAMESPACE } from '../../../protocol/src/client-tools.mjs'
import type { ItemView, TurnStatus } from '../model.mjs'
import type { AgentThreadView } from '../model-tree.mjs'
import type { Text } from '../phrase.mjs'
import { spanOf } from './span.mjs'
import { agentRunState, agentStatesOf } from './tree.mjs'

/** 分块只需要知道条目的标识和种类；助手消息还要知道它是过程说明还是回答 */
export interface BlockInput {
  id: string
  kind: ItemView['kind']
  phase?: 'commentary' | 'final' | 'unknown'
  /**
   * 画成卡片的条目（cardPlace）：outside 露在过程外面（start 派出的子会话和提的提案、offer 卡、带题的助手消息）；
   * inline 排进过程里它所在的位置（启动子代理那一行），整段过程收起时跟着收；
   * tail 是收尾带的建议任务和问题：卡片画在回合最下方的收尾区，过程里它的位置只留一行
   */
  card?: CardPlace
  /** 不画的条目（quietOf）：空的收尾调用。不占块，也不算进步数 */
  quiet?: boolean
  /** 收尾调用（litch_sessions.wrap_up），空的、带建议的都是：认最终回答时看它前后（answersAroundWrapUp） */
  wrapUp?: boolean
  /** 设备进程提醒收尾的那条用户消息（event.kind 是 remind）：这个回合对用户透明，只留收尾带出来的卡片 */
  remind?: boolean
}

/** 过程里的一段 */
export type ProcessPart =
  /** 说明段：一条助手消息，按正文画 */
  | { type: 'note'; itemId: string }
  /** 步骤组：key 是组里第一个条目的标识，组里再加条目它也不变 */
  | { type: 'steps'; key: string; itemIds: string[] }
  /** 启动子代理那一行 */
  | { type: 'card'; itemId: string }

export type Block =
  | { type: 'user'; itemId: string }
  /**
   * 最终回答：有 final 的取最后一条 final；分不清阶段的取回合里最后一条助手消息。
   * 空收尾前后的回答（answersAroundQuietWrapUp）可能是几条，每条一块
   */
  | { type: 'answer'; itemId: string }
  | { type: 'plan'; itemId: string }
  | { type: 'todo'; itemId: string }
  /** 上下文压缩：一条分隔线，一直露在外面（官方桌面端也是），压的时候写“正在压缩”，压完写“已压缩” */
  | { type: 'compaction'; itemId: string }
  /** 派出的子会话、start 提的提案、offer 卡、带题的助手消息：一直露在外面 */
  | { type: 'card'; itemId: string }
  /**
   * 回合最下方的收尾区：这一回合收尾带的建议任务卡片和留给用户的问题，按调用的先后。
   * 有就排在全部块的最后（最终回答下面）；条目同时还在过程里占一行。收尾带的要等回合结束（BucketOptions）
   */
  | { type: 'tail'; itemIds: string[] }
  /**
   * 一段过程。中间夹着露在外面的块时会分成几段，回合收起时几段一起收成一行。
   * key 是这一段第一个条目的标识
   */
  | { type: 'process'; key: string; parts: ProcessPart[] }
  /** 整个回合只有提示（手动压缩上下文的那个回合就是这样）：直接露在外面，不收 */
  | { type: 'notes'; key: string; itemIds: string[] }

/**
 * 回合里哪一条助手消息是最终回答。有 final 的取最后一条 final；没有 final 时，
 * 回合里最后一条助手消息的阶段分不清（unknown）就取它；最后一条是过程说明就没有最终回答（中断了的回合常这样）
 */
export function answerOf(items: BlockInput[]): string | undefined {
  // 画成卡片的助手消息（带题的）不算回答：模型问完还在接着干活
  const messages = items.filter(
    (item) => item.kind === 'agentMessage' && item.quiet !== true && item.card === undefined,
  )
  const final = messages.findLast((item) => item.phase === 'final')
  if (final) return final.id
  const last = messages.at(-1)
  return last && last.phase !== 'commentary' ? last.id : undefined
}

/**
 * 收尾（wrap_up）前后的回答。规矩是先收尾、再写完整的回答，但模型有时还按旧顺序来：
 * 先写完整回答、再调收尾、最后补一句短话。Claude 入口把回合最后一段标成 final、之前的标成 commentary，
 * 只认最后一条就把整段回答收进了过程。所以最后一个收尾紧前面是一条助手消息、它后面只有助手消息时，
 * 前面那条连同后面那几条都算回答。新顺序下收尾前顺口说的一句也会这样露出来，代价比把整段回答收掉小。
 * 带建议的收尾在过程里只占一行（卡片在收尾区），和空收尾一样看；带题的消息和子代理那一行是卡片，不在这条规则里
 */
function answersAroundWrapUp(items: BlockInput[]): string[] {
  const at = items.findLastIndex((item) => item.quiet === true || item.wrapUp === true)
  if (at < 0) return []
  const plain = (item: BlockInput) =>
    item.kind === 'agentMessage' && item.card === undefined && item.quiet !== true
  // 连调几次空收尾的（已经收过尾又调空的会被拒，也是 quiet）：往前跳过它们
  const before = items.slice(0, at).findLast((item) => item.quiet !== true)
  const after = items.slice(at + 1)
  if (!before || !plain(before) || !after.every(plain)) return []
  return [before.id, ...after.map((item) => item.id)]
}

export interface BucketOptions {
  /** 回合还在跑：收尾带的卡片和问题先不进收尾区（过程里那一步照留），等回合结束再进 */
  turnRunning?: boolean
}

export function bucketItems(items: BlockInput[], options: BucketOptions = {}): Block[] {
  const shown = items.filter((item) => item.quiet !== true)
  // 回合里除了提示什么都没有：收起来就只剩“已处理”，等于什么都没告诉用户
  if (shown.length > 0 && shown.every((item) => item.kind === 'notice')) {
    return [{ type: 'notes', key: shown[0]?.id ?? '', itemIds: shown.map((item) => item.id) }]
  }
  // 提醒收尾的回合对用户透明：那是设备进程替用户提醒模型补调一次收尾，提醒本身、模型顺口说的话、过程都不画，
  // 只留收尾带出来的卡片（建议、问题）
  if (shown[0]?.kind === 'userMessage' && shown[0].remind === true)
    return remindBlocks(shown, options)
  const answers = new Set<string>()
  const last = answerOf(shown)
  if (last !== undefined) answers.add(last)
  for (const id of answersAroundWrapUp(items)) answers.add(id)
  const blocks: Block[] = []
  const tail: string[] = []
  /** 往过程里加一段：接在前一段过程后面，前面不是过程就开一段新的 */
  const process = (id: string): ProcessPart[] => {
    const last = blocks.at(-1)
    if (last?.type === 'process') return last.parts
    const parts: ProcessPart[] = []
    blocks.push({ type: 'process', key: id, parts })
    return parts
  }
  for (const item of shown) {
    if (item.kind === 'userMessage') {
      blocks.push({ type: 'user', itemId: item.id })
    } else if (item.kind === 'plan') {
      blocks.push({ type: 'plan', itemId: item.id })
    } else if (item.kind === 'todo') {
      // 待办进度一直露在外面，不跟着过程收起来
      blocks.push({ type: 'todo', itemId: item.id })
    } else if (item.kind === 'compaction') {
      blocks.push({ type: 'compaction', itemId: item.id })
    } else if (item.card === 'outside') {
      blocks.push({ type: 'card', itemId: item.id })
    } else if (answers.has(item.id)) {
      blocks.push({ type: 'answer', itemId: item.id })
    } else if (item.card === 'inline') {
      process(item.id).push({ type: 'card', itemId: item.id })
    } else if (item.kind === 'agentMessage') {
      process(item.id).push({ type: 'note', itemId: item.id })
    } else {
      // 收尾区的卡片在过程里照样占一行（步骤组里），卡片本身记下来排到最后；收尾带的等回合结束
      if (item.card === 'tail' && !(options.turnRunning === true && item.wrapUp === true))
        tail.push(item.id)
      const parts = process(item.id)
      const last = parts.at(-1)
      if (last?.type === 'steps') last.itemIds.push(item.id)
      else parts.push({ type: 'steps', key: item.id, itemIds: [item.id] })
    }
  }
  if (tail.length > 0) blocks.push({ type: 'tail', itemIds: tail })
  return blocks
}

/** 提醒收尾的回合画出来的：露在外面的卡片，和收尾区（建议任务、收尾的问题；收尾带的同样等回合结束）。别的都不画 */
function remindBlocks(shown: BlockInput[], options: BucketOptions): Block[] {
  const blocks: Block[] = shown
    .filter((item) => item.card === 'outside')
    .map((item) => ({ type: 'card', itemId: item.id }))
  const tail = shown
    .filter(
      (item) => item.card === 'tail' && !(options.turnRunning === true && item.wrapUp === true),
    )
    .map((item) => item.id)
  if (tail.length > 0) blocks.push({ type: 'tail', itemIds: tail })
  return blocks
}

/** 一段过程里所有条目的标识，按先后 */
export function processItemIds(parts: ProcessPart[]): string[] {
  return parts.flatMap((part) => (part.type === 'steps' ? part.itemIds : [part.itemId]))
}

/**
 * 过程是不是告一段落、可以收成一行了。照 Codex 桌面端（有最终回答、没被打断才让收）：
 * 被打断的回合不收，没有最终回答的回合结束了也不收——收起来只剩一行“已处理”“已中断”，
 * 中途做了什么、写了一半的回答都藏进去了，而停下来以后用户要看的就是这些。
 * 回合还在进行时，最终回答已经写完就算。“刚开始就说自己是最终回答”的消息只在 finalOnStart 为真时采信：
 * harness 声明了消息一开始阶段值就是准的（原生 codex），最终回答一开始就算。没声明的不信——
 * 前置验证 P6 的结论是 Claude Code 和 Pi 都要等消息写完才分得清。
 * answer 是最终回答那一条（没有就不给）
 */
export function processSettled(
  status: TurnStatus,
  answer: { kind: ItemView['kind']; phase?: string; status?: string }[],
  finalOnStart = false,
): boolean {
  if (status === 'interrupted') return false
  if (status !== 'running') return answer.length > 0
  return answer.some(
    (item) =>
      item.kind === 'agentMessage' &&
      item.phase === 'final' &&
      (finalOnStart || item.status === 'completed'),
  )
}

/**
 * 整段过程该不该自动收成一行（用户没点过那一行的时候）：告一段落了就收，
 * 除非用户在这个回合里手动展开过某一组或某一条，或者回合里还有没做完的子代理
 */
export function processFolded(settled: boolean, touched: boolean, agentsRunning: boolean): boolean {
  return settled && !touched && !agentsRunning
}

/**
 * 这个条目画不画：模型每回合最后都要调一次收尾（litch_sessions.wrap_up），没带建议、也没留问题的那种什么都不画，
 * 免得每个回合末尾多出一块。和 cardOf 一样只看条目开始时就有的东西（参数）
 */
export function quietOf(item: ItemView): boolean {
  return (
    item.kind === 'toolCall' &&
    item.wrapUp !== undefined &&
    item.wrapUp.suggestions.length === 0 &&
    item.wrapUp.ask === undefined
  )
}

/**
 * 一个条目交给 bucketItems 的样子（桌面、手机分块共用这一份）：助手消息带阶段和卡片位置，提醒收尾的那条用户消息带 remind，
 * 画成卡片的带位置（收尾调用另带 wrapUp），空收尾标 quiet，别的只有标识和种类
 */
export function blockInput(id: string, item: ItemView): BlockInput {
  const place = cardPlace(item)
  // 收尾调用（空的、带建议的）：认最终回答时看它前后
  const wrapUp = item.kind === 'toolCall' && item.wrapUp !== undefined ? { wrapUp: true } : {}
  if (item.kind === 'agentMessage')
    return { id, kind: item.kind, phase: item.phase, ...(place ? { card: place } : {}) }
  if (item.kind === 'userMessage' && item.event?.kind === 'remind')
    return { id, kind: item.kind, remind: true }
  if (place) return { id, kind: item.kind, card: place, ...wrapUp }
  if (quietOf(item)) return { id, kind: item.kind, quiet: true, ...wrapUp }
  return { id, kind: item.kind }
}

/** 卡片放哪：露在外面、排进过程、收尾区（只有带建议或问题的收尾） */
export type CardPlace = 'outside' | 'inline' | 'tail'

/**
 * 这个条目要不要画成卡片：litch_sessions.start（派出的子会话或提案）、带了建议的收尾（每条一张提案），
 * 启动子代理的那次调用（点开看子线程），和带题的助手消息。等待、发输入这些别的子代理调用还是步骤组里的一行。
 * 判断只看条目开始时就有的东西（对话区只在条目增减时重新分块），条目后来更新也不会从卡片变成一行
 */
export function cardOf(item: ItemView): boolean {
  return cardPlace(item) !== null
}

/**
 * 卡片放在哪：启动子代理那一行排进过程里（inline）；收尾带的建议任务和问题进回合最下方的收尾区（tail）；
 * 别的露在过程外面（outside）；不是卡片是 null。
 * start 派出的子会话、提的提案、offer 卡都露在调用的位置：回合中途开的卡不钉在回合末尾，随对话滚走。
 * 带题的助手消息（模型边干活边问）也露在外面：过程收起来时不能把要人回答的题一起收掉
 */
export function cardPlace(item: ItemView): CardPlace | null {
  if (item.kind === 'agentMessage') return item.questions ? 'outside' : null
  if (item.kind !== 'toolCall') return null
  if (item.spawned) return 'outside'
  // 问用户的工具画成问答卡片，露在外面：过程收起时题和回答还看得见
  if (item.asked) return 'outside'
  if (item.wrapUp) return quietOf(item) ? null : 'tail'
  // 启动子代理刚开始时还不知道子线程是谁（上游开始的事件里没有），也画成卡片，等结束时填上
  return item.agents !== undefined &&
    typeof item.tool === 'object' &&
    item.tool.key === 'collab.spawnAgent'
    ? 'inline'
    : null
}

// ---------- 步骤组的汇总 ----------

/** 步骤组汇总里的一种动作 */
export type StepKind =
  | 'read'
  | 'search'
  | 'list'
  | 'web'
  | 'command'
  | 'add'
  | 'update'
  | 'delete'
  | 'tool'
  | 'notice'
  /** 收尾建议了几个任务（卡片在回合最下方的收尾区，过程里只留这一行） */
  | 'suggest'
  /** 收尾时留了一个问题给用户（问题和按钮也在收尾区） */
  | 'ask'
  /** 给别的会话、子代理发消息（Claude Code 的 SendMessage） */
  | 'message'

// 各家 harness 自带的读、搜、列目录工具的名字（Claude Code 的 Read、Grep、Glob 投影出来是“Read 路径”这样，取第一个词）
const TOOL_KINDS: Record<string, StepKind> = {
  read: 'read',
  read_file: 'read',
  readfile: 'read',
  view: 'read',
  cat: 'read',
  grep: 'search',
  glob: 'search',
  find: 'search',
  search: 'search',
  rg: 'search',
  search_files: 'search',
  find_files: 'search',
  codebase_search: 'search',
  ls: 'list',
  list: 'list',
  list_dir: 'list',
  list_files: 'list',
  list_directory: 'list',
  webfetch: 'web',
  web_fetch: 'web',
  fetch: 'web',
  // Claude Code 的 SendMessage 投影出来是“SendMessage 收件人”
  sendmessage: 'message',
}

/** 工具调用算哪种动作：认得出的读、搜、列目录、看网页，别的都是“调用工具” */
export function toolKind(tool: Text): StepKind {
  if (typeof tool !== 'string') return 'tool'
  const word = tool.trim().split(/\s+/, 1)[0]?.toLowerCase() ?? ''
  return TOOL_KINDS[word] ?? 'tool'
}

/** 条目在汇总里算哪种动作。思考不算（null），助手消息、计划这些不进步骤组的也是 null */
export function stepKindOf(item: ItemView): StepKind | null {
  switch (item.kind) {
    case 'command':
      return 'command'
    case 'fileChange': {
      const first = item.changes[0]
      return first ? first.change : 'update'
    }
    case 'toolCall':
      if (item.wrapUp) return item.wrapUp.suggestions.length > 0 ? 'suggest' : 'ask'
      if (item.spawned?.via === 'start') return 'suggest'
      // 会话工具的 read、list 读的是会话，不是文件、目录
      if (item.source === CLIENT_TOOL_NAMESPACE.sessions) return 'tool'
      return toolKind(item.tool)
    case 'webSearch':
      return 'web'
    case 'notice':
      return 'notice'
    default:
      return null
  }
}

/** 条目失败了没有。拒绝了的不算失败，另算 */
export function stepFailed(item: ItemView): boolean {
  switch (item.kind) {
    case 'command':
      return (
        item.status !== 'declined' &&
        (item.status === 'failed' || (item.exitCode !== null && item.exitCode !== 0))
      )
    case 'fileChange':
      return item.status === 'failed'
    case 'toolCall':
      return item.status === 'failed' || (item.status !== 'declined' && item.error !== null)
    default:
      return false
  }
}

const declinedOf = (item: ItemView): boolean =>
  (item.kind === 'command' || item.kind === 'fileChange' || item.kind === 'toolCall') &&
  item.status === 'declined'

export interface StepsTally {
  /** 动作和个数，按组里第一次出现的先后。改文件按路径数，同一个文件改几次算一个 */
  counts: { kind: StepKind; n: number }[]
  /** 有字的思考几条（不进汇总文字；没字的思考不画、不算） */
  thoughts: number
  /** 工具步骤数：不算思考、不算提示 */
  steps: number
  failed: number
  declined: number
  /** 改文件加了、删了几行 */
  added: number
  removed: number
  /**
   * 这一组从第一条开始到最后一条结束用了多久（含思考、模型出字，按条目上记的 span）。
   * 没记过时刻（从历史里读出来的）时只有一条报了用时的就用它，别的是 null
   */
  durationMs: number | null
  /** 第一条提示的文字：组里只有一条提示时汇总直接写它 */
  notice: Text | null
}

/** 一组条目的汇总。纯函数，界面按它写汇总行 */
export function stepsTally(items: ItemView[]): StepsTally {
  const order: StepKind[] = []
  const counts = new Map<StepKind, number>()
  const paths = new Map<StepKind, Set<string>>()
  const bump = (kind: StepKind, n = 1) => {
    if (!counts.has(kind)) order.push(kind)
    counts.set(kind, (counts.get(kind) ?? 0) + n)
  }
  const tally: StepsTally = {
    counts: [],
    thoughts: 0,
    steps: 0,
    failed: 0,
    declined: 0,
    added: 0,
    removed: 0,
    durationMs: null,
    notice: null,
  }
  /** 报了用时的条目（没记过时刻时，只有一条的就用它的） */
  const timed: number[] = []
  for (const item of items) {
    if (item.kind === 'reasoning') {
      if (thoughtShown(item)) tally.thoughts++
      continue
    }
    const kind = stepKindOf(item)
    if (kind === null) continue
    if (kind === 'notice') {
      bump('notice')
      if (item.kind === 'notice' && tally.notice === null) tally.notice = item.label
      continue
    }
    // 建议任务、收尾的问题：卡片在收尾区，这里只记个数，不算工具步骤
    if (kind === 'suggest' || kind === 'ask') {
      bump(kind, item.kind === 'toolCall' && item.wrapUp ? item.wrapUp.suggestions.length || 1 : 1)
      continue
    }
    tally.steps++
    if (stepFailed(item)) tally.failed++
    if (declinedOf(item)) tally.declined++
    if (item.kind === 'fileChange') {
      if (item.changes.length === 0) bump('update')
      for (const change of item.changes) {
        tally.added += change.added
        tally.removed += change.removed
        const seen = paths.get(change.change) ?? new Set<string>()
        paths.set(change.change, seen)
        const path = change.movedTo ?? change.path
        if (seen.has(path)) continue
        seen.add(path)
        bump(change.change)
      }
      continue
    }
    if ((item.kind === 'command' || item.kind === 'toolCall') && item.durationMs !== null) {
      timed.push(item.durationMs)
    }
    bump(kind)
  }
  tally.counts = order.map((kind) => ({ kind, n: counts.get(kind) ?? 0 }))
  tally.durationMs =
    spanOf(items) ?? (timed.length === 1 && items.length === 1 ? timed[0] : null) ?? null
  return tally
}

/**
 * 思考条目画不画：有可显示的字才画（一行次要的浅字，点开看全文）。引擎只给了加密的、空的推理，
 * 想完了就不画、不算；还在想的照样占一行（汇总行上写“正在工作”）
 */
export function thoughtShown(item: { kind: string; text?: string; status?: string }): boolean {
  if (item.kind !== 'reasoning') return true
  return (item.text ?? '').trim() !== '' || item.status === 'inProgress'
}

export interface ProcessTally {
  /** 说明段几段 */
  notes: number
  /** 工具步骤数（不数说明、思考、提示） */
  steps: number
  /** 启动了几个子代理 */
  agents: number
  /** 失败的步骤数 */
  failed: number
  /** 被拒的步骤数 */
  declined: number
  /** 失败的子代理数：以子线程为准（agentRunState），没给子代理列表时按条目里报的状态算 */
  agentsFailed: number
}

/** 整段过程的汇总，给回合结束后收成的那一行用。threads 是父会话的子代理列表（keys.agents） */
export function processTally(
  items: ItemView[],
  threads?: readonly AgentThreadView[] | null,
): ProcessTally {
  const tally: ProcessTally = {
    notes: 0,
    steps: 0,
    agents: 0,
    failed: 0,
    declined: 0,
    agentsFailed: 0,
  }
  const steps: ItemView[] = []
  const reported = agentStatesOf(items)
  for (const item of items) {
    if (item.kind === 'agentMessage') {
      tally.notes++
    } else if (cardPlace(item) === 'inline' && item.kind === 'toolCall') {
      const agents = item.agents ?? []
      tally.agents += Math.max(1, agents.length)
      tally.agentsFailed += agents.filter((agent) => {
        const thread = threads?.find((entry) => entry.id === agent.threadId)
        return agentRunState(thread, reported.get(agent.threadId), agent.state) === 'failed'
      }).length
    } else {
      steps.push(item)
    }
  }
  const inner = stepsTally(steps)
  tally.steps = inner.steps
  tally.failed = inner.failed
  tally.declined = inner.declined
  return tally
}
