import { randomUUID } from 'node:crypto'
// litch_sessions：模型列出、读取这台设备上的会话，派子会话，给自己的子会话发消息、打断，等它们停下。
// 执行方是设备进程（device-tools.mts 注册的一个命名空间），工具定义在 packages/protocol/src/client-tools-sessions.mts。
// 读类（list、read、wait）能看这台设备上所有会话，options 列能用的 harness 和型号（session-options.mts）；写类（send、interrupt）只能作用于调用者自己的 Litch 子孙会话，
// 别的一律 [litch:blocked]，引擎自己的子代理线程另外提示用引擎自己的工具。归档（archive）照 Claude 桌面端的 archive_session：
// 这台设备上哪个会话都行（self 是这个会话自己，回合结束时归档），只在用户亲手发起的回合里收，在干活的、置顶的不归档；
// 恢复（unarchive）自己的子孙随时可以，别的也要用户发起的回合（session-archive.mts）。提案类（start 出提案、accept、withdraw）
// 只作用于调用者自己会话上的提案；提案的门槛（一回合几张、同标题、fresh 简报的显示宽度）在 start 和 wrap_up 里查。
// wrap_up 是每回合收尾必调的（干完活先调它、再写最终回答）：每条建议成一张提案，调没调记在会话树里
// （没调的用户回合结束后设备进程开回合提醒）。设置里“每回合收尾”关掉时新会话没有这个工具（session-tree.mts）。
// start 的 initiation offer 只带标题落一张 offer 卡，调用一直等到用户选（或者又发了话、回合结束）；选了新会话的，
// 模型再用 accept 带上简报开起来。hand_off 把做到一半的任务交给一个分叉到这个回合之前的子会话，立刻开始。
// 这个 harness 的任务卡关着（设备设置 harness.<id>.taskCards）时当场生效：wrap_up 的建议一条都不落、propose 回 blocked、
// offer 直接当在这里做；wrap_up 的 ask、actions 只整理（wrapUpAsk）、不存库，界面从调用参数里读。
// start、accept（补 offer 的简报）、wrap_up 的建议里模型给的 harness、model 先查这台设备上有没有（不认的回 invalid，带可选项），
// 免得开出第一轮就报错的会话。
// 结果是一段 JSON 文字，失败第一行是 [litch:<kind>]，后面是模型能照着改的一句话。
import {
  type ClientToolCallResponse,
  type ClientToolFailureKind,
  clientToolFailure,
} from '../../protocol/src/client-tools.mjs'
import {
  SESSION_SELF,
  SESSION_TOOL,
  SESSION_TOOL_LIMITS,
  type SessionStatusWord,
  type SessionSummary,
  type SessionsArchiveResult,
  type SessionsHandOffResult,
  type SessionsStartResult,
  type SessionsUnarchiveResult,
  type SessionsWithdrawResult,
  type SessionsWrapUpResult,
  type SessionTurnSummary,
  textWidth,
  wrapUpAsk,
} from '../../protocol/src/client-tools-sessions.mjs'
import {
  parseSessionEvent,
  SESSION_TREE_LIMITS,
  type SessionLineageKind,
  type SessionProposal,
} from '../../protocol/src/session-tree.mjs'
import type { DeviceToolCall, DeviceToolHandler } from './device-tools.mjs'
import type { Cascade, SessionArchives } from './session-archive.mjs'
import { checkHarness, modelFor, sessionOptions } from './session-options.mjs'
import { PendingRefused } from './session-pending.mjs'
import {
  acceptProposal,
  StartRefused,
  startChild,
  threadTitle,
  widerSandbox,
  worktreeDefault,
} from './session-start.mjs'
import { lastAnswer, type OfferOutcome, type SessionTree, trimText } from './session-tree.mjs'
import { isObject } from './wire.mjs'

/** 参数不对、对象不对：直接回给模型的失败 */
class Refused extends Error {
  readonly kind: ClientToolFailureKind

  constructor(kind: ClientToolFailureKind, message: string) {
    super(message)
    this.kind = kind
  }
}

const ok = (value: unknown): ClientToolCallResponse => ({
  success: true,
  contentItems: [{ type: 'inputText', text: JSON.stringify(value) }],
})

function string(args: Record<string, unknown>, name: string, required: true): string
function string(args: Record<string, unknown>, name: string, required?: false): string | undefined
function string(args: Record<string, unknown>, name: string, required = false): string | undefined {
  const value = args[name]
  if (value === undefined || value === null) {
    if (required) throw new Refused('invalid', `${name} is required.`)
    return undefined
  }
  if (typeof value !== 'string' || (required && !value.trim()))
    throw new Refused('invalid', `${name} must be a non-empty string.`)
  return value
}

function integer(
  args: Record<string, unknown>,
  name: string,
  fallback: number,
  max: number,
): number {
  const value = args[name] ?? fallback
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > max)
    throw new Refused('invalid', `${name} must be an integer from 1 to ${max}.`)
  return value
}

/** 会话的状态词：设备进程看到的（在跑、等用户）优先，其次是引擎在会话对象上报的 */
function statusWord(tree: SessionTree, thread: Record<string, unknown>): SessionStatusWord {
  const id = String(thread.id)
  const status = isObject(thread.status) ? thread.status : null
  const flags = Array.isArray(status?.activeFlags) ? status.activeFlags : []
  if (tree.waitingOnUser(id) || flags.length > 0) return 'needsUser'
  if (status?.type === 'active' || tree.isActive(id)) return 'running'
  if (status?.type === 'systemError') return 'failed'
  return 'idle'
}

function summary(
  tree: SessionTree,
  harness: string,
  thread: Record<string, unknown>,
  caller: string,
): SessionSummary {
  const id = String(thread.id)
  const lineage = tree.store.parentOf(id)
  return {
    thread_id: id,
    title: threadTitle(thread, lineage?.title),
    harness,
    cwd: typeof thread.cwd === 'string' ? thread.cwd : '',
    status: statusWord(tree, thread),
    updated_at: Number(thread.updatedAt) || 0,
    parent_thread_id: lineage?.parentThreadId ?? null,
    mine: tree.store.descends(id, caller),
  }
}

/** 一个回合给模型看的样子：用户（或注入）的话、最后的回答，都掐过 */
function turnSummary(turn: Record<string, unknown>): SessionTurnSummary {
  const items = Array.isArray(turn.items) ? turn.items : []
  const said = items
    .filter((item) => isObject(item) && item.type === 'userMessage')
    .flatMap((item) => (Array.isArray(item.content) ? item.content : []))
    .filter((part) => isObject(part) && part.type === 'text' && typeof part.text === 'string')
    .map((part) => parseSessionEvent(String(part.text)).rest || String(part.text))
    .join('\n')
  const status = ['completed', 'failed', 'interrupted', 'inProgress'].includes(String(turn.status))
    ? (turn.status as SessionTurnSummary['status'])
    : 'completed'
  const answer = status === 'inProgress' ? null : lastAnswer(turn)
  const limit = SESSION_TOOL_LIMITS.readTextChars
  return {
    input: trimText(said, limit),
    answer: answer === null ? null : trimText(answer, limit),
    status,
  }
}

