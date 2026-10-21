// litch config 里管设备的几组：devices、tools、machine。落到核心现有的 remote.*、device.*、machine.* 命令。
import { taskCardsSettingKey } from '../../../protocol/src/session-tree.mjs'
import { WIRES } from '../device/remote.mjs'
import type { DeviceView, HarnessView, RemoteCheck, RemoteTarget, WireColor } from '../model.mjs'
import type { ConfigConfirmItem } from '../model-config.mjs'
import type { MachineAccessMode, MachineApproval } from '../model-machine.mjs'
import { ConfigFailure, type OpContext, type OpSpec } from './context.mjs'

export const WIRE_NAMES: readonly WireColor[] = WIRES

/**
 * 命令行里写的连接：带 @ 或冒号的当成主机（user@host:port），别的当成 ssh 配置里的别名
 * （别名原样交给 ssh，写主机名也一样连得上）
 */
export function parseTarget(raw: string): RemoteTarget {
  const text = raw.trim()
  if (!text.includes('@') && !text.includes(':')) return { kind: 'alias', alias: text }
  const at = text.lastIndexOf('@')
  const user = at === -1 ? null : text.slice(0, at)
  const rest = at === -1 ? text : text.slice(at + 1)
  const colon = rest.lastIndexOf(':')
  const host = colon === -1 ? rest : rest.slice(0, colon)
  const port = colon === -1 ? null : Number(rest.slice(colon + 1))
  return { kind: 'host', host, port, user: user || null, keyFile: null }
}

const targetText = (target: RemoteTarget | null): string => {
  if (!target) return 'local'
  if (target.kind === 'alias') return target.alias
  const at = target.user ? `${target.user}@${target.host}` : target.host
  return target.port ? `${at}:${target.port}` : at
}

export const harnessLine = (harness: HarnessView): string => {
  const state =
    harness.state === 'ready'
      ? 'ready'
      : harness.state === 'disabled'
        ? 'disabled'
        : `unavailable${harness.down ? ` (${harness.down})` : ''}`
  return `${harness.id} ${state}${harness.version ? ` ${harness.version}` : ''}`
}

/** --json 时一台设备给出去的样子 */
export const deviceData = (device: DeviceView, name: string) => ({
  id: device.id,
  name,
  host: device.host,
  kind: device.kind,
  target: device.target,
  wire: device.wire,
  connection: device.connection,
  mode: device.mode,
  os: device.os,
  harnesses: device.harnesses.map((entry) => ({
    id: entry.id,
    name: entry.name,
    state: entry.state,
    version: entry.version,
    down: entry.down,
  })),
  tools: device.tools,
  machine: device.machine
    ? {
        enabled: device.machine.enabled,
        approval: device.machine.approval,
        access: device.machine.access.mode,
      }
    : null,
  manageable: device.manageable,
  pairing: device.pairing,
  install: device.install,
})

export const deviceLine = (ctx: OpContext, device: DeviceView): string => {
  const harnesses = device.harnesses.map(harnessLine).join(', ') || '-'
  return `${device.id} "${ctx.nameOf(device)}" ${device.host} · ${device.connection} (${device.mode}) · harnesses: ${harnesses}`
}

const checkText = (ctx: OpContext, check: RemoteCheck): string => {
  if (check.ok) {
    const harnesses = 'harnesses' in check && check.harnesses ? check.harnesses : []
    return ctx.say(
      `能连上：对面是${check.peer === 'service' ? ' Litch 设备服务' : '原生 Codex'} ${check.version}${check.system ? `（${check.system}）` : ''}${harnesses.length ? `，harness：${harnesses.map(harnessLine).join('，')}` : ''}`,
      `Reachable: ${check.peer === 'service' ? 'Litch device service' : 'native Codex'} ${check.version}${check.system ? ` (${check.system})` : ''}${harnesses.length ? `, harnesses: ${harnesses.map(harnessLine).join(', ')}` : ''}`,
    )
  }
  const failure = check.failure
  return ctx.say(
    `连不上（${failure.stage}）${failure.detail ? `：${failure.detail}` : ''}。只能加已经能免密登录的 ssh 目标：口令、首次核对主机指纹、配钥匙要用户自己在终端里做好。`,
    `Not reachable (${failure.stage})${failure.detail ? `: ${failure.detail}` : ''}. Only ssh targets that already log in without a password can be added: passwords, first-time host key checks and key setup must be done by the user in a terminal.`,
  )
}

