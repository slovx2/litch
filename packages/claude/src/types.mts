import type { ElicitationRequest, ElicitationResult } from '@anthropic-ai/claude-agent-sdk'
import type { ApprovalPolicy } from './approval-policy.mjs'
import type { CodexErrorInfo } from './codex-error-info.mjs'
import type { RuntimeBackendType } from './runtime-config.mjs'
import type { RuntimeSandboxPolicy } from './sandbox-policy.mjs'

export type {
  JsonRpcError,
  JsonRpcId,
  JsonRpcNotification,
  JsonRpcRequest,
  JsonRpcResponse,
  JsonValue,
  RpcPeer,
  WireMessage,
} from '../../shared/src/types.mjs'

export interface ThreadRecord {
  id: string
  sessionId: string
  forkedFromId: string | null
  // Legacy Codex App clients use this flag to partition the thread list into
  // pinned and work-directory views. Keep it optional for older test fixtures
  // and normalize missing values to false at the persistence boundary.
  isPinned?: boolean | undefined
  // Newer Codex clients represent pinning as membership in a reserved thread
  // section. Keep the raw section metadata alongside the legacy flag so both
  // protocol generations can share the same persisted state.
  sectionId?: string | null | undefined
  sectionEnteredAt?: number | null | undefined
  sectionPosition?: number | null | undefined
  preview: string
  name: string | null
  archived: boolean
  cwd: string
  model: string
  reasoningEffort: string | null
  modelProvider: string
  // Which backend actually drives this thread's turns. 'claude' = our native
  // @anthropic-ai/claude-agent-sdk runtime. 'codex' = a child `codex exec`
  // process running the real OpenAI Codex CLI. Picked at thread/start based
  // on the model the user chose in the App's model picker (gpt-* → codex,
  // sonnet/opus/haiku → claude), persisted on the thread so every later
  // turn / resume / fork / steer routes to the right backend without needing
  // the model id again.
  runtimeBackend: 'claude' | 'codex'
  claudeSessionId: string | null
  // Real Codex's persisted session id (returned by `codex exec` as
  // thread.started.thread_id). Reused on subsequent turns via
  // `codex exec resume <id>` so the conversation history survives. Only
  // populated for runtimeBackend='codex' threads.
  codexSessionId: string | null
  source: string
  createdAt: number
  updatedAt: number
  status: ThreadStatus
  // 审批策略与文件系统边界分别保存，不把禁止提权等同于完全访问。
  approvalPolicy: ApprovalPolicy | null
  sandboxMode: string | null
  // Newer Codex clients send a built-in or custom permission profile id
  // (for example `:danger-full-access`) instead of a legacy sandbox string.
  // Keep it alongside the normalized policies so the profile survives resume
  // and the settings UI can round-trip its selection.
  permissionProfileId?: string | null
  // Codex App marks transient title-generation / consolidation threads as
  // ephemeral — these should not appear in the user-facing thread list.
  ephemeral: boolean
  // 'user' | 'subagent' | 'memory_consolidation' (Codex `ThreadSource`).
  // Subagent threads spawned by the Task tool also carry this.
  threadSource: string | null
  // Codex's native subagent identity. `agentRole` mirrors the Codex
  // "agent_role" (mapped from Claude's Task `subagent_type`); `agentNickname`
  // is the unique handle the App displays for this subagent instance.
  agentRole: string | null
  agentNickname: string | null
  // Codex App's per-thread instruction surface (settings panel: project
  // instructions / developer instructions / personality). We thread these
  // through to Claude as a system_prompt addendum so the user's configured
  // tone and constraints actually take effect.
  baseInstructions: string | null
  developerInstructions: string | null
  personality: string | null
}

export interface ThreadSectionAppearance {
  color: string | null
  icon: string | null
}

export interface ThreadSectionRecord {
  id: string
  name: string
  appearance: ThreadSectionAppearance | null
}