async function list(tree: SessionTree, args: Record<string, unknown>, call: DeviceToolCall) {
  const scope = string(args, 'scope') ?? 'all'
  if (scope !== 'all' && scope !== 'mine')
    throw new Refused('invalid', 'scope must be mine or all.')
  const harness = string(args, 'harness')
  const cwd = string(args, 'cwd')
  const status = string(args, 'status')
  if (status !== undefined && status !== 'running' && status !== 'idle')
    throw new Refused('invalid', 'status must be running or idle.')
  const limit = integer(args, 'limit', 20, SESSION_TOOL_LIMITS.listMax)
  const rows: { harness: string; thread: Record<string, unknown> }[] = []
  if (scope === 'mine') {
    for (const child of tree.store.descendants(call.threadId)) {
      const found = await tree.read(child.threadId, false).catch(() => null)
      if (found) rows.push(found)
    }
  } else {
    const sources = tree.host.harnesses().filter((source) => !harness || source.id === harness)
    await Promise.all(
      sources.map(async (source) => {
        try {
          const link = await tree.link(source.id)
          const result = await link.request('thread/list', {
            limit: SESSION_TOOL_LIMITS.listMax,
            sortKey: 'updated_at',
            sortDirection: 'desc',
            ...(cwd ? { cwd } : {}),
          })
          const data = isObject(result) && Array.isArray(result.data) ? result.data : []
          for (const thread of data) if (isObject(thread)) rows.push({ harness: source.id, thread })
        } catch {
          // 这个 harness 现在不可用：它的会话这一次列不出来
        }
      }),
    )
  }
  const sessions = rows
    .filter((row) => !harness || row.harness === harness)
    .filter((row) => !cwd || row.thread.cwd === cwd)
    .map((row) => summary(tree, row.harness, row.thread, call.threadId))
    .filter(
      (one) => !status || (status === 'running' ? one.status !== 'idle' : one.status === 'idle'),
    )
    .sort((a, b) => b.updated_at - a.updated_at)
  return { sessions: sessions.slice(0, limit), truncated: sessions.length > limit }
}

async function read(tree: SessionTree, args: Record<string, unknown>, call: DeviceToolCall) {
  const threadId = string(args, 'thread_id', true)
  const count = integer(
    args,
    'turns',
    SESSION_TOOL_LIMITS.readTurnsDefault,
    SESSION_TOOL_LIMITS.readTurnsMax,
  )
  const { harness, thread } = await found(tree, threadId)
  const turns = (Array.isArray(thread.turns) ? thread.turns : []).filter(isObject).slice(-count)
  return {
    session: summary(tree, harness, thread, call.threadId),
    turns: turns.map(turnSummary),
    pending_requests: tree.pendingRequests(threadId),
    delegated_responses: tree.store.responses(threadId),
  }
}

/** 读一个会话；没有这个会话按参数不对回 */
function found(tree: SessionTree, threadId: string, includeTurns = true) {
  return tree.read(threadId, includeTurns).catch((error: unknown) => {
    throw new Refused('invalid', `Cannot read session ${threadId}: ${messageOf(error)}`)
  })
}

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error))

/** 标题比较时去掉全部空白、不分大小写 */
const sameTitle = (title: string) => title.replace(/\s+/g, '').toLowerCase()

/** 提案的门槛：一个回合最多几张（提醒回合连同它替之提醒的那个用户回合算）；同一会话里还在等的提案不能同标题 */
function gate(tree: SessionTree, call: DeviceToolCall, title: string): void {
  const limit = SESSION_TOOL_LIMITS.proposalsPerTurn
  if (call.turnId && tree.proposalsInTurn(call.threadId, call.turnId) >= limit)
    throw new Refused(
      'blocked',
      `You already proposed ${limit} cards in this turn, the most allowed. Do not propose more now; if other follow-ups are left, mention them in your reply.`,
    )
  const key = sameTitle(title)
  const twin = tree.proposals(call.threadId).find((one) => sameTitle(one.title) === key)
  if (twin)
    throw new Refused(
      'invalid',
      `A proposal titled "${twin.title}" (proposal_id ${twin.id}) is still waiting for the user. Do not propose the same work twice. If the new one replaces it, give it a different title, then withdraw the old one with litch_sessions.withdraw.`,
    )
}

/** start 和 wrap_up 里一条建议共有的那几项 */
interface Spec {
  title: string
  prompt: string
  /** 任务之前的背景；fork 是空串（不记） */
  background: string
  harness: string | undefined
  model: string | undefined
  effort: string | undefined
  cwd: string | undefined
  kind: SessionLineageKind
  /** 要不要自己的工作树；不给照缺省 */
  worktree: boolean | undefined
}

/** 子会话起在哪：harness、模型、强度、目录、fresh 还是 fork。harness 要在这台设备上，fork 只能同 harness */
function targetOf(
  args: Record<string, unknown>,
  call: DeviceToolCall,
  tree: SessionTree,
): Omit<Spec, 'title' | 'prompt' | 'background'> {
  const manager = tree.managers?.lines.managerFor(call.threadId)
  const harness = string(args, 'harness') ?? manager?.dispatch.harness ?? manager?.harness
  const model = string(args, 'model')
  const effort = string(args, 'effort')
  const cwd = string(args, 'cwd')
  const kind = string(args, 'kind') ?? 'fresh'
  if (kind !== 'fresh' && kind !== 'fork')
    throw new Refused('invalid', 'kind must be fresh or fork.')
  const worktree = args.worktree ?? undefined
  if (worktree !== undefined && typeof worktree !== 'boolean')
    throw new Refused('invalid', 'worktree must be true or false.')
  if (harness) checkHarness(tree, harness)
  if (kind === 'fork' && harness && harness !== call.harness)
    throw new Refused('invalid', `fork only works within the same harness (${call.harness}).`)
  return { harness, model, effort, cwd, kind, worktree }
}

/** 模型这次给的 model 在目标 harness 上认不认，认的换成清单里的写法（session-options.mts 的 modelFor） */
async function checked<T extends { harness: string | undefined; model: string | undefined }>(
  tree: SessionTree,
  call: DeviceToolCall,
  target: T,
): Promise<T> {
  return { ...target, model: await modelFor(tree, call, target.harness, target.model) }
}

/**
 * 读一条 start 或建议的参数并查一遍：标题、任务、harness、fork 只能同 harness、fresh 背景的宽度。
 * 任务只要非空；fork 带着整段对话，背景不查也不记
 */
