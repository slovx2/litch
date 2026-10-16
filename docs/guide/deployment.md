# Deployment（远程主机 shim，高级）

::: tip 大多数场景不需要本页
本机使用请按[开始使用](/guide/getting-started)运行 `npm start` 或 Homebrew 后台服务，自带仅监听本机的 SSH 入口，
不需要系统 sshd、`codex` shim 或修改 `~/.zshenv`。本页只适用于让 Codex App 通过系统 SSH 连接远程主机、并由 shim 接管 `codex` 的旧部署方式，目前仅支持 Claude。
:::

The deployment target is a remote SSH host with a `codex` shim earlier in the
login-shell `PATH`.

## Install the shim

Install `scripts/codex-shim` as `codex` on the remote host:

```bash
mkdir -p ~/bin
cp scripts/codex-shim ~/bin/codex && chmod +x ~/bin/codex
```

Then have the login shell export the adapter pointers. Put these in `~/.zshenv`
so non-interactive SSH sees them too:

```bash
export PATH="$HOME/bin:$PATH"
export ANTHROPIC_API_KEY="<your-anthropic-api-key>" # or sign in with `claude /login`
export CHA_CLAUDE_ADAPTER="/opt/codex-harness-adapter/packages/claude/dist/claude/src/adapter.mjs"
export CHA_CLAUDE_NODE="/absolute/path/to/node" # optional
export CODEX_REAL="/usr/local/bin/codex.real"     # optional native-Codex fallback
```

Keep credentials in the host environment or a secret manager. Do not commit
real API keys, OAuth/session state, `.env` files, copied shell snippets with
resolved secrets, or private infrastructure URLs.

Codex App keeps using its native SSH flow: it probes `codex --version`, starts
`codex app-server --listen unix://`, then connects via `codex app-server proxy`.
The shim routes only those app-server calls to the adapter.

::: tip Custom Anthropic endpoints
If your organization uses a supported custom Anthropic endpoint, configure
`ANTHROPIC_BASE_URL` in the host environment. Treat the endpoint value as
deployment configuration and avoid committing private URLs.
:::

## Bootstrapping a fresh host (no sudo / Homebrew)

A clean machine usually needs only four user-space tools:

```bash
# 1. Node 24 — pick your platform tarball from nodejs.org/dist/latest-v24.x.
curl -fsSL https://nodejs.org/dist/latest-v24.x/node-<version>-darwin-arm64.tar.xz | tar -xJ -C ~/.local

# 2. Claude Code CLI under a user prefix.
mkdir -p ~/.local/npm-global
~/.local/node-<version>-darwin-arm64/bin/npm config set prefix ~/.local/npm-global
~/.local/npm-global/bin/npm install -g @anthropic-ai/claude-code
~/.local/npm-global/bin/claude /login        # interactive: claude.ai OAuth

# 3. Adapter checkout + build.
git clone https://github.com/slovx2/litch ~/codex-harness-adapter && cd ~/codex-harness-adapter
npm install && npm run build

# 4. Persist PATH + adapter pointers for non-interactive SSH.
cat >>~/.zshenv <<'EOF'
export PATH="$HOME/.local/npm-global/bin:$HOME/.local/node-<version>-darwin-arm64/bin:$HOME/.local/bin:$PATH"
export CHA_CLAUDE_ADAPTER="$HOME/codex-harness-adapter/packages/claude/dist/claude/src/adapter.mjs"
export CHA_CLAUDE_NODE="$HOME/.local/node-<version>-darwin-arm64/bin/node"
EOF
cp scripts/codex-shim ~/.local/bin/codex && chmod +x ~/.local/bin/codex

npm run doctor       # all checks should be ok
npm run smoke:real   # round-trips a real Claude turn
```

Codex App's Remote connection then hits the shim first and is routed into the
adapter. Disconnecting reclaims the daemon so the adapter exits.

## Daemon lifecycle

The daemon owns the Unix socket while a client is connected. When the last
client disconnects it shuts down after an idle grace period (deferred if a turn
is still active; reconnecting during that window reattaches notifications). Tune
with `CHA_CLAUDE_IDLE_EXIT_MS` (default `15000`; `0` keeps it running).

## Quick remote probe

```bash
ssh host 'command -v codex'
ssh host 'codex --version'
```