export type ThreadStatus =
  | { type: 'notLoaded' }
  | { type: 'idle' }
  | { type: 'systemError' }
  | { type: 'active'; activeFlags: Array<'waitingOnApproval' | 'waitingOnUserInput'> }

export type TurnStatus = 'completed' | 'interrupted' | 'failed' | 'inProgress'

export interface TurnRecord {
  id: string
  threadId: string
  status: TurnStatus
  startedAt: number | null
  completedAt: number | null
  durationMs: number | null
  items: ThreadItem[]
  diff: string
  error: unknown | null
  // Claude Agent SDK ResultMessage metrics. Surface them in turn/completed
  // so Codex App's status bar can show real timing + cost instead of blanks.
  apiDurationMs?: number | null
  numTurns?: number | null
  costUsd?: number | null
}

import type { LitchPeer } from '../../protocol/src/peer-messages.mjs'
import type { UserInput } from '../../shared/src/types.mjs'

export type { UserInput } from '../../shared/src/types.mjs'

export type ThreadItem =
  | {
      type: 'userMessage'
      id: string
      content: UserInput[]
      clientId?: string | null
      /** 别的会话发来的消息（peerMessages 扩展）：只发给声明过的连接，别的连接上去掉 */
      litchPeer?: LitchPeer
    }
  | { type: 'agentMessage'; id: string; text: string; phase: string | null; memoryCitation: null }
  | { type: 'plan'; id: string; text: string }
  | { type: 'reasoning'; id: string; summary: string[]; content: string[] }
  | { type: 'enteredReviewMode'; id: string; review: string }
  | { type: 'exitedReviewMode'; id: string; review: string }
  | { type: 'contextCompaction'; id: string }
  | {
      type: 'commandExecution'
      id: string
      command: string
      cwd: string
      processId: string | null
      source: string
      status: 'inProgress' | 'completed' | 'failed' | 'declined'
      commandActions: unknown[]
      aggregatedOutput: string | null
      exitCode: number | null
      durationMs: number | null
    }
  | {
      type: 'fileChange'
      id: string
      changes: FileUpdateChange[]
      status: 'inProgress' | 'completed' | 'failed' | 'declined'
    }
  // User-uploaded image surfaced in the thread transcript so Codex App can
  // render an inline preview. Path is either a real file path (localImage)
  // or a URL (image with http(s)/data:).
  | { type: 'imageView'; id: string; path: string }
  // Codex hookPrompt — surfaces Claude Code hook activity (PreToolUse,
  // PostToolUse, UserPromptSubmit, etc.) as a first-class timeline item
  // instead of flattening it into a single notice line.
  | {
      type: 'hookPrompt'
      id: string
      // Codex protocol HookPromptFragment = { text, hookRunId }. We previously
      // emitted {kind, text} (a misread of an older schema) — that would crash
      // the App's ts-rs deserializer with "missing field `hookRunId`". Each
      // fragment now carries the structured hookRunId so App can group related
      // fragments under one hook execution.
      fragments: Array<{ text: string; hookRunId: string }>
    }
  | {
      type: 'mcpToolCall'
      id: string
      server: string
      tool: string
      status: string
      arguments: unknown
      // Codex v2 McpToolCallResult shape — must have all three fields present
      // (structuredContent / _meta default to null). Raw content array is the
      // Anthropic tool-result block array.
      result: {
        content: unknown[]
        structuredContent: unknown | null
        _meta: unknown | null
      } | null
      // Codex v2 McpToolCallError shape — { message: string } and nothing else.
      error: { message: string } | null
      durationMs: number | null
    }
  // Native Codex Web Search rendering. Claude SDK's WebSearch tool input is
  // {query: string}; we map it to Codex's `webSearch` ThreadItem so the App
  // gets the dedicated search badge / link UI instead of a generic mcpToolCall.
  | {
      type: 'webSearch'
      id: string
      query: string
      // Codex v2 WebSearchAction. Each variant's inner fields are Option<...>
      // with no serde default, so we MUST always emit them (allowed to be null).
      action:
        | { type: 'search'; query: string | null; queries: string[] | null }
        | { type: 'openPage'; url: string | null }
        | { type: 'findInPage'; pattern: string | null; url: string | null }
        | { type: 'other' }
        | null
    }
  // Native Codex subagent representation. The Task tool spawns a child thread;
  // Codex App displays it as one Agent item that can drill into the child
  // thread by id (`receiverThreadIds`).
  | {
      type: 'collabAgentToolCall'
      id: string
      tool: 'spawnAgent' | 'sendInput' | 'resumeAgent' | 'wait' | 'closeAgent'
      status: 'inProgress' | 'completed' | 'failed'
      senderThreadId: string
      receiverThreadIds: string[]
      prompt: string | null
      model: string | null
      reasoningEffort: string | null
      agentsStates: Record<
        string,
        {
          status:
            | 'pendingInit'
            | 'running'
            | 'interrupted'
            | 'completed'
            | 'errored'
            | 'shutdown'
            | 'notFound'
          message: string | null
        }
      >
    }
  // Canonical MultiAgent V2 display/liveness item. Codex App discovers the
  // child from `started` and clears its working state from `completed` or
  // `interrupted`; collabAgentToolCall remains the structured tool timeline.
  | {
      type: 'subAgentActivity'
      id: string
      kind: 'started' | 'interacted' | 'interrupted' | 'completed'
      agentThreadId: string
      agentPath: string
    }
  // Codex's native dynamic tool call item — used to surface AskUserQuestion as
  // a structured choice card the App renders inline (paired with the
  // item/tool/requestUserInput reverse RPC). The contentItems array carries
  // the user's free-form answer text (Codex `DynamicToolCallOutputContentItem`).
  | {
      type: 'dynamicToolCall'
      id: string
      namespace: string | null
      tool: string
      arguments: unknown
      status: 'inProgress' | 'completed' | 'failed'
      contentItems: Array<
        { type: 'inputText'; text: string } | { type: 'inputImage'; imageUrl: string }
      > | null
      success: boolean | null
      durationMs: number | null
    }