function specOf(args: Record<string, unknown>, call: DeviceToolCall, tree: SessionTree): Spec {
  const title = string(args, 'title', true)
  const prompt = string(args, 'prompt', true)
  const target = targetOf(args, call, tree)
  const fresh = target.kind === 'fresh'
  const background = fresh ? (string(args, 'background') ?? '') : ''
  for (const [name, value] of [
    ['prompt', prompt],
    ['background', background],
  ] as const)
    if (value.length > SESSION_TOOL_LIMITS.messageChars)
      throw new Refused(
        'invalid',
        `${name} is longer than ${SESSION_TOOL_LIMITS.messageChars} characters; shorten it and point to files instead.`,
      )
  // fresh 的子会话看不到这个会话：背景太短的不管直接起还是变成提案都拒绝。按显示宽度算，汉字这类等宽字符算 2
  const width = textWidth(background.trim())
  const least = SESSION_TOOL_LIMITS.freshBackgroundMinWidth
  if (fresh && width < least)
    throw new Refused(
      'invalid',
      `background is ${width === 0 ? 'missing' : `too short (width ${width}; each CJK or other full-width character counts as 2, everything else as 1)`}: a fresh session cannot see this conversation, so background needs a width of at least ${least} (about ${least / 2} Chinese characters or ${least} English letters). Write it for someone who has not read any of this: the overall goal, what has been decided or ruled out so far, the constraints, and how this piece fits in; keep the task itself in prompt. Then try again.`,
    )
  return { title, prompt, background, ...target }
}

/** 目标 harness 收不到父会话那么严时子会话实际会是的那一档沙箱；收得紧、判断不了是 null */
const widerFor = (tree: SessionTree, call: DeviceToolCall, spec: Spec) =>
  widerSandbox(tree, call.threadId, spec.harness ?? call.harness).catch(() => null)

/** 起出来的子会话在新工作树里时，结果里说一句在哪个分支上 */
const worktreeNote = (branch: string | null) =>
  branch ? ` in a new git worktree on branch ${branch}` : ''

/** 过门槛、落一张提案。门槛在落库之前同步查，同一回合里并发的几次 start 不会一起漏过去 */
function proposeOne(
  tree: SessionTree,
  call: DeviceToolCall,
  spec: Spec,
  wider: string | null,
  fallback: boolean,
): SessionProposal {
  const title = spec.title.trim().slice(0, 120)
  gate(tree, call, title)
  return tree.propose({
    threadId: call.threadId,
    title,
    prompt: spec.prompt,
    background: spec.background,
    harness: spec.harness ?? null,
    model: spec.model ?? null,
    effort: spec.effort ?? null,
    cwd: spec.cwd ?? null,
    kind: spec.kind,
    worktree: spec.worktree ?? null,
    worktreeDefault: fallback,
    // 子会话停下后唤不唤醒由 Litch 定，不交给模型：模型派的、提的一律唤醒（用户从卡片开始时可以改）
    wakeParent: true,
    turnId: call.turnId || null,
    callId: call.callId || null,
    ...(wider ? { widerSandbox: wider } : {}),
  })
}

const EXPIRES = `it expires in ${SESSION_TREE_LIMITS.proposalTtlSeconds / 86400} days`

/** 这个 harness 的任务卡关着时，建议、提案不落卡的原因（已经建好的会话手里还有建议的工具，当场生效靠它） */
const cardsOff = (harness: string) =>
  `Task cards are turned off for ${harness} on this device, so no card was made. Do not suggest work as cards in this session; if a follow-up matters, mention it in your answer.`

async function start(
  tree: SessionTree,
  args: Record<string, unknown>,
  call: DeviceToolCall,
  signal: AbortSignal,
): Promise<SessionsStartResult> {
  const initiation = string(args, 'initiation') ?? 'propose'
  const cards = tree.host.taskCards(call.harness)
  if (initiation === 'offer') return cards ? offer(tree, args, call, signal) : offerOff(args, call)
  if (initiation !== 'user_asked' && initiation !== 'propose')
    throw new Refused('invalid', 'initiation must be user_asked, propose or offer.')
  const spec = await checked(tree, call, specOf(args, call, tree))
  // 目标 harness 收不到父会话那么严（比如没有沙箱的 Pi）：模型派的一律变成提案，由用户看过再点
  const wider = await widerFor(tree, call, spec)
  // 只有用户亲手发起的这个回合里、模型说是用户要的，才直接起；别的一律变成提案
  const userTurn =
    tree.isUserTurn(call.harness, call.turnId) ||
    Boolean(tree.managers?.store.forThread(call.threadId))
  if (initiation === 'user_asked' && userTurn && wider === null) {
    const child = await startChild(
      tree,
      call.threadId,
      {
        harness: spec.harness ?? null,
        model: spec.model ?? null,
        effort: spec.effort ?? null,
        cwd: spec.cwd ?? null,
        kind: spec.kind,
        title: spec.title,
        prompt: spec.prompt,
        background: spec.background,
        wakeParent: true,
        worktree: spec.worktree ?? null,
      },
      'model',
    )
    return {
      thread_id: child.threadId,
      note: `Started sub-session ${child.threadId} on ${child.harness}${worktreeNote(child.branch)}. It runs on its own; you will be woken with its result as a <litch-session-event> message. Do not poll it.`,
    }
  }
  const why =
    initiation !== 'user_asked'
      ? ''
      : !userTurn
        ? 'This turn was not started by the user typing a message, so the request became a proposal. '
        : `${spec.harness ?? call.harness} cannot be sandboxed as tightly as this session (it would run with ${wider}), so the request became a proposal for the user to approve. `
  // 任务卡关着：不落卡。用户要的、只是降成了提案的，让用户自己从会话菜单开
  if (!cards)
    throw new Refused(
      'blocked',
      `${why}${cardsOff(call.harness)}${initiation === 'user_asked' ? ' Tell the user they can start it themselves from the session menu (Start a sub-session).' : ''}`,
    )
  const proposal = proposeOne(
    tree,
    call,
    spec,
    wider,
    await worktreeDefault(tree, call.threadId, spec.cwd ?? null),
  )
  return {
    proposal_id: proposal.id,
    note: `${why}The user now sees a proposal card for "${proposal.title}". Nothing runs until they accept it; ${EXPIRES}. Do not do the work here as well.`,
  }
}

/**
 * offer：用户这条消息是和这个会话无关的新任务。只带标题落一张 offer 卡（offered，算进一回合几张的门槛），
 * 调用一直等到它了结：用户选了（新会话 / 在这里做）、用户又发了话、回合被打断或结束。只在用户亲手发起的回合里收。
 * harness、model、cwd、kind 给了的话记在卡上，模型 accept 补简报时没给的照它们
 */
