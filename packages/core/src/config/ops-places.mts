// litch config 里管设备上的东西的几组：phones（扫码绑定的手机）、projects（项目，代码里叫工作区）、tasks（定时任务）。
import type { TaskSchedule, TaskWeekday } from '../../../protocol/src/device-tasks.mjs'
import type { SidebarView, WorkspaceView } from '../model.mjs'
import type { PairingTopicView } from '../model-pairing.mjs'
import type { TaskPatch, TasksView, TaskView } from '../model-tasks.mjs'
import { ConfigFailure, type OpContext, type OpSpec } from './context.mjs'

const done = (ctx: OpContext, data?: unknown) => ({ text: ctx.say('好了。', 'Done.'), data })

// —— phones ——

const pairable = async (ctx: OpContext) => {
  const device = await ctx.device(ctx.cmd.positionals[0])
  if (!device.pairing) {
    throw new ConfigFailure(
      'invalid',
      ctx.say(
        '这台设备的服务不支持扫码绑定手机。',
        'This device service does not support phone pairing.',
      ),
    )
  }
  return device
}

// —— projects ——

const workspacesOf = async (ctx: OpContext, deviceId: string): Promise<WorkspaceView[]> => {
  const sidebar = await ctx.first({ kind: 'sidebar', deviceId })
  return (sidebar as SidebarView).workspaces
}

const projectOf = (ctx: OpContext, list: WorkspaceView[], arg: string): WorkspaceView => {
  const hit =
    list.find((entry) => entry.id === arg) ??
    list.find((entry) => entry.name.toLowerCase() === arg.toLowerCase()) ??
    list.find((entry) => entry.roots[0] === arg)
  if (hit) return hit
  throw new ConfigFailure(
    'invalid',
    ctx.say(
      `没有这个项目：${arg}。有：${list.map((entry) => entry.name).join('、') || '（没有）'}`,
      `No such project: ${arg}. Projects: ${list.map((entry) => entry.name).join(', ') || '(none)'}`,
    ),
  )
}

// —— tasks ——

const DAYS: Record<string, TaskWeekday> = {
  mo: 'MO',
  mon: 'MO',
  tu: 'TU',
  tue: 'TU',
  we: 'WE',
  wed: 'WE',
  th: 'TH',
  thu: 'TH',
  fr: 'FR',
  fri: 'FR',
  sa: 'SA',
  sat: 'SA',
  su: 'SU',
  sun: 'SU',
}
const TIME = /^([01]?\d|2[0-3]):([0-5]\d)$/

const pad = (time: string) => {
  const [hours = '0', minutes = '00'] = time.split(':')
  return `${hours.padStart(2, '0')}:${minutes}`
}

/**
 * 日程：JSON（和协议的 TaskSchedule 同形），或者简写：
 * once 2026-10-20T09:00 · every 30m · hourly 2[:15] · daily 09:00 · weekdays 09:00 · weekly mon,fri 09:00 · monthly 1 09:00
 */
export function parseSchedule(raw: string): TaskSchedule | null {
  const text = raw.trim()
  if (text.startsWith('{')) {
    try {
      const parsed = JSON.parse(text) as TaskSchedule
      return parsed && typeof parsed === 'object' && typeof parsed.type === 'string' ? parsed : null
    } catch {
      return null
    }
  }
  const [kind = '', ...rest] = text.split(/\s+/)
  const last = rest.at(-1) ?? ''
  switch (kind.toLowerCase()) {
    case 'once':
      return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(last) ? { type: 'once', at: last } : null
    case 'every': {
      const match = /^(\d+)m$/.exec(last)
      return match ? { type: 'interval', minutes: Number(match[1]) } : null
    }
    case 'hourly': {
      const match = /^(\d+)(?::(\d{1,2}))?$/.exec(last)
      return match
        ? {
            type: 'hourly',
            intervalHours: Number(match[1]),
            minute: Number(match[2] ?? 0),
            days: null,
          }
        : null
    }
    case 'daily':
    case 'weekdays':
      return TIME.test(last) ? { type: kind.toLowerCase() as 'daily', time: pad(last) } : null
    case 'weekly': {
      const days = (rest[0] ?? '').split(',').map((day) => DAYS[day.trim().toLowerCase()])
      if (rest.length !== 2 || days.some((day) => !day) || !TIME.test(last)) return null
      return { type: 'weekly', days: days as TaskWeekday[], time: pad(last) }
    }
    case 'monthly': {
      const day = Number(rest[0])
      if (rest.length !== 2 || !Number.isInteger(day) || !TIME.test(last)) return null
      return { type: 'monthly', day, time: pad(last) }
    }
    default:
      return null
  }
}

