import { type ChildProcess, spawn } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { isDeepStrictEqual } from 'node:util'
import { EXTENSION } from '../../protocol/src/device.mjs'
import { catalogPagination } from '../../shared/src/catalog-pagination.mjs'
import {
  clientToolNamespaces,
  isClientToolNamespace,
  noClientToolExecutor,
  pickClientToolExecutor,
} from '../../shared/src/client-tool-executor.mjs'
import { FilesystemRpc } from '../../shared/src/filesystem-rpc.mjs'
import { FuzzyFileSearch, FuzzySearchSessions } from '../../shared/src/fuzzy-session.mjs'
import { gitDiffToRemote as computeGitDiffToRemote } from '../../shared/src/git-diff-remote.mjs'
import { declaredExtensions, declineNote } from '../../shared/src/harness-declaration.mjs'
import {
  applyNotificationOptOut,
  optOutNotificationMethods,
} from '../../shared/src/notification-opt-out.mjs'
import { ProcessRpc } from '../../shared/src/process-rpc.mjs'
import { projectRequest } from '../../shared/src/project-rpc.mjs'
import { BROADCAST_THREAD_NOTIFICATIONS } from '../../shared/src/protocol-contract.mjs'
import { allowsApproval } from './approval-policy.mjs'
import { approvalRequest, mcpToolApprovalDecision, sessionGrantKey } from './approval-request.mjs'
import {
  type BackgroundCommandEntry,
  BackgroundCommands,
  endedCommandItem,
} from './background-commands.mjs'
import {
  backgroundTerminals,
  type ListedBackgroundTerminal,
  paginateBackgroundTerminals,
} from './background-terminals.mjs'
import { buildInfo } from './build-info.mjs'
import { listClaudeHooks } from './claude-capabilities.mjs'
import {
  migrateDefaultModel,
  readSettingsDefaults,
  writeSettingsDefaults,
} from './claude-default-model.mjs'
import { PROVIDER_CONFIG_KEY } from './claude-provider.mjs'
import { cliConfigLayer, mergeConfigLayers, requestConfigLayer } from './cli-config.mjs'
import { TurnFailure, turnErrorOf } from './codex-error-info.mjs'
import {
  applyConfigEdits,
  isConfigObject,
  readConfigFile,
  validateConfigTarget,
  writeConfigFile,
} from './config-store.mjs'
import { dynamicToolResult } from './dynamic-tool-result.mjs'
import { dynamicToolInstructions } from './dynamic-tools.mjs'
import { experimentalFeatureList, experimentalFeatureSet } from './experimental-features.mjs'
import { GoalController } from './goal-controller.mjs'
import { ClaudeHarnessConfig } from './harness-config.mjs'
import { HarnessConfigError } from './harness-config-common.mjs'
import { mergeMcpConfig, readMcpConfig } from './mcp.mjs'
import { sdkMcpServers } from './mcp-config.mjs'
import { elicitationParams, elicitationResponse } from './mcp-elicitation.mjs'
import { mcpOAuthManager } from './mcp-oauth.mjs'
import { type McpCallbacks, McpOperationCancelled, McpRpc, type McpScope } from './mcp-rpc.mjs'
import { type McpToolRef, mcpToolRef } from './mcp-tool-name.mjs'
import { parseContextItems } from './native-context.mjs'
import {
  type NativeSessionSource,
  NativeSessions,
  nativeSessionsEnabled,
  sdkNativeSessionSource,
} from './native-sessions.mjs'
import { PendingInteractions } from './pending-interactions.mjs'
import {
  copyPermissionOverlay,
  mergePermissionOverlay,
  type PermissionOverlay,
  parsePermissionGrant,
  permissionToolName,
} from './permission-grants.mjs'
import {
  applyPermissionProfile,
  compileFileSystemRules,
  defaultPermissionsId,
  profileSandboxMode,
  validatePermissionsConfig,
} from './permission-profiles.mjs'
import { ProposedPlanParser, type ProposedPlanSegment } from './proposed-plan.mjs'
import {
  historyHeadCursors,
  isForeignModel,
  ProtocolError,
  pageRecords,
  pageThreadItems,
  rejectForeignModel,
  requiredString,
  submissionHash,
  ThreadNotFound,
  validateRuntimePermissions,
} from './protocol-contract.mjs'
import { projectProviderLoopConfig } from './provider-loop-config.mjs'
import {
  hasProviderLoopSelectionInput,
  isProviderLoopSelectionConfigKey,
  type ProviderLoopSelectionInput,
  providerLoopSelectionInputFromConfig,
  providerLoopSelectionInputFromEnv,
  resolveProviderLoopSelection,
} from './provider-loop-selection.mjs'
import { AccountRateLimits } from './rate-limits.mjs'
import { recordRunEvent } from './run-registry.mjs'
import { normalizeRuntimeType } from './runtime-config.mjs'
import { defaultSandboxPolicy, parseSandboxPolicy, policyFromParams } from './sandbox-policy.mjs'
import {
  addedFileDiff,
  allSelectableModelOptions,
  asRecord,
  buildSystemPromptAddendum,
  catalogModelId,
  commandArray,
  commandEnv,
  compactSummary,
  declinedToolItem,
  defaultSelectableModelId,
  emptyTokenBreakdown,
  extraModelOption,
  fileChangeFromTool,
  gitTurnDiff,
  gitUntrackedDiff,
  gitWorktreeTree,
  hasLegacyPermissionParams,
  isGitWorkTree,
  isNotAGitRepo,
  isSelectableModel,
  isSubagentToolName,
  loadRuntimeModelCatalog,
  modelFromParams,
  normalizeApprovalPolicy,
  normalizeDecision,
  normalizePersonality,
  normalizeReasoningEffortEnum,
  normalizeSandboxMode,
  normalizeSelectableModelId,
  normalizeSessionSource,
  normalizeThreadSource,
  normalizeUserInputAnswers,
  nullIfEmpty,
  numberOr,
  parseSubagentTrailer,
  permissionProfileIdFromParams,
  permissionProfileList,
  permissionProfilePolicy,
  personalityPromptCue,
  readConfigReasoningEffort,
  reasoningEffortFromParams,
  reviewLabel,
  reviewPrompt,
  sandboxEnvelope,
  sandboxFromTurnParams,
  simpleDiff,
  stringListFromEnv,
  stringOr,
  subagentStructuredResult,
  summarizeRpcParams,
  threadPermissionProfileId,
  todoWriteToPlanSteps,
  tokenBreakdownFromClaudeUsage,
  toolItemWithResult,
  toolResultText,
  userInputAnswersAsContent,
} from './server-helpers.mjs'
import { resolveShellEnvironmentPolicy, type ShellEnvironmentPolicy } from './shell-environment.mjs'
import { layeredSkillRules, skillRules } from './skill-config.mjs'
import { SkillsRpc } from './skills-rpc.mjs'
import { PINNED_SECTION_ID, type SessionStore } from './store.mjs'
import {
  relayRuntimeEvents,
  SubagentProjection,
  subagentRelayPrompt,
} from './subagent-projection.mjs'
import { threadAttachmentOwnerList, threadAttachmentRequest } from './thread-attachments.mjs'
import { forkPositionFromParams, forkRetainedTurns } from './thread-fork.mjs'
import type { ThreadGoal } from './thread-goals.mjs'
import { patchGitInfo } from './thread-metadata.mjs'
import { threadQueueRequest } from './thread-queue.mjs'
import { ThreadSubscribers } from './thread-subscribers.mjs'
import { threadTimelineList } from './thread-timeline.mjs'
import { readImageView, toolUseItem } from './tool-items.mjs'
import { parseTurnSettings } from './turn-settings.mjs'
import type {
  ClaudeRuntime,
  FileUpdateChange,
  ImageInput,
  JsonRpcId,
  JsonRpcRequest,
  JsonRpcResponse,
  NativeSessionFork,
  PermissionDecision,
  RpcPeer,
  RuntimeBackgroundCommandEnd,
  RuntimeEvent,
  ThreadItem,
  ThreadRecord,
  ThreadSectionAppearance,
  ThreadTokenUsage,
  TokenUsageBreakdown,
  TurnRecord,
  UserInput,
  UserInputAnswers,
  UserInputQuestion,
  WireMessage,
} from './types.mjs'
import {
  adapterHome,
  claudeOutputFormat,
  codexCliVersion,
  codexHome,
  codexUserAgent,
  debugLog,
  defaultAllowedTools,
  ensureParent,
  extractImageInputs,
  isCodexOpenAiModel,
  newId,
  normalizeCodexReasoningEffort,
  nowMillis,
  nowSeconds,
  platformFamily,
  platformOs,
  resolveClaudeEffort,
  resolveClaudeModel,
  textFromInput,
} from './util.mjs'
import { parseWorkflowCommand } from './workflow-command.mjs'
import { maybeCreateThreadWorktree } from './worktree.mjs'

// A missing Claude Task result must not keep Codex cc in its working state
// forever. This is deliberately a long, configurable watchdog for the whole
// subagent phase; it is not the short journal-drain grace period used when a
// terminal notification has already arrived.
const DEFAULT_SUBAGENT_WATCHDOG_MS = 30 * 60 * 1000
const MIN_SUBAGENT_WATCHDOG_MS = 100

function isWorkflowToolName(value: string): boolean {
  const name = value.trim().toLowerCase()
  return name === 'workflow' || name === 'workflows'
}

// 子代理失败的原因：CLI 给 Agent 工具的错误结果（去掉包装之后）就是原话；一个字都没有时才写一句兜底的
function subagentFailure(text: string): string {
  const reason = text.trim()
  return reason || 'Subagent failed without a reason.'
}

function subagentWatchdogTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.CHA_CLAUDE_SUBAGENT_TIMEOUT_MS?.trim()
  if (!raw) return DEFAULT_SUBAGENT_WATCHDOG_MS
  const parsed = Number(raw)
  // Zero is the documented opt-out. Invalid and negative values must fall
  // back to the bounded default rather than silently reintroducing an
  // unbounded loading state.
  if (!Number.isFinite(parsed)) return DEFAULT_SUBAGENT_WATCHDOG_MS
  if (parsed === 0) return 0
  if (parsed < 0) return DEFAULT_SUBAGENT_WATCHDOG_MS
  return Math.max(MIN_SUBAGENT_WATCHDOG_MS, Math.floor(parsed))
}

type TurnItemsView = 'full' | 'summary' | 'notLoaded'

interface SubagentContext {
  childThreadId: string
  childTurnId: string
  waitItemId: string
  agentPath: string
  prompt: string
  subType: string | null
  // 子代理过程在子线程里的投影；工作流聚合出的代理没有过程可投影。
  projection: SubagentProjection | null
  // 派出它的那个 spawnAgent 条目（结束时的样子）。子代理结束时以同一个标识再发一次 item/completed，
  // 带上它最后的状态：官方桌面端按条目标识原地换掉，Litch 也一样
  spawnItem: ThreadItem
}

interface ActiveSubagentState {
  thread: ThreadRecord
  turn: TurnRecord
  contexts: Map<string, SubagentContext>
  active: Set<string>
}

interface PeerFeatures {
  // Codex cc 26.818.61809 only accepts started/interacted/interrupted in the
  // subAgentActivity schema. Newer clients may opt into the completed kind
  // explicitly during initialize; keep the legacy wire shape otherwise.
  supportsCompletedSubagentActivity: boolean
  // 握手时声明认识的协议扩展（capabilities.litchExtensions）。扩展内容只发给声明过的连接。
  extensions: Set<string>
  // 声明能执行的客户端工具命名空间（clientTools 扩展的 capabilities.litchClientTools）
  clientTools: ReadonlySet<string>
}

function turnItemsView(value: unknown): TurnItemsView {
  if (value === 'full' || value === 'summary' || value === 'notLoaded') return value
  return 'summary'
}

/** 隔多久扫一次本机别处开的 Claude Code 会话（有连接时） */
const NATIVE_WATCH_MS = 30_000

export class CodexClaudeAppServer {
  private readonly rateLimits = new AccountRateLimits()
  private readonly accountPeers = new Set<RpcPeer>()
  // 请求从一条仍连着的连接手里收回（它退订了这个线程）：直接告诉它撤掉卡片，不经线程路由。
  private pendingInteractions = new PendingInteractions((peer, threadId, requestId) => {
    try {
      peer.send({
        jsonrpc: '2.0',
        method: 'serverRequest/resolved',
        params: { threadId, requestId },
      })
    } catch {}
  })
  private closedPeers = new WeakSet<RpcPeer>()
  // 线程的订阅连接。一个线程可以同时被几条连接订阅：通知和等人回答的请求发给全部订阅连接。
  private readonly subscribers = new ThreadSubscribers()
  private peerFeatures = new WeakMap<RpcPeer, PeerFeatures>()
  private activeTurnByThread = new Map<string, string>()
  private scheduledGoals = new Map<string, string>()
  private scheduledQueues = new Map<string, string>()
  private goalUsageLimited = new Set<string>()
  // 自动起名已经看过几次（每个回合结束看一次，最多三次）；用户改过名的记成 Infinity，不再动
  private titleChecks = new Map<string, number>()
  private get goals(): GoalController {
    return new GoalController(this.store)
  }
  private interruptingByThread = new Map<string, Promise<void>>()
  private activeItemsByTurn = new Map<string, Set<string>>()
  private runtimeReadyByTurn = new Map<
    string,
    {
      ready: Promise<boolean>
      resolve: (started: boolean) => void
    }
  >()
  private nativeMutations = new Set<string>()
  private subagentStateByTurn = new Map<string, ActiveSubagentState>()
  // 子代理追问回合占用父会话：子线程 ID → 父线程 ID，回合结束时释放。
  private relayParentByChild = new Map<string, string>()
  // 回合结束后仍在运行的后台命令，以及 CLI 为处理它们的结果自己开的回合。
  private readonly backgroundCommands = new BackgroundCommands()
  private spontaneousTurns = new Set<string>()
  // 已经交到运行时手里的回合：运行时再说“没有回合在跑”，就是它已经交还、协议层还在收尾。
  private handedToRuntime = new Set<string>()
  private turnClearWaiters = new Map<string, Array<() => void>>()
  private detachedReapTimer: NodeJS.Timeout | null = null
  // 等着卸载的临时会话：会话标识 → 到时限的定时器（见 scheduleEphemeralUnload）
  private readonly ephemeralUnloads = new Map<string, NodeJS.Timeout>()
  private readonly fuzzySearch = new FuzzyFileSearch()
  private readonly fuzzySessions = new FuzzySearchSessions((peer, message) =>
    this.notify(peer, message),
  )
  private commandSessionAllow = new Map<string, Set<string>>()
  // 与固定 Codex 一致：会话授权仅在当前 runtime 运行代内跨 Turn 有效。
  private permissionSessionGrants = new Map<string, PermissionOverlay>()
  private commandProcesses = new Map<string, ChildProcess>()
  private readonly processes = new ProcessRpc(sandboxCommand)
  private readonly filesystem = new FilesystemRpc()
  private readonly mcp = new McpRpc()
  // Skill 开关的规则：config.json 的 skills.config 在前，`-c` 的接在后面（skill-config.mts）
  private readonly skills = new SkillsRpc(() =>
    layeredSkillRules([this.persistedSkillConfig, asRecord(cliConfigLayer().skills).config]),
  )
  private persistedSkillConfig: unknown = null
  private readonly mcpOAuth = mcpOAuthManager()
  private elicitationCounts = new Map<string, number>()
  private configModel = defaultSelectableModelId()
  private configReasoningEffort =
    normalizeCodexReasoningEffort(process.env.CHA_CLAUDE_DEFAULT_EFFORT) ?? 'medium'
  // Catch-all for arbitrary keys the App's settings sheet writes (approval
  // policy, sandbox preference, instructions toggles, etc.). We don't apply
  // them to typed runtime state, but we round-trip them through config/read
  // so the user's settings survive a daemon restart instead of resetting on
  // every reconnect.
  private configOverrides: Record<string, unknown> = {}
  private readonly configPath = join(adapterHome(), 'config.json')
  // harness 详情设置（litch/harness/*）：读写 Claude Code 自己的 settings.json、~/.claude.json、CLAUDE.md 与账号
  private readonly harnessConfig = new ClaudeHarnessConfig({
    broadcast: (method, params) => this.broadcastHarnessConfig(method, params),
    modelOptions: () =>
      allSelectableModelOptions().map((option) => ({
        value: option.id,
        title: { 'zh-CN': option.displayName, en: option.displayName },
        ...(option.description
          ? { description: { 'zh-CN': option.description, en: option.description } }
          : {}),
      })),
    defaultsChanged: () => {
      this.loadPersistedConfig()
    },
    mcpLogin: (name, complete) => {
      const scope = this.mcpScope()
      const config = sdkMcpServers(scope.servers)[name]
      if (!config) throw new ProtocolError(-32602, '当前范围未配置指定 MCP 服务')
      return this.mcpOAuth.login(
        scope.source,
        config,
        { name, timeoutSecs: 600 },
        HARNESS_CONFIG_PEER,
        (result) => complete({ success: result.success, error: result.error }),
      )
    },
  })
  private idleCheckHandler: (() => void) | null = null
  private stopped = false
  private readonly store: SessionStore
  private readonly runtime: ClaudeRuntime
  /** 本机别处开的 Claude Code 会话（native-sessions.mts）。关掉了是 null */
  private readonly native: NativeSessions | null
  private nativeTimer: NodeJS.Timeout | null = null

  constructor(
    store: SessionStore,
    runtime: ClaudeRuntime,
    nativeSource: NativeSessionSource | null = nativeSessionsEnabled()
      ? sdkNativeSessionSource()
      : null,
  ) {
    this.store = store
    this.runtime = runtime
    this.native = nativeSource
      ? new NativeSessions({
          store,
          source: nativeSource,
          newThread: (fields) => this.nativeThreadRecord(fields),
          busy: (threadId) => this.sessionHolder(threadId) !== null,
        })
      : null
    this.runtime.setSessionHandlers?.({
      onSpontaneousTurn: (threadId) => this.spontaneousTurn(threadId),
      onBackgroundCommandEnded: (threadId, end) => {
        const entry = this.backgroundCommands.take(threadId, end.taskId)
        if (entry) this.finishBackgroundCommand(entry, end)
      },
      onSessionClosed: (threadId, reason) => this.sessionClosed(threadId, reason),
    })
    this.loadPersistedConfig()
    this.discardLeftoverEphemeral()
  }

  async handle(peer: RpcPeer, message: WireMessage): Promise<void> {
    // 还在说话的连接就是连着的。
    this.closedPeers.delete(peer)
    if ('method' in message && message.method) {
      debugLog('rpc.request', {
        peerId: peer.id,
        id: 'id' in message ? message.id : null,
        method: message.method,
        params: summarizeRpcParams(message.method, message.params),
      })
      if ('id' in message) {
        await this.handleRequest(peer, message as JsonRpcRequest)
      } else {
        await this.handleNotification(peer, message)
      }
      return
    }
    if ('id' in message) {
      debugLog('rpc.responseFromClient', {
        peerId: peer.id,
        id: message.id,
        hasError: Boolean((message as JsonRpcResponse).error),
      })
      this.pendingInteractions.resolve(peer, message as JsonRpcResponse)
    }
  }

  // final：这条连接就是进程的寿命（标准输入输出），它断开后适配器随即退出，不会再有别的连接。
  closePeer(peer: RpcPeer, final = false): void {
    this.accountPeers.delete(peer)
    this.closedPeers.add(peer)
    // 等不来下一个订阅者：趁还能写，告诉对端它手里的请求已经失效。
    if (final) this.pendingInteractions.cancelPeer(peer.id)
    this.skills.closePeer(peer.id)
    this.mcpOAuth.closePeer(peer.id)
    this.mcp.closePeer(peer.id)
    this.filesystem.closePeer(peer.id)
    this.processes.closePeer(peer.id)
    debugLog('peer.close', { peerId: peer.id })
    // 订阅者断开只摘掉它自己，别的订阅连接照常。
    const watched = this.subscribers.threadsOf(peer)
    this.subscribers.removePeer(peer)
    for (const threadId of watched) this.scheduleEphemeralUnload(threadId)
    // 它手里等人回答的请求不作废：别的订阅连接还拿着就继续等；一条都不剩就回到没人可送的状态。
    this.pendingInteractions.dropPeer(peer.id)
    this.pendingInteractions.reroute()
    this.armDetachedReap()
  }

  // 所有连接都断开后，看管后台命令的进程再留一段时间；期间有连接回来就继续留。
  private armDetachedReap(): void {
    // 留着的 MCP 连接（含 stdio 服务的子进程）没人用的现在就关，不等空闲超时
    if (!this.stopped && this.accountPeers.size === 0) void this.runtime.closeIdleMcp?.()
    const linger = detachedLingerMs()
    if (this.stopped || this.detachedReapTimer || linger <= 0 || this.accountPeers.size > 0) return
    if ((this.runtime.liveSessions?.().length ?? 0) === 0) return
    this.detachedReapTimer = setTimeout(() => {
      this.detachedReapTimer = null
      if (this.stopped || this.accountPeers.size > 0) return
      for (const threadId of this.runtime.liveSessions?.() ?? [])
        if (!this.sessionHolder(threadId))
          void this.runtime.closeSession?.(threadId, '所有客户端已断开')
      // 有回合占着的进程这次不收（包括停在那里等人确认的回合）；仍然没有连接的话过一段再看。
      this.armDetachedReap()
    }, linger)
    this.detachedReapTimer.unref()
  }

  async stop(): Promise<void> {
    if (this.stopped) return
    if (this.nativeTimer) clearInterval(this.nativeTimer)
    this.nativeTimer = null
    // 先同步通知仍连接的客户端审批已失效，再抑制退出过程中的其他事件。
    this.pendingInteractions.close()
    this.stopped = true
    for (const timer of this.ephemeralUnloads.values()) clearTimeout(timer)
    this.ephemeralUnloads.clear()
    this.scheduledQueues.clear()
    this.permissionSessionGrants.clear()
    this.mcpOAuth.close()
    this.harnessConfig.close()
    await this.mcp.close()
    this.filesystem.close()
    await this.processes.close()
    // Child turns are created directly from Task/Workflow events and are not
    // registered in activeTurnByThread. Finalize them before aborting the
    // runtime or closing SQLite, otherwise stdio EOF can leave child turns
    // persisted as inProgress until a later restart recovery pass.
    this.finalizeActiveSubagentsForShutdown('server stopped')
    this.completeActiveTurns('interrupted', { message: 'server stopped' })
    await this.runtime.stop()
    this.skills.close()
    this.store.close()
  }

  // 还有 CLI 进程在看管后台命令时，适配器也不算空闲。
  hasActiveTurns(): boolean {
    return (
      (this.runtime.liveSessions?.().length ?? 0) > 0 ||
      this.activeTurnByThread.size > 0 ||
      this.scheduledGoals.size > 0 ||
      this.scheduledQueues.size > 0 ||
      this.nativeMutations.size > 0
    )
  }

  setIdleCheckHandler(handler: () => void): void {
    this.idleCheckHandler = handler
  }

  private skillsCwd(peer: RpcPeer): string {
    for (const id of this.subscribers.threadsOf(peer).reverse()) {
      const thread = this.store.getThread(id)
      if (thread) return thread.cwd
    }
    return this.skills.preferredCwd(peer.id) ?? process.cwd()
  }

  private async handleNotification(_peer: RpcPeer, _message: WireMessage): Promise<void> {
    // Currently only `initialized` is expected from clients.
  }

  private async handleRequest(peer: RpcPeer, request: JsonRpcRequest): Promise<void> {
    const threadId = asRecord(request.params).threadId
    const recoverContext = [
      'thread/resume',
      'thread/fork',
      'thread/rollback',
      'thread/revert',
      'thread/inject_items',
      'thread/delete',
      'thread/compact/start',
      'thread/settings/update',
      'turn/start',
      'thread/queue/start',
      'review/start',
    ].includes(request.method)
    const nativeMutation =
      [
        'thread/fork',
        'thread/rollback',
        'thread/revert',
        'thread/inject_items',
        'review/start',
      ].includes(request.method) ||
      (recoverContext &&
        typeof threadId === 'string' &&
        !!this.store.pendingContextInjection(threadId))
    let locked = false
    try {
      if (
        request.params === null &&
        ['experimentalFeature/list', 'experimentalFeature/enablement/set'].includes(request.method)
      )
        throw new ProtocolError(-32602, 'params 必须是对象')
      if (typeof threadId === 'string' && this.nativeMutations.has(threadId))
        throw new ProtocolError(-32009, '原生会话正在变更，请稍后重试')
      if (nativeMutation && typeof threadId === 'string') {
        this.nativeMutations.add(threadId)
        locked = true
      }
      if (recoverContext && typeof threadId === 'string')
        await this.recoverContextInjection(threadId)
      const result = await this.dispatch(peer, request.method, request.params ?? {})
      debugLog('rpc.response', {
        peerId: peer.id,
        id: request.id,
        method: request.method,
        ok: true,
      })
      this.sendResponse(peer, request.id, result)
    } catch (error) {
      debugLog('rpc.response', {
        peerId: peer.id,
        id: request.id,
        method: request.method,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : null,
      })
      this.sendResponse(peer, request.id, undefined, {
        code: error instanceof ProtocolError ? error.code : -32000,
        message: error instanceof Error ? error.message : String(error),
        // harness 详情设置的错误带 data.litch（原因），客户端按它处理
        ...(error instanceof HarnessConfigError ? { data: error.data } : {}),
      })
    } finally {
      if (locked) this.nativeMutations.delete(threadId as string)
      // 这次请求可能让某个线程有了订阅连接（恢复、发消息等）：应答发出之后，
      // 把等着人回答的请求送给它，先后与原生“恢复后重放挂起的请求”一致。
      this.pendingInteractions.reroute()
    }
  }

