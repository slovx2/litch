# Codex App Remote Capability Matrix

Codex App connects to a remote host via the normal Codex Remote SSH app-server
flow, while agent turns are routed to Claude Code. Default runtime is the Claude
Agent SDK sidecar; runtime selection is pluggable. Status legend: **Supported**,
**Experimental**, **Stub**, **Unsupported**, **N/A**.

## Core

| Area | Status | Notes |
| --- | --- | --- |
| Remote transport | Supported | SSH starts `codex app-server --listen unix://` + `proxy`; the shim reports a Codex-compatible version/user agent. |
| Thread lifecycle | Supported | start/resume/fork/archive/list/read + turn listing, backed by SQLite + Claude session ids. |
| Normal chat | Supported | `turn/start` streams Claude text/reasoning into Codex agentMessage/reasoning items. |
| 原生消息队列 | Supported | `thread/queue/add/list/update/delete/reorder/start` 持久化输入、顺序与消息身份；已加载线程自动执行，成功后继续消费，中断或失败后暂停。重启只读不执行，显式 resume/start 才恢复。领取与回合账本同事务，已消费或删除的消息 ID 不得重新入队。 |
| Steering / interrupt | Supported | `turn/steer` and `turn/interrupt` route to the active Claude client. |
| Token usage | Supported | SDK ResultMessage usage → TokenUsageBreakdown, pushed as `thread/tokenUsage/updated` (cumulative + last turn). |

## Runtime selection

| Backend | Status | Notes |
| --- | --- | --- |
| Selection mechanism | Supported | `CHA_CLAUDE_RUNTIME_TYPE` picks native `codex` passthrough (shim) or adapter runtimes. Switch with `codex-harness-adapter-mode` on the host and reconnect. |
| agent-sdk-sidecar (default) | Supported | In-process Claude Agent SDK; full tool/permission/reasoning events. |
| agent-http / Channels | Experimental | Consumes `POST /message`, `GET /messages|/status|/events`; message-level deltas only, no semantic tool/permission/reasoning events. |
| agentapi | Experimental | Same HTTP/SSE client against coder/agentapi; terminal-derived text only, no structured tool events. |
| claude-p | Experimental | `claude-p --output-format json --input-file ...` per turn; final transcript result only, not streaming, no `turn/steer`. |

## Models & turns

| Area | Status | Notes |
| --- | --- | --- |
| Model mapping | Supported | Native Claude aliases pass through; unknown Codex/OpenAI ids fall back to the default model. App model/effort selections are remembered and echoed via `config/read`. |
| Reasoning effort | Best effort | Codex efforts normalized, mappable via `CHA_CLAUDE_EFFORT_ALIASES`; older SDKs may ignore unsupported options. |
| Structured title/summary turns | Supported (fallback) | Codex internal model ids (e.g. gpt-5.4-mini) map to `CHA_CLAUDE_SUMMARY_MODEL` (default haiku) when an outputSchema is present; falls back to schema-shaped JSON if Claude emits plain text. Claude CLI 用 draft-07 严格模式校验输出格式：声明 2019-09 / 2020-12 的模式在交给 CLI 前换成等价写法（去掉 `$schema`，`prefixItems`/`items` 换成 `items`/`additionalItems`，`dependentRequired`/`dependentSchemas` 并入 `dependencies`）；没有等价写法的约束、自定义关键字和其他草案直接让回合报错并说明原因，结果仍按原模式校验（OUTPUT-SCHEMA-001…006）。 |
| SDK option compatibility | Supported | When an older SDK rejects an option, the sidecar drops it one at a time (least essential first) and emits an info notice. |

## Tools, approvals & events