const scheduleOf = (ctx: OpContext, raw: string): TaskSchedule => {
  const schedule = parseSchedule(raw)
  if (schedule) return schedule
  throw new ConfigFailure(
    'invalid',
    ctx.say(
      `日程认不出：${raw}。写法见 litch config tasks --help。`,
      `Cannot read the schedule: ${raw}. See litch config tasks --help.`,
    ),
  )
}

const tasksOf = async (ctx: OpContext, deviceId: string): Promise<TaskView[]> => {
  const view = (await ctx.first({ kind: 'tasks', deviceId })) as TasksView
  if (view.available === false) {
    throw new ConfigFailure(
      'invalid',
      ctx.say(
        '这台设备的服务不支持定时任务。',
        'This device service does not support scheduled tasks.',
      ),
    )
  }
  return view.tasks
}

const taskOf = (ctx: OpContext, list: TaskView[], arg: string | undefined): TaskView => {
  const key = arg ?? ''
  const hit = list.find((task) => task.id === key) ?? list.find((task) => task.name === key)
  if (hit) return hit
  throw new ConfigFailure('invalid', ctx.say(`没有这个任务：${key}。`, `No such task: ${key}.`))
}

const taskLine = (task: TaskView): string =>
  `${task.id} "${task.name}" ${task.status} · ${JSON.stringify(task.schedule)} · ${task.target.kind === 'thread' ? `thread ${task.target.threadId}` : `new session in ${task.target.cwd}`} (${task.target.harness})${task.nextRunAt ? ` · next ${new Date(task.nextRunAt).toISOString()}` : ''}`

const TASK_OPTIONS = [
  'name',
  'prompt',
  'schedule',
  'timezone',
  'cwd',
  'project',
  'harness',
  'thread',
  'model',
  'effort',
  'permission',
]