async function offer(
  tree: SessionTree,
  args: Record<string, unknown>,
  call: DeviceToolCall,
  signal: AbortSignal,
): Promise<SessionsStartResult> {
  const title = string(args, 'title', true).trim().slice(0, 120)
  if (
    (args.prompt !== undefined && args.prompt !== null) ||
    (args.background !== undefined && args.background !== null)
  )
    throw new Refused(
      'invalid',
      'An offer takes the title only. Call start again with initiation "offer" and no prompt or background; if the user chooses a new session, you pass the brief to accept.',
    )
  const target = await checked(tree, call, targetOf(args, call, tree))
  if (!tree.isUserTurn(call.harness, call.turnId))
    throw new Refused(
      'blocked',
      `An offer is only for a new task in a message the user just typed, and this turn was not started that way. Do the work here, or suggest it with ${tree.hasWrapUp(call.threadId) ? 'wrap_up' : 'start (initiation "propose")'}.`,
    )
  const fallback = await worktreeDefault(tree, call.threadId, target.cwd ?? null)
  gate(tree, call, title)
  const proposal = tree.propose({
    threadId: call.threadId,
    title,
    prompt: '',
    background: '',
    harness: target.harness ?? null,
    model: target.model ?? null,
    effort: target.effort ?? null,
    cwd: target.cwd ?? null,
    kind: target.kind,
    // offer 卡上的工作树开关由用户定（选新会话时带回来），模型给的不认
    worktree: null,
    worktreeDefault: fallback,
    wakeParent: true,
    turnId: call.turnId || null,
    callId: call.callId || null,
    offer: true,
  })
  const outcome = await tree.waitOffer(proposal, signal)
  return {
    proposal_id: proposal.id,
    choice: outcome.choice,
    note: offerNote(proposal, outcome),
  }
}

/** 任务卡关着时的 offer：不出卡，直接当在这里做 */
function offerOff(args: Record<string, unknown>, call: DeviceToolCall): SessionsStartResult {
  const title = string(args, 'title', true).trim().slice(0, 120)
  return {
    choice: 'here',
    note: `Task cards are turned off for ${call.harness} on this device, so there is no "New session" card: do "${title}" here, in this session.`,
  }
}

/** offer 了结之后给模型的那句话：接下来怎么做 */
function offerNote(proposal: SessionProposal, outcome: OfferOutcome): string {
  const title = `"${proposal.title}"`
  if (outcome.choice === 'session')
    return `The user chose a new session for ${title}. Now call litch_sessions.accept with proposal_id ${proposal.id} and the full brief. A fresh session cannot see this conversation, so give it background (the overall goal, what has been decided so far, the constraints, how this fits in; a width of at least ${SESSION_TOOL_LIMITS.freshBackgroundMinWidth}, each CJK character counts as 2) and prompt (the task, the files or area, and what done looks like). Add harness, model, cwd or kind only if they should differ from this session. Do not do the work here.`
  switch (outcome.reason) {
    case 'spoke':
      return `The user sent a new message instead of choosing, which counts as doing ${title} here. Read their new message and go on in this session; do not start a session for it.`
    case 'interrupted':
      return `The user interrupted the turn instead of choosing; ${title} now counts as done here. Stop and wait for the user.`
    case 'ended':
      return `The turn ended before the user chose; ${title} now counts as done here.`
    default:
      return `The user chose to do ${title} here. Do it in this session now; do not start a session for it.`
  }
}

/**
 * 收尾：记下这个回合调过了（不调的话用户回合结束后设备进程会开回合提醒），每条建议照 start(propose) 的门槛
 * 落一张提案（callId 是这次 wrap_up）。某条不收的写 refused 和能照着改的原因，其余照收；空列表也是成功
 */
async function wrapUp(
  tree: SessionTree,
  args: Record<string, unknown>,
  call: DeviceToolCall,
): Promise<SessionsWrapUpResult> {
  const given = args.suggestions
  if (!Array.isArray(given))
    throw new Refused(
      'invalid',
      'suggestions must be an array: the suggested tasks of this turn, or [] when there are none. Call wrap_up again.',
    )
  // 提醒回合补调的收尾：回答已经在上一个回合里了，只要一句。别的回合先收尾、再写完整的最终回答
  const reminder = tree.isReminderTurn(call.threadId, call.turnId)
  const finish = reminder
    ? 'End your turn now, with at most one short line; do not repeat your last reply.'
    : 'Now write your final answer to the user as the last message of this turn, complete on its own (not a summary of or a pointer to earlier text). If you already wrote the full answer earlier in this turn, do not repeat it; end with at most one short line.'
  // 已经收过尾又来一次空的：有的模型不写字就结束不了回合，会一遍遍调空收尾。回一个错，让它去写回答
  if (given.length === 0 && tree.isWrappedUp(call.threadId, call.turnId))
    throw new Refused(
      'invalid',
      `This turn is already wrapped up; do not call wrap_up again. ${finish}`,
    )
  tree.wrappedUp(call.threadId, call.turnId)
  // 问题和按钮不建提案、不存库，界面从这次调用的参数里读；这里只按规矩整理一遍，改过的话提一句
  const asked = wrapUpAsk(args)
  const cards = tree.host.taskCards(call.harness)
  const suggestions: SessionsWrapUpResult['suggestions'] = []
  // 一条一条来：前面落下的提案算进后面的门槛（一回合几张、同标题）
  for (const one of given) {
    const title = isObject(one) && typeof one.title === 'string' ? one.title.trim() : ''
    if (!cards) {
      suggestions.push({ title, refused: cardsOff(call.harness) })
      continue
    }
    try {
      if (!isObject(one))
        throw new Refused(
          'invalid',
          'Each suggestion must be an object with title, prompt and (for fresh) background.',
        )
      const spec = await checked(tree, call, specOf(one, call, tree))
      const proposal = proposeOne(
        tree,
        call,
        spec,
        await widerFor(tree, call, spec),
        await worktreeDefault(tree, call.threadId, spec.cwd ?? null),
      )
      suggestions.push({ title: proposal.title, proposal_id: proposal.id })
    } catch (error) {
      suggestions.push({ title, refused: messageOf(error) })
    }
  }
  const made = suggestions.filter((one) => one.proposal_id).length
  const refused = suggestions.length - made
  const parts = [
    given.length === 0
      ? 'Nothing suggested.'
      : made > 0
        ? `The user now sees ${made} suggested-task card${made > 1 ? 's' : ''}; nothing runs until they start one, and ${EXPIRES}. Do not do that work here as well.`
        : cards
          ? 'No card was made.'
          : '',
    ...(asked.value
      ? [
          `The user sees your question${asked.value.actions.length ? ' with its buttons' : ''} at the end of the turn${asked.trimmed ? ' (shortened to fit the limits)' : ''}; a click comes back to you as their message.`,
        ]
      : asked.trimmed
        ? ['ask was empty, so no question or buttons are shown.']
        : []),
    !cards && refused > 0
      ? `${cardsOff(call.harness)} ${finish}`
      : refused > 0
        ? `${refused} suggestion${refused > 1 ? 's were' : ' was'} refused (see refused). If you can fix them, call wrap_up again with only the fixed ones first; otherwise mention that work in one line. ${finish}`
        : `Your turn is wrapped up; do not call wrap_up again. ${finish}`,
  ]
  return { suggestions, note: parts.filter(Boolean).join(' ') }
}