const wireOf = (ctx: OpContext, value: string | undefined): WireColor | undefined => {
  if (value === undefined) return undefined
  if (!WIRE_NAMES.includes(value as WireColor)) {
    throw new ConfigFailure(
      'invalid',
      ctx.say(
        `没有这种线色：${value}。可选：${WIRE_NAMES.join('、')}`,
        `Unknown wire color: ${value}. Choose one of: ${WIRE_NAMES.join(', ')}`,
      ),
    )
  }
  return value as WireColor
}

const remoteOnly = (ctx: OpContext, device: DeviceView) => {
  if (device.kind !== 'ssh') {
    throw new ConfigFailure(
      'invalid',
      ctx.say('本机设备不能这样改。', 'The local device cannot be changed this way.'),
    )
  }
}

const done = (ctx: OpContext, data?: unknown) => ({ text: ctx.say('好了。', 'Done.'), data })

/**
 * 任务卡开关（设备设置 harness.<id>.taskCards）要写哪几项、对着哪个版本写。
 * 给了 harness 只写它的，没给写这台设备上声明了这一项的全部 harness
 */
async function taskCardEdits(
  ctx: OpContext,
  device: DeviceView,
  harness: string | undefined,
): Promise<{ version: number; keys: string[] }> {
  if (device.connection !== 'online' || !device.manageable) {
    throw new ConfigFailure(
      'invalid',
      ctx.say(
        '任务卡开关存在设备上：这台设备要连着、有设置接口才改得了。',
        'Task cards are stored on the device: it must be online and have the settings interface.',
      ),
    )
  }
  const manage = await ctx.first({ kind: 'manage', deviceId: device.id })
  const wanted = harness === undefined ? device.harnesses.map((entry) => entry.id) : [harness]
  const keys = wanted
    .map((id) => taskCardsSettingKey(id))
    .filter((key) => manage.settings.some((spec) => spec.key === key))
  if (keys.length === 0) {
    throw new ConfigFailure(
      'invalid',
      ctx.say(
        '这台设备的设备服务还没有任务卡开关，先升级它。',
        'The device service on this device has no task-card switch yet; update it first.',
      ),
    )
  }
  return { version: manage.snapshot.version, keys }
}

