# src/AGENTS.md

Adapter internals. All files are `.mts` ESM, compiled to `dist/*.mjs`. See the
[root AGENTS.md](../AGENTS.md) for build/test and project-wide conventions.

## Map

- `adapter.mts` — entry point / CLI mode dispatch.
- `server.mts` — Codex app-server protocol layer (the big one; prefer adding new
  surface as helpers and splitting when practical).
- `transports.mts` — stdio / WebSocket / Unix-socket daemon / `proxy`.
- `store.mts` — SQLite thread/turn persistence via `node:sqlite` (Node 24+).
- `types.mts` — shared protocol/runtime types.
- `util.mts` — shared helpers.
- `mcp.mts` — MCP stdio/HTTP tool & resource calls.
- `worktree.mts` — optional per-thread git worktree isolation.

## Runtime backends

Claude backends sit behind the `ClaudeRuntime` interface and are constructed in
`runtime-factory.mts` from `runtime-config.mts`:

- `native-runtime.mts` — default, in-process Claude Agent SDK.
- `http-agent-runtime.mts` — `agent-http` / `agentapi` HTTP/SSE bridges.
- `claude-p-runtime.mts` — one-shot `claude-p` transcript wrapper.
- `codex-proxy-runtime.mts` — native Codex passthrough (`codex exec`).
- `mock-runtime.mts` — credential-free protocol testing (`CHA_CLAUDE_MOCK=1`).

**Adding a backend:** create `<name>-runtime.mts` implementing `ClaudeRuntime`,
register it in `runtime-factory.mts`, and add any env knobs to
`runtime-config.mts`. The PostToolUse hook nudges if runtime code lands
elsewhere.

## Conventions

- Keep the protocol layer (`server.mts`) decoupled from any specific backend —
  it only talks to `ClaudeRuntime`.
- Compatibility-only Codex UI methods should return stable empty/inert
  responses rather than throwing (see the capability matrix in `docs/`).
- **Erasable syntax only**: no `enum`, `namespace`, or constructor parameter
  properties (`constructor(private x: T)`). Declare the field, then assign in the
  body. `tsc` (with `erasableSyntaxOnly`) and the PostToolUse hook both flag
  violations.
- **回合用的设置一次读齐**：一个回合用的审批策略、权限模式、沙箱策略、计划模式，要在回合开始、第一次
  `await` 之前一次读齐（`runRuntimeTurn` 开头的 `turnSettings`）。`turn/started` 发出之后客户端随时会改
  会话设置，等完再读会读到另一档，几样凑不到一起（工作区档配上没有可写目录的完全访问策略，写文件全被当成越界）。
- 本机别处（命令行、Claude 桌面端）开的 Claude Code 会话也进会话列表（`native-sessions.mts`，历史怎么画在 `native-history.mts`）：列表时用 SDK 的 `listSessions({ includeProgrammatic: false })` 扫一遍、登记进库（会话号就是原生会话号），历史在读、恢复、发消息之前才画，原生记录变了接着最后一个回合的边界往后画，边界对不上整份重画。库里的 `native_sessions` 记着每个原生会话号是怎么来的（适配器自己用过的、导进来的、导进来又删掉的），这几种都不再导；适配器自己的会话换原生会话号（`upsertThread`、`updateClaudeSessionId`）时自动记上。工具调用画成哪种条目只有一份（`tool-items.mts`），实时回合和读历史共用。有连接时每 30 秒再扫一次，头一遍之后扫到的新会话发 `thread/started`。Claude 桌面端派出的会话带 `litchNativeLineage`（扩展 nativeLineage）：是不是派出来的看原生记录开头（`native-lineage.mts`，认一次记进库）；父会话读桌面端自己的数据目录（`desktop-lineage.mts`，`claude-code-sessions/*/*/local_*.json` 的 `spawnedFrom`、`cliSessionId`），只读、跟着每次扫描重算、只放内存，读不到、格式不对就是没有父会话，绝不报错；父会话变了给声明了的连接再发一次 `thread/started`。`CHA_CLAUDE_DESKTOP_DATA` 指定桌面端数据目录（测试、夹具用），给 `0` 不读。`CHA_CLAUDE_NATIVE_SESSIONS=0` 关掉。测试里主目录是空的，什么都列不出来；要测就像 `native-sessions.test.mts` 那样先设 `CLAUDE_CONFIG_DIR` 再引入服务的模块（SDK 装载时就定下了目录）。