export interface FileUpdateChange {
  path: string
  kind: { type: 'add' } | { type: 'delete' } | { type: 'update'; move_path: string | null }
  diff: string
}

export interface RuntimeTurnContext {
  // 子代理追问回合：主会话只负责用 SendMessage 把用户原文转给该子代理。
  subagentRelay?: { agentId: string; message: string }
  // CLI 会话所属的线程；追问回合跑在父线程的会话上。缺省即 threadId。
  sessionThreadId?: string
  // CLI 自己开的一轮（后台任务结束后的续跑）：没有用户输入，接到已在运行的那一轮上。
  spontaneous?: boolean
  // systemPromptAddendum 末尾的目标说明。它每回合都可能变化，进程存活期间随用户消息更新。
  goalContext?: string | null
  permissionTools?: boolean
  permissionGrants?: import('./permission-grants.mjs').PermissionOverlay
  goalTools?: boolean
  trackGoalTools?: boolean
  sandboxPolicy?: RuntimeSandboxPolicy
  // 自定义权限档位落到具体路径上的规则（permission-profiles.mts）；有它时文件类工具与命令沙箱都按它判
  fileSystem?: import('./permission-profiles.mjs').FileSystemRules
  // Bash 命令的环境变量规则（shell-environment.mts）；没配不带
  shellEnvironment?: import('./shell-environment.mjs').ShellEnvironmentPolicy
  dynamicTools?: unknown[]
  threadId: string
  turnId: string
  // normal = user-visible chat/review turn; summary = Codex App's structured
  // title/metadata turn; compact = explicit context compaction.
  purpose?: 'normal' | 'summary' | 'compact'
  prompt: string
  cwd: string
  runtimeType: RuntimeBackendType | null
  model: string | null
  effort: string | null
  claudeSessionId: string | null
  forkSession: boolean
  mcpServers: unknown | null
  mcpConfigSource?: string
  allowedTools: string[] | null
  addDirs: string[]
  skillOverrides?: Record<string, 'on' | 'off'>
  // 配置的 skills.bundled.enabled = false：Claude Code 自带的 Skill 整个关掉（它的 disableBundledSkills）
  disableBundledSkills?: boolean
  outputFormat: unknown | null
  approvalPolicy: ApprovalPolicy | null
  sandboxMode: string | null
  // Pre-assembled system prompt addendum (baseInstructions + developerInstructions
  // + personality cue). Sidecar appends it to Claude's default system prompt.
  systemPromptAddendum: string | null
  // 客户端和原生计划工具共同维护，退出后仍保留用户的沙箱限制。
  planMode: boolean
  // 模型交计划（ExitPlanMode）时入口自己问要不要执行：发起回合的连接握手时声明了 planConfirmation
  // 扩展才问。不问时回合带着计划停下，由客户端在回合结束后自己问（官方桌面端的做法）。
  planConfirmation?: boolean
  // 会话还没有名字：CLI 不会自己起标题时（宿主环境关了，或者是续接的会话），请它照这句话（会话的第一句话）起一个
  sessionTitle?: string
  // Multimodal input attached to the turn. localImage gets read + base64
  // encoded; image (URL) is passed through as-is. Sidecar reshapes the
  // Claude SDK query into a multimodal user message when this is non-empty.
  imageInputs: ImageInput[]
}

