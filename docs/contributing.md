# Contributing

## Toolchain

本机环境最低要求为 Node.js 24、Go 1.26.6（源码构建）、Claude Code CLI 2.1.282、Pi CLI 0.99.1；接受更高稳定版，不要求安装精确版本。仓库 SDK、插件依赖与 CI 验证基线继续锁定，见 `protocol/versions.json`。

Pi 本体不随适配器分发：`packages/pi` 只把它列为开发依赖，用于类型和测试基线，运行时加载用户安装的 Pi。测试默认使用这份基线，设置 `PI_CLI` 可改测本机安装的版本，例如 `PI_CLI=$(command -v pi) npm test --prefix packages/pi`。

DeepSeek Harness 同样不随适配器分发，`packages/dsh` 也不把它列为依赖，所以 dsh 入口的测试不在 `npm test` 里，需要本机有一份 dsh：`CHA_DSH_CLI=<dsh 路径> npm run test:dsh`（包级测试，回环 mock 模型）和 `npm run test:dsh-ssh`（隔离实例经真实 SSH，仅 macOS）；`PATH` 里有 `dsh` 时可省略变量。CI 的 `dsh` 任务按 `protocol/versions.json` 的 `dshMinimum` 把 dsh 装到临时前缀后运行这两条。

| Tool | Role | Command |
| --- | --- | --- |
| [tsx](https://tsx.is) | Run `.mts` sources directly (dev loop) | `npm run dev` |
| [tsc](https://www.typescriptlang.org) | Type-check + emit `dist/*.mjs` | `npm run build` / `npm run typecheck` |
| [Biome](https://biomejs.dev) | Format + lint | `npm run check` / `npm run check:fix` |
| `node --test` | Unit tests | `npm test` |
| [VitePress](https://vitepress.dev) | This docs site | `npm run docs:dev` |

```bash
npm run setup       # 安装锁定依赖并构建两个适配器与本地 CLI
npm start           # 自动检测并启动可用引擎；也可加 -- --harness pi
npm run dev          # tsx src/adapter.mts — run sources directly, no build
npm run build        # tsc -> dist/ (production artifact)
npm run typecheck    # tsc --noEmit
npm run check        # biome format + lint (read-only)
npm run check:fix    # biome auto-fix
npm test             # build + node --test packages/claude/dist/claude/test/*.mjs
```

## Conventions

- **ESM only**: `.mts` sources under `src/` compile to `.mjs` under `dist/`.
  Relative imports use the `.mjs` extension (NodeNext).
- **Erasable syntax only** (`erasableSyntaxOnly`): no `enum`, `namespace`, or
  constructor parameter properties. Declare fields explicitly and assign in the
  constructor body. This keeps `tsx` and Node 24 native type stripping working —
  on Node 24 you can run `node src/adapter.mts` directly.
- **Never hand-edit `dist/` or `generated/`** — they are produced by
  `npm run build` and `npm run generate:schema`.
- Formatting: 2-space, single quotes, no semicolons, lineWidth 100 (Biome).
  Run `npm run check:fix` before committing.
- New Claude backends go in a `*-runtime.mts` module wired through
  `runtime-factory.mts` (the `ClaudeRuntime` interface).

## Why `.mts` / `.mjs`?

The adapter is launched directly with `node packages/claude/dist/claude/src/adapter.mjs` on remote
hosts. Compiling `.mts` → `.mjs` makes every file unambiguously ESM at the file
level (Node always treats `.mjs` as ESM, regardless of any `package.json`), so
the deployed artifact needs only `node` — no TS toolchain, no dependence on a
`type: module` lookup in `dist/`.

## Project layout

- `src/adapter.mts` — entry point / CLI mode dispatch.
- `src/server.mts` — Codex app-server protocol layer.
- `src/transports.mts` — stdio / WebSocket / Unix-socket daemon / proxy.
- `src/store.mts` — SQLite thread/turn persistence (`node:sqlite`).
- `src/*-runtime.mts` + `runtime-factory.mts` — pluggable Claude backends.
- `scripts/codex-shim` — the `PATH` shim Codex App invokes.
- `scripts/codex-harness-adapter-mode` — host helper to switch backends.
- `test/` — `node:test` suites against `dist/`.

The repo also ships progressive `AGENTS.md` files (root + `src/` + `scripts/` +
`test/`) for AI agents working in the codebase, plus a Claude Code guard hook in
`scripts/hooks/guard.mjs`.

## Docs site

This site is built with VitePress from `docs/`:

```bash
npm run docs:dev       # local preview with hot reload
npm run docs:build     # static build -> docs/.vitepress/dist
npm run docs:preview   # serve the built site
```

It deploys to GitHub Pages automatically on push to `main` via
`.github/workflows/deploy-docs.yml`.
