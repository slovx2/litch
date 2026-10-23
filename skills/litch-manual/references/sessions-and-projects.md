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

In the UI: Add project… on the device's menu, the **+** on the built-in Projects group, or in the
new-session project picker; rename, color, pin, move to a group (or back to Projects), reorder and delete
from the project's menu. Groups (sidebar folders) are made from the device menu (New group…). Projects
that are not pinned or in a group are listed under the built-in Projects group (it can't be renamed or
deleted). In the sidebar, drag a project onto a group's title row to put it at the end of that group
(the row lights up), or between two projects to place it there (a line shows where it lands); dragging
it onto Projects takes it out of its group. Drag a group's title row (or Projects') above or below
another group to change their order, or use Move up / Move down in its menu; Pinned stays on top and
the order is remembered on this computer only. Sessions can be dragged onto Pinned or a group's title, or
back onto their own project. The phone app shows the same groups but has no dragging. Arranging the
sidebar (groups, pins, order) is not available through the command; tell the user how to do it in the
sidebar.

## Sessions

Sessions are not created or edited through `litch config`. What the user can do in the UI, so you can
explain it:

- **Start**: New session (Mod+N) → pick device, project, harness, model, reasoning effort, permissions
  (Read only / In project / Full access, or the harness's own presets) and optionally turn on the
  Plan mode switch → send the
  first message. `scripts/litch open new` brings the user to this page.
- **Worktrees**: on the New session page, when the project folder is in a git repository on a device
  that supports worktrees, "Where" offers Local (the project folder) or New worktree. A new worktree is
  created by the device service with its own branch (named from the first line of the message), so the
  session's changes stay out of the project folder; "From" picks what to branch from: the default
  branch, the current local state (current commit plus uncommitted changes and new files), or any
  local or remote branch. The choice is remembered per device and project. Such a session shows a
  branch mark in the sidebar and a Worktree card in the info rail (branch, base, path; Terminal, Copy
  path, and Restore when the folder was removed). Device settings → Worktrees lists every worktree on
  the device: Remove deletes the folder and keeps the branch (uncommitted changes saved as a snapshot,
  or discarded), Restore brings a removed one back with its snapshot, Remove with branch deletes both
  for good. The Worktree card also has "Merge <base>": it merges new commits from the branch the
  worktree started from (nothing is pushed; commit the worktree's changes first; on conflicts it stops
  and lists the files to resolve in the terminal or by the model). In such a session the Diff tab's
  "All" compares against where the worktree started (its latest common commit with the base branch),
  so committed changes show too ("Since <commit>"); those can't be discarded there. Archiving the
  session removes a clean worktree (the branch stays), keeps one with uncommitted changes (see
  `worktrees.keptDays`), or hands it to a sub-session still sharing it; reopening or unarchiving the
  session brings the folder back. Deleting the session deletes its worktree folder without a snapshot.
  Where worktrees go, how branches are named and automatic cleanup: `device-settings.md`.
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
  devices: text files only), context meter. In an existing session, clicking the meter shows context
  usage and a Compact context button (dimmed with the reason underneath while a turn runs or when the
  harness can't compact). When the harness is signed in with a subscription (Claude Code with an
  Anthropic subscription, Codex with ChatGPT) it also lists the plan limits: the 5-hour and weekly
  limits, per-model weekly limits when there are any, how much of each is used and when it resets. API
  keys and third-party providers have no plan limits, and those rows are not shown.
- **Side panel**: Files (tree, search, read-only viewer, add a file to the conversation), Diff (all /
  staged / unstaged, stage, unstage, discard, comment on lines; comments go with the next message),
  Browser, Suggested tasks, Background, Subagents.