export interface ImageInput {
  kind: 'base64' | 'url'
  mediaType: string
  // Base64-encoded bytes when kind=base64; the URL string when kind=url.
  data: string
  // Display path/URL preserved for the imageView ThreadItem rendering.
  displayPath: string
}

export type RuntimeEvent =
  | {
      type: 'rate_limits'
      credentialScope: string | null
      info: import('./rate-limits.mjs').NativeRateLimitInfo
    }
  | { type: 'plan_mode'; enabled: boolean }
  | { type: 'plan_text'; text: string }
  // 模型交了计划（ExitPlanMode）：计划条目到此为止。入口不问时（见 planConfirmation）回合随后停下，
  // 在回合里问时这一条先于提问。plan 是 CLI 交来的计划全文（计划文件的内容），没有时是 null。
  | { type: 'plan_handoff'; plan: string | null }
  // 压缩后上下文里还剩多少（compact_boundary 的 compact_metadata.post_tokens），CLI 没报是 null
  | { type: 'context_compacted'; messageId: string; postTokens?: number | null }
  | { type: 'native_boundary'; messageId: string }
  | { type: 'session'; claudeSessionId: string }
  // 这一轮里 CLI 连着哪些 MCP 服务（配置里的原名）。拆 MCP 工具名时拿它对服务名。
  | { type: 'mcp_servers'; names: string[] }
  // A new top-level model response is beginning, not a streamed content block.
  | { type: 'message_boundary' }
  | { type: 'text_delta'; delta: string }
  | { type: 'reasoning_delta'; delta: string }
  | { type: 'tool_use'; toolUseId: string; toolName: string; input: Record<string, unknown> }
  | { type: 'tool_output_delta'; toolUseId: string; delta: string }
  | {
      type: 'tool_result'
      toolUseId: string
      content: unknown
      isError?: boolean
      // SDK 的结构化工具结果（tool_use_result）；子代理的正文与用量以它为准。
      structured?: unknown
      // 命令转入后台：这条结果只是启动回执，命令仍在运行，结束时另行通知。
      backgroundTaskId?: string
    }
  // Agent 工具返回的只是后台启动回执：子代理仍在运行，结果稍后以 tool_result 送达。
  | { type: 'subagent_backgrounded'; toolUseId: string; agentId: string }
  // 子代理内部的正文、思考与工具调用，按所属 Agent 工具调用投影到子线程。
  | { type: 'subagent_event'; agentToolUseId: string; event: SubagentInnerEvent }
  // 子代理有动静（CLI 的 task_progress、子代理的流式增量）。只给看门狗重新计时，不投影。
  // agentToolUseId 是派出它的 Agent 调用，taskId 是 CLI 的任务 ID；认不出是哪一个时都不带
  | { type: 'subagent_activity'; agentToolUseId?: string; taskId?: string }
  // CLI 给一个 Agent 调用起了任务（task_started，local_agent）：看门狗单独停它时要用这个任务 ID
  | { type: 'subagent_task'; toolUseId: string; taskId: string }
  // 主模型用 SendMessage 续跑了一个已结束的子代理（toolUseId 是那次 SendMessage，agentId 是 CLI 的代理 ID）。
  // 续跑期间子代理的消息照旧挂在当初派出它的 Agent 调用下面（subagent_event 的 agentToolUseId）。message 是交给它的话
  | { type: 'subagent_resumed'; toolUseId: string; agentId: string; message: string }
  // 续跑的子代理结束了（CLI 的 task_notification）。summary 是它最后的回答
  | {
      type: 'subagent_resume_finished'
      toolUseId: string
      agentId: string
      status: 'completed' | 'failed' | 'interrupted'
      summary: string
    }
  | {
      type: 'permission_request'
      requestId: string
      toolUseId: string
      toolName: string
      input: Record<string, unknown>
    }
  | {
      type: 'user_input_request'
      toolName?: string
      requestId: string
      toolUseId: string
      questions: UserInputQuestion[]
    }
  | { type: 'notice'; level: 'info' | 'warning' | 'error'; message: string }
  // 别的会话发来的消息进了模型（CLI 回显的 origin.kind=peer）：text 是对方的原文
  | { type: 'peer_message'; text: string; peer: LitchPeer }
  // 回合累计的用量（只加进 total）；contextWindow 是主模型的上下文窗口，不知道是 null
  // model 是最近一次顶层请求的模型（窗口按它记下，导进来的会话算用量时查）
  | {
      type: 'usage'
      usage: Record<string, unknown>
      contextWindow?: number | null
      model?: string | null
    }
  // 一次模型请求结束：现在上下文里有多少（换掉 last）。agentToolUseId 不为空的是那个子代理自己的请求
  // model 是最近一次顶层请求的模型：回合还没结束、线程还没记下窗口时按它查窗口
  | {
      type: 'context_usage'
      usage: Record<string, unknown>
      agentToolUseId: string | null
      model?: string | null
    }
  | { type: 'goal_usage'; messageId: string; usage: Record<string, unknown> }
  | { type: 'goal_limit'; usageLimited: boolean }
  | {
      type: 'metrics'
      durationMs: number | null
      apiDurationMs: number | null
      numTurns: number | null
      costUsd: number | null
    }
  | {
      type: 'hook'
      hookRunId: string
      messageId: string
      phase: 'started' | 'progress' | 'response'
      hookName: string
      hookEvent: string
      outcome: 'success' | 'error' | 'cancelled' | null
      exitCode: number | null
      stdout: string
      stderr: string
      output: string
    }
  | {
      type: 'completed'
      claudeSessionId?: string | null
      result?: string | null
      success: boolean
      /** 失败时认出的模型接口错误种类（codex-error-info.mts），TurnError 带上 */
      codexErrorInfo?: CodexErrorInfo | null
    }
  | { type: 'error'; message: string }

