# Contributing

Thanks for helping improve Codex Harness Adapter. This root guide is the GitHub
entry point; the full contributor guide lives in [docs/contributing.md](docs/contributing.md).

## Before you start

- 本机工具只要求最低稳定版本：Node.js 24（>= 24.0.0）、Go >= 1.26.6；Claude Code CLI >= 2.1.282、Pi CLI >= 0.99.1。允许更高稳定版，不要求用户安装精确版本或降级。
- SDK/插件的仓库依赖仍按精确版本锁定，CI 使用 `protocol/versions.json` 的基线复现；环境版本范围与依赖锁是不同约束。
- 使用 `npm run setup` 安装锁定依赖并构建，`npm start` 自动检测并启动可用引擎；缺失或失败入口只告警，`--harness` 可指定单引擎。
- Keep changes small and reviewable. Separate runtime/protocol work, docs work,
  dependency updates, and release planning into different pull requests.
- Do not commit secrets, local Claude Code session files, OAuth data, API keys,
  `.env` files, or acceptance-test transcripts.

## Development checks

Run the checks that match your change:

```bash
npm run typecheck
npm run check
npm test
npm run docs:build
```

For runtime or protocol changes, include focused tests under `test/` and run the
full `npm test` suite. For docs-only changes, run `npm run docs:build` and note
whether any link-checking gap remains.

## Project layout

- `packages/claude`、`packages/pi` 是并列的引擎适配器。
- `packages/shared` 提供共享协议、传输和版本检测。
- `cmd/codex-harness-adapter` 提供本机启动器，`sshserver` 提供通用 SSH 库。
- `scripts/codex-shim` is the remote `codex` PATH shim.
- `docs/` is the VitePress documentation site.
- 各适配器的 `test/` 包含针对其编译输出的 `node:test` 测试。

## Pull request expectations

- Keep each PR focused on one behavior or documentation topic.
- Include a clear test plan in the PR description.
- Add or update tests for code changes.
- Avoid broad formatting churn unless the PR is explicitly a formatting/tooling
  change.

See [docs/contributing.md](docs/contributing.md) for the detailed toolchain and
coding conventions.