/** 调用者自己的提案（挂在调用者这个会话上的）。没有这个提案、别人的都回给模型 */
function ownProposal(tree: SessionTree, proposalId: string, call: DeviceToolCall): SessionProposal {
  const proposal = tree.proposal(proposalId)
  if (!proposal)
    throw new Refused(
      'invalid',
      `There is no proposal ${proposalId}. Use the proposal_id returned by start.`,
    )
  if (proposal.threadId !== call.threadId)
    throw new Refused(
      'blocked',
      `Proposal ${proposalId} belongs to another session; you can only act on proposals you made in this session.`,
    )
  return proposal
}

const settledWord: Record<Exclude<SessionProposal['status'], 'pending' | 'started'>, string> = {
  offered: 'it is an offer waiting for the user to choose',
  chosen: 'the user chose a new session for it; start it with accept and the brief',
  here: 'the user chose to do it here',
  dismissed: 'the user dismissed it',
  withdrawn: 'it was withdrawn',
  expired: 'it expired',
}

/** accept 里只有开始 offer 卡时才给的简报字段 */
const BRIEF_FIELDS = [
  'prompt',
  'background',
  'title',
  'harness',
  'model',
  'effort',
  'cwd',
  'kind',
] as const

/**
 * 用户在这个回合里让开始某张提案：按提案原样起（同用户点“开始”），只在用户亲手发起的回合里允许。
 * 自己的 offer 卡走 acceptOffer（用户选了新会话，模型补简报开起来）
 */
async function accept(
  tree: SessionTree,
  args: Record<string, unknown>,
  call: DeviceToolCall,
): Promise<SessionsStartResult> {
  const proposalId = string(args, 'proposal_id', true)
  const mine = tree.proposal(proposalId)
  if (mine?.offer && mine.threadId === call.threadId) return acceptOffer(tree, args, call, mine)
  if (!tree.isUserTurn(call.harness, call.turnId))
    throw new Refused(
      'blocked',
      'This turn was not started by the user typing a message, so you cannot start proposals for them. Tell the user they can start it from the card.',
    )
  const proposal = ownProposal(tree, proposalId, call)
  if (BRIEF_FIELDS.some((name) => args[name] !== undefined && args[name] !== null))
    throw new Refused(
      'invalid',
      `prompt, background, title, harness, model, effort, cwd and kind are only for an offer the user answered with "New session"; proposal ${proposalId} starts as it was proposed. Call accept again with proposal_id only.`,
    )
  // 正在被用户点开始：等它起完，按已经开始了答
  const running = tree.accepting.get(proposalId)
  if (running) {
    const child = await running.catch(() => null)
    if (child)
      return {
        thread_id: child.threadId,
        note: `The user already started this proposal as session ${child.threadId}. Do not start it again.`,
      }
  }
  const current = tree.proposal(proposalId) ?? proposal
  if (current.status === 'started' && current.startedThreadId)
    return {
      thread_id: current.startedThreadId,
      note: `This proposal was already started as session ${current.startedThreadId}. Do not start it again.`,
    }
  if (current.status !== 'pending' && current.status !== 'started')
    throw new Refused(
      'invalid',
      `Proposal ${proposalId} cannot be started: ${settledWord[current.status]}. If the user wants this work now, start it with litch_sessions.start (initiation "user_asked").`,
    )
  // 目标 harness 收不到父会话那么严：要用户在卡片上看过提醒自己点
  if (current.widerSandbox)
    throw new Refused(
      'blocked',
      `This proposal would run with a wider sandbox (${current.widerSandbox}) than this session, so only the user can start it, from the card. Tell them so.`,
    )
  const child = await acceptProposal(tree, proposalId)
  return {
    thread_id: child.threadId,
    note: `Started sub-session ${child.threadId} on ${child.harness}${worktreeNote(child.branch)} from the proposal. It runs on its own; ${current.wakeParent ? 'you will be woken with its result as a <litch-session-event> message' : 'its result is attached to the next user message'}. Do not poll it.`,
  }
}

/**
 * 开始一张自己的 offer 卡：用户选了新会话（chosen），模型补上简报。必须带 prompt，fresh 还要带够宽的 background；
 * title、harness、model、cwd、kind 不给的照卡上的。不要求用户发起的回合（用户在卡上选新会话就是同意）。
 * 目标 harness 收不到这个会话那么严的不起，卡片带着简报降成普通提案（pending、带 widerSandbox），由用户看过再点
 */
async function acceptOffer(
  tree: SessionTree,
  args: Record<string, unknown>,
  call: DeviceToolCall,
  proposal: SessionProposal,
): Promise<SessionsStartResult> {
  switch (proposal.status) {
    case 'chosen':
      break
    case 'pending':
      // 补的简报开到收不紧的 harness 上、降成了普通提案卡：只能由用户在卡上开始
      throw new Refused(
        'blocked',
        `Proposal ${proposal.id} is now a card waiting for the user${proposal.widerSandbox ? ` (it would run with a wider sandbox, ${proposal.widerSandbox}, than this session)` : ''}; only the user can start it, from the card. Tell them so.`,
      )
    case 'offered':
      throw new Refused(
        'invalid',
        `The user has not chosen yet for proposal ${proposal.id}. Wait for the result of your start call.`,
      )
    case 'here':
      throw new Refused(
        'invalid',
        `For proposal ${proposal.id} the user chose to do it here (or went on talking). Do the work in this session; do not start a session for it.`,
      )
    case 'started':
      return {
        ...(proposal.startedThreadId ? { thread_id: proposal.startedThreadId } : {}),
        note: `This offer was already started${proposal.startedThreadId ? ` as session ${proposal.startedThreadId}` : ''}. Do not start it again.`,
      }
    default:
      throw new Refused(
        'invalid',
        `Proposal ${proposal.id} cannot be started: it was ${proposal.status}.`,
      )
  }
  const prompt = args.prompt
  if (typeof prompt !== 'string' || !prompt.trim())
    throw new Refused(
      'invalid',
      `prompt is required: the user chose a new session for "${proposal.title}", so pass the full brief: prompt (the task, the files or area, what done looks like) and, for fresh, background (the context it cannot see).`,
    )
  const spec = await checked(
    tree,
    call,
    specOf(
      {
        title: args.title ?? proposal.title,
        prompt,
        background: args.background,
        harness: args.harness ?? proposal.harness,
        model: args.model ?? proposal.model,
        effort: args.effort ?? proposal.effort,
        cwd: args.cwd ?? proposal.cwd,
        kind: args.kind ?? proposal.kind,
      },
      call,
      tree,
    ),
  )
  const wider = await widerFor(tree, call, spec)
  // 目标 harness 收不到这个会话那么严：不开，降成一张带简报的普通提案卡，用户看过提醒再决定点不点
  if (wider) {
    const held = tree.holdOffer(proposal.id, {
      title: spec.title,
      prompt: spec.prompt,
      background: spec.background,
      harness: spec.harness ?? null,
      model: spec.model ?? null,
      effort: spec.effort ?? null,
      cwd: spec.cwd ?? null,
      kind: spec.kind,
      widerSandbox: wider,
    })
    if (!held)
      throw new Refused(
        'invalid',
        `Proposal ${proposal.id} is no longer waiting for a brief (the turn ended or it was withdrawn). Do not start a session for it.`,
      )
    return {
      proposal_id: held.id,
      note: `${spec.harness ?? call.harness} cannot be sandboxed as tightly as this session (it would run with ${wider}), so the session was not started. The card now shows your brief as a proposal: the user reviews it and starts it themselves (they can change the harness there); nothing runs until they do, and ${EXPIRES}. Tell the user why in one line. Do not do the work here, and do not call accept for it again.`,
    }
  }
  const child = await acceptProposal(
    tree,
    proposal.id,
    {
      title: spec.title,
      prompt: spec.prompt,
      background: spec.background,
      // 空字符串是用缺省（这个会话的）
      harness: spec.harness ?? '',
      model: spec.model ?? '',
      effort: spec.effort ?? '',
      cwd: spec.cwd ?? '',
      kind: spec.kind,
    },
    'chosen',
  )
  return {
    thread_id: child.threadId,
    note: `Started sub-session ${child.threadId} on ${child.harness}${worktreeNote(child.branch)} for "${spec.title.trim()}". It runs on its own; you will be woken with its result as a <litch-session-event> message. Do not do that work here, and do not poll it.`,
  }
}