  private async dispatch(peer: RpcPeer, method: string, params: unknown): Promise<unknown> {
    if (params === null || typeof params !== 'object' || Array.isArray(params))
      throw new ProtocolError(-32602, 'params 必须是对象')
    if (method.startsWith('litch/harness/'))
      return this.harnessConfig.dispatch(method, asRecord(params))
    if (
      [
        'thread/start',
        'thread/resume',
        'thread/fork',
        'turn/start',
        'thread/settings/update',
        'thread/metadata/update',
      ].includes(method)
    )
      validateRuntimePermissions(asRecord(params), this.configOverrides.permissions)
    // 允许回退的 thread/start 由 threadStart 换成本运行时的默认模型，临时的 thread/fork 由 threadFork
    // 换成源会话的模型，不能先按外部模型拒绝。
    const substitutesModel =
      (method === 'thread/start' && asRecord(params).allowProviderModelFallback === true) ||
      (method === 'thread/fork' && asRecord(params).ephemeral === true)
    if (!substitutesModel) {
      rejectForeignModel(asRecord(params).model)
      rejectForeignModel(asRecord(asRecord(params).config).model)
    }
    if (
      [
        'plugin/install',
        'plugin/installed',
        'plugin/list',
        'plugin/read',
        'plugin/share/checkout',
        'plugin/share/delete',
        'plugin/share/list',
        'plugin/share/save',
        'plugin/share/updateTargets',
        'plugin/skill/read',
        'plugin/uninstall',
        'marketplace/add',
        'marketplace/remove',
        'marketplace/upgrade',
        'account/login/start',
        'account/login/cancel',
        'account/logout',
        'account/sendAddCreditsNudgeEmail',
        'account/rateLimitResetCredit/consume',
        'account/usage/read',
        'account/workspaceMessages/read',
        'remoteControl/status/read',
        'feedback/upload',
        'attestation/generate',
        'environment/add',
        // OpenAI/Codex 专属：Bedrock 与 Gateway 认证、ChatGPT 连接器详情、Codex 记忆与 rollout、
        // 插件对账、Touch ID 用户验证及外部代理配置导入。Claude 不伪造成功。
        'account/bedrock/discover',
        'account/bedrock/setup',
        'account/gatewayOAuth/login',
        'account/gatewayOAuth/cancel',
        'account/gatewayOAuth/read',
        'app/installed',
        'app/read',
        'memory/status',
        'plugin/reconcile',
        'rollout/compress',
        'userVerification/status',
        'userVerification/enroll',
        'userVerification/delete',
        'userVerification/verify',
        'userVerification/cancel',
        'externalAgentConfig/import',
        'externalAgentConfig/import/readHistories',
        'externalAgentConfig/import/recordHistory',
        // OpenAI 托管应用的 MCP 事件流与 Guardian 安全分类器，Claude 无对应物，不伪造确认。
        'mcpServer/event/stream/start',
        'mcpServer/event/stream/stop',
        'thread/approveGuardianDeniedAction',
      ].includes(method)
    )
      throw new ProtocolError(-32004, `Claude 运行时不适用此能力: ${method}`)
    switch (method) {
      case 'runtime/info':
        return buildInfo()
      case 'server/diagnostics':
        // 只报告本适配器进程的实测数据；没有等价测量的物理占用保持未知。
        return {
          process: {
            id: process.pid,
            residentMemoryBytes: process.memoryUsage.rss(),
            physicalFootprintBytes: null,
          },
          gauges: [
            { name: 'claude_adapter.active_turns', value: this.activeTurnByThread.size },
            { name: 'claude_adapter.initialized_connections', value: this.accountPeers.size },
          ],
        }
      case 'initialize': {
        // Claude 用户设置（如模型服务）变更后，新连接看到的模型目录随之刷新。
        await loadRuntimeModelCatalog(this.runtime)
        this.accountPeers.add(peer)
        this.watchNative()
        if (this.detachedReapTimer) clearTimeout(this.detachedReapTimer)
        this.detachedReapTimer = null
        const initParams = asRecord(params)
        const clientInfo = asRecord(initParams.clientInfo)
        const capabilities = asRecord(initParams.capabilities)
        const declaredActivityKinds = Array.isArray(capabilities.subAgentActivityKinds)
          ? capabilities.subAgentActivityKinds
          : []
        this.peerFeatures.set(peer, {
          supportsCompletedSubagentActivity:
            capabilities.subAgentActivityCompleted === true ||
            declaredActivityKinds.includes('completed') ||
            process.env.CHA_CLAUDE_SUBAGENT_COMPLETED === '1',
          extensions: declaredExtensions(initParams),
          clientTools: clientToolNamespaces(initParams),
        })
        // 客户端退订的通知，这条连接上从现在起不发（握手之后排着要推的那几条也算）。
        applyNotificationOptOut(peer, initParams)
        // Push the account snapshot + MCP server statuses right after handshake
        // so the App's sidebar avatar and MCP panel populate without waiting
        // for the next polling cycle. Without these the avatar stays "signed
        // out" and the MCP list never reflects current boot state.
        queueMicrotask(() => {
          this.notify(peer, {
            method: 'account/updated',
            params: { authMode: 'apikey', planType: null },
          })
          this.announceUnattended(peer)
          // 探测要把配置里的每个 MCP 服务连一次（stdio 的就是起一份进程），产出只有
          // mcpServer/startupStatus/updated 这一种通知：连接退订了它，就不为它白连一遍。
          if (optOutNotificationMethods(initParams).has('mcpServer/startupStatus/updated')) return
          void Promise.resolve()
            .then(() => this.mcpProbe(peer, this.mcpScope()))
            .catch((error: unknown) => {
              this.notify(peer, {
                method: 'mcpServer/startupStatus/updated',
                params: {
                  name: 'MCP configuration',
                  status: 'failed',
                  error: String(error),
                  threadId: null,
                },
              })
            })
        })
        return {
          userAgent: codexUserAgent(
            stringOr(clientInfo.name, 'codex-app'),
            stringOr(clientInfo.version, 'unknown'),
          ),
          codexHome: codexHome(),
          platformFamily: platformFamily(),
          platformOs: platformOs(),
        }
      }
      case 'thread/start':
        return this.threadStart(peer, asRecord(params))
      case 'project/create':
      case 'project/import':
      case 'project/list':
      case 'project/read':
      case 'project/update':
      case 'project/move':
      case 'project/delete':
        return projectRequest(
          this.store.projects,
          method,
          asRecord(params),
          (projectId, changeType) => {
            setImmediate(() => {
              for (const target of this.accountPeers)
                this.notify(target, {
                  method: 'project/changed',
                  params: { projectId, changeType },
                })
            })
          },
          (threadId, projectId) => this.threadProjectUpdated(threadId, projectId),
        )
      case 'thread/resume':
        await this.nativeHistory(asRecord(params).threadId)
        return this.withNativeLineage(peer, await this.threadResume(peer, asRecord(params)))
      case 'thread/fork':
        return this.threadFork(peer, asRecord(params))
      case 'thread/list':
        await this.refreshNative()
        return this.withNativeLineage(peer, this.threadList(asRecord(params)))
      case 'thread/read':
        await this.nativeHistory(asRecord(params).threadId)
        return this.withNativeLineage(peer, this.threadRead(asRecord(params)))
      case 'thread/attachment/add':
      case 'thread/attachment/list':
      case 'thread/attachment/remove':
        return threadAttachmentRequest(this.store, method, asRecord(params), (update) => {
          setImmediate(() =>
            this.notifyThread(update.threadId, {
              method: 'thread/attachment/updated',
              params: update,
            }),
          )
        })
      case 'thread/attachmentOwner/list':
        return threadAttachmentOwnerList(this.store, asRecord(params))
      case 'thread/turns/list':
        await this.nativeHistory(asRecord(params).threadId)
        return this.threadTurnsList(asRecord(params))
      case 'thread/timeline/list':
        return threadTimelineList(this.store, asRecord(params))
      case 'thread/items/list':
        return this.threadItemsList(asRecord(params))
      case 'thread/items/read':
        await this.nativeHistory(asRecord(params).threadId)
        return this.threadItemsRead(asRecord(params))
      case 'thread/delete': {
        const threadId = requiredString(asRecord(params).threadId, 'threadId')
        if (!this.store.getThread(threadId)) throw new ProtocolError(-32602, '未知会话')
        // 子线程的追问回合借用这个线程的进程：它在跑时这个线程同样算活动。
        if (this.sessionHolder(threadId)) throw new ProtocolError(-32009, '活动会话不能删除')
        const helper = this.store.getThread(threadId)?.ephemeral === true
        await this.runtime.closeSession?.(threadId, '会话已删除')
        this.store.deleteThread(threadId)
        const subscribed = this.subscribers.clear(threadId)
        this.clearThreadState(threadId)
        // 关闭（有连接订阅着它才算加载着）给原来订阅着它的连接，删除再加上删它的这条；不是临时会话的，
        // 和上游一样再发给所有握手过的连接（见 announce）。会话已经从库里删了，announce 认不出它是不是临时会话，这里自己分。
        const everyone = helper ? [] : [...this.accountPeers]
        const tell = (method: string, watching: RpcPeer[]) => {
          if (this.stopped) return
          for (const target of new Set([...everyone, ...watching]))
            this.deliver(target, { method, params: { threadId } }, peer)
        }
        if (subscribed.length > 0) tell('thread/closed', subscribed)
        tell('thread/deleted', [peer, ...subscribed])
        return {}
      }
      case 'thread/turns/items/list':
        return this.threadTurnItemsList(asRecord(params))
      case 'thread/name/set':
        return this.threadNameSet(asRecord(params))
      case 'thread/archive':
        return this.threadArchive(peer, asRecord(params), true)
      case 'thread/unsubscribe':
        return this.threadUnsubscribe(peer, asRecord(params))
      case 'thread/queue/start':
        return this.startQueuedTurn(peer, asRecord(params))
      case 'thread/queue/add':
      case 'thread/queue/list':
      case 'thread/queue/update':
      case 'thread/queue/delete':
      case 'thread/queue/reorder': {
        const value = asRecord(params)
        const result = threadQueueRequest(this.store, method, value)
        const threadId = requiredString(value.threadId, 'threadId')
        if (result.changed) {
          this.notify(peer, { method: 'thread/queue/changed', params: { threadId } })
          if (method === 'thread/queue/add') this.scheduleQueue(threadId)
        }
        return result.result
      }
      case 'thread/increment_elicitation':
        return this.threadAdjustElicitation(asRecord(params), 1)
      case 'thread/decrement_elicitation':
        return this.threadAdjustElicitation(asRecord(params), -1)
      case 'thread/goal/set':
        return this.threadGoalSet(peer, asRecord(params))
      case 'thread/goal/get':
        return this.threadGoalGet(asRecord(params))
      case 'thread/goal/clear':
        return this.threadGoalClear(asRecord(params))
      case 'thread/metadata/update':
        return this.threadMetadataUpdate(asRecord(params))
      case 'thread/section/move':
        return this.threadSectionMove(asRecord(params))
      case 'threadSection/list':
        return this.threadSectionList(asRecord(params))
      case 'threadSection/create':
        return this.threadSectionCreate(asRecord(params))
      case 'threadSection/update':
        return this.threadSectionUpdate(asRecord(params))
      case 'threadSection/delete':
        return this.threadSectionDelete(asRecord(params))
      case 'thread/settings/update':
        return this.threadSettingsUpdate(peer, asRecord(params))
      // Intentional no-ops: Claude Code has no equivalent concept, so the
      // adapter acknowledges the call without side effects rather than failing
      // the RPC (which would break the Codex App connection).
      case 'thread/memoryMode/set':
      case 'memory/reset':
        return {}
      case 'thread/unarchive':
        return this.threadArchive(peer, asRecord(params), false)
      case 'thread/compact/start':
        return this.threadCompactStart(peer, asRecord(params))
      case 'thread/shellCommand':
        return this.threadShellCommand(peer, asRecord(params))
      case 'thread/backgroundTerminals/clean':
        return this.threadBackgroundTerminalsClean(asRecord(params))
      case 'thread/backgroundTerminals/list':
        return this.threadBackgroundTerminalsList(asRecord(params))
      case 'thread/backgroundTerminals/terminate':
        return this.threadBackgroundTerminalsTerminate(asRecord(params))
      case 'thread/rollback':
        return this.threadRollback(asRecord(params))
      case 'thread/revert':
        return this.threadRevert(asRecord(params))
      case 'thread/loaded/list':
        return this.threadLoadedList(asRecord(params))
      case 'thread/inject_items':
        return this.threadInjectItems(peer, asRecord(params))
      case 'turn/start':
        // 导进来的会话在命令行里又说过几句：先把那几句画进来，回合接在后面
        await this.nativeHistory(asRecord(params).threadId)
        return this.turnStart(peer, asRecord(params))
      case 'turn/steer':
        return this.turnSteer(peer, asRecord(params))
      case 'turn/settings/update':
        return this.turnSettingsUpdate(asRecord(params))
      case 'turn/interrupt':
        return this.turnInterrupt(peer, asRecord(params))
      // Realtime voice is unsupported: Claude Code has no realtime audio
      // channel. These ack so the App's capability probe does not error; a
      // real session would need a separate audio backend.
      case 'thread/realtime/start':
      case 'thread/realtime/appendAudio':
      case 'thread/realtime/appendText':
      case 'thread/realtime/stop':
        return {}
      case 'thread/realtime/listVoices':
        return { voices: { v1: [], v2: [], defaultV1: null, defaultV2: null } }
      case 'review/start':
        return this.reviewStart(peer, asRecord(params))
      case 'config/read':
        return this.configRead(asRecord(params))
      case 'configRequirements/read':
        return { requirements: null }
      case 'model/list':
        return this.modelList(asRecord(params))
      case 'modelProvider/capabilities/read':
        return {
          imageGeneration: false,
          // Claude Code SDK ships a WebSearch tool. Default to advertising it
          // so Codex App shows the search affordance; CHA_CLAUDE_WEBSEARCH=0
          // turns it off for environments where the tool is rate-limited.
          webSearch: process.env.CHA_CLAUDE_WEBSEARCH !== '0',
        }
      case 'experimentalFeature/list':
        return experimentalFeatureList(
          asRecord(params),
          (id) => this.subscribers.has(id) && this.store.getThread(id) != null,
        )
      case 'permissionProfile/list':
        return permissionProfileList(asRecord(params), this.configOverrides.permissions)
      case 'experimentalFeature/enablement/set':
        return experimentalFeatureSet(asRecord(params))
      case 'collaborationMode/list':
        return {
          data: [
            { name: '直接执行', mode: 'default', model: null, reasoning_effort: null },
            { name: '先做计划', mode: 'plan', model: null, reasoning_effort: null },
          ],
        }
      case 'mock/experimentalMethod':
        return {
          echoed: typeof asRecord(params).value === 'string' ? asRecord(params).value : null,
        }
      case 'skills/list':
        return this.skills.list(peer, asRecord(params), this.skillsCwd(peer))
      case 'skills/extraRoots/set':
        if (this.hasActiveTurns()) throw new ProtocolError(-32009, '活动回合期间不能修改技能目录')
        return this.skills.setRoots(asRecord(params))
      case 'hooks/list':
        return { data: listClaudeHooks(asRecord(params), this.skillsCwd(peer)) }
      case 'marketplace/add':
        return this.marketplaceAdd(asRecord(params))
      case 'marketplace/remove':
        return this.marketplaceRemove(asRecord(params))
      case 'marketplace/upgrade':
        return this.marketplaceUpgrade(asRecord(params))
      case 'plugin/list':
        return { marketplaces: [], marketplaceLoadErrors: [], featuredPluginIds: [] }
      case 'plugin/read':
        return this.pluginRead(asRecord(params))
      case 'plugin/skill/read':
        return { contents: null }
      case 'plugin/share/save':
        return this.pluginShareSave(asRecord(params))
      case 'plugin/share/updateTargets':
        return this.pluginShareUpdateTargets(asRecord(params))
      case 'plugin/share/delete':
      case 'plugin/uninstall':
        return {}
      case 'plugin/install':
        return { authPolicy: 'ON_USE', appsNeedingAuth: [] }
      case 'skills/config/write':
        if (this.hasActiveTurns()) throw new ProtocolError(-32009, '活动回合期间不能修改技能开关')
        return this.skills.write(
          asRecord(params),
          this.skillsCwd(peer),
          asRecord(this.persistedConfigValues().values.skills).config,
          (rules) =>
            this.configWriteResponse(
              {
                keyPath: 'skills.config',
                value: rules.length > 0 ? rules : null,
                mergeStrategy: 'replace',
              },
              false,
            ),
        )
      case 'plugin/share/list':
        return { data: [] }
      // Stub the three RPC methods Codex App may call but our dispatcher
      // previously threw "method not implemented" on. Stubs return the
      // schema-correct empty shape so the App's call sites don't surface an
      // RPC error toast.
      case 'plugin/share/checkout':
        // PluginShareCheckoutResponse — App polls after a share/save; nothing to checkout.
        return {}
      case 'environment/add':
        // EnvironmentAddResponse — adds a workspace environment; we have no concept of one.
        return {}
      case 'attestation/generate':
        // AttestationGenerateResponse — returns a signed blob; clients with
        // requestAttestation:true expect a string. Empty string is permissive.
        return { attestation: '' }
      case 'app/list':
        return { data: [], nextCursor: null }
      case 'mcpServer/oauth/login':
        return this.mcpOAuthLogin(peer, asRecord(params))
      case 'config/mcpServer/reload':
        return this.mcpReload(peer)
      case 'mcpServerStatus/list':
        return this.mcp.statuses(
          this.mcpScope(asRecord(params).threadId),
          asRecord(params),
          this.mcpCallbacks(peer, asRecord(params).threadId),
        )
      case 'mcpServer/resource/read':
      case 'mcpServer/tool/call':
        return this.mcpCall(peer, method, asRecord(params))
      case 'windowsSandbox/setupStart':
        return { started: false }
      case 'windowsSandbox/readiness':
        return { status: 'notConfigured' }
      case 'account/login/start':
        return { type: 'apiKey' }
      case 'account/login/cancel':
        return { status: 'notFound' }
      case 'account/logout':
        return {}
      case 'account/sendAddCreditsNudgeEmail':
        return { status: 'cooldown_active' }
      case 'feedback/upload':
        return { threadId: stringOr(asRecord(params).threadId, '') }
      case 'account/read':
        // Claude 凭据由独立运行时管理，不伪装成 OpenAI 或 Bedrock 登录。
        return { account: null, requiresOpenaiAuth: false }
      case 'account/rateLimits/read':
        return this.accountRateLimits()
      case 'fs/readFile':
      case 'fs/readDirectory':
      case 'fs/getMetadata':
      case 'fs/writeFile':
      case 'fs/createDirectory':
      case 'fs/remove':
      case 'fs/copy':
      case 'fs/watch':
      case 'fs/unwatch':
        return this.filesystem.call(peer, method, asRecord(params))
      case 'command/exec':
        return this.processes.start(peer, 'command', asRecord(params))
      case 'command/exec/write':
        return this.processes.followup(peer, 'command', 'write', asRecord(params))
      case 'command/exec/terminate':
        return this.processes.followup(peer, 'command', 'kill', asRecord(params))
      case 'command/exec/resize':
        return this.processes.followup(peer, 'command', 'resize', asRecord(params))
      case 'process/spawn':
        return this.processes.start(peer, 'process', asRecord(params))
      case 'process/writeStdin':
        return this.processes.followup(peer, 'process', 'write', asRecord(params))
      case 'process/kill':
        return this.processes.followup(peer, 'process', 'kill', asRecord(params))
      case 'process/resizePty':
        return this.processes.followup(peer, 'process', 'resize', asRecord(params))
      case 'externalAgentConfig/detect':
        return { items: [] }
      case 'config/value/write':
      case 'config/batchWrite':
        return this.configWriteResponse(asRecord(params), method === 'config/batchWrite')
      case 'getConversationSummary':
        return this.getConversationSummary(asRecord(params))
      case 'gitDiffToRemote':
        return this.gitDiffToRemote(asRecord(params))
      case 'getAuthStatus':
        return { authMethod: null, authToken: null, requiresOpenaiAuth: false }
      case 'fuzzyFileSearch':
        return this.fuzzySearch.search(asRecord(params))
      case 'fuzzyFileSearch/sessionStart':
        return this.fuzzySessions.start(peer, asRecord(params))
      case 'fuzzyFileSearch/sessionUpdate':
        return this.fuzzySessions.update(peer, asRecord(params))
      case 'fuzzyFileSearch/sessionStop':
        return this.fuzzySessions.stop(asRecord(params))
      default:
        throw new ProtocolError(-32601, `method not implemented: ${method}`)
    }
  }

  private threadStart(peer: RpcPeer, params: Record<string, unknown>): unknown {
    this.loadPersistedConfig()
    const projectId =
      params.projectId == null ? null : requiredString(params.projectId, 'projectId')
    if (projectId !== null) this.store.projects.read(projectId)
    const id = newId()
    const now = nowSeconds()
    const requestedCwd = stringOr(params.cwd, process.cwd())
    const cwd = maybeCreateThreadWorktree(id, requestedCwd).cwd
    const requestedModel = modelFromParams(params, this.configModel)
    // 与 Codex 的 allowProviderModelFallback 一致：Desktop 以自身默认模型（如 gpt-*）新建会话时，
    // 本运行时目录中不可用的模型换成已保存的默认模型，而不是原样记录后在运行时静默改用 CLI 默认。
    const model =
      params.allowProviderModelFallback === true && !isSelectableModel(requestedModel)
        ? this.configModel
        : catalogModelId(requestedModel)
    const reasoningEffort = reasoningEffortFromParams(params, this.configReasoningEffort)
    const requestedProfileId = permissionProfileIdFromParams(params)
    // 请求里没选权限（也没给旧式沙箱）时用配置的 default_permissions，审批策略仍按请求、配置的顺序取
    const permissionProfileId =
      requestedProfileId ??
      (params.sandbox != null || params.sandboxPolicy != null
        ? null
        : defaultPermissionsId(this.configOverrides))
    const permissionProfile = permissionProfilePolicy(
      permissionProfileId,
      this.configOverrides.permissions,
    )
    const selectedProviderLoop = resolveProviderLoopSelection(this.providerLoopSelectionInput())
    const isTitleOrHelper =
      params.ephemeral === true ||
      params.threadSource === 'title_generation' ||
      params.threadSource === 'memory_consolidation'
    const thread: ThreadRecord = {
      id,
      sessionId: id,
      forkedFromId: null,
      isPinned: false,
      sectionId: null,
      sectionEnteredAt: null,
      sectionPosition: null,
      preview: '',
      name: null,
      archived: false,
      cwd,
      model,
      reasoningEffort,
      modelProvider: 'claude-code',
      claudeSessionId: null,
      // v2 SessionSource is camelCase; the old `app_server` falls through to
      // `unknown` on the App side, hiding the source in the thread sidebar.
      source: 'appServer',
      createdAt: now,
      updatedAt: now,
      status: { type: 'idle' },
      approvalPolicy:
        normalizeApprovalPolicy(params.approvalPolicy) ??
        (requestedProfileId ? permissionProfile?.approvalPolicy : null) ??
        normalizeApprovalPolicy(this.configOverrides.approval_policy) ??
        permissionProfile?.approvalPolicy ??
        'on-request',
      sandboxMode:
        permissionProfile?.sandboxMode ??
        sandboxFromTurnParams(params) ??
        normalizeSandboxMode(this.configOverrides.sandbox_mode) ??
        'workspace-write',
      permissionProfileId: permissionProfile?.id ?? null,
      ephemeral: isTitleOrHelper,
      threadSource: normalizeThreadSource(params.threadSource),
      agentRole: nullIfEmpty(typeof params.agentRole === 'string' ? params.agentRole : null),
      agentNickname: nullIfEmpty(
        typeof params.agentNickname === 'string' ? params.agentNickname : null,
      ),
      baseInstructions: nullIfEmpty(
        typeof params.baseInstructions === 'string'
          ? params.baseInstructions
          : typeof this.configOverrides.instructions === 'string'
            ? this.configOverrides.instructions
            : null,
      ),
      developerInstructions: nullIfEmpty(
        typeof params.developerInstructions === 'string'
          ? params.developerInstructions
          : typeof this.configOverrides.developer_instructions === 'string'
            ? this.configOverrides.developer_instructions
            : null,
      ),
      personality: normalizePersonality(params.personality),
      // Pick the runtime backend from the chosen model — picking gpt-* in
      // the App's model dropdown flips the new thread to runtimeBackend
      // 'codex' so turns get forwarded to `codex exec`. Default 'claude'.
      runtimeBackend: 'claude',
      codexSessionId: null,
    }
    this.store.upsertThread(thread)
    if (projectId !== null) this.store.projects.assignThread(id, projectId)
    // 保存创建时实际策略，后续全局默认变化不能扩大已有会话的授权。
    const settings = this.store.threadSettings(id)
    settings.sandboxPolicy = this.configSandboxPolicy(thread.sandboxMode, cwd)
    this.store.saveThreadSettings(id, settings)
    this.saveRuntimeSettings(id, params)
    recordRunEvent('thread.started', {
      threadId: thread.id,
      cwd: thread.cwd,
      model: thread.model,
      runtimeBackend: thread.runtimeBackend,
      threadSource: thread.threadSource,
      ephemeral: thread.ephemeral,
    })
    this.subscribers.add(id, peer)
    this.notify(peer, { method: 'thread/started', params: { thread: this.toThread(thread, []) } })
    return this.threadEnvelope(thread)
  }

  private threadResume(peer: RpcPeer, params: Record<string, unknown>): unknown {
    const threadId = stringOr(params.threadId, '')
    const thread = this.store.getThread(threadId)
    if (!thread) throw new Error('unknown thread: ' + threadId)
    // 恢复之前的设置：这次恢复要是改动了它，别的订阅连接也得知道。
    const settingsBefore = JSON.stringify(this.threadSettingsNotification(thread))
    this.saveRuntimeSettings(threadId, params)
    if (typeof params.cwd === 'string' && params.cwd.length > 0) thread.cwd = params.cwd
    const rawModel = modelFromParams(params, null)
    const model = rawModel ? normalizeSelectableModelId(rawModel, thread.model) : null
    const reasoningEffort = reasoningEffortFromParams(params, null)
    const permissionProfileId = permissionProfileIdFromParams(params)
    const permissionProfile = permissionProfilePolicy(
      permissionProfileId,
      this.configOverrides.permissions,
    )
    if (model) {
      // runtimeBackend is pinned at thread/start. Refuse cross-backend
      // model changes on resume — the conversation history wouldn't carry
      // over between Claude SDK and `codex exec`. App's model picker can
      // still rebind same-backend models (e.g. sonnet → opus).
      const newBackend = isCodexOpenAiModel(model) ? 'codex' : 'claude'
      if (newBackend === thread.runtimeBackend) {
        thread.model = model
      } else {
        debugLog('thread.resume.modelBackendMismatch', {
          threadId,
          oldModel: thread.model,
          newModel: model,
          oldBackend: thread.runtimeBackend,
          newBackend,
        })
      }
    }
    if (reasoningEffort) thread.reasoningEffort = reasoningEffort
    if (permissionProfileId) {
      thread.permissionProfileId = permissionProfileId
      if (params.approvalPolicy != null)
        thread.approvalPolicy = normalizeApprovalPolicy(params.approvalPolicy)
      else if (permissionProfile?.approvalPolicy)
        thread.approvalPolicy = permissionProfile.approvalPolicy
      if (permissionProfile?.sandboxMode) thread.sandboxMode = permissionProfile.sandboxMode
    } else {
      if (hasLegacyPermissionParams(params)) thread.permissionProfileId = null
      if (params.approvalPolicy != null)
        thread.approvalPolicy = normalizeApprovalPolicy(params.approvalPolicy)
      const sandbox = sandboxFromTurnParams(params)
      if (sandbox) thread.sandboxMode = sandbox
    }
    if (typeof params.threadSource === 'string')
      thread.threadSource = normalizeThreadSource(params.threadSource)
    if (typeof params.baseInstructions === 'string')
      thread.baseInstructions = nullIfEmpty(params.baseInstructions)
    if (typeof params.developerInstructions === 'string')
      thread.developerInstructions = nullIfEmpty(params.developerInstructions)
    if (typeof params.personality === 'string')
      thread.personality = normalizePersonality(params.personality)
    this.store.upsertThread(thread)
    recordRunEvent('thread.resumed', {
      threadId,
      cwd: thread.cwd,
      model: thread.model,
      runtimeBackend: thread.runtimeBackend,
      threadSource: thread.threadSource,
      ephemeral: thread.ephemeral,
    })
    // 这条连接已经拿着的提问、审批：应答和用量回放之后再发一次，见 PendingInteractions.resend。
    const held = this.pendingInteractions.heldBy(peer.id, threadId)
    this.subscribers.add(threadId, peer)
    // 恢复时主动回显持久化的计划与审批设置，客户端不能按本地默认值猜测。
    // 回显是给恢复它的这条连接的；这次恢复没有改动设置时，不去打扰已经在看这个线程的别的连接。
    this.threadSettingsUpdate(peer, { threadId }, settingsBefore)
    this.bindPeerToDescendants(peer, threadId)
    this.goals.resume(threadId)
    this.scheduleQueue(threadId)
    this.scheduleGoal(threadId)
    const usage = this.store.threadUsage(threadId)
    // 与原生一致：恢复时回放的用量只发给恢复它的这条连接。
    if (usage)
      setImmediate(() =>
        this.notifyOnly(peer, {
          method: 'thread/tokenUsage/updated',
          params: { threadId, ...usage },
        }),
      )
    if (held.length > 0) setImmediate(() => this.pendingInteractions.resend(peer, held))
    return {
      ...asRecord(
        this.threadEnvelope(
          thread,
          params.excludeTurns === true ? [] : this.store.listTurns(thread.id),
        ),
      ),
      initialTurnsPage:
        params.initialTurnsPage == null
          ? null
          : this.threadTurnsList({ ...asRecord(params.initialTurnsPage), threadId }),
    }
  }

  private async threadFork(peer: RpcPeer, params: Record<string, unknown>): Promise<unknown> {
    const parentId = stringOr(params.threadId, '')
    const parent = this.store.getThread(parentId)
    if (!parent) throw new Error(`unknown thread: ${parentId}`)
    const position = forkPositionFromParams(params)
    // 照上游：截在某一回合之前（beforeTurnId）时，有回合在跑也能分叉，带走的都是已经结束的回合。
    // 原生记录还在被 CLI 写，分叉只截到最后一个保留回合的消息边界，那之前的行早已落盘；
    // SDK 逐行解析、跳过解析不了的行，写了一半的末行读不进来。其余位置照旧要求会话空闲。
    if (this.activeTurnByThread.has(parentId) && position?.kind !== 'before')
      throw new ProtocolError(-32009, '活动会话不能分叉')
    // 位置参数（lastTurnId / beforeTurnId）决定带走哪些回合；源线程的回合、原生会话和进程都不动。
    const parentTurns = this.store.listTurns(parentId)
    const retained = forkRetainedTurns(parentTurns, position)
    const nativeFork = await this.forkNativeHistory(parent, parentTurns, retained)
    const boundaries = this.remapNativeBoundaries(retained, nativeFork)
    const now = nowSeconds()
    const id = newId()
    const requestedCwd = stringOr(params.cwd, parent.cwd)
    const cwd = maybeCreateThreadWorktree(id, requestedCwd).cwd
    // 临时分叉是客户端拿来做杂事的（官方桌面端改名后起描述，带的是它自己的生成模型 gpt-*）：
    // Codex 的模型沿用源会话的。源会话的模型装得下带过来的这段历史，用户的模型服务也一定有它
    const requestedModel = modelFromParams(params, parent.model)
    const model =
      params.ephemeral === true && isForeignModel(requestedModel) ? parent.model : requestedModel
    const thread: ThreadRecord = {
      ...parent,
      id,
      sessionId: id,
      forkedFromId: parent.id,
      // 预览取自第一条用户消息；一个回合都没带过来时留空，由分叉里的第一条消息填。
      preview: position && !retained.length ? '' : parent.preview,
      isPinned: false,
      sectionId: null,
      sectionEnteredAt: null,
      sectionPosition: null,
      archived: false,
      cwd,
      model,
      reasoningEffort: reasoningEffortFromParams(params, parent.reasoningEffort),
      claudeSessionId: nativeFork?.sessionId ?? null,
      createdAt: now,
      updatedAt: now,
      status: { type: 'idle' },
      approvalPolicy:
        params.approvalPolicy != null
          ? normalizeApprovalPolicy(params.approvalPolicy)
          : (permissionProfilePolicy(
              permissionProfileIdFromParams(params),
              this.configOverrides.permissions,
            )?.approvalPolicy ?? parent.approvalPolicy),
      sandboxMode:
        permissionProfilePolicy(
          permissionProfileIdFromParams(params),
          this.configOverrides.permissions,
        )?.sandboxMode ??
        sandboxFromTurnParams(params) ??
        parent.sandboxMode,
      permissionProfileId:
        permissionProfileIdFromParams(params) ??
        (hasLegacyPermissionParams(params) ? null : (parent.permissionProfileId ?? null)),
      // 照上游只看这一次请求：侧聊、改名后起描述的分叉带 ephemeral: true，是临时的；
      // 没带的就是普通会话，从临时会话分出来的也一样
      ephemeral: params.ephemeral === true,
      threadSource:
        typeof params.threadSource === 'string'
          ? normalizeThreadSource(params.threadSource)
          : normalizeThreadSource(parent.threadSource),
      agentRole: nullIfEmpty(
        typeof params.agentRole === 'string' ? params.agentRole : parent.agentRole,
      ),
      agentNickname: nullIfEmpty(
        typeof params.agentNickname === 'string' ? params.agentNickname : parent.agentNickname,
      ),
      baseInstructions: nullIfEmpty(
        typeof params.baseInstructions === 'string'
          ? params.baseInstructions
          : parent.baseInstructions,
      ),
      developerInstructions: nullIfEmpty(
        typeof params.developerInstructions === 'string'
          ? params.developerInstructions
          : parent.developerInstructions,
      ),
      personality:
        typeof params.personality === 'string'
          ? normalizePersonality(params.personality)
          : parent.personality,
      // Fork: model may flip backend (forking from claude-thread with a
      // gpt-* model = new codex-backed thread); otherwise inherit parent.
      runtimeBackend: 'claude',
      codexSessionId: null,
    }
    this.store.upsertThread(thread)
    this.store.saveThreadSettings(id, this.store.threadSettings(parentId))
    const parentProject = this.store.projects.projectId(parentId)
    if (parentProject !== null) this.store.projects.assignThread(id, parentProject)
    const parentGoal = this.store.threadGoal(parentId)
    if (parentGoal && parentGoal.status !== 'active')
      this.store.saveThreadGoal({ ...parentGoal, threadId: id })
    const parentUsage = this.store.threadUsage(parentId)
    this.saveRuntimeSettings(id, params)
    // 按回合存放的数据只跟着带走的回合走：用量记在被切掉的回合上时不带过去。
    for (const turn of retained) {
      const cloned = { ...turn, id: newId(), threadId: id }
      this.store.upsertTurn(cloned)
      if (parentUsage?.turnId === turn.id)
        this.store.saveThreadUsage(id, cloned.id, parentUsage.tokenUsage)
      const boundary = boundaries.get(turn.id)
      if (boundary) this.store.saveNativeBoundary(cloned.id, boundary)
    }
    recordRunEvent('thread.forked', {
      threadId: thread.id,
      parentThreadId: parent.id,
      cwd: thread.cwd,
      model: thread.model,
      runtimeBackend: thread.runtimeBackend,
      threadSource: thread.threadSource,
      ephemeral: thread.ephemeral,
    })
    this.subscribers.add(id, peer)
    this.notify(peer, { method: 'thread/started', params: { thread: this.toThread(thread, []) } })
    return this.threadEnvelope(thread, params.excludeTurns === true ? [] : this.store.listTurns(id))
  }

  /**
   * 扫一遍本机别处开的 Claude Code 会话，登记新的。announce：新登记的告诉所有握手过的连接（和新建会话一样
   * 发 thread/started）；只给后台定时扫到的用，头一遍扫到的不算（那是本来就有的，列表里自然有，
   * 一下子发上百条只是添乱）。扫不了（目录读不了之类）不影响列表：记一笔，照列库里有的
   */
  private async refreshNative(announce = false): Promise<void> {
    if (!this.native) return
    const baseline = !this.native.scanned
    let added: string[]
    let moved: string[]
    try {
      ;({ added, moved } = await this.native.refresh(announce))
    } catch (error) {
      debugLog('native.sessions.refreshFailed', { error: String(error) })
      return
    }
    for (const threadId of added) {
      const thread = this.store.getThread(threadId)
      if (!thread) continue
      const settings = this.store.threadSettings(threadId)
      settings.sandboxPolicy = this.configSandboxPolicy(thread.sandboxMode, thread.cwd)
      this.store.saveThreadSettings(threadId, settings)
      if (announce && !baseline)
        this.announce(
          { method: 'thread/started', params: { thread: this.toThread(thread, []) } },
          undefined,
          (target, notification) => ({
            method: notification.method,
            params: this.withNativeLineage(target, structuredClone(notification.params)),
          }),
        )
    }
    if (added.length > 0) debugLog('native.sessions.imported', { count: added.length })
    // 登记过的会话在 Claude 桌面端的父会话变了：声明了 nativeLineage 的连接再收一次这个会话（客户端按标识换掉），
    // 没声明的连接看不到这个字段，不用打扰。列表时扫到的也发：别的连接没在列表
    if (!baseline)
      for (const threadId of moved) {
        const thread = this.store.getThread(threadId)
        // 归档了的不在列表里，发了反而让客户端把它当成新会话放回侧栏
        if (!thread || thread.ephemeral || thread.archived) continue
        const params = this.withNativeLineage(null, { thread: this.toThread(thread, []) })
        for (const target of this.accountPeers)
          if (
            this.isConnected(target) &&
            this.peerFeatures.get(target)?.extensions.has(EXTENSION.nativeLineage)
          )
            this.deliver(
              target,
              { method: 'thread/started', params: structuredClone(params) },
              target,
            )
      }
  }

  /**
   * 有连接握手过以后，隔一阵扫一次本机的原生会话：别处新开的会话不用等下一次列表就出现。
   * 没有连接的时候不扫
   */
  private watchNative(): void {
    if (!this.native || this.nativeTimer || this.stopped) return
    this.nativeTimer = setInterval(() => {
      if (this.accountPeers.size > 0) void this.refreshNative(true)
    }, NATIVE_WATCH_MS)
    this.nativeTimer.unref()
  }

  /** 导进来的会话：原生记录里还没画进来的部分画进来。会话不认识的先扫一遍（可能是刚在别处开的） */
  private async nativeHistory(threadId: unknown): Promise<void> {
    if (!this.native || typeof threadId !== 'string' || !threadId) return
    if (!this.store.getThread(threadId)) await this.refreshNative()
    try {
      await this.native.history(threadId)
    } catch (error) {
      debugLog('native.sessions.historyFailed', { threadId, error: String(error) })
    }
  }

  /** 给一个本机别处开的 Claude Code 会话建记录：模型、权限照新建会话的默认来 */
  private nativeThreadRecord(fields: {
    id: string
    cwd: string
    preview: string
    name: string | null
    createdAt: number
    updatedAt: number
  }): ThreadRecord {
    return {
      ...fields,
      sessionId: fields.id,
      forkedFromId: null,
      isPinned: false,
      sectionId: null,
      sectionEnteredAt: null,
      sectionPosition: null,
      archived: false,
      model: this.configModel,
      reasoningEffort: this.configReasoningEffort,
      modelProvider: 'claude-code',
      claudeSessionId: fields.id,
      source: 'cli',
      status: { type: 'idle' },
      approvalPolicy: normalizeApprovalPolicy(this.configOverrides.approval_policy) ?? 'on-request',
      sandboxMode: normalizeSandboxMode(this.configOverrides.sandbox_mode) ?? 'workspace-write',
      permissionProfileId: null,
      ephemeral: false,
      threadSource: null,
      agentRole: null,
      agentNickname: null,
      baseInstructions: null,
      developerInstructions: null,
      personality: null,
      runtimeBackend: 'claude',
      codexSessionId: null,
    }
  }

  private threadList(params: Record<string, unknown>): unknown {
    const parentThreadId =
      typeof params.parentThreadId === 'string' && params.parentThreadId.length > 0
        ? params.parentThreadId
        : null
    const ancestorThreadId =
      typeof params.ancestorThreadId === 'string' && params.ancestorThreadId.length > 0
        ? params.ancestorThreadId
        : null
    if (parentThreadId != null && ancestorThreadId != null)
      throw new ProtocolError(-32600, 'parentThreadId 与 ancestorThreadId 不能同时指定')
    // 与 Codex 原生一致：不指定来源时只列用户自己的线程，子代理线程不混进普通列表；
    // 按父线程或祖先线程查且不指定来源时不限来源。
    const sourceKinds = Array.isArray(params.sourceKinds)
      ? params.sourceKinds.filter((value): value is string => typeof value === 'string')
      : parentThreadId != null || ancestorThreadId != null
        ? undefined
        : []
    const sortKey =
      params.sortKey === 'updated_at' ||
      params.sortKey === 'recency_at' ||
      params.sortKey === 'section_position'
        ? params.sortKey
        : 'created_at'
    if (
      params.sortKey != null &&
      !['created_at', 'updated_at', 'recency_at', 'section_position'].includes(
        String(params.sortKey),
      )
    )
      throw new ProtocolError(-32602, 'sortKey 无效')
    const isPinned = typeof params.isPinned === 'boolean' ? params.isPinned : null
    const sectionId =
      params.sectionId === null
        ? null
        : typeof params.sectionId === 'string'
          ? params.sectionId
          : undefined
    const modelProviders = Array.isArray(params.modelProviders)
      ? params.modelProviders.filter((value): value is string => typeof value === 'string')
      : []
    // 0.163.0 起：最多 100 个，不合法就拒绝，不截断（照上游）
    const excludedThreadIds = params.excludedThreadIds ?? []
    if (!Array.isArray(excludedThreadIds) || excludedThreadIds.length > 100)
      throw new ProtocolError(-32602, 'excludedThreadIds accepts at most 100 entries')
    for (const id of excludedThreadIds) requiredString(id, 'excludedThreadIds 的每一项')
    const filters = {
      archived: (params.archived as boolean | null | undefined) ?? null,
      projectId:
        params.projectId === undefined
          ? undefined
          : params.projectId === null
            ? null
            : requiredString(params.projectId, 'projectId'),
      isPinned,
      sectionId,
      cwd:
        typeof params.cwd === 'string' || Array.isArray(params.cwd)
          ? (params.cwd as string | string[])
          : null,
      includeEphemeral: params.includeEphemeral === true,
      // 照上游的状态库（push_thread_filters_with_preview）：还没说过话（预览为空）的会话不列，
      // 看归档的、按父会话或祖先会话查的、指定了某个分区（置顶也是）的照列。官方桌面端在新对话页上
      // 会先建一个空会话、一阵子没用就删，这种会话不该出现在别的客户端的列表里
      requirePreview:
        params.archived !== true &&
        parentThreadId == null &&
        ancestorThreadId == null &&
        typeof sectionId !== 'string' &&
        isPinned !== true,
      parentThreadId,
      ancestorThreadId,
      sourceKinds,
      sortKey,
      modelProviders,
      searchTerm: typeof params.searchTerm === 'string' ? params.searchTerm : null,
      // 排好序再进游标的散列：同一组排除换个顺序还是同一个查询
      excludedThreadIds: [...(excludedThreadIds as string[])].sort(),
    }
    const pagination = catalogPagination(params, submissionHash(filters))
    const found = this.store.listThreads({
      ...filters,
      sortKey,
      sortDirection: pagination.sortDirection,
      cursor: pagination.cursor,
      limit: pagination.limit + 1,
    })
    const threads = found.slice(0, pagination.limit)
    const last = threads.at(-1)
    const cursorValue = (thread: ThreadRecord): number =>
      sortKey === 'section_position'
        ? (thread.sectionPosition ?? thread.createdAt)
        : sortKey === 'created_at'
          ? thread.createdAt
          : thread.updatedAt
    return {
      data: threads.map((thread) => this.toThread(thread, [])),
      nextCursor:
        last && found.length > pagination.limit
          ? pagination.encode(cursorValue(last), last.id)
          : null,
      backwardsCursor: threads[0]
        ? pagination.encode(cursorValue(threads[0]), threads[0].id, true)
        : null,
    }
  }

  private threadSectionMove(params: Record<string, unknown>): unknown {
    const threadId = stringOr(params.threadId, '')
    if (params.sectionId !== null && typeof params.sectionId !== 'string')
      throw new Error('sectionId must be a string or null')
    const sectionId = params.sectionId === null ? null : params.sectionId
    if (sectionId === '') throw new Error('sectionId must not be empty')
    const beforeThreadId =
      typeof params.beforeThreadId === 'string' && params.beforeThreadId.length > 0
        ? params.beforeThreadId
        : null
    const moved = this.store.moveThreadToSection(threadId, sectionId, beforeThreadId)
    debugLog('thread.section.moved', {
      threadId,
      sectionId: moved.sectionId ?? null,
      isPinned: moved.isPinned === true,
      beforeThreadId,
    })
    return {}
  }

  private threadSectionList(params: Record<string, unknown>): unknown {
    const requestedLimit = numberOr(params.limit, 100)
    const limit = Number.isFinite(requestedLimit)
      ? Math.max(1, Math.min(Math.floor(requestedLimit), 200))
      : 100
    const offset = typeof params.cursor === 'string' ? Number(params.cursor) : 0
    if (!Number.isSafeInteger(offset) || offset < 0) throw new Error('invalid section cursor')
    const sections = this.store.listSections(limit, String(offset))
    const nextOffset = offset + sections.length
    const hasMore = this.store.listSections(1, String(nextOffset)).length > 0
    return { data: sections, nextCursor: hasMore ? String(nextOffset) : null }
  }