export type SubagentInnerEvent =
  | { type: 'text'; text: string }
  | { type: 'reasoning'; text: string }
  | { type: 'tool_use'; toolUseId: string; toolName: string; input: Record<string, unknown> }
  | { type: 'tool_result'; toolUseId: string; content: unknown; isError?: boolean }

// Codex's request_user_input primitive — surfaces Claude's AskUserQuestion as a
// native choice card in the App instead of a generic mcpToolCall blob. Matches
// the Codex v2 ToolRequestUserInputQuestion shape so the App's structured UI
// (`isOther` for free-text, `isSecret` for masked, options list) renders correctly.
// isOther 是“选项之外可以自己说”的唯一标记：选项里不放代表它的假选项。
export interface UserInputQuestion {
  id: string
  header: string
  question: string
  isOther: boolean
  isSecret: boolean
  options: Array<{ label: string; description: string }> | null
}

export interface UserInputAnswers {
  // 按题目标识。answers 是这道题交回来的字：选中的选项标签，或者用户自己写的话；
  // 空数组是没有回答。标准协议里只有 answers，一道题可以有不止一个（多选时）。
  // notes 不是标准协议的字段，应答里带了就收：有答案时它是另附的备注，没有答案时它就是答案。
  answers: Record<string, { answers: string[]; notes?: string | null }>
}