/** 撤回自己的提案：pending 的标 withdrawn；已经开始、不要了、过期了的照实回，不报错 */
async function withdraw(
  tree: SessionTree,
  args: Record<string, unknown>,
  call: DeviceToolCall,
): Promise<SessionsWithdrawResult> {
  const proposalId = string(args, 'proposal_id', true)
  const found = ownProposal(tree, proposalId, call)
  // offer 卡：还在等用户选的不能撤回；用户选了在这里做的已经没有卡了；选了新会话、还没开始的可以撤回
  if (found.status === 'offered')
    throw new Refused(
      'invalid',
      `Proposal ${proposalId} is an offer still waiting for the user's choice; it cannot be withdrawn.`,
    )
  if (found.status === 'here')
    throw new Refused(
      'invalid',
      `For proposal ${proposalId} the user chose to do it here; there is no card to withdraw.`,
    )
  // 用户正在点开始：等它起完再看
  await tree.accepting.get(proposalId)?.catch(() => null)
  const status = tree.proposal(proposalId)?.status
  if (status === 'pending' || status === 'chosen')
    tree.settleProposal(proposalId, 'withdrawn', null, ['pending', 'chosen'])
  const current = ownProposal(tree, proposalId, call)
  switch (current.status) {
    case 'started':
      return {
        status: 'started',
        ...(current.startedThreadId ? { thread_id: current.startedThreadId } : {}),
        note: `The user already started it${current.startedThreadId ? ` as session ${current.startedThreadId}` : ''}; it can no longer be withdrawn. If that work is no longer needed, tell the user.`,
      }
    case 'dismissed':
      return { status: 'dismissed', note: 'The user already dismissed it. Nothing to do.' }
    case 'expired':
      return { status: 'expired', note: 'It already expired. Nothing to do.' }
    default:
      return { status: 'withdrawn', note: 'Withdrawn: the card now shows it as withdrawn.' }
  }
}

/**
 * 交接：做到一半来了一条无关的新消息，把手上的任务交给一个分叉会话（分叉到这个回合之前，不带这条新消息），
 * 第一条消息是剩下的计划，立刻开始，停下后唤醒这个会话。不出卡；只在用户亲手发起的回合里允许
 */
async function handOff(
  tree: SessionTree,
  args: Record<string, unknown>,
  call: DeviceToolCall,
): Promise<SessionsHandOffResult> {
  const title = string(args, 'title', true)
  const plan = string(args, 'remaining_plan', true)
  if (plan.length > SESSION_TOOL_LIMITS.messageChars)
    throw new Refused(
      'invalid',
      `remaining_plan is longer than ${SESSION_TOOL_LIMITS.messageChars} characters; shorten it and point to files instead.`,
    )
  if (!tree.isUserTurn(call.harness, call.turnId))
    throw new Refused(
      'blocked',
      'hand_off is for when the user sends a new, unrelated message while you are working, and this turn was not started by the user typing a message. Keep working here.',
    )
  const worktree = args.worktree ?? undefined
  if (worktree !== undefined && typeof worktree !== 'boolean')
    throw new Refused('invalid', 'worktree must be true or false.')
  let child: { threadId: string; harness: string; branch: string | null }
  try {
    child = await startChild(
      tree,
      call.threadId,
      {
        kind: 'fork',
        title,
        prompt: plan,
        wakeParent: true,
        handOffBefore: call.turnId,
        worktree: worktree ?? null,
      },
      'model',
    )
  } catch (error) {
    if (error instanceof StartRefused) throw error
    throw new Refused(
      'failed',
      `Could not hand off: ${messageOf(error)}. Keep the task here: answer the new message first, then go back to it.`,
    )
  }
  return {
    thread_id: child.threadId,
    note: `Handed "${title.trim()}" off to session ${child.threadId}${worktreeNote(child.branch)}: a fork of this conversation up to the previous turn, with the remaining plan. It starts now; you will be woken with its result as a <litch-session-event> message. Stop that task here (do not continue it or poll it) and answer the user's new message.`,
  }
}

/**
 * 写类工具的对象：调用者自己的 Litch 子孙会话随时可以；用户亲手发起的回合里任何会话都可以；
 * 发消息（message 为真）还可以发给两边之间发过消息的会话（store.contacted：谁发给谁、怎么发的都算，
 * send、打断、用户 @、派子会话……），打断不算
 */
async function writable(
  tree: SessionTree,
  threadId: string,
  call: DeviceToolCall,
  message: boolean,
): Promise<string> {
  if (threadId === call.threadId) throw new Refused('blocked', 'This is your own session.')
  if (tree.store.descends(threadId, call.threadId)) return tree.owner(threadId)
  const { thread } = await found(tree, threadId, false)
  if (typeof thread.parentThreadId === 'string' && thread.parentThreadId)
    throw new Refused(
      'blocked',
      `Session ${threadId} is a subagent thread of its harness, not a Litch sub-session. Use your own subagent tools to talk to it.`,
    )
  if (tree.isUserTurn(call.harness, call.turnId)) return tree.owner(threadId)
  if (message && tree.store.contacted(call.threadId, threadId)) return tree.owner(threadId)
  throw new Refused(
    'blocked',
    message
      ? `Session ${threadId} is not one of your sub-sessions, and it and this session have never messaged each other (nor did the user mention one in the other), so you can message it only on a turn the user started. This turn was not. Ask the user to mention it or to send the message.`
      : `Session ${threadId} is not one of your sub-sessions, so you can interrupt it only on a turn the user started. This turn was not. Ask the user to do it themselves.`,
  )
}

