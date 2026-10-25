// 后台任务的英文文案。键必须和 zh-CN-background.ts 完全一致，多一句少一句都编译不过。
import type { Entry } from './types.ts'
import type { zhBackground } from './zh-CN-background.ts'

const plural = (n: string | number | undefined, one: string, many: string) =>
  `${n} ${Number(n) === 1 ? one : many}`

export const enBackground: Record<keyof typeof zhBackground, Entry> = {
  'side.tab.background': 'Background',
  'background.bar': ({ count }) =>
    `${plural(count, 'background task', 'background tasks')} running`,
  'background.barOpen': 'Show background tasks on the right',
  'background.barClose': 'Hide background tasks',
  'background.inTurn': ({ count }) => `${count} running in the background`,
  'background.sidebar': ({ count }) =>
    `${plural(count, 'background task', 'background tasks')} running`,
  'sidebar.tally.background': ({ count }) => `${count} with background tasks`,
  'background.running': 'Running',
  'background.ended': 'Finished',
  'background.none': 'No background tasks running',
  'background.noneEver':
    'No background tasks in this session. Commands still running after a turn ends, subagents, and sub-sessions appear here.',
  'background.pick': 'Open a session to see its background tasks.',
  'background.wakes': 'Continues automatically when done',
  'background.noWake': 'Doesn’t continue automatically',
  'background.status.running': 'Running',
  'background.status.completed': 'Done',
  'background.status.failed': 'Failed',
  'background.status.stopped': 'Stopped',
  'background.kind.shell': 'Command',
  'background.kind.agent': 'Subagent',
  'background.kind.monitor': 'Monitor',
  'background.kind.workflow': 'Workflow',
  'background.kind.remote': 'Remote task',
  'background.kind.other': 'Task',
  'background.origin.backgroundTask': 'Background task finished, continuing',
  'background.origin.schedule': 'Started by a scheduled task',
  'background.origin.goal': 'Goal not met yet, continuing',
  'background.origin.queue': 'Queued message, sent automatically',
  'background.origin.peer': 'Message from another session',
  // Background tasks and subagents share one tab (subagents and sub-sessions count as background tasks)
  'background.stop': 'Stop',
  'background.stop.title': 'Stop this background task',
  'background.stopping': 'Stopping',
  'background.output.none': 'No output yet',
  'background.output.unknown': 'Output for this command isn’t available',
  'fault.backgroundStop':
    'Couldn’t stop this background task. It may have already finished, or this harness can’t stop it on its own',
}
