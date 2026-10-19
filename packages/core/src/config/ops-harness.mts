// litch config 里管设备设置和 harness 的几组：settings、harness、diagnose。落到设备的设置接口
// （manage 主题、device.settings.write）和 device.harness.restart、device.diagnostics.run、device.logs.read、device.sshConfig.read。
// 设置有哪些、是什么类型由设备服务声明，执行器和界面一样不认识具体的设置项，按类型转值。

import { harnessIdOf } from '../device/harness.mjs'
import type { DeviceView, HarnessView } from '../model.mjs'
import type {
  EnvEntryView,
  LogSource,
  ManageView,
  SettingEditView,
  SettingSpecView,
  SettingValueView,
} from '../model-manage.mjs'
import { parseSwitch } from './argv.mjs'
import { ConfigFailure, clip, type OpContext, type OpSpec } from './context.mjs'
import { harnessLine } from './ops-devices.mjs'

const manageOf = async (ctx: OpContext, device: DeviceView): Promise<ManageView> => {
  if (!device.manageable) {
    throw new ConfigFailure(
      'invalid',
      ctx.say(
        '这台设备没有设置接口（单 harness 的入口或旧版的设备服务）。',
        'This device has no settings interface (a single-harness entry or an old device service).',
      ),
    )
  }
  return (await ctx.first({ kind: 'manage', deviceId: device.id }, 10_000)) as ManageView
}

const valueText = (spec: SettingSpecView, value: SettingValueView): string => {
  if (value === null || value === undefined) return '(default)'
  if (spec.type === 'secret') return (value as { set?: boolean }).set ? '(set)' : '(not set)'
  if (Array.isArray(value)) {
    return `[${(value as EnvEntryView[]).map((entry) => (entry.secret ? `${entry.name}=(secret)` : `${entry.name}=${entry.value ?? ''}`)).join(', ')}]`
  }
  return JSON.stringify(value)
}

const specLine = (ctx: OpContext, manage: ManageView, spec: SettingSpecView, detail: boolean) => {
  const value = manage.snapshot.values[spec.key] ?? null
  const scope = spec.scope.kind === 'harness' ? ` [${spec.scope.harness}]` : ''
  const head = `${spec.key}${scope} = ${valueText(spec, value)} (${spec.type}${spec.options.length ? `: ${spec.options.map((option) => option.value).join('|')}` : ''}${spec.minimum !== null || spec.maximum !== null ? `, ${spec.minimum ?? ''}..${spec.maximum ?? ''}` : ''}${spec.restart === 'harness' ? ', restarts harness' : ''}) — ${ctx.said(spec.title)}`
  return detail ? `${head}\n  ${ctx.said(spec.description)}` : head
}

/** 环境变量表：JSON 数组，或者 NAME=VALUE 用分号隔开 */
const envOf = (raw: string): EnvEntryView[] | null => {
  const text = raw.trim()
  if (text === '') return []
  if (text.startsWith('[')) {
    try {
      const list = JSON.parse(text) as EnvEntryView[]
      return Array.isArray(list) && list.every((entry) => typeof entry?.name === 'string')
        ? list
        : null
    } catch {
      return null
    }
  }
  const entries: EnvEntryView[] = []
  for (const part of text.split(';')) {
    if (!part.trim()) continue
    const eq = part.indexOf('=')
    if (eq <= 0) return null
    entries.push({ name: part.slice(0, eq).trim(), value: part.slice(eq + 1) })
  }
  return entries
}

