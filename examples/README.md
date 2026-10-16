# Examples

These examples show safe local setup patterns. They intentionally use
placeholders and do not include real credentials.

本机的 `npm start` 或 Homebrew 后台服务不需要下面的 shim 与 shell 导出：变量写入
`~/.codex-harness-adapter/env`（见 [Configuration](../docs/guide/configuration.md#环境文件)）。
以下示例只适用于[远程主机 shim 部署](../docs/guide/deployment.md)。

## Local shell exports

Use your shell, a local secret manager, or your deployment system to inject
credentials at runtime. Do not commit `.env` files or resolved secrets.

```bash
export CHA_CLAUDE_ADAPTER="$PWD/packages/claude/dist/claude/src/adapter.mjs"
export CHA_CLAUDE_NODE="/absolute/path/to/node-24"

# Choose one authentication method managed by your own environment.
export ANTHROPIC_API_KEY="<your-anthropic-api-key>"
# or authenticate interactively on the host:
# claude /login
```

## Remote shim setup

```bash
mkdir -p "$HOME/bin"
cp scripts/codex-shim "$HOME/bin/codex"
chmod +x "$HOME/bin/codex"
export PATH="$HOME/bin:$PATH"
```

After building the adapter, point `CHA_CLAUDE_ADAPTER` at the compiled entry
point on that host:

```bash
npm install
npm run build
export CHA_CLAUDE_ADAPTER="$PWD/packages/claude/dist/claude/src/adapter.mjs"
```

## Protocol-only local test

Use the mock runtime when you want to test the app-server protocol without live
Claude credentials:

```bash
CHA_CLAUDE_MOCK=1 node packages/claude/dist/claude/src/adapter.mjs app-server --listen ws://127.0.0.1:8788
```

See [../docs/guide/getting-started.md](../docs/guide/getting-started.md) and
[../docs/guide/deployment.md](../docs/guide/deployment.md) for the full setup
guide.
