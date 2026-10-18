// litch_sessions：模型列出、读取这台设备上的会话，派子会话，给自己的子会话发消息、打断，等它们停下。
// 执行方是设备进程（device-tools.mts 注册的一个命名空间），工具定义在 packages/protocol/src/client-tools-sessions.mts。
// 读类（list、read、wait）能看这台设备上所有会话；写类（send、interrupt）只能作用于调用者自己的 Litch 子孙会话，
// 别的一律 [litch:blocked]，引擎自己的子代理线程另外提示用引擎自己的工具。结果是一段 JSON 文字，失败第一行是 [litch:<kind>]。
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
  type SessionTurnSummary,
} from '../../protocol/src/client-tools-sessions.mjs'
import {
  parseSessionEvent,
  SESSION_TREE_LIMITS,
  type SessionLineageKind,
} from '../../protocol/src/session-tree.mjs'
import type { DeviceToolCall, DeviceToolHandler } from './device-tools.mjs'
import { StartRefused, startChild, threadTitle } from './session-start.mjs'
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

async function start(tree: SessionTree, args: Record<string, unknown>, call: DeviceToolCall) {
  const title = string(args, 'title', true)
  const prompt = string(args, 'prompt', true)
  const harness = string(args, 'harness')
  const model = string(args, 'model')
  const cwd = string(args, 'cwd')
  const given = string(args, 'kind') ?? 'fresh'
  if (given !== 'fresh' && given !== 'fork')
    throw new Refused('invalid', 'kind must be fresh or fork.')
  const kind: SessionLineageKind = given
  const wake = args.wake_parent ?? true
  if (typeof wake !== 'boolean') throw new Refused('invalid', 'wake_parent must be a boolean.')
  const initiation = string(args, 'initiation') ?? 'propose'
  if (initiation !== 'user_asked' && initiation !== 'propose')
    throw new Refused('invalid', 'initiation must be user_asked or propose.')
  if (prompt.length > SESSION_TOOL_LIMITS.messageChars)
    throw new Refused(
      'invalid',
      `prompt is longer than ${SESSION_TOOL_LIMITS.messageChars} characters.`,
    )
  if (harness && !tree.host.harnesses().some((source) => source.id === harness))
    throw new Refused('invalid', `There is no harness "${harness}" on this device.`)
  if (kind === 'fork' && harness && harness !== call.harness)
    throw new Refused('invalid', `fork only works within the same harness (${call.harness}).`)
  // 只有用户亲手发起的这个回合里、模型说是用户要的，才直接起；别的一律变成提案
  if (initiation === 'user_asked' && tree.isUserTurn(call.harness, call.turnId)) {
    const spec = {
      harness: harness ?? null,
      model: model ?? null,
      cwd: cwd ?? null,
      kind,
      title,
      prompt,
      wakeParent: wake,
    }
    const child = await startChild(tree, call.threadId, spec, 'model')
    return {
      thread_id: child.threadId,
      note: `Started sub-session ${child.threadId} on ${child.harness}. It runs on its own; ${wake ? 'you will be woken with its result as a <litch-session-event> message' : 'its result is attached to the next user message'}. Do not poll it.`,
    }
  }
  const proposal = tree.propose({
    threadId: call.threadId,
    title: title.trim().slice(0, 120),
    prompt,
    harness: harness ?? null,
    model: model ?? null,
    cwd: cwd ?? null,
    kind,
    wakeParent: wake,
  })
  const why =
    initiation === 'user_asked'
      ? 'This turn was not started by the user typing a message, so the request became a proposal. '
      : ''
  return {
    proposal_id: proposal.id,
    note: `${why}The user now sees a proposal card for "${proposal.title}". Nothing runs until they accept it; it expires in ${SESSION_TREE_LIMITS.proposalTtlSeconds / 86400} days. Do not do the work here as well.`,
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
