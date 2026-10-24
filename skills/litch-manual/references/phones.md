# Phones (Android app, pairing by QR code)

The Litch Android app connects over SSH to the same machines. Instead of copying keys by hand, a
device the desktop already reaches can be added to the phone by scanning a QR code: the phone creates
its own key, enrolls it on that machine, and the user confirms a matching code on the computer. The
computer's keys never leave it, and each phone can be revoked on its own. Remote adapter 0.12.0 or
later.

## Commands

- `scripts/litch phones list <device>` lists phones paired with that device (name, date).
- `scripts/litch phones pair <device>` opens the pairing dialog in the Litch window. Optional flags
  change the address the phone will use (host, port, user; see `scripts/litch phones --help`); they only
  affect what goes into the QR code, not how the desktop connects.
- `scripts/litch phones revoke <device> <phone>` removes that phone's key from the device.
  **Irreversible: ask first**, then the user confirms in Litch; the phone can no longer connect until paired again.

## What the user does (exception E2)

You can only open the dialog. Then the user:

1. In the Android app: Add device → Scan to add, and scans the code (or pastes "Copy pairing text").
2. On the computer, Litch shows "Phone '…' wants to pair" with a 6-digit code; if it matches the phone,
   the user clicks Allow.

The code is valid for 10 minutes and once only (a new one appears when it expires); the confirmation has
to happen within 2 minutes. Do not show the QR code while sharing the screen.

## Requirements and problems

- The phone must reach the address in the code directly (no jump hosts). If the phone cannot connect,
  re-open the dialog with an address the phone can reach (for example the machine's LAN or VPN address).
- Pairing **this computer** (Local) needs its SSH server on: macOS System Settings → General → Sharing
  → Remote Login; Windows "OpenSSH Server" optional feature; Linux sshd. That is a system setting the user
  turns on.
- Litch refuses to create a code (and says why) when `authorized_keys` is a symlink or read-only, sshd
  does not accept keys, two-factor login is required, or the host key does not match.
- Windows administrator accounts cannot be paired by QR code yet (their keys live in
  `administrators_authorized_keys`); add the phone's public key there by hand.
- On a machine without the desktop app, `codex-harness-adapter pair` shows the same QR code in a
  terminal.
- Settings of the Litch app on the phone itself are out of reach (exception E9).
  They live in the phone app under Settings: language, theme (follow the system, light, dark), skin
  (Retro, Literary, Standard, the same three as on the desktop; default Retro), task cards, the
  sign-in approval key's fingerprint, updates.

## In a session on the phone

- **Usage and limits**: tap "Context N% ›" under the input box, or ⋯ → Usage and limits. It shows the
  context in use and, for subscription logins (Claude Code with an Anthropic subscription, Codex with a
  ChatGPT login), each limit window's usage and when it resets; API keys have no limits to show.
- **Compact context**: ⋯ → Compact context, or the button in the usage sheet. Not offered for harnesses
  that cannot compact; while a turn runs it says to wait.
- **Activity and subagents**: as on the desktop, each subagent a harness starts is one line (type,
  description, time, and a status: queued, running, done, failed or stopped); tap it to open the
  subagent's page with its task, the failure reason and its own transcript (read only). Tapping an
  activity group opens its steps below it, with **Collapse** at the end; the tapped line stays in place.
- **Quote part of a reply**: long-press a reply → Select text, select a passage, then Reply in the system
  menu. The passage goes above the input box as a quote (the same comment chip as "Comment on this
  reply" on the desktop, sent as `<litch-comments>`); tap the chip to add a note. Done leaves selecting.
- **Updates**: the phone checks the GitHub release feed and shows a bar on the device and session lists;
  the user taps Update, then confirms the system installer. If it says the new version is signed
  differently, the installed build was not a release build (for example one installed for testing):
  uninstall it and install the release APK once (this clears the phone app's data; devices must be added
  again), after which updates work. If the download breaks off, the bar offers Retry; any failure bar can
  be closed with ✕ and stays closed for that package until a newer one is released.

## Approving the agent's sign-ins on the phone

When an agent asks to sign in to a site in the built-in browser (see `browser-and-computer-use.md`) and
the session's device is paired with the phone, the card also shows in that session on the phone, above
the input box. The phone only offers "Sign in as {account}" and Decline (the web page is on the computer,
so signing in by hand happens there); whichever side answers first wins.

- Usernames are masked on the phone (`so•••@gmail.com`); the password never goes through it. Litch on
  the computer fills in and submits after it has checked the phone's signature.
- Approving needs the phone's fingerprint, face or screen lock. Without any screen lock the phone cannot
  approve.
- The phone signs with its own **approval key** (separate from its SSH key, one per phone, whichever way
  it connects, ordinary sshd or Tailscale SSH). Pairing by QR code with a current desktop sends it along
  (covered by the confirmation code). Phones paired earlier do not need to pair again: the computer
  remembers the key at the first approval and shows a notice; if that was not the user, remove the phone
  in the desktop's settings.
- Phone Settings → Sign-in approvals shows the approval key's fingerprint; the desktop's paired-phones
  setting shows the same one. If the computer says the phone's key does not match, pair the phone again
  by scanning.
- Cards from scheduled-task turns expire after 30 minutes and can carry "Let this scheduled task use this
  account for this site from now on".
- The phone must have Litch open and be connected to that device to see the card (no background
  notifications yet).

## Tailscale SSH

When the address in the code is served by Tailscale SSH (the machine runs `tailscale set --ssh` and the
phone comes in over the tailnet), tailscaled lets connections in by the Tailscale ACL and ignores
`authorized_keys`, so the one-time key cannot work. Litch notices this (the SSH banner of that address,
or the device reporting Tailscale SSH for a `*.ts.net` / `100.64.0.0/10` address) and creates the code
the Tailscale way instead: the dialog says so, the phone must have Tailscale on and signed in, and after
logging in with its own key it enrolls itself; the confirmation code and Allow work as usual.

- Whether a phone can log in is decided by the Tailscale ACL. Any tailnet device the ACL allows can log in
  as that user without a key, so **revoking a phone in Litch does not block it**: change the ACL or remove
  the device in the Tailscale admin console. The phone list and the revoke prompt say this.
- If the ACL uses check mode, Litch (and the phone) shows the verification link; open it, finish the
  check, then retry.
- If the one-time key check fails because the address the desktop uses is Tailscale SSH, the dialog says
  so and offers "Use Tailscale instead".
- `codex-harness-adapter pair` asks whether the phone uses the Tailscale address when the machine runs
  Tailscale SSH; the Tailscale way without `--host` puts the machine's tailnet IP in the code.
- When the desktop's own SSH config reaches the device by its Tailscale name (MagicDNS name, short name or
  tailnet IP) and the device runs Tailscale SSH, the dialog fills in the device's tailnet IP: the phone's
  DNS may not resolve MagicDNS names (for example while another VPN app is on). The menu next to the host
  switches between the IP, the full MagicDNS name and the short name.
