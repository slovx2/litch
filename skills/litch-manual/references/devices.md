# Devices

## Local and remote

- **Local** is this computer. It is always there; Litch starts its bundled device service on launch.
  The service keeps running after Litch quits, so sessions, terminals and scheduled tasks are not
  interrupted. On quit Litch asks whether to stop it as well (only for a service Litch started
  itself); the choice can be remembered, and File → "Ask About the Background Service on Quit" turns
  the question back on. Local cannot be removed or renamed.
- A **remote device** is another machine reached through its own SSH server. Litch logs in with the
  user's ssh config and keys, starts the device service there if needed and keeps one connection that
  carries every harness on that machine. No port is opened on either side.
- A machine that only has the Codex CLI (no Litch adapter) can be added too; it then has Codex as its
  only harness. Installing the adapter there later and reconnecting switches it to the device service.

## Reading

- `scripts/litch devices list` lists devices with name, id, connection state, target and wire color.
- `scripts/litch devices check` tests an SSH target without adding it: whether it is reachable,
  trusted, logs in, and what is installed there (device service and its version, or Codex only). Use
  it before `devices add` and to explain a failing connection.

## Adding a remote device

`scripts/litch devices add` adds a device: a display name and a target, where the target is an alias
from `~/.ssh/config` or `user@host:port` (exact flags: `scripts/litch devices --help`). Litch runs the
same check as `devices check` first and refuses targets that fail it.

Requirements the user must meet first (Litch will not do these, exception E4):

1. `ssh <target>` must log in **without a password prompt**: a key in `~/.ssh` or loaded in the ssh
   agent (a key with a passphrase has to be added to the agent first). Litch has no password field.
2. The host key must already be trusted: the user connects once in a terminal (`ssh <target>`) and
   accepts the fingerprint.
3. The Litch adapter 0.6.0 or later should be installed on that machine (or the Codex CLI 0.125.0 or
   later for a Codex-only device). Install on Linux or macOS:
   `curl -fsSL https://github.com/slovx2/litch/releases/latest/download/install.sh | sh`, or on macOS
   `brew install slovx2/tap/codex-harness-adapter`. Litch then starts the service itself; nothing has to
   be started by hand.

Check results and what to tell the user:

| Result | Meaning | Next step |
|---|---|---|
| Unreachable | No network path or SSH server | Check host, port, VPN, that sshd runs |
| Host not trusted | Host key not in `known_hosts` | User runs `ssh <target>` once and accepts |
| Login refused | Key not accepted | User sets up key login (`ssh-copy-id`), or loads the key into the agent |
| Nothing installed | Neither adapter nor codex found | Install the adapter (command above) |
| Too old | Adapter older than required | Rerun the install script or `brew upgrade codex-harness-adapter` |
| Won't start / Handshake failed | The service did not come up | `scripts/litch diagnose logs <device>` after adding, or run `codex-harness-adapter doctor` there |

Feature minimums on the remote adapter: built-in browser and Computer Use 0.8.0, "operate this
computer" 0.10.0, session trees and scheduled tasks 0.11.0, phone pairing 0.12.0.

## Changing a device

- `scripts/litch devices rename` changes the display name.
- `scripts/litch devices wire` sets the wire color: `green`, `orange`, `blue`, `violet`, `yellow`,
  `brown`, `red` or `slate`.
- `scripts/litch devices target` changes how Litch connects (another alias or `user@host:port`); it is
  checked like a new device and the device reconnects.
- `scripts/litch devices reconnect` drops and re-opens the connection (useful after the user fixed
  something on the remote side, or after upgrading the adapter there).
- `scripts/litch devices remove` removes a remote device from Litch. **Irreversible: ask first**; the
  user then confirms in Litch. It only stops Litch from connecting; nothing on that machine is deleted
  (sessions, the adapter and its service stay). Port forwards for the built-in browser and any "operate this computer" processes from
  that device end.

## Connection behavior

- Litch reconnects by itself after a drop (backing off up to 30 seconds); running turns continue on
  the device and are not lost. While offline the sidebar shows the last known sessions read-only.
- Authentication failures, untrusted host keys, missing or too-old adapters are not retried
  automatically: fix the cause, then `scripts/litch devices reconnect`.
- Litch never upgrades or stops a remote device service on its own. When the remote service is older
  than the app, the device's "Device service" section says so (the device row gets a small mark) and
  offers **Upgrade**. Only after the user confirms does Litch, over ssh, install the app's own version
  there (the install script with `--version`, or `brew upgrade codex-harness-adapter`) and ask the
  service to stop when idle (`device-stop --if-idle`); the reconnect then starts the new version. While
  the service is busy the old one keeps running and Litch retries on every connection and every 5
  minutes until the app quits; **Switch Now** stops it right away after a second confirmation that lists
  what gets interrupted. If the adapter's install method can't be recognized, Litch only shows the
  commands to copy; a service run in the foreground or by a service manager (`brew services`, systemd)
  is installed but not restarted. This is desktop-only and not available through `scripts/litch`; the
  phone app only shows that the service is older.

## Related

- Device settings (harness switches, terminals, tasks, SSH entries): `device-settings.md`.
- Harness install and enable: `harnesses.md`.
- Per-device switches for the browser, Computer Use and "operate this computer": `tools set` in
  `browser-and-computer-use.md` and `operate-this-computer.md`.
- Diagnostics and logs: `troubleshooting.md`.