  private threadSectionCreate(params: Record<string, unknown>): unknown {
    const name = stringOr(params.name, '')
    const section = this.store.createSection(
      newId(),
      name,
      this.sectionAppearance(params.appearance),
    )
    return { section }
  }

  private threadSectionUpdate(params: Record<string, unknown>): unknown {
    const sectionId = stringOr(params.sectionId, '')
    const existing = this.store.getSection(sectionId)
    if (!existing) throw new Error(`unknown section: ${sectionId}`)
    const name = typeof params.name === 'string' ? params.name : existing.name
    const appearance =
      params.appearance === undefined
        ? existing.appearance
        : this.sectionAppearance(params.appearance)
    return { section: this.store.updateSection(sectionId, name, appearance) }
  }

  private threadSectionDelete(params: Record<string, unknown>): unknown {
    this.store.deleteSection(stringOr(params.sectionId, ''))
    return {}
  }

  private sectionAppearance(value: unknown): ThreadSectionAppearance | null {
    if (value == null) return null
    const record = asRecord(value)
    return {
      color: typeof record.color === 'string' ? record.color : null,
      icon: typeof record.icon === 'string' ? record.icon : null,
    }
  }

  private threadRead(params: Record<string, unknown>): unknown {
    const threadId = requiredString(params.threadId, 'threadId')
    const thread = this.store.getThread(threadId)
    // 话术照上游：桌面端找会话在哪台机器上时拿别处的会话号来问，按这句认“这里没有”（ThreadNotFound）
    if (!thread) throw new ThreadNotFound(threadId)
    // Codex cc hydrates the Subagent panel with includeTurns:false. A
    // parent-linked child with no renderable turns is treated by that client
    // as still loading, and it does not reliably follow up with turns/list.
    // Keep metadata-only reads for ordinary threads, but return the small
    // child transcript so Prompt/Response and the terminal state can render.
    const includeTurns = params.includeTurns !== false || thread.threadSource === 'subagent'
    const turns = includeTurns ? this.store.listTurns(threadId) : []
    return { thread: this.toThread(thread, turns) }
  }

  private threadTurnsList(params: Record<string, unknown>): unknown {
    const threadId = requiredString(params.threadId, 'threadId')
    if (!this.store.getThread(threadId)) throw new ProtocolError(-32602, '未知会话')
    const itemsView = turnItemsView(params.itemsView)
    const page = pageRecords(
      this.store.listTurns(threadId),
      params,
      `turns:${threadId}`,
      (turn) => turn.id,
    )
    return { ...page, data: page.data.map((turn) => this.toTurnView(turn, itemsView)) }
  }

  private threadItemsList(params: Record<string, unknown>): unknown {
    const threadId = requiredString(params.threadId, 'threadId')
    if (!this.store.getThread(threadId)) throw new ProtocolError(-32602, '未知会话')
    return pageThreadItems(threadId, this.store.listTurns(threadId), {
      ...params,
      sortDirection: params.sortDirection ?? 'asc',
    })
  }

  // thread/items/read（0.163.0 起，实验性）：按条目号取一个回合里的条目，按存储顺序给，找不到的跳过。
  private threadItemsRead(params: Record<string, unknown>): unknown {
    const threadId = requiredString(params.threadId, 'threadId')
    const turnId = requiredString(params.turnId, 'turnId')
    const ids = params.itemIds
    if (
      !Array.isArray(ids) ||
      ids.length < 1 ||
      ids.length > 100 ||
      ids.some((id) => typeof id !== 'string')
    )
      throw new ProtocolError(-32600, 'itemIds must contain 1 to 100 IDs')
    if (!this.store.getThread(threadId)) throw new ThreadNotFound(threadId)
    const wanted = new Set(ids as string[])
    const turn = this.store.listTurns(threadId).find((candidate) => candidate.id === turnId)
    return {
      data: (turn?.items ?? [])
        .filter((item) => wanted.has(item.id))
        .map((item) => ({ turnId, item })),
    }
  }

  private saveRuntimeSettings(threadId: string, params: Record<string, unknown>): void {
    const settings = this.store.threadSettings(threadId)
    const thread = this.store.getThread(threadId)
    if (!thread) throw new ProtocolError(-32602, '未知会话')
    const cwd = typeof params.cwd === 'string' ? params.cwd : thread.cwd
    settings.sandboxPolicy = policyFromParams(
      params,
      cwd,
      settings.sandboxPolicy ?? defaultSandboxPolicy(thread.sandboxMode, cwd),
    )
    applyPermissionProfile(
      settings,
      params,
      thread.permissionProfileId,
      cwd,
      this.configOverrides.permissions,
    )
    const mode = asRecord(params.collaborationMode).mode
    if (mode === 'plan' || mode === 'default') settings.planMode = mode === 'plan'
    else if (typeof params.planMode === 'boolean') settings.planMode = params.planMode
    if (params.historyMode != null) {
      if (params.historyMode !== 'legacy' && params.historyMode !== 'paginated')
        throw new ProtocolError(-32602, 'historyMode 无效')
      settings.historyMode = params.historyMode
    }
    if (params.dynamicTools != null) {
      if (!Array.isArray(params.dynamicTools))
        throw new ProtocolError(-32602, 'dynamicTools 必须是数组')
      settings.dynamicTools = params.dynamicTools
    }
    if (params.config != null) {
      settings.config = asRecord(params.config)
      // 写错了当场报，不等到跑命令
      this.shellEnvironmentPolicy(settings.config)
    }
    this.store.saveThreadSettings(threadId, settings)
  }

  private threadTurnItemsList(params: Record<string, unknown>): unknown {
    const turnId = stringOr(params.turnId, '')
    const turn = this.store.getTurn(turnId)
    return {
      data: turn?.items ?? [],
      nextCursor: null,
      backwardsCursor: null,
    }
  }

  private threadNameSet(params: Record<string, unknown>): unknown {
    const threadId = requiredString(params.threadId, 'threadId')
    if (!this.store.getThread(threadId)) throw new ProtocolError(-32602, '未知会话')
    const name = params.name == null ? null : String(params.name)
    this.titleChecks.set(threadId, Number.POSITIVE_INFINITY)
    this.store.updateThreadName(threadId, name)
    this.notifyThread(threadId, {
      method: 'thread/name/updated',
      params: { threadId, threadName: name ?? undefined },
    })
    return {}
  }

  private async threadArchive(
    caller: RpcPeer,
    params: Record<string, unknown>,
    archived: boolean,
  ): Promise<unknown> {
    const threadId = requiredString(params.threadId, 'threadId')
    if (!this.store.getThread(threadId)) throw new ProtocolError(-32602, '未知会话')
    this.store.setArchived(threadId, archived)
    if (archived) {
      this.scheduledGoals.delete(threadId)
      // 占着这个线程的进程的回合也可能是子线程的追问，一并打断。
      const holder = this.sessionHolder(threadId)
      if (holder)
        await this.turnInterrupt(this.subscribers.first(holder.threadId) ?? caller, holder)
      await this.runtime.closeSession?.(threadId, '会话已归档')
    }
    // 照上游：先回应答，再广播（rust-v0.162.0-alpha.20 的 thread_archive、thread_unarchive）
    setImmediate(() =>
      this.notifyThread(threadId, {
        method: archived ? 'thread/archived' : 'thread/unarchived',
        params: { threadId },
      }),
    )
    if (!archived) {
      const thread = this.store.getThread(threadId)
      if (!thread) throw new Error(`unknown thread: ${threadId}`)
      return { thread: this.toThread(thread, this.store.listTurns(threadId)) }
    }
    this.clearThreadState(threadId)
    return {}
  }

  // Drops per-thread in-memory state (session-scoped command approvals,
  // elicitation counts) so an archived thread does not
  // leak entries for the lifetime of the process.
  private clearThreadState(threadId: string): void {
    this.scheduledQueues.delete(threadId)
    this.commandSessionAllow.delete(threadId)
    this.permissionSessionGrants.delete(threadId)
    this.elicitationCounts.delete(threadId)
  }

  private threadUnsubscribe(peer: RpcPeer, params: Record<string, unknown>): unknown {
    const threadId = stringOr(params.threadId, '')
    // 只摘掉这一条连接；别的订阅连接照常。
    if (!this.subscribers.remove(threadId, peer)) return { status: 'notSubscribed' }
    // 与原生一致：线程在没有任何订阅连接之后才算关闭。还有别的连接在看时它仍然是加载着的，
    // 不发 thread/closed；最后一个订阅者退订时发，和只有一条连接时一样。
    if (!this.subscribers.has(threadId)) {
      this.notify(peer, { method: 'thread/closed', params: { threadId } })
      this.scheduleEphemeralUnload(threadId)
    }
    return { status: 'unsubscribed' }
  }

  // 临时会话照上游的卸载走（thread_lifecycle.rs：没有订阅者、也不在跑了，过 thread_unload_delay，默认 60 秒）：
  // 上游的临时会话不写盘，卸载了就没了。这里卸载时把库里的记录删掉，CLI 写下的会话记录也删掉（CLI 总会写，
  // 不删的话 `claude --resume` 里会多出一堆起标题、起描述、侧聊的会话，起描述的分叉每次还是整段历史的一份拷贝）。
  // 时限之内又有连接订阅（恢复、发消息）就留着；退订、断开、回合结束时各来一次，后者从头计时。
  private scheduleEphemeralUnload(threadId: string, restart = false): void {
    if (this.stopped) return
    const pending = this.ephemeralUnloads.get(threadId)
    if (pending && !restart) return
    if (this.store.getThread(threadId)?.ephemeral !== true || this.subscribers.has(threadId)) return
    if (pending) clearTimeout(pending)
    const timer = setTimeout(() => {
      this.ephemeralUnloads.delete(threadId)
      void this.unloadEphemeral(threadId).catch((error: unknown) =>
        debugLog('thread.ephemeral.unloadFailed', { threadId, error: String(error) }),
      )
    }, ephemeralUnloadDelayMs())
    timer.unref()
    this.ephemeralUnloads.set(threadId, timer)
  }

  private async unloadEphemeral(threadId: string): Promise<void> {
    if (this.stopped || this.store.getThread(threadId)?.ephemeral !== true) return
    if (this.subscribers.has(threadId)) return
    // 还在跑（含借它进程的追问回合）：回合收尾时（clearActiveTurn）再来。打断、变更原生会话这类没有收尾回调的，过一会儿再看
    if (this.sessionHolder(threadId)) return
    if (this.interruptingByThread.has(threadId) || this.nativeMutations.has(threadId)) {
      setTimeout(() => this.scheduleEphemeralUnload(threadId), 1_000).unref()
      return
    }
    // 卸载期间这个会话上的请求都先拒掉（“原生会话正在变更”），之后就是找不到会话
    this.nativeMutations.add(threadId)
    let removed: ThreadRecord | null = null
    try {
      await this.runtime.closeSession?.(threadId, '临时会话已卸载')
      const thread = this.store.getThread(threadId)
      if (this.stopped || !thread || this.subscribers.has(threadId)) return
      this.store.deleteThread(threadId)
      this.subscribers.clear(threadId)
      this.clearThreadState(threadId)
      removed = thread
      debugLog('thread.ephemeral.unloaded', { threadId })
    } finally {
      this.nativeMutations.delete(threadId)
    }
    if (removed?.claudeSessionId)
      await this.deleteNativeTranscript(removed.claudeSessionId, removed.cwd)
  }

  // 入口启动时库里的临时会话都是上次留下的（没到时限就退出了）：没有连接能再订阅它们，照卸载的规矩删掉。
  // 它们的子代理会话也是临时的，一起删；子代理的会话记录在父会话的记录下面，跟着删。
  private discardLeftoverEphemeral(): void {
    const leftovers = this.store.ephemeralThreads()
    for (const thread of leftovers) this.store.deleteThread(thread.id)
    if (leftovers.length === 0) return
    debugLog('thread.ephemeral.leftovers', { count: leftovers.length })
    void (async () => {
      for (const thread of leftovers)
        if (thread.claudeSessionId)
          await this.deleteNativeTranscript(thread.claudeSessionId, thread.cwd)
    })()
  }

  private async deleteNativeTranscript(sessionId: string, cwd: string): Promise<void> {
    try {
      await this.runtime.deleteSession?.(sessionId, cwd)
    } catch (error) {
      // 没写过（还没跑过回合）或者已经没了：没什么可删的
      debugLog('thread.ephemeral.transcriptNotDeleted', { sessionId, error: String(error) })
    }
  }

  private threadLoadedList(params: Record<string, unknown>): unknown {
    const loaded = this.subscribers.threads().sort()
    const { data, nextCursor } = pageRecords(
      loaded,
      { ...params, sortDirection: 'asc' },
      'loaded-threads',
      (id) => id,
    )
    return { data, nextCursor }
  }

  private async recoverContextInjection(threadId: string): Promise<void> {
    const pending = this.store.pendingContextInjection(threadId)
    if (!pending) return
    if (this.store.getThread(threadId)?.runtimeBackend !== 'claude')
      throw new ProtocolError(-32004, 'Claude 入口不能追加其他引擎的会话上下文')
    if (!this.runtime.appendContext)
      throw new ProtocolError(-32004, '当前运行时不支持真实上下文追加')
    try {
      const result = await this.runtime.appendContext(pending)
      this.store.commitContextInjection(pending, result.boundary)
    } catch (error) {
      // 不支持的后端没有启动原生进程，不留下永久阻塞的待确认记录。
      if (error instanceof ProtocolError && error.code === -32004)
        this.store.discardContextInjection(pending.messageId)
      throw error
    }
  }

  private async threadInjectItems(
    _peer: RpcPeer,
    params: Record<string, unknown>,
  ): Promise<unknown> {
    const threadId = requiredString(params.threadId, 'threadId')
    const thread = this.store.getThread(threadId)
    if (!thread) throw new ProtocolError(-32602, '未知会话')
    if (thread.runtimeBackend !== 'claude')
      throw new ProtocolError(-32004, 'Claude 入口不能追加其他引擎的会话上下文')
    const messages = parseContextItems(params.items).map((message) => ({
      ...message,
      uuid: newId(),
    }))
    if (!this.runtime.appendContext)
      throw new ProtocolError(-32004, '当前运行时不支持真实上下文追加')
    const turns = this.store.listTurns(threadId)
    if (
      this.activeTurnByThread.has(threadId) ||
      this.interruptingByThread.has(threadId) ||
      turns.some((turn) => turn.status === 'inProgress')
    )
      throw new ProtocolError(-32009, '活动或尚未确认的会话不能追加上下文')
    // 所有 items 先完整校验，相邻同角色的合成一条原生消息，整批在一次 CLI 输入里追加；
    // 落盘对账按每条的 uuid（见 persistedContextBoundary）。照上游不生成回合、不发通知。
    this.store.beginContextInjection(
      {
        threadId,
        cwd: thread.cwd,
        model: resolveClaudeModel(thread.model),
        sessionId: thread.claudeSessionId ?? newId(),
        existingSession: !!thread.claudeSessionId,
        messageId: newId(),
        messages,
      },
      turns.at(-1)?.id ?? null,
    )
    await this.recoverContextInjection(threadId)
    debugLog('thread.inject_items', { threadId, count: (params.items as unknown[]).length })
    return {}
  }

  private threadGoalSet(peer: RpcPeer, params: Record<string, unknown>): unknown {
    const threadId = this.goalThreadID(params)
    const goal = this.goals.patch(threadId, params)
    // 照上游（state/src/extract.rs 的 ThreadGoalUpdated）：还没说过话的会话，目标就是它的预览，
    // 只在预览为空时填。不然只设了目标的会话，预览会是续跑回合那句内部提示
    const thread = this.store.getThread(threadId)
    if (thread && !thread.preview) {
      thread.preview = goal.objective.slice(0, 200)
      this.store.upsertThread(thread)
    }
    this.subscribers.add(threadId, peer)
    setImmediate(() => this.goalUpdated(threadId, goal))
    this.scheduleGoal(threadId)
    return { goal }
  }

  private threadGoalGet(params: Record<string, unknown>): unknown {
    return { goal: this.store.threadGoal(this.goalThreadID(params, true)) }
  }

  private threadGoalClear(params: Record<string, unknown>): unknown {
    const threadId = this.goalThreadID(params)
    const cleared = this.goals.clear(threadId)
    this.scheduledGoals.delete(threadId)
    if (cleared)
      setImmediate(() =>
        this.notifyThread(threadId, { method: 'thread/goal/cleared', params: { threadId } }),
      )
    return { cleared }
  }

  private goalThreadID(params: Record<string, unknown>, allowArchived = false): string {
    const threadId = requiredString(params.threadId, 'threadId')
    const thread = this.store.getThread(threadId)
    if (!thread) throw new ProtocolError(-32602, '未知会话')
    // 归档保留元数据查询契约，但不允许修改目标或从归档态启动续跑。
    if (thread.archived && !allowArchived) throw new ProtocolError(-32600, '会话已归档')
    return threadId
  }

  private goalUpdated(threadId: string, goal: ThreadGoal | null): void {
    if (goal)
      this.notifyThread(threadId, { method: 'thread/goal/updated', params: { threadId, goal } })
  }

  private finishGoal(
    threadId: string,
    turnId: string,
    status: 'completed' | 'interrupted' | 'failed',
  ): void {
    const limited = this.goalUsageLimited.delete(turnId)
    this.goalUpdated(threadId, this.goals.finish(threadId, turnId, status, limited))
  }

  private scheduleGoal(threadId: string): void {
    if (this.stopped || this.scheduledGoals.has(threadId) || !this.goals.runnable(threadId)) return
    const generation = this.store.goalState(threadId).ledger.generation
    this.scheduledGoals.set(threadId, generation)
    setImmediate(() => {
      if (this.scheduledGoals.get(threadId) !== generation) return
      this.scheduledGoals.delete(threadId)
      // 续跑的回合没有发起它的请求：由最早订阅的那条连接代表，通知照常发给全部订阅连接。
      const peer = this.subscribers.first(threadId)
      if (
        !peer ||
        this.stopped ||
        this.activeTurnByThread.has(threadId) ||
        this.interruptingByThread.has(threadId) ||
        this.nativeMutations.has(threadId) ||
        this.store.pendingContextInjection(threadId) ||
        !this.goals.runnable(threadId) ||
        this.store.goalState(threadId).ledger.generation !== generation
      )
        return
      if (this.store.hasUncertainTools(threadId)) {
        this.goalUpdated(threadId, this.goals.patch(threadId, { status: 'blocked' }))
        this.notifyThread(threadId, {
          method: 'warning',
          params: {
            threadId,
            message: '存在结果未确认的工具副作用，目标不能自动恢复。请先核对执行结果。',
          },
        })
        return
      }
      if (this.store.queue.list(threadId).length > 0) {
        this.scheduleQueue(threadId)
        return
      }
      // 始终复用真实提交、SDK 会话和审批链路；不注入预制助手历史。
      void this.turnStart(peer, {
        threadId,
        input: [{ type: 'text', text: '继续执行当前持续目标；完成后使用目标工具确认完成。' }],
        clientUserMessageId: 'goal:' + generation + ':' + newId(),
      }).catch((error) => {
        if (this.stopped) return
        this.goalUpdated(threadId, this.goals.patch(threadId, { status: 'blocked' }))
        this.notifyThread(threadId, {
          method: 'warning',
          params: { threadId, message: String(error) },
        })
      })
    })
  }

  private async startQueuedTurn(peer: RpcPeer, params: Record<string, unknown>): Promise<unknown> {
    const threadId = requiredString(params.threadId, 'threadId')
    const thread = this.store.getThread(threadId)
    if (!thread) throw new ProtocolError(-32602, '未知会话')
    if (thread.archived) throw new ProtocolError(-32600, '会话已归档')
    const item =
      params.queuedSubmissionId == null
        ? this.store.queue.list(threadId)[0]
        : this.store.queue.get(
            threadId,
            requiredString(params.queuedSubmissionId, 'queuedSubmissionId'),
          )
    if (!item) throw new ProtocolError(-32602, '待执行队列项不存在')
    const result = await this.turnStart(
      peer,
      {
        threadId,
        input: item.input,
        clientUserMessageId: item.clientUserMessageId,
      },
      item.id,
    )
    this.notify(peer, { method: 'thread/queue/changed', params: { threadId } })
    return result
  }

  private scheduleQueue(threadId: string): void {
    if (this.stopped || this.scheduledQueues.has(threadId)) return
    const generation = newId()
    this.scheduledQueues.set(threadId, generation)
    setImmediate(() => {
      if (this.scheduledQueues.get(threadId) !== generation) return
      this.scheduledQueues.delete(threadId)
      const peer = this.subscribers.first(threadId)
      const thread = this.store.getThread(threadId)
      if (
        !peer ||
        !thread ||
        thread.archived ||
        this.stopped ||
        this.activeTurnByThread.has(threadId) ||
        this.interruptingByThread.has(threadId) ||
        this.nativeMutations.has(threadId) ||
        this.store.pendingContextInjection(threadId) ||
        this.store.queue.list(threadId).length === 0
      )
        return
      if (this.store.hasUncertainTools(threadId)) {
        this.notifyThread(threadId, {
          method: 'warning',
          params: {
            threadId,
            message: '存在结果未确认的工具副作用，队列不能自动恢复。请先核对执行结果。',
          },
        })
        return
      }
      // 使用普通提交的原子账本及执行链路，失败保留待办，不自动重试工具。
      void this.startQueuedTurn(peer, { threadId }).catch((error) => {
        if (!this.stopped)
          this.notifyThread(threadId, {
            method: 'warning',
            params: { threadId, message: String(error) },
          })
      })
    })
  }

  private threadAdjustElicitation(params: Record<string, unknown>, delta: number): unknown {
    const threadId = stringOr(params.threadId, '')
    const next = Math.max(0, (this.elicitationCounts.get(threadId) ?? 0) + delta)
    this.elicitationCounts.set(threadId, next)
    return { count: next, paused: next > 0 }
  }

  private threadMetadataUpdate(params: Record<string, unknown>): unknown {
    const threadId = requiredString(params.threadId, 'threadId')
    const thread = this.store.getThread(threadId)
    if (!thread) throw new ProtocolError(-32602, '未知会话')
    const projectId =
      params.projectId == null
        ? undefined
        : params.projectId === ''
          ? null
          : requiredString(params.projectId, 'projectId')
    if (projectId != null) this.store.projects.read(projectId)
    const settings = this.store.threadSettings(threadId)
    const gitInfo = patchGitInfo(settings.gitInfo, params.gitInfo)

    // 元数据更新也必须保存完整权限策略，不能只修改展示档位。
    const rawModel = modelFromParams(params, null)
    const model = rawModel ? normalizeSelectableModelId(rawModel, thread.model) : null
    const reasoningEffort = reasoningEffortFromParams(params, null)
    if (model) {
      const newBackend = isCodexOpenAiModel(model) ? 'codex' : 'claude'
      thread.runtimeBackend = newBackend
      thread.model = model
    }
    if (reasoningEffort) thread.reasoningEffort = reasoningEffort
    const permissionProfileId = permissionProfileIdFromParams(params)
    const permissionProfile = permissionProfilePolicy(
      permissionProfileId,
      this.configOverrides.permissions,
    )
    if (permissionProfileId) thread.permissionProfileId = permissionProfileId
    else if (hasLegacyPermissionParams(params)) thread.permissionProfileId = null
    if (permissionProfile?.approvalPolicy) thread.approvalPolicy = permissionProfile.approvalPolicy
    if (permissionProfile?.sandboxMode) thread.sandboxMode = permissionProfile.sandboxMode
    if (params.approvalPolicy != null)
      thread.approvalPolicy = normalizeApprovalPolicy(params.approvalPolicy)
    const sandboxMode = sandboxFromTurnParams(params)
    if (sandboxMode && !permissionProfile) thread.sandboxMode = sandboxMode
    if (typeof params.isPinned === 'boolean') {
      const currentlyPinned = thread.sectionId === PINNED_SECTION_ID || thread.isPinned === true
      if (currentlyPinned !== params.isPinned) {
        const moved = this.store.moveThreadToSection(
          threadId,
          params.isPinned ? PINNED_SECTION_ID : null,
          null,
        )
        thread.isPinned = moved.isPinned
        thread.sectionId = moved.sectionId
        thread.sectionEnteredAt = moved.sectionEnteredAt
        thread.sectionPosition = moved.sectionPosition
      }
    }
    if (typeof params.baseInstructions === 'string')
      thread.baseInstructions = nullIfEmpty(params.baseInstructions)
    if (typeof params.developerInstructions === 'string')
      thread.developerInstructions = nullIfEmpty(params.developerInstructions)
    if (typeof params.personality === 'string')
      thread.personality = normalizePersonality(params.personality)

    thread.updatedAt = nowSeconds()
    this.store.upsertThread(thread)
    if (Object.hasOwn(params, 'gitInfo')) {
      settings.gitInfo = gitInfo ?? null
      this.store.saveThreadSettings(threadId, settings)
    }
    this.saveRuntimeSettings(threadId, params)

    if (projectId !== undefined && this.store.projects.assignThread(threadId, projectId))
      this.threadProjectUpdated(threadId, projectId)
    return this.threadEnvelope(thread, this.store.listTurns(threadId))
  }

  private threadProjectUpdated(threadId: string, projectId: string | null): void {
    setImmediate(() =>
      this.notifyThread(threadId, {
        method: 'thread/project/updated',
        params: { threadId, projectId },
      }),
    )
  }

  // unchangedFrom：恢复线程时传入恢复之前的设置通知。恢复没有改动设置时，回显只发给恢复它的这条连接。
  private threadSettingsUpdate(
    peer: RpcPeer,
    params: Record<string, unknown>,
    unchangedFrom?: string,
  ): unknown {
    const threadId = stringOr(params.threadId, '')
    const thread = this.store.getThread(threadId)
    if (!thread) throw new Error(`unknown thread: ${threadId}`)

    // Codex App sends model and effort changes through this RPC. Keep these
    // legacy settings fields in the compatibility handler so removing the
    // duplicate dispatch case does not silently disable profile/model
    // switching for existing clients.
    const rawModel = modelFromParams(params, null)
    const model = rawModel ? normalizeSelectableModelId(rawModel, thread.model) : null
    if (model) {
      thread.runtimeBackend = isCodexOpenAiModel(model) ? 'codex' : 'claude'
      thread.model = model
    }
    const reasoningEffort = reasoningEffortFromParams(params, null)
    if (reasoningEffort) thread.reasoningEffort = reasoningEffort
    if (typeof params.personality === 'string')
      thread.personality = normalizePersonality(params.personality)
    const collaborationMode = asRecord(params.collaborationMode)
    const collaborationSettings = asRecord(collaborationMode.settings)
    const developerInstructions =
      typeof collaborationSettings.developer_instructions === 'string'
        ? collaborationSettings.developer_instructions
        : typeof collaborationSettings.developerInstructions === 'string'
          ? collaborationSettings.developerInstructions
          : null
    if (developerInstructions !== null)
      thread.developerInstructions = nullIfEmpty(developerInstructions)

    const permissionProfileId = permissionProfileIdFromParams(params)
    const permissionProfile = permissionProfilePolicy(
      permissionProfileId,
      this.configOverrides.permissions,
    )
    if (permissionProfileId) thread.permissionProfileId = permissionProfileId
    else if (hasLegacyPermissionParams(params)) thread.permissionProfileId = null
    if (permissionProfile?.approvalPolicy) thread.approvalPolicy = permissionProfile.approvalPolicy
    if (permissionProfile?.sandboxMode) thread.sandboxMode = permissionProfile.sandboxMode
    if (params.approvalPolicy != null)
      thread.approvalPolicy = normalizeApprovalPolicy(params.approvalPolicy)
    const sandboxMode = sandboxFromTurnParams(params)
    if (sandboxMode && !permissionProfile) thread.sandboxMode = sandboxMode
    if (typeof params.cwd === 'string' && params.cwd.length > 0) thread.cwd = params.cwd
    this.store.upsertThread(thread)
    this.saveRuntimeSettings(threadId, params)

    const notification = this.threadSettingsNotification(thread)
    if (unchangedFrom !== undefined && JSON.stringify(notification) === unchangedFrom)
      this.notifyOnly(peer, notification)
    else this.notify(peer, notification)
    return {}
  }

  private threadSettingsNotification(thread: ThreadRecord): { method: string; params: unknown } {
    const threadId = thread.id
    const activePermissionProfileId = threadPermissionProfileId(
      this.store.threadSettings(threadId).permissionProfile?.id ?? thread.permissionProfileId,
      thread.approvalPolicy,
      thread.sandboxMode,
    )
    return {
      method: 'thread/settings/updated',
      params: {
        threadId,
        threadSettings: {
          cwd: thread.cwd,
          approvalPolicy: thread.approvalPolicy ?? 'on-request',
          approvalsReviewer: 'user',
          sandboxPolicy:
            this.store.threadSettings(threadId).sandboxPolicy ??
            sandboxEnvelope(thread.sandboxMode, thread.cwd),
          activePermissionProfile: activePermissionProfileId
            ? { id: activePermissionProfileId, extends: null }
            : null,
          model: thread.model,
          modelProvider: thread.modelProvider,
          serviceTier: null,
          effort: thread.reasoningEffort,
          summary: null,
          collaborationMode: {
            mode: this.store.threadSettings(threadId).planMode ? 'plan' : 'default',
            settings: {
              model: thread.model,
              reasoning_effort: thread.reasoningEffort,
              developer_instructions: thread.developerInstructions,
            },
          },
          personality: thread.personality,
        },
      },
    }
  }

  private async forkNativeSession(
    thread: ThreadRecord,
    boundary?: string,
  ): Promise<NativeSessionFork> {
    if (!this.runtime.forkSession || !thread.claudeSessionId)
      throw new ProtocolError(-32000, '缺少原生会话或分叉能力')
    return this.runtime.forkSession(thread.claudeSessionId, thread.cwd, boundary)
  }

  // 分叉用的原生会话。回合全部带走时整份复制；只带走前面一段时复制到最后一个保留回合的
  // 消息边界为止；一个回合都不带时不要原生会话，分叉从空白历史开始。
  private async forkNativeHistory(
    parent: ThreadRecord,
    parentTurns: TurnRecord[],
    retained: TurnRecord[],
  ): Promise<NativeSessionFork | null> {
    if (!parent.claudeSessionId) return null
    if (retained.length === parentTurns.length) return this.forkNativeSession(parent)
    const last = retained.at(-1)
    if (!last) return null
    const boundary = this.store.nativeBoundary(last.id)
    if (!boundary) throw new ProtocolError(-32000, '缺少原生消息边界，不能安全分叉')
    return this.forkNativeSession(parent, boundary)
  }

  private remapNativeBoundaries(
    turns: TurnRecord[],
    fork: NativeSessionFork | null,
  ): Map<string, string> {
    const result = new Map<string, string>()
    if (!fork) return result
    for (const turn of turns) {
      const old = this.store.nativeBoundary(turn.id)
      if (!old) continue
      const mapped = fork.messageIds[old]
      if (!mapped) throw new ProtocolError(-32000, '原生分叉缺少保留回合的消息边界')
      result.set(turn.id, mapped)
    }
    return result
  }

  private async threadRollback(params: Record<string, unknown>): Promise<unknown> {
    const threadId = stringOr(params.threadId, '')
    const thread = this.store.getThread(threadId)
    if (!thread) throw new Error(`unknown thread: ${threadId}`)
    if (this.sessionHolder(threadId) || this.interruptingByThread.has(threadId))
      throw new ProtocolError(-32009, '活动会话不能回退')
    // Honor the protocol's `numTurns: u32, must be >= 1` — drop that many
    // turns from the end of the thread. Without this, App's rewind UI sends
    // the request and we silently return the unchanged thread, leaving the
    // user staring at the timeline they were trying to redo.
    const numTurns = params.numTurns
    if (typeof numTurns !== 'number' || !Number.isInteger(numTurns) || numTurns < 1)
      throw new ProtocolError(-32602, 'numTurns 必须是正整数')
    // 回退会换一份原生历史；留着的进程还握着旧的那份，连同后台命令一起结束。
    await this.runtime.closeSession?.(threadId, '会话已回退')
    const retained = this.store.listTurns(threadId).slice(0, -numTurns)
    let nativeFork: NativeSessionFork | null = null
    if (thread.claudeSessionId && retained.length) {
      const boundary = this.store.nativeBoundary(retained.at(-1)!.id)
      if (!boundary) throw new ProtocolError(-32000, '缺少原生消息边界，不能安全回退')
      nativeFork = await this.forkNativeSession(thread, boundary)
      thread.claudeSessionId = nativeFork.sessionId
    } else thread.claudeSessionId = null
    const boundaries = this.remapNativeBoundaries(retained, nativeFork)
    const dropped = this.store.commitRollback(thread, numTurns, boundaries)
    debugLog('thread.rollback', { threadId, requested: numTurns, dropped })
    return { thread: this.toThread(thread, this.store.listTurns(threadId)) }
  }

  private async threadRevert(params: Record<string, unknown>): Promise<unknown> {
    const threadId = requiredString(params.threadId, 'threadId')
    const beforeTurnId = requiredString(params.beforeTurnId, 'beforeTurnId')
    if (!this.store.getThread(threadId)) throw new ProtocolError(-32602, '未知会话')
    const turns = this.store.listTurns(threadId)
    const index = turns.findIndex((turn) => turn.id === beforeTurnId)
    if (index < 0) throw new ProtocolError(-32602, 'beforeTurnId 不属于此会话的当前历史')
    // 两种 historyMode 共用同一持久化历史；保留原模式，不阻断旧会话使用新入口。
    // 原生分叉与 SQLite 提交共用旧入口的事务，文件系统副作用不回退。
    await this.threadRollback({ threadId, numTurns: turns.length - index })
    const thread = this.store.getThread(threadId)!
    setImmediate(() =>
      this.notifyThread(threadId, {
        method: 'thread/reverted',
        params: { threadId },
      }),
    )
    return {
      thread: this.toThread(thread, []),
      ...historyHeadCursors(threadId, this.store.listTurns(threadId)),
    }
  }

  private threadShellCommand(peer: RpcPeer, params: Record<string, unknown>): unknown {
    const threadId = requiredString(params.threadId, 'threadId')
    const thread = this.store.getThread(threadId)
    if (!thread) throw new ProtocolError(-32602, 'threadId 必须指向已有会话')
    const command = requiredString(params.command, 'command')
    if (command.includes('\0')) throw new ProtocolError(-32602, 'command 不能包含空字节')
    const shell = process.env.SHELL || '/bin/sh'
    const cwd = thread.cwd
    const processId = newId()
    debugLog('thread.shellCommand.start', { threadId, processId, cwd, command })
    const child = spawn(shell, ['-lc', command], { cwd, env: process.env, stdio: 'pipe' })
    this.commandProcesses.set(processId, child)
    child.stdout?.on('data', (chunk) =>
      this.notify(peer, {
        method: 'command/exec/outputDelta',
        params: {
          processId,
          stream: 'stdout',
          deltaBase64: Buffer.from(chunk).toString('base64'),
          capReached: false,
        },
      }),
    )
    child.stderr?.on('data', (chunk) =>
      this.notify(peer, {
        method: 'command/exec/outputDelta',
        params: {
          processId,
          stream: 'stderr',
          deltaBase64: Buffer.from(chunk).toString('base64'),
          capReached: false,
        },
      }),
    )
    child.once('error', (error) =>
      debugLog('thread.shellCommand.error', { threadId, processId, error: error.message }),
    )
    child.once('close', (code, signal) => {
      debugLog('thread.shellCommand.close', { threadId, processId, code, signal })
      this.commandProcesses.delete(processId)
    })
    return {}
  }

