// 经理设置复用设备契约。部分任务分配参数必须先合并最新设置，避免覆盖未指定项。
import {
  MANAGER_DEFAULT_CONTACT,
  MANAGER_DEFAULT_DISPATCH,
} from '../../../protocol/src/manager.mjs'
import type { DeviceView } from '../model.mjs'
import type { ManagerDraft, ManagerEdit, ManagerView } from '../model-manager.mjs'
import { ConfigFailure, clip, type OpContext, type OpSpec } from './context.mjs'

const OPTIONS = [
  'name',
  'rules',
  'line-harness',
  'line-model',
  'line-effort',
  'worktree',
  'merge',
  'max-running',
  'notify',
]
const SUMMARY =
  '--name <name> --rules <text> --line-harness <id> --line-model <id> --line-effort <id> --worktree on|off --merge manager|user --max-running <number> --notify on|off'
const bad = (ctx: OpContext, zh: string, en: string) =>
  new ConfigFailure('invalid', ctx.say(zh, en))

async function list(ctx: OpContext, deviceId: string): Promise<ManagerView[]> {
  const view = await ctx.first({ kind: 'managers', deviceId })
  if (view.available !== true)
    throw bad(
      ctx,
      '设备尚未提供经理功能；请检查连接与设备版本',
      'Managers are not available; check the connection and device version',
    )
  return view.managers
}

async function resolve(ctx: OpContext, deviceId: string): Promise<ManagerView> {
  const id = ctx.cmd.positionals[1]
  const rows = await list(ctx, deviceId)
  const exact = rows.find((manager) => manager.id === id)
  const names = rows.filter((manager) => manager.name === id)
  if (exact) return exact
  if (names.length === 1 && names[0]) return names[0]
  throw bad(
    ctx,
    '经理不存在或名称不唯一；请先列出经理并使用标识',
    'Manager missing or name ambiguous; list managers and use an id',
  )
}

const result = (data: unknown) => ({ text: JSON.stringify(data), data })

const settingsStamp = (manager: ManagerView) =>
  JSON.stringify({
    name: manager.name,
    rules: manager.rules,
    dispatch: manager.dispatch,
    contact: manager.contact,
    status: manager.status,
  })

function expands(before: ManagerView, next: ManagerEdit): boolean {
  const dispatch = next.dispatch
  if (!dispatch) return false
  return (
    dispatch.maxRunningLines > before.dispatch.maxRunningLines ||
    (dispatch.harness ?? before.harness) !== (before.dispatch.harness ?? before.harness) ||
    (before.dispatch.merge === 'user' && dispatch.merge === 'manager') ||
    (before.dispatch.worktree && !dispatch.worktree)
  )
}

async function confirm(
  ctx: OpContext,
  device: DeviceView,
  manager: Pick<ManagerDraft, 'name' | 'rules' | 'cwd' | 'harness' | 'dispatch'>,
  action: 'create' | 'dispatch',
  firstTask = false,
) {
  const name = (id: string) => device.harnesses.find((entry) => entry.id === id)?.name ?? id
  await ctx.confirm([
    {
      kind: 'manager',
      action,
      name: manager.name,
      rules: clip(manager.rules.replace(/\s+/g, ' ').trim(), 240),
      device: ctx.nameOf(device),
      cwd: manager.cwd,
      harness: name(manager.harness),
      lineHarness: name(manager.dispatch.harness ?? manager.harness),
      maxRunning: manager.dispatch.maxRunningLines,
      worktree: manager.dispatch.worktree,
      merge: manager.dispatch.merge,
      firstTask,
    },
  ])
}

function patch(ctx: OpContext, current: Pick<ManagerDraft, 'dispatch' | 'contact'>): ManagerEdit {
  const options = ctx.cmd.options
  const edit: ManagerEdit = {}
  for (const name of ['name', 'rules'] as const) {
    const value = options.get(name)
    if (value !== undefined) edit[name] = value
  }
  const dispatch = { ...current.dispatch }
  let changed = false
  for (const name of ['harness', 'model', 'effort'] as const) {
    const value = options.get(`line-${name}`)
    if (value !== undefined) {
      dispatch[name] = value || null
      changed = true
    }
  }
  // 换工作线 harness 时未指定的型号/强度清空，和界面一致。
  if (options.has('line-harness') && dispatch.harness !== current.dispatch.harness) {
    if (!options.has('line-model')) dispatch.model = null
    if (!options.has('line-effort')) dispatch.effort = null
  } else if (
    options.has('line-model') &&
    dispatch.model !== current.dispatch.model &&
    !options.has('line-effort')
  ) {
    dispatch.effort = null
  }
  const worktree = ctx.switchOf('worktree')
  if (worktree !== undefined) {
    dispatch.worktree = worktree
    changed = true
  }
  const merge = options.get('merge')
  if (merge !== undefined) {
    if (merge !== 'manager' && merge !== 'user')
      throw bad(ctx, '合并方式只能是 manager 或 user', '--merge must be manager or user')
    dispatch.merge = merge
    changed = true
  }
  const maximum = options.get('max-running')
  if (maximum !== undefined) {
    const number = Number(maximum)
    if (!Number.isSafeInteger(number) || number < 1)
      throw bad(ctx, '并行数必须是正整数', '--max-running must be a positive integer')
    dispatch.maxRunningLines = number
    changed = true
  }
  if (changed) edit.dispatch = dispatch
  const desktopNotification = ctx.switchOf('notify')
  if (desktopNotification !== undefined) edit.contact = { ...current.contact, desktopNotification }
  return edit
}