/** 命令行写的一个值按设置的类型转。key= 留空是清掉、回到默认值 */
const editOf = (ctx: OpContext, spec: SettingSpecView, raw: string): SettingEditView => {
  const bad = (why: string, whyEn: string) =>
    new ConfigFailure('invalid', ctx.say(`${spec.key}：${why}`, `${spec.key}: ${whyEn}`))
  if (raw === '' && spec.type !== 'env') return { key: spec.key, value: null }
  switch (spec.type) {
    case 'boolean': {
      const value = parseSwitch(raw)
      if (value === null) throw bad('要写 on 或 off', 'use on or off')
      return { key: spec.key, value }
    }
    case 'integer': {
      const value = Number(raw)
      if (!Number.isInteger(value)) throw bad('要是整数', 'must be an integer')
      if (
        (spec.minimum !== null && value < spec.minimum) ||
        (spec.maximum !== null && value > spec.maximum)
      ) {
        throw bad(
          `要在 ${spec.minimum ?? '-∞'} 到 ${spec.maximum ?? '∞'} 之间`,
          `must be between ${spec.minimum ?? '-∞'} and ${spec.maximum ?? '∞'}`,
        )
      }
      return { key: spec.key, value }
    }
    case 'enum':
      if (!spec.options.some((option) => option.value === raw)) {
        throw bad(
          `只能是 ${spec.options.map((option) => option.value).join('、')}`,
          `must be one of ${spec.options.map((option) => option.value).join(', ')}`,
        )
      }
      return { key: spec.key, value: raw }
    case 'env': {
      const value = envOf(raw)
      if (!value)
        throw bad(
          '写成 NAME=VALUE;NAME2=VALUE2 或 JSON 数组',
          'use NAME=VALUE;NAME2=VALUE2 or a JSON array',
        )
      return { key: spec.key, value }
    }
    case 'string':
    case 'path':
    case 'secret':
      return { key: spec.key, value: raw }
    default:
      throw bad(
        `这一版 Litch 不认识 ${spec.type} 类型，改不了`,
        `this Litch does not know the ${spec.type} type`,
      )
  }
}

const harnessOf = (ctx: OpContext, device: DeviceView, arg: string | undefined): HarnessView => {
  const id = arg ?? ''
  // 认界面的标识（claude）、适配器的引擎名（claude-code）和显示名
  const hit = device.harnesses.find(
    (entry) =>
      entry.id === id ||
      entry.id === harnessIdOf(id) ||
      entry.name.toLowerCase() === id.toLowerCase(),
  )
  if (hit) return hit
  throw new ConfigFailure(
    'invalid',
    ctx.say(
      `这台设备上没有这个 harness：${id}。有：${device.harnesses.map((entry) => entry.id).join('、')}`,
      `No such harness on this device: ${id}. Harnesses: ${device.harnesses.map((entry) => entry.id).join(', ')}`,
    ),
  )
}

const writeResult = (
  ctx: OpContext,
  result: { changed: string[]; restarted: string[]; pendingRestart: string[] },
) => ({
  text: ctx.say(
    `改了：${result.changed.join('、') || '（没有变化）'}${result.restarted.length ? `；已重启：${result.restarted.join('、')}` : ''}${result.pendingRestart.length ? `；有回合在跑，等着重启：${result.pendingRestart.join('、')}` : ''}`,
    `Changed: ${result.changed.join(', ') || '(nothing)'}${result.restarted.length ? `; restarted: ${result.restarted.join(', ')}` : ''}${result.pendingRestart.length ? `; waiting to restart (turns running): ${result.pendingRestart.join(', ')}` : ''}`,
  ),
  data: result,
})

/** 启用开关（设备服务标了 enable 角色的那一项）开或关 */
const toggleHarness = async (ctx: OpContext, on: boolean) => {
  const device = await ctx.device(ctx.cmd.positionals[0])
  const harness = harnessOf(ctx, device, ctx.cmd.positionals[1])
  const manage = await manageOf(ctx, device)
  const spec = manage.settings.find(
    (entry) =>
      entry.role === 'enable' &&
      entry.scope.kind === 'harness' &&
      entry.scope.harness === harness.id,
  )
  if (!spec) {
    throw new ConfigFailure(
      'invalid',
      ctx.say(`${harness.id} 没有启用开关。`, `${harness.id} has no enable switch.`),
    )
  }
  const result = await ctx.run('device.settings.write', {
    deviceId: device.id,
    expectedVersion: manage.snapshot.version,
    edits: [{ key: spec.key, value: on }],
  })
  return writeResult(ctx, result)
}