- **Background tasks**: work still running after a turn ends (a background command, a Claude Code
  Monitor, a dsh background job, a long-running Codex command, or a background command Litch gives Pi,
  OpenCode and ACP sessions through its `litch_shell` tools (on by default; each harness's "Background
  commands" setting turns it off). The session counts as idle, not stuck:
  a breathing line above the composer says how many are running; clicking it opens the Background tab
  (running tasks first, then finished ones; name, elapsed time and status, no output). The folded
  turn says "N running in the background", and the sidebar row shows a slowly breathing hollow mark
  instead of the spinner. Claude Code, dsh and Litch's background commands (Pi, OpenCode, ACP)
  continue on their own when a task finishes by itself; that turn starts with "Background task
  finished, continuing" instead of a message from the user. A task you or the model stopped does not
  wake the session. Codex does not continue on its own. Gemini CLI and Qwen Code get no Litch
  background commands. Litch's background commands run on the device the session runs on, as the
  model's own commands do; their output goes to a log file the model can read. They keep running when
  every client disconnects, and stop when the harness's runtime restarts (a settings change, a service
  restart or upgrade) or the session is deleted. A sub-session reports to its parent when its turn ends and says how many
  background tasks are still running, then reports again when they finish (after the turn that
  continues, or right away for Codex). A scheduled run ends with its turn too; when the background
  work finishes later, the run's summary and count are updated and it shows as unread again.
  There is no stop button yet: ask the model to stop a task, or
  stop the turn. With Pi's "Ask before acting" on, starting a background command is asked about like
  any other command; in OpenCode's read-only permission mode the model cannot start one, and outside
  the project folder it asks first (except with full access). On the phone, the same line opens a list
  from the bottom; the folded steps and the
  line at the start of a continuing turn look the same as on the desktop.
- **Goals** (Codex and Claude Code only; other harnesses show no goal controls): type `/goal` followed
  by what should be achieved and send it. Instead of a normal message this sets the session's goal,
  and the harness keeps working on it turn after turn while the session is idle, until the goal is
  achieved, blocked, hits a usage limit or runs out of its budget. Each turn it starts on its own
  begins with "Goal not met yet, continuing" instead of a message from the user. A line above the
  composer shows the status, the goal and the time or tokens used, with Pause / Resume and Clear;
  clicking it opens the Goal tab in the side panel, where the goal can be edited (Save, or Mod+S;
  saving also resumes it). Sending `/goal` with different text while a goal is unfinished asks before
  replacing it. Stop pauses an active goal before stopping the turn, so it does not start again by
  itself. `/goal` also works on the New session page. Once the goal is achieved it is cleared right
  away: the line above the composer goes, and "Goal reached · <time>" appears under the last answer
  of the turn that achieved it (until a new goal is set). Only text is accepted (no images or files),
  and a token budget can be shown but not set in Litch. The phone follows the same rules: the goal
  line above the composer (status, time, Pause / Resume, Clear — no confirmation), `/goal` from the
  slash list (also on the New session page), the line at the start of a continuing turn and the
  "Goal reached" line; editing in a side tab is desktop only. For Codex, a goal set in another app on
  the same session shows up here too; if goals are turned off in the Codex configuration, the
  controls disappear for that session.
- **Terminal**: per project; "Put away, keep it running on the device" keeps a terminal alive and
  "Terminals on the device" brings it back. Limits are device settings (`device-settings.md`).
- **Session menu**: pin, move to group or project, rename, archive (undo available), delete (permanent),
  schedule a task for this session, start a sub-session, detach a sub-session.
- **Session names**: Claude Code sessions take the title Claude Code writes; Codex sessions started in
  Litch are named by Litch after their first turn (switch and conditions in `harnesses.md`). A name the
  user sets by hand is never replaced.
- **Archived sessions** page: restore, open read-only, delete.
- **Reply style**: sessions that Litch starts (including sub-sessions and scheduled tasks) tell the model
  that replies appear in Litch, which renders Markdown and Mermaid diagrams, and to answer
  conversationally rather than like a terminal. Codex sessions do not get this (Codex keeps its own
  style, as in the official Codex app). The user's own instructions take precedence. It is fixed when
  a session is created: sessions started outside Litch (for example in the official Codex app) and
  sessions created before this version do not have it, and a session Litch created keeps it when
  opened in another app. There is no setting to turn it off.

## Claude Code sessions started elsewhere

The Claude Code harness also lists Claude Code sessions started elsewhere on the machine (Claude desktop
app, `claude` in a terminal). They can be opened and continued in Litch, and back in the other app.

- **Read-only while another process has it open**: when the Claude desktop app or a `claude` in a
  terminal still has the session open, the session is read-only in Litch: the composer is greyed out
  with "Another process has taken over this session, so it is read-only here" (中文「此会话正由另一个
  进程接管，这边只读」), and sending, rewinding and compacting are refused. Two processes writing one
  session would fork its history. What the other side does still shows up in Litch every few seconds,
  and the session becomes writable again by itself once the other side lets go.
- **How to make the desktop app let go**: archive that session in the Claude desktop app, or quit the
  Claude desktop app (it keeps a session's process running after the reply, so a session used there
  recently is usually still held). In a terminal, exit `claude`. A session that was written to in the
  last 10 seconds by something Litch cannot identify also counts as held.
- **Going back**: do not continue the session in the desktop app while Litch is still running a turn
  in it; wait until Litch's turn has finished. The desktop app does not check, so this cannot be
  blocked.
- **Settings**: when Litch picks up the session, it takes the model, reasoning effort, permissions
  (bypass permissions becomes Full access) and Plan from what the other app used last. A setting the
  user changes in Litch stays as set; the others keep following the other app. Titles and approvals
  granted for the session are not shared.
- **Context usage** shows how much the last request used; the window size is only known for models
  Litch has run itself, otherwise only the amount used is shown.

## Session trees (sub-sessions)

A session can start **sub-sessions** on the same device, with any harness. They are nested under the
parent in the sidebar (up to 8 levels), their results come back to the parent, and the parent can be
woken to continue.

- **By hand**: session menu → Start a sub-session… → harness, model, project, context ("Start fresh",
  or carry over the parent's context, which needs the parent's harness), title, task, background
  (only for a fresh start, optional: what the sub-session cannot see of this conversation), and
  "Wake the main session when done". If the chosen harness cannot give the same sandbox as the parent,
  the dialog warns that the sub-session will be looser.
- **By the model**: in sessions of every harness (Codex, Claude Code, Pi, DSH, OpenCode, Gemini CLI,
  Qwen Code, ACP) the model has `litch_sessions` tools: list and read sessions on the device, start
  sub-sessions, send to and interrupt its own sub-sessions, wait for them. When the user did not ask for
  a sub-session in that turn, it becomes a suggested task instead of starting directly.
- **Suggested tasks**: the model suggests a task of its own as a card instead of only mentioning it:
  work that ends in something of its own (a branch, a pull request) and that you may want to follow
  apart from this conversation, such as something it noticed, the follow-up its answer recommends, or
  independent steps of an agreed plan. Parts of the current task (however large), and anything it left
  unfinished or unverified, stay in the conversation; most turns end with no card. When the next step
  simply continues what the model just found (say, fixing what it diagnosed), it asks one short
  question at the end of the turn with one or two reply buttons instead of making a card; a click
  sends the button's words as your message, and the question lapses with your next message. The
  cards and the question from the wrap-up appear below the final answer once the turn has ended;
  cards for independent plan steps appear as soon as the model suggests them. The
  card shows its state (waiting, started, done here, dismissed, withdrawn by the model, expired after
  7 days). Buttons: Start, Do it here (the card is settled and "Do it here: <title>" plus the task is
  sent to the session as your message, after the running turn if one is running), Edit and start
  (change the harness, model, effort, project, folder, fresh or with context, title, task,
  background, permissions), Dismiss. Whatever the card does not set comes from the parent session as
  it is when you start: harness, model, reasoning effort and folder (on another harness, that
  harness's default model and effort). The same holds when the model starts a sub-session or hands
  off a task. A fresh card the model raises always carries a background (the overall goal,
  decisions and constraints so far) next to the task; the sub-session gets it as its own section
  before the task. Expand the brief on the card to read it.
- **Where a sub-session works** (devices that support worktrees): when the parent session is in a
  worktree Litch created (or shares one), a new sub-session gets its own new worktree and branch,
  starting from the last commit of the parent's branch (the parent's uncommitted changes are not
  carried over); otherwise it shares the parent's folder. The model can say which it wants; cards,
  the "New session" choice of an offer card and the Start a sub-session dialog have a "New worktree"
  checkbox, preset this way, and what is checked there wins. "Do it here" always stays in the current
  session and folder. A handed-off task gets a worktree only on harnesses that can fork into another
  folder (Codex, Claude Code); elsewhere it shares the folder.
  The side panel's **Suggested tasks** tab lists every card of the current session, with a badge for
  the waiting ones; clicking one scrolls to it. You can also tell the model "start the second one", and
  it withdraws cards that went stale. At most three cards it raises on its own per turn (independent
  steps of an agreed plan count separately), four in all. When its work is done, the model makes a
  wrap-up call that carries its suggestions (an empty one when there are none) and then writes its full
  final answer as the last message of the turn; the steps before the wrap-up fold into "Worked". If a
  model still writes its answer first and only a short line after the wrap-up, the answer is shown in
  full, not folded. When a turn the user started ends without a wrap-up, Litch starts one short reminder
  turn (a light line "Reminded the model to wrap up"). Device settings: `sessions.wrapUp` (on by default)
  turns the wrap-up off for sessions created afterwards (the model then suggests cards only when it sees
  fit, and nothing is reminded); `sessions.wrapUpReminder` (on by default, no effect while
  `sessions.wrapUp` is off) switches the reminder, at once. **Task cards** can be switched off per
  harness with the device setting `harness.<id>.taskCards` (on by default, for example
  `scripts/litch settings set <device> harness.pi.taskCards=false`): sessions of that harness then get
  no suggested-task cards, no new-session offers, no wrap-up and no reminder, at once and in running
  sessions too; the model still starts sub-sessions when you ask and hands off tasks. Started cards
  show the harness and folder the sub-session actually got. The mobile app shows the same cards and a
  per-session list (the "N suggested tasks waiting for you" bar at the top of a conversation, or the menu).
- **New task or here**: when the user asks for something unrelated to the current session (after a
  first task has been done in it; the first request is simply what the session is for), the model
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
  A sub-session you stop or archive yourself does not wake the parent either: the report notes it and
  the parent sees it on your next message. A failed or interrupted turn's report carries its error.
  If a sub-session finishes several turns while the parent is busy, only its latest report is handed over.
- **Detach as a standalone session** (session menu or the "Started from …" bar at the top of a
  sub-session) cuts the link.
- **Subagents** started by a harness itself (for example Codex's agents) are not sub-sessions; they show
  in the side panel's Subagents tab and cannot be messaged directly. In Claude Code sessions, Litch stops
  a subagent that shows no activity for 30 minutes; the turn and the other subagents keep running, and
  the model is told that Litch, not you, stopped it.
- **Messages from other Claude sessions**: Claude Code sessions on the same computer can message each
  other (`ListAgents`, `SendMessage`), including the Claude desktop app's sessions and Claude Code in a
  terminal. A message that reaches a Litch session shows as "Message from …" in place of your own
  message (with "Sender skips approvals" when the sender runs tools without asking, and "Open in
  Claude" when it came from a Claude desktop session); an idle session handles it in a turn of its own,
  a busy one right after its current step. On the sending side the step reads "Message …". This is the
  device setting `harness.claude-code.crossSessionInbox` (on by default), and works only between
  sessions on the same computer. A session keeps the same address while Litch restarts its Claude Code
  process. When another Litch session messages one whose process is not running, Litch starts it
  first and the message opens a turn there; from the Claude desktop app or a terminal, the receiving
  session's process has to be running.

The whole feature can be switched per device with the `sessions.enabled` setting
(`scripts/litch settings set <device> sessions.enabled=false`); remote devices need adapter 0.11.0 or
later.
