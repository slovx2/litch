<p align="center">
  <img src="docs/images/litch-logo.png" width="420" alt="Litch">
</p>

# Litch

[简体中文](README.md) | **English**

One interface for all your coding agents. Litch is an open-source desktop client that brings Claude Code, Pi, Codex and other harnesses, on one machine or several, into a single window. It speaks the Codex app-server protocol.

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

- **Multiple harnesses.** Claude Code, Pi, Codex (native), plus experimental DeepSeek Harness. Each engine keeps its own sessions, tools, model configuration and login. If codex is installed on a machine, its sessions show up next to the other harnesses by themselves.
- **Panels for coding work.** A terminal that survives a dropped connection, a file tree and viewer, and diff review (stage, revert, and inline comments that go out with your next message).
- **Remote machines.** Litch reaches a remote machine through your system's ssh. Neither side opens a port, and login is left to your own ssh config and key agent, so the app has no password field. If the adapter is installed there, all of that machine's harnesses come in together, with settings, workspaces and terminals that survive a dropped connection; a machine with only native codex works too, with nothing else to install. It reconnects by itself after a drop, and a turn that was running is not lost. The adapter route needs adapter 0.6.0 or later on that machine.
- **Mobile.** In development.

## Status

| Part | Status |
|---|---|
| Adapter `codex-harness-adapter` | Usable. Lets the Codex desktop app drive Claude Code, Pi and the experimental DeepSeek Harness directly; Litch also reaches all the harnesses on a machine through it. See [install and usage](ADAPTER.en.md) |
| Desktop client Litch | Early development, with no installer yet: run it from source, or package it into an app on your own Mac. The packaged app ships with its own copy of the adapter and gathers the harnesses installed on this machine under one device, Local. You can browse sessions, send messages (with images and attachments), queue, interrupt and steer, answer approvals and questions, and use plan mode, `/` commands and `@` to find files. When starting a session you pick the device, workspace and harness, and sessions from different harnesses in the same folder share one workspace. The side panel has a terminal, files and diff review. The Devices page can enable or disable a harness, change its settings, and show diagnostics and logs. It can also connect over SSH to the device service or native codex on a remote machine |
| Mobile | In development |

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

When it opens, it starts that adapter by itself, and the Claude Code, Pi, DeepSeek Harness and codex installed on this machine show up under the device named Local (codex uses your own data, in `~/.codex` by default; disable it on the Devices page if you do not want it). A harness that is not installed says why; on the Devices page you can give the path to its command or disable it. The adapter keeps its state in `~/.codex-harness-adapter`, shared with a standalone install of the adapter. The service keeps running after you quit the app, so sessions are not interrupted.

The app is only ad-hoc signed for this machine, so another Mac will refuse to open it.

## Docs

[Adapter install and usage](ADAPTER.en.md) · [Development conventions](AGENTS.md) (Chinese) · [Contributing](CONTRIBUTING.md)

---

The adapter is based on [fuergaosi233/claude-codex](https://github.com/fuergaosi233/claude-codex). [MIT](LICENSE) · [Third-party notices](THIRD_PARTY_NOTICES.md)