async function send(tree: SessionTree, args: Record<string, unknown>, call: DeviceToolCall) {
  const threadId = string(args, 'thread_id', true)
  const message = string(args, 'message', true)
  if (message.length > SESSION_TOOL_LIMITS.messageChars)
    throw new Refused(
      'invalid',
      `message is longer than ${SESSION_TOOL_LIMITS.messageChars} characters.`,
    )
  const harness = await writable(tree, threadId, call, true)
  const caller = tree.store.parentOf(call.threadId)?.title ?? ''
  // 发过一次，两边之后一直可以互相发：告诉对面怎么回（回答写在它自己的对话里，这边看不到）
  const reply = `\n\n(To answer, send a message back with litch_sessions.send to thread_id ${call.threadId}; your reply in this conversation does not reach that session.)`
  const text = `[Litch] Message from session ${caller ? `"${caller}" ` : ''}(${call.threadId}), not typed by the user:\n\n${message}${reply}`
  const input = [{ type: 'text', text, text_elements: [] }]
  // 订阅它，它这一回合结束时设备进程收得到（回报、wait）
  await tree.watch(harness, threadId)
  const link = await tree.link(harness)
  const running = tree.activeTurn(threadId)
  if (running) {
    try {
      await link.request('turn/steer', { threadId, input, expectedTurnId: running })
      tree.store.addContact(call.threadId, threadId)
      return { thread_id: threadId, note: 'Added to the turn it is running now.' }
    } catch {
      // 回合刚好结束了：当新的一句发
    }
  }
  await link.request('turn/start', { threadId, input })
  tree.store.addContact(call.threadId, threadId)
  return { thread_id: threadId, note: 'Sent; it started a new turn.' }
}

async function wait(
  tree: SessionTree,
  args: Record<string, unknown>,
  call: DeviceToolCall,
  signal: AbortSignal,
) {
  const ids = args.thread_ids
  if (
    !Array.isArray(ids) ||
    ids.length === 0 ||
    ids.length > SESSION_TOOL_LIMITS.waitThreadsMax ||
    !ids.every((id) => typeof id === 'string' && id)
  )
    throw new Refused(
      'invalid',
      `thread_ids must list 1 to ${SESSION_TOOL_LIMITS.waitThreadsMax} session ids.`,
    )
  const seconds = integer(args, 'timeout_seconds', 60, SESSION_TOOL_LIMITS.waitSecondsMax)
  const deadline = Date.now() + seconds * 1000
  const threads = [...new Set(ids as string[])]
  for (const id of threads) await found(tree, id, false)
  let timedOut = false
  for (;;) {
    const states = await Promise.all(threads.map((id) => tree.read(id, false).catch(() => null)))
    // 在等用户答的也算停下了：等下去也不会有结果
    const running = states.some((state) => state && statusWord(tree, state.thread) === 'running')
    if (!running) break
    if (signal.aborted) throw new Refused('failed', 'The turn ended while waiting.')
    const left = deadline - Date.now()
    if (left <= 0) {
      timedOut = true
      break
    }
    // 有回合结束就再看一遍；通知可能来不了（没订阅的会话），隔一阵也看一遍
    await new Promise<void>((resolve) => {
      const timer = setTimeout(done, Math.min(left, 2000))
      const off = tree.onTurnEnded((id) => {
        if (threads.includes(id)) done()
      })
      signal.addEventListener('abort', done, { once: true })
      function done() {
        clearTimeout(timer)
        off()
        signal.removeEventListener('abort', done)
        resolve()
      }
    })
  }
  const sessions = []
  for (const id of threads) {
    const state = await tree.read(id, true).catch(() => null)
    if (!state) continue
    const turns = Array.isArray(state.thread.turns) ? state.thread.turns.filter(isObject) : []
    const last = turns.at(-1)
    const answer = last && last.status !== 'inProgress' ? lastAnswer(last) : null
    sessions.push({
      ...summary(tree, state.harness, state.thread, call.threadId),
      last_answer: answer === null ? null : trimText(answer, SESSION_TOOL_LIMITS.readTextChars),
    })
  }
  return { sessions, timed_out: timedOut }
}

async function interrupt(tree: SessionTree, args: Record<string, unknown>, call: DeviceToolCall) {
  const threadId = string(args, 'thread_id', true)
  const harness = await writable(tree, threadId, call, false)
  let turnId = tree.activeTurn(threadId)
  if (!turnId) {
    const { thread } = await found(tree, threadId)
    const last = (Array.isArray(thread.turns) ? thread.turns : []).filter(isObject).at(-1)
    if (last?.status === 'inProgress' && typeof last.id === 'string') turnId = last.id
  }
  if (!turnId) return { thread_id: threadId, note: 'It is not running; nothing to interrupt.' }
  const link = await tree.link(harness)
  await link.request('turn/interrupt', { threadId, turnId })
  tree.store.addContact(call.threadId, threadId)
  return { thread_id: threadId, note: 'Interrupted its running turn.' }
}

/** 引擎自己的子代理线程不是 Litch 会话：归档、恢复让模型用引擎自己的工具 */
function notSubagent(thread: Record<string, unknown>, threadId: string): void {
  if (typeof thread.parentThreadId === 'string' && thread.parentThreadId)
    throw new Refused(
      'blocked',
      `Session ${threadId} is a subagent thread of its harness, not a Litch session. Use your own subagent tools for it.`,
    )
}

/**
 * 归档一个会话：用户亲手发话或经理收到看板答复的回合可收，其他事件不算用户同意。
 * 别的会话：在干活的、置顶的不归档，照实回；归档了的话它已经停下的子孙跟着归档。self：等这个回合结束再归档
 */