const LOG_SOURCES: readonly LogSource[] = ['device', 'service', 'runtime', 'diagnostics']

export const HARNESS_OPS: Record<string, OpSpec> = {
  'settings get': {
    args: [1, 2],
    usage: 'settings get <device> [key]',
    summary: {
      zh: '设备的设置：每一项的键、现值、类型和说明',
      en: 'Device settings: key, value, type and description of each',
    },
    async run(ctx) {
      const device = await ctx.device(ctx.cmd.positionals[0])
      const manage = await manageOf(ctx, device)
      const key = ctx.cmd.positionals[1]
      const specs = key ? manage.settings.filter((spec) => spec.key === key) : manage.settings
      if (key && specs.length === 0) {
        throw new ConfigFailure('invalid', ctx.say(`没有这一项：${key}`, `No such setting: ${key}`))
      }
      return {
        text: [
          `version ${manage.snapshot.version}`,
          ...specs.map((spec) => specLine(ctx, manage, spec, Boolean(key))),
        ].join('\n'),
        data: {
          version: manage.snapshot.version,
          settings: specs.map((spec) => ({
            ...spec,
            value: manage.snapshot.values[spec.key] ?? null,
          })),
          pendingRestart: manage.snapshot.pendingRestart,
        },
      }
    },
  },
  'settings set': {
    args: [2, 64],
    usage: 'settings set <device> <key>=<value> [<key>=<value> …]   (key= resets to default)',
    summary: {
      zh: '改设备的设置（一次写入，全有或全无）',
      en: 'Change device settings (one all-or-nothing write)',
    },
    async run(ctx) {
      const device = await ctx.device(ctx.cmd.positionals[0])
      const manage = await manageOf(ctx, device)
      const edits = ctx.cmd.positionals.slice(1).map((pair) => {
        const eq = pair.indexOf('=')
        const key = eq <= 0 ? pair : pair.slice(0, eq)
        const spec = manage.settings.find((entry) => entry.key === key)
        if (eq <= 0 || !spec) {
          throw new ConfigFailure(
            'invalid',
            ctx.say(
              `认不出：${pair}（要写成 键=值，键见 settings get）`,
              `Cannot read ${pair} (use key=value; keys are in settings get)`,
            ),
          )
        }
        return editOf(ctx, spec, pair.slice(eq + 1))
      })
      const result = await ctx.run('device.settings.write', {
        deviceId: device.id,
        expectedVersion: manage.snapshot.version,
        edits,
      })
      return writeResult(ctx, result)
    },
  },
  'harness list': {
    args: [1, 1],
    usage: 'harness list <device>',
    summary: {
      zh: '设备上的 harness：状态、版本、用不了的原因',
      en: 'Harnesses on a device: state, version, why unavailable',
    },
    async run(ctx) {
      const device = await ctx.device(ctx.cmd.positionals[0])
      return {
        text:
          device.harnesses
            .map(
              (entry) =>
                `${harnessLine(entry)} — ${entry.name}${entry.detail ? `: ${clip(ctx.said(entry.detail))}` : ''}`,
            )
            .join('\n') ||
          ctx.say('还不知道（设备没连上过）。', 'Not known yet (the device has not connected).'),
        data: device.harnesses,
      }
    },
  },
  'harness enable': {
    args: [2, 2],
    usage: 'harness enable <device> <harness>',
    summary: {
      zh: '启用一个 harness（settings set 的快捷写法）',
      en: 'Enable a harness (shortcut for settings set)',
    },
    run: (ctx) => toggleHarness(ctx, true),
  },
  'harness disable': {
    args: [2, 2],
    usage: 'harness disable <device> <harness>',
    summary: { zh: '停用一个 harness', en: 'Disable a harness' },
    run: (ctx) => toggleHarness(ctx, false),
  },
  'harness restart': {
    args: [2, 2],
    flags: ['force'],
    usage: 'harness restart <device> <harness> [--force]',
    summary: {
      zh: '重启一个 harness（有回合在跑时不动，--force 照样重启）',
      en: 'Restart a harness (refuses while turns run unless --force)',
    },
    async run(ctx) {
      const device = await ctx.device(ctx.cmd.positionals[0])
      const harness = harnessOf(ctx, device, ctx.cmd.positionals[1])
      const result = await ctx.run('device.harness.restart', {
        deviceId: device.id,
        harness: harness.id,
        ...(ctx.cmd.flags.has('force') ? { force: true } : {}),
      })
      return {
        text: result.running
          ? ctx.say(`${harness.id} 在运行了。`, `${harness.id} is running.`)
          : ctx.say(
              `${harness.id} 没起来：${ctx.said(result.text)}`,
              `${harness.id} did not start: ${ctx.said(result.text)}`,
            ),
        data: result,
      }
    },
  },
  'diagnose run': {
    args: [1, 1],
    options: ['harness'],
    usage: 'diagnose run <device> [--harness <id>]',
    summary: { zh: '在设备上跑一遍诊断', en: 'Run diagnostics on a device' },
    async run(ctx) {
      const device = await ctx.device(ctx.cmd.positionals[0])
      const harness = ctx.cmd.options.get('harness')
      const result = await ctx.run('device.diagnostics.run', {
        deviceId: device.id,
        ...(harness ? { harness } : {}),
      })
      return {
        text: result.checks
          .map(
            (check) =>
              `${check.status} ${check.id}${check.scope.kind === 'harness' ? ` [${check.scope.harness}]` : ''}: ${ctx.said(check.title)}${check.detail ? ` — ${ctx.said(check.detail)}` : ''}${check.logPath ? ` (${check.logPath})` : ''}`,
          )
          .join('\n'),
        data: result,
      }
    },
  },
  'diagnose logs': {
    args: [1, 1],
    options: ['harness', 'source', 'bytes'],
    usage:
      'diagnose logs <device> [--source device|service|runtime|diagnostics] [--harness <id>] [--bytes <n>]',
    summary: { zh: '读设备上日志的末尾', en: 'Read the tail of a log on the device' },
    async run(ctx) {
      const device = await ctx.device(ctx.cmd.positionals[0])
      const harness = ctx.cmd.options.get('harness')
      const source = (ctx.cmd.options.get('source') ??
        (harness ? 'runtime' : 'device')) as LogSource
      if (!LOG_SOURCES.includes(source)) {
        throw new ConfigFailure(
          'invalid',
          ctx.say(
            `--source 只能是 ${LOG_SOURCES.join('、')}`,
            `--source must be one of ${LOG_SOURCES.join(', ')}`,
          ),
        )
      }
      const bytes = Number(ctx.cmd.options.get('bytes') ?? 16_384)
      const result = await ctx.run('device.logs.read', {
        deviceId: device.id,
        source,
        ...(harness ? { harness } : {}),
        maxBytes: Number.isFinite(bytes) && bytes > 0 ? Math.min(bytes, 262_144) : 16_384,
      })
      return {
        text: `${result.path}${result.truncated ? ' (tail)' : ''}\n${result.text}`,
        data: result,
      }
    },
  },
  'diagnose ssh-config': {
    args: [1, 1],
    usage: 'diagnose ssh-config <device>',
    summary: {
      zh: '给官方 Codex 桌面端用的 ssh 配置片段',
      en: 'ssh config snippet for the official Codex desktop',
    },
    async run(ctx) {
      const device = await ctx.device(ctx.cmd.positionals[0])
      const result = await ctx.run('device.sshConfig.read', { deviceId: device.id })
      const missing = result.entries
        .filter((entry) => entry.config === null)
        .map((entry) => `# ${entry.harness}: ${ctx.said(entry.unavailable)}`)
      return { text: [result.text, ...missing].filter(Boolean).join('\n'), data: result }
    },
  },
}
