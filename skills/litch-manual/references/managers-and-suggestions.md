# Managers and suggested tasks

## Managers

A manager is a conversation that coordinates worklines (sub-sessions), maintains decisions and items
on a board stored on its device, and reports progress. Repository changes remain the evidence for
what has landed. Managers and their worklines appear in the desktop sidebar's **Managers** view;
ordinary sessions appear in **Chat**. The phone can read manager events and workline conversations,
but has no manager board or manager settings page.

### Where and how to create one

Switch the sidebar to Managers → **New manager**. The form has three steps:

1. **Basic information**: optional name, **Manager settings** (custom instructions), and first task.
2. **Environment**: device, project or working folder, manager harness, model and reasoning effort.
   A folder and a ready harness are required.
3. **Assignment and notifications**: workline harness/model/effort, whether code work gets its own
   worktree, who merges it, maximum running worklines and desktop decision notifications.

Previous returns to an earlier step without losing input. Create is on the final step; invalid
values keep the form on the relevant step. A blank name lets the manager name itself. A blank first
task asks it to plan and wait for the user to say to start. Manager settings can contain role,
preferences and project rules, or stay empty. Litch generates its operating rules from the current
dispatch and waiting settings; those generated rules are not a text field to edit.

Defaults: worklines inherit the manager's harness/model/effort, share its folder, and are reviewed and
merged by the manager; separate worktrees are off, maximum running worklines is **4**, desktop
notifications are on, and unanswered decisions wait indefinitely. Changing workline harness without
choosing a model or effort uses that harness's defaults. Workline concurrency includes the entire
subtree; approvals and background work also occupy slots.

### Editing settings

Open a manager → title-bar **Settings**. The same three sections are tabs. You can change its name,
custom Manager settings, workline dispatch and notifications. Device, folder and the manager's own
harness/model/effort are read-only after creation; there is no first-task field. Saving dispatch or
notifications preserves custom instructions and does not change existing worklines. Invalid
concurrency selects the dispatch tab; a failed save keeps the form. Cancel discards edits. Ending and
ended managers are read-only. Instruction changes leave a “Manager settings updated” event in the
conversation. Creation, board answers and ending have their own event labels as well.

### Commands

Run `scripts/litch status` first; use real device and manager ids returned by these reads:

```sh
scripts/litch managers list local
scripts/litch managers get local <manager-id>
scripts/litch managers set local <manager-id> --rules 'Review changes and report unverified work.'
scripts/litch managers set local <manager-id> --notify on --max-running 4 --worktree on --merge manager
scripts/litch managers create local --cwd /path/to/project --harness pi --first-task 'Prepare a plan.'
scripts/litch open managers
```

`get` and `set` also accept a unique manager name. Use `scripts/litch managers --help` for all flags.
`--line-harness`, `--line-model` and `--line-effort` set workline defaults; an empty string resets an
override. Changing one field preserves others. Verify with `managers get` after saving. These are
configuration commands; answering a decision and ending a manager remain explicit board actions.

Creating a manager authorizes it to dispatch work autonomously, including during event-driven turns.
The command therefore always shows a desktop confirmation card before creating anything. It names
the manager, summarizes custom instructions, and shows the device, folder, manager/workline harness,
concurrency limit, worktree/merge choices and whether a first task was supplied. Declining creates
nothing. Even with a blank first task, creation still requires confirmation.

Reads and ordinary edits (name, custom instructions, notifications or lower concurrency) execute
directly. Increasing concurrency, changing the effective workline harness, moving merge responsibility
from the user to the manager, or disabling separate worktrees requires the same confirmation.
Harness permissions cannot be reliably ranked, so any effective workline-harness change asks.
Declining leaves settings unchanged. If settings changed while the card was open, the command fails
instead of overwriting them; read again and retry the intended change.

### Board and decisions

The manager page has the conversation beside **Overview**, **Decisions**, **Items** and **Work lines**.
Narrow windows switch between Chat and Board. Opening Files covers the board; the info rail is hidden.
Overview separates blocked items from unblocked items assigned to the user. Work lines open their
conversations; **Back to manager** returns. Clicking an item's decision id opens that decision,
including the appropriate answered or closed group.

Choose an option or write an answer. Answers are local drafts until **Submit to manager**; they do
not sync before submission. Submitting saves them to the device and asks the manager to handle them.
Successful drafts clear; failed ones remain. If a decision changed, review its new version before
confirming. **Clear drafts** only clears local unsent answers. Closed decisions can be reopened.
You may also answer explicitly in the manager conversation. Recorded links and evidence do not
automatically become stale or verified; there is no automatic deadline/default-answer execution.

**End manager** asks for confirmation, makes chat and board read-only during final tasks, then moves
the manager into Ended when its final turn stops. Unfinished items remain recorded. The manager may
archive its own completed, landed or abandoned worklines without asking again; running or pinned
sessions remain. This does not authorize archiving unrelated sessions. There is no takeover action.

### Common questions

- **Where are the rules?** Put custom instructions in Settings → Basic information → Manager settings. Automatic
  operating rules come from Assignment and notifications. There is no separate editable Scope field.
- **Why no notification?** See the manager-notification rules in `appearance-and-preferences.md`.
- **Why did the sidebar switch?** Chat and Managers remember separate positions for this app run.
  Opening a session from a notification, link or activity switches to its owning view. See
  `sessions-and-projects.md` for revealing its row.
- **Cannot edit or create?** Connect the device and use a version supporting managers. The runtime
  must be ready, the working directory must exist, and concurrency must be a positive integer.

## Suggested tasks

A suggestion is a proposed task, not work already started and not a manager board item. Its card
offers **Start**, **Edit and start**, **Do it here**, and **Dismiss**. The brief shows the background and
task; expand it before starting. Missing choices inherit from the parent at the time you start it
(a different harness uses its own model/effort defaults). Worktree behavior and session authorization
are in `sessions-and-projects.md`.

### Where and how to use them

The desktop sidebar's **Suggestions** entry shows pending ordinary suggestions across devices with
a count, alongside Tasks, Appearance and Settings in the bottom row. Cards automatically form a
multi-column grid when space allows and return to one column in narrow windows. They show the
title, brief, source conversation, project/device and creation time, with the
same actions as the original card. A manager board's **Suggestions from this manager’s lines**
opens this list filtered to that manager's whole subtree; switch back to all suggestions there.
Instant “New session / Do it here” offers are not included. The side panel also lists suggestions
for the current session; the phone has only the per-session list.

Handled, withdrawn and expired suggestions leave the list; history stays in the source conversation.
Offline devices keep the last snapshot, but actions need a connection. An archived source is marked
and opens as a read-only preview. Click the source conversation's name and arrow to open it;
**Back to list** or Escape returns from an archived preview to the same suggestion list and filter.
**Do it here** first restores it and its worktree; a failed restore
leaves the suggestion pending. Deleting the source withdraws its pending cards.

### Configuration and common questions

`scripts/litch open suggestions` opens the global list. Retention is per device, in Devices → the
device → Session orchestration → Suggestion retention. Its values, commands and expiration behavior
are in `device-settings.md`. Task cards can be switched per harness with
`scripts/litch tools set <device> --harness <id> --task-cards on|off`.

No suggestions visible: check the manager filter, source device's connection and task-card switch,
and whether the cards were handled or expired. Increasing retention does not restore expired cards.
