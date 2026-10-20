// litch_sessions：模型列出、读取这台设备上的会话，派子会话，给自己的子会话发消息、打断，等它们停下。
// 执行方是设备进程（device-tools.mts 注册的一个命名空间），工具定义在 packages/protocol/src/client-tools-sessions.mts。
// 读类（list、read、wait）能看这台设备上所有会话；写类（send、interrupt）只能作用于调用者自己的 Litch 子孙会话，
// 别的一律 [litch:blocked]，引擎自己的子代理线程另外提示用引擎自己的工具。提案类（start 出提案、accept、withdraw）
// 只作用于调用者自己会话上的提案；提案的门槛（一回合几张、同标题、fresh 简报的显示宽度）在 start 和 wrap_up 里查。
// wrap_up 是每回合收尾必调的：每条建议成一张提案，调没调记在会话树里（没调的用户回合结束后设备进程开回合提醒）。
// 结果是一段 JSON 文字，失败第一行是 [litch:<kind>]，后面是模型能照着改的一句话。
import {
  type ClientToolCallResponse,
  type ClientToolFailureKind,
  clientToolFailure,
} from '../../protocol/src/client-tools.mjs'
import {
  SESSION_TOOL,
  SESSION_TOOL_LIMITS,
  type SessionStatusWord,
  type SessionSummary,
  type SessionsStartResult,
  type SessionsWithdrawResult,
  type SessionsWrapUpResult,
  type SessionTurnSummary,
  textWidth,
} from '../../protocol/src/client-tools-sessions.mjs'
import {
  parseSessionEvent,
  SESSION_TREE_LIMITS,
  type SessionLineageKind,
  type SessionProposal,
} from '../../protocol/src/session-tree.mjs'
import type { DeviceToolCall, DeviceToolHandler } from './device-tools.mjs'
import {
  acceptProposal,
  StartRefused,
  startChild,
  threadTitle,
  widerSandbox,
} from './session-start.mjs'
import { lastAnswer, type SessionTree, trimText } from './session-tree.mjs'
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
  return { session: summary(tree, harness, thread, call.threadId), turns: turns.map(turnSummary) }
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
  harness: string | undefined
  model: string | undefined
  cwd: string | undefined
  kind: SessionLineageKind
}

/** 读一条 start 或建议的参数并查一遍：标题、简报、harness、fork 只能同 harness、fresh 简报的宽度 */
function specOf(args: Record<string, unknown>, call: DeviceToolCall, tree: SessionTree): Spec {
  const title = string(args, 'title', true)
  const prompt = string(args, 'prompt', true)
  const harness = string(args, 'harness')
  const model = string(args, 'model')
  const cwd = string(args, 'cwd')
  const given = string(args, 'kind') ?? 'fresh'
  if (given !== 'fresh' && given !== 'fork')
    throw new Refused('invalid', 'kind must be fresh or fork.')
  if (prompt.length > SESSION_TOOL_LIMITS.messageChars)
    throw new Refused(
      'invalid',
      `prompt is longer than ${SESSION_TOOL_LIMITS.messageChars} characters.`,
    )
  if (harness && !tree.host.harnesses().some((source) => source.id === harness))
    throw new Refused('invalid', `There is no harness "${harness}" on this device.`)
  if (given === 'fork' && harness && harness !== call.harness)
    throw new Refused('invalid', `fork only works within the same harness (${call.harness}).`)
  // fresh 的子会话只知道这段简报：太短的不管直接起还是变成提案都拒绝。按显示宽度算，汉字这类等宽字符算 2
  const width = textWidth(prompt.trim())
  const least = SESSION_TOOL_LIMITS.freshPromptMinWidth
  if (given === 'fresh' && width < least)
    throw new Refused(
      'invalid',
      `prompt is too short (width ${width}; each CJK or other full-width character counts as 2, everything else as 1): a fresh session knows nothing but this text, so it needs a width of at least ${least} (about ${least / 2} Chinese characters or ${least} English letters). State the task, the files or area, and what done looks like, then try again.`,
    )
  return { title, prompt, harness, model, cwd, kind: given }
}

/** 目标 harness 收不到父会话那么严时子会话实际会是的那一档沙箱；收得紧、判断不了是 null */
const widerFor = (tree: SessionTree, call: DeviceToolCall, spec: Spec) =>
  widerSandbox(tree, call.threadId, spec.harness ?? call.harness).catch(() => null)

