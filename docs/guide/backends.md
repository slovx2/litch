# Backends

The adapter's internal Codex protocol layer talks to a small `ClaudeRuntime`
interface, so non-SDK Claude Code bridges can be selected without removing the
default Agent SDK route.

| Backend | Status | Streaming | Approvals / diffs |
| --- | --- | --- | --- |
| `agent-sdk-sidecar` (default) | Stable | Full (text, reasoning, tools) | Yes |
| `agent-http` / Channels | Experimental | Message-level deltas | No |
| `agentapi` | Experimental | Terminal-derived text | No |
| `claude-p` | Experimental | None (one-shot) | No |
| `codex` (native passthrough) | Stable | Native Codex | Native Codex |

## Switching routes

::: tip 本地 SSH 入口
`npm start` 或 Homebrew 后台服务不读取 `runtime.env`，也不经过 shim：在[环境文件](/guide/configuration#环境文件)中设置
`CHA_CLAUDE_RUNTIME_TYPE` 并重启即可切换（`codex` 直通除外）。下面的 `codex-harness-adapter-mode` 只用于[远程主机 shim 部署](/guide/deployment)。
:::

Install the host helper next to the shim:

```bash
install -m 0755 scripts/codex-harness-adapter-mode ~/.local/bin/codex-harness-adapter-mode
```

It rewrites `~/.codex-harness-adapter/runtime.env`, prepares the matching bridge daemon
(`agent-http` / `agentapi`), stops the current app-server so Codex App reconnects
into the new route, and provides readback commands:

```bash
codex-harness-adapter-mode list                 # selectable modes; current marked *
codex-harness-adapter-mode set agent-http opus  # switch route, restart bridge with Opus
codex-harness-adapter-mode model opus           # keep route; update default/bridge model
codex-harness-adapter-mode status               # mode, bridge health, recent logs
codex-harness-adapter-mode logs adapter|agent-http|agentapi
```

::: warning Model switching
Model switching is exact per turn for the SDK runtime and `claude-p` (the adapter
passes `model` directly). For `agent-http` / `agentapi` the bridge talks to a
long-lived Claude Code session, so changing the model means restarting that
bridge (`codex-harness-adapter-mode model <alias>`).
:::

::: warning Native codex passthrough
In `CHA_CLAUDE_RUNTIME_TYPE=codex` the shim launches the real Codex
app-server, so the adapter is not in the process and cannot switch back from
in-App controls. Use `codex-harness-adapter-mode set codex` / `set agent-sdk-sidecar` on
the host and reconnect.
:::

## agent-http / Channels

Loads the bridge from `$CHA_CLAUDE_AGENT_HTTP_DIR` (or `~/agent-http`) but
launches Claude Code from the thread cwd. Uses `POST /message`, `GET /messages`,
`GET /status`, `GET /events`; streams message-level deltas only (no semantic
tool / thinking / permission events).

```bash
codex-harness-adapter-mode set agent-http opus
```

## agentapi

Runs `agentapi server --type=claude` from the thread cwd and maps final agent
text into Codex messages. No rich approval / file-change events (terminal-derived
text only). Run `codex-harness-adapter-mode trust` if Claude's workspace-trust prompt
appears.

```bash
codex-harness-adapter-mode set agentapi opus
```

## claude-p

Runs `claude-p --output-format json --input-file ...` per turn and emits the
final assistant text. Not streaming, no `turn/steer`; defaults to one-shot turns
(some `claude-p` builds replay results when combining `--resume` with
`--input-file`).

```bash
export CHA_CLAUDE_RUNTIME_TYPE="claude-p"
export CHA_CLAUDE_CLAUDE_P_COMMAND="claude-p"
# export CHA_CLAUDE_CLAUDE_P_RESUME=1   # only after verifying --resume + --input-file
```