export const MANAGER_OPS: Record<string, OpSpec> = {
  'managers list': {
    args: [1, 1],
    usage: 'managers list <device>',
    summary: { zh: '列出设备上的经理及其设置', en: 'List managers and their settings on a device' },
    async run(ctx) {
      return result(await list(ctx, (await ctx.device(ctx.cmd.positionals[0])).id))
    },
  },
  'managers get': {
    args: [2, 2],
    usage: 'managers get <device> <manager>',
    summary: {
      zh: '读取一个经理的设定、任务分配和通知',
      en: 'Read a manager’s instructions, dispatch and notifications',
    },
    async run(ctx) {
      return result(await resolve(ctx, (await ctx.device(ctx.cmd.positionals[0])).id))
    },
  },
  'managers set': {
    args: [2, 2],
    options: OPTIONS,
    usage: `managers set <device> <manager> [${SUMMARY}]`,
    summary: {
      zh: '修改经理设置；扩大派活能力需桌面确认，不改变已有工作线',
      en: 'Change manager settings; expanding dispatch needs desktop confirmation; existing worklines stay unchanged',
    },
    async run(ctx) {
      const device = await ctx.device(ctx.cmd.positionals[0])
      const manager = await resolve(ctx, device.id)
      if (manager.status !== 'active')
        throw bad(ctx, '结束中或已结束的经理不可修改', 'Ending or ended managers are read-only')
      const edit = patch(ctx, manager)
      if (Object.keys(edit).length === 0)
        throw bad(ctx, '至少给一项设置', 'Pass at least one setting')
      if (expands(manager, edit)) {
        const stamp = settingsStamp(manager)
        await confirm(ctx, device, { ...manager, ...edit }, 'dispatch')
        if (settingsStamp(await resolve(ctx, device.id)) !== stamp)
          throw bad(
            ctx,
            '确认期间经理设置已改变，请重新读取后再修改',
            'Manager settings changed during confirmation; read them again before editing',
          )
      }
      return result(
        (
          await ctx.run('managers.update', {
            deviceId: device.id,
            managerId: manager.id,
            patch: edit,
          })
        ).manager,
      )
    },
  },
  'managers create': {
    args: [1, 1],
    options: [...OPTIONS, 'cwd', 'harness', 'model', 'effort', 'first-task'],
    usage: `managers create <device> --cwd <path> --harness <id> [--model <id>] [--effort <id>] [--first-task <text>] [${SUMMARY}]`,
    summary: {
      zh: '新建经理并授权自主派活（需桌面确认）；首个任务留空时仅制定计划',
      en: 'Create a manager authorized to dispatch work (desktop confirmation required); an empty first task only plans',
    },
    async run(ctx) {
      const device = await ctx.device(ctx.cmd.positionals[0])
      const get = (name: string) => ctx.cmd.options.get(name)
      const cwd = get('cwd')?.trim()
      const harness = get('harness')
      if (
        !cwd ||
        !harness ||
        !device.harnesses.some((item) => item.id === harness && item.state === 'ready')
      )
        throw bad(
          ctx,
          '需要工作目录和设备上可用的 harness 标识；请先运行 harness list',
          'Pass --cwd and a ready harness id from harness list',
        )
      const manager: ManagerDraft = {
        cwd,
        harness,
        model: get('model') || null,
        effort: get('effort') || null,
        name: '',
        scope: '',
        template: 'blank',
        rules: '',
        firstTask: get('first-task') ?? '',
        dispatch: { ...MANAGER_DEFAULT_DISPATCH },
        contact: { ...MANAGER_DEFAULT_CONTACT },
      }
      Object.assign(manager, patch(ctx, manager))
      await confirm(ctx, device, manager, 'create', Boolean(manager.firstTask.trim()))
      return result(await ctx.run('managers.create', { deviceId: device.id, manager }))
    },
  },
}
