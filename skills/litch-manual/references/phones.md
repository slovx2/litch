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
  **Irreversible: ask first**; the phone can no longer connect until paired again.

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