  // ── 跨回合存活的后台命令 ──

  // 后台命令的启动回执：条目保持 inProgress，命令结束时再补完成通知。
  private trackBackgroundCommand(
    sessionThreadId: string,
    threadId: string,
    turnId: string,
    itemId: string,
    taskId: string,
    startedAtMs: number | undefined,
  ): boolean {
    const item = this.store.getItem(turnId, itemId)
    if (item?.type !== 'commandExecution') return false
    this.backgroundCommands.add(sessionThreadId, {
      taskId,
      threadId,
      turnId,
      itemId,
      startedAtMs: startedAtMs ?? nowMillis(),
    })
    return true
  }

  // 通知带的是命令当初所在的回合，那个回合多半早已结束。
  private finishBackgroundCommand(
    entry: BackgroundCommandEntry,
    end: Pick<RuntimeBackgroundCommandEnd, 'status' | 'exitCode' | 'output'>,
  ): void {
    const threadId = entry.threadId
    const durationMs = Math.max(0, nowMillis() - entry.startedAtMs)
    const item = this.store.updateItem(entry.turnId, entry.itemId, (item) =>
      endedCommandItem(item, end, durationMs),
    )
    if (!item) return
    if (end.output)
      this.notifyThread(threadId, {
        method: 'item/commandExecution/outputDelta',
        params: { threadId, turnId: entry.turnId, itemId: entry.itemId, delta: end.output },
      })
    this.notifyThread(threadId, {
      method: 'item/completed',
      params: { threadId, turnId: entry.turnId, item, completedAtMs: nowMillis() },
    })
  }

  // CLI 进程退出：它名下还在跑的后台命令都已随它结束。
  private sessionClosed(threadId: string, reason: string): void {
    debugLog('runtime.session.closed', { threadId, reason })
    for (const entry of this.backgroundCommands.drain(threadId))
      this.finishBackgroundCommand(entry, {
        status: 'stopped',
        exitCode: null,
        output: '',
      })
    this.idleCheckHandler?.()
  }

  // CLI 自己开了一轮（后台命令结束后把结果告诉模型）。没有用户输入，适配器为它建一个回合。
  private async spontaneousTurn(threadId: string): Promise<boolean> {
    if (this.stopped) return false
    const thread = this.store.getThread(threadId)
    if (!thread || thread.archived) return false
    // 占着这个进程的回合：线程自己的，或者借用它做追问的子线程的。
    const holder = this.sessionHolder(threadId)
    if (holder) {
      if (this.interruptingByThread.has(holder.threadId)) return false
      // 回合还没交到运行时手里：它会接到同一个进程上，CLI 自己开的这一轮并进那个回合。
      if (!this.handedToRuntime.has(holder.turnId)) return true
      // 运行时已经把回合交还，协议层还在收尾（算差异、发终态）：等它收完再为这一轮建回合。
      await this.activeTurnCleared(holder.threadId, holder.turnId)
      return this.spontaneousTurn(threadId)
    }
    if (
      this.interruptingByThread.has(threadId) ||
      this.nativeMutations.has(threadId) ||
      this.store.pendingContextInjection(threadId) ||
      this.store.listTurns(threadId).some((turn) => turn.status === 'inProgress')
    )
      return false
    // 这一轮不是哪条连接发起的，用占位连接代表它：通知和请求按线程当时的订阅连接送（见 recipients），
    // 一条都没有时无处可送——回合照常执行并落库，遇到需要确认的调用就停在那里，等有客户端订阅这个线程。
    // 不能拿开始那一刻订阅着的连接来代表：它中途退订之后，“没人订阅就发给发起回合的连接”这条规则
    // 会把它当成发起者，回合内容和确认请求接着往一条已经不看这个线程的连接上送。
    const peer = detachedPeer(threadId)
    const turn: TurnRecord = {
      id: newId(),
      threadId,
      status: 'inProgress',
      startedAt: nowSeconds(),
      completedAt: null,
      durationMs: null,
      items: [],
      diff: '',
      error: null,
    }
    this.store.upsertTurn(turn)
    this.spontaneousTurns.add(turn.id)
    this.goals.begin(threadId, turn.id)
    recordRunEvent('turn.started', {
      threadId,
      turnId: turn.id,
      cwd: thread.cwd,
      model: thread.model,
      runtimeBackend: thread.runtimeBackend,
      purpose: 'normal',
    })
    this.markActiveTurn(threadId, turn.id)
    this.setThreadStatus(peer, threadId, { type: 'active', activeFlags: [] })
    setImmediate(() => {
      this.notify(peer, {
        method: 'turn/started',
        params: { threadId, turn: this.toLifecycleTurn(turn) },
      })
      void this.runRuntimeTurn(peer, thread, turn, '', { threadId, _spontaneous: true }).catch(
        (error) => this.failTurn(peer, threadId, turn, error),
      )
    })
    return true
  }

  private sessionHolder(threadId: string): { threadId: string; turnId: string } | null {
    const own = this.activeTurnByThread.get(threadId)
    if (own) return { threadId, turnId: own }
    for (const [child, parent] of this.relayParentByChild) {
      const turnId = parent === threadId ? this.activeTurnByThread.get(child) : undefined
      if (turnId) return { threadId: child, turnId }
    }
    return null
  }

  // 等某个活动回合收尾完（不再占着线程）。
  private activeTurnCleared(threadId: string, turnId: string): Promise<void> {
    if (this.activeTurnByThread.get(threadId) !== turnId) return Promise.resolve()
    return new Promise((resolve) => {
      const waiters = this.turnClearWaiters.get(threadId) ?? []
      waiters.push(resolve)
      this.turnClearWaiters.set(threadId, waiters)
    })
  }

  /** 插进回合的话交给运行时的文字：选中的 Skill 正文在前（同 turn/start），其余照旧 */
  private inputPrompt(threadId: string, input: UserInput[]): string {
    const cwd = this.store.getThread(threadId)?.cwd ?? process.cwd()
    const skills = this.skills.expandSkillInputs(cwd, input)
    return withSkillInstructions(skills.instructions, textFromInput(skills.rest))
  }

  // 有活动回合时 turn/start 和上游一样并进那个回合（上游 start_or_steer：相当于 steer，回执里是那个回合），
  // CLI 自己续跑的回合（用户不知道有回合在跑）也是这样。不并的：追问子代理的回合（插的话到不了子代理）、
  // 审查和手动压缩的回合（上游同样不许插话）、带 outputSchema 的（上游要求和活动回合的一致），这几种照旧拒绝。
  // 回合正在收尾、运行时不再收插话时，等它收尾完按普通回合开始（上游这时也是新开一个回合）。
  // 这次 turn/start 里的模型、权限等设置不跟着改（并入的回合沿用它开始时的设置）。
  private async joinActiveTurn(
    peer: RpcPeer,
    threadId: string,
    params: Record<string, unknown>,
    messageId: string | null,
    hash: string,
  ): Promise<TurnRecord | null> {
    const turnId = this.activeTurnByThread.get(threadId)
    if (!turnId || this.interruptingByThread.has(threadId)) return null
    if (this.relayParentByChild.has(threadId) || params.outputSchema != null) return null
    const active = this.store.getTurn(turnId)
    if (active?.status !== 'inProgress') return null
    const first = active.items[0]?.type
    if (first === 'contextCompaction' || active.items.some((i) => i.type === 'enteredReviewMode'))
      return null
    const input = Array.isArray(params.input) ? (params.input as UserInput[]) : []
    if (extractImageInputs(input).images.length > 0)
      throw new ProtocolError(
        -32009,
        this.spontaneousTurns.has(turnId)
          ? '会话正在处理后台命令的结果，带图片的消息请稍后再发'
          : '回合正在进行，带图片的消息不能并进去，请等回合结束后再发',
      )
    const startup = this.runtimeReadyByTurn.get(turnId)
    if (startup && !(await startup.ready)) return null
    if (this.activeTurnByThread.get(threadId) !== turnId) return null
    const item: ThreadItem = {
      type: 'userMessage',
      id: newId(),
      content: input,
      clientId: messageId,
    }
    // 先送进去再落库：送不进去时这条消息不能留下“已提交”的记录。
    try {
      await this.runtime.steer(threadId, this.inputPrompt(threadId, input))
    } catch (error) {
      if (!(error instanceof ProtocolError) || error.code !== -32009) throw error
      // 那一轮刚好结束：等它收尾完，按普通回合提交。
      await this.activeTurnCleared(threadId, turnId)
      return null
    }
    this.store.saveSteeredMessage(turnId, item, messageId, hash)
    this.sendInputItem(peer, threadId, turnId, item)
    return this.store.getTurn(turnId)
  }

  // 回合的输入条目（用户消息、上传的图片）和上游一样发给会话的全部订阅者（item/started、item/completed，用户消息带
  // clientId）：别的连接开的回合（设备进程开的唤醒、提醒，手机上发的话）正看着这个会话的客户端也能实时看到；
  // 发起方按 clientId 认出自己先显示的那条。
  private sendInputItem(peer: RpcPeer, threadId: string, turnId: string, item: ThreadItem): void {
    this.notify(peer, {
      method: 'item/started',
      params: { threadId, turnId, item, startedAtMs: nowMillis() },
    })
    this.notify(peer, {
      method: 'item/completed',
      params: { threadId, turnId, item, completedAtMs: nowMillis() },
    })
  }

  private failTurn(peer: RpcPeer, threadId: string, turn: TurnRecord, error: Error): void {
    if (this.stopped) return
    const current = this.store.getTurn(turn.id)
    if (current && current.status !== 'inProgress') return
    this.finishGoal(threadId, turn.id, 'failed')
    const turnError = turnErrorOf(error)
    const completed = this.store.completeTurn(turn.id, 'failed', turnError) ?? turn
    this.pendingInteractions.cancelThread(threadId)
    this.notify(peer, {
      method: 'error',
      params: { threadId, turnId: turn.id, willRetry: false, error: turnError },
    })
    this.notify(peer, {
      method: 'turn/completed',
      params: { threadId, turn: this.toLifecycleTurn(completed) },
    })
    this.clearActiveTurn(threadId)
    this.setThreadStatus(peer, threadId, { type: 'idle' })
  }

  // 与原生 load_thread 一致：会话必须存在且已加载（有连接订阅）。
  private loadedThreadForTerminals(params: Record<string, unknown>): ThreadRecord {
    const threadId = requiredString(params.threadId, 'threadId')
    const thread = this.store.getThread(threadId)
    if (!thread || !this.subscribers.has(threadId))
      throw new ProtocolError(-32600, `thread not found: ${threadId}`)
    return thread
  }

  private listedBackgroundTerminals(thread: ThreadRecord): ListedBackgroundTerminal[] {
    const turnIds = new Set(this.backgroundCommands.list(thread.id).map((entry) => entry.turnId))
    const active = this.activeTurnByThread.get(thread.id)
    if (active) turnIds.add(active)
    const items = [...turnIds].flatMap((turnId) => this.store.getTurn(turnId)?.items ?? [])
    return backgroundTerminals(
      this.runtime.listBackgroundShells?.(thread.id) ?? [],
      thread.cwd,
      items,
    )
  }

  private threadBackgroundTerminalsList(params: Record<string, unknown>): unknown {
    const thread = this.loadedThreadForTerminals(params)
    return paginateBackgroundTerminals(
      this.listedBackgroundTerminals(thread).map((entry) => entry.terminal),
      params.cursor,
      params.limit,
    )
  }

  private async threadBackgroundTerminalsTerminate(
    params: Record<string, unknown>,
  ): Promise<unknown> {
    const thread = this.loadedThreadForTerminals(params)
    const processId = requiredString(params.processId, 'processId')
    const entry = this.listedBackgroundTerminals(thread).find(
      (listed) => listed.terminal.processId === processId,
    )
    if (!entry) return { terminated: false }
    return {
      terminated: (await this.runtime.stopBackgroundShell?.(thread.id, entry.taskId)) ?? false,
    }
  }

  // 原生提交清理操作后立即返回，不等待终止完成。
  private threadBackgroundTerminalsClean(params: Record<string, unknown>): unknown {
    const thread = this.loadedThreadForTerminals(params)
    for (const entry of this.listedBackgroundTerminals(thread))
      void this.runtime.stopBackgroundShell?.(thread.id, entry.taskId)
    return {}
  }

  private async reviewStart(peer: RpcPeer, params: Record<string, unknown>): Promise<unknown> {
    let threadId = requiredString(params.threadId, 'threadId')
    let thread = this.store.getThread(threadId)
    if (!thread) throw new ProtocolError(-32602, '未知会话')
    if (this.activeTurnByThread.has(threadId) || this.interruptingByThread.has(threadId))
      throw new ProtocolError(-32009, '活动会话不能开始审查')
    if (params.delivery != null && params.delivery !== 'inline' && params.delivery !== 'detached')
      throw new ProtocolError(-32602, '审查 delivery 无效')
    const target = asRecord(params.target)
    if (
      typeof target.type !== 'string' ||
      !['uncommittedChanges', 'baseBranch', 'commit', 'custom'].includes(target.type)
    )
      throw new ProtocolError(-32602, '审查 target 类型无效')
    if (target.type === 'baseBranch') requiredString(target.branch, 'target.branch')
    if (target.type === 'commit') {
      requiredString(target.sha, 'target.sha')
      if (target.title != null && typeof target.title !== 'string')
        throw new ProtocolError(-32602, 'target.title 必须是字符串')
    }
    if (target.type === 'custom') requiredString(target.instructions, 'target.instructions')
    // 分叉由原生会话实现；父会话保持原有权限、历史和工作目录。
    if (params.delivery === 'detached') {
      const fork = asRecord(await this.threadFork(peer, { threadId }))
      threadId = requiredString(asRecord(fork.thread).id, 'reviewThreadId')
      const forked = this.store.getThread(threadId)
      if (!forked) throw new Error('原生审查分叉缺少会话记录')
      thread = forked
    }
    this.subscribers.add(threadId, peer)
    const turnId = newId()
    const review = reviewLabel(params.target)
    const prompt = reviewPrompt(params.target)
    const userItem: ThreadItem = {
      type: 'userMessage',
      id: turnId,
      content: [{ type: 'text', text: review, text_elements: [] }],
    }
    const entered: ThreadItem = { type: 'enteredReviewMode', id: newId(), review }
    const turn: TurnRecord = {
      id: turnId,
      threadId,
      status: 'inProgress',
      startedAt: nowSeconds(),
      completedAt: null,
      durationMs: null,
      items: [userItem, entered],
      diff: '',
      error: null,
    }
    this.store.upsertTurn(turn)
    recordRunEvent('turn.started', {
      threadId,
      turnId,
      cwd: thread.cwd,
      model: thread.model,
      runtimeBackend: thread.runtimeBackend,
      purpose: params.outputSchema == null ? 'normal' : 'summary',
    })
    this.markActiveTurn(threadId, turnId)
    this.setThreadStatus(peer, threadId, { type: 'active', activeFlags: [] })
    // The review/start RESPONSE carries the synthesized userMessage item (the
    // real app-server's build_review_turn does the same, with itemsView
    // notLoaded); the turn/started NOTIFICATION stays empty like every other
    // lifecycle turn.
    const responseTurn = this.toLifecycleTurn(turn, [userItem])
    setImmediate(() => {
      this.notify(peer, {
        method: 'turn/started',
        params: { threadId, turn: this.toLifecycleTurn(turn) },
      })
      this.notify(peer, {
        method: 'item/started',
        params: { threadId, turnId, item: entered, startedAtMs: nowMillis() },
      })
      this.notify(peer, {
        method: 'item/completed',
        params: { threadId, turnId, item: entered, completedAtMs: nowMillis() },
      })
      void this.runRuntimeTurn(peer, thread, turn, prompt, {
        model: thread.model,
        effort: thread.reasoningEffort,
      }).catch((error) => {
        if (this.store.getTurn(turnId)?.status !== 'inProgress') return
        this.finishReview(peer, threadId, turnId, `审查失败：${error.message}`)
        const completed =
          this.store.completeTurn(turnId, 'failed', { message: error.message }) ?? turn
        this.pendingInteractions.cancelThread(threadId)
        recordRunEvent('turn.failed', {
          threadId,
          turnId,
          runtimeBackend: thread.runtimeBackend,
          error: { message: error.message },
        })
        this.notify(peer, {
          method: 'error',
          params: { threadId, turnId, willRetry: false, error: { message: error.message } },
        })
        this.notify(peer, {
          method: 'turn/completed',
          params: { threadId, turn: this.toLifecycleTurn(completed) },
        })
        this.clearActiveTurn(threadId)
        this.setThreadStatus(peer, threadId, { type: 'idle' })
      })
    })
    return { turn: responseTurn, reviewThreadId: threadId }
  }

  private finishReview(
    peer: RpcPeer | undefined,
    threadId: string,
    turnId: string,
    failure?: string,
  ): void {
    const turn = this.store.getTurn(turnId)
    if (
      !turn?.items.some((item) => item.type === 'enteredReviewMode') ||
      turn.items.some((item) => item.type === 'exitedReviewMode')
    )
      return
    const review =
      failure ??
      turn.items
        .flatMap((item) =>
          item.type === 'agentMessage' || item.type === 'plan' ? [item.text] : [],
        )
        .join('\n')
    const item: ThreadItem = { type: 'exitedReviewMode', id: newId(), review }
    this.store.appendItem(turnId, item)
    if (!peer) return
    this.notify(peer, {
      method: 'item/started',
      params: { threadId, turnId, item, startedAtMs: nowMillis() },
    })
    this.notify(peer, {
      method: 'item/completed',
      params: { threadId, turnId, item, completedAtMs: nowMillis() },
    })
  }

  private threadCompactStart(peer: RpcPeer, params: Record<string, unknown>): unknown {
    const threadId = stringOr(params.threadId, '')
    const thread = this.store.getThread(threadId)
    if (!thread) throw new Error(`unknown thread: ${threadId}`)
    if (this.activeTurnByThread.has(threadId)) throw new ProtocolError(-32009, '活动会话不能压缩')
    const turnId = newId()
    const compactItem: ThreadItem = { type: 'contextCompaction', id: newId() }
    const turn: TurnRecord = {
      id: turnId,
      threadId,
      status: 'inProgress',
      startedAt: nowSeconds(),
      completedAt: null,
      durationMs: null,
      items: [compactItem],
      diff: '',
      error: null,
    }
    this.store.upsertTurn(turn)
    recordRunEvent('turn.started', {
      threadId,
      turnId,
      cwd: thread.cwd,
      model: thread.model,
      runtimeBackend: thread.runtimeBackend,
      purpose: params.outputSchema == null ? 'normal' : 'summary',
    })
    this.markActiveTurn(threadId, turnId)
    this.setThreadStatus(peer, threadId, { type: 'active', activeFlags: [] })
    setImmediate(() => {
      this.notify(peer, {
        method: 'turn/started',
        params: { threadId, turn: this.toLifecycleTurn(turn) },
      })
      this.notify(peer, {
        method: 'item/started',
        params: { threadId, turnId, item: compactItem, startedAtMs: nowMillis() },
      })
      // 回答条目等 CLI 真的说了话才建：手动压缩通常一个字也不说，回合里只有压缩条目（上游也是）。
      const agent: { id: string | null } = { id: null }

      let failure: Error | null = null
      void this.runCompactTurn(peer, thread, turnId, agent, compactItem)
        .catch((error) => {
          failure = error instanceof Error ? error : new Error(String(error))
        })
        .finally(() => {
          if (this.stopped) return
          this.notify(peer, {
            method: 'item/completed',
            params: { threadId, turnId, item: compactItem, completedAtMs: nowMillis() },
          })
          const finalAgent = agent.id
            ? this.store.getTurn(turnId)?.items.find((i) => i.id === agent.id)
            : undefined
          if (finalAgent)
            this.notify(peer, {
              method: 'item/completed',
              params: { threadId, turnId, item: finalAgent, completedAtMs: nowMillis() },
            })
          const completed =
            this.store.completeTurn(
              turnId,
              failure ? 'failed' : 'completed',
              failure ? { message: failure.message } : null,
            ) ?? turn
          this.clearActiveTurn(threadId)
          this.setThreadStatus(peer, threadId, { type: 'idle' })
          this.notify(peer, {
            method: 'turn/completed',
            params: { threadId, turn: this.toLifecycleTurn(completed) },
          })
          if (!failure)
            this.notify(peer, { method: 'thread/compacted', params: { threadId, turnId } })
        })
    })
    return {}
  }

  // Calls into the runtime with a structured "give me a 1-paragraph summary"
  // prompt against the summary model alias (haiku). Streams the text into the
  // placeholder agent message via item/agentMessage/delta. Errors propagate
  // so the threadCompactStart fallback can substitute the local snippet.
  // 回答条目在头一段非空的字到来时才建，标识记在 agent 里交回给调用方收尾。
  private async runCompactTurn(
    peer: RpcPeer,
    thread: ThreadRecord,
    turnId: string,
    agent: { id: string | null },
    compactItem: ThreadItem,
  ): Promise<void> {
    let compacted = false
    this.handedToRuntime.add(turnId)
    await this.runtime.runTurn(
      {
        threadId: thread.id,
        turnId,
        purpose: 'compact',
        prompt: '/compact',
        cwd: thread.cwd,
        runtimeType: null,
        model: resolveClaudeModel(thread.model, 'normal'),
        effort: resolveClaudeEffort(thread.reasoningEffort ?? null),
        claudeSessionId: thread.claudeSessionId,
        forkSession: false,
        mcpServers: null,
        allowedTools: ['Read', 'Glob', 'Grep'],
        addDirs: [],
        skillOverrides: this.skills.runtimeOverrides(thread.cwd),
        outputFormat: null,
        approvalPolicy: 'never',
        sandboxMode: 'read-only',
        systemPromptAddendum: null,
        planMode: false,
        imageInputs: [],
      },
      {
        onEvent: async (event) => {
          if (this.stopped) return
          if (event.type === 'rate_limits') this.recordRateLimits(event)
          if (event.type === 'context_compacted') {
            compacted = true
            if (event.messageId) this.store.saveNativeBoundary(turnId, event.messageId)
            this.compactedUsage(peer, thread.id, turnId, event.postTokens)
          }
          if (event.type === 'text_delta' && event.delta) {
            if (!agent.id) {
              const item: ThreadItem = {
                type: 'agentMessage',
                id: newId(),
                text: '',
                phase: null,
                memoryCitation: null,
              }
              this.store.appendItem(turnId, item)
              this.notify(peer, {
                method: 'item/started',
                params: { threadId: thread.id, turnId, item, startedAtMs: nowMillis() },
              })
              agent.id = item.id
            }
            const agentItemId = agent.id
            this.store.appendTextLater(turnId, agentItemId, event.delta)
            this.notify(peer, {
              method: 'item/agentMessage/delta',
              params: { threadId: thread.id, turnId, itemId: agentItemId, delta: event.delta },
            })
          }
          if (event.type === 'error') throw new Error(event.message)
          if (event.type === 'completed' && !event.success) {
            throw new Error(event.result ?? 'compaction turn failed')
          }
        },
        // Compaction never asks for approvals — it's read-only summarisation.
        onPermissionRequest: async () => ({ decision: 'accept' }),
        // Compaction shouldn't ever invoke AskUserQuestion; if it does, return
        // an empty answer so the model proceeds with its summary.
        onUserInputRequest: async (event) => ({
          answers: Object.fromEntries(event.questions.map((q) => [q.id, { answers: [] }])),
        }),
      },
    )

    if (!compacted) {
      void compactItem
      throw new Error('未收到原生压缩边界，不能确认上下文已压缩')
    }
    // 之前放在用户消息前面的指令压进了摘要，下个回合再放一次
    this.rememberInjectedInstructions(thread.id, null)
  }

  private async turnStart(
    peer: RpcPeer,
    params: Record<string, unknown>,
    queuedId?: string,
  ): Promise<unknown> {
    const threadId = requiredString(params.threadId, 'threadId')
    const thread = this.store.getThread(threadId)
    if (!thread) throw new Error(`unknown thread: ${threadId}`)
    const messageId =
      params.clientUserMessageId == null
        ? null
        : requiredString(params.clientUserMessageId, 'clientUserMessageId')
    const hash = submissionHash(params)
    if (messageId) {
      if (!queuedId && this.store.queue.hasClient(threadId, messageId))
        throw new ProtocolError(-32009, '消息 ID 已由队列管理，请通过队列操作')
      const submitted = this.store.submittedTurn(threadId, messageId, hash)
      if (submitted) return { turn: this.toLifecycleTurn(submitted) }
    }
    const merged = queuedId
      ? null
      : await this.joinActiveTurn(peer, threadId, params, messageId, hash)
    if (merged) return { turn: this.toLifecycleTurn(merged) }
    if (
      this.activeTurnByThread.has(threadId) ||
      this.interruptingByThread.has(threadId) ||
      this.store.pendingContextInjection(threadId) ||
      this.store.listTurns(threadId).some((turn) => turn.status === 'inProgress')
    )
      throw new ProtocolError(-32009, '会话已有活动或结果尚未确认的 Turn')
    // 追问回合要恢复父会话；同一个 Claude 会话不能同时被两个 CLI 进程使用。
    const relay = this.subagentRelay(thread)
    if ([...this.relayParentByChild.values()].includes(threadId))
      throw new ProtocolError(-32009, '子代理正在处理追问，主任务暂时不能开始新回合')
    if (
      relay &&
      (this.activeTurnByThread.has(relay.parent.id) ||
        this.interruptingByThread.has(relay.parent.id) ||
        [...this.relayParentByChild.values()].includes(relay.parent.id))
    )
      throw new ProtocolError(-32009, '主任务正在运行，子代理暂时不能接收新消息')
    const turnId = newId()
    const input = Array.isArray(params.input) ? (params.input as UserInput[]) : []
    // extractImageInputs splits user input into the text prompt and any image
    // attachments (localImage / image URL / data:). Sidecar repacks the
    // images into a Claude SDK multimodal user message; here we also append
    // an `imageView` ThreadItem per image so the App's transcript shows them
    // inline next to the user message instead of losing them.
    if (typeof params.cwd === 'string' && params.cwd.length > 0) thread.cwd = params.cwd
    // 选中的 Skill 按上游的方式把正文交给模型（见 SkillsRpc.expandSkillInputs）；标题、工作流命令仍按用户写的话认
    const skills = this.skills.expandSkillInputs(thread.cwd, input)
    const { textPrompt, images } = extractImageInputs(skills.rest)
    const userPrompt = textPrompt || textFromInput(skills.rest)
    const workflowCommand = parseWorkflowCommand(userPrompt)
    const prompt = withSkillInstructions(skills.instructions, userPrompt)
    const model = modelFromParams(params, thread.model)
    const reasoningEffort = reasoningEffortFromParams(params, thread.reasoningEffort)
    const permissionProfileId = permissionProfileIdFromParams(params)
    const permissionProfile = permissionProfilePolicy(
      permissionProfileId,
      this.configOverrides.permissions,
    )
    if (model) thread.model = catalogModelId(model)
    if (reasoningEffort) thread.reasoningEffort = reasoningEffort
    if (permissionProfileId) {
      thread.permissionProfileId = permissionProfileId
      if (params.approvalPolicy != null)
        thread.approvalPolicy = normalizeApprovalPolicy(params.approvalPolicy)
      else if (permissionProfile?.approvalPolicy)
        thread.approvalPolicy = permissionProfile.approvalPolicy
      if (permissionProfile?.sandboxMode) thread.sandboxMode = permissionProfile.sandboxMode
    } else {
      if (hasLegacyPermissionParams(params)) thread.permissionProfileId = null
      if (params.approvalPolicy != null)
        thread.approvalPolicy = normalizeApprovalPolicy(params.approvalPolicy)
      const requestedSandbox = sandboxFromTurnParams(params)
      if (requestedSandbox) thread.sandboxMode = requestedSandbox
    }
    this.store.upsertThread(thread)
    const preview = userPrompt || textFromInput(input)
    if (!thread.preview && preview) {
      thread.preview = preview.slice(0, 200)
      thread.updatedAt = nowSeconds()
      this.store.upsertThread(thread)
    }
    const initialItems: ThreadItem[] = [
      { type: 'userMessage', id: newId(), content: input, clientId: messageId },
    ]
    const imageItems: ThreadItem[] = []
    for (const img of images) {
      // Codex v2 imageView.path is AbsolutePathBuf — Rust's custom Deserialize
      // rejects anything that isn't an absolute filesystem path (URLs, data:
      // URIs, relative paths). For non-local images we'd otherwise crash the
      // App on persist/reload. Only emit imageView for kind:'base64' inputs
      // that came from a real local file path (the displayPath in that case
      // is the original absolute path captured by extractImageInputs).
      if (img.kind === 'base64' && img.displayPath.startsWith('/')) {
        imageItems.push({ type: 'imageView', id: newId(), path: img.displayPath })
      }
    }
    // imageView 条目和用户消息一样留在回合里（thread/read），也实时发出去，界面在回合进行中就能显示上传的图片
    initialItems.push(...imageItems)
    // Note: we used to short-circuit Codex App's title-generation turn with a
    // local regex-derived title to avoid prompt leakage into the parent thread.
    // That leakage no longer happens (title turns run on their own ephemeral
    // thread, filtered from listings), so the short-circuit was just forcing a
    // hardcoded "处理X" string instead of the real model output. Now every turn
    // — including the structured title turn on Claude Haiku — runs end-to-end.
    const turn: TurnRecord = {
      id: turnId,
      threadId,
      status: 'inProgress',
      startedAt: nowSeconds(),
      completedAt: null,
      durationMs: null,
      items: initialItems,
      diff: '',
      error: null,
    }
    this.store.saveSubmission(turn, messageId, hash, queuedId)
    this.subscribers.add(threadId, peer)
    if (params.outputSchema == null) this.goals.begin(threadId, turnId)
    recordRunEvent('turn.started', {
      threadId,
      turnId,
      cwd: thread.cwd,
      model: thread.model,
      runtimeBackend: thread.runtimeBackend,
      purpose: params.outputSchema == null ? 'normal' : 'summary',
    })
    this.markActiveTurn(threadId, turnId)
    if (relay) this.relayParentByChild.set(threadId, relay.parent.id)
    this.setThreadStatus(peer, threadId, { type: 'active', activeFlags: [] })
    const publicTurn = this.toLifecycleTurn(turn)

    setImmediate(() => {
      this.notify(peer, { method: 'turn/started', params: { threadId, turn: publicTurn } })
      for (const item of initialItems) this.sendInputItem(peer, threadId, turnId, item)
      if (params.outputSchema == null && workflowCommand?.type === 'list') {
        this.completeWorkflowListTurn(peer, thread, turn)
        return
      }
      // Carry parsed images through the params bag so runRuntimeTurn can hand
      // them to the runtime context without re-parsing user input.
      void this.runRuntimeTurn(peer, thread, turn, prompt, {
        ...params,
        _imageInputs: images,
      }).catch((error) => this.failTurn(peer, threadId, turn, error))
    })
    return { turn: publicTurn }
  }

  private completeWorkflowListTurn(peer: RpcPeer, thread: ThreadRecord, turn: TurnRecord): void {
    const itemId = newId()
    const emptyItem: ThreadItem = {
      type: 'agentMessage',
      id: itemId,
      text: '',
      phase: null,
      memoryCitation: null,
    }
    this.store.appendItem(turn.id, emptyItem)
    this.notify(peer, {
      method: 'item/started',
      params: { threadId: thread.id, turnId: turn.id, item: emptyItem, startedAtMs: nowMillis() },
    })

    const text = this.workflowListText(thread.id, turn.id)
    const completedItem: ThreadItem = { ...emptyItem, text }
    this.store.updateItem(turn.id, itemId, () => completedItem)
    this.notify(peer, {
      method: 'item/agentMessage/delta',
      params: { threadId: thread.id, turnId: turn.id, itemId, delta: text },
    })
    this.notify(peer, {
      method: 'item/completed',
      params: {
        threadId: thread.id,
        turnId: turn.id,
        item: completedItem,
        completedAtMs: nowMillis(),
      },
    })

    this.finishGoal(thread.id, turn.id, 'completed')
    const completed = this.store.completeTurn(turn.id, 'completed') ?? turn
    recordRunEvent('turn.completed', {
      threadId: thread.id,
      turnId: turn.id,
      runtimeBackend: thread.runtimeBackend,
      durationMs: completed.durationMs,
      command: 'workflows.list',
    })
    this.clearActiveTurn(thread.id)
    this.setThreadStatus(peer, thread.id, { type: 'idle' })
    this.notify(peer, {
      method: 'turn/completed',
      params: { threadId: thread.id, turn: this.toLifecycleTurn(completed) },
    })
    this.scheduleGoal(thread.id)
  }

  private workflowListText(threadId: string, currentTurnId: string): string {
    const runs = this.store
      .listTurns(threadId)
      .filter((turn) => turn.id !== currentTurnId)
      .map((turn) => {
        const userItem = turn.items.find((item) => item.type === 'userMessage')
        const prompt = userItem?.type === 'userMessage' ? textFromInput(userItem.content) : ''
        const command = parseWorkflowCommand(prompt)
        if (command?.type !== 'run') return null
        const childIds = new Set<string>()
        for (const item of turn.items) {
          if (item.type !== 'collabAgentToolCall' || item.tool !== 'spawnAgent') continue
          for (const childId of item.receiverThreadIds) childIds.add(childId)
        }
        const agents = Array.from(childIds).map((childId) => {
          const child = this.store.getThread(childId)
          const latestTurn = this.store.listTurns(childId).at(-1)
          return {
            nickname: child?.agentNickname ?? childId.slice(0, 12),
            role: child?.agentRole ?? 'subagent',
            status: latestTurn?.status ?? child?.status.type ?? 'unknown',
          }
        })
        return { turn, prompt: command.prompt, agents }
      })
      .filter((run): run is NonNullable<typeof run> => run !== null)
      .reverse()
      .slice(0, 20)

    if (runs.length === 0) {
      return [
        'No workflow runs in this task.',
        '',
        'Start one with `/workflows <task>`. The adapter runs it through Claude ultracode and exposes its agents as reviewable Codex subagent tasks.',
      ].join('\n')
    }

    const lines = ['Workflow runs in this task:']
    for (const run of runs) {
      const task = run.prompt.replace(/\s+/g, ' ').slice(0, 120)
      lines.push(
        `- ${run.turn.id.slice(0, 12)} · ${run.turn.status} · ${run.agents.length} agent(s) · ${task}`,
      )
      if (run.agents.length > 0) {
        lines.push(
          `  Agents: ${run.agents
            .map((agent) => `${agent.nickname} (${agent.role}, ${agent.status})`)
            .join(', ')}`,
        )
      }
    }
    lines.push('', 'Open the Agent items in the workflow turn to review each child task.')
    return lines.join('\n')
  }

