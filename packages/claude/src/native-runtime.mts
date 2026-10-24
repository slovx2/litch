import { randomUUID } from 'node:crypto'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { join, relative } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

// 提示缓存时长（CHA_CLAUDE_PROMPT_CACHE_TTL=1h 时设 CLI 自己的那几个变量，默认什么都不设），CLI 继承这个进程的环境
applyPromptCacheTtl()

// In-process Claude runtime — replaces the Python sidecar entirely. Talks to
// @anthropic-ai/claude-agent-sdk directly so we get a single process boundary
// (Codex App ⇄ adapter), faster cold-starts, and no JSONL bridge to maintain.
//
// Surface contract: the same ClaudeRuntime shape the older sidecar-runtime
// implemented, so server.mts is unchanged.
//
// What this file preserves from the Python sidecar:
//   * subagent suppression state machine (active_subagent_ids)
//   * text stream-vs-block dedup — JS SDK re-delivers completed content
//     blocks after their streaming deltas（thinking 不流式发，等整块到了才分得清是思考还是旁白）
//   * ToolUseBlock double-delivery dedup (skip start, take from AssistantMessage)
//   * SDK StructuredOutput 结果校验与转发
//   * derive_permission_mode mapping for (approvalPolicy, sandbox, planMode)
//   * multimodal user input (text + base64/url image blocks)
//
// What this file no longer needs (vs. Python):
//   * class_name / obj_get polymorphism — JS blocks have native block.type
//   * droppable_in_priority TypeError loop — JS Options is a stable type
//   * rate_limit_event parse-gap fallback — JS SDK first-class
//
// CLI 来自宿主安装；Worker 仍通过独立 CLAUDE_CONFIG_DIR 提供配置和认证。