| Area | Status | Notes |
| --- | --- | --- |
| Claude Code tools | Supported | Not restricted by default; set `CHA_CLAUDE_ALLOWED_TOOLS` to restrict. |
| Approval policy / sandbox | Supported | App's approvalPolicy + sandbox persist on the thread and map to Claude permission_mode. "Full access" drops the can_use_tool callback; read-only restricts tools to read/search. |
| Bash approval | Supported | can_use_tool → Codex `item/commandExecution/requestApproval`. Bypassed when approvalPolicy=never / Full access. |
| File edit approval | Supported | Edit/Write/MultiEdit → Codex fileChange items with approval + diff updates. |
| 等待确认时客户端不在 | Supported | 需要用户回答的请求（命令与文件审批、权限请求、提问、回合里的 MCP 征询）跟着线程的订阅连接走，不设超时。线程没有连着的客户端时回合停在那里，线程状态为 `active` 加 `waitingOnApproval` / `waitingOnUserInput`；新连接握手后会收到这些线程的 `thread/status/changed`，订阅线程（`thread/resume` 等）之后请求原样送达，请求 ID 不变。拿着请求的连接断开不使请求失效；订阅换了连接则改送新连接，并向原连接发 `serverRequest/resolved`，原连接的回答不再算数。打断回合、归档线程或适配器退出才使请求失效（等待期间删除、回退线程按“有活动回合”拒绝）；等待期间不受全部连接断开后的保留时间限制，子代理看门狗也不计时。客户端执行的工具调用（`item/tool/call`）没送出时同样等订阅者，送出后不换连接、不重发，所在连接断开按失败结束。不属于任何线程的请求只跟发起它的连接走。标准输入输出上的连接断开即进程退出，请求随之失效。 |
| Bash output | Supported | Forwarded as command output on completion (SDK has no incremental tool-output streaming). |
| Generic Claude tools | Supported | Non-command/file tools → mcpToolCall items under the `claude-code` pseudo server. |
| Subagent (Task) | Supported | Task spawns a child thread and emits native `subAgentActivity` lifecycle events (capability-gated `completed`) plus `spawnAgent`/`wait` tool state. 子代理的正文、思考与工具调用投影为子线程自己的条目，最后一段正文即结果（不再另写一条）；结果取 SDK 的结构化工具结果，不含 CLI 的内部包装文字。子线程跟随父线程的 `ephemeral`（普通会话下为 false，桌面才会把打开之后的更新显示出来）；昵称 `agent-{12hex}` 创建后不变，CLI 的代理 ID 另存，只用于追问寻址。 |
| 后台子代理 | Supported | CLI 默认把子代理放到后台：启动回执不当作结果，主回合照常继续；回合在 CLI 上报会话空闲后才结束，子代理的真实结果在此之前送达父线程与子线程。后台 Bash 不在等待范围内：回合照常结束，命令留在 CLI 进程里继续运行（见 Background terminals）。 |
| 子线程追问 | Supported (中转) | 在已结束的子代理子线程里发消息：适配器恢复父会话，由主模型调用 `SendMessage` 把用户原文转给该子代理（钩子写定收件人与正文，并拒绝其他工具），子代理带着此前的上下文继续，输出显示在子线程，父线程不新增回合。每次追问占用父会话一个隐藏回合；父回合进行中、Workflow 子代理或没有可恢复记录时拒绝（`-32009`），追问进行中父线程不能开新回合，追问回合内的追加输入（`turn/steer`）同样拒绝。被恢复的子代理再派出的子代理不单独显示。 |
| Ephemeral / threadSource | Supported | `ephemeral: true` threads (title-gen, memory-consolidation) persist but are excluded from `thread/list` unless `includeEphemeral: true`. `threadSource` round-trips. |
| 子线程的列表行为 | Supported | 与 Codex 0.157.1 一致：`thread/list` 不指定来源或来源为空时不返回子代理线程；带 `sourceKinds: ["subAgent" \| "subAgentThreadSpawn"]`，或按 `parentThreadId` / `ancestorThreadId` 查且不指定来源时返回。两个关系参数同时给出报 -32600。与原生的差别：关系按 `forkedFromId` 判断，不指定来源时用户分叉出的线程也会返回。 |
| Claude side events | Supported | rate_limit / hook / subagent / compaction events summarized into structured notice lines. |
| Review mode | Supported (text) | `review/start` creates an in-progress review turn and routes the prompt through Claude. No native guardian finding items. |
| Context compaction | Supported (summary) | `thread/compact/start` routes the summary prompt and emits contextCompaction items. No native persisted rollout compaction. |

## Utilities

