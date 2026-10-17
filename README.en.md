<p align="center">
  <img src="docs/images/litch-logo.png" width="420" alt="Litch">
</p>

# Litch

[简体中文](README.md) | **English**

Drive the coding agents on every machine from one desktop.

Litch is an open-source desktop client that brings Claude Code, Pi, Codex and other harnesses, on this machine and on remote ones, into a single window. It speaks the Codex app-server protocol. It focuses on three things:

- **Remote connections.** Reach any number of machines through your own ssh, with no port opened on either side. Every harness on each machine comes in together; dropped connections reconnect by themselves and running turns are not lost.
- **Built-in browser.** Agents can open pages, click, fill in forms and take screenshots in the browser that ships with Litch, while you watch in the side panel and can take over at any time.
- **Computer Use (macOS).** Agents can operate the apps on this Mac, and each app needs your approval before the first action.

**Agents on remote machines can use this desktop's browser and Computer Use too.** The agent runs on the server while the browser and the desktop stay with you: a dev server on the remote machine (addresses like `localhost:3000`) is forwarded over ssh and opens in the desktop's browser automatically. Each device has its own switch for each capability (the browser is on by default, Computer Use is off).

## Screenshots

### Retro (default)

<p>
  <img src="docs/images/en/retro-dark-chat.png" width="32%" alt="Retro skin, dark: a conversation">
  <img src="docs/images/en/retro-dark-activity.png" width="32%" alt="Retro skin, dark: activity expanded to show a diff">
  <img src="docs/images/en/retro-light-stream.png" width="32%" alt="Retro skin, light: an answer streaming in">
</p>

### Literary

<p>
  <img src="docs/images/en/human-light-chat.png" width="32%" alt="Literary skin, light: a conversation">
  <img src="docs/images/en/human-light-activity.png" width="32%" alt="Literary skin, light: activity expanded to show a diff">
  <img src="docs/images/en/human-dark-stream.png" width="32%" alt="Literary skin, dark: an answer streaming in">
</p>

The screenshots show demo data. Skin, light or dark, and language (中文 / English) can be switched at any time.

## Features

- **Remote machines.** Litch reaches a remote machine through your system's ssh. Neither side opens a port, and login is left to your own ssh config and key agent, so the app has no password field. If the adapter is installed there, all of that machine's harnesses come in together, with settings, projects and terminals that survive a dropped connection; a machine with only native codex works too, with nothing else to install. It reconnects by itself after a drop, and a turn that was running is not lost. The adapter route needs adapter 0.6.0 or later on that machine; for agents there to use this desktop's browser and Computer Use, it needs 0.8.0 or later.
- **Built-in browser.** A browser in the side panel that both you and the agent can use: open pages, read them, click, fill in forms, upload files, take screenshots. The first visit to an outside site asks for your consent (for this turn, this session, always, or deny); local addresses are allowed. Links in the conversation open in the built-in browser by default; Cmd/Ctrl-click them, or turn this off in Settings, to use your system browser instead. Agents on remote devices use this same browser, and the remote machine's localhost is forwarded over ssh.
- **Computer Use (macOS only).** The agent looks at the screen and operates apps on your Mac. System permissions go to a small, separately signed helper, "Litch Computer Use", not to Litch itself: click "Open System Settings" in the Computer Use group of Settings, and the helper appears in the list, so you only need to turn on Accessibility and Screen Recording for it. Each app needs your approval before the first action, password managers and the like are always off limits, an on-screen notice shows while it works, and Esc stops it. Agents on remote devices can use it too, but only after you turn it on in that device's settings, and every session asks again.
- **Multiple harnesses.** Claude Code, Pi, Codex (native), plus experimental DeepSeek Harness (DSH). Each engine keeps its own sessions, tools, model configuration and login. If codex is installed on a machine, its sessions show up next to the other harnesses by themselves.
- **Panels for coding work.** A terminal that survives a dropped connection, a file tree and viewer, and diff review (stage, revert, and inline comments that go out with your next message).
- **Mobile.** In development.

## Status