  private async runRuntimeTurn(
    peer: RpcPeer,
    thread: ThreadRecord,
    turn: TurnRecord,
    prompt: string,
    params: Record<string, unknown>,
  ): Promise<void> {
    const itemIds = new Map<string, string>()
    // 用户在审批里拒绝、条目已经收尾成“已拒绝”的工具调用：随后 CLI 交回的那条工具结果不再改写它。
    const declinedToolUses = new Set<string>()
    let agentItemId: string | null = null
    let reasoningItemId: string | null = null
    /** 现在这条思考有没有来过字。记在这里，不用每条增量都把回合读出来看摘要是不是还空着 */
    let reasoningStarted = false
    let hasTextOutput = false
    const noticesSeen = new Set<string>()
    const commandOutputSeen = new Set<string>()
    // 这个回合用的沙箱策略和计划模式在这里定下来，和 thread 里的审批策略、权限模式是同一时刻的。
    // 下面取 diff 基线要起 git，会等；等的时候会话换了权限档的话，晚读的沙箱策略已经是新的一档，
    // 和开始时的权限模式凑不到一起：工作区档配上没有可写目录的完全访问策略，回合里写文件全被当成越界。
    this.saveRuntimeSettings(thread.id, params)
    const turnSettings = this.store.threadSettings(thread.id)
    // 回合开始前的工作区即 diff 基线，既有未提交改动与此前回合的结果都不属于本回合。
    const diffBase = await gitWorktreeTree(thread.cwd)
    // MultiAgent V2 uses subAgentActivity for display/liveness and the
    // spawnAgent/wait tool calls for the structured timeline. A naturally
    // completed child is not closed again: wait/completed must remain the last
    // parent state so Codex App retains the terminal snapshot.
    const subagentContexts = new Map<string, SubagentContext>()
    const activeSubagents = new Set<string>()
    // 后台子代理仍计入 activeSubagents（看门狗与收尾都靠它），但不阻塞主模型：
    // 它运行期间主线程照常输出，所以按“前台子代理数”决定是否抑制主线程事件。
    const backgroundSubagents = new Set<string>()
    // A Workflow launch can be pending before it has produced a journal
    // agent (or after its last projected agent has completed). Keep the
    // watchdog armed for that whole async operation, not only while a child
    // tool_use is present.
    let workflowInFlight = false
    const workflowLaunchToolUseIds = new Set<string>()
    // Track per-item start time so commandExecution / mcpToolCall items can
    // report a real durationMs in turn/completed (otherwise the App's status
    // bar shows "—" for every command).
    const itemStartedAtMs = new Map<string, number>()
    // 这一轮里 CLI 连着的 MCP 服务的名字，由运行时在开头报上来；拆 MCP 工具名时拿它对服务名。
    const mcpServers: { names: string[] } = { names: [] }
    // Mutable holder rather than `let collectedMetrics`: TS's control-flow
    // analysis doesn't see writes from inside the onEvent callback, so a bare
    // `let` would still be inferred as `null` outside the closure.
    const collectedMetrics: {
      apiDurationMs: number | null
      numTurns: number | null
      costUsd: number | null
      set: boolean
    } = {
      apiDurationMs: null,
      numTurns: null,
      costUsd: null,
      set: false,
    }
    const forkSession = false
    // Plan mode: Claude SDK runs with permissionMode='plan' — it produces
    // planning text but does not execute tools. We surface the planning
    // output as Codex's native `plan` ThreadItem (instead of agentMessage)
    // and stream deltas via item/plan/delta + turn/plan/updated so the
    // App's Plan-mode UI lights up properly. Detection:
    //   * turn/start.planMode === true (App's explicit request)
    //   * thread.approvalPolicy / sandbox flags don't suppress it
    // The current planMode flag for this turn was computed above as
    // `params.planMode === true`; reproduce here so the helpers can check it.
    let planMode = turnSettings.planMode === true
    let planItemId: string | null = null
    const planText = new ProposedPlanParser()
    const completePlanItem = (): void => {
      if (!planItemId) return
      const item = this.store.getTurn(turn.id)?.items.find((i) => i.id === planItemId)
      if (item)
        this.notify(peer, {
          method: 'item/completed',
          params: { threadId: thread.id, turnId: turn.id, item, completedAtMs: nowMillis() },
        })
      planItemId = null
    }
    const ensurePlanItem = (): string => {
      if (planItemId) return planItemId
      planItemId = newId()
      const item: ThreadItem = { type: 'plan', id: planItemId, text: '' }
      this.store.appendItem(turn.id, item)
      this.notify(peer, {
        method: 'item/started',
        params: { threadId: thread.id, turnId: turn.id, item, startedAtMs: nowMillis() },
      })
      return planItemId
    }
    const ensureAgentItem = (): string => {
      if (agentItemId) return agentItemId
      agentItemId = newId()
      const item: ThreadItem = {
        type: 'agentMessage',
        id: agentItemId,
        text: '',
        phase: null,
        memoryCitation: null,
      }
      this.store.appendItem(turn.id, item)
      this.notify(peer, {
        method: 'item/started',
        params: { threadId: thread.id, turnId: turn.id, item, startedAtMs: nowMillis() },
      })
      return agentItemId
    }
    const ensureReasoningItem = (): string => {
      if (reasoningItemId) return reasoningItemId
      reasoningItemId = newId()
      reasoningStarted = false
      // Claude 的 thinking 本身就是面向用户的思考摘要：按推理摘要下发，桌面与手机才会像原生模型一样展示（用户 2026-09-29 决定）。
      const item: ThreadItem = {
        type: 'reasoning',
        id: reasoningItemId,
        summary: [],
        content: [],
      }
      this.store.appendItem(turn.id, item)
      this.notify(peer, {
        method: 'item/started',
        params: { threadId: thread.id, turnId: turn.id, item, startedAtMs: nowMillis() },
      })
      return reasoningItemId
    }
    const completeReasoningItem = (): void => {
      if (!reasoningItemId) return
      const item = this.store.getItem(turn.id, reasoningItemId)
      if (item)
        this.notify(peer, {
          method: 'item/completed',
          params: { threadId: thread.id, turnId: turn.id, item, completedAtMs: nowMillis() },
        })
      reasoningItemId = null
    }
    const appendAgentText = (delta: string): void => {
      const itemId = ensureAgentItem()
      this.store.appendTextLater(turn.id, itemId, delta)
      this.notify(peer, {
        method: 'item/agentMessage/delta',
        params: { threadId: thread.id, turnId: turn.id, itemId, delta },
      })
    }
    // 计划模式里回答中的 <proposed_plan> 块是计划（plan 条目），块外的照旧是回答（agentMessage），
    // 和上游 codex 一样；计划块穿插在一条回答中间时，回答还是同一个条目。
    const applyPlanSegment = (segment: ProposedPlanSegment): void => {
      if (segment.type === 'text') {
        appendAgentText(segment.text)
        return
      }
      if (segment.type === 'planStart') {
        completePlanItem()
        ensurePlanItem()
        return
      }
      if (segment.type === 'planEnd') {
        completePlanItem()
        return
      }
      const itemId = ensurePlanItem()
      this.store.appendTextLater(turn.id, itemId, segment.text)
      this.notify(peer, {
        method: 'item/plan/delta',
        params: { threadId: thread.id, turnId: turn.id, itemId, delta: segment.text },
      })
    }
    const completeAgentItem = (phase: 'commentary' | 'final_answer'): void => {
      // 一段回答说完了：解析器攒着的半行放出来
      for (const segment of planText.finish()) applyPlanSegment(segment)
      if (!agentItemId) return
      const item = this.store.updateItem(turn.id, agentItemId, (item) =>
        item.type === 'agentMessage' ? { ...item, phase } : item,
      )
      if (item)
        this.notify(peer, {
          method: 'item/completed',
          params: { threadId: thread.id, turnId: turn.id, item, completedAtMs: nowMillis() },
        })
      agentItemId = null
    }
    const completeMessage = (phase: 'commentary' | 'final_answer' = 'commentary'): void => {
      completeReasoningItem()
      completeAgentItem(phase)
    }

    // Allow per-turn override of policy (Codex App may attach updated values
    // when the user toggles Full access mid-conversation), then fall back to
    // the thread-level setting captured at start/resume. turn/start ships a
    // sandboxPolicy struct (e.g. {type:"dangerFullAccess"}); thread/start uses
    // the simpler sandbox string. Both are honoured.
    const permissionProfile = permissionProfilePolicy(
      permissionProfileIdFromParams(params),
      this.configOverrides.permissions,
    )
    const approvalPolicy =
      (params.approvalPolicy != null ? normalizeApprovalPolicy(params.approvalPolicy) : null) ??
      permissionProfile?.approvalPolicy ??
      thread.approvalPolicy
    let sandboxMode =
      (turnSettings.permissionProfile
        ? profileSandboxMode(turnSettings.permissionProfile.profile)
        : null) ??
      permissionProfile?.sandboxMode ??
      sandboxFromTurnParams(params) ??
      thread.sandboxMode
    // Per-turn instruction overrides: Codex App may resend its instruction
    // panel state when the user toggles personality mid-thread. Falls back to
    // whatever was captured at thread/start.
    const baseInstructions =
      (typeof params.baseInstructions === 'string' ? params.baseInstructions : null) ??
      thread.baseInstructions
    const developerInstructions =
      (typeof params.developerInstructions === 'string' ? params.developerInstructions : null) ??
      thread.developerInstructions
    const personality =
      (typeof params.personality === 'string' ? normalizePersonality(params.personality) : null) ??
      thread.personality
    const turnPurpose = params.outputSchema == null ? 'normal' : 'summary'
    // If this is a forked side-conversation (sidechat) that has different
    // developerInstructions from its parent, appending them to systemPromptAddendum
    // would mutate the system prompt prefix and invalidate the prefix KV cache
    // for all inherited history (80k+ tokens).
    // Instead, preserve the parent's system prompt addendum to guarantee 100% cache hits,
    // and prepend side-conversation instructions directly into the turn's user prompt.
    // 前缀照上游的语义只放一次（上游的开发者指令只在初始上下文里，压缩、回退弄没了才再放）：
    // 这个会话里已经放过同一份、还在模型的上下文里，就不再放；指令变了再放一次
    let systemPromptAddendum: string | null = null
    let effectivePrompt = prompt
    let injecting: string | null = null
    if (thread.forkedFromId != null && developerInstructions) {
      const parentThread = this.store.getThread(thread.forkedFromId)
      const parentDev = parentThread?.developerInstructions ?? null
      if (developerInstructions !== parentDev) {
        systemPromptAddendum = buildSystemPromptAddendum({
          baseInstructions: parentThread?.baseInstructions ?? baseInstructions,
          developerInstructions: parentDev,
          personality: parentThread?.personality ?? personality,
        })
        if (!this.instructionsInjected(thread.id, developerInstructions)) {
          effectivePrompt = `<side-conversation-instructions>\n${developerInstructions}\n</side-conversation-instructions>\n\n${prompt}`
          injecting = developerInstructions
        }
      } else {
        systemPromptAddendum = buildSystemPromptAddendum({
          baseInstructions,
          developerInstructions,
          personality,
        })
      }
    } else {
      systemPromptAddendum = buildSystemPromptAddendum({
        baseInstructions,
        developerInstructions,
        personality,
      })
    }

    // 追问回合跑在父会话上：系统提示、模型、工具面都与父线程的普通回合一致，
    // 才能命中父会话的提示缓存；子线程只负责展示被恢复的子代理的输出。
    const relay = turnPurpose === 'normal' ? this.subagentRelay(thread) : null
    // 子代理追问是在父会话的 CLI 里跑的一轮：父会话选着自定义档位时，档位和沙箱策略照父会话现在的
    const parentSettings = relay ? this.store.threadSettings(relay.parent.id) : null
    const permissionSettings = parentSettings?.permissionProfile ? parentSettings : turnSettings
    if (permissionSettings.permissionProfile)
      sandboxMode = profileSandboxMode(permissionSettings.permissionProfile.profile)
    // Bash 的环境变量规则：进程级配置（config.json 加 -c）上叠线程的 config；追问回合跑在父会话的 CLI 里，用父会话的
    const shellEnvironment = this.shellEnvironmentPolicy((parentSettings ?? turnSettings).config)
    if (relay) {
      systemPromptAddendum = buildSystemPromptAddendum({
        baseInstructions: relay.parent.baseInstructions,
        developerInstructions: relay.parent.developerInstructions,
        personality: relay.parent.personality,
      })
      effectivePrompt = subagentRelayPrompt(relay.agentId, prompt)
    }
    const runtimeThread = relay?.parent ?? thread
    // 追问回合用的是另一份提示词，前缀没交出去
    if (injecting !== null && !relay)
      this.rememberInjectedInstructions(thread.id, { text: injecting, turnId: turn.id })
    const rawTurnModel = relay ? relay.parent.model : stringOr(params.model, thread.model)
    // 命名空间带的 instructions 拼在用户自己的指令之后、目标说明之前：它跟着会话的工具走、不随回合变，
    // 目标说明要留在最末尾（native-session.mts 的 stableAddendum 按末尾认它）。追问回合用父会话的工具，
    // 和父会话的普通回合一致，才命中提示缓存
    if (turnPurpose === 'normal')
      systemPromptAddendum =
        [
          systemPromptAddendum,
          dynamicToolInstructions(this.store.threadSettings(runtimeThread.id).dynamicTools),
          this.goals.context(runtimeThread.id),
        ]
          .filter(Boolean)
          .join('\n\n') || null
    const isCodexThread = false
    const resolvedModel = isCodexThread
      ? rawTurnModel
      : resolveClaudeModel(rawTurnModel, params.outputSchema == null ? 'normal' : 'summary')
    const resolvedEffort = resolveClaudeEffort(
      relay
        ? (relay.parent.reasoningEffort ?? process.env.CHA_CLAUDE_EFFORT ?? null)
        : typeof params.effort === 'string'
          ? params.effort
          : (thread.reasoningEffort ?? process.env.CHA_CLAUDE_EFFORT ?? null),
    )
    // Log the effective Claude SDK model+effort per turn so when a user
    // reports "switching model didn't work" we can diff App's payload against
    // what actually reached the SDK in one grep.
    debugLog('turn.runtime.applied', {
      threadId: thread.id,
      turnId: turn.id,
      paramsModel: params.model ?? null,
      paramsEffort: params.effort ?? null,
      threadModel: thread.model,
      threadEffort: thread.reasoningEffort,
      envDefaultModel: process.env.CHA_CLAUDE_DEFAULT_MODEL ?? null,
      envDefaultEffort:
        process.env.CHA_CLAUDE_DEFAULT_EFFORT ?? process.env.CHA_CLAUDE_EFFORT ?? null,
      resolvedModel,
      resolvedEffort,
    })
    // For codex-backed threads, force the per-turn runtimeType to 'codex-proxy'
    // so the SelectableRuntime dispatches to CodexProxyRuntime instead of
    // the default Claude SDK runtime. Also route the codex session id (stored
    // separately from Claude's) through the existing claudeSessionId slot —
    // CodexProxyRuntime consumes it as the resume id. In mock mode the
    // mock runtime handles everything regardless of model id — bypass the
    // codex-proxy override so unit tests stay deterministic.
    this.subagentStateByTurn.set(turn.id, {
      thread,
      turn,
      contexts: subagentContexts,
      active: activeSubagents,
    })
    let acceptRuntimeEvents = true
    let watchdogTimer: NodeJS.Timeout | null = null
    let resolveWatchdog: (() => void) | null = null
    const watchdogTimeoutMs = subagentWatchdogTimeoutMs()
    const watchdogPromise =
      watchdogTimeoutMs > 0
        ? new Promise<void>((resolve) => {
            resolveWatchdog = resolve
          })
        : null
    const disarmWatchdog = (): void => {
      if (watchdogTimer) clearTimeout(watchdogTimer)
      watchdogTimer = null
    }
    const armWatchdog = (): void => {
      if (
        !watchdogPromise ||
        watchdogTimer ||
        !acceptRuntimeEvents ||
        (activeSubagents.size === 0 && !workflowInFlight)
      )
        return
      watchdogTimer = setTimeout(() => {
        watchdogTimer = null
        // 回合停在那里等人确认不算子代理没有回音：接着等，重新计时。
        if (this.pendingInteractions.has(thread.id)) {
          armWatchdog()
          return
        }
        // Flip this before resolving the race so an already-buffered SDK event
        // cannot create a fresh child after the watchdog has decided to fail.
        acceptRuntimeEvents = false
        resolveWatchdog?.()
      }, watchdogTimeoutMs)
      watchdogTimer.unref()
    }
    // 每来一个运行时事件都要问一遍，流式的每条增量也是：只问状态，不把整个回合读出来。
    const turnIsActive = (): boolean =>
      !this.stopped &&
      acceptRuntimeEvents &&
      this.store.turnStatus(turn.id) === 'inProgress' &&
      this.activeTurnByThread.get(thread.id) === turn.id
    if (!turnIsActive()) return
    this.runtimeReadyByTurn.get(turn.id)?.resolve(true)
    this.handedToRuntime.add(turn.id)
    const runtimeTurn = this.runtime.runTurn(
      {
        threadId: thread.id,
        turnId: turn.id,
        purpose: turnPurpose,
        goalTools: turnPurpose === 'normal',
        permissionTools: turnPurpose === 'normal',
        permissionGrants: copyPermissionOverlay(this.permissionSessionGrants.get(thread.id)),
        trackGoalTools:
          turnPurpose === 'normal' && this.store.threadGoal(thread.id)?.status === 'active',
        prompt: effectivePrompt,
        ...(relay
          ? {
              subagentRelay: { agentId: relay.agentId, message: prompt },
              sessionThreadId: relay.parent.id,
            }
          : {}),
        ...(params._spontaneous === true ? { spontaneous: true } : {}),
        goalContext: turnPurpose === 'normal' ? this.goals.context(runtimeThread.id) : null,
        cwd: relay ? relay.parent.cwd : stringOr(params.cwd, thread.cwd),
        runtimeType: isCodexThread ? 'codex-proxy' : null,
        model: resolvedModel,
        effort: resolvedEffort,
        claudeSessionId: isCodexThread ? thread.codexSessionId : runtimeThread.claudeSessionId,
        forkSession,
        mcpServers: this.mcpScope(runtimeThread.id).servers,
        mcpConfigSource: this.mcpScope(runtimeThread.id).source,
        dynamicTools: this.store.threadSettings(runtimeThread.id).dynamicTools ?? [],
        allowedTools: defaultAllowedTools(),
        addDirs: stringListFromEnv('CHA_CLAUDE_ADD_DIRS', []),
        skillOverrides: this.skills.runtimeOverrides(stringOr(params.cwd, thread.cwd)),
        outputFormat: claudeOutputFormat(params.outputSchema),
        approvalPolicy,
        sandboxMode,
        sandboxPolicy:
          permissionSettings.sandboxPolicy ?? defaultSandboxPolicy(sandboxMode, thread.cwd),
        ...(shellEnvironment ? { shellEnvironment } : {}),
        ...(permissionSettings.permissionProfile
          ? {
              fileSystem: compileFileSystemRules(
                permissionSettings.permissionProfile,
                relay ? relay.parent.cwd : stringOr(params.cwd, thread.cwd),
              ),
            }
          : {}),
        systemPromptAddendum,
        planMode,
        planConfirmation: this.asksPlanConfirmation(peer, thread.id),
        ...(turnPurpose === 'normal' && this.wantsSessionTitle(thread.id)
          ? { sessionTitle: thread.preview }
          : {}),
        imageInputs: Array.isArray(params._imageInputs)
          ? (params._imageInputs as ImageInput[])
          : [],
      },
      {
        onPermissionToolCall: async (proposal, callId) => {
          if (!turnIsActive()) throw new Error('Turn 已结束，不能申请权限')
          let itemId = itemIds.get(callId)
          if (!itemId) {
            const item = this.toolUseToItem(
              {
                type: 'tool_use',
                toolUseId: callId,
                toolName: permissionToolName,
                input: { ...proposal },
              },
              thread.cwd,
              mcpServers.names,
            )
            itemId = item.id
            itemIds.set(callId, item.id)
            this.store.appendItem(turn.id, item)
            this.notify(peer, {
              method: 'item/started',
              params: { threadId: thread.id, turnId: turn.id, item, startedAtMs: nowMillis() },
            })
          }
          this.setThreadStatus(peer, thread.id, {
            type: 'active',
            activeFlags: ['waitingOnApproval'],
          })
          try {
            const response = await this.sendServerRequest(
              peer,
              'item/permissions/requestApproval',
              newId(),
              {
                threadId: thread.id,
                turnId: turn.id,
                itemId,
                environmentId: null,
                startedAtMs: nowMillis(),
                cwd: thread.cwd,
                reason: proposal.reason,
                permissions: {
                  network: proposal.permissions.network ?? null,
                  fileSystem: proposal.permissions.fileSystem ?? null,
                },
              },
            )
            if (!turnIsActive()) throw new Error('权限请求已取消，未授予权限')
            const grant = parsePermissionGrant(proposal, response)
            if (grant.scope === 'session')
              this.permissionSessionGrants.set(
                thread.id,
                mergePermissionOverlay(this.permissionSessionGrants.get(thread.id), grant),
              )
            return grant
          } finally {
            if (turnIsActive())
              this.setThreadStatus(peer, thread.id, { type: 'active', activeFlags: [] })
          }
        },
        onGoalToolCall: async (name, args, callId) => {
          if (!turnIsActive()) throw new Error('Turn 已结束，不能执行目标工具')
          const result = this.goals.tool(thread.id, turn.id, name, args, callId)
          this.goalUpdated(thread.id, this.store.threadGoal(thread.id))
          return result
        },
        onNativeToolIntent: (callId, name, args) => {
          if (!turnIsActive()) throw new Error('Turn 已结束，不能执行原生工具')
          const prior = this.store.reserveTool(
            thread.id,
            'native:' + callId,
            submissionHash({ name, args }),
          )
          if (prior) throw new Error('原生工具已经执行并确认，禁止再次产生副作用')
        },
        onNativeToolResult: (callId, result) => {
          if (turnIsActive()) this.store.completeTool(thread.id, 'native:' + callId, result)
        },
        onDynamicToolCall: async (tool, args, callId) => {
          if (!turnIsActive()) throw new Error('Turn 已结束，不能执行工具')
          const previous = this.store.reserveTool(thread.id, callId, submissionHash({ tool, args }))
          if (previous) return previous.result
          const requestId = newId()
          completeMessage()
          const startedAt = nowMillis()
          const item: Extract<ThreadItem, { type: 'dynamicToolCall' }> = {
            type: 'dynamicToolCall',
            id: callId,
            namespace: tool.namespace ?? null,
            tool: tool.name,
            arguments: args,
            status: 'inProgress',
            contentItems: null,
            success: null,
            durationMs: null,
          }
          this.store.appendItem(turn.id, item)
          itemIds.set(callId, item.id)
          this.notify(peer, {
            method: 'item/started',
            params: {
              threadId: thread.id,
              turnId: turn.id,
              item,
              startedAtMs: startedAt,
            },
          })
          const finish = (result: unknown) => {
            // 保存执行器原始结果，不能用 SDK 为模型截断/落盘后的 tool_result 覆盖 UI 历史。
            if (!turnIsActive()) return
            const output = dynamicToolResult(result)
            const completed: ThreadItem = {
              ...item,
              ...output,
              status: output.success ? 'completed' : 'failed',
              durationMs: nowMillis() - startedAt,
            }
            this.store.updateItem(turn.id, item.id, () => completed)
            this.notify(peer, {
              method: 'item/completed',
              params: {
                threadId: thread.id,
                turnId: turn.id,
                item: completed,
                completedAtMs: nowMillis(),
              },
            })
          }
          // 客户端工具（litch_ 开头的命名空间）只交给声明过能执行它的连接，挑不出来当场失败，不等人订阅
          const namespace = tool.namespace ?? null
          const executor = isClientToolNamespace(namespace)
            ? this.clientToolExecutor(peer, thread.id, namespace as string)
            : undefined
          if (executor === null) {
            const result = noClientToolExecutor(namespace as string)
            this.store.completeTool(thread.id, callId, result)
            finish(result)
            return result
          }
          try {
            const result = dynamicToolResult(
              await this.sendServerRequest(
                peer,
                'item/tool/call',
                requestId,
                {
                  threadId: thread.id,
                  turnId: turn.id,
                  callId,
                  tool: tool.name,
                  namespace,
                  arguments: args,
                },
                undefined,
                undefined,
                executor,
              ),
            )
            this.store.completeTool(thread.id, callId, result)
            finish(result)
            return result
          } catch (error) {
            // 未收到确定结果仍保留执行意图，禁止后续重放副作用。
            finish({ success: false, contentItems: [{ type: 'inputText', text: String(error) }] })
            throw error
          }
        },
        onEvent: relayRuntimeEvents(relay !== null, async (event) => {
          // Interrupts, watchdog expiry, and a peer reconnect can leave a few
          // SDK messages queued after the server has terminalized the turn.
          // They are stale and must never resurrect a child or an inProgress
          // item in the Codex App.
          if (!turnIsActive()) return
          if (event.type === 'rate_limits') {
            this.recordRateLimits(event)
            return
          }
          if (event.type === 'native_boundary') {
            this.store.saveNativeBoundary(turn.id, event.messageId)
            return
          }
          // CLI 自己压缩了上下文：之前放在用户消息前面的指令压进了摘要，下个回合再放一次
          if (event.type === 'context_compacted') {
            this.rememberInjectedInstructions(runtimeThread.id, null)
            this.compactedUsage(peer, thread.id, turn.id, event.postTokens)
          }
          if (event.type === 'session') {
            this.store.updateClaudeSessionId(thread.id, event.claudeSessionId)
            return
          }
          if (event.type === 'mcp_servers') {
            mcpServers.names = event.names
            return
          }
          if (event.type === 'subagent_backgrounded') {
            if (!activeSubagents.has(event.toolUseId)) return
            backgroundSubagents.add(event.toolUseId)
            const ctx = subagentContexts.get(event.toolUseId)
            if (ctx) this.saveSubagentId(ctx.childThreadId, event.agentId)
            return
          }
          if (event.type === 'subagent_event') {
            // 动态工具由原始回调生成生命周期，不再按子代理的工具调用重复投影。
            if (
              event.event.type === 'tool_use' &&
              event.event.toolName.startsWith('mcp__codex_harness_adapter')
            )
              return
            subagentContexts.get(event.agentToolUseId)?.projection?.handle(event.event)
            return
          }
          if (activeSubagents.size > backgroundSubagents.size) {
            if (
              event.type === 'text_delta' ||
              event.type === 'reasoning_delta' ||
              event.type === 'message_boundary'
            )
              return
            if (event.type === 'tool_use' && !isSubagentToolName(event.toolName)) return
            if (event.type === 'tool_output_delta' && !itemIds.has(event.toolUseId)) return
            if (
              event.type === 'tool_result' &&
              !activeSubagents.has(event.toolUseId) &&
              !itemIds.has(event.toolUseId)
            )
              return
          }
          if (event.type === 'message_boundary') {
            completeMessage()
            return
          }
          if (event.type === 'tool_use' && !itemIds.has(event.toolUseId)) completeMessage()
          if (event.type === 'tool_use' && isSubagentToolName(event.toolName)) {
            // Spawn the child thread, then mirror MultiAgent V2: a
            // subAgentActivity started item plus spawnAgent/wait tool state.
            //
            // Concept alignment: Claude's `subagent_type` (e.g. "general-
            // purpose") is the same idea as Codex's `agentRole`; we also
            // generate an `agentNickname` matching the `agent-{12hex}` shape
            // Claude itself uses internally so the App's subagent UI shows a
            // distinct, repeatable handle. The collabAgentToolCall.model
            // field carries the actual SDK model the subagent runs on, NOT
            // the subagent_type — that distinction was wrong before.
            //
            // 昵称定下后不再改：桌面的标签页取子线程出现时的名字，列表行取之后读到的
            // 名字，中途改名两处就对不上。CLI 给的代理 ID 另存，见 saveSubagentId。
            const promptText = String(event.input.prompt ?? event.input.description ?? '')
            // Agent 工具的一句话描述（终端里括号里的那句）：当作子线程的名字，客户端拿它作子代理的标题
            const description =
              typeof event.input.description === 'string' && event.input.description.trim()
                ? event.input.description.trim()
                : null
            const subType =
              typeof event.input.subagent_type === 'string' ? event.input.subagent_type : null
            const subagentModel =
              typeof event.input.model === 'string' ? event.input.model : thread.model
            const childThreadId = newId()
            const agentNickname = `agent-${childThreadId.replace(/-/g, '').slice(0, 12)}`
            const agentPath = `/root/${agentNickname}`
            const agentRole = subType ?? 'general-purpose'
            const childStartedAt = nowSeconds()
            const childThread: ThreadRecord = {
              id: childThreadId,
              sessionId: thread.sessionId,
              forkedFromId: thread.id,
              isPinned: false,
              sectionId: null,
              sectionEnteredAt: null,
              sectionPosition: null,
              preview: promptText.slice(0, 200),
              name: description,
              archived: false,
              cwd: thread.cwd,
              model: subagentModel,
              reasoningEffort: thread.reasoningEffort,
              modelProvider: thread.modelProvider,
              claudeSessionId: null,
              source: normalizeSessionSource(thread.source),
              createdAt: childStartedAt,
              updatedAt: childStartedAt,
              status: { type: 'active', activeFlags: [] },
              approvalPolicy: thread.approvalPolicy,
              sandboxMode: thread.sandboxMode,
              // 跟随父线程。桌面不把打开之后的实时更新应用到临时线程，子线程一律标成
              // 临时会让运行中打开的子线程停在打开那一刻，状态一直是运行中。
              ephemeral: thread.ephemeral,
              threadSource: 'subagent',
              agentRole,
              agentNickname,
              // Subagent inherits parent's instruction surface so the same
              // project/developer guidance applies to the child run.
              baseInstructions: thread.baseInstructions,
              developerInstructions: thread.developerInstructions,
              personality: thread.personality,
              // Subagents always run via Claude — the Task tool is a Claude SDK
              // construct. A codex-backed thread that spawns a subagent would
              // never reach this code path (subagent detection is Claude-side).
              runtimeBackend: 'claude',
              codexSessionId: null,
            }
            this.store.upsertThread(childThread)
            // 子代理在父会话的 CLI 里跑，权限档就是父会话的：快照跟着记到子线程上（报给客户端的也一致）
            const parentProfile = this.store.threadSettings(thread.id)
            if (parentProfile.permissionProfile) {
              const childSettings = this.store.threadSettings(childThreadId)
              childSettings.permissionProfile = parentProfile.permissionProfile
              if (parentProfile.sandboxPolicy)
                childSettings.sandboxPolicy = parentProfile.sandboxPolicy
              this.store.saveThreadSettings(childThreadId, childSettings)
            }
            // Child notifications must follow the current parent peer. This
            // matters after unix-daemon reconnects, when the old peer is gone
            // before the child publishes its response.
            // 没有连接订阅父线程时不登记：占位连接进了路由表，子线程的通知会一直被丢到父线程恢复为止。
            // 父线程有几条连接订阅时，子线程跟着它们全部。
            for (const subscriber of this.recipients(peer, { threadId: thread.id }))
              if (this.isConnected(subscriber)) this.subscribers.add(childThreadId, subscriber)
            const childTurn: TurnRecord = {
              id: newId(),
              threadId: childThreadId,
              status: 'inProgress',
              startedAt: childStartedAt,
              completedAt: null,
              durationMs: null,
              items: [
                {
                  type: 'userMessage',
                  id: newId(),
                  content: [{ type: 'text', text: promptText, text_elements: [] }],
                },
              ],
              diff: '',
              error: null,
            }
            this.store.upsertTurn(childTurn)
            // 明确发给子线程的每条订阅连接（上面刚跟着父线程登记的）；没有连接在看时，照旧给发起回合的那条连接。
            // 不像别的会话那样发给所有连接（见 announce）：上游不为子代理的会话发 thread/started，
            // 这一条是父会话回合里的事，只给看着父会话的连接。
            const childStarted = {
              method: 'thread/started',
              params: { thread: this.toThread(childThread, []) },
            }
            for (const subscriber of this.recipients(peer, { threadId: childThreadId }))
              this.notifyOnly(subscriber, childStarted)
            this.notify(peer, {
              method: 'turn/started',
              params: {
                threadId: childThreadId,
                turn: this.toLifecycleTurn(childTurn),
              },
            })
            // The bundled Codex cc client creates a child conversation from
            // thread/started with an empty turn and treats the history as
            // loaded while the child is live. Replay the persisted prompt as
            // a normal item lifecycle so the child page has its Prompt even
            // when it is opened before the first response token arrives.
            const childPrompt = childTurn.items.find((item) => item.type === 'userMessage')
            if (childPrompt) this.emitItemLifecycle(peer, childThreadId, childTurn.id, childPrompt)
            recordRunEvent('subagent.spawned', {
              parentThreadId: thread.id,
              parentTurnId: turn.id,
              childThreadId,
              model: subagentModel,
              agentRole,
              agentNickname,
            })

            // Stage 1 — spawnAgent (begin + end emitted together; the agent is
            // already created so there's no real latency here).
            const spawnId = newId()
            // Codex v2 collabAgentToolCall.reasoningEffort is `ReasoningEffort | null`
            // (strict enum: none|minimal|low|medium|high|xhigh). Same Oops trap as
            // threadSource — an empty string from a sloppy resume crashes the App.
            // Normalize here once and reuse for every stage of the lifecycle.
            const collabEffort = normalizeReasoningEffortEnum(thread.reasoningEffort)
            const spawnBegin: ThreadItem = {
              type: 'collabAgentToolCall',
              id: spawnId,
              tool: 'spawnAgent',
              status: 'inProgress',
              senderThreadId: thread.id,
              receiverThreadIds: [],
              prompt: promptText || null,
              model: subagentModel,
              reasoningEffort: collabEffort,
              agentsStates: {},
            }
            this.store.appendItem(turn.id, spawnBegin)
            this.notify(peer, {
              method: 'item/started',
              params: {
                threadId: thread.id,
                turnId: turn.id,
                item: spawnBegin,
                startedAtMs: nowMillis(),
              },
            })
            const spawnEnd: ThreadItem = {
              type: 'collabAgentToolCall',
              id: spawnId,
              tool: 'spawnAgent',
              status: 'completed',
              senderThreadId: thread.id,
              receiverThreadIds: [childThreadId],
              prompt: promptText || null,
              model: subagentModel,
              reasoningEffort: collabEffort,
              agentsStates: { [childThreadId]: { status: 'running', message: null } },
            }
            this.store.updateItem(turn.id, spawnId, () => spawnEnd)
            this.notify(peer, {
              method: 'item/completed',
              params: {
                threadId: thread.id,
                turnId: turn.id,
                item: spawnEnd,
                completedAtMs: nowMillis(),
              },
            })
            const waitId = newId()
            const subagentContext: SubagentContext = {
              childThreadId,
              childTurnId: childTurn.id,
              waitItemId: waitId,
              agentPath,
              prompt: promptText,
              subType,
              spawnItem: spawnEnd,
              projection: new SubagentProjection(
                {
                  appendItem: (item) => void this.store.appendItem(childTurn.id, item),
                  updateItem: (itemId, update) =>
                    this.store.updateItem(childTurn.id, itemId, update),
                  notify: (method, params) => this.notify(peer, { method, params }),
                  toolItem: (toolEvent) =>
                    this.toolUseToItem(toolEvent, thread.cwd, mcpServers.names),
                },
                childThreadId,
                childTurn.id,
              ),
            }
            this.emitSubagentActivity(peer, thread.id, turn.id, subagentContext, 'started')

            // Wait begins after the activity item; this is the long phase that
            // gives Codex App its "agent is working" indicator while the
            // subagent runs. It closes when the Task tool_result arrives.
            const waitBegin: ThreadItem = {
              type: 'collabAgentToolCall',
              id: waitId,
              tool: 'wait',
              status: 'inProgress',
              senderThreadId: thread.id,
              receiverThreadIds: [childThreadId],
              prompt: null,
              model: null,
              reasoningEffort: null,
              agentsStates: {},
            }
            this.store.appendItem(turn.id, waitBegin)
            this.notify(peer, {
              method: 'item/started',
              params: {
                threadId: thread.id,
                turnId: turn.id,
                item: waitBegin,
                startedAtMs: nowMillis(),
              },
            })

            itemIds.set(event.toolUseId, waitId)
            subagentContexts.set(event.toolUseId, subagentContext)
            activeSubagents.add(event.toolUseId)
            armWatchdog()
            return
          }
          if (event.type === 'tool_result' && activeSubagents.has(event.toolUseId)) {
            const ctx = subagentContexts.get(event.toolUseId)
            if (!ctx) return
            const rawResultText = toolResultText(event.content)
            const collabStatus: 'completed' | 'failed' = event.isError ? 'failed' : 'completed'
            const agentStatus: 'completed' | 'errored' = event.isError ? 'errored' : 'completed'

            // claude-agent-sdk's Task tool appends a metadata trailer to the
            // result content: an `agentId: <hex>` line + a `<usage>...</usage>`
            // block. Codex App doesn't render those — they just leak as raw
            // text. Strip them from the visible body and route the metadata
            // into the proper protocol fields (agentNickname / tokenUsage /
            // metrics) so the subagent timeline carries the same identity +
            // usage the SDK reports.
            // 结构化结果不带模型侧的包装前缀；拿不到时才回退到解析文本尾部。
            const parsed =
              subagentStructuredResult(event.structured) ?? parseSubagentTrailer(rawResultText)
            const resultText = parsed.cleanText
            // 失败时 CLI 给的结果就是原因（钩子拒绝、子代理类型不存在……），原话写进子线程回合的 error
            const failure = event.isError ? subagentFailure(resultText) : null

            const childTurn = this.completeSubagentChildTurn(
              peer,
              ctx,
              resultText,
              event.isError ? 'failed' : 'completed',
              failure ? { message: failure } : null,
              parsed.usage?.durationMs ?? null,
            )
            recordRunEvent('subagent.completed', {
              parentThreadId: thread.id,
              parentTurnId: turn.id,
              childThreadId: ctx.childThreadId,
              childTurnId: childTurn.id,
              status: childTurn.status,
              agentRole: ctx.subType ?? 'general-purpose',
            })
            const childThread = this.store.getThread(ctx.childThreadId)
            if (childThread) {
              childThread.updatedAt = nowSeconds()
              this.store.upsertThread(childThread)
            }
            if (parsed.agentId) this.saveSubagentId(ctx.childThreadId, parsed.agentId)

            // The child completion activity arrives before wait/completed in
            // native V2. The installed Codex cc schema predates the
            // `completed` activity kind, so only send it when the client
            // explicitly advertises support; the wait terminal snapshot is
            // sufficient for legacy reducers.
            if (event.isError || this.subagentActivityAudience(peer, thread.id).aware) {
              this.emitSubagentActivity(
                peer,
                thread.id,
                turn.id,
                ctx,
                event.isError ? 'interrupted' : 'completed',
              )
            }

            // Push the subagent's token usage as a Codex-native
            // thread/tokenUsage/updated notification on the CHILD thread
            // (App's status bar reads from this) and roll the totals into
            // the parent thread so subagent costs aren't invisible.
            if (parsed.usage && parsed.usage.totalTokens) {
              const breakdown: TokenUsageBreakdown = {
                totalTokens: parsed.usage.totalTokens,
                inputTokens: 0,
                cachedInputTokens: 0,
                outputTokens: parsed.usage.totalTokens,
                reasoningOutputTokens: 0,
              }
              // 子线程的占用是它最后一次请求的（运行时按请求报过就有）；窗口先借父线程的
              const childStored = this.store.threadUsage(ctx.childThreadId)?.tokenUsage
              const childUsage: ThreadTokenUsage = {
                total: breakdown,
                last: childStored?.last ?? breakdown,
                modelContextWindow:
                  childStored?.modelContextWindow ??
                  this.store.threadUsage(thread.id)?.tokenUsage.modelContextWindow ??
                  null,
              }
              this.store.saveThreadUsage(ctx.childThreadId, childTurn.id, childUsage)
              this.notify(peer, {
                method: 'thread/tokenUsage/updated',
                params: {
                  threadId: ctx.childThreadId,
                  turnId: childTurn.id,
                  tokenUsage: childUsage,
                },
              })
              // 父线程只加进累计，不改它的占用
              this.recordTokenUsage(peer, thread.id, turn.id, {
                add: {
                  input_tokens: 0,
                  output_tokens: parsed.usage.totalTokens,
                  cache_read_input_tokens: 0,
                  cache_creation_input_tokens: 0,
                },
              })
            }

            this.resettleSpawnItem(peer, thread.id, turn.id, ctx, agentStatus, failure)

            // Stage 2 close — wait (end). Re-emits the same waitItemId.
            const waitEnd: ThreadItem = {
              type: 'collabAgentToolCall',
              id: ctx.waitItemId,
              tool: 'wait',
              status: collabStatus,
              senderThreadId: thread.id,
              receiverThreadIds: [ctx.childThreadId],
              prompt: null,
              model: null,
              reasoningEffort: null,
              agentsStates: { [ctx.childThreadId]: { status: agentStatus, message: failure } },
            }
            this.store.updateItemAndMoveToEnd(turn.id, ctx.waitItemId, () => waitEnd)
            this.notify(peer, {
              method: 'item/completed',
              params: {
                threadId: thread.id,
                turnId: turn.id,
                item: waitEnd,
                completedAtMs: nowMillis(),
              },
            })

            // Codex cc 26.x does not advertise the terminal
            // subAgentActivity kind. For a successful child, wait/completed
            // is already the terminal display state; appending closeAgent
            // makes the bundled client hide the finished child. Keep the
            // legacy closeAgent cleanup only for failed results.
            if (this.subagentActivityAudience(peer, thread.id).legacy && event.isError) {
              const closeId = newId()
              const closeBegin: ThreadItem = {
                type: 'collabAgentToolCall',
                id: closeId,
                tool: 'closeAgent',
                status: 'inProgress',
                senderThreadId: thread.id,
                receiverThreadIds: [ctx.childThreadId],
                prompt: null,
                model: null,
                reasoningEffort: null,
                agentsStates: {},
              }
              this.store.appendItem(turn.id, closeBegin)
              this.notify(peer, {
                method: 'item/started',
                params: {
                  threadId: thread.id,
                  turnId: turn.id,
                  item: closeBegin,
                  startedAtMs: nowMillis(),
                },
              })
              const closeEnd: ThreadItem = {
                ...closeBegin,
                status: collabStatus,
                agentsStates: { [ctx.childThreadId]: { status: agentStatus, message: failure } },
              }
              this.store.updateItem(turn.id, closeId, () => closeEnd)
              this.notify(peer, {
                method: 'item/completed',
                params: {
                  threadId: thread.id,
                  turnId: turn.id,
                  item: closeEnd,
                  completedAtMs: nowMillis(),
                },
              })
            }
            // Keep the context discoverable until the child turn and wait
            // item have both been persisted. If one of those operations throws,
            // the outer settlement path can still finalize the child as failed.
            activeSubagents.delete(event.toolUseId)
            backgroundSubagents.delete(event.toolUseId)
            subagentContexts.delete(event.toolUseId)
            if (activeSubagents.size === 0 && !workflowInFlight) disarmWatchdog()
            return
          }
          if (event.type === 'plan_text') {
            completePlanItem()
            // 计划文件里的就是计划：条目只放文件的内容。
            const itemId = ensurePlanItem()
            this.store.updateItem(turn.id, itemId, (item) =>
              item.type === 'plan' ? { ...item, text: event.text } : item,
            )
            this.notify(peer, {
              method: 'item/plan/delta',
              params: { threadId: thread.id, turnId: turn.id, itemId, delta: event.text },
            })
            return
          }
          if (event.type === 'plan_handoff') {
            // 模型交了计划（ExitPlanMode）。入口不问时（发起回合的连接没声明 planConfirmation）回合随后停下，
            // 客户端在回合结束后看最后一个计划条目来问；入口在回合里问时，这一条先于提问到。
            // 这个回合里还没有成文的计划时补一个计划条目：先用 CLI 交来的计划（计划是之前的回合写进计划文件的）；
            // CLI 也没有（模型没写文件、没用 <proposed_plan>，只是把计划说了出来）就用刚说完的那段回答，
            // 不然客户端找不到计划可问。这时那段话既是回答也是计划，界面上会出现两次。
            completeMessage()
            completePlanItem()
            const items = this.store.getTurn(turn.id)?.items ?? []
            const written = items.some((item) => item.type === 'plan' && item.text.trim() !== '')
            const spoken = items.findLast(
              (item) => item.type === 'agentMessage' && item.text.trim() !== '',
            )
            const plan = event.plan ?? (spoken?.type === 'agentMessage' ? spoken.text : null)
            if (!written && plan) {
              const itemId = ensurePlanItem()
              this.store.updateItem(turn.id, itemId, (item) =>
                item.type === 'plan' ? { ...item, text: plan } : item,
              )
              this.notify(peer, {
                method: 'item/plan/delta',
                params: { threadId: thread.id, turnId: turn.id, itemId, delta: plan },
              })
              completePlanItem()
            }
            return
          }
          if (event.type === 'plan_mode') {
            completeMessage()
            completePlanItem()
            planMode = event.enabled
            this.threadSettingsUpdate(peer, {
              threadId: thread.id,
              collaborationMode: { mode: planMode ? 'plan' : 'default' },
            })
            return
          }
          if (event.type === 'text_delta') {
            if (event.delta.length === 0) return
            completeReasoningItem()
            hasTextOutput = true
            // 计划模式里只有 <proposed_plan> 块进计划条目，其余的话是回答（上游 codex 0.163.0 也是这样）；
            // 计划文件的内容、ExitPlanMode 交来的计划另由 plan_text、plan_handoff 记成计划条目。
            // 结构化摘要属于输出结果，不能混进计划正文或改变计划状态。
            // 流式的字只记一笔（appendTextLater），不是每条增量都把整个回合写一遍。下面两处和思考、命令输出都是。
            if (planMode && params.outputSchema == null) {
              for (const segment of planText.push(event.delta)) applyPlanSegment(segment)
              return
            }
            appendAgentText(event.delta)
            return
          }
          if (event.type === 'reasoning_delta') {
            if (event.delta.length === 0) return
            completeAgentItem('commentary')
            const itemId = ensureReasoningItem()
            // 这条思考的头一段字：摘要原先是空的，先告诉客户端多了一段
            const firstPart = !reasoningStarted
            reasoningStarted = true
            this.store.appendTextLater(turn.id, itemId, event.delta)
            if (firstPart)
              this.notify(peer, {
                method: 'item/reasoning/summaryPartAdded',
                params: { threadId: thread.id, turnId: turn.id, itemId, summaryIndex: 0 },
              })
            this.notify(peer, {
              method: 'item/reasoning/summaryTextDelta',
              params: {
                threadId: thread.id,
                turnId: turn.id,
                itemId,
                delta: event.delta,
                summaryIndex: 0,
              },
            })
            return
          }
          if (event.type === 'tool_use') {
            // 动态工具由原始回调生成完整生命周期，SDK 的代理 MCP 事件不能再生成重复项。
            if (event.toolName.startsWith('mcp__codex_harness_adapter__')) return
            if (isWorkflowToolName(event.toolName)) {
              workflowLaunchToolUseIds.add(event.toolUseId)
              workflowInFlight = true
              armWatchdog()
            }
            // Defense in depth against duplicate tool_use events for the same
            // tool_use_id. Claude SDK has been known to emit a block_start
            // event with an empty input AND a complete copy in the final
            // AssistantMessage — sidecar suppresses the empty start, but if
            // anything slips through we'd otherwise create a husk
            // commandExecution item that never closes (the second emit
            // overwrites itemIds[] so the husk never sees its tool_result).
            if (itemIds.has(event.toolUseId)) return
            // Claude's TodoWrite is the equivalent of Codex's `update_plan`
            // todo/checklist tool, which the real app-server maps to a
            // turn/plan/updated notification (structured steps) rather than a
            // timeline item. Mirror that: emit the structured plan and suppress
            // the generic tool item so the App's plan/checklist UI drives off
            // the spec'd notification.
            if (event.toolName === 'TodoWrite') {
              const plan = todoWriteToPlanSteps(event.input)
              if (plan) {
                this.notify(peer, {
                  method: 'turn/plan/updated',
                  params: { threadId: thread.id, turnId: turn.id, explanation: null, plan },
                })
              }
              itemIds.set(event.toolUseId, '')
              return
            }
            const item = this.toolUseToItem(event, thread.cwd, mcpServers.names)
            itemIds.set(event.toolUseId, item.id)
            itemStartedAtMs.set(item.id, nowMillis())
            this.store.appendItem(turn.id, item)
            this.notify(peer, {
              method: 'item/started',
              params: { threadId: thread.id, turnId: turn.id, item, startedAtMs: nowMillis() },
            })
            if (item.type === 'fileChange') {
              this.notify(peer, {
                method: 'item/fileChange/patchUpdated',
                params: {
                  threadId: thread.id,
                  turnId: turn.id,
                  itemId: item.id,
                  changes: item.changes,
                },
              })
            }
            return
          }
          if (event.type === 'tool_output_delta') {
            const itemId = itemIds.get(event.toolUseId)
            if (!itemId) return
            commandOutputSeen.add(itemId)
            this.store.appendTextLater(turn.id, itemId, event.delta)
            this.notify(peer, {
              method: 'item/commandExecution/outputDelta',
              params: { threadId: thread.id, turnId: turn.id, itemId, delta: event.delta },
            })
            return
          }
          if (event.type === 'tool_result') {
            if (workflowLaunchToolUseIds.delete(event.toolUseId)) {
              workflowInFlight = workflowLaunchToolUseIds.size > 0
              if (activeSubagents.size === 0 && !workflowInFlight) disarmWatchdog()
            }
            const itemId = itemIds.get(event.toolUseId)
            if (!itemId) return
            // 被拒绝的调用没有执行：条目在审批应答时已经收尾，这条结果只是交给模型的那句拒绝的话。
            if (declinedToolUses.has(event.toolUseId)) return
            if (
              event.backgroundTaskId &&
              this.trackBackgroundCommand(
                relay?.parent.id ?? thread.id,
                thread.id,
                turn.id,
                itemId,
                event.backgroundTaskId,
                itemStartedAtMs.get(itemId),
              )
            )
              return
            const resultText = toolResultText(event.content)
            const durationMs = (() => {
              const started = itemStartedAtMs.get(itemId)
              return started == null ? null : Math.max(0, nowMillis() - started)
            })()
            const item = this.store.updateItem(turn.id, itemId, (item) =>
              toolItemWithResult(item, event.content, event.isError === true, durationMs),
            )
            if (item?.type === 'commandExecution' && resultText && !commandOutputSeen.has(itemId)) {
              this.notify(peer, {
                method: 'item/commandExecution/outputDelta',
                params: { threadId: thread.id, turnId: turn.id, itemId, delta: resultText },
              })
            }
            if (item && item.type !== 'dynamicToolCall')
              this.notify(peer, {
                method: 'item/completed',
                params: { threadId: thread.id, turnId: turn.id, item, completedAtMs: nowMillis() },
              })
            // 读的是图：和上游 view_image 一样另有一个 imageView 条目，开始和完成一起发
            const image =
              item && readImageView(item, event.content, event.isError === true, thread.cwd)
            if (image) {
              this.store.appendItem(turn.id, image)
              const at = nowMillis()
              this.notify(peer, {
                method: 'item/started',
                params: { threadId: thread.id, turnId: turn.id, item: image, startedAtMs: at },
              })
              this.notify(peer, {
                method: 'item/completed',
                params: { threadId: thread.id, turnId: turn.id, item: image, completedAtMs: at },
              })
            }
            const diff = await gitTurnDiff(thread.cwd, diffBase)
            if (this.store.turnStatus(turn.id) !== 'inProgress') return
            if (diff) {
              this.store.updateTurnDiff(turn.id, diff)
              this.notify(peer, {
                method: 'turn/diff/updated',
                params: { threadId: thread.id, turnId: turn.id, diff },
              })
            }
            return
          }
          if (event.type === 'notice') {
            debugLog('turn.runtime.notice', { threadId: thread.id, turnId: turn.id, ...event })
            // Runtime status is not assistant prose. Keep genuine warnings
            // visible in the native warning surface without breaking Markdown.
            if (event.level !== 'info' && !noticesSeen.has(event.message)) {
              noticesSeen.add(event.message)
              this.notify(peer, {
                method: 'warning',
                params: { threadId: thread.id, message: event.message },
              })
            }
            return
          }
          if (event.type === 'usage') {
            this.recordTokenUsage(peer, thread.id, turn.id, {
              add: event.usage,
              window: event.contextWindow ?? null,
            })
            return
          }
          if (event.type === 'context_usage') {
            const last = tokenBreakdownFromClaudeUsage(event.usage)
            if (!event.agentToolUseId) {
              this.recordTokenUsage(peer, thread.id, turn.id, { last })
              return
            }
            // 子代理自己的请求：记在它的子线程上，窗口先借父线程的
            const ctx = subagentContexts.get(event.agentToolUseId)
            if (ctx)
              this.recordTokenUsage(peer, ctx.childThreadId, ctx.childTurnId, {
                last,
                window: this.store.threadUsage(thread.id)?.tokenUsage.modelContextWindow ?? null,
              })
            return
          }
          if (event.type === 'goal_usage') {
            this.goalUpdated(
              thread.id,
              this.goals.usage(
                thread.id,
                turn.id,
                event.messageId,
                tokenBreakdownFromClaudeUsage(event.usage).totalTokens,
              ),
            )
            return
          }
          if (event.type === 'goal_limit') {
            if (event.usageLimited) this.goalUsageLimited.add(turn.id)
            return
          }
          if (event.type === 'hook') {
            const update = this.store.recordHookEvent(turn.id, event)
            if (!update) return
            if (update.started)
              this.notify(peer, {
                method: 'item/started',
                params: {
                  threadId: thread.id,
                  turnId: turn.id,
                  item: update.item,
                  startedAtMs: nowMillis(),
                },
              })
            if (update.completed)
              this.notify(peer, {
                method: 'item/completed',
                params: {
                  threadId: thread.id,
                  turnId: turn.id,
                  item: update.item,
                  completedAtMs: nowMillis(),
                },
              })
            return
          }
          if (event.type === 'metrics') {
            // Track metrics on the runRuntimeTurn closure rather than in the
            // SQLite turns row (which doesn't have these columns). They get
            // merged into the final TurnRecord shipped via turn/completed.
            collectedMetrics.apiDurationMs = event.apiDurationMs
            collectedMetrics.numTurns = event.numTurns
            collectedMetrics.costUsd = event.costUsd
            collectedMetrics.set = true
            return
          }
          if (event.type === 'completed') {
            if (event.claudeSessionId) {
              // Codex-backed threads route the SAME claudeSessionId slot into
              // codex_session_id (used as `codex exec resume <id>` on the
              // next turn). Claude threads keep the original wiring.
              if (isCodexThread) {
                this.store.updateCodexSessionId(thread.id, event.claudeSessionId)
              } else {
                this.store.updateClaudeSessionId(thread.id, event.claudeSessionId)
              }
            }
            if (!event.success)
              throw new TurnFailure(
                event.result ?? 'Claude turn failed',
                event.codexErrorInfo ?? null,
              )
          }
          if (event.type === 'error') {
            throw new Error(event.message)
          }
        }),
        onElicitationRequest: async (request, signal) => {
          if (
            typeof approvalPolicy === 'object' &&
            approvalPolicy !== null &&
            !allowsApproval(approvalPolicy, 'mcp_elicitations')
          )
            return { action: 'decline' }
          if (!turnIsActive() || signal.aborted) return { action: 'cancel' }
          completeMessage()
          const requestId = newId()
          const params = elicitationParams(request, thread.id, turn.id)
          this.setThreadStatus(peer, thread.id, {
            type: 'active',
            activeFlags: ['waitingOnUserInput'],
          })
          try {
            const response = await this.sendServerRequest(
              peer,
              'mcpServer/elicitation/request',
              requestId,
              params,
              signal,
            )
            if (!turnIsActive() || signal.aborted) return { action: 'cancel' }
            return elicitationResponse(request, response)
          } finally {
            if (turnIsActive())
              this.setThreadStatus(peer, thread.id, { type: 'active', activeFlags: [] })
          }
        },
        onPermissionRequest: async (event) => {
          if (!turnIsActive()) return { decision: 'cancel' }
          completeMessage()
          let itemId = itemIds.get(event.toolUseId)
          if (!itemId) {
            const item = this.toolUseToItem(
              {
                type: 'tool_use',
                toolUseId: event.toolUseId,
                toolName: event.toolName,
                input: event.input,
              },
              thread.cwd,
              mcpServers.names,
            )
            itemId = item.id
            itemIds.set(event.toolUseId, item.id)
            this.store.appendItem(turn.id, item)
            this.notify(peer, {
              method: 'item/started',
              params: { threadId: thread.id, turnId: turn.id, item, startedAtMs: nowMillis() },
            })
            if (item.type === 'fileChange') {
              this.notify(peer, {
                method: 'item/fileChange/patchUpdated',
                params: {
                  threadId: thread.id,
                  turnId: turn.id,
                  itemId: item.id,
                  changes: item.changes,
                },
              })
            }
          }
          const mcp = mcpToolRef(event.toolName, mcpServers.names)
          const decision = await this.requestApproval(peer, thread.id, turn.id, itemId, event, mcp)
          if (!turnIsActive()) return { decision: 'cancel' }
          if (decision.decision === 'decline' || decision.decision === 'cancel') {
            // 照上游：拒绝和“拒绝并停下”都当场把条目收尾成“已拒绝”，不等 CLI 交回那句给模型看的话；
            // 没有这种状态的条目类型照旧由工具结果（停下时由回合收尾）收尾。
            const declinedId = itemId
            const item = this.store.updateItem(turn.id, declinedId, declinedToolItem)
            if (item && 'status' in item && item.status === 'declined') {
              declinedToolUses.add(event.toolUseId)
              this.notify(peer, {
                method: 'item/completed',
                params: { threadId: thread.id, turnId: turn.id, item, completedAtMs: nowMillis() },
              })
            }
          }
          if (decision.decision === 'cancel') {
            // 取消意味着终止回合；先同步持久化中断，再异步等待 CLI 停止，避免权限回调互等。
            void this.turnInterrupt(peer, { threadId: thread.id, turnId: turn.id }).catch(
              (error) => {
                this.notifyThread(thread.id, {
                  method: 'warning',
                  params: { threadId: thread.id, message: String(error) },
                })
              },
            )
            return decision
          }
          if (decision.decision === 'acceptForSession') {
            const grant = sessionGrantKey(thread, event, mcp)
            if (grant) {
              const set = this.commandSessionAllow.get(thread.id) ?? new Set<string>()
              set.add(grant)
              this.commandSessionAllow.set(thread.id, set)
            }
          }
          return decision
        },
        onUserInputRequest: async (event) => {
          if (!turnIsActive()) return { answers: {} }
          completeMessage()
          if (event.toolName === 'ExitPlanMode') {
            // 模型交计划了：计划条目到此为止，先收尾再问。
            completePlanItem()
          }
          // Render AskUserQuestion as Codex's native dynamicToolCall item +
          // item/tool/requestUserInput reverse RPC. The App pops its
          // structured choice card; we wait for the answers, finalise the
          // item, then return the structured answer back to the runtime
          // 答案通过 SDK canUseTool 的 updatedInput 正式返回。
          const item: ThreadItem = {
            type: 'dynamicToolCall',
            id: newId(),
            namespace: 'claude',
            tool: event.toolName ?? 'AskUserQuestion',
            arguments: { questions: event.questions },
            status: 'inProgress',
            contentItems: null,
            success: null,
            durationMs: null,
          }
          this.store.appendItem(turn.id, item)
          const startedAt = nowMillis()
          this.notify(peer, {
            method: 'item/started',
            params: { threadId: thread.id, turnId: turn.id, item, startedAtMs: startedAt },
          })
          this.setThreadStatus(peer, thread.id, {
            type: 'active',
            activeFlags: ['waitingOnUserInput'],
          })
          try {
            const answers = await this.requestUserInput(
              peer,
              thread.id,
              turn.id,
              item.id,
              event.questions,
              planMode,
            )
            if (!turnIsActive()) return { answers: {} }
            const contentItems = userInputAnswersAsContent(event.questions, answers)
            const completedItem: ThreadItem = {
              ...item,
              status: 'completed',
              success: true,
              contentItems,
              durationMs: Math.max(0, nowMillis() - startedAt),
            }
            this.store.updateItem(turn.id, item.id, () => completedItem)
            this.notify(peer, {
              method: 'item/completed',
              params: {
                threadId: thread.id,
                turnId: turn.id,
                item: completedItem,
                completedAtMs: nowMillis(),
              },
            })
            return answers
          } catch (error) {
            // 超时可能被原生工具转换成拒绝后继续模型，必须在这里结束提问条目。
            // 中断路径已结束的条目不重复发布，迟到答案也不能恢复该条目。
            if (turnIsActive() && this.activeItemsByTurn.get(turn.id)?.has(item.id)) {
              const message = error instanceof Error ? error.message : String(error)
              const failedItem: ThreadItem = {
                ...item,
                status: 'failed',
                success: false,
                contentItems: [{ type: 'inputText', text: message }],
                durationMs: Math.max(0, nowMillis() - startedAt),
              }
              this.store.updateItem(turn.id, item.id, () => failedItem)
              this.notify(peer, {
                method: 'item/completed',
                params: {
                  threadId: thread.id,
                  turnId: turn.id,
                  item: failedItem,
                  completedAtMs: nowMillis(),
                },
              })
            }
            throw error
          } finally {
            if (turnIsActive())
              this.setThreadStatus(peer, thread.id, { type: 'active', activeFlags: [] })
          }
        },
      },
    )
    const runtimeOutcome = runtimeTurn.then(
      () => ({ kind: 'resolved' as const }),
      (error: unknown) => ({
        kind: 'rejected' as const,
        error: error instanceof Error ? error : new Error(String(error)),
      }),
    )
    const outcome = watchdogPromise
      ? await Promise.race([
          runtimeOutcome,
          watchdogPromise.then(() => ({ kind: 'timeout' as const })),
        ])
      : await runtimeOutcome
    disarmWatchdog()
    acceptRuntimeEvents = false
    if (this.stopped) return
    for (const item of this.store.finishHookRuns(
      turn.id,
      'unknown',
      'SDK 已结束但未返回此 Hook 终态；执行结果不确定，不自动重放',
    )) {
      this.notify(peer, {
        method: 'item/completed',
        params: {
          threadId: thread.id,
          turnId: turn.id,
          item,
          completedAtMs: nowMillis(),
        },
      })
    }
    if (outcome.kind === 'timeout') {
      const timeoutSeconds = Math.ceil(watchdogTimeoutMs / 1000)
      const timeoutUnit = timeoutSeconds === 1 ? 'second' : 'seconds'
      const message = `Subagent did not publish a terminal result within ${timeoutSeconds} ${timeoutUnit}.`
      if (this.store.turnStatus(turn.id) === 'inProgress') {
        completeMessage()
        this.finalizeOrphanedSubagents(
          peer,
          thread,
          turn,
          subagentContexts,
          activeSubagents,
          message,
        )
        this.subagentStateByTurn.delete(turn.id)
        // 原生中断包含有界强制终止；必须等 CLI 停止后才能释放用户审批。
        await this.runtime.interrupt(thread.id)
      }
      throw new Error(message)
    }
    if (outcome.kind === 'rejected') {
      if (this.store.turnStatus(turn.id) === 'inProgress') {
        completeMessage()
        this.finalizeOrphanedSubagents(peer, thread, turn, subagentContexts, activeSubagents)
      }
      this.subagentStateByTurn.delete(turn.id)
      throw outcome.error
    }
    if (this.store.turnStatus(turn.id) === 'inProgress') {
      this.finalizeOrphanedSubagents(peer, thread, turn, subagentContexts, activeSubagents)
    }
    this.subagentStateByTurn.delete(turn.id)
    // 回合结束前这几处只问状态，不把整个回合读出来
    const currentStatus = this.store.turnStatus(turn.id)
    if (currentStatus && currentStatus !== 'inProgress') return

    const finalDiff = await gitTurnDiff(thread.cwd, diffBase)
    if (this.stopped) return
    if (this.store.turnStatus(turn.id) !== 'inProgress') return
    if (finalDiff) {
      this.store.updateTurnDiff(turn.id, finalDiff)
      this.notify(peer, {
        method: 'turn/diff/updated',
        params: { threadId: thread.id, turnId: turn.id, diff: finalDiff },
      })
    }
    if (params.outputSchema != null && !hasTextOutput) {
      throw new Error('运行时未返回结构化结果')
    }
    completeMessage('final_answer')
    const planItem = this.store.getTurn(turn.id)?.items.find((item) => item.id === planItemId)
    if (planItem)
      this.notify(peer, {
        method: 'item/completed',
        params: {
          threadId: thread.id,
          turnId: turn.id,
          item: planItem,
          completedAtMs: nowMillis(),
        },
      })
    this.finishReview(peer, thread.id, turn.id)
    this.finishGoal(thread.id, turn.id, 'completed')
    const completed: TurnRecord = this.store.completeTurn(turn.id, 'completed') ?? turn
    recordRunEvent('turn.completed', {
      threadId: thread.id,
      turnId: turn.id,
      runtimeBackend: thread.runtimeBackend,
      durationMs: completed.durationMs,
      apiDurationMs: collectedMetrics.apiDurationMs,
      numTurns: collectedMetrics.numTurns,
      costUsd: collectedMetrics.costUsd,
    })
    if (collectedMetrics.set) {
      completed.apiDurationMs = collectedMetrics.apiDurationMs
      completed.numTurns = collectedMetrics.numTurns
      completed.costUsd = collectedMetrics.costUsd
    }
    this.scheduleGoal(thread.id)
    this.clearActiveTurn(thread.id)
    this.setThreadStatus(peer, thread.id, { type: 'idle' })
    // Plan-mode text streams through the `plan` ThreadItem + item/plan/delta
    // events; turn/plan/updated is reserved for the update_plan/TodoWrite
    // checklist tool (see the tool_use handler), matching the real app-server
    // which keeps those two surfaces separate.
    this.notify(peer, {
      method: 'turn/completed',
      params: { threadId: thread.id, turn: this.toLifecycleTurn(completed) },
    })
    void this.adoptSessionTitle(thread.id)
  }