import type { OnElicitation, Query, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import { type ApprovalPolicy, allowsApproval, toolApprovalFlow } from './approval-policy.mjs'
import { deniedMessage } from './approval-request.mjs'
import { claudeConfigDir } from './claude-native-files.mjs'
import {
  ACCOUNT_PROVIDER,
  contextLaunch,
  NATIVE_PROVIDER,
  plainProvider,
  withFlagSettings,
} from './claude-provider.mjs'
import { settingsEnvValue } from './claude-setting-layers.mjs'
import { cliOutputFormat } from './cli-output-schema.mjs'
import { type CodexErrorInfo, codexErrorInfoFor, TurnFailure } from './codex-error-info.mjs'
import {
  compactWindowOf,
  contextTokens,
  contextWindowOf,
  mergeRequestUsage,
  type RequestUsage,
} from './context-usage.mjs'
import { dynamicToolCliNames, dynamicToolServer } from './dynamic-tools.mjs'
import { goalToolServer, isGoalTool } from './goal-tools.mjs'
import {
  claudeBashTimeoutEnv,
  hostClaudeEnvOverrides,
  hostClaudeExecutable,
  hostClaudeSessionEnv,
} from './host-claude.mjs'
import { jsonSchemaValidator } from './json-schema.mjs'
import { sdkMcpStartupEnvironment } from './mcp-config.mjs'
import { isNarration, narrationIndexes } from './narration.mjs'
import {
  appendNativeContext,
  type ContextInjection,
  contextFrameBatches,
  nativeMessagePersisted,
  persistedContext,
  persistedContextBoundary,
} from './native-context.mjs'
import { cliDeniedServers, NativeMcpBridge } from './native-mcp-bridge.mjs'
import { NativeMcpPool } from './native-mcp-pool.mjs'
import { NativeProcess, succeedsWithin } from './native-process.mjs'
import {
  backgroundCommandEnd,
  carriesReminder,
  goalReminder,
  isMainToolResult,
  keepAliveIdleMs,
  keepAliveLimit,
  liveContext,
  needsStrictSkillShell,
  notificationFolded,
  notificationGraceLeft,
  peerMessageOf,
  resultConfirms,
  sessionFingerprint,
  startsRound,
  steerMessage,
  stopNotice,
  userMessage,
} from './native-session.mjs'
import { forkNativeSession } from './native-session-fork.mjs'
import { waitForTranscript } from './native-tool-intents.mjs'
import { NativeTurnInput } from './native-turn-input.mjs'
import { claimPeerInboxSocket, inboxReady } from './peer-inbox-socket.mjs'
import { mergePermissionOverlay, permissionToolName } from './permission-grants.mjs'
import { permissionToolServer } from './permission-tools.mjs'
import { ProtocolError, submissionHash } from './protocol-contract.mjs'
import {
  type NativeAccountUsage,
  type NativeRateLimitInfo,
  rateLimitCredentialScope,
} from './rate-limits.mjs'
import {
  applyPromptCacheTtl,
  claudeCrossSessionInbox,
  claudePlansLocation,
  claudeSessionTitle,
  claudeSettingSources,
  claudeThreadIdHeaderEnv,
} from './runtime-config.mjs'
import {
  deniedTool,
  isFileEditTool,
  isFileReadTool,
  isPlanFile,
  type OriginalBashInputs,
  planDirectory,
  runtimePermissionOptions,
  sandboxedBashInput,
} from './runtime-permissions.mjs'
import type { RuntimeTurnSettings } from './turn-settings.mjs'
import type {
  ClaudeRuntime,
  NativeModelInfo,
  NativeSessionFork,
  PermissionDecision,
  RuntimeBackgroundShell,
  RuntimeHandlers,
  RuntimePeerWake,
  RuntimeSessionHandlers,
  RuntimeTurnContext,
} from './types.mjs'
import {
  askUserQuestionUpdatedInput,
  PLAN_EXIT_QUESTION_ID,
  PLAN_HANDED_OFF,
  PLAN_NOT_CONFIRMED,
  parseAskUserQuestions,
  planExitQuestion,
  planExitVerdict,
  planWithNote,
} from './user-questions.mjs'
import { debugLog, newId } from './util.mjs'
import { parseWorkflowCommand, workflowRuntimePrompt } from './workflow-command.mjs'
import {
  defaultWorkflowTranscriptRoots,
  parseWorkflowLaunchInfo,
  WorkflowJournalMonitor,
  type WorkflowLaunchInfo,
} from './workflow-subagents.mjs'

type ClaudeSdk = typeof import('@anthropic-ai/claude-agent-sdk')

// background_tasks_changed 先于 task_started 到达，列出时再关联工具调用与命令。
interface BackgroundShellState {
  live: Map<string, number>
  taskToolUse: Map<string, string>
  bashCommand: Map<string, string>
  seqByTask: Map<string, number>
  nextSeq: number
}

// 额度与凭据的归属：账号和用户自己的配置（native）按 CLI 实际会用的凭据算，凭据变了要换进程、
// 额度观测也跟着换主；用户加的供应商没有订阅额度，它们的密钥和定义由 providerScope 管
function rateScope(context: RuntimeTurnContext): string | null {
  const provider = context.provider ?? plainProvider()
  return provider === ACCOUNT_PROVIDER || provider === NATIVE_PROVIDER
    ? rateLimitCredentialScope(context.cwd)
    : null
}

// 供应商没填密钥、被删了时算不出来：给一个不会和任何进程对上的值，新进程起的时候再正式报错
function providerScope(context: RuntimeTurnContext): string {
  try {
    return contextLaunch(context.provider, context.model).scope
  } catch {
    return 'unavailable'
  }
}

function titleEnv(context: RuntimeTurnContext): NodeJS.ProcessEnv {
  try {
    return contextLaunch(context.provider, context.model).env
  } catch {
    return process.env
  }
}

// 一个 CLI 进程。回合结束时还有后台命令在跑，进程就留下来接着服务后面的回合；
// 期间 CLI 自己开的一轮（后台命令结束后的续跑）由协议层另建回合接上。
interface NativeSession {
  // 会话所属线程；追问回合跑在父线程的会话上。
  key: string
  fingerprint: string
  // 进程起来时的登录与模型服务设置（rateLimitCredentialScope），变了就不再复用这个进程
  credentialScope: string | null
  // 进程起来时的供应商、它的定义和密钥（claude-provider.mts 的 scope），变了也不再复用
  providerScope: string
  strictSkillShell: boolean
  sessionId: string | null
  // 当前回合的上下文；没有回合时是最近一个回合的。
  context: RuntimeTurnContext
  turn: PendingTurn | null
  query: Query
  input: NativeTurnInput
  abort: AbortController
  mcp: NativeMcpBridge
  process: NativeProcess
  // 模型的回复还在不在流：工具意图确认的钩子按它决定等多久
  shells: BackgroundShellState
  // 出现在 background_tasks_changed 里的任务（任意类型）。它们结束后 CLI 会自己再跑一轮。
  backgroundTasks: Set<string>
  // 还在跑的非 ambient 的 MCP、WebSocket 监视（monitor_*）：描述和列出来的先后（和后台命令共用一个计数）。
  // 和后台命令一样要保活进程：进程一退它们就没了（Monitor 工具起的是 local_bash，已经算在 shells 里）
  monitors: Map<string, { description: string; seq: number }>
  // CLI 上报的会话状态。idle 表示后台子代理及其通知触发的续跑都已结束；
  // null 表示 CLI 没有上报过状态，回合仍在第一条 result 处结束。
  state: 'idle' | 'running' | 'requires_action' | null
  applied: {
    model: string | null
    effort: string | null
    goalContext: string | null
    planMode: boolean
  }
  // 后台任务的结束通知到达的时间：它触发的那一轮还没开始，也还看不出已被当前这一轮带走。
  notificationAt: number | null
  notificationTimer: ReturnType<typeof setTimeout> | null
  reapTimer: ReturnType<typeof setTimeout> | null
  // 正在等协议层把回合接上来。
  attach: Promise<PendingTurn | null> | null
  attachResolve: ((turn: PendingTurn | null) => void) | null
  // 协议层没有接这一轮：丢弃它的输出，直到 CLI 回到 idle。
  discard: boolean
  kept: boolean
  // 只因空闲保留（CHA_CLAUDE_KEEP_ALIVE_IDLE_SECONDS）而留着：没有回合也没有后台命令，到点就退出。
  // idleSince 是它闲下来的时间，满额时先回收闲得最久的。
  idle: boolean
  idleSince: number
  closing: boolean
  closeReason: string
  // 请 CLI 现起的会话标题，还没起完时进程先别退出（见 finishDeferredResult）
  title: Promise<unknown> | null
  done: Promise<void>
}

interface PendingTurn {
  credentialScope: string | null
  session: NativeSession
  context: RuntimeTurnContext
  handlers: RuntimeHandlers
  query: Query
  abort: AbortController
  input: NativeTurnInput
  resolved: boolean
  resolve: () => void
  reject: (error: Error) => void
  outcome: Promise<void>
  settled: Promise<void>
  // 本回合最后送入的用户消息；它被某条 result 确认之后回合才能结束。自行续跑的回合没有。
  awaited: string | null
  awaitedSeen: boolean
  // SDK assistant envelopes can deliver one content block at a time. Keep
  // dedup scoped to a model response, preserving unstreamed blocks alongside
  // streamed ones and emitting a boundary only when the message id changes.
  assistantMessageId: string | null
  usageMessageIds: Map<string, string>
  usageByMessage: Map<string, Record<string, unknown>>
  // 上下文占用：每一路（'' 是主会话，其余是子代理的 parent_tool_use_id）最近一次请求的用量
  contextUsage: Map<string, RequestUsage>
  // 最近一次顶层请求用的模型，结果里按它取上下文窗口
  contextModel: string | null
  streamedBlocks: Map<number, { type: string; text: string }>
  // Subagent suppression — when a Task/Agent tool_use opens a subagent, all
  // nested tool_use / text / thinking events should be hidden from the App
  // timeline until the matching tool_result closes the parent Task.
  activeSubagents: Set<string>
  completedWorkflowTasks: Set<string>
  workflowToolUseIds: Set<string>
  workflowLaunches: Map<string, WorkflowLaunchInfo>
  workflowTranscriptRoots: string[]
  skippedWorkflowTaskIds: Set<string>
  workflowTasks: Map<string, WorkflowTaskState>
  // Tool ids whose content_block_start we already saw — used to skip the
  // second delivery via AssistantMessage.content (the SDK ships every
  // ToolUseBlock twice; we keep only the AssistantMessage copy because
  // content_block_start arrives with empty input).
  toolStartSeen: Set<string>
  // Buffer + tool ids for StructuredOutput coercion: when the SDK ships a
  // synthetic StructuredOutput tool_use we want to suppress the streamed
  // text and emit only the final coerced JSON.
  structuredBuffer: string
  pendingUserMessage: null | { resolve: (v: { message: unknown }) => void }
  deferredResult: PendingTurnResult | null
  workflowFailure: string | null
  // 模型交了计划、入口没问（context.planConfirmation 为假）：拒绝那次 ExitPlanMode 并让 CLI 停下。
  // CLI 因此报的 error_during_execution 是这次停下，不是出错，回合按正常结束算。
  planHandoff: boolean
  // 后台子代理：task_id（即 agentId）→ Agent 工具调用 ID，结果以 task_notification 为准。
  backgroundAgents: Map<string, string>
  // 各子代理最近一段正文，后台子代理结束时作为它的结果。
  subagentText: Map<string, string>
  // 主会话这一回合调的 SendMessage：调用 ID → 交给子代理的话。CLI 续跑子代理时 task_started 的 tool_use_id 是其中之一
  sendMessages: Map<string, string>
  // 这一回合里被 SendMessage 续跑、还没结束的子代理：agentId → 那次 SendMessage 的调用 ID
  resumedAgents: Map<string, string>
  // 上次报子代理流式增量的时刻（毫秒）：增量很密，隔一秒报一次就够看门狗用
  // 每个子代理（按派出它的 Agent 调用）上一次报“有动静”的时刻
  subagentStreamAt: Map<string, number>
  // 主会话最近一条 API 出错的助手消息上 CLI 归的类（SDKAssistantMessageError），回合失败时拼 codexErrorInfo
  apiErrorCategory: string | null
}

interface PendingTurnResult {
  success: boolean
  resultText: string | null
  claudeSessionId: string | null
  codexErrorInfo?: CodexErrorInfo | null
}

interface WorkflowTaskState {
  taskId: string
  toolUseId: string
  workflowName: string
  description: string
  prompt: string
  monitor: WorkflowJournalMonitor | null
  aggregateStarted: boolean
  terminal: boolean
  monitorFailed?: boolean
}

interface PendingPermission {
  resolve: (value: PermissionDecision) => void
}

const WORKFLOW_TERMINAL_FLUSH_TIMEOUT_MS = 500
// 没有回合也没有后台命令的进程多留这么久再退出，避免刚停掉命令就来了新回合。
const IDLE_REAP_MS = 2_000
const SPONTANEOUS_ATTACH_TIMEOUT_MS = 10_000
// 为别的会话唤醒时：等对方的 CLI 进程起来最多多久（之前要算差异基线、连 MCP），进程起来之后等它的收件箱就绪最多多久
const PEER_WAKE_START_MS = 60_000
const PEER_WAKE_READY_MS = 30_000
const WORKFLOW_JOURNAL_SETTLE_TIMEOUT_MS = 3_000

// 进程名下还有回合结束后要接着跑的东西：后台命令（含 Monitor 工具起的）、MCP 与 WebSocket 监视
function hasBackgroundWork(session: NativeSession): boolean {
  return session.shells.live.size > 0 || session.monitors.size > 0
}

const joinReminders = (...notes: Array<string | null>): string | null =>
  notes.filter((note) => note !== null).join('\n') || null

export class NativeClaudeRuntime implements ClaudeRuntime {
  private sdk: ClaudeSdk | null = null
  private turns = new Map<string, PendingTurn>()
  private sessions = new Map<string, NativeSession>()
  private sessionHandlers: RuntimeSessionHandlers | null = null
  private turnSettingsReady = new Map<
    string,
    { threadId: string; ready: Promise<PendingTurn | null> }
  >()
  // 以下四张表按会话所属线程登记，覆盖进程从启动到确认退出的整个过程。
  private inputs = new Map<string, NativeTurnInput>()
  private permissions = new Map<string, PendingPermission>()
  private aborts = new Map<string, AbortController>()
  private cleanup = new Map<string, Promise<void>>()
  private processes = new Map<string, NativeProcess>()
  // 追问回合的线程 → 它所用会话的线程，启动期间靠它找到进程。
  private sessionKeys = new Map<string, string>()
  // 正在等旧进程退出、还没起新进程的回合（按线程）；打断时置位。
  private starting = new Map<string, { cancelled: boolean }>()
  // MCP 连接按线程跨回合留着（CLI 进程退出了也留），线程关闭、空闲超时、适配器停止时关。
  private mcpPool = new NativeMcpPool()
  // 会话里起过的有名字的子代理（Agent 工具的 name），按会话键：SendMessage 发给它们时不当成发给别的会话
  private agentNames = new Map<string, Set<string>>()
  // 用户停掉的、还没告诉模型的后台命令，按线程，记着是哪个进程停的（takeStopNotice）
  private userStops = new Map<
    string,
    Array<{ session: NativeSession; taskId: string; toolUseId: string | null; description: string }>
  >()

  setSessionHandlers(handlers: RuntimeSessionHandlers): void {
    this.sessionHandlers = handlers
  }

  cliProcessKeys(): string[] {
    return [...this.processes].filter(([, process]) => !process.hasExited).map(([key]) => key)
  }

  // 只是空闲保留着的进程不算：它不看管任何东西，客户端全断开或配置改变时直接关掉。
  liveSessions(): string[] {
    return [...this.sessions.values()]
      .filter((session) => !session.closing && !this.isIdle(session))
      .map((s) => s.key)
  }

  // 会话改了名，进程还开着：请它在收件箱里换名字（rename_session，同时记成会话的标题）。
  // 关着收件箱时不发；老版本的 CLI 不认，报错就算了，下次起进程时经 CLAUDE_CODE_SESSION_NAME 带上
  async renameSession(threadId: string, name: string): Promise<void> {
    const session = this.sessions.get(threadId)
    if (!session || session.closing || !claudeCrossSessionInbox()) return
    // 运行时有这个方法，SDK 的类型声明里没写
    const query = session.query as Query & { renameSession?: (title: string) => Promise<void> }
    if (typeof query.renameSession !== 'function') return
    await query.renameSession(name).catch((error) => {
      debugLog('native.session_rename.failed', { threadId, error: String(error) })
    })
  }

  async closeIdleSessions(reason: string): Promise<void> {
    await Promise.all(
      [...this.sessions.values()]
        .filter((session) => this.isIdle(session))
        .map((session) => this.shutdown(session, reason)),
    )
  }

  private isIdle(session: NativeSession): boolean {
    return (
      session.idle &&
      !session.closing &&
      !session.turn &&
      !session.attach &&
      !hasBackgroundWork(session)
    )
  }

  async closeSession(threadId: string, reason: string): Promise<void> {
    const session = this.sessions.get(threadId)
    if (session) await this.shutdown(session, reason)
    await this.mcpPool.closeThread(threadId)
  }

  closeIdleMcp(): Promise<void> {
    return this.mcpPool.closeIdle()
  }

  async runTurn(context: RuntimeTurnContext, handlers: RuntimeHandlers): Promise<void> {
    const key = context.sessionThreadId ?? context.threadId
    const existing = this.sessions.get(key)
    if (context.spontaneous) {
      // 为别的会话发来的消息唤醒：没有进程就起一个（不送用户消息），等收件箱里的消息开这一轮
      if (context.wake && (!existing || existing.closing)) {
        if (existing) await succeedsWithin(existing.done, 5_000)
        if (this.processes.has(key))
          throw new ProtocolError(-32009, '上一个 Claude CLI 尚未确认退出，无法唤醒')
        return this.startSession(key, context, handlers)
      }
      // 那一轮已经被拒绝或超时放弃时，没有东西可接。
      if (!existing || existing.closing || existing.turn || (!existing.attach && !context.wake))
        throw new ProtocolError(-32009, 'Claude CLI 已退出，自行续跑的回合无法接上')
      return this.runOnSession(existing, context, handlers)
    }
    let restarted: string | null = null
    let reason: string | null = null
    if (existing && !existing.closing) {
      if (existing.turn)
        throw new ProtocolError(-32009, '上一个 Claude CLI 尚未确认退出，禁止启动新回合')
      reason = this.incompatibility(existing, context)
      if (!reason) return this.runOnSession(existing, context, handlers)
      if (hasBackgroundWork(existing)) restarted = reason
    }
    if (existing) {
      // 等旧进程退出的这段时间里回合可能被打断：记一个标记，打断时置位。
      const starting = { cancelled: false }
      this.starting.set(context.threadId, starting)
      try {
        if (existing.closing) await succeedsWithin(existing.done, 5_000)
        else await this.shutdown(existing, reason ?? '启动配置已改变')
      } finally {
        if (this.starting.get(context.threadId) === starting) this.starting.delete(context.threadId)
      }
      if (starting.cancelled) return
    }
    if (this.processes.has(key))
      throw new ProtocolError(-32009, '上一个 Claude CLI 尚未确认退出，禁止启动新回合')
    if (restarted)
      await handlers.onEvent({
        type: 'notice',
        level: 'warning',
        message: `${restarted}，Claude 进程已重新启动，之前在后台运行的命令已停止。`,
      })
    return this.startSession(key, context, handlers)
  }

  // 新回合能否直接用现有进程；不能时返回要告诉用户的原因。
  private incompatibility(session: NativeSession, context: RuntimeTurnContext): string | null {
    // 压缩只是往会话里送一条命令，不依赖启动配置。
    if (context.purpose === 'compact') return null
    if (context.forkSession || (context.claudeSessionId ?? null) !== session.sessionId)
      return '会话历史已改变'
    if (sessionFingerprint(context) !== session.fingerprint) return '工作目录、工具或指令配置已改变'
    // 进程起来时读的登录、模型服务设置（环境变量、settings.json 里的凭据）之后不再重读
    if (rateScope(context) !== session.credentialScope) return 'Claude 的登录或模型服务设置已改变'
    if (providerScope(context) !== session.providerScope) return '模型供应商或它的设置已改变'
    if (needsStrictSkillShell(context) && !session.strictSkillShell) return '权限设置已收紧'
    if ((!context.model && session.applied.model) || (!context.effort && session.applied.effort))
      return '模型设置已改变'
    return null
  }

  private beginTurnSettings(context: RuntimeTurnContext): (pending: PendingTurn | null) => void {
    let ready!: (pending: PendingTurn | null) => void
    this.turnSettingsReady.set(context.turnId, {
      threadId: context.threadId,
      ready: new Promise((resolve) => {
        ready = resolve
      }),
    })
    return ready
  }

  private attachTurn(
    session: NativeSession,
    context: RuntimeTurnContext,
    handlers: RuntimeHandlers,
  ): PendingTurn {
    let resolve!: () => void
    let reject!: (error: Error) => void
    const outcome = new Promise<void>((done, fail) => {
      resolve = done
      reject = fail
    })
    const pending: PendingTurn = {
      credentialScope: rateScope(context),
      session,
      context,
      handlers,
      query: session.query,
      abort: session.abort,
      input: session.input,
      resolved: false,
      resolve,
      reject,
      outcome,
      settled: outcome.catch(() => {}),
      awaited: null,
      awaitedSeen: false,
      assistantMessageId: null,
      usageMessageIds: new Map(),
      usageByMessage: new Map(),
      contextUsage: new Map(),
      contextModel: null,
      streamedBlocks: new Map(),
      activeSubagents: new Set(),
      completedWorkflowTasks: new Set(),
      workflowToolUseIds: new Set(),
      workflowLaunches: new Map(),
      workflowTranscriptRoots: defaultWorkflowTranscriptRoots(process.env, context.cwd),
      skippedWorkflowTaskIds: new Set(),
      workflowTasks: new Map(),
      toolStartSeen: new Set(),
      structuredBuffer: '',
      pendingUserMessage: null,
      deferredResult: null,
      workflowFailure: null,
      planHandoff: false,
      backgroundAgents: new Map(),
      subagentText: new Map(),
      sendMessages: new Map(),
      resumedAgents: new Map(),
      subagentStreamAt: new Map(),
      apiErrorCategory: null,
    }
    this.turns.set(context.turnId, pending)
    session.context = context
    session.turn = pending
    session.attachResolve?.(pending)
    return pending
  }

  // 在已有进程上跑一个回合：用户回合送入一条消息；自行续跑的回合接到已经在跑的那一轮上。
  private async runOnSession(
    session: NativeSession,
    context: RuntimeTurnContext,
    handlers: RuntimeHandlers,
  ): Promise<void> {
    this.clearTimer(session, 'reapTimer')
    session.idle = false
    const ready = this.beginTurnSettings(context)
    try {
      const pending = this.attachTurn(session, context, handlers)
      if (context.wake) this.armWakeTimeout(session, pending)
      // 用户消息送进去之前到达的 result（比如正好赶上的后台命令通知那一轮）不属于这个回合：
      // 接上时就记下要等的消息 ID。
      const uuid = context.spontaneous ? null : randomUUID()
      pending.awaited = uuid
      try {
        // 压缩用的是一套临时配置，不改会话已经生效的模型与模式。
        if (context.purpose !== 'compact') await this.applyTurnConfig(session, context)
        if (uuid && !pending.resolved) {
          const reminder =
            context.purpose === 'compact'
              ? null
              : joinReminders(
                  goalReminder(session.applied.goalContext, context.goalContext ?? null),
                  carriesReminder(context) ? this.takeStopNotice(session.key, session) : null,
                )
          if (context.purpose !== 'compact')
            session.applied.goalContext = context.goalContext ?? null
          session.input.send(userMessage(context, uuid, reminder))
          this.requestTitle(session, context)
        }
        // 首条用户消息送入之后才放行回合内追加的指令，保证先后。
        ready(pending)
      } catch (error) {
        // 进程在应用设置时出了问题：整个进程不再可信，连同后台命令一起结束。
        if (!pending.resolved) {
          void this.shutdown(session, '应用回合设置失败')
          throw error
        }
      }
      await pending.outcome
    } finally {
      ready(null)
      this.turnSettingsReady.delete(context.turnId)
      if (session.closing) await session.done
    }
  }

  // 模型、推理强度、计划模式都有运行期接口；其余启动配置由 incompatibility 把关。
  private async applyTurnConfig(
    session: NativeSession,
    context: RuntimeTurnContext,
  ): Promise<void> {
    const settings: RuntimeTurnSettings = {}
    if (context.model && context.model !== session.applied.model) settings.model = context.model
    if (context.effort && context.effort !== session.applied.effort)
      settings.effortLevel = context.effort as NonNullable<RuntimeTurnSettings['effortLevel']>
    if (Object.keys(settings).length > 0) {
      await session.query.applyFlagSettings(settings)
      if (settings.model) session.applied.model = settings.model
      if (settings.effortLevel) session.applied.effort = settings.effortLevel
    }
    if (context.planMode !== session.applied.planMode) {
      await session.query.setPermissionMode(derivePermissionMode(context.planMode))
      session.applied.planMode = context.planMode
    }
  }

  private clearTimer(session: NativeSession, name: 'reapTimer' | 'notificationTimer'): void {
    const timer = session[name]
    if (timer) clearTimeout(timer)
    session[name] = null
  }

  // 结束一个进程：让 CLI 自己停掉后台命令并退出，等它确认。
  private async shutdown(session: NativeSession, reason: string): Promise<void> {
    if (!session.closeReason) session.closeReason = reason
    session.closing = true
    this.clearTimer(session, 'reapTimer')
    this.clearTimer(session, 'notificationTimer')
    session.attachResolve?.(null)
    session.input.close()
    try {
      await session.process.terminate()
    } catch (error) {
      debugLog('native.session.terminateFailed', { threadId: session.key, error: String(error) })
    }
    session.abort.abort()
    await session.done
  }

  // 唤醒回合等的那条消息一直没来（发送方的 SendMessage 被拒、发送失败）：说一声，按普通回合结束收尾
  private armWakeTimeout(session: NativeSession, pending: PendingTurn): void {
    const timer = setTimeout(() => {
      if (pending.resolved || session.turn !== pending || session.closing) return
      if (session.state === 'running' || session.state === 'requires_action') return
      void this.endEmptyWake(session, pending)
    }, peerWakeWaitMs())
    timer.unref()
    void pending.settled.then(() => clearTimeout(timer))
  }

  private async endEmptyWake(session: NativeSession, pending: PendingTurn): Promise<void> {
    this.detach(pending)
    const refusal = this.keepAlive(session)
    if (refusal !== null) {
      session.closing = true
      session.process.allowGracefulClose()
      session.input.close()
    }
    try {
      await pending.handlers.onEvent({
        type: 'notice',
        level: 'info',
        message: '为别的会话发来的消息唤醒了这个会话，但没有等到消息',
      })
      await pending.handlers.onEvent({
        type: 'completed',
        success: true,
        result: null,
        claudeSessionId: session.sessionId,
      })
      pending.resolve()
    } catch (error) {
      pending.reject(error instanceof Error ? error : new Error(String(error)))
    }
  }

  // 别的会话的 SendMessage 要发给 to：是本机没在跑的 Litch 会话时先把它的 CLI 拉起来，等收件箱就绪再放行，
  // 消息照旧由 CLI 自己投递。认不出、拉不起来、等不到都放行，CLI 照常报它的错。
  // 分两段等：先等进程起来（之前有算基线、连 MCP 这些，唤醒回合结束了就不再等），再从起来那刻算收件箱就绪
  private async wakePeer(from: string, to: string): Promise<void> {
    if (!to || !this.sessionHandlers?.onPeerWake) return
    // 发给自己起的、有名字的子代理：CLI 先按自己的代理认，不是别的会话
    if (this.agentNames.get(from)?.has(to.replace(/\s*\[[0-9a-zA-Z]+\]$/, '').trim())) return
    let wake: RuntimePeerWake | null
    try {
      wake = await this.sessionHandlers.onPeerWake(to, from)
    } catch (error) {
      debugLog('native.peerWake.failed', { from, to, error: String(error) })
      return
    }
    if (!wake || wake.key === from) return
    let ended = false
    void wake.ended?.then(
      () => {
        ended = true
      },
      () => {
        ended = true
      },
    )
    // 供应商只换 ANTHROPIC_* 那几项，不动配置目录：按设备进程自己的环境找
    const configDir = claudeConfigDir()
    const startBy = Date.now() + PEER_WAKE_START_MS
    let readyBy: number | null = null
    while (!ended) {
      const session = this.sessions.get(wake.key)
      const pid = session && !session.closing ? session.process.cliPid : null
      if (pid !== null) {
        readyBy ??= Date.now() + PEER_WAKE_READY_MS
        if (await inboxReady(pid, configDir)) return
        if (Date.now() > readyBy) break
      } else if (Date.now() > startBy) break
      await delay(200)
    }
    debugLog('native.peerWake.notReady', { from, to, key: wake.key, ended })
  }

  closingSession(threadId: string): Promise<void> | null {
    const session = this.sessions.get(threadId)
    if (session) return session.closing ? session.done : null
    return this.processes.has(threadId) ? (this.cleanup.get(threadId) ?? null) : null
  }

  // 没有回合也没有后台命令的进程不再有用。开了空闲保留时多留一会儿，下个回合直接用。
  private scheduleReap(session: NativeSession): void {
    if (session.reapTimer || session.closing) return
    const idleMs = keepAliveIdleMs()
    if (idleMs > 0 && !session.idle) {
      session.idle = true
      session.idleSince = Date.now()
    }
    session.reapTimer = setTimeout(
      () => {
        session.reapTimer = null
        if (session.closing || session.turn || session.attach || hasBackgroundWork(session)) return
        void this.shutdown(session, idleMs > 0 ? '空闲保留已到时' : '后台命令已全部结束')
      },
      Math.max(IDLE_REAP_MS, idleMs),
    )
    session.reapTimer.unref()
  }

  // 起一个新的 CLI 进程并在上面跑第一个回合。
  private async startSession(
    key: string,
    context: RuntimeTurnContext,
    handlers: RuntimeHandlers,
  ): Promise<void> {
    let cleaned!: () => void
    const done = new Promise<void>((resolve) => {
      cleaned = resolve
    })
    this.cleanup.set(key, done)
    const input = new NativeTurnInput()
    const abort = new AbortController()
    const mcp = new NativeMcpBridge(this.mcpPool, key)
    const nativeProcess = new NativeProcess(key, context.turnId)
    this.processes.set(key, nativeProcess)
    this.inputs.set(key, input)
    this.aborts.set(key, abort)
    if (key !== context.threadId) this.sessionKeys.set(context.threadId, key)
    const ready = this.beginTurnSettings(context)
    const slot: { context: RuntimeTurnContext; session: NativeSession | null } = {
      context,
      session: null,
    }
    const current = (): Promise<PendingTurn | null> =>
      slot.session ? this.currentTurn(slot.session) : Promise.resolve(null)
    let session: NativeSession | null = null
    let pending: PendingTurn
    try {
      if (
        context.permissionTools &&
        Object.keys(context.mcpServers ?? {}).some(
          (name) => name.replace(/[^a-zA-Z0-9_-]/g, '_') === 'codex_harness_adapter_permissions',
        )
      )
        throw new Error('codex_harness_adapter_permissions 是内部权限服务保留名称')
      const sdk = await this.loadSdk()
      if (input.isClosed) throw new ProtocolError(-32009, '原生回合启动已取消')
      const live = liveContext({
        get context() {
          return slot.session?.context ?? slot.context
        },
      })
      const liveHandlers = this.liveHandlers(current)
      const inboxSocket = claudeCrossSessionInbox()
        ? await claimPeerInboxSocket(key, process.env)
        : null
      const options = this.buildOptions(sdk, live, abort, current, key, inboxSocket)
      options.spawnClaudeCodeProcess = nativeProcess.spawn.bind(nativeProcess)
      options.mcpServers = await mcp.connect(
        context.mcpServers,
        context.cwd,
        liveHandlers,
        abort.signal,
        context.mcpConfigSource,
      )
      if (input.isClosed) throw new ProtocolError(-32009, '原生回合启动已取消')
      const denied = cliDeniedServers(context.mcpServers)
      if (denied.length > 0)
        options.settings = {
          ...(options.settings as Record<string, unknown>),
          deniedMcpServers: denied,
        }
      this.addInternalServers(options, live, liveHandlers, abort)
      const query = sdk.query({ prompt: input, options })
      session = {
        key,
        fingerprint: sessionFingerprint(context),
        credentialScope: rateScope(context),
        providerScope: providerScope(context),
        strictSkillShell: needsStrictSkillShell(context),
        sessionId: null,
        context,
        turn: null,
        query,
        input,
        abort,
        mcp,
        process: nativeProcess,
        shells: {
          live: new Map(),
          taskToolUse: new Map(),
          bashCommand: new Map(),
          seqByTask: new Map(),
          nextSeq: 0,
        },
        backgroundTasks: new Set(),
        monitors: new Map(),
        state: null,
        applied: {
          model: context.model,
          effort: context.effort,
          goalContext: context.goalContext ?? null,
          planMode: context.planMode,
        },
        notificationAt: null,
        notificationTimer: null,
        reapTimer: null,
        attach: null,
        attachResolve: null,
        discard: false,
        kept: false,
        idle: false,
        idleSince: 0,
        closing: false,
        closeReason: '',
        title: null,
        done,
      }
      slot.session = session
      this.sessions.set(key, session)
      pending = this.attachTurn(session, context, handlers)
      ready(pending)
      // The SDK accepts either a plain string prompt OR an AsyncIterable of
      // SDKUserMessage envelopes. Always feed the iterable form so we have
      // room to attach image blocks alongside the text and the door is open
      // for mid-turn steer() calls.
      // 唤醒回合不送用户消息：这一轮由收件箱里别的会话发来的消息开
      if (context.wake) this.armWakeTimeout(session, pending)
      else {
        const notice = carriesReminder(context) ? this.takeStopNotice(session.key, session) : null
        input.send(userMessage(context, null, notice))
        this.requestTitle(session, context)
      }
    } catch (error) {
      // 进程没有进入消息循环，这里按同样的顺序收尾。
      ready(null)
      this.turnSettingsReady.delete(context.turnId)
      this.sessionKeys.delete(context.threadId)
      if (session && this.sessions.get(key) === session) this.sessions.delete(key)
      try {
        await this.releaseProcess(key, input, abort, mcp, nativeProcess, () => {})
      } finally {
        if (this.cleanup.get(key) === done) this.cleanup.delete(key)
        cleaned()
      }
      throw error
    }
    // Kick off the receive loop in the background. We don't await it here
    // because runTurn() must resolve when the turn ends — the receive loop
    // settles each turn and keeps serving the process afterwards.
    void this.runSession(session, cleaned)
    try {
      await pending.outcome
    } finally {
      ready(null)
      this.turnSettingsReady.delete(context.turnId)
      this.sessionKeys.delete(context.threadId)
      if (session.closing) await session.done
    }
  }

  // 消息循环结束即进程生命周期结束：结清挂着的回合，确认进程退出，释放执行屏障。
  private async runSession(session: NativeSession, cleaned: () => void): Promise<void> {
    try {
      await this.consume(session)
    } catch (error) {
      // 收尾本身出错也不能把回合和进程登记留在那里。
      debugLog('native.session.consumeFailed', { threadId: session.key, error: String(error) })
      const pending = session.turn
      if (pending && !pending.resolved) {
        this.detach(pending)
        pending.reject(error instanceof Error ? error : new Error(String(error)))
      }
    }
    session.closing = true
    this.clearTimer(session, 'reapTimer')
    this.clearTimer(session, 'notificationTimer')
    session.attachResolve?.(null)
    const reason = session.closeReason || 'Claude 进程已退出'
    try {
      await this.releaseProcess(
        session.key,
        session.input,
        session.abort,
        session.mcp,
        session.process,
        () => {},
      )
    } finally {
      if (this.sessions.get(session.key) === session) {
        this.sessions.delete(session.key)
        // 有名字的子代理跟着进程没了
        this.agentNames.delete(session.key)
      }
      if (this.cleanup.get(session.key) === session.done) this.cleanup.delete(session.key)
      try {
        this.sessionHandlers?.onSessionClosed(session.key, reason)
      } catch (error) {
        debugLog('native.session.closedHandlerFailed', {
          threadId: session.key,
          error: String(error),
        })
      }
      cleaned()
    }
  }

  private async releaseProcess(
    key: string,
    input: NativeTurnInput,
    abort: AbortController,
    mcp: NativeMcpBridge,
    nativeProcess: NativeProcess,
    cleaned: () => void,
  ): Promise<void> {
    input.close()
    if (this.inputs.get(key) === input) this.inputs.delete(key)
    if (this.aborts.get(key) === abort) this.aborts.delete(key)
    let stopped = false
    try {
      try {
        await nativeProcess.stopIfUnconfirmed()
        await mcp.close()
      } finally {
        if (!(await nativeProcess.wait(3_000))) await nativeProcess.terminate()
        stopped = true
      }
    } finally {
      if (stopped && this.processes.get(key) === nativeProcess) this.processes.delete(key)
      cleaned()
    }
  }

  listBackgroundShells(threadId: string): RuntimeBackgroundShell[] {
    const session = this.sessions.get(threadId)
    if (!session) return []
    const state = session.shells
    const shells: RuntimeBackgroundShell[] = [...state.live].map(([taskId, seq]) => {
      const toolUseId = state.taskToolUse.get(taskId) ?? null
      return {
        taskId,
        toolUseId,
        command: (toolUseId && state.bashCommand.get(toolUseId)) || '',
        seq,
      }
    })
    for (const [taskId, monitor] of session.monitors)
      shells.push({
        taskId,
        toolUseId: null,
        command: monitor.description,
        seq: monitor.seq,
        monitor: true,
      })
    return shells.sort((a, b) => a.seq - b.seq)
  }

  // 有没有回合在跑都能停：后台命令、监视属于进程，不属于某个回合。CLI 的 stop_task 停哪种任务都是同一个函数，
  // 监视（monitor_*）也停得掉。用户停的命令记下来（userStops），下一轮换了进程时由 Litch 告诉模型
  async stopBackgroundShell(threadId: string, taskId: string): Promise<boolean> {
    const session = this.sessions.get(threadId)
    if (!session || session.closing) return false
    const shell = session.shells.live.has(taskId)
    if (!shell && !session.monitors.has(taskId)) return false
    try {
      await session.query.stopTask(taskId)
    } catch (error) {
      debugLog('native.backgroundShell.stopFailed', { threadId, taskId, error: String(error) })
      return false
    }
    if (shell) {
      const toolUseId = session.shells.taskToolUse.get(taskId) ?? null
      const stops = this.userStops.get(threadId) ?? []
      stops.push({
        session,
        taskId,
        toolUseId,
        description: (toolUseId && session.shells.bashCommand.get(toolUseId)) || taskId,
      })
      this.userStops.set(threadId, stops)
    }
    return true
  }

  /**
   * 上一轮之后用户停掉的后台命令，这一轮开头给模型的那段话。CLI 对用户停的命令自己会在下一轮开头并进一条
   * 不开回合的通知，但它只在进程的内存里：还是停它的那个进程就交给 CLI，换了进程（空闲回收、配置变了）的由
   * Litch 照 CLI 的样子补上。取了就清掉，只交一次
   */
  private takeStopNotice(threadId: string, session: NativeSession): string | null {
    const stops = this.userStops.get(threadId)
    if (!stops) return null
    this.userStops.delete(threadId)
    const lost = stops.filter((stop) => stop.session !== session)
    return lost.length ? stopNotice(lost) : null
  }

  async stopSubagentTask(threadId: string, taskId: string): Promise<boolean> {
    const session = this.sessionFor(threadId)
    if (!session || session.closing) return false
    try {
      await session.query.stopTask(taskId)
      return true
    } catch (error) {
      debugLog('native.subagent.stopFailed', { threadId, taskId, error: String(error) })
      return false
    }
  }

  // 线程当前的进程：它自己的，或者（追问回合）它借用的父线程的。
  private sessionFor(threadId: string): NativeSession | null {
    const own = this.sessions.get(threadId)
    if (own) return own
    for (const session of this.sessions.values())
      if (session.turn?.context.threadId === threadId) return session
    return null
  }

  // 回调（权限、钩子、内置工具）到来时所属的回合。没有回合说明 CLI 自己开了一轮，
  // 请协议层接上；接不上返回 null，调用方按“回合已结束”拒绝。
  private currentTurn(session: NativeSession): Promise<PendingTurn | null> {
    if (session.turn) return Promise.resolve(session.turn)
    if (session.closing || session.discard) return Promise.resolve(null)
    if (session.attach) return session.attach
    let timer: ReturnType<typeof setTimeout> | undefined
    session.attach = new Promise<PendingTurn | null>((resolve) => {
      session.attachResolve = (turn) => {
        clearTimeout(timer)
        session.attach = null
        session.attachResolve = null
        resolve(turn)
      }
    })
    const attach = session.attach
    const refuse = (): void => {
      if (session.attach === attach) this.abandonRound(session)
    }
    timer = setTimeout(refuse, SPONTANEOUS_ATTACH_TIMEOUT_MS)
    timer.unref()
    if (!this.sessionHandlers) refuse()
    else
      void this.sessionHandlers.onSpontaneousTurn(session.key).then((accepted) => {
        if (!accepted) refuse()
      }, refuse)
    return attach
  }

  // 放弃 CLI 自己开的、没有回合来接的那一轮：中止它，丢掉它剩下的输出。
  private abandonRound(session: NativeSession): void {
    if (!session.attachResolve) return
    session.discard = true
    session.attachResolve(null)
    void session.query.interrupt().catch(() => {})
    // 等人接的时候回收被跳过了，这里补上。
    this.scheduleReap(session)
  }

  private liveHandlers(current: () => Promise<PendingTurn | null>): RuntimeHandlers {
    const turn = async (): Promise<RuntimeHandlers> => {
      const pending = await current()
      if (!pending) throw new Error('回合已结束，不能执行')
      return pending.handlers
    }
    return {
      onEvent: async (event) => {
        await (await current())?.handlers.onEvent(event)
      },
      onPermissionRequest: async (event) => (await turn()).onPermissionRequest(event),
      onPermissionToolCall: async (proposal, callId) => {
        const handlers = await turn()
        if (!handlers.onPermissionToolCall) throw new Error('权限执行端不可用')
        return handlers.onPermissionToolCall(proposal, callId)
      },
      onGoalToolCall: async (name, args, callId) => {
        const handlers = await turn()
        if (!handlers.onGoalToolCall) throw new Error('目标执行端不可用')
        return handlers.onGoalToolCall(name, args, callId)
      },
      onDynamicToolCall: async (tool, args, callId) => {
        const handlers = await turn()
        if (!handlers.onDynamicToolCall) throw new Error('工具未注册或执行端不可用')
        return handlers.onDynamicToolCall(tool, args, callId)
      },
      onElicitationRequest: async (request, signal) => {
        const handlers = await turn()
        if (!handlers.onElicitationRequest) throw new Error('MCP 交互处理器未注册')
        return handlers.onElicitationRequest(request, signal)
      },
    }
  }

  async steer(threadId: string, prompt: string, messageId?: string): Promise<void> {
    // 进程还在启动，或回合正在应用设置：等首条用户消息送入之后再送，保证先后。
    const starting = [...this.turnSettingsReady.values()].find(
      (entry) => entry.threadId === threadId,
    )
    const pending = starting ? await starting.ready : (this.sessionFor(threadId)?.turn ?? null)
    if (!pending || pending.resolved || pending.context.threadId !== threadId)
      throw new ProtocolError(-32009, '原生回合未启动或已结束')
    const uuid = messageId ?? randomUUID()
    pending.input.send(steerMessage(workflowRuntimePrompt(prompt), uuid))
    pending.awaited = uuid
    pending.awaitedSeen = false
  }

  async appendContext(context: ContextInjection): Promise<{ boundary: string }> {
    const session = this.sessions.get(context.threadId)
    if (session && !session.closing) return this.appendToSession(session, context)
    if (this.processes.has(context.threadId))
      throw new ProtocolError(-32009, 'Claude CLI 尚未退出，不能追加上下文')
    let cleaned!: () => void
    const cleanup = new Promise<void>((resolve) => {
      cleaned = resolve
    })
    const abort = new AbortController()
    const nativeProcess = new NativeProcess(context.threadId, context.messageId)
    this.cleanup.set(context.threadId, cleanup)
    this.processes.set(context.threadId, nativeProcess)
    this.aborts.set(context.threadId, abort)
    const timeout = setTimeout(() => abort.abort(new Error('原生上下文追加超时')), 20_000)
    try {
      return await appendNativeContext(await this.loadSdk(), context, abort, nativeProcess)
    } finally {
      clearTimeout(timeout)
      try {
        await nativeProcess.stopIfUnconfirmed()
        if (!(await nativeProcess.wait(3_000))) await nativeProcess.terminate()
        if (this.processes.get(context.threadId) === nativeProcess)
          this.processes.delete(context.threadId)
      } finally {
        if (this.aborts.get(context.threadId) === abort) this.aborts.delete(context.threadId)
        if (this.cleanup.get(context.threadId) === cleanup) this.cleanup.delete(context.threadId)
        cleaned()
      }
    }
  }

  // 进程还活着：直接送不触发模型请求的输入帧（见 contextFrameBatches），不另起进程抢同一个会话文件。
  private async appendToSession(
    session: NativeSession,
    context: ContextInjection,
  ): Promise<{ boundary: string }> {
    if (session.turn || session.attach)
      throw new ProtocolError(-32009, 'Claude CLI 正在运行，不能追加上下文')
    if (context.sessionId !== session.sessionId)
      throw new ProtocolError(-32000, '原生会话与存活的 Claude 进程不一致，不能追加上下文')
    const sdk = await this.loadSdk()
    const done = await persistedContext(sdk, context)
    if (done.count === context.messages.length && done.boundary) return { boundary: done.boundary }
    let previous: SDKUserMessage[] | undefined
    for (const batch of contextFrameBatches(context, done.count)) {
      if (previous) await nativeMessagePersisted(sdk, context, previous.at(-1)?.uuid)
      for (const frame of batch) session.input.send(frame)
      previous = batch
    }
    // 最后一条落盘了整批才算完；中途看会是“只写进了一部分”
    await nativeMessagePersisted(sdk, context, context.messages.at(-1)?.uuid)
    const boundary = await persistedContextBoundary(sdk, context)
    if (!boundary) throw new ProtocolError(-32000, '原生历史未持久化注入 UUID，不能返回成功')
    return { boundary }
  }

  async updateTurnSettings(
    threadId: string,
    turnId: string,
    settings: RuntimeTurnSettings,
  ): Promise<boolean> {
    const startup = this.turnSettingsReady.get(turnId)
    if (!startup || startup.threadId !== threadId) return false
    const pending = await startup.ready
    if (!pending || pending.resolved || pending.abort.signal.aborted) return false
    // CLI 的 flag 层只属于当前进程，不写 settings 文件。进程可能留到后面的回合，
    // 所以记下已生效的值，下个回合按线程设置重新对齐。
    if (Object.keys(settings).length) {
      await pending.query.applyFlagSettings(settings)
      if (settings.model) pending.session.applied.model = settings.model
      if (settings.effortLevel) pending.session.applied.effort = settings.effortLevel
    }
    return true
  }

  async forkSession(
    sessionId: string,
    cwd: string,
    upToMessageId?: string,
  ): Promise<NativeSessionFork> {
    const sdk = await this.loadSdk()
    return forkNativeSession(sdk, sessionId, cwd, upToMessageId)
  }

  // SDK 的 deleteSession 只删这个项目目录里的 `<会话>.jsonl` 和 `<会话>/`（子代理的记录），找不到就报错。
  async deleteSession(sessionId: string, cwd: string): Promise<void> {
    const sdk = await this.loadSdk()
    await sdk.deleteSession(sessionId, { dir: cwd })
  }

  // CLI 给会话起的标题：SDK 读会话记录，用户改的名优先，其次 CLI 起的（ai-title）
  async sessionTitle(sessionId: string, cwd: string): Promise<string | null> {
    const sdk = await this.loadSdk()
    const info = await sdk.getSessionInfo(sessionId, { dir: cwd })
    return info?.customTitle?.trim() || null
  }

  // 会话还没有名字、CLI 又不会自己起的时候（宿主环境让它不起；续接的会话它也不起），
  // 请这个进程照会话的第一句话起一个并写进会话记录，回合结束时由协议层读出来。
  // 已经有标题的它直接给回来，不再请求模型；老版本的 CLI 不认这个请求，报错就算了。
  private requestTitle(session: NativeSession, context: RuntimeTurnContext): void {
    const description = context.sessionTitle?.trim()
    if (!description || session.title) return
    if (
      context.claudeSessionId == null &&
      !cliSkipsAutoTitle({ ...titleEnv(context), ...hostClaudeEnvOverrides })
    )
      return
    // 运行时有这个方法，SDK 的类型声明里没写
    const query = session.query as Query & {
      generateSessionTitle?: (
        description: string,
        options: { persist: boolean },
      ) => Promise<unknown>
    }
    if (typeof query.generateSessionTitle !== 'function') return
    session.title = query.generateSessionTitle(description, { persist: true }).catch((error) => {
      debugLog('native.session_title.failed', { threadId: session.key, error: String(error) })
    })
  }

  async interrupt(threadId: string): Promise<void> {
    // 回合还在等旧进程退出：让它不要再起新进程。
    const starting = this.starting.get(threadId)
    if (starting) starting.cancelled = true
    const session = this.sessionFor(threadId)
    if (!session) {
      // 进程还在启动，或者只是一次上下文追加。
      const key = this.sessionKeys.get(threadId) ?? threadId
      const cleanup = this.cleanup.get(key)
      const nativeProcess = this.processes.get(key)
      this.inputs.get(key)?.close()
      this.aborts.get(key)?.abort()
      if (nativeProcess && !(await nativeProcess.wait(2_500))) await nativeProcess.terminate()
      await cleanup
      if (this.processes.get(key) === nativeProcess) this.processes.delete(key)
      return
    }
    const pending = session.turn
    if (!pending) {
      // CLI 自己开的那一轮还没有回合接上：协议层的回合已经被打断，这一轮不再要了。
      // 其余情况下留着的进程只是在看管后台命令，打断与它无关。
      if (session.attach && !session.closing) this.abandonRound(session)
      return
    }
    // 还有后台命令在跑时只中止这一轮，进程和命令都留下。
    if (!session.closing && hasBackgroundWork(session) && keepAliveLimit() > 0) {
      if (await this.interruptRound(pending)) {
        await this.stopWorkflowTasks(pending)
        if ((await succeedsWithin(pending.settled, 2_500)) && !session.closing) return
      }
    }
    await this.interruptAndClose(session)
  }

  // 只中止当前这一轮。停止意味着全部停下：排着队还没处理的追加指令一并取消，
  // 否则它们会在打断之后自己跑起来。取消不掉（旧版 CLI 不认这个选项）时返回 false，
  // 由调用方改为结束进程。
  private async interruptRound(pending: PendingTurn): Promise<boolean> {
    const interrupt = pending.query.interrupt.bind(pending.query) as (options?: {
      cancelQueued?: boolean
    }) => Promise<{ still_queued?: string[] } | undefined>
    let receipt: { still_queued?: string[] } | undefined
    const done = interrupt({ cancelQueued: true }).then((value) => {
      receipt = value
    })
    if (!(await succeedsWithin(done, 1_500))) return false
    return !receipt?.still_queued?.length
  }

  private async interruptAndClose(session: NativeSession): Promise<void> {
    const pending = session.turn
    const nativeProcess = session.process
    if (!session.closeReason) session.closeReason = '回合已中断'
    session.closing = true
    // SDK 的 abort 先关闭 stdin，CLI 仍有退出宽限期；此时释放 MCP
    // 会把错误工具结果送回尚未中断的模型循环。先等待 CLI 确认中断。
    if (pending) {
      if (await succeedsWithin(pending.query.interrupt(), 1_500)) nativeProcess.allowGracefulClose()
      else await nativeProcess.terminate()
    }
    session.input.close()
    session.abort.abort()
    if (pending) await this.stopWorkflowTasks(pending)
    if (!(await nativeProcess.wait(2_500))) await nativeProcess.terminate()
    await session.done
  }

  async stop(): Promise<void> {
    const sessions = [...this.sessions.values()]
    const others = [...new Set([...this.cleanup.keys(), ...this.processes.keys()])].filter(
      (key) => !this.sessions.has(key),
    )
    await Promise.all([
      ...sessions.map((session) =>
        session.turn ? this.interruptAndClose(session) : this.shutdown(session, '适配器已停止'),
      ),
      ...others.map((key) => this.interrupt(key)),
    ])
    await this.mcpPool.close()
    this.turns.clear()
    this.permissions.clear()
  }

  // 模型目录取自固定 CLI 的原生 /model 列表（按供应商的凭据列，订阅、API key 各有各的）；
  // 只读元数据，不发送用户消息也不请求模型。
  supportedModels(provider?: string | null): Promise<NativeModelInfo[]> {
    return this.metadataQuery(
      'model-catalog',
      '读取原生模型目录超时',
      (query) => query.supportedModels(),
      provider ?? null,
    )
  }

  // 订阅额度取自 CLI 的 get_usage（/usage 背后的数据），CLI 自己用它的登录去问；
  // 跳过本机会话记录的扫描（behaviors），只要额度
  accountUsage(): Promise<NativeAccountUsage> {
    return this.metadataQuery(
      'account-usage',
      '读取账号额度超时',
      (query) =>
        query.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET({ skipBehaviors: true }),
      ACCOUNT_PROVIDER,
    )
  }

  // 起一个只答控制请求的 CLI：不发用户消息，问完就关
  private async metadataQuery<T>(
    label: string,
    timeoutMessage: string,
    ask: (query: Query) => Promise<T>,
    provider: string | null,
  ): Promise<T> {
    const launch = contextLaunch(provider, null)
    const sdk = await this.loadSdk()
    const abort = new AbortController()
    const nativeProcess = new NativeProcess(label, newId())
    const prompt = (async function* (): AsyncGenerator<never> {
      await new Promise((resolve) =>
        abort.signal.addEventListener('abort', resolve, { once: true }),
      )
    })()
    const query = sdk.query({
      prompt,
      options: {
        abortController: abort,
        pathToClaudeCodeExecutable: hostClaudeExecutable(),
        cwd: process.cwd(),
        // 只读用户级（入口自己的目录不是项目）；CHA_CLAUDE_SETTING_SOURCES 没选 user 时一层都不读
        settingSources: claudeSettingSources().filter((source) => source === 'user'),
        tools: [],
        mcpServers: {},
        strictMcpConfig: true,
        env: { ...launch.env, ...hostClaudeEnvOverrides },
        ...(launch.flagSettings ? { settings: withFlagSettings({}, launch) } : {}),
        stderr: (data: string) => process.stderr.write(data),
        spawnClaudeCodeProcess: nativeProcess.spawn.bind(nativeProcess),
      },
    })
    const timeout = setTimeout(() => abort.abort(new Error(timeoutMessage)), 20_000)
    try {
      return await ask(query)
    } finally {
      clearTimeout(timeout)
      abort.abort()
      query.close()
      await nativeProcess.terminate()
    }
  }

  // ── private ──

  private async loadSdk(): Promise<ClaudeSdk> {
    if (this.sdk) return this.sdk
    // Dynamic import keeps the heavy native binary out of the require graph
    // until a real runtime turn is requested (mocked tests don't pay for it).
    this.sdk = await import('@anthropic-ai/claude-agent-sdk')
    return this.sdk
  }

  // 适配器自己的工具服务（动态工具、目标、权限申请）。它们在进程启动时注册，
  // 处理器与上下文都取“当前回合”的。
  private addInternalServers(
    options: Record<string, unknown>,
    context: RuntimeTurnContext,
    handlers: RuntimeHandlers,
    abort: AbortController,
  ): void {
    if (!context.dynamicTools?.length && !context.goalTools && !context.permissionTools) return
    const nativeIds = new Map<string, string[]>()
    const hooks = options.hooks as { PreToolUse: Array<{ hooks: unknown[] }> }
    hooks.PreToolUse.push({
      hooks: [
        async (input: Record<string, unknown>, toolUseId: string) => {
          const key = `${input.tool_name}:${submissionHash(input.tool_input)}`
          const ids = nativeIds.get(key) ?? []
          ids.push(toolUseId)
          nativeIds.set(key, ids)
          return {}
        },
      ],
    })
    const servers = (options.mcpServers as Record<string, unknown>) ?? {}
    if (context.dynamicTools?.length)
      servers.codex_harness_adapter = dynamicToolServer(
        context.dynamicTools,
        handlers,
        (name, args) => {
          const id = nativeIds
            .get(`mcp__codex_harness_adapter__${name}:${submissionHash(args)}`)
            ?.shift()
          if (!id) throw new Error('缺少原生工具调用 ID，禁止执行副作用')
          return id
        },
      )
    if (context.goalTools) {
      if (servers.codex_harness_adapter_goal)
        throw new Error('codex_harness_adapter_goal 是内部目标服务保留名称')
      servers.codex_harness_adapter_goal = goalToolServer(
        {
          ...handlers,
          onGoalToolCall: async (name, args, callId) => {
            const result = await handlers.onGoalToolCall?.(name, args, callId)
            if (name === 'create_goal') context.trackGoalTools = true
            return result
          },
        },
        (name, args) => {
          const id = nativeIds
            .get(`mcp__codex_harness_adapter_goal__${name}:${submissionHash(args)}`)
            ?.shift()
          if (!id) throw new Error('缺少原生目标工具调用 ID，禁止执行')
          return id
        },
      )
    }
    if (context.permissionTools) {
      servers.codex_harness_adapter_permissions = permissionToolServer(
        async (proposal, callId) => {
          abort.signal.throwIfAborted()
          if (context.planMode) throw new Error('计划模式不能申请新增执行权限；请先确认退出计划')
          if (!allowsApproval(context.approvalPolicy, 'request_permissions'))
            throw new Error('当前审批策略禁止申请新增权限')
          if (!handlers.onPermissionToolCall) throw new Error('权限执行端不可用')
          const grant = await handlers.onPermissionToolCall(proposal, callId)
          abort.signal.throwIfAborted()
          if (context.planMode) throw new Error('计划模式禁止应用执行授权')
          context.permissionGrants = mergePermissionOverlay(context.permissionGrants, grant)
          return grant
        },
        (args) => {
          const id = nativeIds.get(`${permissionToolName}:${submissionHash(args)}`)?.shift()
          if (!id) throw new Error('缺少原生权限工具调用 ID，禁止申请授权')
          return id
        },
      )
    }
    options.mcpServers = servers
  }

  // context 是“当前回合”的视图：进程启动时取一次的项用的是第一个回合的值，
  // 回调里读到的则是调用时那个回合的值。
  private buildOptions(
    sdk: ClaudeSdk,
    context: RuntimeTurnContext,
    abort: AbortController,
    current: () => Promise<PendingTurn | null>,
    sessionKey: string,
    inboxSocket: string | null = null,
  ): Record<string, unknown> {
    const originalBashInputs: OriginalBashInputs = new Map()
    const reservedGoalTools = new Set<string>()
    // 会话所选型号的供应商：没填密钥、供应商被删了在这里报错，回合失败，绝不退回账号
    const launch = contextLaunch(context.provider, context.model)
    const childEnv = launch.env
    // 开着线程号开关时要给的 ANTHROPIC_CUSTOM_HEADERS：以 CLI 本来会用的那份为底（设置的 env 里配了的优先，
    // 没配用进程环境），下面同时放进进程环境和入口传的设置的 env。CLI 起来后会拿设置里的 env 盖进程环境，
    // 入口传的这一层优先于用户、项目的设置，才不会被它们盖掉。关着时是空对象，两处都不碰
    const threadHeader = claudeThreadIdHeaderEnv(
      {
        ANTHROPIC_CUSTOM_HEADERS:
          // 托管模式下 CLI 不认设置文件里的请求头，只认进程环境（供应商定义里的头已经在里面）
          (launch.managed
            ? undefined
            : settingsEnvValue(context.cwd, 'ANTHROPIC_CUSTOM_HEADERS')) ??
          childEnv.ANTHROPIC_CUSTOM_HEADERS,
      },
      context.sessionThreadId ?? context.threadId,
    )
    const inbox = claudeCrossSessionInbox()
    const opts: Record<string, unknown> = {
      abortController: abort,
      pathToClaudeCodeExecutable: hostClaudeExecutable(),
      includePartialMessages: true,
      includeHookEvents: true,
      // 子代理的正文与思考也带父工具调用 ID 转发，用于投影到子线程。
      forwardSubagentText: true,
      cwd: context.cwd,
      settingSources: claudeSettingSources(),
      // 失败后由持久化状态对账；禁止 CLI 自行重放可能已接收的模型请求。
      env: {
        ...childEnv,
        ...claudeBashTimeoutEnv(childEnv),
        ...hostClaudeSessionEnv(inbox),
        // 收件箱里的登记名：别的会话 ListAgents 看到、SendMessage 发往的就是它。没有名字时 CLI 按目录自己起
        ...(inbox && context.sessionName ? { CLAUDE_CODE_SESSION_NAME: context.sessionName } : {}),
        ...sdkMcpStartupEnvironment(context.mcpServers),
        CLAUDE_CODE_MAX_RETRIES: '0',
        CLAUDE_CODE_DISABLE_NONSTREAMING_FALLBACK: '1',
        // 清单只映射 TodoWrite：新模型默认不提供清单工具，旧模型默认提供未映射的 Task*。
        CLAUDE_CODE_ENABLE_TODO_TOOLS: '1',
        CLAUDE_CODE_ENABLE_TASKS: '0',
        // 让 CLI 上报会话状态，用 idle 判断后台子代理与续跑是否全部结束。
        CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS: '1',
        // 命令里调 litch-machine 时按它认会话。CLI 一个会话一个进程，Bash 工具继承它；
        // 追问子代理的回合跑在父线程的会话上，给的是父线程
        LITCH_THREAD_ID: context.sessionThreadId ?? context.threadId,
        ...threadHeader,
        // CHA_CLAUDE_SESSION_TITLE=off：CLI 不自己用小模型起标题（入口这边也不请它起，见 server.mts）
        ...(claudeSessionTitle() ? {} : { CLAUDE_CODE_DISABLE_TERMINAL_TITLE: '1' }),
      },
      ...runtimePermissionOptions(context, originalBashInputs),
      settings: {
        // 放 CLI 自己的默认位置时给空串：这一层优先于用户、项目的设置，盖掉那里配的 plansDirectory，
        // CLI 见到空值就用默认位置，和豁免的目录对得上（给项目外的目录 CLI 会报错再退回默认位置）
        plansDirectory:
          claudePlansLocation() === 'workspace'
            ? relative(context.cwd, planDirectory(context))
            : '',
        // Skill 的内联 shell 不经过 Bash hook；受限会话只能通过常规工具执行命令。
        ...(needsStrictSkillShell(context) ? { disableSkillShellExecution: true } : {}),
        ...(context.skillOverrides ? { skillOverrides: context.skillOverrides } : {}),
        ...(context.disableBundledSkills ? { disableBundledSkills: true } : {}),
        ...(threadHeader.ANTHROPIC_CUSTOM_HEADERS ? { env: threadHeader } : {}),
        // 别的会话发来的消息一律直接投递：不设时 CLI 按权限档位扣住不一致的，SDK 起的会话批不了，过期就丢了
        ...(inbox ? { crossSessionInbound: 'accept' } : {}),
      },
      // 收件箱开着时让 CLI 回显进模型的用户消息（照 Claude 桌面端）：别的会话发来的那条带 origin.kind=peer，
      // 认出来画进对话（handlePeerReplay）；自己发的、后台通知的回显丢掉。
      // 收件箱用会话的固定地址（peer-inbox-socket.mts）：换了进程，别处记下的地址照样发得到
      ...(inbox
        ? {
            extraArgs: {
              'replay-user-messages': null,
              ...(inboxSocket ? { 'messaging-socket-path': inboxSocket } : {}),
            },
          }
        : {}),
      disallowedTools: ['CronCreate', 'CronDelete', 'CronList', 'ScheduleWakeup'],
      stderr: (data: string) => process.stderr.write(data),
      onElicitation: (async (request, { signal }) => {
        const pending = await current()
        if (signal.aborted || !pending?.handlers.onElicitationRequest) return { action: 'cancel' }
        try {
          return await pending.handlers.onElicitationRequest(request, signal)
        } catch (error) {
          if (signal.aborted || abort.signal.aborted) return { action: 'cancel' }
          throw error
        }
      }) satisfies OnElicitation,
      ...(process.env.CHA_CLAUDE_SDK_DEBUG === '1' ? { debug: true } : {}),
    }
    if (context.model) opts.model = context.model
    if (context.effort) opts.effort = context.effort
    const resume = sdkResumeSessionId(context.claudeSessionId, context.cwd)
    if (resume) opts.resume = resume
    if (resume && context.forkSession) opts.forkSession = true

    if (context.addDirs && context.addDirs.length > 0) opts.additionalDirectories = context.addDirs
    if (context.allowedTools && context.allowedTools.length > 0)
      opts.allowedTools = context.allowedTools
    if (context.outputFormat) opts.outputFormat = cliOutputFormat(context.outputFormat)

    // 完全访问由回调授权，支持 root 部署且保留计划确认和用户提问。
    const mode = derivePermissionMode(context.planMode)
    opts.permissionMode = mode
    const permissionHooks = opts.hooks as { PreToolUse: Array<{ hooks: unknown[] }> }
    // 工具执行之前先把这次调用记进入口自己的库（server.mts 的 onNativeToolCall），记上了才放行。
    // CLI 的会话记录是攒一阵（约 100 毫秒）才写一批的，入口崩溃、CLI 被强杀时这次调用可能还没进记录，
    // 恢复的会话里模型就不知道它发出过；入口凭这份意图在下一回合告诉模型（native-tool-intents.mts）。
    // 不等 CLI 把这一行写进会话记录（那样每次工具调用都要多等约 100 毫秒），只在新会话的记录文件还没有时等它出现。
    permissionHooks.PreToolUse.push({
      hooks: [
        async (event: Record<string, unknown>, toolUseId: string) => {
          try {
            abort.signal.throwIfAborted()
            const transcriptPath = event.transcript_path
            if (typeof transcriptPath !== 'string' || !transcriptPath.endsWith('.jsonl'))
              throw new Error('钩子事件里没有会话记录的路径')
            // 新会话的记录文件还没写出来时等它出现，不然崩了连会话都恢复不了（native-tool-intents.mts）
            await waitForTranscript(transcriptPath, abort.signal)
            const pending = await current()
            if (!pending) throw new Error('没有接着这一轮的回合')
            pending.handlers.onNativeToolCall?.({
              callId: toolUseId,
              tool: String(event.tool_name),
              input: event.tool_input ?? {},
              sessionKey,
              transcriptPath,
              agentId: typeof event.agent_id === 'string' ? event.agent_id : null,
            })
            if (context.trackGoalTools && !isGoalTool(String(event.tool_name))) {
              pending.handlers.onNativeToolIntent?.(
                toolUseId,
                String(event.tool_name),
                (event.tool_input ?? {}) as Record<string, unknown>,
              )
              reservedGoalTools.add(toolUseId)
            }
            return {}
          } catch (error) {
            // Hook 抛错只会被 CLI 记录，必须显式 deny 才能阻止工具。
            if (!abort.signal.aborted)
              debugLog('native.toolIntent.unrecorded', {
                toolUseId,
                tool: String(event.tool_name),
                error: String(error),
              })
            return {
              hookSpecificOutput: {
                hookEventName: 'PreToolUse',
                permissionDecision: 'deny',
                permissionDecisionReason: '原生工具意图未能记下或回合已取消，禁止执行。',
              },
            }
          }
        },
      ],
    })

    // 发给本机没在跑的 Litch 会话：先把对方拉起来（wakePeer）。追问回合的 SendMessage 发给子代理，不走这里
    if (claudeCrossSessionInbox())
      permissionHooks.PreToolUse.push({
        hooks: [
          async (event: Record<string, unknown>) => {
            const input = (event.tool_input ?? {}) as Record<string, unknown>
            // 记下自己起的有名字的子代理：发给它们的 SendMessage 不是发给别的会话
            if (isSubagentTool(String(event.tool_name)) && typeof input.name === 'string') {
              const names = this.agentNames.get(sessionKey) ?? new Set<string>()
              names.add(input.name.trim())
              this.agentNames.set(sessionKey, names)
            }
            if (event.tool_name !== 'SendMessage' || context.subagentRelay) return {}
            if (typeof input.to === 'string') await this.wakePeer(sessionKey, input.to.trim())
            return {}
          },
        ],
      })

    // 追问回合可能跑在已经存活的进程上，所以这个钩子始终注册，调用时再看是不是追问回合。
    permissionHooks.PreToolUse.push({
      hooks: [
        async (event: Record<string, unknown>) => {
          const relay = context.subagentRelay
          // 被恢复的子代理自己的工具调用照常走权限流程。
          if (!relay || typeof event.agent_id === 'string') return {}
          if (event.tool_name !== 'SendMessage')
            return {
              hookSpecificOutput: {
                hookEventName: 'PreToolUse',
                permissionDecision: 'deny',
                permissionDecisionReason:
                  '本回合只负责把用户的话转给子代理：请调用 SendMessage，不要调用其他工具。',
              },
            }
          // 收件人与正文由适配器写定，模型的转述不会改动用户原文。
          return {
            hookSpecificOutput: {
              hookEventName: 'PreToolUse',
              permissionDecision: 'allow',
              updatedInput: { to: relay.agentId, message: relay.message },
            },
          }
        },
      ],
    })

    if (parseWorkflowCommand(context.prompt)?.type === 'run') {
      opts.settings = {
        ...((opts.settings as Record<string, unknown> | undefined) ?? {}),
        enableWorkflows: true,
        workflowKeywordTriggerEnabled: true,
      }
    }

    opts.canUseTool = this.makeCanUseTool(context, originalBashInputs, current)
    const hooks = opts.hooks as Record<string, unknown>
    hooks.PostToolUse = [
      {
        matcher: 'EnterPlanMode|ExitPlanMode|Write|Edit',
        hooks: [
          async (event: Record<string, unknown>) => {
            const pending = await current()
            if (!pending || pending.abort.signal.aborted || event.agent_id) return {}
            const input = (event.tool_input ?? {}) as Record<string, unknown>
            if (isPlanFile(context, String(event.tool_name), input)) {
              await pending.handlers.onEvent({
                type: 'plan_text',
                text: readFileSync(String(input.file_path), 'utf8'),
              })
              return {}
            }
            if (event.tool_name !== 'EnterPlanMode' && event.tool_name !== 'ExitPlanMode') return {}
            const enabled = event.tool_name === 'EnterPlanMode'
            await pending.query.setPermissionMode(derivePermissionMode(enabled))
            context.planMode = enabled
            if (pending.session) pending.session.applied.planMode = enabled
            await pending.handlers.onEvent({ type: 'plan_mode', enabled })
            return {}
          },
        ],
      },
    ]
    const confirmNativeTool =
      (failed: boolean) => async (event: Record<string, unknown>, callId: string) => {
        const pending = await current()
        if (pending && reservedGoalTools.delete(callId) && !isGoalTool(String(event.tool_name)))
          pending.handlers.onNativeToolResult?.(callId, { confirmed: true, failed })
        return {}
      }
    ;(hooks.PostToolUse as unknown[]).push({ hooks: [confirmNativeTool(false)] })
    hooks.PostToolUseFailure = [{ hooks: [confirmNativeTool(true)] }]

    // Project + developer + personality instructions ride along as a system
    // prompt append, preserving Claude Code's built-in preset.
    // Re-render on resume so settings changes (including clearing an append)
    // take effect on the next turn instead of waiting for SDK compaction.
    opts.systemPrompt = {
      type: 'preset',
      preset: 'claude_code',
      snapshot: false,
      ...(context.systemPromptAddendum?.trim()
        ? { append: context.systemPromptAddendum.trim() }
        : {}),
    }

    // 账号：命令行设置层把用户设置里的凭据、地址、云厂商开关、apiKeyHelper 置空，压过它们
    opts.settings = withFlagSettings(opts.settings as Record<string, unknown>, launch)
    void sdk // keep parameter referenced for future SDK-version-gated options
    return opts
  }

  private makeCanUseTool(
    context: RuntimeTurnContext,
    originalBashInputs: OriginalBashInputs,
    current: () => Promise<PendingTurn | null>,
  ) {
    return async (
      toolName: string,
      input: Record<string, unknown>,
      options: {
        toolUseID?: string
        signal: AbortSignal
        agentID?: string
        matchedAskRule?: unknown
      },
    ): Promise<
      | { behavior: 'allow'; updatedInput?: unknown }
      | { behavior: 'deny'; message: string; interrupt?: boolean }
    > => {
      const toolUseId = options.toolUseID || `tool-${newId()}`
      const pending = await current()
      if (!pending) return { behavior: 'deny', message: 'turn already finished' }
      // 即使完全访问也保留提问与计划确认；只对明确的完全访问组合自动授权。
      const autoAllow =
        context.approvalPolicy === 'never' && context.sandboxMode === 'danger-full-access'
      if (context.permissionTools && toolName === permissionToolName)
        return options.agentID
          ? { behavior: 'deny', message: '子代理不能申请父会话权限' }
          : { behavior: 'allow', updatedInput: input }
      if (context.goalTools && isGoalTool(toolName))
        return options.agentID
          ? { behavior: 'deny', message: '子代理不能修改父会话目标' }
          : { behavior: 'allow', updatedInput: input }
      // 动态工具一律不在这里问：执行方是客户端，要不要问用户由它定，
      // 和原生 codex 对动态工具的做法一样
      if (dynamicToolCliNames(context.dynamicTools).has(toolName))
        return { behavior: 'allow', updatedInput: input }

      // 用 SDK 正式的 updatedInput 返回答案，不能伪装成工具拒绝。
      if (toolName === 'AskUserQuestion') {
        try {
          const requestId = `${context.threadId}:${context.turnId}:askq:${toolUseId}`
          const questions = parseAskUserQuestions(input)
          if (questions.length === 0) {
            return { behavior: 'deny', message: 'no questions provided' }
          }
          if (typeof pending.handlers.onUserInputRequest !== 'function') {
            return { behavior: 'deny', message: 'user input not available in this runtime' }
          }
          const answers = await pending.handlers.onUserInputRequest({
            type: 'user_input_request',
            requestId,
            toolUseId,
            questions,
          })
          if (options.signal.aborted) return { behavior: 'deny', message: '提问已取消' }
          return {
            behavior: 'allow',
            updatedInput: askUserQuestionUpdatedInput(input, questions, answers),
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          return { behavior: 'deny', message: `AskUserQuestion failed: ${msg}` }
        }
      }

      if (options.agentID && (toolName === 'EnterPlanMode' || toolName === 'ExitPlanMode'))
        return { behavior: 'deny', message: '子代理不能修改父会话的计划模式' }
      if (toolName === 'EnterPlanMode') return { behavior: 'allow', updatedInput: input }
      if (toolName === 'ExitPlanMode') {
        // 发起回合的连接没声明 planConfirmation（官方桌面端、移动端）：它们在回合结束后自己问，
        // 入口不再问一次。不放行这次调用（放行就退出计划模式接着执行了），并让 CLI 就此停下，
        // 回合带着计划正常结束；要执行时客户端会发一个切回默认模式的新回合。
        // 带输出格式的回合不这么做：停下来就没有结构化结果了，照旧在回合里问。
        if (!context.planConfirmation && !context.outputFormat) {
          await pending.handlers.onEvent({
            type: 'plan_handoff',
            plan: typeof input.plan === 'string' && input.plan.trim() ? input.plan : null,
          })
          pending.planHandoff = true
          // interrupt 时 CLI 给模型的是它自己的那句“用户没让继续，停下等用户”，这里的话只进日志
          return { behavior: 'deny', message: PLAN_HANDED_OFF, interrupt: true }
        }
        // 先把交来的计划记下（这个回合还没有计划条目时由它补一个），再问
        await pending.handlers.onEvent({
          type: 'plan_handoff',
          plan: typeof input.plan === 'string' && input.plan.trim() ? input.plan : null,
        })
        const answers = await pending.handlers.onUserInputRequest?.({
          type: 'user_input_request',
          toolName: 'ExitPlanMode',
          requestId: `${context.turnId}:exit-plan:${toolUseId}`,
          toolUseId,
          questions: [planExitQuestion()],
        })
        if (options.signal.aborted) return { behavior: 'deny', message: PLAN_NOT_CONFIRMED }
        // 不是普通提问：答案是放不放行的决定。没放行时，用户自己写的话随拒绝一起交给模型；
        // 放行时带着的补充并进计划一起交回，CLI 会把改过的计划回给模型。
        const verdict = planExitVerdict(answers?.answers[PLAN_EXIT_QUESTION_ID])
        if (!verdict.execute) return { behavior: 'deny', message: verdict.message }
        if (verdict.note)
          return {
            behavior: 'allow',
            updatedInput: { ...input, plan: planWithNote(input.plan, verdict.note) },
          }
        return { behavior: 'allow', updatedInput: input }
      }
      if (isPlanFile(context, toolName, input)) return { behavior: 'allow', updatedInput: input }
      // 读文件照 codex 不走审批（哪种审批策略、计划模式都一样）：按可读范围直接判定，自定义档位里
      // 禁读的拒绝（大小写、链接按真实路径，见 deniedTool），其余放行；内置档位整个磁盘可读。
      // CLI 只在读工作目录外的文件时才来问，不在这里定就会变成审批，never 下直接被拒
      if (isFileReadTool(toolName)) {
        const reason = deniedTool(context, toolName, input)
        return reason
          ? { behavior: 'deny', message: reason }
          : { behavior: 'allow', updatedInput: input }
      }
      if (
        toolName === 'Bash' &&
        originalBashInputs.has(toolUseId) &&
        context.approvalPolicy !== 'untrusted' &&
        (context.planMode || context.sandboxMode === 'read-only')
      )
        return { behavior: 'allow', updatedInput: input }
      if (context.planMode && !(toolName === 'Bash' && originalBashInputs.has(toolUseId)))
        return { behavior: 'deny', message: '计划模式不能执行副作用' }
      if (autoAllow) return { behavior: 'allow', updatedInput: input }
      // never 只表示不发起审批：适配器已按授权目录把关的文件编辑，以及已套 OS 沙箱的 Bash
      // 直接执行；越界或其他工具仍拒绝，不因不审批而扩大权限。
      if (
        context.approvalPolicy === 'never' &&
        (isFileEditTool(toolName) || (toolName === 'Bash' && originalBashInputs.has(toolUseId)))
      ) {
        const reason = deniedTool(context, toolName, input)
        return reason
          ? { behavior: 'deny', message: reason }
          : { behavior: 'allow', updatedInput: input }
      }
      if (
        !allowsApproval(
          context.approvalPolicy,
          options.matchedAskRule ? 'rules' : toolApprovalFlow(toolName),
        )
      )
        return { behavior: 'deny', message: '当前审批策略禁止发起此类权限请求' }

      const requestId = `${context.threadId}:${context.turnId}:${toolName}:${toolUseId}`
      // Subagent-aware approval suppression: when Claude is mid-subagent we
      // still want THIS tool to be approved by the user (otherwise nested
      // tools would silently bypass approval). The server-side already
      // routes everything through onPermissionRequest; nothing to change here.
      const decision = await new Promise<PermissionDecision>((resolve) => {
        const cancelled = () => finish({ decision: 'cancel' })
        const finish = (value: PermissionDecision) => {
          this.permissions.delete(requestId)
          options.signal.removeEventListener('abort', cancelled)
          resolve(value)
        }
        this.permissions.set(requestId, { resolve: finish })
        if (options.signal.aborted) {
          cancelled()
          return
        }
        options.signal.addEventListener('abort', cancelled, { once: true })
        void Promise.resolve()
          .then(() =>
            pending.handlers.onPermissionRequest({
              type: 'permission_request',
              requestId,
              toolUseId,
              toolName,
              input: originalBashInputs.get(toolUseId) ?? input,
            }),
          )
          .then(finish, () => finish({ decision: 'decline' }))
      })

      if (decision.decision === 'accept' || decision.decision === 'acceptForSession') {
        if (decision.updatedInput) {
          const updated = decision.updatedInput as Record<string, unknown>
          const reason = deniedTool(context, toolName, updated)
          if (reason) return { behavior: 'deny', message: reason }
          return {
            behavior: 'allow',
            updatedInput: toolName === 'Bash' ? sandboxedBashInput(context, updated) : updated,
          }
        }
        return { behavior: 'allow', updatedInput: decision.updatedInput ?? input }
      }
      return {
        behavior: 'deny',
        // 用户拒绝时附了说明的话带在这里：这句话进工具结果，模型看得到。
        message: deniedMessage(decision),
        interrupt: decision.decision === 'cancel',
      }
    }
  }

  private async consume(session: NativeSession): Promise<void> {
    try {
      for await (const message of session.query as AsyncIterable<Record<string, unknown>>) {
        this.observe(session, message)
        if (session.discard) {
          // 被放弃的那一轮：丢到它的 result 为止。这期间可能已有新回合接上，
          // 那一轮被中止的 result 不能算到新回合头上。
          if (message.type === 'result') session.discard = false
          continue
        }
        let pending = session.turn
        if (!pending) {
          // 没有回合时到来的内容：要么是 CLI 自己开的一轮，要么可以忽略。
          if (!startsRound(message)) continue
          pending = await this.currentTurn(session)
          if (!pending) continue
        }
        // 回显的用户消息（收件箱开着时才有）：别的会话发来的画进对话，别的丢掉；都不当原生边界
        if (message.type === 'user' && message.isReplay === true) {
          const peer = peerMessageOf(message)
          if (peer) await pending.handlers.onEvent({ type: 'peer_message', ...peer })
          continue
        }
        if (
          (message.type === 'assistant' || message.type === 'user') &&
          !message.parent_tool_use_id &&
          typeof message.uuid === 'string'
        ) {
          await pending.handlers.onEvent({ type: 'native_boundary', messageId: message.uuid })
        }
        await this.handleMessage(pending, message)
        // 回合结束而进程不保留时，消息循环到此为止；保留则继续服务后面的回合。
        if (pending.resolved && session.closing) break
      }
      // 迭代器结束即进程已经或即将退出。先标记，再结清挂着的回合。
      session.closing = true
      const pending = session.turn
      if (!pending || pending.resolved) return
      if (pending.deferredResult) {
        // The SDK iterator is the authoritative lifetime of a turn. If it
        // closes while a workflow journal still has an unresolved task, there
        // will be no later task_notification to unblock the deferred result.
        // Close those projected agents as failed and finish the parent turn
        // rather than leaving Codex cc's spinner alive forever.
        if (this.hasPendingWorkflowTasks(pending)) await this.stopWorkflowTasks(pending)
        await this.finishDeferredResult(pending, true)
        if (!pending.resolved) return
      }
      // The async iterator finished without a 'result' message — treat as
      // successful empty turn (claude-agent-sdk does occasionally end without
      // a SDKResultMessage when interrupted cleanly).
      if (!pending.resolved) {
        await this.stopWorkflowTasks(pending)
        this.detach(pending)
        try {
          await pending.handlers.onEvent({
            type: 'completed',
            success: false,
            result: 'SDK 未返回终态，执行结果不确定，请读取历史对账',
          })
          pending.resolve()
        } catch (err) {
          pending.reject(err instanceof Error ? err : new Error(String(err)))
        }
      }
    } catch (err) {
      session.closing = true
      const pending = session.turn
      if (!pending || pending.resolved) {
        debugLog('native.session.failed', { threadId: session.key, error: String(err) })
        return
      }
      this.detach(pending)
      const error = err instanceof Error ? err : new Error(String(err))
      try {
        await this.stopWorkflowTasks(pending)
        await pending.handlers.onEvent({ type: 'error', message: error.message })
      } catch {}
      pending.reject(error)
    }
  }

  // 把回合从进程上摘下来；进程是否留下由调用方决定。
  private detach(pending: PendingTurn): void {
    pending.resolved = true
    this.turns.delete(pending.context.turnId)
    if (pending.session?.turn === pending) pending.session.turn = null
  }

  // 属于进程而不属于某个回合的状态：后台任务、会话状态、会话 ID。没有回合时也要跟。
  private observe(session: NativeSession, message: Record<string, unknown>): void {
    if (
      session.notificationAt != null &&
      isMainToolResult(message) &&
      notificationFolded(session.notificationAt, Date.now())
    )
      session.notificationAt = null
    if (message.type !== 'system') return
    const subtype = String(message.subtype ?? '')
    if (
      subtype === 'session_state_changed' ||
      subtype === 'background_tasks_changed' ||
      subtype === 'command_lifecycle' ||
      subtype.startsWith('task_')
    )
      debugLog('native.sdk.system', {
        threadId: session.key,
        turnId: session.turn?.context.turnId ?? null,
        subtype,
        state: message.state,
        taskId: message.task_id,
        taskType: message.task_type,
        status: message.status,
      })
    if (subtype === 'init') {
      if (typeof message.session_id === 'string' && message.session_id)
        session.sessionId = message.session_id
      // 哪些工具在真实环境里可用（如 Monitor）只有这里看得到。
      debugLog('native.sdk.init', { threadId: session.key, tools: message.tools })
      // 新的一轮开始了：之前的结束通知由这一轮处理。
      session.notificationAt = null
      this.clearTimer(session, 'notificationTimer')
      return
    }
    if (subtype === 'session_state_changed') {
      const state = message.state
      if (state !== 'idle' && state !== 'running' && state !== 'requires_action') return
      session.state = state
      if (state === 'idle') session.discard = false
      return
    }
    if (
      subtype === 'background_tasks_changed' ||
      subtype === 'task_started' ||
      subtype === 'task_updated' ||
      subtype === 'task_notification'
    )
      try {
        this.sessionHandlers?.onBackgroundTaskMessage?.(session.key, message)
      } catch (error) {
        debugLog('native.session.backgroundTaskHandlerFailed', {
          threadId: session.key,
          error: String(error),
        })
      }
    if (subtype === 'background_tasks_changed' && Array.isArray(message.tasks)) {
      const state = session.shells
      const live = new Map<string, number>()
      const monitors: NativeSession['monitors'] = new Map()
      for (const task of message.tasks as Array<Record<string, unknown>>) {
        if (typeof task.task_id !== 'string' || !task.task_id) continue
        session.backgroundTasks.add(task.task_id)
        if (String(task.task_type ?? '').startsWith('monitor_') && task.ambient !== true)
          monitors.set(task.task_id, {
            description: typeof task.description === 'string' ? task.description : '',
            seq: session.monitors.get(task.task_id)?.seq ?? state.nextSeq++,
          })
        if (task.task_type !== 'local_bash' || task.ambient === true) continue
        let seq = state.seqByTask.get(task.task_id)
        if (seq == null) {
          seq = state.nextSeq++
          state.seqByTask.set(task.task_id, seq)
        }
        live.set(task.task_id, seq)
      }
      state.live = live
      session.monitors = monitors
      session.process.trackBackgroundProcesses()
      if (!hasBackgroundWork(session) && !session.turn) this.scheduleReap(session)
      return
    }
    if (
      subtype === 'task_started' &&
      message.task_type === 'local_bash' &&
      typeof message.task_id === 'string' &&
      typeof message.tool_use_id === 'string'
    ) {
      session.shells.taskToolUse.set(message.task_id, message.tool_use_id)
      session.process.trackBackgroundProcesses()
      return
    }
    if (subtype !== 'task_notification' || typeof message.task_id !== 'string') return
    if (!session.backgroundTasks.delete(message.task_id)) return
    const stopped = message.status === 'killed' || message.status === 'stopped'
    // 任务自己结束后 CLI 会再跑一轮把结果告诉模型；被停掉的不会。
    if (!stopped) session.notificationAt = Date.now()
    if (!session.shells.seqByTask.has(message.task_id)) return
    const toolUseId = session.shells.taskToolUse.get(message.task_id) ?? null
    try {
      this.sessionHandlers?.onBackgroundCommandEnded(
        session.key,
        backgroundCommandEnd(message, toolUseId),
      )
    } catch (error) {
      debugLog('native.session.commandEndedHandlerFailed', {
        threadId: session.key,
        error: String(error),
      })
    }
  }

  private async handleMessage(
    pending: PendingTurn,
    message: Record<string, unknown>,
  ): Promise<void> {
    const type = String(message.type ?? '')
    switch (type) {
      case 'system':
        await this.handleSystem(pending, message)
        break
      case 'stream_event':
        await this.handleStreamEvent(pending, message)
        break
      case 'assistant':
        if (typeof message.error === 'string' && message.parent_tool_use_id == null)
          pending.apiErrorCategory = message.error
        await this.handleAssistant(pending, message)
        break
      case 'user':
        await this.handleUser(pending, message)
        break
      case 'result':
        await this.handleResult(pending, message)
        break
      default:
        // Hook events, rate-limit notifications, etc. Many of them surface as
        // their own SDKMessage variants in recent SDK builds. Convert to a
        // generic notice + (for hook events) a structured hook event so the
        // server can render a hookPrompt timeline item.
        await this.handleOther(pending, type, message)
    }
  }

  private async handleSystem(
    pending: PendingTurn,
    message: Record<string, unknown>,
  ): Promise<void> {
    const subtype = String(message.subtype ?? '')
    if (subtype === 'background_tasks_changed') return
    if (subtype === 'command_lifecycle') {
      // 用户消息对应的那一轮跑完了；有些命令（如压缩）的 result 不带消息 ID。
      if (message.state === 'completed' && message.command_uuid === pending.awaited)
        pending.awaitedSeen = true
      return
    }
    if (subtype === 'session_state_changed') {
      if (message.state === 'idle') await this.finishDeferredResult(pending)
      return
    }
    // 主模型用 SendMessage 续跑已结束的子代理：CLI 以同一个代理 ID 再起一个 local_agent 任务，
    // tool_use_id 是那次 SendMessage；跑的过程照旧是挂在当初 Agent 调用下面的子代理消息，结束时发 task_notification
    if (
      subtype === 'task_started' &&
      message.task_type === 'local_agent' &&
      typeof message.task_id === 'string' &&
      typeof message.tool_use_id === 'string' &&
      pending.sendMessages?.has(message.tool_use_id)
    ) {
      ;(pending.resumedAgents ??= new Map()).set(message.task_id, message.tool_use_id)
      await pending.handlers.onEvent({
        type: 'subagent_resumed',
        toolUseId: message.tool_use_id,
        agentId: message.task_id,
        message: pending.sendMessages?.get(message.tool_use_id) ?? '',
      })
      return
    }
    if (subtype === 'task_progress') {
      await pending.handlers.onEvent({
        type: 'subagent_activity',
        ...(typeof message.task_id === 'string' ? { taskId: message.task_id } : {}),
        ...(typeof message.tool_use_id === 'string' ? { agentToolUseId: message.tool_use_id } : {}),
      })
      return
    }
    if (
      subtype === 'task_started' &&
      message.task_type === 'local_agent' &&
      typeof message.task_id === 'string' &&
      typeof message.tool_use_id === 'string'
    ) {
      await pending.handlers.onEvent({
        type: 'subagent_task',
        toolUseId: message.tool_use_id,
        taskId: message.task_id,
      })
      // 不 return：后台任务的集合也要看这条
    }
    if (
      subtype === 'task_notification' &&
      typeof message.task_id === 'string' &&
      typeof message.tool_use_id === 'string' &&
      pending.resumedAgents?.get(message.task_id) === message.tool_use_id
    ) {
      pending.resumedAgents?.delete(message.task_id)
      await pending.handlers.onEvent({
        type: 'subagent_resume_finished',
        toolUseId: String(message.tool_use_id),
        agentId: message.task_id,
        status:
          message.status === 'completed'
            ? 'completed'
            : message.status === 'killed' || message.status === 'stopped'
              ? 'interrupted'
              : 'failed',
        summary: String(message.summary ?? '').trim(),
      })
      return
    }
    if (subtype === 'task_notification' && typeof message.task_id === 'string') {
      const agentToolUseId = pending.backgroundAgents?.get(message.task_id)
      if (agentToolUseId) {
        pending.backgroundAgents?.delete(message.task_id)
        await this.finishBackgroundAgent(pending, agentToolUseId, message)
        return
      }
    }
    if (subtype === 'hook_started' || subtype === 'hook_progress' || subtype === 'hook_response') {
      if (typeof message.hook_id !== 'string' || !message.hook_id) return
      await pending.handlers.onEvent({
        type: 'hook',
        hookRunId: message.hook_id,
        messageId: String(message.uuid ?? ''),
        phase:
          subtype === 'hook_started'
            ? 'started'
            : subtype === 'hook_progress'
              ? 'progress'
              : 'response',
        hookName: String(message.hook_name ?? ''),
        hookEvent: String(message.hook_event ?? ''),
        outcome:
          message.outcome === 'success' ||
          message.outcome === 'error' ||
          message.outcome === 'cancelled'
            ? message.outcome
            : null,
        exitCode: typeof message.exit_code === 'number' ? message.exit_code : null,
        stdout: String(message.stdout ?? ''),
        stderr: String(message.stderr ?? ''),
        output: String(message.output ?? ''),
      })
      return
    }
    // 开始压缩：status 是 compacting。压完时（成没成都是）、权限模式变了时也发 status，那几条不用：压成了另有 compact_boundary
    if (subtype === 'status') {
      if (message.status === 'compacting') await pending.handlers.onEvent({ type: 'compacting' })
      return
    }
    if (subtype === 'compact_boundary') {
      const meta = message.compact_metadata as Record<string, unknown> | undefined
      await pending.handlers.onEvent({
        type: 'context_compacted',
        messageId: String(message.uuid ?? ''),
        postTokens: typeof meta?.post_tokens === 'number' ? meta.post_tokens : null,
      })
      return
    }
    if (subtype === 'init') {
      const sessionId = String(message.session_id ?? '')
      if (sessionId) await pending.handlers.onEvent({ type: 'session', claudeSessionId: sessionId })
      if (Array.isArray(message.mcp_servers))
        await pending.handlers.onEvent({
          type: 'mcp_servers',
          names: message.mcp_servers.flatMap((server: { name?: unknown }) =>
            typeof server?.name === 'string' ? [server.name] : [],
          ),
        })
      return
    }
    if (subtype === 'permission_denied') {
      // The SDK auto-denied a tool call (auto-mode classifier, deny rule, etc).
      // Surface as a notice so the user sees why nothing happened.
      const toolName = String((message as Record<string, unknown>).tool_name ?? 'tool')
      await pending.handlers.onEvent({
        type: 'notice',
        level: 'warning',
        message: `Permission denied for ${toolName}`,
      })
      return
    }
    if (subtype === 'task_started' && isWorkflowBackgroundTask(message)) {
      const taskId = String(message.task_id ?? '')
      if (!taskId) return
      const sourceToolUseId = String(message.tool_use_id ?? '')
      if (message.skip_transcript === true) {
        const skipped =
          pending.skippedWorkflowTaskIds ?? (pending.skippedWorkflowTaskIds = new Set())
        skipped.add(taskId)
        this.discardDeferredWorkflowLaunches(pending, taskId, sourceToolUseId)
        const hiddenState = pending.workflowTasks?.get(taskId)
        if (hiddenState) {
          hiddenState.terminal = true
          await hiddenState.monitor?.stop()
          await this.closeWorkflowAgentLifecycles(
            pending,
            hiddenState,
            'Workflow transcript was hidden before the agent completed.',
            false,
          )
          await this.closeWorkflowAggregateLifecycle(
            pending,
            hiddenState,
            'Workflow transcript was hidden.',
            false,
          )
        }
        await this.finishDeferredResult(pending)
        return
      }
      const toolUseId = workflowTaskToolUseId(taskId)
      if (pending.completedWorkflowTasks.has(toolUseId)) return
      const state = this.ensureWorkflowTask(pending, taskId)
      if (sourceToolUseId && !state.toolUseId) state.toolUseId = sourceToolUseId
      state.workflowName = String(message.workflow_name ?? '').trim() || state.workflowName
      state.description = String(message.description ?? '').trim() || state.description
      state.prompt =
        String(message.prompt ?? '').trim() ||
        state.prompt ||
        state.description ||
        state.workflowName
      this.attachDeferredWorkflowJournal(pending, state, sourceToolUseId)
      return
    }
    if (subtype === 'task_notification') {
      const taskId = String(message.task_id ?? '')
      if (!taskId) return
      const knownState = pending.workflowTasks?.get(taskId)
      const hasWorkflowHint =
        isWorkflowBackgroundTask(message) || String(message.workflow_name ?? '').trim().length > 0
      const sourceToolUseId = String(message.tool_use_id ?? '')
      const hasPendingWorkflowLaunch = [...(pending.workflowLaunches?.values() ?? [])].some(
        (launch) => launch.taskId === taskId,
      )
      const hasPendingWorkflowTool =
        sourceToolUseId.length > 0 && pending.workflowToolUseIds?.has(sourceToolUseId) === true
      // The SDK's task_notification shape does not require task_type or
      // workflow_name. Once this turn has a matching launch/tool id, the task
      // is already proven to be a Workflow and the terminal notification must
      // not be discarded just because optional hints are absent.
      if (!knownState && !hasWorkflowHint && !hasPendingWorkflowLaunch && !hasPendingWorkflowTool)
        return
      if (pending.skippedWorkflowTaskIds?.has(taskId)) {
        this.discardDeferredWorkflowLaunches(pending, taskId, '')
        const hiddenState = pending.workflowTasks?.get(taskId)
        if (hiddenState) {
          hiddenState.terminal = true
          await hiddenState.monitor?.stop()
          await this.closeWorkflowAgentLifecycles(
            pending,
            hiddenState,
            'Workflow transcript was hidden before the agent completed.',
            false,
          )
          await this.closeWorkflowAggregateLifecycle(
            pending,
            hiddenState,
            'Workflow transcript was hidden.',
            false,
          )
        }
        await this.finishDeferredResult(pending)
        return
      }
      let state = knownState
      if (!state) {
        // Claude can emit task_notification before task_started (especially
        // after a reconnect or when the SDK batches system events). Create the
        // projected state from the notification instead of dropping the only
        // terminal signal and leaving the parent deferred forever.
        state = this.ensureWorkflowTask(pending, taskId)
        if (sourceToolUseId && !state.toolUseId) state.toolUseId = sourceToolUseId
        state.workflowName = String(message.workflow_name ?? '').trim() || state.workflowName
        state.description = String(message.description ?? '').trim() || state.description
        state.prompt =
          String(message.prompt ?? '').trim() ||
          state.prompt ||
          state.description ||
          state.workflowName
        this.attachDeferredWorkflowJournal(pending, state, sourceToolUseId)
      }
      if (message.skip_transcript === true) {
        const skipped =
          pending.skippedWorkflowTaskIds ?? (pending.skippedWorkflowTaskIds = new Set())
        skipped.add(taskId)
        this.discardDeferredWorkflowLaunches(pending, taskId, state.toolUseId)
        state.terminal = true
        await state.monitor?.stop()
        await this.closeWorkflowAgentLifecycles(
          pending,
          state,
          'Workflow transcript was hidden before the agent completed.',
          false,
        )
        await this.closeWorkflowAggregateLifecycle(
          pending,
          state,
          'Workflow transcript was hidden.',
          false,
        )
        await this.finishDeferredResult(pending)
        return
      }
      const toolUseId = workflowTaskToolUseId(taskId)
      if (pending.completedWorkflowTasks.has(toolUseId)) {
        state.terminal = true
        await this.finishDeferredResult(pending)
        return
      }
      const status = String(message.status ?? '')
      const summary = String(message.summary ?? '').trim() || `Workflow ${status || 'finished'}`
      const usage = workflowTaskUsage(message.usage)
      const trailer = usage
        ? `\n<usage>total_tokens: ${usage.totalTokens}\ntool_uses: ${usage.toolUses}\nduration_ms: ${usage.durationMs}</usage>`
        : ''
      const monitor = state.monitor
      let monitorStopped = false
      if (monitor && !state.aggregateStarted && !state.monitorFailed) {
        await settlesWithin(monitor.flush(), WORKFLOW_TERMINAL_FLUSH_TIMEOUT_MS)
        // onError can replace state.monitor while flush() is awaiting I/O.
        // Continue through the aggregate fallback in that case; never
        // dereference the mutable field after an await.
        if (state.monitor === monitor && !state.monitorFailed) {
          await monitor.drain(WORKFLOW_JOURNAL_SETTLE_TIMEOUT_MS)
        }
        if (state.monitor === monitor && !state.monitorFailed) {
          const projectedBeforeStop = this.workflowProjectedAgentIds(pending, state)
          if (monitor.startedCount > 0 || projectedBeforeStop.length > 0) {
            state.terminal = true
          }
          await monitor.stop()
          monitorStopped = true
          const projectedAgentIds = this.workflowProjectedAgentIds(pending, state)
          // A terminal notification owns this monitor even when the journal
          // yielded no agents. Clear the state before the aggregate fallback
          // so a late read or poll cannot keep the parent looking active.
          if (state.monitor === monitor) state.monitor = null
          if (monitor.startedCount > 0 || projectedAgentIds.length > 0) {
            state.terminal = true
            await this.closeWorkflowAgentLifecycles(
              pending,
              state,
              status === 'completed'
                ? `Workflow completed before the individual transcript result became visible.\n${summary}`
                : `Workflow ended before the agent published an individual result.\n${summary}`,
              status !== 'completed',
            )
            pending.completedWorkflowTasks.add(toolUseId)
            await pending.handlers.onEvent({
              type: 'notice',
              level: status === 'completed' ? 'info' : 'warning',
              message: `${state.workflowName || `Workflow ${taskId}`}: ${summary}${trailer}`,
            })
            await this.finishDeferredResult(pending)
            return
          }
        }
      }
      // If monitor failure raced with flush/drain, the error path has already
      // detached the monitor. Stop the snapshot defensively as well; stop is
      // idempotent and this closes the only remaining polling handle.
      if (monitor && !monitorStopped && (state.monitor !== monitor || state.monitorFailed)) {
        await monitor.stop()
      }

      await this.ensureWorkflowAggregateStarted(pending, state)
      if (!pending.activeSubagents.delete(toolUseId)) return
      pending.completedWorkflowTasks.add(toolUseId)
      state.terminal = true
      await pending.handlers.onEvent({
        type: 'tool_result',
        toolUseId,
        content: `${summary}${trailer}`,
        isError: status !== 'completed',
      })
      await this.finishDeferredResult(pending)
    }
  }

  private async handleStreamEvent(
    pending: PendingTurn,
    message: Record<string, unknown>,
  ): Promise<void> {
    const event = message.event as Record<string, unknown> | undefined
    if (!event) return
    const eventType = String(event.type ?? '')
    const source = String(message.parent_tool_use_id ?? '')
    pending.usageMessageIds ??= new Map()
    pending.usageByMessage ??= new Map()
    if (eventType === 'message_start') {
      const inner = event.message as Record<string, unknown> | undefined
      if (typeof inner?.id === 'string') {
        pending.usageMessageIds.set(source, inner.id)
        pending.usageByMessage.set(inner.id, (inner.usage ?? {}) as Record<string, unknown>)
      }
      if (!source && typeof inner?.model === 'string') pending.contextModel = inner.model
      mergeRequestUsage(pending.contextUsage, source, inner?.id, inner?.usage)
    } else if (eventType === 'message_delta') {
      const id = pending.usageMessageIds.get(source)
      if (id) await this.goalUsage(pending, { id, usage: event.usage })
      await this.contextUsage(pending, source, id, event.usage)
    }
    if (
      message.parent_tool_use_id &&
      Date.now() - (pending.subagentStreamAt.get(source) ?? 0) >= 1000
    ) {
      pending.subagentStreamAt.set(source, Date.now())
      await pending.handlers.onEvent({ type: 'subagent_activity', agentToolUseId: source })
    }
    if (message.parent_tool_use_id || pending.activeSubagents.size > 0) return
    if (eventType === 'message_start') {
      const inner = event.message as Record<string, unknown> | undefined
      await this.beginAssistantMessage(pending, stringOrNull(inner?.id), true)
      return
    }
    if (eventType === 'content_block_start') {
      const block = event.content_block as Record<string, unknown> | undefined
      if (block && String(block.type) === 'tool_use') {
        const id = String(block.id ?? '')
        // Skip the start envelope for tool_use — input is empty here and the
        // full block lands later inside the AssistantMessage. Without this
        // we'd emit one orphan inProgress item per tool and a real one.
        if (id) pending.toolStartSeen.add(id)
      }
      return
    }
    if (eventType === 'content_block_delta') {
      const delta = event.delta as Record<string, unknown> | undefined
      if (!delta) return
      const deltaType = String(delta.type ?? '')
      if (deltaType === 'text_delta') {
        const text = String(delta.text ?? '')
        if (!text) return
        this.recordStreamedBlock(pending, event.index, 'text', text)
        // Special-case: StructuredOutput synthetic tool buffers text and emits
        // only the final coerced JSON; suppress raw deltas while it's active.
        if (pending.context.outputFormat) {
          pending.structuredBuffer += text
          return
        }
        await pending.handlers.onEvent({ type: 'text_delta', delta: text })
      }
      // thinking_delta 不发：这个块是思考还是旁白（narration.mts），要等签名和那一帧助手消息到了才知道，
      // 整块到了再按块发。默认的思考展示下真思考本来就没有字，看不出差别；打开了思考摘要时摘要整块出现
    }
  }

  private async beginAssistantMessage(
    pending: PendingTurn,
    messageId: string | null,
    streamStart = false,
  ): Promise<void> {
    if (messageId ? messageId === pending.assistantMessageId : !streamStart) return
    pending.assistantMessageId = messageId
    pending.streamedBlocks = new Map()
    if (!pending.context?.outputFormat) {
      await pending.handlers.onEvent({ type: 'message_boundary' })
    }
  }

  private recordStreamedBlock(
    pending: PendingTurn,
    index: unknown,
    type: string,
    text: string,
  ): void {
    const blockIndex = typeof index === 'number' ? index : 0
    const blocks = (pending.streamedBlocks ??= new Map())
    const previous = blocks.get(blockIndex)
    blocks.set(blockIndex, { type, text: (previous?.type === type ? previous.text : '') + text })
  }

  private unstreamedBlockText(pending: PendingTurn, type: string, text: string): string {
    for (const [index, block] of pending.streamedBlocks ?? []) {
      if (block.type !== type || !text.startsWith(block.text)) continue
      pending.streamedBlocks.delete(index)
      return text.slice(block.text.length)
    }
    return text
  }

  private async handleAssistant(
    pending: PendingTurn,
    message: Record<string, unknown>,
  ): Promise<void> {
    const inner = message.message as Record<string, unknown> | undefined
    if (!inner) return
    await this.goalUsage(pending, inner)
    const nestedMessage = Boolean(message.parent_tool_use_id)
    if (!nestedMessage && typeof inner.model === 'string' && !inner.model.startsWith('<'))
      pending.contextModel = inner.model
    await this.contextUsage(
      pending,
      String(message.parent_tool_use_id ?? ''),
      inner.id,
      inner.usage,
    )
    if (!nestedMessage && pending.activeSubagents.size === 0) {
      await this.beginAssistantMessage(pending, stringOrNull(inner.id))
    }
    const content = (inner.content as Array<Record<string, unknown>>) || []
    const agentToolUseId = stringOrNull(message.parent_tool_use_id)
    const narration = narrationIndexes(message)
    for (const [index, block] of content.entries()) {
      const blockType = String(block.type ?? '')
      if (agentToolUseId && (blockType === 'text' || blockType === 'thinking')) {
        const text = String((blockType === 'text' ? block.text : block.thinking) ?? '')
        if (!text) continue
        // 旁白按说明文字给子线程，但它不是子代理的结果，不记成最后一段话
        if (blockType === 'text') (pending.subagentText ??= new Map()).set(agentToolUseId, text)
        const said = blockType === 'text' || isNarration(block, index, narration)
        await pending.handlers.onEvent({
          type: 'subagent_event',
          agentToolUseId,
          event: { type: said ? 'text' : 'reasoning', text },
        })
        continue
      }
      if (blockType === 'text') {
        if (nestedMessage || pending.activeSubagents.size > 0) continue
        const text = this.unstreamedBlockText(pending, 'text', String(block.text ?? ''))
        if (pending.context?.outputFormat) {
          pending.structuredBuffer += text
        } else if (text) {
          await pending.handlers.onEvent({ type: 'text_delta', delta: text })
        }
      } else if (blockType === 'thinking') {
        if (nestedMessage || pending.activeSubagents.size > 0) continue
        const thinking = String(block.thinking ?? '')
        if (!thinking) continue
        if (!pending.context?.outputFormat && isNarration(block, index, narration)) {
          // 旁白是一段说明：前后各断一次，不和前面的回答、同一条消息后面的正文粘成一条
          await pending.handlers.onEvent({ type: 'message_boundary' })
          await pending.handlers.onEvent({ type: 'text_delta', delta: thinking })
          await pending.handlers.onEvent({ type: 'message_boundary' })
        } else {
          await pending.handlers.onEvent({ type: 'reasoning_delta', delta: thinking })
        }
      } else if (blockType === 'tool_use') {
        const id = String(block.id ?? '')
        const name = String(block.name ?? '')
        const input = (block.input as Record<string, unknown>) || {}
        if (!id) continue
        if (name === 'Bash')
          pending.session?.shells.bashCommand.set(id, String(input.command ?? ''))
        if (!nestedMessage && name === 'SendMessage')
          (pending.sendMessages ??= new Map()).set(id, String(input.message ?? input.content ?? ''))
        // Suppress nested tool uses while a subagent is in flight.
        const parentSubagent = nestedMessage || pending.activeSubagents.size > 0
        if (isSubagentTool(name)) {
          pending.activeSubagents.add(id)
        }
        if (parentSubagent && !isSubagentTool(name)) {
          // 子代理自己的工具调用归到它的子线程；提问仍由 canUseTool 桥接到父线程。
          if (agentToolUseId && name !== 'StructuredOutput' && name !== 'AskUserQuestion')
            await pending.handlers.onEvent({
              type: 'subagent_event',
              agentToolUseId,
              event: { type: 'tool_use', toolUseId: id, toolName: name, input },
            })
          continue
        }
        if (name === 'StructuredOutput') {
          // Defer emission; the final coercion happens at result-time.
          continue
        }
        if (name === 'AskUserQuestion' || name === 'ExitPlanMode') {
          // The canUseTool bridge below renders this as a Codex-native
          // dynamicToolCall via onUserInputRequest. Skip the generic
          // tool_use event so the App doesn't also draw an mcpToolCall card
          // for the same question.
          // 计划确认（ExitPlanMode）也是这样：问用户的那一条就是它的条目，选“继续规划”时
          // CLI 交回的拒绝只给模型看，不再另有一条失败的工具调用。
          continue
        }
        await pending.handlers.onEvent({ type: 'tool_use', toolUseId: id, toolName: name, input })
        if (isWorkflowTool(name)) pending.workflowToolUseIds.add(id)
      }
    }
  }

  private async handleUser(pending: PendingTurn, message: Record<string, unknown>): Promise<void> {
    // The SDK delivers tool_result blocks as a 'user' message turn from the
    // CLI's perspective. Surface them so the server can update the matching
    // tool item.
    const workflowLaunchResult =
      message.tool_use_result ?? (message as Record<string, unknown>).toolUseResult
    let workflowLaunchAttached = false
    const inner = message.message as Record<string, unknown> | undefined
    if (!inner) return
    const content = Array.isArray(inner.content)
      ? (inner.content as Array<Record<string, unknown>>)
      : []
    const toolResultCount = content.filter((block) => String(block.type) === 'tool_result').length
    const agentToolUseId = stringOrNull(message.parent_tool_use_id)
    // SDK 每条用户消息只带一份结构化结果；多个结果并存时无法归属，不使用。
    const structured = toolResultCount === 1 ? workflowLaunchResult : undefined
    for (const block of content) {
      if (String(block.type) !== 'tool_result') continue
      const toolUseId = String(block.tool_use_id ?? '')
      if (!toolUseId) continue
      const isError = Boolean(block.is_error)
      const bodyContent = block.content
      if (agentToolUseId && !pending.activeSubagents.has(toolUseId)) {
        await pending.handlers.onEvent({
          type: 'subagent_event',
          agentToolUseId,
          event: { type: 'tool_result', toolUseId, content: bodyContent, isError },
        })
        continue
      }
      const isWorkflowLaunch = pending.workflowToolUseIds?.delete(toolUseId) === true
      const wasSubagent = pending.activeSubagents.delete(toolUseId)
      const backgroundAgentId =
        wasSubagent && !isWorkflowLaunch && !isError
          ? (asyncAgentLaunchId(structured) ?? launchReceiptAgentId(bodyContent))
          : null
      if (backgroundAgentId) {
        // Agent 默认后台运行，此时拿到的只是启动回执。子代理的结果以
        // task_notification 为准；主模型在此期间继续输出，不再按子代理抑制。
        ;(pending.backgroundAgents ??= new Map()).set(backgroundAgentId, toolUseId)
        await pending.handlers.onEvent({
          type: 'subagent_backgrounded',
          toolUseId,
          agentId: backgroundAgentId,
        })
        continue
      }
      const backgroundTaskId = isError
        ? null
        : this.backgroundTaskFor(pending, toolUseId, structured, bodyContent)
      // Even if this was a subagent we still emit its tool_result so the
      // server's subagent state machine closes the collabAgentToolCall.
      await pending.handlers.onEvent({
        type: 'tool_result',
        toolUseId,
        content: bodyContent,
        isError,
        ...(structured === undefined ? {} : { structured }),
        ...(backgroundTaskId ? { backgroundTaskId } : {}),
      })
      if (!workflowLaunchAttached && isWorkflowLaunch && toolResultCount === 1) {
        workflowLaunchAttached = true
        this.attachWorkflowJournal(pending, workflowLaunchResult, toolUseId)
      }
      void wasSubagent
    }
  }

  // 这条工具结果是不是后台命令的启动回执。以结构化结果为准：有结构化结果却没带
  // backgroundTaskId，就是在前台跑完的（前台命令跑久了 CLI 也发 task_started，好让人中途转到后台，
  // 所以光有任务启动时记下的对应关系不算数）。一条消息带多个结果时没有结构化结果，
  // 退回到那个对应关系，但回执的正文里得提到这个任务的标识。
  private backgroundTaskFor(
    pending: PendingTurn,
    toolUseId: string,
    structured: unknown,
    content: unknown,
  ): string | null {
    const shells = pending.session?.shells
    if (!shells?.bashCommand.has(toolUseId)) return null
    const reported = (structured as { backgroundTaskId?: unknown } | undefined)?.backgroundTaskId
    if (typeof reported === 'string' && reported) return reported
    if (structured !== undefined) return null
    const text = typeof content === 'string' ? content : JSON.stringify(content ?? '')
    for (const [taskId, owner] of shells.taskToolUse)
      if (owner === toolUseId && text.includes(taskId)) return taskId
    return null
  }

  private attachWorkflowJournal(pending: PendingTurn, value: unknown, toolUseId: string): void {
    const launch = parseWorkflowLaunchInfo(
      value,
      pending.workflowTranscriptRoots ?? defaultWorkflowTranscriptRoots(process.env),
    )
    if (!launch) return
    if (pending.skippedWorkflowTaskIds?.has(launch.taskId)) return
    const state = pending.workflowTasks?.get(launch.taskId)
    if (!state) {
      const boundState = [...(pending.workflowTasks?.values() ?? [])].find(
        (candidate) => candidate.toolUseId === toolUseId,
      )
      if (boundState) return
      const launches = pending.workflowLaunches ?? (pending.workflowLaunches = new Map())
      launches.set(toolUseId, launch)
      return
    }
    this.attachParsedWorkflowJournal(pending, state, launch, toolUseId)
  }

  private attachParsedWorkflowJournal(
    pending: PendingTurn,
    state: WorkflowTaskState,
    launch: WorkflowLaunchInfo,
    toolUseId: string,
  ): void {
    if (launch.taskId !== state.taskId) return
    if (state.toolUseId && state.toolUseId !== toolUseId) return
    if (!state.toolUseId) state.toolUseId = toolUseId
    state.workflowName = launch.workflowName || state.workflowName
    state.description = launch.summary || state.description
    state.prompt = state.prompt || state.description || state.workflowName
    if (state.terminal || state.aggregateStarted || state.monitor) return

    state.monitor = this.createWorkflowMonitor(pending, state, launch)
    state.monitor.start()
  }

  private attachDeferredWorkflowJournal(
    pending: PendingTurn,
    state: WorkflowTaskState,
    sourceToolUseId: string,
  ): void {
    const launches = pending.workflowLaunches
    if (!launches || launches.size === 0) return
    if (sourceToolUseId) {
      const launch = launches.get(sourceToolUseId)
      if (!launch) return
      launches.delete(sourceToolUseId)
      this.attachParsedWorkflowJournal(pending, state, launch, sourceToolUseId)
      return
    }
    const matches = [...launches.entries()].filter(([, launch]) => launch.taskId === state.taskId)
    if (matches.length !== 1) return
    const match = matches[0]
    if (!match) return
    const [toolUseId, launch] = match
    launches.delete(toolUseId)
    this.attachParsedWorkflowJournal(pending, state, launch, toolUseId)
  }

  private discardDeferredWorkflowLaunches(
    pending: PendingTurn,
    taskId: string,
    sourceToolUseId: string,
  ): void {
    const launches = pending.workflowLaunches
    if (!launches) return
    if (sourceToolUseId) launches.delete(sourceToolUseId)
    for (const [toolUseId, launch] of launches) {
      if (launch.taskId === taskId) launches.delete(toolUseId)
    }
  }

  private createWorkflowMonitor(
    pending: PendingTurn,
    state: WorkflowTaskState,
    launch: WorkflowLaunchInfo,
  ): WorkflowJournalMonitor {
    return new WorkflowJournalMonitor({
      launch,
      onStarted: async (agent) => {
        if (state.terminal) return
        const toolUseId = workflowAgentToolUseId(state.taskId, agent.agentId)
        if (
          pending.activeSubagents.has(toolUseId) ||
          pending.completedWorkflowTasks.has(toolUseId)
        ) {
          return
        }
        pending.activeSubagents.add(toolUseId)
        try {
          await pending.handlers.onEvent({
            type: 'tool_use',
            toolUseId,
            toolName: 'Agent',
            input: {
              description: agent.description,
              prompt: agent.prompt,
              subagent_type: 'workflow',
            },
          })
        } catch (error) {
          pending.activeSubagents.delete(toolUseId)
          throw error
        }
      },
      onResult: async (agent) => {
        if (state.terminal) return
        const toolUseId = workflowAgentToolUseId(state.taskId, agent.agentId)
        if (!pending.activeSubagents.has(toolUseId)) return
        await pending.handlers.onEvent({
          type: 'tool_result',
          toolUseId,
          content: agent.content,
          isError: agent.isError,
        })
        pending.activeSubagents.delete(toolUseId)
        pending.completedWorkflowTasks.add(toolUseId)
      },
      onError: async (error) => {
        if (state.terminal) return
        // Monitoring failures are terminal for the projected workflow. Record
        // the failure now so a later successful SDK result cannot revive the
        // task or leave the parent waiting for a journal that is no longer
        // being observed.
        const message = `Workflow monitoring failed: ${error.message}`
        state.monitorFailed = true
        state.monitor = null
        state.terminal = true
        pending.workflowFailure ??= message
        await this.closeWorkflowAgentLifecycles(pending, state, message, true)
        await this.closeWorkflowAggregateLifecycle(pending, state, message, true)
        if (state.toolUseId) pending.workflowToolUseIds.delete(state.toolUseId)
        await pending.handlers.onEvent({
          type: 'notice',
          level: 'warning',
          message,
        })
        if (pending.deferredResult) {
          pending.completedWorkflowTasks.add(workflowTaskToolUseId(state.taskId))
          pending.deferredResult = {
            ...pending.deferredResult,
            success: false,
            resultText: pending.deferredResult.resultText ?? message,
          }
          await this.finishDeferredResult(pending, true)
        }
      },
    })
  }

  private workflowProjectedAgentIds(pending: PendingTurn, state: WorkflowTaskState): string[] {
    const agentIds = new Set(state.monitor?.activeAgentIds() ?? [])
    const prefix = `workflow-agent:${state.taskId}:`
    for (const toolUseId of pending.activeSubagents) {
      if (!toolUseId.startsWith(prefix)) continue
      const agentId = toolUseId.slice(prefix.length)
      if (agentId) agentIds.add(agentId)
    }
    return [...agentIds]
  }

  private async closeWorkflowAgentLifecycles(
    pending: PendingTurn,
    state: WorkflowTaskState,
    message: string,
    isError: boolean,
  ): Promise<number> {
    let closed = 0
    for (const agentId of this.workflowProjectedAgentIds(pending, state)) {
      const toolUseId = workflowAgentToolUseId(state.taskId, agentId)
      if (!pending.activeSubagents.delete(toolUseId)) continue
      pending.completedWorkflowTasks.add(toolUseId)
      await pending.handlers.onEvent({
        type: 'tool_result',
        toolUseId,
        content: `${message}\nagentId: ${agentId}`,
        isError,
      })
      closed += 1
    }
    return closed
  }

  private async closeWorkflowAggregateLifecycle(
    pending: PendingTurn,
    state: WorkflowTaskState,
    message: string,
    isError: boolean,
  ): Promise<boolean> {
    const toolUseId = workflowTaskToolUseId(state.taskId)
    if (!pending.activeSubagents.delete(toolUseId)) return false
    pending.completedWorkflowTasks.add(toolUseId)
    await pending.handlers.onEvent({
      type: 'tool_result',
      toolUseId,
      content: message,
      isError,
    })
    return true
  }

  private ensureWorkflowTask(pending: PendingTurn, taskId: string): WorkflowTaskState {
    const tasks = pending.workflowTasks ?? (pending.workflowTasks = new Map())
    const existing = tasks.get(taskId)
    if (existing) return existing
    const state: WorkflowTaskState = {
      taskId,
      toolUseId: '',
      workflowName: '',
      description: '',
      prompt: '',
      monitor: null,
      aggregateStarted: false,
      terminal: false,
    }
    tasks.set(taskId, state)
    return state
  }

  private async ensureWorkflowAggregateStarted(
    pending: PendingTurn,
    state: WorkflowTaskState,
  ): Promise<void> {
    if (state.terminal || state.aggregateStarted) return
    const toolUseId = workflowTaskToolUseId(state.taskId)
    if (pending.completedWorkflowTasks.has(toolUseId)) return
    state.aggregateStarted = true
    pending.activeSubagents.add(toolUseId)
    try {
      await pending.handlers.onEvent({
        type: 'tool_use',
        toolUseId,
        toolName: 'Agent',
        input: {
          description: state.workflowName ? `Workflow: ${state.workflowName}` : 'Workflow',
          prompt: state.prompt || state.description || state.workflowName || 'Workflow',
          subagent_type: 'workflow',
        },
      })
    } catch (error) {
      state.aggregateStarted = false
      pending.activeSubagents.delete(toolUseId)
      throw error
    }
  }

  private async stopWorkflowTasks(pending: PendingTurn): Promise<void> {
    const tasks = pending.workflowTasks
    if (tasks) {
      for (const state of tasks.values()) {
        state.terminal = true
        await state.monitor?.stop()
        await this.closeWorkflowAgentLifecycles(
          pending,
          state,
          'Workflow monitoring stopped before the agent published an individual result.',
          true,
        )
        await this.closeWorkflowAggregateLifecycle(
          pending,
          state,
          'Workflow monitoring stopped before the workflow published a terminal result.',
          true,
        )
      }
    }
    pending.workflowLaunches?.clear()
  }

  private hasPendingWorkflowTasks(pending: PendingTurn): boolean {
    if ((pending.workflowToolUseIds?.size ?? 0) > 0) return true
    if ((pending.workflowLaunches?.size ?? 0) > 0) return true
    for (const state of pending.workflowTasks?.values() ?? []) {
      if (!state.terminal) return true
    }
    return false
  }

  // 后台子代理结束：把它最后一段正文作为结果交给协议层收尾子线程。
  private async finishBackgroundAgent(
    pending: PendingTurn,
    toolUseId: string,
    message: Record<string, unknown>,
  ): Promise<void> {
    const text = pending.subagentText?.get(toolUseId) ?? String(message.summary ?? '').trim()
    pending.subagentText?.delete(toolUseId)
    const usage = workflowTaskUsage(message.usage)
    await pending.handlers.onEvent({
      type: 'tool_result',
      toolUseId,
      content: text,
      isError: message.status !== 'completed',
      structured: {
        status: 'completed',
        agentId: message.task_id,
        content: [{ type: 'text', text }],
        ...(usage
          ? {
              totalTokens: usage.totalTokens,
              totalToolUseCount: usage.toolUses,
              totalDurationMs: usage.durationMs,
            }
          : {}),
      },
    })
  }

  private async finishDeferredResult(pending: PendingTurn, force = false): Promise<void> {
    const deferred = pending.deferredResult
    if (!deferred || pending.resolved) return
    const session = pending.session as NativeSession | undefined
    const confirmed = !pending.awaited || pending.awaitedSeen
    if (force && deferred.success && !confirmed) {
      deferred.success = false
      deferred.resultText = 'SDK 退出前未确认追加指令，执行结果不确定，请读取历史对账'
    }
    if (!force && deferred.success && !confirmed) return
    if (!force && deferred.success && this.hasPendingWorkflowTasks(pending)) return
    // 后台子代理结束后 CLI 会自行续跑一轮并再发一条 result；idle 之前回合都没有结束。
    if (!force && deferred.success && session?.state != null && session.state !== 'idle') return
    // 结束通知与 idle 几乎同时到达时，通知触发的那一轮还没开始；等它开始再结束回合。
    if (!force && deferred.success && session && this.awaitsNotificationRound(session)) return

    pending.deferredResult = null
    this.detach(pending)
    const refusal = session && !force ? this.keepAlive(session) : null
    // 进程要退出了：请它起的标题还没写进会话记录的话，等一会儿（标题用的是小模型，一般早就起完了）
    if (session?.title && !force && refusal !== null)
      await Promise.race([session.title, delay(TITLE_GRACE_MS)])
    if (session && (force || refusal !== null)) {
      // 进程不保留：让 CLI 自己收尾退出，runTurn 等它确认后才返回。
      session.closing = true
      session.process.allowGracefulClose()
      session.input.close()
    }
    try {
      if (refusal)
        await pending.handlers.onEvent({ type: 'notice', level: 'warning', message: refusal })
      await pending.handlers.onEvent({
        type: 'completed',
        success: deferred.success,
        result: deferred.resultText,
        claudeSessionId: deferred.claudeSessionId,
        ...(deferred.codexErrorInfo ? { codexErrorInfo: deferred.codexErrorInfo } : {}),
      })
      if (deferred.success) {
        pending.resolve()
      } else {
        pending.reject(
          new TurnFailure(
            deferred.resultText ?? 'Claude turn failed',
            deferred.codexErrorInfo ?? null,
          ),
        )
      }
    } catch (err) {
      pending.reject(err instanceof Error ? err : new Error(String(err)))
    }
  }

  // 回合结束时进程要不要留下。返回 null 表示留下；空串表示不留；
  // 其他文字表示本该留下却留不了，要告诉用户后台命令为什么停了。
  // 没有后台命令时只有开了空闲保留才留，满额时先回收闲得最久的空闲会话，回收不出位置就不留。
  private keepAlive(session: NativeSession): string | null {
    if (session.closing || session.process.hasExited) return ''
    const shells = hasBackgroundWork(session)
    // 临时会话没人会接着聊、也不该被别的会话找到：只为后台命令留
    if (!shells && (keepAliveIdleMs() <= 0 || session.context.ephemeral)) return ''
    const limit = keepAliveLimit()
    if (limit <= 0) return ''
    if (!session.kept) {
      const kept = [...this.sessions.values()].filter((other) => other.kept && !other.closing)
      const idle = kept
        .filter((other) => this.isIdle(other))
        .sort((a, b) => a.idleSince - b.idleSince)
      const over = kept.length - limit + 1
      if (over > 0 && idle.length < over)
        return shells
          ? `已有 ${kept.length} 个会话在保留后台命令，达到上限；本回合启动的后台命令已随回合结束而停止。`
          : ''
      for (const other of idle.slice(0, Math.max(over, 0)))
        void this.shutdown(other, '保留的会话数达到上限')
      session.kept = true
    }
    if (!shells) this.scheduleReap(session)
    return null
  }

  // 还要不要为结束通知触发的那一轮等下去。要等时到点再来结算一次；等待期间又来了通知就接着等。
  private awaitsNotificationRound(session: NativeSession): boolean {
    if (session.notificationAt == null) return false
    const left = notificationGraceLeft(session.notificationAt, Date.now())
    if (left === 0) {
      session.notificationAt = null
      return false
    }
    if (session.notificationTimer) return true
    session.notificationTimer = setTimeout(() => {
      session.notificationTimer = null
      const pending = session.turn
      if (pending)
        void this.finishDeferredResult(pending).catch((error) =>
          debugLog('native.session.finishFailed', { threadId: session.key, error: String(error) }),
        )
    }, left)
    session.notificationTimer.unref()
    return true
  }

  private async handleResult(
    pending: PendingTurn,
    message: Record<string, unknown>,
  ): Promise<void> {
    debugLog('native.sdk.result', {
      threadId: pending.context?.threadId,
      turnId: pending.context?.turnId,
      origin: message.origin,
      numTurns: message.num_turns,
    })
    if (pending.resolved) return
    if (pending.awaited && resultConfirms(message, pending.awaited)) pending.awaitedSeen = true
    const subtype = String(message.subtype ?? '')
    // 多个后台任务同时结束时 CLI 会先发一条空 result，真正的那条随后才到；
    // 适配器送入的静默消息也只产生空 result。它们不能盖掉已有的结果。
    if (
      pending.deferredResult &&
      subtype === 'success' &&
      !message.is_error &&
      Number(message.num_turns) === 0 &&
      !message.result
    ) {
      await this.finishDeferredResult(pending)
      return
    }
    // 交了计划之后是入口让 CLI 停下的（planHandoff）：CLI 报的“执行中出错”就是这次停下
    const handedOff = pending.planHandoff && subtype === 'error_during_execution'
    let success =
      (handedOff || (subtype === 'success' && !message.is_error)) && pending.workflowFailure == null
    let resultText = handedOff
      ? null
      : (pending.workflowFailure ?? (message.result == null ? null : String(message.result)))
    let structuredText: string | undefined
    if (success && pending.context.outputFormat) {
      try {
        if (message.structured_output === undefined) throw new Error('SDK 未返回 structured_output')
        const format = pending.context.outputFormat as Record<string, unknown>
        const schema = format.schema as Record<string, unknown>
        const validate = jsonSchemaValidator(schema, { validateFormats: false }).compile(schema)
        if (!validate(message.structured_output))
          throw new Error('SDK 结构化结果不符合 outputSchema')
        structuredText = JSON.stringify(message.structured_output)
      } catch (error) {
        success = false
        resultText = error instanceof Error ? error.message : String(error)
      }
    }
    const claudeSessionId = message.session_id == null ? null : String(message.session_id)
    const usage = (message.usage as Record<string, unknown>) || {}
    const modelWindow = contextWindowOf(message.modelUsage, pending.contextModel)
    const contextWindow = (await compactWindow(pending.query, modelWindow)) ?? modelWindow
    // Push usage + metrics before completed so server can roll them into the
    // turn before emitting turn/completed.
    if (Object.keys(usage).length > 0 || contextWindow !== null) {
      await pending.handlers.onEvent({
        type: 'usage',
        usage,
        contextWindow,
        model: pending.contextModel,
      })
    }
    await pending.handlers.onEvent({
      type: 'metrics',
      durationMs: numberOrNull(message.duration_ms),
      apiDurationMs: numberOrNull(message.duration_api_ms),
      numTurns: numberOrNull(message.num_turns),
      costUsd: numberOrNull(message.total_cost_usd),
    })
    // SDK 的格式工具通过 result.structured_output 返回数据，不能丢弃后用输入合成答案。
    if (success && structuredText)
      await pending.handlers.onEvent({ type: 'text_delta', delta: structuredText })
    pending.deferredResult = {
      success,
      resultText,
      claudeSessionId,
      codexErrorInfo: success
        ? null
        : codexErrorInfoFor({
            status: message.api_error_status as number | null | undefined,
            category: pending.apiErrorCategory,
            text: resultText,
          }),
    }
    if (!success) await this.stopWorkflowTasks(pending)
    await this.finishDeferredResult(pending)
  }

  // 一次请求的用量来了（流式的结尾，或者一条助手消息）：并进这一路，占用变了就报
  private async contextUsage(
    pending: PendingTurn,
    lane: string,
    id: unknown,
    usage: unknown,
  ): Promise<void> {
    const entry = mergeRequestUsage(pending.contextUsage, lane, id, usage)
    if (!entry) return
    const tokens = contextTokens(entry.usage)
    if (tokens === 0 || tokens === entry.reported) return
    entry.reported = tokens
    await pending.handlers.onEvent({
      type: 'context_usage',
      usage: { ...entry.usage },
      agentToolUseId: lane || null,
      model: pending.contextModel,
    })
  }

  private async goalUsage(pending: PendingTurn, message: Record<string, unknown>): Promise<void> {
    if (
      !pending.context?.goalTools ||
      typeof message.id !== 'string' ||
      !message.usage ||
      typeof message.usage !== 'object'
    )
      return
    pending.usageByMessage ??= new Map()
    const usage = { ...(pending.usageByMessage.get(message.id) ?? {}) }
    for (const [key, value] of Object.entries(message.usage))
      if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0)
        usage[key] = Math.max(Number(usage[key] ?? 0), value)
    pending.usageByMessage.set(message.id, usage)
    await pending.handlers.onEvent({ type: 'goal_usage', messageId: message.id, usage })
  }

  private async handleOther(
    pending: PendingTurn,
    type: string,
    message: Record<string, unknown>,
  ): Promise<void> {
    if (type === 'rate_limit' || type === 'rate_limit_event') {
      const info = message.rate_limit_info as Record<string, unknown> | undefined
      if (
        info &&
        ['allowed', 'allowed_warning', 'rejected'].includes(String(info.status)) &&
        pending.credentialScope &&
        pending.credentialScope === rateLimitCredentialScope(pending.context.cwd)
      )
        await pending.handlers.onEvent({
          type: 'rate_limits',
          credentialScope: pending.credentialScope,
          info: { ...info } as NativeRateLimitInfo,
        })
      if (
        pending.context?.goalTools &&
        info?.status === 'rejected' &&
        (typeof info.rateLimitType === 'string' || info.errorCode === 'credits_required')
      )
        await pending.handlers.onEvent({ type: 'goal_limit', usageLimited: true })
      // Subscription usage updates also arrive when requests are allowed.
      // Those are bookkeeping, not warnings about a failed model request.
      if (info?.status === 'allowed') return
      const explicit = stringOrNull(message.message)
      if (!explicit && info?.status !== 'allowed_warning' && info?.status !== 'rejected') {
        if (type === 'rate_limit_event') return
      }
      await pending.handlers.onEvent({
        type: 'notice',
        level: 'warning',
        message: explicit ?? rateLimitNotice(info),
      })
      return
    }
  }
}

function rateLimitNotice(info: Record<string, unknown> | undefined): string {
  const window = String(info?.rateLimitType ?? 'usage').replaceAll('_', ' ')
  const status =
    info?.status === 'allowed_warning'
      ? `Claude usage is nearing the ${window} limit`
      : `Claude ${window} limit reached`
  const utilization = typeof info?.utilization === 'number' ? info.utilization : null
  const used = utilization == null ? '' : ` (${Math.round(utilization * 100)}% used)`
  const resetsAt = typeof info?.resetsAt === 'number' ? new Date(info.resetsAt * 1000) : null
  const reset =
    resetsAt && Number.isFinite(resetsAt.getTime()) ? ` Resets at ${resetsAt.toISOString()}.` : ''
  return `${status}${used}.${reset}`
}

// Codex 的审批策略与沙箱由 PreToolUse 边界检查和 canUseTool 实施；SDK 只区分计划模式。
// never 也必须走 canUseTool：dontAsk 会在回调前拒绝授权目录内的写入。
function derivePermissionMode(planMode: boolean): 'default' | 'plan' {
  // 会话选择是权限来源，环境变量不能覆盖客户端授权。
  return planMode ? 'plan' : 'default'
}

// Subagent tool detection — same allowlist as Python's is_subagent_tool and
// TS isSubagentToolName in server.mts.
function isSubagentTool(name: string): boolean {
  const n = name.trim().toLowerCase()
  return (
    n === 'task' || n === 'agent' || n === 'subagent' || n === 'spawn_agent' || n === 'spawnagent'
  )
}

// Agent 工具的结构化结果为 async_launched 时返回后台子代理的 agentId。
function asyncAgentLaunchId(value: unknown): string | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const result = value as Record<string, unknown>
  return result.status === 'async_launched' ? stringOrNull(result.agentId) : null
}

