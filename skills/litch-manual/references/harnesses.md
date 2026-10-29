# Harnesses

## The supported harnesses

| Id | Name | Notes |
|---|---|---|
| `claude-code` | Claude Code | Needs the standalone `claude` CLI, signed in. Also lists Claude Code sessions started elsewhere on the machine |
| `codex` | Codex | The native Codex CLI (`codex app-server`). Uses the user's own Codex data (`~/.codex`, or `CODEX_HOME`); only one codex process should write a given session at a time |
| `pi` | Pi | Installed with npm (`@earendil-works/pi-coding-agent`) |
| `dsh` | DSH (DeepSeek Harness) | Experimental |
| `opencode` | OpenCode | Experimental; uses the user's `opencode` |
| `gemini` | Gemini CLI | Over ACP; off by default |
| `qwen` | Qwen Code | Over ACP; off by default |
| `acp` | ACP | Any agent that speaks the Agent Client Protocol; off by default, needs its command in `harness.acp.cliPath` |

Litch never bundles a harness. Each device uses what is installed on it. Feature support differs: plan
mode exists only where the harness supports it.

## Seeing what is there

桌面与手机的设备详情中，正在运行的 harness 会显示当前 CLI 入口、启动时版本、选择来源和
启动时间。来源为命令行路径设置、环境变量、PATH 查找或默认安装位置；这不改变现有选择顺序。
入口可能是包装脚本。修改路径设置后，旧进程的信息保留到实际重启；未运行时不把新设置冒充当前入口。

- `scripts/litch harness list <device>` shows every harness on the device: enabled or not, ready or
  unavailable with the reason, and the version when known.

## Installing and updating (a system task, not a Litch command)

Installing or upgrading a harness is done with the harness's own official installer, in a shell, as the
user. Litch has no command for it. Do it yourself with the user's OK, or give the user the command:

| Harness | Official install (pin a version where shown) | Litch verified | Minimum | Docs |
|---|---|---|---|---|
| Claude Code | `curl -fsSL https://claude.ai/install.sh \| bash -s 2.1.282` (Windows PowerShell: `irm https://claude.ai/install.ps1 \| iex`) | 2.1.282 | 2.1.282 | https://code.claude.com/docs/en/setup |
| Codex | `npm install -g @openai/codex@0.163.0` | 0.163.0 | 0.157.1 | https://github.com/openai/codex |
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
  Litch's own install and update buttons also check npm's global folder (`npm prefix -g`): if the new
  copy is not on `PATH`, or an older copy from another Node installation comes first, Litch uses the
  new one and writes it into `harness.<id>.cliPath` (the install log says so).
- For a remote device the command has to run on that machine: in a terminal there, or, with the user's
  OK, `ssh <alias> '<command>'` from here.
- Afterwards make Litch pick it up: `scripts/litch harness restart <device> <id>` (it re-detects the
  command; the Devices page has the same as the harness's Restart button). If the harness was disabled,
  `scripts/litch harness enable <device> <id>`.

**Signing in, API keys, providers and the harness's own settings** live on the Devices page: each
harness row has a **Settings** button (详情设置) that opens these tabs, all reading and writing the
harness's own config files on that device (shared with its CLI there):

- **Config**: default model and effort, permissions, and the rest of what the harness's official app
  offers (Codex: approval, sandbox, web search, features, skills/plugins/hooks, memories; Claude Code:
  `~/.claude/settings.json`, including models, context window, telemetry and OpenTelemetry export;
  OpenCode, Pi, DSH: their own settings). Codex also has a global context window and auto-compact
  limit that apply to every model. Some changes say they need a new session or a restart; the page
  offers the restart. Codex's Config tab also has **Name sessions automatically** (on by default; it is
  Litch's own switch, kept on the device, not in Codex's config file): after the first turn of a
  session started in Litch, Litch names it with a small model of the luna family, only if the account's
  model list has one, and never over a name the user set. Turning it off affects sessions started
  afterwards. DSH's Config tab lists its built-in plugins; the ones DSH cannot run without are locked
  on (turning them off broke turns, restarts or this page), and one that is already off can be turned
  back on (it says so). Turning off any other removes what it provides.
- **Accounts**: sign in (browser, device code, or pasting a code back), set an API key, add custom
  providers, switch the active provider. Codex can stay signed in to ChatGPT while using an API-key
  provider. OAuth credentials stay in the harness's own store; keys the harness only reads from
  environment variables are kept in that harness's environment on the device (secret).
  Claude Code has no active provider: the one account (Claude subscription, Console, or a
  `claude setup-token` long-lived token) and any number of providers the user adds (Anthropic API keys,
  Anthropic-compatible gateways with a hand-written or fetched model list) all appear in the model
  picker as `[Provider] model` once more than one is usable. Each session runs on the provider of its
  model and can switch at the next turn (the composer says so under the input); new sessions start
  with the last model picked. Editing a gateway offers "Fetch models from provider" to tick models
  from its `/v1/models` into the list. Keys and extra headers of added
  providers are stored by Litch on the device (not in `~/.claude`), shown only by their last four
  characters. Moving a provider to another host or changing its key header requires entering the key
  again. A session whose provider was removed fails with an error instead of moving to another
  provider. Credentials or a gateway configured in Claude Code's own `settings.json` or environment
  show as a read-only "Claude Code" provider.
- **Models** (Codex only): a custom model list that replaces Codex's built-in catalog in its model
  picker. Each entry either uses a built-in model as is, or is based on one with a new model name,
  display name or context window (everything else is copied from the base). Models not in the list
  disappear from the picker; "restore" goes back to the built-in catalog. Takes effect after a restart.
  When the list was first taken over from the user's own `model_catalog_json` file, a model there with
  the same name as a built-in one keeps the user's own fields (the user's win where they differ); only
  the fields the user did not set follow Codex's built-in catalog.
- **MCP**: the harness's user-level MCP servers.
- **Instructions**: the user-level `AGENTS.md` (Claude Code: `CLAUDE.md`). **Unified mode** writes one
  copy and turns the other harnesses' files into symlinks to it (old files are backed up beside them).

Unsaved changes on the Config, Models or Instructions tab are not dropped silently: switching tab,
going back, opening another page or device, or closing the window (desktop) first asks Save, Discard or
Cancel (on the phone: switching tab and going back).

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