  // 这个会话还要不要自动起名：Claude 会话、还没有名字、用户没改过名，只看前三个回合
  private wantsSessionTitle(threadId: string): boolean {
    if ((this.titleChecks.get(threadId) ?? 0) >= 3 || !this.runtime.sessionTitle) return false
    const thread = this.store.getThread(threadId)
    return Boolean(
      thread &&
        !thread.name &&
        !thread.ephemeral &&
        thread.threadSource !== 'subagent' &&
        thread.runtimeBackend === 'claude',
    )
  }

  // Claude 会话的名字：CLI 起的标题写在会话记录里（ai-title），读出来当会话名。
  // 标题是异步起的，可能晚一两个回合才写进去，所以前三个回合结束时各看一次；用户改过名的不动。
  private async adoptSessionTitle(threadId: string): Promise<void> {
    if (!this.wantsSessionTitle(threadId)) return
    const thread = this.store.getThread(threadId)
    if (!thread?.claudeSessionId) return
    this.titleChecks.set(threadId, (this.titleChecks.get(threadId) ?? 0) + 1)
    let title: string | null | undefined
    try {
      title = await this.runtime.sessionTitle?.(thread.claudeSessionId, thread.cwd)
    } catch (error) {
      debugLog('thread.title.failed', { threadId, error: String(error) })
      return
    }
    // 和第一句话一样的不算起了名（侧栏本来就显示第一句话）
    if (!title || title === thread.preview.trim() || this.stopped) return
    // 等的时候用户改了名，或者会话没了
    if (this.titleChecks.get(threadId) === Number.POSITIVE_INFINITY) return
    if (this.store.getThread(threadId)?.name !== null) return
    this.titleChecks.set(threadId, Number.POSITIVE_INFINITY)
    this.store.updateThreadName(threadId, title)
    this.notifyThread(threadId, {
      method: 'thread/name/updated',
      params: { threadId, threadName: title },
    })
  }

  private completeSubagentChildTurn(
    peer: RpcPeer,
    context: SubagentContext,
    resultText: string,
    status: 'completed' | 'failed' | 'interrupted',
    error: unknown | null,
    durationMs: number | null = null,
  ): TurnRecord {
    let childTurn = this.store.getTurn(context.childTurnId)
    if (!childTurn) {
      childTurn = {
        id: context.childTurnId,
        threadId: context.childThreadId,
        status: 'inProgress',
        startedAt: nowSeconds(),
        completedAt: null,
        durationMs: null,
        items: [
          {
            type: 'userMessage',
            id: newId(),
            content: [{ type: 'text', text: context.prompt, text_elements: [] }],
          },
        ],
        diff: '',
        error: null,
      }
      this.store.upsertTurn(childTurn)
    }

    // 过程投影里最后一段正文若就是结果，已原地标为最终回答，不再重复写一条。
    // 没有结果文字时不写空的回答条目（上游读历史时也跳过空的回答）；失败的原因只在回合的 error 上，
    // 不再另写成一段回答（那样原因和出错框是分开的两处）。
    const ended = status !== 'completed'
    if (!context.projection?.finish(resultText, ended) && resultText && !ended) {
      const agentItemId = newId()
      const startedItem: ThreadItem = {
        type: 'agentMessage',
        id: agentItemId,
        text: '',
        phase: null,
        memoryCitation: null,
      }
      this.store.appendItem(childTurn.id, startedItem)
      this.notify(peer, {
        method: 'item/started',
        params: {
          threadId: context.childThreadId,
          turnId: childTurn.id,
          item: startedItem,
          startedAtMs: nowMillis(),
        },
      })

      const completedItem: ThreadItem = { ...startedItem, text: resultText }
      this.store.updateItem(childTurn.id, agentItemId, () => completedItem)
      if (resultText) {
        this.notify(peer, {
          method: 'item/agentMessage/delta',
          params: {
            threadId: context.childThreadId,
            turnId: childTurn.id,
            itemId: agentItemId,
            delta: resultText,
          },
        })
      }
      this.notify(peer, {
        method: 'item/completed',
        params: {
          threadId: context.childThreadId,
          turnId: childTurn.id,
          item: completedItem,
          completedAtMs: nowMillis(),
        },
      })
    }

    const completed = this.store.completeTurn(childTurn.id, status, error) ?? childTurn
    if (durationMs != null) {
      completed.durationMs = durationMs
      this.store.upsertTurn(completed)
    }
    this.setThreadStatus(peer, context.childThreadId, { type: 'idle' })
    this.notify(peer, {
      method: 'turn/completed',
      params: {
        threadId: context.childThreadId,
        turn: this.toCompletedTurn(completed),
      },
    })
    return completed
  }

  private emitSubagentActivity(
    peer: RpcPeer,
    parentThreadId: string,
    parentTurnId: string,
    context: SubagentContext,
    kind: 'started' | 'interacted' | 'interrupted' | 'completed',
  ): void {
    // Codex cc 26.x treats a persisted started activity marker as liveness,
    // but does not advertise a compatible terminal activity kind. The
    // canonical spawnAgent/wait lifecycle remains available for discovery and
    // review, so omit this optional marker for legacy peers.
    // 线程有几条订阅连接时各按自己的声明：声明过的收到，没声明的只收到 interrupted。
    const understands = (target: RpcPeer) =>
      kind === 'interrupted' || this.supportsCompletedSubagentActivity(target)
    if (!this.recipients(peer, { threadId: parentThreadId }).some(understands)) return
    const item: ThreadItem = {
      type: 'subAgentActivity',
      id: newId(),
      kind,
      agentThreadId: context.childThreadId,
      agentPath: context.agentPath,
    }
    // Keep the persisted history capability-neutral. The durable wait and
    // child-turn state covers live and completed runs; persisting either
    // started or completed activity would make a mixed-version reconnect
    // decode a kind the peer may not support. Interrupted remains the one
    // legacy-safe terminal marker for abandoned children.
    if (kind === 'interrupted') this.store.appendItem(parentTurnId, item)
    this.emitItemLifecycle(peer, parentThreadId, parentTurnId, item, understands)
  }