/** 过门槛、落一张提案。门槛在落库之前同步查，同一回合里并发的几次 start 不会一起漏过去 */
function proposeOne(
  tree: SessionTree,
  call: DeviceToolCall,
  spec: Spec,
  wider: string | null,
): SessionProposal {
  const title = spec.title.trim().slice(0, 120)
  gate(tree, call, title)
  return tree.propose({
    threadId: call.threadId,
    title,
    prompt: spec.prompt,
    harness: spec.harness ?? null,
    model: spec.model ?? null,
    cwd: spec.cwd ?? null,
    kind: spec.kind,
    // 子会话停下后唤不唤醒由 Litch 定，不交给模型：模型派的、提的一律唤醒（用户从卡片开始时可以改）
    wakeParent: true,
    turnId: call.turnId || null,
    callId: call.callId || null,
    ...(wider ? { widerSandbox: wider } : {}),
  })
}

const EXPIRES = `it expires in ${SESSION_TREE_LIMITS.proposalTtlSeconds / 86400} days`

async function start(
  tree: SessionTree,
  args: Record<string, unknown>,
  call: DeviceToolCall,
): Promise<SessionsStartResult> {
  const spec = specOf(args, call, tree)
  const initiation = string(args, 'initiation') ?? 'propose'
  if (initiation !== 'user_asked' && initiation !== 'propose')
    throw new Refused('invalid', 'initiation must be user_asked or propose.')
  // 目标 harness 收不到父会话那么严（比如没有沙箱的 Pi）：模型派的一律变成提案，由用户看过再点
  const wider = await widerFor(tree, call, spec)
  // 只有用户亲手发起的这个回合里、模型说是用户要的，才直接起；别的一律变成提案
  const userTurn = tree.isUserTurn(call.harness, call.turnId)
  if (initiation === 'user_asked' && userTurn && wider === null) {
    const child = await startChild(
      tree,
      call.threadId,
      {
        harness: spec.harness ?? null,
        model: spec.model ?? null,
        cwd: spec.cwd ?? null,
        kind: spec.kind,
        title: spec.title,
        prompt: spec.prompt,
        wakeParent: true,
      },
      'model',
    )
    return {
      thread_id: child.threadId,
      note: `Started sub-session ${child.threadId} on ${child.harness}. It runs on its own; you will be woken with its result as a <litch-session-event> message. Do not poll it.`,
    }
  }
  const proposal = proposeOne(tree, call, spec, wider)
  const why =
    initiation !== 'user_asked'
      ? ''
      : !userTurn
        ? 'This turn was not started by the user typing a message, so the request became a proposal. '
        : `${spec.harness ?? call.harness} cannot be sandboxed as tightly as this session (it would run with ${wider}), so the request became a proposal for the user to approve. `
  return {
    proposal_id: proposal.id,
    note: `${why}The user now sees a proposal card for "${proposal.title}". Nothing runs until they accept it; ${EXPIRES}. Do not do the work here as well.`,
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
  // 已经收过尾又来一次空的：有的模型不写字就结束不了回合，被要求“别再写字”时会一遍遍调空收尾。回一个错，让它写一句就停
  if (given.length === 0 && tree.isWrappedUp(call.threadId, call.turnId))
    throw new Refused(
      'invalid',
      'This turn is already wrapped up. Do not call wrap_up again: end your turn now, with at most one short line.',
    )
  tree.wrappedUp(call.threadId, call.turnId)
  const suggestions: SessionsWrapUpResult['suggestions'] = []
  // 一条一条来：前面落下的提案算进后面的门槛（一回合几张、同标题）
  for (const one of given) {
    const title = isObject(one) && typeof one.title === 'string' ? one.title.trim() : ''
    try {
      if (!isObject(one))
        throw new Refused('invalid', 'Each suggestion must be an object with title and prompt.')
      const spec = specOf(one, call, tree)
      const proposal = proposeOne(tree, call, spec, await widerFor(tree, call, spec))
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
        : 'No card was made.',
    refused > 0
      ? `${refused} suggestion${refused > 1 ? 's were' : ' was'} refused (see refused). If you can fix them, call wrap_up again with only the fixed ones; otherwise mention that work in one line.`
      : 'Your turn is wrapped up: end it now, with at most one short line. Do not call wrap_up again.',
  ]
  return { suggestions, note: parts.join(' ') }
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

/** 用户在这个回合里让开始某张提案：按提案原样起（同用户点“开始”），只在用户亲手发起的回合里允许 */
async function accept(
  tree: SessionTree,
  args: Record<string, unknown>,
  call: DeviceToolCall,
): Promise<SessionsStartResult> {
  const proposalId = string(args, 'proposal_id', true)
  if (!tree.isUserTurn(call.harness, call.turnId))
    throw new Refused(
      'blocked',
      'This turn was not started by the user typing a message, so you cannot start proposals for them. Tell the user they can start it from the card.',
    )
  const proposal = ownProposal(tree, proposalId, call)
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
    note: `Started sub-session ${child.threadId} on ${child.harness} from the proposal. It runs on its own; ${current.wakeParent ? 'you will be woken with its result as a <litch-session-event> message' : 'its result is attached to the next user message'}. Do not poll it.`,
  }
}

/** 撤回自己的提案：pending 的标 withdrawn；已经开始、不要了、过期了的照实回，不报错 */
async function withdraw(
  tree: SessionTree,
  args: Record<string, unknown>,
  call: DeviceToolCall,
): Promise<SessionsWithdrawResult> {
  const proposalId = string(args, 'proposal_id', true)
  ownProposal(tree, proposalId, call)
  // 用户正在点开始：等它起完再看
  await tree.accepting.get(proposalId)?.catch(() => null)
  if (tree.proposal(proposalId)?.status === 'pending')
    tree.settleProposal(proposalId, 'withdrawn', null)
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

/** 写类工具的对象：只能是调用者自己的 Litch 子孙会话 */
async function own(tree: SessionTree, threadId: string, call: DeviceToolCall): Promise<string> {
  if (threadId === call.threadId) throw new Refused('blocked', 'This is your own session.')
  if (tree.store.descends(threadId, call.threadId)) return tree.owner(threadId)
  const { thread } = await found(tree, threadId, false)
  if (typeof thread.parentThreadId === 'string' && thread.parentThreadId)
    throw new Refused(
      'blocked',
      `Session ${threadId} is a subagent thread of its harness, not a Litch sub-session. Use your own subagent tools to talk to it.`,
    )
  throw new Refused(
    'blocked',
    `Session ${threadId} is not one of your sub-sessions, so you cannot change it. Ask the user to do it themselves.`,
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
  const harness = await own(tree, threadId, call)
  const caller = tree.store.parentOf(call.threadId)?.title ?? ''
  const text = `[Litch] Message from session ${caller ? `"${caller}" ` : ''}(${call.threadId}), not typed by the user:\n\n${message}`
  const input = [{ type: 'text', text, text_elements: [] }]
  // 订阅它，它这一回合结束时设备进程收得到（回报、wait）
  await tree.watch(harness, threadId)
  const link = await tree.link(harness)
  const running = tree.activeTurn(threadId)
  if (running) {
    try {
      await link.request('turn/steer', { threadId, input, expectedTurnId: running })
      return { thread_id: threadId, note: 'Added to the turn it is running now.' }
    } catch {
      // 回合刚好结束了：当新的一句发
    }
  }
  await link.request('turn/start', { threadId, input })
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
  const harness = await own(tree, threadId, call)
  let turnId = tree.activeTurn(threadId)
  if (!turnId) {
    const { thread } = await found(tree, threadId)
    const last = (Array.isArray(thread.turns) ? thread.turns : []).filter(isObject).at(-1)
    if (last?.status === 'inProgress' && typeof last.id === 'string') turnId = last.id
  }
  if (!turnId) return { thread_id: threadId, note: 'It is not running; nothing to interrupt.' }
  const link = await tree.link(harness)
  await link.request('turn/interrupt', { threadId, turnId })
  return { thread_id: threadId, note: 'Interrupted its running turn.' }
}

/** litch_sessions 的处理函数，注册进设备进程的命名空间表 */
export function sessionToolsHandler(tree: SessionTree): DeviceToolHandler {
  return async (call, { signal }) => {
    if (!tree.host.enabled())
      return clientToolFailure(
        'disabled',
        'Session orchestration is turned off in this device’s settings, so litch_sessions is not available. Tell the user if they asked for it.',
      )
    const args = isObject(call.arguments) ? call.arguments : {}
    try {
      switch (call.tool) {
        case SESSION_TOOL.list:
          return ok(await list(tree, args, call))
        case SESSION_TOOL.read:
          return ok(await read(tree, args, call))
        case SESSION_TOOL.start:
          return ok(await start(tree, args, call))
        case SESSION_TOOL.accept:
          return ok(await accept(tree, args, call))
        case SESSION_TOOL.withdraw:
          return ok(await withdraw(tree, args, call))
        case SESSION_TOOL.wrapUp:
          return ok(await wrapUp(tree, args, call))
        case SESSION_TOOL.send:
          return ok(await send(tree, args, call))
        case SESSION_TOOL.wait:
          return ok(await wait(tree, args, call, signal))
        case SESSION_TOOL.interrupt:
          return ok(await interrupt(tree, args, call))
        default:
          return clientToolFailure('invalid', `litch_sessions has no tool "${call.tool}".`)
      }
    } catch (error) {
      if (error instanceof Refused || error instanceof StartRefused)
        return clientToolFailure(error.kind, error.message)
      return clientToolFailure('failed', messageOf(error))
    }
  }
}
