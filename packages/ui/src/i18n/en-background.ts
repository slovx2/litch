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
    'No background tasks in this session yet. Commands still running after a turn ends show up here.',
  'background.pick': 'Open a session to see its background tasks here.',
  'background.wakes': 'Continues automatically when done',
  'background.noWake': 'Does not continue on its own',
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
}