  private emitItemLifecycle(
    peer: RpcPeer,
    threadId: string,
    turnId: string,
    item: ThreadItem,
    only?: (target: RpcPeer) => boolean,
  ): void {
    const startedAtMs = nowMillis()
    this.notify(
      peer,
      {
        method: 'item/started',
        params: {
          threadId,
          turnId,
          item,
          startedAtMs,
        },
      },
      only,
    )
    this.notify(
      peer,
      {
        method: 'item/completed',
        params: {
          threadId,
          turnId,
          item,
          completedAtMs: nowMillis(),
        },
      },
      only,
    )
  }

  // 子代理结束了：派出它的 spawnAgent 条目以同一个标识再发一次 item/completed，带上它最后的状态
  // （上游的 V2 也只在派出时报一次“在跑”；客户端照子线程算状态，这里只是让条目本身也对）。
  // 落库时原地换掉、不挪位置：读历史时它还在原处，状态是最后的
  private resettleSpawnItem(
    peer: RpcPeer,
    threadId: string,
    turnId: string,
    context: SubagentContext,
    status: 'completed' | 'errored' | 'interrupted',
    message: string | null,
  ): void {
    if (context.spawnItem.type !== 'collabAgentToolCall') return
    const item: ThreadItem = {
      ...context.spawnItem,
      agentsStates: { [context.childThreadId]: { status, message } },
    }
    context.spawnItem = item
    this.store.updateItem(turnId, item.id, () => item)
    this.notify(peer, {
      method: 'item/completed',
      params: { threadId, turnId, item, completedAtMs: nowMillis() },
    })
  }

  private supportsCompletedSubagentActivity(peer: RpcPeer): boolean {
    if (process.env.CHA_CLAUDE_SUBAGENT_COMPLETED === '1') return true
    if (process.env.CHA_CLAUDE_SUBAGENT_COMPLETED === '0') return false
    return this.peerFeatures.get(peer)?.supportsCompletedSubagentActivity === true
  }

  // 这个线程的通知此刻发给的连接里，有没有认识子代理 completed 活动的（aware），
  // 有没有不认识的（legacy）。只有一条连接时两者相反，就是那条连接自己的声明。
  // 写进历史的 closeAgent 收尾对所有连接是同一份：只要有一条不认识的连接在看，就照旧写。
  private subagentActivityAudience(
    peer: RpcPeer,
    threadId: string,
  ): { aware: boolean; legacy: boolean } {
    const targets = this.recipients(peer, { threadId })
    const aware = targets.filter((target) => this.supportsCompletedSubagentActivity(target)).length
    return { aware: aware > 0, legacy: aware < targets.length }
  }

  // 父回合结束时还没交回结果的子代理。stopped：是用户打断了父回合，子代理跟着被停掉，
  // 子线程的回合记成被打断（不是出错，error 留空，和上游打断回合一样）；否则记成失败，原因是 failureMessage
  private finalizeOrphanedSubagents(
    peer: RpcPeer,
    thread: ThreadRecord,
    turn: TurnRecord,
    contexts: Map<string, SubagentContext>,
    active: Set<string>,
    failureMessage = 'Subagent ended without a terminal task result.',
    stopped = false,
  ): void {
    for (const toolUseId of Array.from(active)) {
      const context = contexts.get(toolUseId)
      active.delete(toolUseId)
      contexts.delete(toolUseId)
      if (!context) continue

      const message = stopped ? null : failureMessage
      const agentStatus = stopped ? 'interrupted' : 'errored'
      const childTurn = this.completeSubagentChildTurn(
        peer,
        context,
        message ?? '',
        stopped ? 'interrupted' : 'failed',
        message ? { message } : null,
      )
      recordRunEvent('subagent.completed', {
        parentThreadId: thread.id,
        parentTurnId: turn.id,
        childThreadId: context.childThreadId,
        childTurnId: childTurn.id,
        status: childTurn.status,
        agentRole: context.subType ?? 'general-purpose',
      })

      this.emitSubagentActivity(peer, thread.id, turn.id, context, 'interrupted')
      this.resettleSpawnItem(peer, thread.id, turn.id, context, agentStatus, message)

      const waitEnd: ThreadItem = {
        type: 'collabAgentToolCall',
        id: context.waitItemId,
        tool: 'wait',
        // 用户打断的：等待本身没出错，是等的那个被停掉了
        status: stopped ? 'completed' : 'failed',
        senderThreadId: thread.id,
        receiverThreadIds: [context.childThreadId],
        prompt: null,
        model: null,
        reasoningEffort: null,
        agentsStates: { [context.childThreadId]: { status: agentStatus, message } },
      }
      this.store.updateItemAndMoveToEnd(turn.id, context.waitItemId, () => waitEnd)
      this.notify(peer, {
        method: 'item/completed',
        params: {
          threadId: thread.id,
          turnId: turn.id,
          item: waitEnd,
          completedAtMs: nowMillis(),
        },
      })
      if (this.subagentActivityAudience(peer, thread.id).legacy) {
        const closeId = newId()
        const closeBegin: ThreadItem = {
          type: 'collabAgentToolCall',
          id: closeId,
          tool: 'closeAgent',
          status: 'inProgress',
          senderThreadId: thread.id,
          receiverThreadIds: [context.childThreadId],
          prompt: null,
          model: null,
          reasoningEffort: null,
          agentsStates: {},
        }
        this.store.appendItem(turn.id, closeBegin)
        this.notify(peer, {
          method: 'item/started',
          params: {
            threadId: thread.id,
            turnId: turn.id,
            item: closeBegin,
            startedAtMs: nowMillis(),
          },
        })
        const closeEnd: ThreadItem = {
          ...closeBegin,
          status: 'failed',
          agentsStates: { [context.childThreadId]: { status: agentStatus, message } },
        }
        this.store.updateItem(turn.id, closeId, () => closeEnd)
        this.notify(peer, {
          method: 'item/completed',
          params: {
            threadId: thread.id,
            turnId: turn.id,
            item: closeEnd,
            completedAtMs: nowMillis(),
          },
        })
      }
    }
  }

  private async requestApproval(
    peer: RpcPeer,
    threadId: string,
    turnId: string,
    itemId: string,
    event: Extract<RuntimeEvent, { type: 'permission_request' }>,
    // 这次调用的是哪个 MCP 服务的哪个工具；不是 MCP 工具时是 null。
    mcp: McpToolRef | null,
  ): Promise<PermissionDecision> {
    // runtime 已按当前 Turn 权限判断；抵达此处的请求必须由用户决定。
    const thread = this.store.getThread(threadId)
    const grant = sessionGrantKey(thread, event, mcp)
    if (grant && this.commandSessionAllow.get(threadId)?.has(grant)) {
      return { decision: 'accept' }
    }

    this.setThreadStatus(peer, threadId, { type: 'active', activeFlags: ['waitingOnApproval'] })
    const requestId = newId()
    // 命令在哪个目录里跑就报哪个，和条目上记的一样。
    const item = this.store.getItem(turnId, itemId)
    const cwd = item?.type === 'commandExecution' ? item.cwd : (thread?.cwd ?? '')
    const request = approvalRequest(event, { threadId, turnId, itemId, requestId, cwd }, mcp)

    let response: unknown
    try {
      // 请求会送给线程的每条订阅连接，之后还可能补送给新订阅的连接：每次按要送去的那条连接
      // 有没有声明扩展来给参数，没声明的收到的始终是标准形状。哪条连接答的都算数。
      response = await this.sendServerRequest(
        peer,
        request.method,
        requestId,
        request.params,
        undefined,
        (target) =>
          this.peerFeatures.get(target)?.extensions.has(EXTENSION.declineWithNote)
            ? request.paramsWithNote
            : request.params,
      )
    } finally {
      if (!this.stopped && this.activeTurnByThread.get(threadId) === turnId)
        this.setThreadStatus(peer, threadId, { type: 'active', activeFlags: [] })
    }
    // “拒绝并附说明”就是带了一句话的拒绝；说明是空的和普通拒绝一样。MCP 工具的审批是征询的形状，没有这一项。
    const asked = request.method === 'mcpServer/elicitation/request'
    const note = asked ? null : declineNote(response)
    const decision = asked
      ? mcpToolApprovalDecision(response)
      : note === null
        ? normalizeDecision(response)
        : 'decline'
    // 选了“拒绝并停下”时由调用方先收尾条目、再中断回合。
    return { decision, ...(note ? { note } : {}) }
  }

  private async requestUserInput(
    peer: RpcPeer,
    threadId: string,
    turnId: string,
    itemId: string,
    questions: UserInputQuestion[],
    planMode: boolean,
  ): Promise<UserInputAnswers> {
    const requestId = newId()
    // 题目原样发出去：选项之外能不能自己说，看题目上的 isOther，这里不往选项里补东西。
    // isBlocking 照上游（core/src/tools/handlers/request_user_input.rs）：只有计划模式是 true；
    // 只是给客户端展示用的标记，两种都一直等到有人回答
    const params = { threadId, turnId, itemId, isBlocking: planMode, questions }
    const response = await this.sendServerRequest(
      peer,
      'item/tool/requestUserInput',
      requestId,
      params,
    )
    return normalizeUserInputAnswers(response, questions)
  }

  private async turnInterrupt(peer: RpcPeer, params: Record<string, unknown>): Promise<unknown> {
    const threadId = requiredString(params.threadId, 'threadId')
    const requestedTurnId = requiredString(params.turnId, 'turnId')
    if (!this.store.getThread(threadId)) throw new ProtocolError(-32602, '会话不存在')
    const requested = this.store.getTurn(requestedTurnId)
    if (requested && requested.threadId !== threadId)
      throw new ProtocolError(-32602, '回合不属于指定会话')
    const activeTurnId = this.activeTurnByThread.get(threadId)
    if (activeTurnId && activeTurnId !== requestedTurnId)
      throw new ProtocolError(-32009, '指定回合与当前活动回合不一致')
    if (!requested) throw new ProtocolError(-32602, '指定回合不存在')
    const stopping = this.interruptingByThread.get(threadId)
    if (stopping) {
      await stopping
      return {}
    }
    if (requested.status !== 'inProgress') return {}
    this.subscribers.add(threadId, peer)
    const turnId = activeTurnId || requestedTurnId
    if (turnId) {
      const turn = this.store.getTurn(turnId)
      if (turn?.status === 'inProgress') {
        const subagents = this.subagentStateByTurn.get(turnId)
        if (subagents) {
          this.finalizeOrphanedSubagents(
            peer,
            subagents.thread,
            subagents.turn,
            subagents.contexts,
            subagents.active,
            undefined,
            true,
          )
          this.subagentStateByTurn.delete(turnId)
        }
        this.finishGoal(threadId, turnId, 'interrupted')
        this.finishReview(peer, threadId, turnId, '审查已中断')
        // 用户打断不是出错：error 留空，和上游一样（turn/interrupt 走 abort_all_tasks，TurnAbortedEvent
        // 的 error 是 None，turn/completed 和读历史里都是 null）。此前带的那句 interrupted 被 Litch 画成了出错框
        this.store.completeTurn(turnId, 'interrupted')
      }
    }
    this.runtimeReadyByTurn.get(turnId)?.resolve(false)
    // Persist the terminal state before asking the SDK to abort. A few SDK
    // versions deliver one or two buffered tool events during interrupt; the
    // runRuntimeTurn guard now rejects them because the turn is no longer
    // active, so they cannot create an orphan child after this point.
    // 终态先落库，执行权仍保留到 SDK 真正停止，防止旧 interrupt 命中新回合。
    // 停止失败时保留屏障，明确拒绝新提交；重启运行时后才能恢复。
    // CLI 确认中断之后才能释放交互，不能只依赖 SDK 的 stdin EOF。
    const interrupting = (async () => this.runtime.interrupt(threadId))()
    this.interruptingByThread.set(threadId, interrupting)
    await interrupting
    this.pendingInteractions.cancelThread(threadId)
    const completed = this.store.getTurn(turnId)
    if (completed)
      this.notify(peer, {
        method: 'turn/completed',
        params: { threadId, turn: this.toLifecycleTurn(completed) },
      })
    this.interruptingByThread.delete(threadId)
    this.clearActiveTurn(threadId)
    this.setThreadStatus(peer, threadId, { type: 'idle' })
    return {}
  }

  private async turnSettingsUpdate(params: Record<string, unknown>): Promise<unknown> {
    const threadId = requiredString(params.threadId, 'threadId')
    const turnId = requiredString(params.turnId, 'turnId')
    const settings = parseTurnSettings(params)
    const active = (): boolean =>
      this.activeTurnByThread.get(threadId) === turnId &&
      this.store.getTurn(turnId)?.status === 'inProgress'
    if (!active()) return { status: 'targetUnavailable' }
    const startup = this.runtimeReadyByTurn.get(turnId)
    if (startup && !(await startup.ready)) return { status: 'targetUnavailable' }
    if (!active()) return { status: 'targetUnavailable' }
    if (!this.runtime.updateTurnSettings)
      throw new ProtocolError(-32004, '当前运行时不支持真实回合设置更新')
    const applied = await this.runtime.updateTurnSettings(threadId, turnId, settings)
    return { status: applied ? 'applied' : 'targetUnavailable' }
  }

  private async turnSteer(peer: RpcPeer, params: Record<string, unknown>): Promise<unknown> {
    const threadId = requiredString(params.threadId, 'threadId')
    const expectedTurnId = requiredString(params.expectedTurnId, 'expectedTurnId')
    if (!this.store.getThread(threadId)) throw new ProtocolError(-32602, '会话不存在')
    const messageId =
      params.clientUserMessageId == null
        ? null
        : requiredString(params.clientUserMessageId, 'clientUserMessageId')
    const hash = submissionHash({ method: 'turn/steer', ...params })
    if (messageId) {
      const submitted = this.store.submittedTurn(threadId, messageId, hash)
      if (submitted) return { turnId: submitted.id }
    }
    const activeTurnId = this.activeTurnByThread.get(threadId)
    if (
      !activeTurnId ||
      expectedTurnId !== activeTurnId ||
      this.store.getTurn(activeTurnId)?.status !== 'inProgress'
    )
      throw new ProtocolError(-32009, '指定回合与当前活动回合不一致')
    // 追问回合跑在父会话上，回合内追加的输入只会到主模型而到不了子代理。
    if (this.relayParentByChild.has(threadId))
      throw new ProtocolError(-32009, '子代理正在处理上一条追问，请等它结束后再发送')
    const startup = this.runtimeReadyByTurn.get(activeTurnId)
    if (startup && !(await startup.ready)) throw new ProtocolError(-32009, '回合未启动便已终结')
    // 等待启动时另一端可能提交相同消息或取消回合，落库前再次核对。
    if (messageId) {
      const submitted = this.store.submittedTurn(threadId, messageId, hash)
      if (submitted) return { turnId: submitted.id }
    }
    if (this.activeTurnByThread.get(threadId) !== activeTurnId)
      throw new ProtocolError(-32009, '回合已终结')
    const input = Array.isArray(params.input) ? (params.input as UserInput[]) : []
    const prompt = this.inputPrompt(threadId, input)
    // 插的话留在回合里（thread/read），送进去之后和上游一样发给全部订阅者（上游在交给模型时发这条用户消息）
    const item: ThreadItem = {
      type: 'userMessage',
      id: newId(),
      content: input,
      clientId: messageId,
    }
    this.store.saveSteeredMessage(activeTurnId, item, messageId, hash)
    try {
      await this.runtime.steer(threadId, prompt)
    } catch (error) {
      // 运行时已经在收尾、不再收输入（上游同样拒绝往收尾中的回合里插话）：这句话没进回合，别留在记录里
      this.store.withdrawSteeredMessage(activeTurnId, item.id, messageId)
      throw error
    }
    this.sendInputItem(peer, threadId, activeTurnId, item)
    return { turnId: activeTurnId }
  }

  private mcpScope(value?: unknown): McpScope {
    const threadId = value == null ? null : requiredString(value, 'threadId')
    const thread = threadId === null ? null : this.store.getThread(threadId)
    if (threadId !== null && !thread) throw new ProtocolError(-32602, '未知会话')
    const configured =
      threadId === null ? undefined : this.store.threadSettings(threadId).config?.mcp_servers
    const servers = mergeMcpConfig(readMcpConfig(), this.configOverrides.mcp_servers, configured)
    sdkMcpServers(servers)
    return {
      threadId,
      cwd: thread?.cwd ?? process.cwd(),
      servers: servers as Record<string, unknown>,
      source:
        configured != null
          ? `thread:${threadId}`
          : this.configOverrides.mcp_servers != null
            ? `config:${this.configPath}`
            : `native:${process.env.CLAUDE_CONFIG_DIR ?? homedir()}`,
    }
  }

  private async mcpOAuthLogin(peer: RpcPeer, params: Record<string, unknown>): Promise<unknown> {
    const scope = this.mcpScope(params.threadId)
    const name = requiredString(params.name, 'name')
    const config = sdkMcpServers(scope.servers)[name]
    if (!config) throw new ProtocolError(-32602, '当前范围未配置指定 MCP 服务')
    return this.mcpOAuth.login(scope.source, config, params, peer.id, (result) => {
      this.notify(peer, { method: 'mcpServer/oauthLogin/completed', params: result })
    })
  }

  private mcpCallbacks(peer: RpcPeer, value?: unknown): McpCallbacks {
    const threadId = value == null ? null : requiredString(value, 'threadId')
    return {
      peerId: peer.id,
      status: (name, status, error) => {
        this.notify(peer, {
          method: 'mcpServer/startupStatus/updated',
          params: { threadId, name, status, error },
        })
      },
      elicitation: async (request, signal) => {
        if (!threadId) throw new ProtocolError(-32602, 'MCP 交互需要指定会话')
        const policy = this.store.getThread(threadId)?.approvalPolicy
        if (policy && typeof policy === 'object' && !allowsApproval(policy, 'mcp_elicitations'))
          return { action: 'decline' }
        const requestId = newId()
        const response = await this.sendServerRequest(
          peer,
          'mcpServer/elicitation/request',
          requestId,
          elicitationParams(request, threadId, null),
          signal,
        )
        signal.throwIfAborted()
        return elicitationResponse(request, response)
      },
    }
  }

  private async mcpProbe(peer: RpcPeer, scope: McpScope): Promise<void> {
    // 一个服务失败不能让排在后面的服务没有状态：失败已由状态回调逐个通知，
    // 这里只把第一个错误留给调用方。操作被取消（连接断开、重载）时立即停止。
    let failure: unknown
    for (const name of Object.keys(sdkMcpServers(scope.servers))) {
      try {
        await this.mcp.withClient(
          scope,
          name,
          this.mcpCallbacks(peer, scope.threadId),
          async (client, signal) => {
            await client.ping({ signal })
          },
        )
      } catch (error) {
        if (error instanceof McpOperationCancelled) throw error
        failure ??= error
      }
    }
    if (failure !== undefined) throw failure
  }

  private async mcpReload(peer: RpcPeer): Promise<unknown> {
    if (this.activeTurnByThread.size)
      throw new ProtocolError(-32009, '回合执行期间不能重载 MCP，请先停止回合')
    await this.mcp.cancelAll()
    const scopes = [this.mcpScope(), ...this.subscribers.threads().map((id) => this.mcpScope(id))]
    for (const scope of scopes) await this.mcpProbe(peer, scope)
    return {}
  }

  private async mcpCall(
    peer: RpcPeer,
    method: string,
    params: Record<string, unknown>,
  ): Promise<unknown> {
    const isTool = method === 'mcpServer/tool/call'
    const scope = this.mcpScope(
      isTool ? requiredString(params.threadId, 'threadId') : params.threadId,
    )
    const server = requiredString(params.server, 'server')
    const target = requiredString(isTool ? params.tool : params.uri, isTool ? 'tool' : 'uri')
    if (isTool) {
      const thread = this.store.getThread(scope.threadId!)!
      if (this.activeTurnByThread.has(thread.id))
        throw new ProtocolError(-32009, '回合执行期间不能从管理接口并发调用工具')
      // 任意 MCP 工具没有可信的副作用边界，管理接口不能绕过原生权限。
      if (
        thread.sandboxMode !== 'danger-full-access' ||
        this.store.threadSettings(thread.id).planMode
      )
        throw new ProtocolError(-32004, '直接 MCP 工具调用需要完整权限会话')
      if (
        params.arguments != null &&
        (typeof params.arguments !== 'object' || Array.isArray(params.arguments))
      )
        throw new ProtocolError(-32602, 'MCP arguments 必须是对象')
      if (params._meta != null && (typeof params._meta !== 'object' || Array.isArray(params._meta)))
        throw new ProtocolError(-32602, 'MCP _meta 必须是对象')
    }
    return this.mcp.withClient(
      scope,
      server,
      this.mcpCallbacks(peer, scope.threadId),
      async (client, signal) => {
        if (!isTool) return client.readResource({ uri: target }, { signal })
        return client.callTool(
          {
            name: target,
            arguments: asRecord(params.arguments),
            ...(params._meta == null ? {} : { _meta: asRecord(params._meta) }),
          },
          undefined,
          { signal },
        )
      },
    )
  }

  private configRead(params: Record<string, unknown>): unknown {
    if (params.includeLayers != null && typeof params.includeLayers !== 'boolean')
      throw new ProtocolError(-32602, 'includeLayers 必须是布尔值')
    if (params.cwd != null && typeof params.cwd !== 'string')
      throw new ProtocolError(-32602, 'cwd 必须是字符串')
    const persisted = this.loadPersistedConfig()
    const metadata = { name: { type: 'user', file: this.configPath }, version: persisted.version }
    // Base config = our typed defaults; overrides (whatever the App's
    // settings sheet has written previously via config/value/write) are
    // layered on top so the user sees their last-saved values instead of
    // the defaults bouncing back on every reconnect. Typed fields (model /
    // model_reasoning_effort) take precedence over overrides since they're
    // applied via a stricter validator.
    return {
      config: {
        ...this.publicConfigOverrides(),
        model: this.configModel,
        review_model: null,
        model_context_window: null,
        model_auto_compact_token_limit: null,
        model_provider: 'claude-code',
        approval_policy: this.configOverrides.approval_policy ?? 'on-request',
        approvals_reviewer: this.configOverrides.approvals_reviewer ?? 'user',
        sandbox_mode: this.configOverrides.sandbox_mode ?? 'workspace-write',
        sandbox_workspace_write: this.configOverrides.sandbox_workspace_write ?? null,
        // 不带权限设置新建的会话会用哪个预设（上游 Config 摊平的 default_permissions，客户端的新建页照它显示）：
        // 照 thread/start 的取法从配置里的两项凑，凑不成预设时是 null，和建出来的会话报的一致
        default_permissions:
          defaultPermissionsId(this.configOverrides) ??
          threadPermissionProfileId(
            null,
            normalizeApprovalPolicy(this.configOverrides.approval_policy) ?? 'on-request',
            normalizeSandboxMode(this.configOverrides.sandbox_mode) ?? 'workspace-write',
          ),
        forced_chatgpt_workspace_id: null,
        forced_login_method: null,
        web_search: this.configOverrides.web_search ?? 'disabled',
        tools: this.configOverrides.tools ?? null,
        profile: this.configOverrides.profile ?? null,
        profiles: {},
        instructions: this.configOverrides.instructions ?? null,
        developer_instructions: this.configOverrides.developer_instructions ?? null,
        compact_prompt: this.configOverrides.compact_prompt ?? null,
        model_reasoning_effort: this.configReasoningEffort,
        model_reasoning_summary: this.configOverrides.model_reasoning_summary ?? null,
        model_verbosity: this.configOverrides.model_verbosity ?? null,
        service_tier: this.configOverrides.service_tier ?? null,
        analytics: this.configOverrides.analytics ?? null,
        apps: this.configOverrides.apps ?? null,
        model_providers: this.exposedModelProviders(),
        provider_loop_config: projectProviderLoopConfig(
          undefined,
          this.providerLoopSelectionInput(),
        ),
      },
      origins: Object.fromEntries(Object.keys(persisted.values).map((key) => [key, metadata])),
      layers: params.includeLayers
        ? [{ ...metadata, config: persisted.values, disabledReason: null }]
        : null,
    }
  }

  private providerLoopSelectionInput(): ProviderLoopSelectionInput {
    const legacyRuntimeType = normalizeRuntimeType(
      process.env.CHA_CLAUDE_RUNTIME_TYPE ??
        process.env.CHA_CLAUDE_RUNTIME ??
        process.env.CHA_CLAUDE_BACKEND,
    )
    const envInput = providerLoopSelectionInputFromEnv(process.env, legacyRuntimeType)
    if (hasProviderLoopSelectionInput(envInput)) return envInput
    return providerLoopSelectionInputFromConfig(
      this.configOverrides,
      legacyRuntimeType,
      process.env.CHA_CLAUDE_MOCK === '1',
    )
  }

  private publicConfigOverrides(): Record<string, unknown> {
    return Object.fromEntries(
      Object.entries(this.configOverrides).filter(
        ([key]) => !isProviderLoopSelectionConfigKey(key) && key !== PROVIDER_CONFIG_KEY,
      ),
    )
  }

  // Build the model_providers map served by config/read. Always exposes
  // 'claude-code'; conditionally adds 'codex' when a real Codex CLI is
  // resolvable on the host. Exposing 'codex' as a separate provider entry
  // gives the App's settings panel a way to surface OpenAI-family models
  // (gpt-*) without the App treating them as foreign to the Claude
  // provider's allowlist.
  private exposedModelProviders(): Record<string, unknown> {
    const providers: Record<string, unknown> = {
      'claude-code': {
        name: 'Claude Code',
        base_url: null,
        env_key: null,
        env_key_instructions: null,
        experimental_bearer_token: null,
        auth: null,
        aws: null,
        wire_api: 'responses',
        query_params: null,
        http_headers: null,
        env_http_headers: null,
        request_max_retries: null,
        stream_max_retries: null,
        stream_idle_timeout_ms: null,
        websocket_connect_timeout_ms: null,
        requires_openai_auth: false,
        supports_websockets: false,
      },
    }
    return providers
  }

  private modelList(params: Record<string, unknown>): unknown {
    if (params.includeHidden != null && typeof params.includeHidden !== 'boolean')
      throw new ProtocolError(-32602, 'includeHidden 必须是布尔值')
    const defaultModel = this.configModel
    // 会话报的模型都要在这里找得到对应的一行（否则客户端的模型选择器没有选中项、强度也没了）：
    // 原生目录之外，配置的默认模型和没归档的会话用着的模型（CLI 认的别名、完整型号等）各补一行。
    const catalog = allSelectableModelOptions()
    const listed = new Set(catalog.map((option) => option.id.toLowerCase()))
    const extras: string[] = []
    for (const id of [defaultModel, ...this.store.threadModels()]) {
      if (!id || isCodexOpenAiModel(id) || listed.has(id.toLowerCase())) continue
      listed.add(id.toLowerCase())
      extras.push(id)
    }
    const options = [...catalog, ...extras.map((id) => extraModelOption(id, id === defaultModel))]
    const hasConfiguredDefault = options.some((option) => option.id === defaultModel)
    const effortDescriptions: Record<string, string> = {
      low: 'Fast runtime response',
      medium: 'Balanced runtime response',
      high: 'Deeper runtime response',
      xhigh: 'Maximum reasoning',
    }
    // 原生目录按模型给出推理强度；Codex 协议没有的档位（如 max）不暴露。
    const reasoningEffortsFor = (efforts: string[] | undefined) =>
      (efforts ?? Object.keys(effortDescriptions))
        .filter((effort) => Object.hasOwn(effortDescriptions, effort))
        .map((effort) => ({ reasoningEffort: effort, description: effortDescriptions[effort] }))
    const models = options.map((option) => ({
      id: option.id,
      model: option.id,
      upgrade: null,
      upgradeInfo: null,
      availabilityNux: null,
      displayName: option.displayName,
      description: option.description,
      modelSpecialty: null,
      hidden: false,
      supportedReasoningEfforts: reasoningEffortsFor(option.efforts),
      defaultReasoningEffort: this.configReasoningEffort,
      inputModalities: ['text', 'image'],
      supportsPersonality: false,
      additionalSpeedTiers: [],
      serviceTiers: [],
      defaultServiceTier: null,
      isDefault: hasConfiguredDefault ? option.id === defaultModel : option.isDefault === true,
    }))
    // 目录或查询条件改变后，旧游标不能静默读取不一致的下一页。
    const scope = `models:${submissionHash({ models, includeHidden: params.includeHidden ?? false })}`
    const { data, nextCursor } = pageRecords(
      models,
      { ...params, sortDirection: 'asc' },
      scope,
      (model) => model.id,
    )
    return { data, nextCursor }
  }

  private accountRateLimits(): unknown {
    return this.rateLimits.read()
  }

  private recordRateLimits(event: Extract<RuntimeEvent, { type: 'rate_limits' }>): void {
    for (const rateLimits of this.rateLimits.record(event.credentialScope, event.info))
      for (const peer of this.accountPeers)
        this.notify(peer, { method: 'account/rateLimits/updated', params: { rateLimits } })
  }

  // 记下一个线程的用量并发 `thread/tokenUsage/updated`。三样各管各的：add 只加进累计（total），
  // last 是现在上下文里有多少（最近一次模型请求的用量），window 是主模型的上下文窗口。
  // 没给的那几样沿用上次存下的，窗口跟着线程存，恢复、分叉时一起带上。
  private recordTokenUsage(
    peer: RpcPeer,
    threadId: string,
    turnId: string,
    change: {
      add?: Record<string, unknown>
      last?: TokenUsageBreakdown
      window?: number | null
    },
  ): void {
    const added = change.add ? tokenBreakdownFromClaudeUsage(change.add) : null
    const stored = this.store.threadUsage(threadId)?.tokenUsage
    const prior = stored?.total ?? emptyTokenBreakdown()
    const total: TokenUsageBreakdown = added
      ? {
          totalTokens: prior.totalTokens + added.totalTokens,
          inputTokens: prior.inputTokens + added.inputTokens,
          cachedInputTokens: prior.cachedInputTokens + added.cachedInputTokens,
          outputTokens: prior.outputTokens + added.outputTokens,
          reasoningOutputTokens: prior.reasoningOutputTokens + added.reasoningOutputTokens,
        }
      : prior
    const last = change.last ?? stored?.last ?? emptyTokenBreakdown()
    const modelContextWindow = change.window ?? stored?.modelContextWindow ?? null
    if (
      stored &&
      total === prior &&
      isDeepStrictEqual(last, stored.last) &&
      modelContextWindow === stored.modelContextWindow
    )
      return
    if (!stored && total.totalTokens === 0 && last.totalTokens === 0) return
    const tokenUsage: ThreadTokenUsage = { total, last, modelContextWindow }
    this.store.saveThreadUsage(threadId, turnId, tokenUsage)
    this.notify(peer, {
      method: 'thread/tokenUsage/updated',
      params: { threadId, turnId, tokenUsage },
    })
    // token usage 不能推算账户配额；只有原生 rate_limit_event 更新限额快照。
  }

  // 压缩之后上下文里只剩摘要：占用换成 CLI 报的压缩后的词元数，不等下一次请求
  private compactedUsage(
    peer: RpcPeer,
    threadId: string,
    turnId: string,
    postTokens: number | null | undefined,
  ): void {
    if (typeof postTokens !== 'number' || postTokens <= 0) return
    this.recordTokenUsage(peer, threadId, turnId, {
      last: { ...emptyTokenBreakdown(), totalTokens: postTokens, inputTokens: postTokens },
    })
  }

  private marketplaceAdd(params: Record<string, unknown>): unknown {
    const source = stringOr(params.source, 'local')
    const marketplaceName = stringOr(
      params.refName,
      source.split('/').filter(Boolean).at(-1) ?? 'marketplace',
    )
    return {
      marketplaceName,
      installedRoot: `${codexHome()}/marketplaces/${marketplaceName}`,
      alreadyAdded: true,
    }
  }

  private marketplaceRemove(params: Record<string, unknown>): unknown {
    const marketplaceName = stringOr(params.marketplaceName, 'marketplace')
    return { marketplaceName, installedRoot: null }
  }

  private marketplaceUpgrade(params: Record<string, unknown>): unknown {
    const marketplaceName =
      typeof params.marketplaceName === 'string' ? params.marketplaceName : null
    return {
      selectedMarketplaces: marketplaceName ? [marketplaceName] : [],
      upgradedRoots: [],
      errors: [],
    }
  }

  private pluginShareSave(params: Record<string, unknown>): unknown {
    const remotePluginId = stringOr(params.remotePluginId, `local-${newId()}`)
    return {
      remotePluginId,
      shareUrl: `https://localhost.invalid/codex-harness-adapter/plugin-share/${encodeURIComponent(remotePluginId)}`,
    }
  }

  private pluginShareUpdateTargets(params: Record<string, unknown>): unknown {
    const shareTargets = Array.isArray(params.shareTargets) ? params.shareTargets : []
    return {
      principals: shareTargets.map((target) => {
        const rec = asRecord(target)
        return {
          principalType: stringOr(rec.principalType, 'user'),
          principalId: stringOr(rec.principalId, ''),
          name: stringOr(rec.principalId, 'unknown'),
        }
      }),
      discoverability: params.discoverability === 'UNLISTED' ? 'UNLISTED' : 'PRIVATE',
    }
  }

  private configWriteResponse(params: Record<string, unknown>, batch: boolean): unknown {
    validateConfigTarget(params, this.configPath)
    const previous = this.persistedConfigValues()
    if (params.expectedVersion != null && params.expectedVersion !== previous.version)
      throw new ProtocolError(-32009, '配置已变化，请重新读取后提交')
    const next = applyConfigEdits(previous.values, params, batch)
    this.validateConfigValues(next)
    // 运行中的工具不能在热重载过程中被悄悄扩大权限。
    if (params.reloadUserConfig === true && this.activeTurnByThread.size > 0)
      throw new ProtocolError(-32009, '有活动回合，不能热重载配置')
    // 默认模型与强度写进 settings.json，其余照旧写 config.json
    const { model, model_reasoning_effort, ...rest } = next
    const changedDefault = (key: string) =>
      submissionHash(previous.values[key] ?? null) !== submissionHash(next[key] ?? null)
    if (changedDefault('model') || changedDefault('model_reasoning_effort'))
      writeSettingsDefaults({
        ...(changedDefault('model') ? { model: (model as string | undefined) ?? null } : {}),
        ...(changedDefault('model_reasoning_effort')
          ? { effort: (model_reasoning_effort as string | undefined) ?? null }
          : {}),
      })
    const version = writeConfigFile(this.configPath, rest, readConfigFile(this.configPath).version)
    this.loadPersistedConfig()
    if (params.reloadUserConfig === true) {
      const changed = (key: string) =>
        submissionHash(previous.values[key] ?? null) !== submissionHash(next[key] ?? null)
      for (const id of this.subscribers.threads()) {
        const thread = this.store.getThread(id)
        if (!thread) continue
        if (changed('approval_policy')) {
          thread.approvalPolicy = normalizeApprovalPolicy(next.approval_policy) ?? 'on-request'
          thread.permissionProfileId = null
        }
        if (changed('sandbox_mode')) {
          thread.sandboxMode = normalizeSandboxMode(next.sandbox_mode) ?? 'workspace-write'
          thread.permissionProfileId = null
        }
        if (changed('instructions'))
          thread.baseInstructions = typeof next.instructions === 'string' ? next.instructions : null
        if (changed('developer_instructions'))
          thread.developerInstructions =
            typeof next.developer_instructions === 'string' ? next.developer_instructions : null
        this.store.upsertThread(thread)
        const settings = this.store.threadSettings(id)
        if (changed('sandbox_mode')) delete settings.permissionProfile
        if (
          (changed('sandbox_mode') || changed('sandbox_workspace_write')) &&
          !settings.permissionProfile
        )
          settings.sandboxPolicy = this.configSandboxPolicy(thread.sandboxMode, thread.cwd)
        this.store.saveThreadSettings(id, settings)
        const peer = this.subscribers.first(id)
        if (peer) this.threadSettingsUpdate(peer, { threadId: id })
      }
    }
    return {
      status: 'ok',
      version,
      filePath: this.configPath,
      overriddenMetadata: null,
    }
  }