export interface TokenUsageBreakdown {
  totalTokens: number
  inputTokens: number
  cachedInputTokens: number
  outputTokens: number
  reasoningOutputTokens: number
}

export interface ThreadTokenUsage {
  total: TokenUsageBreakdown
  last: TokenUsageBreakdown
  modelContextWindow: number | null
}

export interface PermissionDecision {
  decision: 'accept' | 'acceptForSession' | 'decline' | 'cancel'
  updatedInput?: Record<string, unknown>
  // 用户拒绝时附的说明（扩展 declineWithNote），只在 decline 时有；运行时要把它交给模型。
  note?: string
}

/**
 * 一次原生工具调用的意图：PreToolUse 钩子放行之前由入口记进自己的库（`native_tool_intents`）。
 * CLI 的会话记录要攒一阵才写，入口崩溃、CLI 被强杀时这次调用可能还没进记录；入口据此在下一回合告诉模型
 */
export interface NativeToolIntent {
  callId: string
  tool: string
  input: unknown
  /** CLI 进程所在会话的键（追问子代理时是父会话）：判断写这份记录的 CLI 还在不在 */
  sessionKey: string
  /** 钩子事件里的 transcript_path（主会话的记录）和子代理的 agent_id */
  transcriptPath: string
  agentId: string | null
}

export interface RuntimeHandlers {
  onPermissionToolCall?(
    proposal: import('./permission-grants.mjs').PermissionProposal,
    callId: string,
  ): Promise<import('./permission-grants.mjs').PermissionGrant>
  onGoalToolCall?(name: string, args: Record<string, unknown>, callId: string): Promise<unknown>
  /** 原生工具执行之前把意图落进入口的库；抛错时钩子拒绝这次调用 */
  onNativeToolCall?(intent: NativeToolIntent): void
  onNativeToolIntent?(callId: string, name: string, args: Record<string, unknown>): void
  onNativeToolResult?(callId: string, result: unknown): void
  onElicitationRequest?(
    request: ElicitationRequest,
    signal: AbortSignal,
  ): Promise<ElicitationResult>
  onDynamicToolCall?(
    tool: { name: string; namespace?: string },
    args: unknown,
    callId: string,
  ): Promise<unknown>
  onEvent(event: RuntimeEvent): Promise<void> | void
  onPermissionRequest(
    event: Extract<RuntimeEvent, { type: 'permission_request' }>,
  ): Promise<PermissionDecision>
  // Routed when Claude invokes AskUserQuestion. The server bridges this to
  // Codex's native `item/tool/requestUserInput` reverse RPC so the App can
  // render structured choice cards instead of a raw tool_use blob. Optional
  // because not every consumer (mock harnesses, compaction subturns) needs
  // to expose a real user-input surface — when absent the runtime returns an
  // empty answer to the model.
  onUserInputRequest?(
    event: Extract<RuntimeEvent, { type: 'user_input_request' }>,
  ): Promise<UserInputAnswers>
}

export interface NativeSessionFork {
  sessionId: string
  messageIds: Record<string, string>
}