export const PLACE_OPS: Record<string, OpSpec> = {
  'phones list': {
    args: [1, 1],
    usage: 'phones list <device>',
    summary: { zh: '这台设备上已绑定的手机', en: 'Phones paired with a device' },
    async run(ctx) {
      const device = await pairable(ctx)
      const { phones } = await ctx.run('pairing.phones', { deviceId: device.id })
      return {
        text:
          phones
            .map((phone) => `${phone.phoneId} "${phone.name}" ${phone.fingerprint}`)
            .join('\n') || ctx.say('没有绑定的手机。', 'No paired phones.'),
        data: phones,
      }
    },
  },
  'phones pair': {
    args: [1, 1],
    options: ['host', 'port', 'user'],
    usage: 'phones pair <device> [--host <host>] [--port <port>] [--user <user>]',
    summary: {
      zh: '在桌面端打开出码对话框（扫码、核对确认码、允许都由人做）',
      en: 'Open the pairing QR dialog on the desktop (the user scans, checks the code and allows)',
    },
    async run(ctx) {
      const device = await pairable(ctx)
      const port = ctx.cmd.options.get('port')
      if (port !== undefined && !/^\d{1,5}$/.test(port)) {
        throw new ConfigFailure('invalid', ctx.say('--port 要是数字。', '--port must be a number.'))
      }
      const host = ctx.cmd.options.get('host')
      const user = ctx.cmd.options.get('user')
      await ctx.ui({
        kind: 'pair',
        deviceId: device.id,
        prefill: {
          ...(host ? { host } : {}),
          ...(port ? { port: Number(port) } : {}),
          ...(user ? { user } : {}),
        },
      })
      return {
        text: ctx.say(
          '已在 Litch 桌面端打开出码对话框。请用手机扫码，并在桌面端核对确认码后点允许。',
          'The pairing dialog is open in the Litch desktop. Ask the user to scan the code with the phone and check the confirmation code on the desktop before allowing it.',
        ),
      }
    },
  },
  'phones revoke': {
    args: [2, 2],
    usage: 'phones revoke <device> <phone-id>',
    summary: {
      zh: '撤掉一部手机的钥匙（不可逆，先问过用户）',
      en: 'Revoke a phone key (irreversible; ask the user first)',
    },
    async run(ctx) {
      const device = await pairable(ctx)
      await ctx.run('pairing.revoke', {
        deviceId: device.id,
        phoneId: ctx.cmd.positionals[1] ?? '',
      })
      return done(ctx)
    },
  },
  'projects list': {
    args: [1, 1],
    usage: 'projects list <device>',
    summary: { zh: '设备上的项目', en: 'Projects on a device' },
    async run(ctx) {
      const device = await ctx.device(ctx.cmd.positionals[0])
      const list = await workspacesOf(ctx, device.id)
      return {
        text:
          list.map((entry) => `${entry.id} "${entry.name}" ${entry.roots.join(', ')}`).join('\n') ||
          ctx.say('没有项目。', 'No projects.'),
        data: list,
      }
    },
  },
  'projects add': {
    args: [2, 2],
    options: ['name'],
    usage: 'projects add <device> <absolute-path> [--name <name>]',
    summary: {
      zh: '在设备上加一个项目（目录要在那台设备上）',
      en: 'Add a project (a directory on that device)',
    },
    async run(ctx) {
      const device = await ctx.device(ctx.cmd.positionals[0])
      const root = ctx.cmd.positionals[1] ?? ''
      const name =
        ctx.cmd.options.get('name') ??
        root
          .replace(/[\\/]+$/, '')
          .split(/[\\/]/)
          .at(-1) ??
        root
      const { workspaceId } = await ctx.run('workspace.create', {
        deviceId: device.id,
        name,
        root,
        color: null,
      })
      return {
        text: ctx.say(`加好了：${workspaceId}。`, `Added ${workspaceId}.`),
        data: { workspaceId },
      }
    },
  },
  'projects remove': {
    args: [2, 2],
    usage: 'projects remove <device> <project>',
    summary: {
      zh: '去掉一个项目（会话和文件都不动）',
      en: 'Remove a project (sessions and files stay)',
    },
    async run(ctx) {
      const device = await ctx.device(ctx.cmd.positionals[0])
      const project = projectOf(
        ctx,
        await workspacesOf(ctx, device.id),
        ctx.cmd.positionals[1] ?? '',
      )
      await ctx.run('workspace.delete', { deviceId: device.id, workspaceId: project.id })
      return done(ctx)
    },
  },
  'tasks list': {
    args: [1, 1],
    usage: 'tasks list <device>',
    summary: { zh: '设备上的定时任务', en: 'Scheduled tasks on a device' },
    async run(ctx) {
      const device = await ctx.device(ctx.cmd.positionals[0])
      const list = await tasksOf(ctx, device.id)
      return {
        text: list.map(taskLine).join('\n') || ctx.say('没有任务。', 'No tasks.'),
        data: list,
      }
    },
  },
  'tasks create': {
    args: [1, 1],
    options: TASK_OPTIONS,
    flags: ['paused'],
    usage:
      'tasks create <device> --name <name> --prompt <text> --schedule <schedule> [--harness <id>] [--cwd <dir>|--project <project>|--thread <session-id>] [--timezone <IANA>] [--model <id>] [--effort <level>] [--permission <id>] [--paused]',
    summary: { zh: '建一个定时任务', en: 'Create a scheduled task' },
    async run(ctx) {
      const device = await ctx.device(ctx.cmd.positionals[0])
      const get = (name: string) => ctx.cmd.options.get(name)
      const name = get('name')
      const prompt = get('prompt')
      const schedule = get('schedule')
      if (!name || !prompt || !schedule) {
        throw new ConfigFailure(
          'invalid',
          ctx.say('要给 --name、--prompt、--schedule。', 'Pass --name, --prompt and --schedule.'),
        )
      }
      const ready = device.harnesses.find((entry) => entry.state === 'ready')
      const harness = get('harness') ?? ready?.id
      if (!harness) {
        throw new ConfigFailure(
          'invalid',
          ctx.say(
            '这台设备上没有可用的 harness，用 --harness 指定。',
            'No harness is ready on this device; pass --harness.',
          ),
        )
      }
      const thread = get('thread')
      let cwd = get('cwd') ?? null
      let workspaceId: string | null = null
      const projectArg = get('project')
      if (projectArg) {
        const project = projectOf(ctx, await workspacesOf(ctx, device.id), projectArg)
        workspaceId = project.id
        cwd = cwd ?? project.roots[0] ?? null
      }
      if (!thread && !cwd) {
        throw new ConfigFailure(
          'invalid',
          ctx.say('要给 --cwd、--project 或 --thread。', 'Pass --cwd, --project or --thread.'),
        )
      }
      const { task } = await ctx.run('tasks.create', {
        deviceId: device.id,
        task: {
          name,
          prompt,
          schedule: scheduleOf(ctx, schedule),
          timezone: get('timezone') ?? null,
          target: thread
            ? { kind: 'thread', harness, threadId: thread }
            : {
                kind: 'newThread',
                harness,
                cwd: cwd ?? '',
                workspaceId,
                settings: {
                  model: get('model') ?? null,
                  effort: get('effort') ?? null,
                  permission: get('permission') ?? null,
                },
              },
          ...(ctx.cmd.flags.has('paused') ? { status: 'paused' as const } : {}),
        },
      })
      return { text: taskLine(task), data: task }
    },
  },
  'tasks update': {
    args: [2, 2],
    options: ['name', 'prompt', 'schedule', 'timezone', 'cwd', 'model', 'effort', 'permission'],
    usage:
      'tasks update <device> <task> [--name] [--prompt] [--schedule] [--timezone] [--cwd] [--model] [--effort] [--permission]',
    summary: { zh: '改一个定时任务', en: 'Change a scheduled task' },
    async run(ctx) {
      const device = await ctx.device(ctx.cmd.positionals[0])
      const task = taskOf(ctx, await tasksOf(ctx, device.id), ctx.cmd.positionals[1])
      const get = (name: string) => ctx.cmd.options.get(name)
      const patch: TaskPatch = {}
      const name = get('name')
      if (name !== undefined) patch.name = name
      const prompt = get('prompt')
      if (prompt !== undefined) patch.prompt = prompt
      const schedule = get('schedule')
      if (schedule !== undefined) patch.schedule = scheduleOf(ctx, schedule)
      const timezone = get('timezone')
      if (timezone !== undefined) patch.timezone = timezone
      const settingsChanged = ['model', 'effort', 'permission'].some(
        (key) => get(key) !== undefined,
      )
      if (get('cwd') !== undefined || settingsChanged) {
        if (task.target.kind !== 'newThread') {
          throw new ConfigFailure(
            'invalid',
            ctx.say(
              '在已有会话里接着发的任务改不了目录和模型。',
              'Tasks that continue an existing session have no directory or model to change.',
            ),
          )
        }
        const was = task.target.settings
        const cwd = get('cwd')
        patch.target = {
          ...(cwd !== undefined ? { cwd } : {}),
          ...(settingsChanged
            ? {
                settings: {
                  model: get('model') ?? was.model,
                  effort: get('effort') ?? was.effort,
                  permission: get('permission') ?? was.permission,
                },
              }
            : {}),
        }
      }
      if (Object.keys(patch).length === 0) {
        throw new ConfigFailure('invalid', ctx.say('没有要改的。', 'Nothing to change.'))
      }
      const { task: next } = await ctx.run('tasks.update', {
        deviceId: device.id,
        taskId: task.id,
        revision: task.revision,
        patch,
      })
      return { text: taskLine(next), data: next }
    },
  },
  'tasks pause': {
    args: [2, 2],
    usage: 'tasks pause <device> <task>',
    summary: {
      zh: '暂停（不按日程跑，还能立即运行）',
      en: 'Pause (no scheduled runs; can still run now)',
    },
    async run(ctx) {
      const device = await ctx.device(ctx.cmd.positionals[0])
      const task = taskOf(ctx, await tasksOf(ctx, device.id), ctx.cmd.positionals[1])
      const { task: next } = await ctx.run('tasks.pause', {
        deviceId: device.id,
        taskId: task.id,
        paused: true,
      })
      return { text: taskLine(next), data: next }
    },
  },
  'tasks resume': {
    args: [2, 2],
    usage: 'tasks resume <device> <task>',
    summary: { zh: '恢复按日程跑', en: 'Resume scheduled runs' },
    async run(ctx) {
      const device = await ctx.device(ctx.cmd.positionals[0])
      const task = taskOf(ctx, await tasksOf(ctx, device.id), ctx.cmd.positionals[1])
      const { task: next } = await ctx.run('tasks.pause', {
        deviceId: device.id,
        taskId: task.id,
        paused: false,
      })
      return { text: taskLine(next), data: next }
    },
  },
  'tasks run': {
    args: [2, 2],
    usage: 'tasks run <device> <task>',
    summary: { zh: '立即运行一次，不影响日程', en: 'Run once now without changing the schedule' },
    async run(ctx) {
      const device = await ctx.device(ctx.cmd.positionals[0])
      const task = taskOf(ctx, await tasksOf(ctx, device.id), ctx.cmd.positionals[1])
      const result = await ctx.run('tasks.runNow', { deviceId: device.id, taskId: task.id })
      return {
        text: ctx.say(
          `${result.deduplicated ? '已经有一次在跑：' : '开始了：'}${result.run.id}（${result.run.status}）`,
          `${result.deduplicated ? 'Already running: ' : 'Started: '}${result.run.id} (${result.run.status})`,
        ),
        data: result,
      }
    },
  },
  'tasks delete': {
    args: [2, 2],
    usage: 'tasks delete <device> <task>',
    summary: {
      zh: '删掉任务和运行记录（不可逆，先问过用户）',
      en: 'Delete a task and its runs (irreversible; ask the user first)',
    },
    async run(ctx) {
      const device = await ctx.device(ctx.cmd.positionals[0])
      const task = taskOf(ctx, await tasksOf(ctx, device.id), ctx.cmd.positionals[1])
      await ctx.run('tasks.delete', { deviceId: device.id, taskId: task.id })
      return done(ctx)
    },
  },
}

/** 一台设备上绑定了几部手机。取不到是 null（status 用） */
export async function phoneCount(ctx: OpContext, deviceId: string): Promise<number | null> {
  try {
    const view = (await ctx.first({ kind: 'pairing', deviceId }, 3000)) as PairingTopicView
    if (view.phones) return view.phones.length
    const { phones } = await ctx.run('pairing.phones', { deviceId })
    return phones.length
  } catch {
    return null
  }
}
