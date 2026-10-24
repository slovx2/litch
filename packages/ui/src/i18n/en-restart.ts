// 重启设备服务的英文文案。键必须和 zh-CN-restart.ts 完全一致，多一句少一句都编译不过。
import type { Entry } from './types.ts'
import type { zhRestart } from './zh-CN-restart.ts'

export const enRestart: Record<keyof typeof zhRestart, Entry> = {
  'restart.settings': 'Settings',
  'restart.menu': 'Restart device service',
  'restart.menu.busy': 'Restarting…',
  'restart.blocked.offline': 'The device isn’t connected',
  'restart.blocked.single': 'Connected to a single harness, not a device service',
  'restart.blocked.managed':
    'Started in the foreground or by a service manager. Restart it the same way.',
  'restart.blocked.upgrading': 'The device service is being upgraded',
  'restart.pill': 'Restarting',
  'restart.confirm.title': 'Restart the device service on {name}?',
  'restart.confirm.note':
    'Work in progress in these conversations will be interrupted and won’t resume on its own:',
  'restart.confirm.turn': 'Turn in progress',
  'restart.confirm.background': ({ count }) =>
    count === 1 ? '1 background task' : `${count} background tasks`,
  'restart.confirm.more': ({ count }) =>
    count === 1 ? '1 more conversation' : `${count} more conversations`,
  'restart.confirm.yes': 'Restart',
  'restart.confirm.no': 'Cancel',
  'restart.busy.title': 'The device service on {name} is busy',
  'restart.busy.note': 'Restarting now interrupts this work:',
  'restart.busy.yes': 'Restart anyway',
  'restart.done': 'Restarted the device service on {name}',
  'restart.done.interrupted': ({ name, count }) =>
    count === 1
      ? `Restarted the device service on ${name}. 1 conversation was interrupted.`
      : `Restarted the device service on ${name}. ${count} conversations were interrupted.`,
  'restart.failed': 'Couldn’t restart the device service on {name}: {reason}',
  'restart.failed.because': '{reason} ({said})',
  'restart.failed.connect': 'Can’t connect to the device',
  'restart.failed.unsupported':
    'The running service doesn’t accept stop requests. End it manually once.',
  'restart.failed.legacy':
    'An older service without the aggregate interface is running. Restart it manually.',
  'restart.failed.stop': 'The device service didn’t stop',
  'restart.failed.start': 'The device service stopped, but the app couldn’t reconnect',
  'restart.failed.stale': 'After reconnecting, the same service is still running',
  'restart.again': 'Retry',
  'restart.note':
    'The device service restarted and interrupted this turn. Send a message to continue.',
} satisfies Record<string, Entry>