// 没有结构化结果时按回执的文字认：子代理自己派出的后台子代理（CLI 记成 spawnDepth 2），SDK 不给那条
// 工具结果带 tool_use_result；一条用户消息里有几个工具结果时结构化结果也归属不了。回执开头是
// “Async agent launched successfully.”，后面写着 agentId: <id>
function launchReceiptAgentId(content: unknown): string | null {
  const text =
    typeof content === 'string'
      ? content
      : Array.isArray(content)
        ? content.map((entry) => (typeof entry?.text === 'string' ? entry.text : '')).join('\n')
        : ''
  if (!text.trimStart().startsWith('Async agent launched successfully')) return null
  return /\bagentId:\s*([A-Za-z0-9_-]+)/.exec(text)?.[1] ?? null
}

function isWorkflowTool(name: string): boolean {
  return name === 'Workflow'
}

function isWorkflowBackgroundTask(message: Record<string, unknown>): boolean {
  return String(message.task_type ?? '') === 'local_workflow'
}

function workflowTaskToolUseId(taskId: string): string {
  return `workflow-task:${taskId}`
}

function workflowAgentToolUseId(taskId: string, agentId: string): string {
  return `workflow-agent:${taskId}:${agentId}`
}

/**
 * CLI 自己 /context 量占用用的窗口（解析后的自动压缩窗口）。summary 档只用上次请求的用量和本地估算，
 * 不调计数接口；CLI 不答（会话已经收了）或答得慢就算了，退回模型窗口
 */