async function archive(
  tree: SessionTree,
  archives: SessionArchives,
  args: Record<string, unknown>,
  call: DeviceToolCall,
): Promise<SessionsArchiveResult> {
  const given = string(args, 'thread_id', true)
  const self = given === SESSION_SELF || given === call.threadId
  const threadId = self ? call.threadId : given
  let userConsentTurn = tree.isUserTurn(call.harness, call.turnId)
  const manager = tree.managers?.store.forThread(call.threadId)
  if (!userConsentTurn && manager?.harness === call.harness) {
    // 只认开启当前回合的看板答复；旧回合的答复或其他事件中的插话不改变归档闸。
    const { thread } = await tree.read(call.threadId, true)
    const turn = (Array.isArray(thread.turns) ? thread.turns : []).find(
      (turn) => isObject(turn) && turn.id === call.turnId,
    )
    const input = (isObject(turn) && Array.isArray(turn.items) ? turn.items : []).find(
      (item) => isObject(item) && item.type === 'userMessage',
    )
    const first = isObject(input) && Array.isArray(input.content) ? input.content[0] : null
    const event =
      isObject(first) && typeof first.text === 'string' ? parseSessionEvent(first.text).event : null
    userConsentTurn = event?.kind === 'manager-answers' && event.manager?.managerId === manager.id
  }
  if (!userConsentTurn)
    throw new Refused(
      'blocked',
      'Archive only after the user agreed in chat or in a manager board answer; this turn has neither source. Ask the user first (managers: use a board decision), and archive it when they say yes.',
    )
  if (archives.pinned(threadId))
    throw new Refused(
      'blocked',
      `Session ${threadId} is pinned, so it was not archived. Ask the user to unpin it or archive it themselves.`,
    )
  if (self) {
    if (tree.host.backgroundRunning(threadId) > 0)
      throw new Refused(
        'blocked',
        'This session has background tasks still running, so it was not archived. Wait for them to finish or stop them, then try again.',
      )
    archives.archiveAfterTurn(threadId)
    return {
      thread_id: threadId,
      note: 'This session will be archived when this turn ends, with its sub-sessions that have stopped. End your turn now with at most one short line.',
    }
  }
  const { thread } = await found(tree, threadId, false)
  notSubagent(thread, threadId)
  if (tree.host.index.archived(threadId))
    return { thread_id: threadId, note: 'It is already archived. Nothing to do.' }
  if (await archives.working(threadId))
    throw new Refused(
      'blocked',
      `Session ${threadId} is still working (a turn running, waiting for the user, or background tasks running), so it was not archived. Wait until it stops, or ask the user to stop it, then try again.`,
    )
  let cascade: Cascade
  try {
    cascade = await archives.archive(threadId, 'model')
  } catch (error) {
    throw new Refused('failed', `Could not archive session ${threadId}: ${messageOf(error)}`)
  }
  const left = cascade.left.length
    ? ` ${cascade.left.length} of its sub-sessions are still working or pinned and stay in the list.`
    : ''
  return {
    thread_id: threadId,
    ...(cascade.archived.length ? { archived_with: cascade.archived } : {}),
    ...(cascade.left.length ? { left_live: cascade.left } : {}),
    note: `Archived. The user can restore it from Archived${cascade.archived.length ? `; ${cascade.archived.length} of its stopped sub-sessions were archived with it` : ''}.${left}`,
  }
}

/** 把归档了的会话放回来：自己的子孙随时可以，别的要用户亲手发起的回合 */
async function unarchive(
  tree: SessionTree,
  archives: SessionArchives,
  args: Record<string, unknown>,
  call: DeviceToolCall,
): Promise<SessionsUnarchiveResult> {
  const threadId = string(args, 'thread_id', true)
  if (threadId === call.threadId || threadId === SESSION_SELF)
    throw new Refused('invalid', 'This session is not archived.')
  if (!tree.store.descends(threadId, call.threadId) && !tree.isUserTurn(call.harness, call.turnId))
    throw new Refused(
      'blocked',
      `Session ${threadId} is not one of your sub-sessions, so restore it only when the user asks for it in a message they typed. This turn was not started that way.`,
    )
  const { thread } = await found(tree, threadId, false)
  notSubagent(thread, threadId)
  try {
    await archives.unarchive(threadId)
  } catch (error) {
    throw new Refused('failed', `Could not restore session ${threadId}: ${messageOf(error)}`)
  }
  return { thread_id: threadId, note: 'Restored: it is back in the session list.' }
}

/** litch_sessions 的处理函数，注册进设备进程的命名空间表 */
export function sessionToolsHandler(
  tree: SessionTree,
  archives: SessionArchives,
): DeviceToolHandler {
  return async (call, { signal }) => {
    if (!tree.enabledFor(call.threadId))
      return clientToolFailure(
        'disabled',
        'Session orchestration is turned off in this device’s settings, so litch_sessions is not available. Tell the user if they asked for it.',
      )
    const args = isObject(call.arguments) ? call.arguments : {}
    try {
      if (tree.managers?.store.forThread(call.threadId) && call.tool === SESSION_TOOL.wrapUp)
        throw new Refused(
          'invalid',
          'Managers do not use wrap_up. Record decisions and progress on the board.',
        )
      switch (call.tool) {
        case SESSION_TOOL.list:
          return ok(await list(tree, args, call))
        case SESSION_TOOL.read:
          return ok(await read(tree, args, call))
        case SESSION_TOOL.respond: {
          const threadId = string(args, 'thread_id', true)
          if (
            !tree.store.descends(threadId, call.threadId) &&
            !tree.isUserTurn(call.harness, call.turnId)
          )
            throw new PendingRefused(
              'forbidden',
              'Only a parent session or a user-driven turn can respond.',
            )
          const id = string(args, 'request_id', true)
          const source = await tree.read(call.threadId, false)
          if (
            tree.pendingRequests(threadId).some((r) => r.id === id && r.kind === 'clientApproval')
          )
            throw new PendingRefused(
              'executor_required',
              'Answer this approval on its original client.',
            )
          const request = tree.pending.respond(threadId, id, args.answer)
          const record = {
            id: randomUUID(),
            requestId: id,
            threadId,
            turnId: request.turnId,
            sourceThreadId: call.threadId,
            sourceTitle: threadTitle(source.thread),
            parent: tree.store.descends(threadId, call.threadId),
            kind: request.kind,
            title: request.title,
            answer: args.answer,
            ...(request.questions
              ? { questions: request.questions.map(({ id, question }) => ({ id, question })) }
              : {}),
            at: Date.now(),
          }
          tree.recordResponse(record)
          return ok({ answered: true, response: record })
        }
        case SESSION_TOOL.options:
          return ok(await sessionOptions(tree, args, call))
        case SESSION_TOOL.start:
          return ok(await start(tree, args, call, signal))
        case SESSION_TOOL.accept:
          return ok(await accept(tree, args, call))
        case SESSION_TOOL.withdraw:
          return ok(await withdraw(tree, args, call))
        case SESSION_TOOL.wrapUp:
          return ok(await wrapUp(tree, args, call))
        case SESSION_TOOL.handOff:
          return ok(await handOff(tree, args, call))
        case SESSION_TOOL.send:
          return ok(await send(tree, args, call))
        case SESSION_TOOL.wait:
          return ok(await wait(tree, args, call, signal))
        case SESSION_TOOL.interrupt:
          return ok(await interrupt(tree, args, call))
        case SESSION_TOOL.archive:
          return ok(await archive(tree, archives, args, call))
        case SESSION_TOOL.unarchive:
          return ok(await unarchive(tree, archives, args, call))
        default:
          return clientToolFailure('invalid', `litch_sessions has no tool "${call.tool}".`)
      }
    } catch (error) {
      if (error instanceof PendingRefused)
        return { ...ok({ error: { code: error.code, message: error.message } }), success: false }
      if (error instanceof Refused || error instanceof StartRefused)
        return clientToolFailure(error.kind, error.message)
      return clientToolFailure('failed', messageOf(error))
    }
  }
}
