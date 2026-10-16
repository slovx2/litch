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
