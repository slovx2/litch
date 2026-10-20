# Projects and sessions

## Projects

A project is a folder on one device. Sessions of every harness in that folder are listed under it, and
the side panel (files, diff) and terminals follow the project.

- `scripts/litch projects list <device>` lists the device's projects with their paths (arguments of
  the project actions: `scripts/litch projects --help`).
- `scripts/litch projects add <device> <path>` adds a folder as a project. The path is on that device
  (absolute, or `~/…`); the folder must exist there.
- `scripts/litch projects remove <device> <project>` removes the project from the sidebar. The folder
  and the sessions in it are not deleted; the sessions show under "No project" or wherever their working
  folder fits.

In the UI: Add project… on the device's menu or in the new-session project picker; rename, color, pin,
move to a group, reorder and delete from the project's menu. Groups (sidebar folders) are made from the
device menu (New group…). Arranging the sidebar (groups, pins, order) is not available through the
command; tell the user how to do it in the sidebar.

## Sessions

Sessions are not created or edited through `litch config`. What the user can do in the UI, so you can
explain it:

- **Start**: New session (Mod+N) → pick device, project, harness, model, reasoning effort, permissions
  (Read only / In project / Full access, or the harness's own presets) and optionally Plan → send the
  first message. `scripts/litch open new` brings the user to this page.
- **While a turn runs**: messages sent are queued; "Say it now" steers the running turn; Stop
  interrupts it.
- **Approvals and questions** appear as cards above the composer: commands, file changes, extra
  permissions, MCP tools (Allow once / Allow for this session / Always allow / Decline / Decline and
  stop, or decline with a note for the model); multi-question forms; plan confirmation (Run the plan /
  Ask for changes / Not now).
- **Per message**: Fork a new conversation from here; Roll back to here and edit (deletes that message
  and everything after it; files are only restored where the harness supports it, the confirmation says
  which).
- **Composer**: `/` for commands and skills, `@` to mention a file, attach images and files (remote
  devices: text files only), context meter with Compact context.
- **Side panel**: Files (tree, search, read-only viewer, add a file to the conversation), Diff (all /
  staged / unstaged, stage, unstage, discard, comment on lines; comments go with the next message),
  Browser, Suggested tasks, Subagents.
- **Terminal**: per project; "Put away, keep it running on the device" keeps a terminal alive and
  "Terminals on the device" brings it back. Limits are device settings (`device-settings.md`).
- **Session menu**: pin, move to group or project, rename, archive (undo available), delete (permanent),
  schedule a task for this session, start a sub-session, detach a sub-session.
- **Archived sessions** page: restore, open read-only, delete.

## Session trees (sub-sessions)

A session can start **sub-sessions** on the same device, with any harness. They are nested under the
parent in the sidebar (up to 8 levels), their results come back to the parent, and the parent can be
woken to continue.

- **By hand**: session menu → Start a sub-session… → harness, model, project, context ("Start fresh",
  or carry over the parent's context, which needs the parent's harness), title, first message, and
  "Wake the main session when done". If the chosen harness cannot give the same sandbox as the parent,
  the dialog warns that the sub-session will be looser.
- **By the model**: in sessions of every harness (Codex, Claude Code, Pi, DSH, OpenCode, Gemini CLI,
  Qwen Code, ACP) the model has `litch_sessions` tools: list and read sessions on the device, start
  sub-sessions, send to and interrupt its own sub-sessions, wait for them. When the user did not ask for
  a sub-session in that turn, it becomes a suggested task instead of starting directly.
- **Suggested tasks**: the model is told to suggest real follow-up work (something it noticed, the next
  step its answer recommends, independent steps of a plan) as a card instead of only mentioning it. The
  card sits in the conversation at the point it was suggested and shows its state (waiting, started,
  dismissed, withdrawn by the model, expired after 7 days). Buttons: Start, Edit and start (change the
  harness, model, effort, project, folder, fresh or with context, title, brief, permissions), Dismiss.
  The side panel's **Suggested tasks** tab lists every card of the current session, with a badge for
  the waiting ones; clicking one scrolls to it. You can also tell the model "start the second one", and
  it withdraws cards that went stale. At most three cards it raises on its own per turn (independent
  steps of an agreed plan count separately), four in all. The model ends every turn with a
  wrap-up call that carries its suggestions (an empty one when there are none); when a turn the user
  started ends without it, Litch starts one short reminder turn (a light line "Reminded the model to
  wrap up"). The reminder is the device setting `sessions.wrapUpReminder` (on by default). Started cards
  show the harness and folder the sub-session actually got. The mobile app shows the same cards and a
  per-session list (the "N suggested tasks waiting for you" bar at the top of a conversation, or the menu).
- **New task or here**: when the user asks for something unrelated to the current session, the model
  first shows a card with only a title and two buttons, "New session" and "Do it here". New session: the
  model writes the brief and the sub-session starts. Do it here: the model does it in this session.
  Sending a new message instead of choosing counts as "Do it here". Requests that build on the session
  (corrections, follow-ups, the next iteration, going ahead with what was just suggested) get no card.
- **Hand-off**: when an unrelated message arrives while the model is in the middle of a task, it hands the
  task and its remaining plan to a forked sub-session (a "Handed off to a forked session" card, started
  at once, waking the parent when done) and answers the new message here. The fork starts before the
  current turn, so work done in that turn reaches it only through the remaining plan.
- **Reports and waking**: when a sub-session finishes a turn, the start of its last answer is handed to
  the parent ("Reports from sub-sessions"). When the parent is idle and its sub-sessions have stopped,
  the parent is woken to continue (limited per user message). Litch decides this, not the model: sub-
  sessions the model started or suggested always wake the parent; when you start one yourself (spawn
  dialog, Edit and start) you can turn "Wake the main session when done" off. Nothing is woken while no client is
  connected; it happens when one connects. Turns run by scheduled tasks report but do not wake.
- **Detach as a standalone session** (session menu or the "Started from …" bar at the top of a
  sub-session) cuts the link.
- **Subagents** started by a harness itself (for example Codex's agents) are not sub-sessions; they show
  in the side panel's Subagents tab and cannot be messaged directly.

The whole feature can be switched per device with the `sessions.enabled` setting
(`scripts/litch settings set <device> sessions.enabled=false`); remote devices need adapter 0.11.0 or
later.
