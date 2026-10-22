# codex-harness-adapter

[简体中文](ADAPTER.md) | **English**

> This is the adapter that lives in the [Litch](README.en.md) repository. It installs and runs on its own and does not need the Litch desktop client.

## What it solves

**Control Claude Code, Pi, and other harnesses through the mature Codex desktop UI.** Manage projects, conversations, file changes, and approvals in one place while keeping each harness's own models and login.

Currently supports Claude Code and Pi on macOS, Linux, and Windows; DeepSeek Harness (DSH, [details](docs/guide/configuration.md#deepseek-harness实验性)), OpenCode ([details](docs/guide/configuration.md#opencode实验性)) and agents that speak ACP (Gemini CLI, Qwen Code or a command you supply, [details](docs/guide/configuration.md#acp-agent实验性)) are experimental.

## Install and run

### macOS: Homebrew (background service)

Install and sign in to Claude Code or Pi (at least one). Claude needs the standalone `claude` CLI signed in (`claude auth status` reports logged in); Pi must be installed with npm (`npm install -g @earendil-works/pi-coding-agent`), and the adapter uses that install directly. Then:

```sh
brew install slovx2/tap/codex-harness-adapter
brew services start codex-harness-adapter
codex-harness-adapter ssh-config
```

The service starts at login and restarts if it exits unexpectedly. It uses Homebrew's `node@24`. Logs go to `$(brew --prefix)/var/log/codex-harness-adapter.log`; stop it with `brew services stop codex-harness-adapter`. Prebuilt packages are currently Apple Silicon only.

### Linux: install script

Available from 0.6.0. Install and sign in to Claude Code or Pi (at least one, same requirements as above). Then:

```sh
curl -fsSL https://github.com/slovx2/litch/releases/latest/download/install.sh | sh
~/.local/bin/codex-harness-adapter start
```

The release bundles its own Node, so the machine needs neither Node nor Go, and no root. x64 and arm64 are supported; glibc is required, so on musl systems such as Alpine run from source instead. The program goes to `~/.local/share/codex-harness-adapter/<version>/` and the command is `~/.local/bin/codex-harness-adapter`; the script tells you what to do if that directory is not on `PATH`.

Run the same command again to upgrade; `sh -s -- --version <version>` installs a specific version (also how you go back to an older one) and `sh -s -- --uninstall` removes the program (the state directory `~/.codex-harness-adapter` is left alone). Offline, copy the archive and `codex-harness-adapter-SHA256SUMS.txt` to the machine and run `sh install.sh --from <archive>`. After an upgrade, a service that is already running is still the old version. The script does not stop it for you; it prints the two commands that switch to the new one: `codex-harness-adapter device-stop --if-idle` (stops the service only when it is idle: it is left alone while a turn is running, a terminal is open or a client is connected, and tells you which), then `codex-harness-adapter device-start`. If the service uses a non-default state directory, pass the same `--home` to both. Without `--if-idle` the service is stopped right away and running turns are interrupted. Services from 0.5.1 and earlier do not understand this command; end that process by hand once, after its turns have finished.

Claude Code also needs `bubblewrap`. On macOS (Apple Silicon) the script works as an alternative to Homebrew.

### Run from source

Install Node.js **24**, Go **≥ 1.26.6**, and at least one configured harness: [Claude Code **≥ 2.1.282**](https://code.claude.com/docs/en/setup) or [Pi **≥ 0.99.1**](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/README.md#getting-started) (installed with npm). Newer stable versions are accepted; exact versions are not required. [Platform dependencies](docs/guide/getting-started.md#系统依赖)

```sh
git clone https://github.com/slovx2/litch.git
cd litch
npm run setup
npm start
```

Available harnesses start automatically. A missing or failed harness only produces a warning; others keep running. Keep the terminal open after “SSH ready”. Ctrl-C stops the service. For later launches, just run `npm start`.

## Configure Codex Desktop

1. **Optional: set an alias.** Add the printed `Host` block to `~/.ssh/config` (Windows: `%USERPROFILE%\.ssh\config`). Rename the alias if you like.
2. **Add a connection.** Open **Settings → Connections → SSH → Add**. Select the alias or **Add manually**, using the host, port, user, and private key path from the startup output.
3. **Add a project.** From the main screen, choose **Add project → Remote devices dropdown → your device → project directory**.

Use this SSH device even for projects on your local machine. [Connection guide](docs/guide/gui.md)

## Using it from Litch on a remote machine

Litch reaches a remote machine through that machine's own SSH service (if `ssh hostname` logs you in, that is enough); the adapter does not need to open any port. Install the adapter on that machine, then add the host on the Devices page in Litch. Litch logs in, starts the service and keeps it running, and one connection carries every harness on that machine. Terminals survive a dropped connection.

- This needs version 0.6.0 or later (it includes the device service and knows the `device-start` subcommand); with an older version installed, Litch reports that the adapter is too old.
- You do not start anything by hand and you do not need `ssh-config` (that is for Codex Desktop). The service Litch starts keeps those SSH entries closed by default.
- It uses the default state directory, `~/.codex-harness-adapter`.
- The command is found even when it is not on the login shell's `PATH`, as long as it is in `~/.local/bin` or a Homebrew directory.
- A machine with only native codex can be added too; it just has Codex as its single harness. Install the adapter later and press "Check again" in the device's details to switch to the device service. The device service turns Codex on when it can find codex, so the earlier Codex sessions stay visible; if it cannot, fill in its CLI path in settings.
- "The adapter is too old": run the install script again, or `brew upgrade codex-harness-adapter`. "An older service is running": wait for running turns to finish, then restart it once. Litch never stops the service or upgrades it for you.

## How it works, advanced usage, and troubleshooting

```text
Codex Desktop → local SSH → adapter → Claude Code / Pi
```

SSH listens only on `127.0.0.1`: **7331** for Claude, **7332** for Pi; the experimental DSH, OpenCode, Gemini CLI, Qwen Code and custom ACP entries use 7333 through 7337. Each harness runs independently. Your global Codex CLI is unchanged.

```sh
# Start one harness (replace claude-code with pi as needed)
npm start -- --harness claude-code

# Change both SSH ports
npm start -- --claude-port 7441 --pi-port 7442

# Use a custom port for one harness
npm start -- --harness pi --port 7442

# Check a harness / display its SSH configuration
npm run doctor -- --harness pi
npm run ssh-config -- --harness pi --port 7442
```

With Homebrew or the install script, use `codex-harness-adapter start|doctor|ssh-config` instead of `npm start`, `npm run doctor`, and `npm run ssh-config`; the options are the same.

Pass custom ports on every launch and update the desktop connection accordingly. Use `--home <directory>` to change the state directory; pass it to diagnostics and configuration commands too.

Put adapter and harness environment variables (such as `CHA_CLAUDE_*`, `PI_CLI`, or proxies) in `~/.codex-harness-adapter/env`, one `KEY=VALUE` per line. Both foreground runs and the background service read it; restart the service after changes.

With the [Litch](README.en.md) desktop app you can change these on its Devices page instead: enable or disable each harness, set the path to its command and its environment variables, and switch the SSH entries and their ports. Changes are stored in `~/.codex-harness-adapter/device/settings.json` and take precedence over startup flags and the env file: a flag is only the default for a setting that was never written, and the env file comes after settings. The adapter bundled with Litch is the same program and shares this state directory. Litch starts it with `--ssh=off`, so it listens on no port, and the service stays up even when no harness can start, so the app can connect, show why, and let you fix the settings. If the Codex CLI (0.157.1 or later) is installed on the machine, you can also turn it on as a harness on the Devices page (off by default). It uses your own Codex data directory, and only one codex process can write to a given session at a time.

The Claude Code entry also lists Claude Code sessions started elsewhere on this machine (the command line, the Claude desktop app), as found in `~/.claude/projects`; sessions started programmatically are left out. You can open them to read the history and keep talking; that continues the same native session, so if it is still open elsewhere both sides write to it. Deleting one here only stops listing it; the native transcript stays. To turn this off, put `CHA_CLAUDE_NATIVE_SESSIONS=0` in the environment file.

Command-line output comes in Chinese and English and follows the system language by default. Set `CHA_LANG=en` or `CHA_LANG=zh-CN` to choose; it can also go in the environment file above. Messages a harness sends to the Codex UI over the protocol are Chinese only for now.

- **Startup fails:** Run `doctor` for that harness and follow its guidance. Detailed logs are in `~/.codex-harness-adapter/logs/<harness>/` (the device service's are directly under `logs/`). Each file is rotated at 10 MB, at most 5 are kept per log, and files not written for 7 days are deleted; `LITCH_LOG_MAX_BYTES`, `LITCH_LOG_KEEP` and `LITCH_LOG_MAX_AGE_DAYS` change this. Claude's `debug.jsonl` is the exception: it rotates at 50 MB and keeps 3 older files, set by the existing `CHA_CLAUDE_DEBUG_LOG_MAX_BYTES` and `CHA_CLAUDE_DEBUG_LOG_KEEP`. Logs that older versions left under `<harness>/` and `device/` are no longer written and can be deleted.
- **A harness shows as "not installed":** Install its command-line tool and restart the service; or fill in its "CLI path" in Litch's device management (setting key `harness.<id>.cliPath`); or point to it with its own environment variable (`CHA_CLAUDE_CLI` for Claude Code, `PI_CLI` for Pi, `CHA_DSH_CLI` for DSH, `CHA_OPENCODE_CLI` for OpenCode, and `CHA_GEMINI_CLI`, `CHA_QWEN_CLI`, `CHA_ACP_CLI` for the ACP entries). Gemini CLI, Qwen Code and the custom ACP entry are disabled by default; turn them on in the settings first.
- **Connection fails:** Check that the service is running and the port and private key match its output.
- **Model unavailable:** Check login and model settings in native Claude Code / Pi first.

[More configuration](docs/guide/configuration.md) · [Development](CONTRIBUTING.md)

---

Based on [fuergaosi233/claude-codex](https://github.com/fuergaosi233/claude-codex), with generic SSH code from Tyrs Hand. [MIT](LICENSE) · [Third-party licenses](THIRD_PARTY_NOTICES.md)