| Area | Status | Notes |
| --- | --- | --- |
| MCP config/status/tools | Supported | Reads Claude MCP config, passes servers into turns, calls stdio/HTTP tools directly. `mcpServerStatus/list` enumerates real `tools`/`resources`/`resourceTemplates` per server. 服务启动或枚举失败时整个查询返回 `-32001`，不返回空成功；声明了资源能力但没有实现 `resources/templates/list` 的服务按没有模板处理。连接后的启动探测逐个进行，一个服务失败不影响其余服务的状态通知。 |
| Turn-item paging | Supported | `thread/turns/list` honors `itemsView` — `summary` (default: first userMessage + final agentMessage), `full`, and `notLoaded` — instead of always shipping every item. |
| Skills & hooks | Supported | `skills/list` reads `.claude/skills/*/SKILL.md` (user+repo scope); `hooks/list` reads `settings.json` hooks, mapping Claude events to Codex `HookEventName` (unmappable events dropped). |
| Fuzzy file search | Supported | One-shot `fuzzyFileSearch` plus the stateful session API (`sessionStart/Update/Stop`) following Codex 0.157.1: one index per session, `sessionUpdated` then `sessionCompleted` per query, no completion on stop, at most 50 file or directory matches. |
| Git diff to remote | Supported | `gitDiffToRemote` diffs against the closest commit that also exists on a remote (Codex `git-utils` algorithm), including untracked files. |
| Background terminals | Supported | 后台 Bash 跨回合存活：回合结束时还有后台命令在跑，CLI 进程就留下，后面的回合接着用它；命令条目在命令结束前保持 `inProgress`，结束时带原回合的 `turnId` 补发 `item/completed`。`thread/backgroundTerminals/list`、`terminate`、`clean` 在没有回合进行时同样可用。命令自己结束后 CLI 会自行续跑一轮把结果告诉模型，适配器为它建一个没有用户消息的回合；这时用户发来的消息并入该回合。打断回合不停后台命令。线程无人订阅时回合照常执行并落库，状态变化通知所有连接；遇到需要用户确认的调用，回合停在那里等订阅者（见“等待确认时客户端不在”）。改工作目录、MCP、工具或指令配置，以及回退、归档、删除线程会结束进程并停掉后台命令；改模型、推理强度、计划模式不会。同时保留的进程数与全部连接断开后的保留时间可配置。适配器或 CLI 退出、崩溃时后台命令随之清理，不留孤儿进程。`ScheduleWakeup` 与定时任务仍未开放。 |
| Filesystem RPCs | Supported | `fs/readFile`, write, metadata, list, remove, copy, watch/unwatch (Codex v2-shaped). |
| Command/process RPCs | Supported | `command/exec` and `process/spawn` with PTY (`tty`) and piped modes, streaming stdin/stdout/stderr, resize, terminate/write. Semantics follow Codex 0.157.1: 10s default timeout (exit code 124 on timeout), immediate process-group SIGKILL, 1 MiB per-stream cap with `capReached` on the truncating chunk, 2s post-exit drain. PTY runs through the CLI's own `pty-bridge` subcommand, so the packaged runtime must ship the `codex-harness-adapter` binary. |
| 进程诊断 | Supported | `server/diagnostics` 返回当前适配器 PID、RSS 和实际活动回合/已初始化连接计数；physical footprint 无等价测量时返回 null。仅统计当前进程，不包含 CLI 子进程或 Worker 总占用；不会发起模型请求或返回配置、路径、凭据。 |

## Not applicable / unsupported

| Area | Status | Notes |
| --- | --- | --- |
| Realtime audio | Unsupported | No Claude audio channel; methods ack so capability probe doesn't error; listVoices returns empty. 2026-10-08 实测 ChatGPT.app 点击语音聊天会报 `itemsBackwardsCursor` / `turnsBackwardsCursor` 缺失，尚未修复。 |
| Plugins/marketplace/apps | N/A | No Codex plugin marketplace; methods return empty schema-shaped responses. (Claude skills/hooks are surfaced — see Utilities.) |
| Account/rate limits/auth | N/A | Claude manages its own auth; account/OpenAI-auth panels report null/empty. |
| External agent import | Stub | `externalAgentConfig/detect` and import return empty. |
| Windows sandbox | Unsupported | Target deployment is Linux/macOS; methods return not configured. |

## Protocol version

The adapter advertises codex app-server protocol **v2 @ 0.163.0** (via
`codex --version`, the `initialize` userAgent and `runtime/info`; override with
`CHA_CLAUDE_COMPAT_VERSION`). The pinned schema snapshot lives in
`protocol/codex-app-server/0.163.0/`, generated by the official CLI with
`codex app-server generate-json-schema --experimental` and
`generate-ts --experimental`.

0.157.1 → 0.163.0 上游的方法只增不减，类型上有几处删改，对我们的影响：

- 删了 `ModelProviderCapabilitiesReadResponse.namespaceTools`：各入口不再发（严格校验会把它算多出字段）。
- 删了 `PluginSummary.extensions` 和 `PluginEntrypoint`、`PluginExtensions`、`PluginIcon`、`PluginQuickAction`、
  `PluginQuickActionTarget`、`PluginSearchProvider`、`PluginSearchProviderCall`、`PluginSettings` 这几个类型：
  各入口的插件列表本来就是空的，客户端也不读，不受影响。
