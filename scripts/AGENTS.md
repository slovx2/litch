# scripts/AGENTS.md

Operational scripts. See the [root AGENTS.md](../AGENTS.md) for build/test and
project-wide conventions. These run on Node directly (no build step) and ship as
plain `.mjs` / shell.

## Map

- `codex-shim` — the `PATH` shim Codex App invokes. Routes `codex app-server`
  into the adapter (`CHA_CLAUDE_ADAPTER`); forwards everything else to the real
  Codex CLI (`CODEX_REAL`). Keep it dependency-free and POSIX-sh portable.
- `codex-harness-adapter-mode` — host helper to switch runtime backends, restart bridges,
  and read status/logs. Writes `~/.codex-harness-adapter/runtime.env`.
- `hooks/guard.mjs` — Claude Code hook enforcing project conventions (blocks
  build-artifact edits; warns on non-`.mts` src, misplaced runtime code, and
  files > ~1000 lines). Wired in `.claude/settings.json`. Must exit 0 on any
  internal error so it never wedges a session.
- `doctor.mjs` — environment self-check (`npm run doctor`).
- `smoke-real-claude.mjs` — round-trips a real Claude turn (`npm run smoke:real`).
- `acceptance-*.mjs` — end-to-end checks (local-remote, gui-ssh-localhost,
  ssh-runtime-matrix); transcripts land under git-ignored `.codex-harness-adapter/`.
- `probe-*.mjs` — capability / codex-cli-remote probes.
- `dsh-poc-serve.mjs` — isolated DeepSeek Harness entry (workspace CLI, loopback
  mock model, own state dir and port, loopback-only sandbox). `--verify` runs the
  protocol-level check over real SSH (`npm run test:dsh-ssh`); `--gui` keeps it up
  for the desktop app. Needs a user-installed `dsh` (`CHA_DSH_CLI` or `PATH`).
  `dsh-poc-diagnostics.mjs` is a test-only dsh plugin it mounts through the
  instance's `DSH_HOME/cordis.patch.yml`: dsh's own warn/error lines (which the web
  profile otherwise keeps in memory only), the fate of each session-title request
  and every model `fetch` (with the full cause chain when it fails — dsh itself
  reduces it to a message and a code) go to stderr, i.e. the instance's
  `runtime.log`; a missing title quotes them.

- `bench-router.mjs` (+ `bench-router-model.mjs`, its mock model in a worker
  thread) — measures what the device process's routing layer adds in latency and
  CPU: the same isolated Pi entry is driven directly and through the aggregation
  socket (`npm run bench:router`). Manual only, not part of CI; read the load
  averages it prints before trusting latency numbers.
- `bench-delta.mjs` (+ `bench-delta-model.mjs`, its mock model in a worker
  thread) — measures how the Pi entry's cost per streamed delta grows with the
  length of the answer (`npm run bench:delta`): the same kind of delta (answer
  text, thinking, or the arguments of a `write` tool call) at several counts and
  sizes, CPU time of the runtime process per delta. A flat "per delta" column
  means linear; a rising one means something is redoing work proportional to
  what has already streamed. `--cpu-prof <dir>` runs the runtime under Node's
  sampling profiler; `bench-delta-hot.mjs <dir>` turns the result into tables
  (who owns the time, hottest functions, adapter functions with their callees).
  `--engine <file>` points it at another build for a before/after comparison.
  Manual only, not part of CI.
- `bench-delta-claude.mjs` (+ `bench-delta-claude-model.mjs`) — the same
  measurement for the Claude entry (`npm run bench:delta -- --entry claude`;
  `bench-delta.mjs` hands over to it, options are the same). The real Claude
  Code CLI sits between the mock model (Anthropic Messages SSE) and the entry,
  so it needs `CHA_CLAUDE_CLI` pointing at an isolated CLI (it never falls back
  to the `claude` on `PATH`) and reports three processes separately: the entry,
  the process guard that relays the CLI's stdio, and the CLI itself, each from
  the moment the model starts streaming to the end of the turn. Same
  `--cpu-prof` / `bench-delta-hot.mjs` workflow. Manual only, not part of CI.
- `build-cli.mjs` — builds the Go CLI into `bin/`. Fails loudly when `go` is
  missing (it does not skip): engine and device tests need the CLI for the
  pty bridge.
- `adapter-stage.mjs` — stages the adapter tree (Go CLI, official Node, engine
  packages with runtime deps only; there is no `scripts/` directory in the
  staged tree any more). Runs a pty-bridge self-check on the staged CLI. Shared by the desktop app
  (`apps/desktop/scripts/stage-adapter.mjs`) and the standalone release.
  Audits the result: no foreign-platform binaries, no harness CLIs.
- `package-adapter.mjs` — builds the standalone release archives
  (`npm run package:adapter`), the checksum list and a copy of `install.sh`.
  Writes the tar itself so entries are deterministic across hosts.
- `adapter-launcher.sh` — entry point inside the standalone release; resolves
  its real location and passes every argument through unchanged. The CLI picks
  the bundled Node by itself when `--node` is not given. POSIX sh, no PATH
  changes.
- `install.sh` — user-facing installer/upgrader/uninstaller for the standalone
  release. POSIX sh; must pass `sh -n` and shellcheck. Never stops a running
  service. Messages are bilingual (`say 中文 English`).
- `check-adapter-package.mjs` (+ `-guest.mjs`) — container verification of the
  release (`npm run check:adapter-package`, needs Docker; skipped without it).

## Conventions

- Shell scripts: no Bash-only features in `codex-shim` (it runs under the remote
  login shell). Keep it side-effect free except routing.
- `.mjs` scripts read no build output unless they `npm run build` first (the
  acceptance/smoke scripts do via their npm wrappers).
- When adding a hook, branch on `hook_event_name`, read JSON from stdin, and
  fail open (exit 0) on error.
- `.mjs` scripts are Biome-formatted (`npm run format` covers `scripts/`); the
  shell scripts (`codex-shim`, `codex-harness-adapter-mode`) are left untouched.