  private shellEnvironmentPolicy(
    threadConfig: Record<string, unknown> | undefined,
  ): ShellEnvironmentPolicy | null {
    return resolveShellEnvironmentPolicy(
      mergeConfigLayers(this.configOverrides, requestConfigLayer(threadConfig))
        .shell_environment_policy,
    )
  }

  private validateConfigValues(values: Record<string, unknown>): void {
    validateRuntimePermissions({
      approvalPolicy: values.approval_policy,
      sandbox: values.sandbox_mode,
    })
    if (
      values.model != null &&
      (typeof values.model !== 'string' || !isSelectableModel(values.model))
    )
      throw new ProtocolError(-32602, '配置模型不属于当前 Claude 运行时目录')
    if (
      values.model_reasoning_effort != null &&
      (typeof values.model_reasoning_effort !== 'string' ||
        !normalizeCodexReasoningEffort(values.model_reasoning_effort))
    )
      throw new ProtocolError(-32602, '推理强度配置无效')
    for (const key of ['instructions', 'developer_instructions'])
      if (values[key] != null && typeof values[key] !== 'string')
        throw new ProtocolError(-32602, key + ' 必须是字符串')
    if (values.mcp_servers != null) sdkMcpServers(values.mcp_servers)
    // 档位按叠上 `-c` 之后的有效配置查：config.json 里可以引用只在 `-c` 里定义的档位名
    validatePermissionsConfig(mergeConfigLayers(values, cliConfigLayer()))
    resolveShellEnvironmentPolicy(
      mergeConfigLayers(values, cliConfigLayer()).shell_environment_policy,
    )
    if (values.skills != null && !isConfigObject(values.skills))
      throw new ProtocolError(-32602, 'skills 必须是表')
    skillRules(asRecord(values.skills).config)
    if (values.sandbox_workspace_write != null) {
      if (!isConfigObject(values.sandbox_workspace_write))
        throw new ProtocolError(-32602, 'sandbox_workspace_write 必须是对象')
      const configuration = values.sandbox_workspace_write
      parseSandboxPolicy({
        type: 'workspaceWrite',
        ...(configuration.writable_roots == null
          ? {}
          : { writableRoots: configuration.writable_roots }),
        ...(configuration.network_access == null
          ? {}
          : { networkAccess: configuration.network_access }),
        ...(configuration.exclude_tmpdir_env_var == null
          ? {}
          : { excludeTmpdirEnvVar: configuration.exclude_tmpdir_env_var }),
        ...(configuration.exclude_slash_tmp == null
          ? {}
          : { excludeSlashTmp: configuration.exclude_slash_tmp }),
      })
    }
  }

  private configSandboxPolicy(mode: string | null, cwd: string) {
    const policy = defaultSandboxPolicy(mode, cwd)
    if (policy.type !== 'workspaceWrite') return policy
    const configured = asRecord(this.configOverrides.sandbox_workspace_write)
    return parseSandboxPolicy({
      ...policy,
      writableRoots: [cwd, ...((configured.writable_roots as string[] | undefined) ?? [])],
      networkAccess: configured.network_access ?? false,
      excludeTmpdirEnvVar: configured.exclude_tmpdir_env_var ?? false,
      excludeSlashTmp: configured.exclude_slash_tmp ?? false,
    })
  }

  private pluginRead(params: Record<string, unknown>): unknown {
    const name = stringOr(params.pluginName, 'unknown')
    return {
      plugin: {
        marketplaceName: stringOr(params.remoteMarketplaceName, 'local'),
        marketplacePath: params.marketplacePath ?? null,
        summary: {
          id: name,
          name,
          shareContext: null,
          source: { type: 'remote' },
          installed: false,
          enabled: false,
          installPolicy: 'NOT_AVAILABLE',
          authPolicy: 'ON_USE',
          availability: 'AVAILABLE',
          interface: null,
          keywords: [],
        },
        description: null,
        skills: [],
        hooks: [],
        apps: [],
        mcpServers: [],
      },
    }
  }

  private getConversationSummary(params: Record<string, unknown>): unknown {
    const threadId = stringOr(params.conversationId, '')
    const thread =
      this.store.getThread(threadId) ?? this.store.listThreads({ limit: 1, sourceKinds: [] }).at(0)
    const now = new Date().toISOString()
    return {
      summary: {
        conversationId: thread?.id ?? threadId,
        path: '',
        preview: thread?.preview ?? '',
        timestamp: now,
        updatedAt: now,
        modelProvider: thread?.modelProvider ?? 'claude-code',
        cwd: thread?.cwd ?? process.cwd(),
        cliVersion: codexCliVersion(),
        source: normalizeSessionSource(thread?.source),
        gitInfo: null,
      },
    }
  }

  private async gitDiffToRemote(params: Record<string, unknown>): Promise<unknown> {
    const cwd = resolve(requiredString(params.cwd, 'cwd'))
    const result = await computeGitDiffToRemote(cwd)
    if (!result)
      throw new ProtocolError(
        -32600,
        `failed to compute git diff to remote for cwd: ${JSON.stringify(cwd)}`,
      )
    return result
  }

  private toolUseToItem(
    event: Extract<RuntimeEvent, { type: 'tool_use' }>,
    cwd: string,
    mcpServers: readonly string[],
  ): ThreadItem {
    return toolUseItem(event, cwd, mcpServers)
  }

  private threadEnvelope(thread: ThreadRecord, turns: TurnRecord[] = []): unknown {
    const profileSnapshot = this.store.threadSettings(thread.id).permissionProfile
    const activePermissionProfileId = threadPermissionProfileId(
      profileSnapshot?.id ?? thread.permissionProfileId,
      thread.approvalPolicy,
      thread.sandboxMode,
    )
    return {
      thread: this.toThread(thread, turns),
      model: thread.model,
      modelProvider: thread.modelProvider,
      serviceTier: null,
      cwd: thread.cwd,
      runtimeWorkspaceRoots: profileSnapshot?.runtimeWorkspaceRoots ?? [thread.cwd],
      instructionSources: [],
      approvalPolicy: thread.approvalPolicy ?? 'never',
      approvalsReviewer: 'user',
      sandbox:
        this.store.threadSettings(thread.id).sandboxPolicy ??
        sandboxEnvelope(thread.sandboxMode, thread.cwd),
      permissionProfile: null,
      activePermissionProfile: activePermissionProfileId
        ? { id: activePermissionProfileId, extends: null }
        : null,
      // Some newer clients read the compact id while older clients use the
      // structured activePermissionProfile field. Return both; unknown extra
      // fields are ignored by the legacy app-server schema.
      permissions: activePermissionProfileId,
      reasoningEffort: thread.reasoningEffort,
      multiAgentMode: 'explicitRequestOnly',
      initialTurnsPage: null,
      ...historyHeadCursors(thread.id, this.store.listTurns(thread.id)),
    }
  }

  private toThread(thread: ThreadRecord, turns: TurnRecord[] = []): unknown {
    const agentNickname = nullIfEmpty(thread.agentNickname)
    const agentRole = nullIfEmpty(thread.agentRole)
    const parentThreadId = thread.threadSource === 'subagent' ? thread.forkedFromId : null
    const source = parentThreadId
      ? {
          subAgent: {
            thread_spawn: {
              parent_thread_id: parentThreadId,
              depth: this.subagentDepth(thread),
              agent_path: null,
              agent_nickname: agentNickname,
              agent_role: agentRole,
            },
          },
        }
      : normalizeSessionSource(thread.source)
    const profileId =
      thread.sandboxMode === 'danger-full-access'
        ? ':danger-full-access'
        : thread.sandboxMode === 'read-only'
          ? ':read-only'
          : ':workspace'
    const section = thread.sectionId == null ? null : this.store.getSection(thread.sectionId)
    const isPinned = thread.sectionId === PINNED_SECTION_ID || thread.isPinned === true

    return {
      id: thread.id,
      historyMode: this.store.threadSettings(thread.id).historyMode ?? 'legacy',
      projectId: this.store.projects.projectId(thread.id),
      isPinned,
      section,
      sectionEnteredAt: thread.sectionEnteredAt ?? null,
      sessionId: thread.sessionId,
      forkedFromId: thread.forkedFromId,
      parentThreadId,
      preview: thread.preview,
      ephemeral: thread.ephemeral,
      modelProvider: thread.modelProvider,
      createdAt: thread.createdAt,
      updatedAt: thread.updatedAt,
      recencyAt: thread.updatedAt,
      status: thread.status,
      path: null,
      cwd: thread.cwd,
      cliVersion: codexCliVersion(),
      canAcceptDirectInput: true,
      activePermissionProfile: profileId,
      // Defense-in-depth: even if older rows hold an invalid `source` or
      // `threadSource` (legacy `app_server`, empty string from a buggy write
      // path), coerce on the way out so the App's strict deserializer never
      // sees a value outside the wire enum.
      source,
      threadSource: normalizeThreadSource(thread.threadSource),
      agentNickname,
      agentRole,
      gitInfo: this.store.threadSettings(thread.id).gitInfo ?? null,
      name: thread.name,
      turns: turns.map((turn) => this.toTurn(turn)),
    }
  }

  private subagentDepth(thread: ThreadRecord): number {
    let depth = thread.threadSource === 'subagent' ? 1 : 0
    let ancestorId = thread.forkedFromId
    const seen = new Set([thread.id])
    while (ancestorId && !seen.has(ancestorId)) {
      seen.add(ancestorId)
      const ancestor = this.store.getThread(ancestorId)
      if (!ancestor || ancestor.threadSource !== 'subagent') break
      depth += 1
      ancestorId = ancestor.forkedFromId
    }
    return depth
  }

  // Full turn payload for history reads (thread/read, turns/list) — carries the
  // loaded items. The Codex v2 `Turn` schema has no api/cost metadata fields, so
  // the adapter's internal metrics are not serialized onto the wire.
  private toTurn(turn: TurnRecord): unknown {
    return {
      id: turn.id,
      items: turn.items,
      itemsView: 'full',
      status: turn.status,
      error: turn.error,
      startedAt: turn.startedAt,
      completedAt: turn.completedAt,
      durationMs: turn.durationMs,
    }
  }

  private toTurnView(turn: TurnRecord, itemsView: TurnItemsView): unknown {
    if (itemsView === 'full') return this.toTurn(turn)
    if (itemsView === 'notLoaded') return this.toLifecycleTurn(turn)
    const firstUser = turn.items.find((item) => item.type === 'userMessage')
    const lastAgent = turn.items.findLast((item) => item.type === 'agentMessage')
    const items: ThreadItem[] = []
    if (firstUser) items.push(firstUser)
    if (lastAgent && lastAgent.id !== firstUser?.id) items.push(lastAgent)
    return {
      id: turn.id,
      items,
      itemsView: 'summary',
      status: turn.status,
      error: turn.error,
      startedAt: turn.startedAt,
      completedAt: turn.completedAt,
      durationMs: turn.durationMs,
    }
  }

  // Lightweight payload for turn/start, turn/started, and terminal paths that
  // intentionally do not carry an assistant summary. The item stream drives
  // the timeline; completed subagent turns use toCompletedTurn below.
  private toLifecycleTurn(turn: TurnRecord, items: ThreadItem[] = []): unknown {
    return {
      id: turn.id,
      items,
      itemsView: 'notLoaded',
      status: turn.status,
      error: turn.error,
      startedAt: turn.startedAt,
      completedAt: turn.completedAt,
      durationMs: turn.durationMs,
    }
  }

  // Codex includes the final assistant message in successful turn/completed
  // notifications. Subagent pages depend on that summary because they can be
  // opened with a metadata-only thread/read and may not replay prior deltas.
  private toCompletedTurn(turn: TurnRecord): unknown {
    const lastAgent =
      turn.status === 'completed' && turn.error == null
        ? turn.items.findLast((item) => item.type === 'agentMessage' && item.text.trim().length > 0)
        : undefined
    return {
      id: turn.id,
      items: lastAgent ? [lastAgent] : [],
      itemsView: lastAgent ? 'summary' : 'notLoaded',
      status: turn.status,
      error: turn.error,
      startedAt: turn.startedAt,
      completedAt: turn.completedAt,
      durationMs: turn.durationMs,
    }
  }

  private sendResponse(
    peer: RpcPeer,
    id: JsonRpcId,
    result?: unknown,
    error?: { code: number; message: string; data?: unknown },
  ): void {
    const response: JsonRpcResponse = { jsonrpc: '2.0', id }
    if (error) response.error = error
    else response.result = result ?? null
    peer.send(response)
  }

  // 通知发给线程的全部订阅连接（见 recipients）。only：只发给其中满足条件的连接。
  // 会话级的那几种（新建、状态、改名、归档等）不在此列，见 announce。
  private notify(
    peer: RpcPeer,
    notification: { method: string; params: unknown },
    only?: (target: RpcPeer) => boolean,
  ): void {
    // Shutdown intentionally suppresses wire notifications: the peer may
    // already have closed, while persistence still needs to settle child and
    // parent state without throwing on a broken pipe.
    if (this.stopped) return
    if (BROADCAST_THREAD_NOTIFICATIONS.has(notification.method)) {
      this.announce(notification, peer)
      return
    }
    const params = asRecord(notification.params)
    const turnId = stringOr(params.turnId, '')
    const itemId = stringOr(asRecord(params.item).id, '')
    if (notification.method === 'item/started' && turnId && itemId) {
      const items = this.activeItemsByTurn.get(turnId) ?? new Set<string>()
      items.add(itemId)
      this.activeItemsByTurn.set(turnId, items)
    } else if (notification.method === 'item/completed') {
      this.activeItemsByTurn.get(turnId)?.delete(itemId)
    } else if (notification.method === 'turn/completed') {
      const turn = asRecord(params.turn)
      const completedId = stringOr(turn.id, '')
      if (turn.status === 'interrupted' || turn.status === 'failed')
        this.finishAbortedItems(peer, stringOr(params.threadId, ''), completedId)
      this.activeItemsByTurn.delete(completedId)
      const threadId = stringOr(params.threadId, '')
      if (turn.status === 'completed') this.scheduleQueue(threadId)
      else this.scheduledQueues.delete(threadId)
    }
    for (const target of this.recipients(peer, notification.params))
      if (!only || only(target)) this.deliver(target, notification, peer)
  }

  // 只发给这一条连接，不经线程的订阅关系：恢复线程时给恢复者的回放、告诉拿着请求的连接它已经有结果。
  private notifyOnly(peer: RpcPeer, notification: { method: string; params: unknown }): void {
    if (this.stopped) return
    this.deliver(peer, notification, peer)
  }

  // harness 详情设置的通知只发给握手时在 capabilities.litchExtensions 里声明了 harnessConfig 的连接
  private broadcastHarnessConfig(method: string, params: unknown): void {
    if (this.stopped) return
    for (const target of this.accountPeers)
      if (
        this.isConnected(target) &&
        this.peerFeatures.get(target)?.extensions.has(EXTENSION.harnessConfig)
      )
        this.deliver(target, { method, params }, target)
  }

  // 会话级的通知（新建、状态、改名、归档、取消归档、关闭、删除、回退、归属、附件、目标，清单是共用层的
  // BROADCAST_THREAD_NOTIFICATIONS）和上游一样发给每条握手过的连接：没订阅这个会话的客户端（官方桌面端的
  // 别的窗口、Litch 侧栏上别处在跑的会话）靠它们跟着变。订阅着它的连接（没人订阅时是引起这条通知的 origin）
  // 本来就收，没握手过也照收：这个入口不强求先握手。临时会话（客户端起标题用的，不进列表）的只给后面这些，
  // 别的连接拿到只会多出一个列表里没有的会话。
  private announce(
    notification: { method: string; params: unknown },
    origin?: RpcPeer,
    /** 各条连接看到的不一样时（按声明带不带扩展字段）：给这条连接的那一份 */
    shape?: (
      target: RpcPeer,
      notification: { method: string; params: unknown },
    ) => { method: string; params: unknown },
  ): void {
    if (this.stopped) return
    const params = asRecord(notification.params)
    const threadId = stringOr(params.threadId, stringOr(asRecord(params.thread).id, ''))
    const watching = origin
      ? this.recipients(origin, { threadId })
      : this.subscribers.list(threadId)
    const targets = this.store.getThread(threadId)?.ephemeral
      ? watching
      : new Set([...this.accountPeers, ...watching])
    for (const target of targets)
      if (this.isConnected(target))
        this.deliver(target, shape ? shape(target, notification) : notification, origin ?? target)
  }

  /**
   * 声明了 nativeLineage 的连接：导进来的会话里认得出是别的应用派出来的（native-lineage.mts），
   * 应答里的会话对象（thread、列表的每一项）带上 litchNativeLineage。没声明的原样给；
   * peer 是 null 时不看声明（调用的地方已经挑好了连接）
   */
  private withNativeLineage<T>(peer: RpcPeer | null, result: T): T {
    if (peer && !this.peerFeatures.get(peer)?.extensions.has(EXTENSION.nativeLineage)) return result
    const known = this.store.nativeLineage()
    const mark = (value: unknown) => {
      if (!value || typeof value !== 'object') return
      const thread = value as Record<string, unknown>
      if (typeof thread.id !== 'string') return
      // 父会话只从 Claude 桌面端的数据里来：开头认不出（分叉、交接出来的）但桌面端记了父会话的，也算它派出来的
      const parentThreadId = this.native?.parentOf(thread.id)
      const app = known.get(thread.id) ?? (parentThreadId ? 'claude-desktop' : undefined)
      if (app) thread.litchNativeLineage = parentThreadId ? { app, parentThreadId } : { app }
    }
    const body = result && typeof result === 'object' ? (result as Record<string, unknown>) : {}
    if (Array.isArray(body.data)) for (const thread of body.data) mark(thread)
    mark(body.thread)
    return result
  }

  private deliver(
    target: RpcPeer,
    notification: { method: string; params: unknown },
    origin: RpcPeer,
  ): void {
    debugLog('rpc.notify', {
      peerId: target.id,
      originalPeerId: target.id === origin.id ? null : origin.id,
      method: notification.method,
      params: summarizeRpcParams(notification.method, notification.params),
    })
    target.send({ jsonrpc: '2.0', method: notification.method, params: notification.params })
  }

  private finishAbortedItems(peer: RpcPeer, threadId: string, turnId: string): void {
    const active = this.activeItemsByTurn.get(turnId)
    const turn = this.store.getTurn(turnId)
    if (!active || !turn) return
    const message = '回合已终止；未确认的工具结果不能重放'
    for (const item of turn.items) {
      if (!active.has(item.id) || this.backgroundCommands.isRunning(turnId, item.id)) continue
      let completed: ThreadItem = item
      if (item.type === 'dynamicToolCall')
        completed = {
          ...item,
          status: 'failed',
          success: false,
          contentItems: [{ type: 'inputText', text: message }],
        }
      else if (item.type === 'mcpToolCall')
        completed = { ...item, status: 'failed', error: { message } }
      else if ('status' in item && item.status === 'inProgress')
        completed = { ...item, status: 'failed' }
      this.store.updateItem(turnId, item.id, () => completed)
      this.notify(peer, {
        method: 'item/completed',
        params: { threadId, turnId, item: completed, completedAtMs: nowMillis() },
      })
    }
  }

  // 发给线程的订阅连接，没人订阅就不发；会话级的那几种没人订阅也发（见 announce）。
  private notifyThread(threadId: string, notification: { method: string; params: unknown }): void {
    if (BROADCAST_THREAD_NOTIFICATIONS.has(notification.method)) {
      this.announce(notification)
      return
    }
    const peer = this.subscribers.first(threadId)
    if (peer) this.notify(peer, notification)
  }

  // 状态变化和上游一样总是发给所有连接（见 announce），不看有没有连接订阅着这个线程。
  private setThreadStatus(
    peer: RpcPeer | null,
    threadId: string,
    status: ThreadRecord['status'],
  ): void {
    this.store.updateThreadStatus(threadId, status)
    this.announce(
      { method: 'thread/status/changed', params: { threadId, status } },
      peer ?? this.subscribers.first(threadId),
    )
  }

  private isConnected(peer: RpcPeer): boolean {
    return !isDetachedPeer(peer) && !this.closedPeers.has(peer)
  }

  // 新连接握手之后：告诉它哪些线程正停在那里等人确认却没有客户端在看。
  // 桌面端收到 active 的状态通知会把线程拉进列表并标成等待中；点开（恢复）后确认请求随即送达。
  private announceUnattended(peer: RpcPeer): void {
    for (const threadId of this.pendingInteractions.unattended()) {
      const status = this.store.getThread(threadId)?.status
      if (status?.type !== 'active') continue
      // 只发给这条新连接，不经 notify 的按线程改道；调试日志照记，排查时看得到这条通知。
      const params = { threadId, status }
      debugLog('rpc.notify', {
        peerId: peer.id,
        originalPeerId: null,
        method: 'thread/status/changed',
        params: summarizeRpcParams('thread/status/changed', params),
      })
      peer.send({ jsonrpc: '2.0', method: 'thread/status/changed', params })
    }
  }

  // 向客户端发请求并等回答。线程此刻没有客户端在看时不拒绝也不超时：请求留着，
  // 等有连接订阅这个线程再送过去（见 PendingInteractions）。
  private sendServerRequest(
    peer: RpcPeer,
    method: string,
    id: string,
    params: unknown,
    signal?: AbortSignal,
    // 带协议扩展内容的请求用它按要送去的连接给参数；不给就都用 params。
    paramsFor?: (target: RpcPeer) => unknown,
    // 已经挑好的执行方（客户端工具）：只送它一条，它断开就按失败结束，不改送别人
    chosen?: RpcPeer,
  ): Promise<unknown> {
    const threadId = stringOr(asRecord(params).threadId, '')
    // 该由谁来答：线程的全部订阅连接，先答的生效；没人订阅时是发起回合的连接；它也断开了就没有人可送。
    const targets = (): RpcPeer[] => {
      if (chosen) return this.isConnected(chosen) ? [chosen] : []
      const watching = this.recipients(peer, params).filter((target) => this.isConnected(target))
      if (method !== 'item/tool/call') return watching
      // 客户端执行的工具调用有副作用，只交给一条连接：发起回合的连接还订阅着就给它，否则给最早订阅的那条。
      const executor = watching.find((target) => target.id === peer.id) ?? watching[0]
      return executor ? [executor] : []
    }
    return this.pendingInteractions.request(targets, method, id, params, {
      ...(signal ? { signal } : {}),
      ...(paramsFor ? { paramsFor } : {}),
      // 告诉拿着这条请求的每条连接它已经有结果（含回答它的那条，与原生一致）。
      // 没拿到过它的连接没见过这个请求号，不发。
      onFinished: (holders) => {
        for (const holder of holders)
          this.notifyOnly(holder, {
            method: 'serverRequest/resolved',
            params: { threadId, requestId: id },
          })
      },
    })
  }

  // 客户端工具的执行方（规矩在 shared/src/client-tool-executor.mts）：发起回合的连接还连着、声明了这个
  // 命名空间就是它；否则订阅着线程（或照 recipients 跟着父会话）、声明了的连接里最早订阅的那条；没有返回 null。
  // CLI 自己开的回合没有发起者（peer 是脱离的那个）。
  private clientToolExecutor(peer: RpcPeer, threadId: string, namespace: string): RpcPeer | null {
    const namespacesOf = (target: RpcPeer) =>
      this.peerFeatures.get(target)?.clientTools ?? new Set()
    const starter = this.isConnected(peer) ? peer : null
    const watching = this.recipients(peer, { threadId }).filter((target) =>
      this.isConnected(target),
    )
    return pickClientToolExecutor(namespace, starter, watching, namespacesOf)
  }

  private completeActiveTurns(status: 'interrupted' | 'failed', error: unknown): void {
    for (const [threadId, turnId] of this.activeTurnByThread.entries()) {
      const turn = this.store.getTurn(turnId)
      if (turn?.status === 'inProgress') {
        this.finishGoal(threadId, turnId, status)
        this.finishReview(this.subscribers.first(threadId), threadId, turnId, '审查随运行时停止')
        this.store.completeTurn(turnId, status, error)
      }
      this.store.updateThreadStatus(threadId, { type: 'idle' })
    }
    this.activeTurnByThread.clear()
    for (const startup of this.runtimeReadyByTurn.values()) startup.resolve(false)
    this.runtimeReadyByTurn.clear()
  }

  private finalizeActiveSubagentsForShutdown(message: string): void {
    for (const [turnId, state] of this.subagentStateByTurn.entries()) {
      const turn = this.store.getTurn(turnId)
      if (!turn || turn.status !== 'inProgress') {
        this.subagentStateByTurn.delete(turnId)
        continue
      }
      const peer = this.subscribers.first(state.thread.id) ?? {
        id: 'shutdown',
        send: () => {},
        close: () => {},
      }
      this.finalizeOrphanedSubagents(
        peer,
        state.thread,
        turn,
        state.contexts,
        state.active,
        message,
      )
      this.subagentStateByTurn.delete(turnId)
    }
  }

  private markActiveTurn(threadId: string, turnId: string): void {
    let resolve!: (started: boolean) => void
    const ready = new Promise<boolean>((done) => {
      resolve = done
    })
    this.runtimeReadyByTurn.set(turnId, { ready, resolve })
    this.activeTurnByThread.set(threadId, turnId)
  }

  private clearActiveTurn(threadId: string): void {
    const turnId = this.activeTurnByThread.get(threadId)
    if (turnId) {
      this.runtimeReadyByTurn.get(turnId)?.resolve(false)
      this.runtimeReadyByTurn.delete(turnId)
      this.spontaneousTurns.delete(turnId)
      this.handedToRuntime.delete(turnId)
    }
    const existed = this.activeTurnByThread.delete(threadId)
    const waiters = this.turnClearWaiters.get(threadId)
    if (waiters) {
      this.turnClearWaiters.delete(threadId)
      for (const resolve of waiters) resolve()
    }
    this.relayParentByChild.delete(threadId)
    this.armDetachedReap()
    // 没人订阅的临时会话在跑的回合结束了：从现在起算卸载的时限
    if (existed) this.scheduleEphemeralUnload(threadId, true)
    if (existed && this.activeTurnByThread.size === 0) this.idleCheckHandler?.()
  }

  // 子代理线程上的用户输入只能经父会话转给该子代理：SDK 没有宿主直连子代理的接口，
  // 但主模型的 SendMessage 可以按 agentId 把已结束的子代理连同上下文恢复。
  private subagentRelay(thread: ThreadRecord): { parent: ThreadRecord; agentId: string } | null {
    if (thread.threadSource !== 'subagent') return null
    const parent = thread.forkedFromId ? this.store.getThread(thread.forkedFromId) : null
    const agentId = this.store.threadSettings(thread.id).claudeAgentId ?? ''
    if (
      !parent?.claudeSessionId ||
      thread.agentRole === 'workflow' ||
      !/^[0-9a-f]{8,32}$/i.test(agentId)
    )
      throw new ProtocolError(-32009, '这个子代理没有可恢复的记录，不能继续对话')
    return { parent, agentId }
  }

  // CLI 给子代理的 ID 只用于追问时寻址，与显示用的昵称分开保存。
  private saveSubagentId(childThreadId: string, agentId: string): void {
    const settings = this.store.threadSettings(childThreadId)
    if (settings.claudeAgentId === agentId) return
    settings.claudeAgentId = agentId
    this.store.saveThreadSettings(childThreadId, settings)
  }

  // 一条通知或请求该发给哪些连接：线程的全部订阅连接；线程自己没人订阅时跟着最近一个有人订阅的祖先
  // （子代理线程跟着父线程），并把它们记成这个线程的订阅连接；都没有，就是发起这次操作的那条连接。
  // 不带线程的消息只给发起者。
  private recipients(peer: RpcPeer, params: unknown): RpcPeer[] {
    const threadId = stringOr(asRecord(params).threadId, '')
    if (!threadId) return [peer]
    const direct = this.subscribers.list(threadId)
    if (direct.length > 0) return direct
    const seen = new Set<string>()
    let current = this.store.getThread(threadId)
    // 只有子代理会话跟着父会话的订阅连接走（父会话换了连接，比如重连之后，子会话的通知也要到）。
    // 分叉出来的会话是独立的：退订了就是退订了，不因为这条连接还看着源会话又被挂回去
    while (
      current?.threadSource === 'subagent' &&
      current.forkedFromId &&
      !seen.has(current.forkedFromId)
    ) {
      seen.add(current.forkedFromId)
      const inherited = this.subscribers.list(current.forkedFromId)
      if (inherited.length > 0) {
        for (const subscriber of inherited) this.subscribers.add(threadId, subscriber)
        return inherited
      }
      current = this.store.getThread(current.forkedFromId)
    }
    return [peer]
  }

  // 分叉出来的会话自己的开发者指令（和父会话的不同）放在用户消息前面交给模型，只放一次：
  // 上一次放的就是这一份，带着它的回合还在这个会话里（没被回退；分叉带过来的回合换了标识，不算），
  // 也没失败，之后没压缩过（压缩时去掉记录），就还在模型的上下文里
  private instructionsInjected(threadId: string, text: string): boolean {
    const last = this.store.threadSettings(threadId).injectedInstructions
    if (!last || last.text !== text) return false
    const turn = this.store.getTurn(last.turnId)
    return turn?.threadId === threadId && turn.status !== 'failed'
  }

  private rememberInjectedInstructions(
    threadId: string,
    injected: { text: string; turnId: string } | null,
  ): void {
    const settings = this.store.threadSettings(threadId)
    if (injected) settings.injectedInstructions = injected
    else if (settings.injectedInstructions) delete settings.injectedInstructions
    else return
    this.store.saveThreadSettings(threadId, settings)
  }

  // 计划确认由入口在回合里问，还是交给客户端在回合结束后问（planConfirmation 扩展）：
  // 看发起回合的那条连接声明了没有。CLI 自己开的回合（后台命令结束后）不是哪条连接发起的，
  // 看这时订阅着线程的连接，有一条声明了就问；一条都没有时照旧问，问题等有连接订阅时送到
  private asksPlanConfirmation(peer: RpcPeer, threadId: string): boolean {
    const declared = (target: RpcPeer) =>
      this.peerFeatures.get(target)?.extensions.has(EXTENSION.planConfirmation) === true
    if (!isDetachedPeer(peer)) return declared(peer)
    const watching = this.recipients(peer, { threadId }).filter((target) => !isDetachedPeer(target))
    return watching.length === 0 || watching.some(declared)
  }

  private bindPeerToDescendants(peer: RpcPeer, rootThreadId: string): void {
    const queue = [rootThreadId]
    const seen = new Set<string>()
    while (queue.length > 0) {
      const parentId = queue.shift()
      if (!parentId || seen.has(parentId)) continue
      seen.add(parentId)
      for (const child of this.store.listThreads({
        includeEphemeral: true,
        parentThreadId: parentId,
        sortKey: 'created_at',
        sortDirection: 'asc',
      })) {
        this.subscribers.add(child.id, peer)
        queue.push(child.id)
      }
    }
  }

  // 默认模型与强度以 Claude Code 的 settings.json 为准（model、effortLevel），config.json 里的旧值第一次读到时搬过去
  private loadPersistedConfig() {
    let snapshot = readConfigFile(this.configPath)
    this.validateConfigValues(snapshot.values)
    try {
      if (migrateDefaultModel(this.configPath)) snapshot = readConfigFile(this.configPath)
    } catch (error) {
      // 搬不过去（settings.json 坏了之类）就先接着用 config.json 里的旧值，下次再搬
      debugLog('config.migrateDefaultModel.failed', {
        error: error instanceof Error ? error.message : String(error),
      })
    }
    const {
      model: legacyModel,
      model_reasoning_effort: legacyEffort,
      ...overrides
    } = snapshot.values
    const defaults = readSettingsDefaults()
    // settings.json 是和命令行共用的，里面的模型不一定是这个入口能用的（比如手填了别家的）：用不了就按没写处理
    const model =
      defaults.model !== null && isSelectableModel(defaults.model)
        ? defaults.model
        : typeof legacyModel === 'string'
          ? legacyModel
          : null
    this.configModel = model === null ? defaultSelectableModelId() : catalogModelId(model)
    this.configReasoningEffort =
      defaults.effort ??
      normalizeCodexReasoningEffort(typeof legacyEffort === 'string' ? legacyEffort : null) ??
      normalizeCodexReasoningEffort(process.env.CHA_CLAUDE_DEFAULT_EFFORT) ??
      'medium'
    // `app-server -c` 给的那一层叠在 config.json 上（cli-config.mts），只在内存里
    this.configOverrides = mergeConfigLayers(overrides, cliConfigLayer())
    this.persistedSkillConfig = asRecord(overrides.skills).config
    // MCP 服务到用的时候才查（mcpScope），一个服务配错不至于让整个进程起不来
    const { mcp_servers: _, ...checked } = this.configOverrides
    this.validateConfigValues(checked)
    return snapshot
  }

  // config/*Write 在它上面改：config.json 里的那些，加上 settings.json 里的默认模型与强度
  private persistedConfigValues(): { values: Record<string, unknown>; version: string } {
    const snapshot = this.loadPersistedConfig()
    const values: Record<string, unknown> = { ...snapshot.values }
    const defaults = readSettingsDefaults()
    if (defaults.model !== null && isSelectableModel(defaults.model)) values.model = defaults.model
    if (defaults.effort !== null) values.model_reasoning_effort = defaults.effort
    return { values, version: snapshot.version }
  }
}

import { sandboxCommand } from './command-sandbox.mjs'

// 经 litch/harness/mcp/login 开的 MCP 授权不属于哪条连接：连接断开不撤销它，到时限自己结束
const HARNESS_CONFIG_PEER = 'harness-config'

// 线程没有连接订阅时的占位：通知无处可送，路由仍先看线程当前的订阅者。
/** 选中的 Skill 正文放在这一轮的话前面（上游把 SkillInstructions 作为单独的用户片段放在用户消息之前） */
function withSkillInstructions(instructions: string[], prompt: string): string {
  return [...instructions, prompt].filter(Boolean).join('\n\n')
}

const DETACHED_PEER_PREFIX = 'detached:'

function detachedPeer(threadId: string): RpcPeer {
  return { id: DETACHED_PEER_PREFIX + threadId, send: () => {}, close: () => {} }
}

function isDetachedPeer(peer: RpcPeer): boolean {
  return peer.id.startsWith(DETACHED_PEER_PREFIX)
}

// 所有连接断开后，看管后台命令的 CLI 进程再保留多久；0 表示一直保留。
// 临时会话没人订阅、也不在跑了之后多久卸载：照上游 thread_unload_delay 的默认值，60 秒。
function ephemeralUnloadDelayMs(): number {
  const raw = process.env.CHA_CLAUDE_EPHEMERAL_UNLOAD_MS
  const ms = raw == null || raw.trim() === '' ? 60_000 : Number(raw)
  return Number.isFinite(ms) && ms >= 0 ? ms : 60_000
}

function detachedLingerMs(): number {
  const raw = process.env.CHA_CLAUDE_KEEP_ALIVE_DETACHED_MINUTES
  const minutes = raw == null || raw.trim() === '' ? 30 : Number(raw)
  return Number.isFinite(minutes) && minutes >= 0 ? minutes * 60_000 : 30 * 60_000
}