| Part | Status |
|---|---|
| Adapter `codex-harness-adapter` | Usable. Lets the Codex desktop app drive Claude Code, Pi and the experimental DSH directly; Litch also reaches all the harnesses on a machine through it. See [install and usage](ADAPTER.en.md) |
| Desktop client Litch | Early development. Installers are available for macOS (Apple Silicon) and Windows (see Download below; the Windows build has not been fully tested), or run it from source. The app ships with its own copy of the adapter and gathers the harnesses installed on this machine under one device, Local. You can browse sessions, send messages (with images and attachments), queue, interrupt and steer, answer approvals and questions, and use plan mode, `/` commands and `@` to find files. When starting a session you pick the device, project and harness, and sessions from different harnesses in the same folder share one workspace. The side panel has a terminal, files and diff review. The Devices page can enable or disable a harness, change its settings, and show diagnostics and logs. It can also connect over SSH to the device service or native codex on a remote machine |
| Built-in browser, Computer Use | Available since 0.8.0; Computer Use is macOS only. Agents on remote devices can use both capabilities of the desktop (the adapter there needs 0.8.0 or later) |
| Mobile | In development |

## Download

Get it from the [releases page](https://github.com/slovx2/litch/releases/latest):

| System | File | Notes |
|---|---|---|
| macOS (Apple Silicon) | `Litch-<version>-macos-arm64.dmg` | Signed and notarized by Apple. Open it and drag Litch into Applications |
| Windows (x64) | `Litch-<version>-windows-x64-setup.exe` | **Not fully tested yet**; some things may not work. The installer is not signed, so Windows warns that the publisher is unknown: click "More info", then "Run anyway". It installs for the current user only and does not need administrator rights |

The app ships with its own copy of the adapter and, when opened, gathers the Claude Code, Pi, DSH and codex installed on this machine under the device named Local; install and sign in to those harnesses separately. There is no installer for Intel Macs yet; run it from source there.

## Run from source

Requires Node.js 24.

```sh
git clone https://github.com/slovx2/litch.git
cd litch
npm run client:setup
npm run client:start:mock
```

That shows demo data. To see real sessions, start the adapter as described in the [adapter guide](ADAPTER.en.md), then hand its socket to the client:

```sh
LITCH_ENTRY=~/.codex-harness-adapter/pi/runtime.sock npm run client:start
```

Replace `pi` with `claude-code`; use `~/.codex-harness-adapter/device/device.sock` to get every harness over one connection; or point it at the socket of a native codex started with `codex app-server --listen unix://<path>`.

On macOS you can package it into an app you can open directly. It lands under `apps/desktop/out`. Run `npm run client:setup` from above first; the app ships with its own copy of the adapter, so the adapter has to be built too (this needs Go):

```sh
npm ci
npm ci --prefix packages/claude
npm ci --prefix packages/pi
npm ci --prefix packages/dsh
npm run build
npm run client:pack
open apps/desktop/out/Litch-darwin-arm64/Litch.app
```

When it opens, it starts that adapter by itself, and the Claude Code, Pi, DSH and codex installed on this machine show up under the device named Local (codex uses your own data, in `~/.codex` by default; disable it on the Devices page if you do not want it). A harness that is not installed says why; on the Devices page you can give the path to its command or disable it. The adapter keeps its state in `~/.codex-harness-adapter`, shared with a standalone install of the adapter. The service keeps running after you quit the app, so sessions are not interrupted.

An app you package yourself is only ad-hoc signed for this machine, so another Mac will refuse to open it. Computer Use permissions are tied to the signature too, so every repackage needs them granted again. To give it to someone else, or to use Computer Use for long, use the installer from the releases page.

## Docs

[Adapter install and usage](ADAPTER.en.md) · [Development conventions](AGENTS.md) (Chinese) · [Contributing](CONTRIBUTING.md)

---

The adapter is based on [fuergaosi233/claude-codex](https://github.com/fuergaosi233/claude-codex). [MIT](LICENSE) · [Third-party notices](THIRD_PARTY_NOTICES.md)