async function compactWindow(query: Query, modelWindow: number | null): Promise<number | null> {
  try {
    const usage = await Promise.race([
      query.getContextUsage({ detail: 'summary' }),
      delay(CONTEXT_USAGE_GRACE_MS, null, { ref: false }),
    ])
    return compactWindowOf(usage, modelWindow)
  } catch (error) {
    debugLog('native.sdk.contextUsageFailed', { error: String(error) })
    return null
  }
}

async function settlesWithin(promise: Promise<unknown>, timeoutMs: number): Promise<boolean> {
  if (timeoutMs <= 0) return false
  let timer: NodeJS.Timeout | null = null
  try {
    return await Promise.race([
      promise.then(() => true),
      new Promise<boolean>((resolveTimeout) => {
        timer = setTimeout(() => resolveTimeout(false), timeoutMs)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

function workflowTaskUsage(value: unknown): {
  totalTokens: number
  toolUses: number
  durationMs: number
} | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const usage = value as Record<string, unknown>
  const totalTokens = numberOrNull(usage.total_tokens)
  const toolUses = numberOrNull(usage.tool_uses)
  const durationMs = numberOrNull(usage.duration_ms)
  if (totalTokens === null || toolUses === null || durationMs === null) return null
  return { totalTokens, toolUses, durationMs }
}

function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

const TITLE_GRACE_MS = 5_000
const CONTEXT_USAGE_GRACE_MS = 2_000

// 这两个变量设了（不为空就算，CLI 不看值）CLI 就不自己起标题
function cliSkipsAutoTitle(env: NodeJS.ProcessEnv): boolean {
  return Boolean(
    env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC || env.CLAUDE_CODE_DISABLE_TERMINAL_TITLE,
  )
}

export function sdkResumeSessionId(value: string | null, _cwd?: string): string | null {
  // 只恢复调用方明确指定的会话；交由 SDK 报告不存在或损坏的历史。
  return value
}

// 唤醒回合等别的会话那条消息最多多久，默认 60 秒（CHA_CLAUDE_PEER_WAKE_WAIT_MS，用例里调短）
function peerWakeWaitMs(): number {
  const raw = process.env.CHA_CLAUDE_PEER_WAKE_WAIT_MS
  const ms = raw == null || raw.trim() === '' ? 60_000 : Number(raw)
  return Number.isFinite(ms) && ms > 0 ? ms : 60_000
}