export const DEVICE_OPS: Record<string, OpSpec> = {
  'devices list': {
    args: [0, 0],
    usage: 'devices list',
    summary: {
      zh: '列出设备和各自的 harness、连接状态',
      en: 'List devices with their harnesses and connection state',
    },
    async run(ctx) {
      const devices = await ctx.devices()
      return {
        text: devices.map((device) => deviceLine(ctx, device)).join('\n'),
        data: devices.map((device) => deviceData(device, ctx.nameOf(device))),
      }
    },
  },
  'devices check': {
    args: [1, 1],
    usage: 'devices check <ssh-alias|user@host[:port]>',
    summary: { zh: '先连过去看一眼对面有什么，不加', en: 'Probe an ssh target without adding it' },
    async run(ctx) {
      const check = await ctx.run('remote.check', {
        target: parseTarget(ctx.cmd.positionals[0] ?? ''),
      })
      return { text: checkText(ctx, check), data: check }
    },
  },
  'devices add': {
    args: [0, 1],
    options: ['target', 'name', 'wire'],
    usage: 'devices add --target <ssh-alias|user@host[:port]> [--name <name>] [--wire <color>]',
    summary: {
      zh: '先检查能不能免密连上，再加一台远程设备',
      en: 'Check the ssh target, then add it as a remote device',
    },
    async run(ctx) {
      const raw = ctx.cmd.options.get('target') ?? ctx.cmd.positionals[0]
      if (!raw) {
        throw new ConfigFailure('invalid', ctx.say('要给 --target。', 'Pass --target.'))
      }
      const target = parseTarget(raw)
      const wire = wireOf(ctx, ctx.cmd.options.get('wire'))
      const check = await ctx.run('remote.check', { target })
      if (!check.ok) throw new ConfigFailure('failed', checkText(ctx, check), check)
      const name = ctx.cmd.options.get('name')
      const { deviceId } = await ctx.run('device.add', {
        target,
        name: name ?? '',
        ...(wire ? { wire } : {}),
      })
      return {
        text: ctx.say(
          `加好了：${deviceId}（${targetText(target)}）。${checkText(ctx, check)}`,
          `Added ${deviceId} (${targetText(target)}). ${checkText(ctx, check)}`,
        ),
        data: { deviceId, check },
      }
    },
  },
  'devices rename': {
    args: [2, 2],
    usage: 'devices rename <device> <new-name>',
    summary: { zh: '改远程设备的名字', en: 'Rename a remote device' },
    async run(ctx) {
      const device = await ctx.device(ctx.cmd.positionals[0])
      remoteOnly(ctx, device)
      await ctx.run('device.update', { deviceId: device.id, name: ctx.cmd.positionals[1] ?? '' })
      return done(ctx)
    },
  },
  'devices wire': {
    args: [2, 2],
    usage: `devices wire <device> <${WIRE_NAMES.join('|')}>`,
    summary: { zh: '换设备的线色', en: 'Change the device wire color' },
    async run(ctx) {
      const device = await ctx.device(ctx.cmd.positionals[0])
      const wire = wireOf(ctx, ctx.cmd.positionals[1])
      await ctx.run('device.update', { deviceId: device.id, ...(wire ? { wire } : {}) })
      return done(ctx)
    },
  },
  'devices target': {
    args: [2, 2],
    usage: 'devices target <device> <ssh-alias|user@host[:port]>',
    summary: {
      zh: '改远程设备怎么连（先检查新的能不能连上）',
      en: 'Change how a remote device connects (checked first)',
    },
    async run(ctx) {
      const device = await ctx.device(ctx.cmd.positionals[0])
      remoteOnly(ctx, device)
      const target = parseTarget(ctx.cmd.positionals[1] ?? '')
      const check = await ctx.run('remote.check', { target })
      if (!check.ok) throw new ConfigFailure('failed', checkText(ctx, check), check)
      await ctx.run('device.update', { deviceId: device.id, target })
      return done(ctx, { check })
    },
  },
  'devices reconnect': {
    args: [1, 1],
    usage: 'devices reconnect <device>',
    summary: { zh: '丢掉现在的连接重连一次', en: 'Drop the connection and reconnect' },
    async run(ctx) {
      const device = await ctx.device(ctx.cmd.positionals[0])
      await ctx.run('device.reconnect', { deviceId: device.id })
      return done(ctx)
    },
  },
  'devices remove': {
    args: [1, 1],
    usage: 'devices remove <device>',
    summary: {
      zh: '移除远程设备（撤不回，要用户在桌面端点允许）',
      en: 'Remove a remote device (irreversible; the user allows it on the desktop)',
    },
    async run(ctx) {
      const device = await ctx.device(ctx.cmd.positionals[0])
      remoteOnly(ctx, device)
      await ctx.confirm([{ kind: 'erase', what: 'device', device: ctx.nameOf(device), name: null }])
      await ctx.run('device.remove', { deviceId: device.id })
      return done(ctx)
    },
  },
  'tools set': {
    args: [1, 1],
    options: ['harness', 'task-cards', 'browser', 'computer', 'machine'],
    usage:
      'tools set <device> [--harness <id>] [--task-cards on|off] [--browser on|off] [--computer on|off] [--machine on|off]',
    summary: {
      zh: '这台设备（给了 --harness 只改这个 harness）的会话能不能用任务卡、内置浏览器、Computer Use，远程设备能不能操作这台电脑（不分 harness）。不给 --harness 时整台设备的各 harness 一起改；打开 Computer Use、操作这台电脑要用户在桌面端点允许',
      en: 'Let sessions on a device (only one harness with --harness) use task cards, the built-in browser or Computer Use, and let a remote device use this computer (not per harness). Without --harness every harness on the device changes together; turning on Computer Use or this computer needs the user to allow it on the desktop',
    },
    async run(ctx) {
      const device = await ctx.device(ctx.cmd.positionals[0])
      const harness = ctx.cmd.options.get('harness')
      const taskCards = ctx.switchOf('task-cards')
      const browser = ctx.switchOf('browser')
      const computer = ctx.switchOf('computer')
      const machine = ctx.switchOf('machine')
      if (
        taskCards === undefined &&
        browser === undefined &&
        computer === undefined &&
        machine === undefined
      ) {
        throw new ConfigFailure(
          'invalid',
          ctx.say(
            '至少给一项：--task-cards、--browser、--computer、--machine。',
            'Pass at least one of --task-cards, --browser, --computer, --machine.',
          ),
        )
      }
      if (harness !== undefined && !device.harnesses.some((entry) => entry.id === harness)) {
        throw new ConfigFailure(
          'invalid',
          ctx.say(
            `这台设备上没有 ${harness}。有：${device.harnesses.map((entry) => entry.id).join('、') || '（没有）'}`,
            `No such harness on this device: ${harness}. Harnesses: ${device.harnesses.map((entry) => entry.id).join(', ') || '(none)'}`,
          ),
        )
      }
      if (harness !== undefined && machine !== undefined) {
        throw new ConfigFailure(
          'invalid',
          ctx.say(
            '“操作这台电脑”不分 harness：去掉 --harness 再改。',
            '"Use this computer" is not per harness: drop --harness to change it.',
          ),
        )
      }
      if (computer !== undefined && device.tools.computer === null) {
        throw new ConfigFailure(
          'invalid',
          ctx.say('这台桌面端没有 Computer Use。', 'This desktop has no Computer Use.'),
        )
      }
      if (machine !== undefined && device.machine === null) {
        throw new ConfigFailure(
          'invalid',
          ctx.say(
            '只有远程设备有“操作这台电脑”，而且这台桌面端要支持。',
            '"Use this computer" exists only for remote devices on a desktop that supports it.',
          ),
        )
      }
      // 任务卡存在设备上：要连着、设备服务认这一项。先查清楚，免得前面几项改了、这一项改不了
      const cards = taskCards === undefined ? null : await taskCardEdits(ctx, device, harness)
      const items: ConfigConfirmItem[] = []
      const name = ctx.nameOf(device)
      // 打开 Computer Use 要点允许：这一回有哪个 harness 是从关到开
      const each = Object.entries(device.tools.harnesses ?? {})
      const computerOff =
        harness === undefined
          ? device.tools.computer !== true || each.some(([, entry]) => !entry.computer)
          : device.tools.harnesses?.[harness]?.computer !== true
      if (computer === true && computerOff)
        items.push({ kind: 'tool', tool: 'computer', device: name })
      if (machine === true && device.machine?.enabled !== true)
        items.push({ kind: 'tool', tool: 'machine', device: name })
      if (items.length > 0) await ctx.confirm(items)
      if (browser !== undefined || computer !== undefined || machine !== undefined) {
        await ctx.run('device.tools.set', {
          deviceId: device.id,
          ...(harness === undefined ? {} : { harness }),
          ...(browser === undefined ? {} : { browser }),
          ...(computer === undefined ? {} : { computer }),
          ...(machine === undefined ? {} : { machine }),
        })
      }
      if (cards && taskCards !== undefined) {
        await ctx.run('device.settings.write', {
          deviceId: device.id,
          expectedVersion: cards.version,
          edits: cards.keys.map((key) => ({ key, value: taskCards })),
        })
      }
      return done(ctx)
    },
  },
  'machine set': {
    args: [1, 1],
    options: ['approval', 'access'],
    usage: 'machine set <device> [--approval session|each|never] [--access sensitive|open|custom]',
    summary: {
      zh: '远程设备操作这台电脑时怎么审批、能碰哪些位置（不问、全放开要用户在桌面端点允许）',
      en: 'How "use this computer" asks and what it may touch (never-ask and open access need the user to allow it on the desktop)',
    },
    async run(ctx) {
      const device = await ctx.device(ctx.cmd.positionals[0])
      if (!device.machine) {
        throw new ConfigFailure(
          'invalid',
          ctx.say(
            '这台设备没有“操作这台电脑”。',
            'This device has no "use this computer" setting.',
          ),
        )
      }
      const approval = ctx.cmd.options.get('approval') as MachineApproval | undefined
      const access = ctx.cmd.options.get('access') as MachineAccessMode | undefined
      if (approval !== undefined && !['session', 'each', 'never'].includes(approval)) {
        throw new ConfigFailure(
          'invalid',
          ctx.say(
            '--approval 只能是 session、each、never。',
            '--approval must be session, each or never.',
          ),
        )
      }
      if (access !== undefined && !['sensitive', 'open', 'custom'].includes(access)) {
        throw new ConfigFailure(
          'invalid',
          ctx.say(
            '--access 只能是 sensitive、open、custom。',
            '--access must be sensitive, open or custom.',
          ),
        )
      }
      if (approval === undefined && access === undefined) {
        throw new ConfigFailure(
          'invalid',
          ctx.say('至少给一项：--approval、--access。', 'Pass --approval or --access.'),
        )
      }
      const name = ctx.nameOf(device)
      const items: ConfigConfirmItem[] = []
      if (approval === 'never' && device.machine.approval !== 'never')
        items.push({ kind: 'approval', device: name, approval })
      if (access === 'open' && device.machine.access.mode !== 'open')
        items.push({ kind: 'access', device: name, access })
      if (items.length > 0) await ctx.confirm(items)
      await ctx.run('device.machine.set', {
        deviceId: device.id,
        ...(approval ? { approval } : {}),
        ...(access ? { access: { mode: access } } : {}),
      })
      return done(ctx)
    },
  },
  'machine log': {
    args: [1, 1],
    usage: 'machine log <device>',
    summary: {
      zh: '这台远程设备在这台电脑上做过什么',
      en: 'What sessions on a remote device did on this computer',
    },
    async run(ctx) {
      const device = await ctx.device(ctx.cmd.positionals[0])
      const { entries } = await ctx.run('machine.log', { deviceId: device.id })
      const lines = entries
        .slice(-50)
        .map(
          (entry) =>
            `${new Date(entry.at).toISOString()} ${entry.tool} ${entry.result}${entry.flagged ? ' (flagged)' : ''}: ${entry.summary}`,
        )
      return { text: lines.join('\n') || ctx.say('没有记录。', 'No entries.'), data: entries }
    },
  },
  'machine log-clear': {
    args: [1, 1],
    usage: 'machine log-clear <device>',
    summary: {
      zh: '清掉操作记录（撤不回，要用户在桌面端点允许）',
      en: 'Clear the log (irreversible; the user allows it on the desktop)',
    },
    async run(ctx) {
      const device = await ctx.device(ctx.cmd.positionals[0])
      await ctx.confirm([
        { kind: 'erase', what: 'machineLog', device: ctx.nameOf(device), name: null },
      ])
      await ctx.run('machine.log.clear', { deviceId: device.id })
      return done(ctx)
    },
  },
}