- `SkillMetadata.path`、`SkillSummary.path` 从 `AbsolutePathBuf` 改成 `LegacyAppPathString`：线上仍是字符串，
  各入口照旧给绝对路径。
- 枚举加宽：`MessagePhase` 多了 `partial_answer`，`CodexErrorInfo` 多了 `flexUnavailable`、`tooManyDenials`
  并放开成任意字符串或对象，`PlanType`、`RealtimeVoice` 加了值。各入口不发这些新值；
  客户端核心对认不出的阶段值和错误类别本来就有兜底。
- 新加的必填字段一个没有；`Turn.rootTurnId` 在生成的 TypeScript 类型里是必填（`string | null`），
  JSON Schema 里可省，客户端代码里构造 `Turn` 时要写上。

新方法与字段的处理：

- `thread/items/list` 的游标可以是回合里的一个条目（`{type: "item", itemId}`），已支持；
  `thread/items/read`（实验性）已支持。
- `thread/attachmentOwner/list` 已支持；`thread/list` 的 `excludedThreadIds` 已支持。
- `mcpServer/oauth/login` 的应答和 `mcpServer/oauthLogin/completed` 带同一个 `loginId`；
  `mcpServerStatus/list` 的 `serverName` 只列那一个服务。
- `thread/readState/update`、`thread/prediction/request`、
  `account/bedrock/checkGovCloudRequirements` 没有对应能力，回 -32601；
  不发 `thread/readState/changed`、`thread/prediction/updated`，读会话不带 `readState(s)`。
- `turn/start` 的 `parentTurnId`、`rootTurnId`，`thread/fork` 的 `experimentalPredictionMode`，
  `thread/goal/set|clear` 的 `origin`、
  工具输出的 `retain` 收下不用；`Turn.rootTurnId`、`subAgentActivity` 的 `model`、
  `reasoningEffort` 是可选字段，不发。

Because the adapter now reports the same version as a real `codex`, it appends a
distinguishing suffix: `codex --version` prints `codex-cli 0.163.0
(codex-harness-adapter)` and the `initialize` userAgent carries `codex-harness-adapter` in its
originator field. The version number stays first so the App's semver probe still
parses it. Set `CHA_CLAUDE_VERSION_SUFFIX=""` to behave exactly like upstream
codex.

## Wire conformance

- `turn/start` response and the `turn/started` / `turn/completed` notifications
  ship `items: []` with `itemsView: "notLoaded"`, matching the real app-server
  (`bespoke_event_handling.rs` clears items; `turn_processor.rs` returns an empty
  turn). The timeline is driven by the `item/*` event stream; loaded items are
  only returned by history reads (`thread/read`, `thread/turns/list`).
- `thread/timeline/list` 从持久化历史返回普通回合边界及完整条目。最新页优先，
  页内升序，`nextCursor` 向更早历史推进；活动回合没有完成边界。
  0.157.1 到 0.163.0 的官方 TS/实际 wire 与 JSON Schema 对回合边界字段命名不一致，
  适配器同时提供同值的驼峰和下划线字段。普通会话的
  `activeRealtimeSessionAtPageStart` 为 `null`，不代表支持实时语音。
- `thread/revert` 按 `beforeTurnId` 删除目标回合及后续历史，通过真实 SDK 分叉
  保留原生上下文，SQLite 事务同时提交会话指针和展示历史。响应不内嵌回合，
  返回可包含最后保留条目的反向分页游标，并发布 `thread/reverted`。
  两种 `historyMode` 共用相同持久化数据，因此旧会话也可使用该入口；
  活动回合和其他线程的目标会被拒绝。回退不会撤销已有文件改动。
  SDK 分叉重新生成 UUID，适配器通过公开快照导出读取真实来源映射；
  回退时将保留回合的新边界与 session 指针一起事务提交，支持连续回退。
- The user message is recorded in turn history but, like the real app-server, is
  not surfaced as a `userMessage` `item/*` event during a turn (including
  `turn/steer`). `review/start`'s response carries the synthesized `userMessage`
  (itemsView `notLoaded`); `enteredReviewMode` arrives via `item/started`.
  Uploaded images are surfaced live as `imageView` `item/*` events.
- MCP boot status uses `mcpServer/startupStatus/updated` with a valid
  `McpServerStartupState`; `mcpServerStatus/list` returns conformant
  `McpServerStatus` objects (`{ name, tools, resources, resourceTemplates,
  authStatus }`).
- Lifecycle turn envelopes carry only schema fields — internal api/cost/turn
  metrics are not serialized onto the wire (token metrics flow through
  `thread/tokenUsage/updated`).