// 与原生 /model 菜单一致的模型行：value 可直接传给 SDK，default 表示交由原生配置决定。
export type NativeModelInfo = {
  value: string
  resolvedModel?: string
  displayName: string
  description: string
  supportedEffortLevels?: string[]
}

// CLI 进程里仍存活的后台 Bash 任务。回合结束时还有任务在跑，进程就留到下一回合。
export type RuntimeBackgroundShell = {
  taskId: string
  toolUseId: string | null
  command: string
  seq: number
}

// 后台命令结束：自己退出、被停止，或者随 CLI 进程一起结束。
export interface RuntimeBackgroundCommandEnd {
  taskId: string
  toolUseId: string | null
  status: 'completed' | 'failed' | 'stopped'
  exitCode: number | null
  output: string
}

// 跨回合存活的 CLI 进程在没有回合时发生的事，由协议层接手。
export interface RuntimeSessionHandlers {
  // CLI 自己开了一轮。协议层建好回合并以 spontaneous 上下文调用 runTurn 后返回 true；
  // 返回 false 表示不接，运行时会打断这一轮。
  onSpontaneousTurn(threadId: string): Promise<boolean>
  onBackgroundCommandEnded(threadId: string, end: RuntimeBackgroundCommandEnd): void
  // CLI 关于后台任务的 system 消息（background_tasks_changed、task_started、task_updated、task_notification），
  // 原样交给协议层攒后台任务的集合（background-tasks.mts）
  onBackgroundTaskMessage?(threadId: string, message: Record<string, unknown>): void
  // 进程已退出，仍在运行的后台命令随它结束。
  onSessionClosed(threadId: string, reason: string): void
}

export interface ClaudeRuntime {
  supportedModels?(): Promise<NativeModelInfo[]>
  // 账号的订阅额度（CLI 的 get_usage）。不发用户消息、不请求模型
  accountUsage?(): Promise<import('./rate-limits.mjs').NativeAccountUsage>
  setSessionHandlers?(handlers: RuntimeSessionHandlers): void
  // 仍有 CLI 进程存活的线程（只是空闲保留着的不算）。
  liveSessions?(): string[]
  // CLI 进程还没退出的会话键（正在收场的也算：退出前它还会写会话记录）
  cliProcessKeys?(): string[]
  closeSession?(threadId: string, reason: string): Promise<void>
  // 关掉只是空闲保留着的 CLI 进程：客户端全都断开、技能配置要改时
  closeIdleSessions?(reason: string): Promise<void>
  // 客户端全都断开时：关掉跨回合留着、眼下没人用的 MCP 连接
  closeIdleMcp?(): Promise<void>
  // 删掉 CLI 写下的一份会话记录（连同它的子代理记录）：临时会话卸载时用。找不到就报错。
  deleteSession?(sessionId: string, cwd: string): Promise<void>
  listBackgroundShells?(threadId: string): RuntimeBackgroundShell[]
  stopBackgroundShell?(threadId: string, taskId: string): Promise<boolean>
  // 停掉一个子代理任务（看门狗用），回合照常。停不了（没有进程、任务已不在）返回 false
  stopSubagentTask?(threadId: string, taskId: string): Promise<boolean>
  updateTurnSettings?(
    threadId: string,
    turnId: string,
    settings: import('./turn-settings.mjs').RuntimeTurnSettings,
  ): Promise<boolean>
  appendContext?(
    context: import('./native-context.mjs').ContextInjection,
  ): Promise<{ boundary: string }>
  forkSession?(sessionId: string, cwd: string, upToMessageId?: string): Promise<NativeSessionFork>
  // CLI 给这个会话起的标题（用户改的名优先，其次 CLI 起的），没有是 null
  sessionTitle?(sessionId: string, cwd: string): Promise<string | null>
  runTurn(context: RuntimeTurnContext, handlers: RuntimeHandlers): Promise<void>
  steer(threadId: string, prompt: string): Promise<void>
  interrupt(threadId: string): Promise<void>
  stop(): Promise<void>
}
