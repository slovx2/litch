# Harnesses

## The supported harnesses

| Id | Name | Notes |
|---|---|---|
| `claude-code` | Claude Code | Needs the standalone `claude` CLI, signed in. Also lists Claude Code sessions started elsewhere on the machine |
| `codex` | Codex | The native Codex CLI (`codex app-server`). Uses the user's own Codex data (`~/.codex`, or `CODEX_HOME`); only one codex process should write a given session at a time. Not available on Windows devices yet |
| `pi` | Pi | Installed with npm (`@earendil-works/pi-coding-agent`) |
| `dsh` | DSH (DeepSeek Harness) | Experimental |
| `opencode` | OpenCode | Experimental; uses the user's `opencode` |
| `gemini` | Gemini CLI | Over ACP; off by default |
| `qwen` | Qwen Code | Over ACP; off by default |
| `acp` | ACP | Any agent that speaks the Agent Client Protocol; off by default, needs its command in `harness.acp.cliPath` |

Litch never bundles a harness. Each device uses what is installed on it. Feature support differs: ACP
sessions cannot start sub-sessions and do not get the browser, Computer Use or "operate this computer"
tools; plan mode exists only where the harness supports it.

## Seeing what is there

- `scripts/litch harness list <device>` shows every harness on the device: enabled or not, ready or
  unavailable with the reason, and the version when known.

## Installing and updating (a system task, not a Litch command)

Installing or upgrading a harness is done with the harness's own official installer, in a shell, as the
user. Litch has no command for it. Do it yourself with the user's OK, or give the user the command:

| Harness | Official install (pin a version where shown) | Litch verified | Minimum | Docs |
|---|---|---|---|---|
| Claude Code | `curl -fsSL https://claude.ai/install.sh \| bash -s 2.1.282` (Windows PowerShell: `irm https://claude.ai/install.ps1 \| iex`) | 2.1.282 | 2.1.282 | https://code.claude.com/docs/en/setup |
| Codex | `npm install -g @openai/codex@0.160.0` | 0.160.0 | 0.157.1 | https://github.com/openai/codex |
| Pi | `npm install -g @earendil-works/pi-coding-agent@0.99.1` | 0.99.1 | 0.99.1 | https://github.com/earendil-works/pi |
| DSH | `npm install -g @deepseek-ai/dsh@0.2.0-rc.2` | 0.2.0-rc.2 | 0.2.0-rc.2 | https://www.npmjs.com/package/@deepseek-ai/dsh |
| OpenCode | `curl -fsSL https://opencode.ai/install \| bash -s -- --version 1.18.33` (Windows: `npm install -g opencode-ai@1.18.33`) | 1.18.33 | 1.18.0 | https://opencode.ai/docs |
| Gemini CLI | `npm install -g @google/gemini-cli` | none | none | https://github.com/google-gemini/gemini-cli |
| Qwen Code | `npm install -g @qwen-code/qwen-code` | none | none | https://github.com/QwenLM/qwen-code |

- Prefer the verified version. Newer versions usually work too; Litch only needs the minimum and never
  requires an exact version. For the latest, drop the version (`@latest`, or no argument to the
  scripts). Gemini CLI and Qwen Code have not been verified by Litch.
- Never use sudo. If npm's global folder is not writable, tell the user (they can set an npm prefix in
  their home, or use a Node version manager); do not change system folders.
- npm must be the one on the user's login `PATH`, the same one the harness will be found with.
- For a remote device the command has to run on that machine: in a terminal there, or, with the user's
  OK, `ssh <alias> '<command>'` from here.
- Afterwards make Litch pick it up: `scripts/litch harness restart <device> <id>` (it re-detects the
  command; the Devices page has the same as the harness's Restart button). If the harness was disabled,
  `scripts/litch harness enable <device> <id>`.

**Signing in, API keys, providers and the harness's own settings** live on the Devices page: each
harness row has a **Settings** button (详情设置) that opens four tabs, all reading and writing the
harness's own config files on that device (shared with its CLI there):

- **Config**: default model and effort, permissions, and the rest of what the harness's official app
  offers (Codex: approval, sandbox, web search, features, skills/plugins/hooks, memories; Claude Code:
  `~/.claude/settings.json`; OpenCode, Pi, DSH: their own settings). Some changes say they need a new
  session or a restart; the page offers the restart.
- **Accounts**: sign in (browser, device code, or pasting a code back), set an API key, add custom
  providers, switch the active provider. Codex can stay signed in to ChatGPT while using an API-key
  provider. OAuth credentials stay in the harness's own store; keys the harness only reads from
  environment variables are kept in that harness's environment on the device (secret).
- **MCP**: the harness's user-level MCP servers.
- **Instructions**: the user-level `AGENTS.md` (Claude Code: `CLAUDE.md`). **Unified mode** writes one
  copy and turns the other harnesses' files into symlinks to it (old files are backed up beside them).

Guide the user there; signing in needs the user in a browser. If the user hands you an API key, you may
still store it in that harness's environment on that device:
`scripts/litch settings set <device> harness.<id>.env=…` (value syntax: `scripts/litch settings --help`).

## Enabling, disabling, restarting

- `scripts/litch harness enable <device> <id>` / `scripts/litch harness disable <device> <id>` turn a
  harness on or off on that device (the `harness.<id>.enabled` setting). Disabling stops its runtime;
  its sessions stay on disk and come back when re-enabled. Disabled harnesses disappear from the
  new-session page.
- `scripts/litch harness restart <device> <id>` restarts one harness and re-detects its command (use it
  after the user installed or upgraded the CLI by hand, or changed its login).

Enabling, disabling, restarting, and changing a harness's CLI path or environment interrupt turns
running in that harness on that device. Check `scripts/litch status` first and warn the user.

## "Not installed" or "Unavailable"

1. Is it installed for the user's login shell? Run its version command in a login shell on that device
   (`claude --version`, `codex --version`, …); `scripts/litch harness list <device>` shows Litch's view.
2. Installed somewhere unusual: set its command explicitly,
   `scripts/litch settings set <device> harness.<id>.cliPath=/absolute/path/to/cli`.
3. Too old: install the verified or a newer version as above, then restart it.
4. Starts but fails: read `scripts/litch diagnose logs <device>` for that harness
   (`troubleshooting.md`), most often a sign-in or model problem in the harness itself.
5. Gemini CLI, Qwen Code and ACP are off by default: enable them first.