- `turn/plan/updated` is reserved for the `update_plan`/TodoWrite checklist tool
  and ships the spec shape `{ explanation, plan: [{ step, status }] }` (status
  ∈ pending/inProgress/completed); the checklist tool is not also surfaced as a
  timeline item. Plan-mode prose stays on the separate `plan` ThreadItem +
  `item/plan/delta` channel.
  当前 CLI（2.1.286 实测）默认用 Task 系列工具取代 TodoWrite，而 Task 系列不产生
  清单通知；适配器固定设置 `CLAUDE_CODE_ENABLE_TODO_TOOLS=1`、`CLAUDE_CODE_ENABLE_TASKS=0`
  让模型继续使用 TodoWrite，SUBAGENT-003 用真实 CLI 验证清单通知。

## Robustness notes

- `image.fileId` 保留在会话历史中。当前不能解析上游图片内容时，向模型明确传递不可读提示，
  正文及后续回合继续执行；纯文本提取（含 steer/恢复路径）使用同一提示。
  标识不能解释为本地路径或下载 URL。`native-image-reference.test.mts` 用真实 SDK/CLI
  验证提示实际进入模型请求以及重启保留原始附件；这是降级行为，图片下载能力仍未实现。
- `turn/settings/update` 通过 SDK 的 `applyFlagSettings` 实际更新当前回合的模型和 effort，
  不写用户配置或未来回合的线程设置；启动边界等待原生CLI就绪，错配或已结束目标返回
  `targetUnavailable`。TURNSETTINGS-001/002 验证实际模型HTTP参数、其他会话隔离和重启后的默认值。
  按用户的主流程兼容要求，附带的 `summary`、`serviceTier` 偏好在Claude没有对应语义时忽略，
  不阻断有效模型切换；`auto_review` / `guardian_subagent` 降级为用户审批，
  TURNSETTINGS-004验证真实文件写入仍等待人工回答且允许/拒绝均生效。
  非法模型/effort、协议外字段或非法审批角色仍拒绝，整批参数校验后才发布。
- 项目 CRUD、导入、重排与线程归属保存到 SQLite，创建和导入使用唯一幂等键。
  导入失败整体回滚；项目删除只解除归属，保留会话历史和源文件。
  `project/list` 支持位置与最近活动时间双向分页，空项目始终排在最后；
  `thread/list` 支持按项目或未归属筛选，游标绑定查询范围。
  fork 继承项目，临时会话归属不跨进程保存；归档会话不计入项目最近活动时间。
  PROJECT-002/003 使用真实 SDK/CLI 回合、重启及 SQLite 写入失败验证这些语义，
  并验证 `project/changed` 与 `thread/project/updated` 真实通知。
- 附件元数据由 `thread/attachment/add|list|remove` 真实持久化到 SQLite，
  `(threadId, attachmentType, identityKey)` 唯一；重复添加返回原内容，不覆盖 payload。
  仅创建和实际删除推送 `thread/attachment/updated`，分页游标绑定所属会话。
  ATTACHMENT-002 用真实 SDK/CLI 回合验证重启、跨线程及类型隔离、删除边界后继续分页、
  历史和源文件不变、删除会话清理附件；此能力不提供图片上传或 fileId 下载。
- Unix socket paths are validated against the platform `sun_path` limit (~104
  macOS / ~108 Linux); a deep `CODEX_HOME` falls back to a short hashed path
  under the system temp dir.
- git diff / file-listing failures are written to the debug log (distinguishing
  "not a git repository" from real errors) rather than swallowed.
- Per-thread in-memory state (command approvals, elicitation counts)
  is released when a thread is archived.
- 用量快照持久化在 SQLite。恢复会话推送已保存的累计用量，归档不清零，fork 复制后独立累计；
  按位置分叉时，记在被切掉的回合上的用量不带过去，分叉自己跑完一轮后才有用量。
  EVENTS-002 通过真实 SDK 验证多块文本、事件顺序、历史与用量在重启后的一致性。
- 目标记录保存在 SQLite，归档和重启后仍保留；fork 复制独立快照，删除会话同时删除目标。
  部分更新保留未提供字段，显式 null 清除 tokenBudget。GOAL-001/003 验证这些存储语义。
  自动续跑、累计用量及预算停止尚待 GOAL-002 验收，当前不能宣称目标执行功能完整。

## Next targets

1. Parse Claude review text into first-class Codex review finding items.
2. Persist compaction summaries in a dedicated store, not just UI items.
3. Run the capability probe over SSH against a named host.
4. Flesh out plugin/skill/app surfaces if Codex App starts relying on them.
