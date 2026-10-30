# Appearance and preferences

These preferences belong to this desktop, take effect immediately and do not sync to the phone.
Read them with `scripts/litch look get` (or the broader `scripts/litch status`). Use `--json` when
parsing the result. After a change, read it back. Exact flags: `scripts/litch look --help`.

## Appearance

Open Settings → Appearance, or the sidebar's Appearance menu. The menu offers skin, theme and
language, with a link to the full settings page.

| Item | Values | Default |
|---|---|---|
| Skin | `retro` (Retro), `human` (Literary, 文艺), `standard` (Standard) | `retro` |
| Theme | `system`, `light`, `dark` | `system` |
| Density | `compact`, `standard`, `roomy` | `standard` |
| Conversation width | `wide` (up to 1280 px), `compact` (up to 760 px) | `wide` |
| Window zoom | 80, 90, 100, 110, 125, 150 percent | 100 |
| Sidebar text size | 90, 100, 110, 120, 135, 150 percent | 100 |
| Conversation text size | 90, 100, 110, 120, 135, 150 percent | 100 |

```sh
scripts/litch look set --skin human --mode dark --density standard --width compact --zoom 100
scripts/litch look set --tree-text 120 --chat-text 135
scripts/litch look get
```

Text sizes scale their reading areas relative to the skin, and the chosen factors survive skin
changes. Conversation text size covers prose, code, diagrams, questions, approvals, the composer and
its menus, selection actions, comments and quotation previews, suggestions, attachments and
conversation confirmations. Side chats, agent details, background tasks and goals also follow it.
Floating cards reposition and wrap or scroll when needed. Sidebar text size covers device, project
and session rows. The top bar, sidebar header/footer/menus, settings, info rail, panel tabs, diffs,
file previews, terminal and browser keep their own sizes.

Text size and window zoom multiply: 150% of each gives 225%. Percent signs are optional in commands;
`1.2` also means 120%. Conversation width changes are visible only in wide windows; when the
conversation area is below about 810 px both choices look alike. Layout sizes, grouping, pins and
order are adjusted directly in the window, not by these commands.

## Language

Settings → Language selects Chinese or English. `scripts/litch look language zh-CN` and
`scripts/litch look language en` also change the app menu. First launch chooses the system language;
there is no ongoing “follow system language” choice.

## Sending during a turn

Settings → Conversation chooses **Send now** (default) or **Queue**. Send now adds a message to the
running turn; if that harness cannot take mid-turn input, the message queues instead. Queue waits
until the turn ends. This also controls question replies and comments sent directly to the session.
The queued message's own “Send now” action remains available where supported.

```sh
scripts/litch chat get
scripts/litch chat send-mode queue
scripts/litch chat send-mode now
```

This setting chooses delivery; the “Added to this turn” label and segmented activity are
transcript behavior, described in `sessions-and-projects.md`.

## Notifications

Open Settings → Notifications. `scripts/litch notify get` reads all three preferences below.

| Preference | Command | Default |
|---|---|---|
| Session notifications | `scripts/litch notify sessions on|off` | on |
| Session scope | `scripts/litch notify scope all|main` | `all` |
| Successful scheduled-task runs | `scripts/litch notify task-success on|off` | off |

A session notifies when its turn ends or fails, or when it needs an approval or answer, unless you
are viewing that session in the focused window. Sessions started elsewhere stay quiet while the
sidebar hides them. New notifications replace the previous turn/waiting notice; handling a request
withdraws its notice, and opening the session clears its turn notice. On macOS a waiting request can
bounce the Dock icon while Litch is in the background. Clicking a notification opens its session.

**Main sessions only** means no parent in the session tree. Litch sub-sessions, manager worklines and
known children from another app are filtered even if their parent is not loaded or is archived.
A session without known parent information is treated as a main session. Scope filters completion,
failure, approval and answer notices; it does not change unread dots or Dock counts. The session
notification switch still applies. Manager decisions, scheduled tasks and remote approvals without
a session are outside this scope. Failed scheduled-task runs always notify; success uses the switch.

Unread state is local to each app: a turn ending or failing while unseen creates a dot and contributes
to the Dock count; opening clears it. Approvals/questions do not add to that count. Unread rows stay
findable even behind collapsed parents or “Show more”. The phone has no system push notifications
and does not share this desktop notification preference.

### Manager decisions

Each manager's **Desktop notifications for new decisions** switch is independent of ordinary session
notifications. Change it in the manager form or Settings → Assignment and notifications, or with
`scripts/litch managers set <device> <manager> --notify on|off`; read it with
`scripts/litch managers get <device> <manager>`.

While the desktop is connected, a decision becoming open (including reopening) notifies once.
Editing an open decision does not notify again. Initial loading, reconnecting, reloading a board or
turning notifications on does not replay existing decisions. Viewing that manager in the focused
window suppresses the notice. Clicking it opens the manager; the title names the manager and the
body shows the decision title. No notice is sent while the desktop is closed or disconnected.

### If a notification is missing

Check the session switch and scope with `notify get`, whether you are already viewing the session,
and the system's notification permissions/Focus mode. For manager decisions check that manager's
switch and whether the decision is newly open. A missing notice does not mean the task stopped.

## Other preferences

- Conversation links: `scripts/litch browser links in-app|system`; details in
  `browser-and-computer-use.md`.
- Manual installation: `scripts/litch assist get` and `scripts/litch assist manual on|off`;
  details in `concepts-and-ui.md`.
- Open a page: `scripts/litch open settings/<section>`, `device <device>`, `tasks`, `managers`,
  `suggestions` or `new`. Use `scripts/litch open --help` for section names.
- Shortcuts are read-only in Settings → Shortcuts. Litch updates are user-controlled in
  Settings → About → Updates and are outside the configuration command.
