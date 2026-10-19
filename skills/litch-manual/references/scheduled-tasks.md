# Scheduled tasks

A scheduled task sends a prompt to a harness on a schedule. Tasks live **on the device** and the device
service runs them, so they run even when Litch is closed or disconnected (but not while the device
itself is off; it does not start up for them). Remote devices need adapter 0.11.0 or later.

In the UI: sidebar → **Scheduled tasks** (tasks grouped by device, New task, details with past runs);
or a session's menu → "Schedule a task for this session". `scripts/litch open tasks` opens the page.
The Android app can manage them too.

## Commands

Exact flags: `scripts/litch tasks --help`.

- `scripts/litch tasks list` lists tasks (all devices, or one) with schedule, next and last run, state.
- `scripts/litch tasks create` creates one. It needs a device, a name, a prompt, a schedule and what
  happens when it fires (below). It can be created paused.
- `scripts/litch tasks update` changes name, prompt, schedule, time zone or the new-session options.
  The harness and the "new session vs. continue a session" choice cannot be changed after creation:
  create a new task instead (and delete the old one, after asking).
- `scripts/litch tasks pause` / `scripts/litch tasks resume` stop and restart firing on schedule.
- `scripts/litch tasks run` runs a task now (not if a run of it is already going or queued).
- `scripts/litch tasks delete` deletes a task. **Irreversible: ask first.** A run in progress is not
  interrupted, and sessions it created are kept.

## Fields

- **Name** (up to 120 characters) and **prompt** (the message sent each time).
- **Schedule**, one of: once at a date and time; every N minutes (at least 5); every N hours at minute
  M (optionally only on some weekdays); daily at a time; weekdays at a time; weekly on some days at a
  time; monthly on day D at a time (on the last day for months without day D).
- **Time zone**: an IANA name such as `Europe/Berlin`; the default is the **device's** time zone, not
  this computer's. Mention it when the device is in another zone.
- **When it fires**, one of:
  - start a **new session** each time: harness, project (or working folder), model, reasoning effort,
    permissions;
  - **continue an existing session**: the prompt is sent into that session each time.
- **Start paused**.

## Rules worth telling the user

- Missed times (device off, schedules disabled) are run once when possible, recorded as "merged N
  missed runs"; a one-time task still runs once.
- A run is limited to 2 hours. A failed run does not pause the task; a task whose target session is
  gone is paused.
- At most 200 tasks per device. Runs at once per device are limited by `tasks.maxConcurrent` (default
  2); `tasks.enabled` switches all schedules on the device off and on (`device-settings.md`).
- Failed runs always show a system notification on the desktop; successful ones only when the user
  turns that on: `scripts/litch notify task-success` (`appearance-and-preferences.md`).
- Models in Codex, Claude Code, Pi, DSH and OpenCode sessions can manage tasks themselves through their
  `litch_tasks` tools; a task created that way continues the session it was created from by default.
