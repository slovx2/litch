import {
  EXTERNAL_METHOD,
  type ExternalOwnerIdentity,
  type ExternalSourceDraft,
} from '../../../protocol/src/external-sources.mjs'
import { isExternalMethodParams } from '../../../protocol/src/external-validation.mjs'
import type { Commands } from '../channel/protocol.mjs'
import { ConfigFailure, type OpContext, type OpSpec } from './context.mjs'

const options = ['device'] as const
export const newOperation = (ctx: OpContext) =>
  `cli-${ctx.host.clock.now()}-${Math.random().toString(36).slice(2)}`
export const invalid = (ctx: OpContext, zh: string, en: string) =>
  new ConfigFailure('invalid', ctx.say(zh, en))
export const getDevice = (ctx: OpContext) => ctx.device(ctx.cmd.options.get('device') ?? 'local')
const refs = (values: string[]) => values.join(', ')
const who = (owner: ExternalOwnerIdentity) => `@${owner.loginCache} · ${owner.userId}`

const ownerInput = (ctx: OpContext): Commands['external.owner.resolve']['params'] => {
  const value = ctx.cmd.positionals[0]
  if (ctx.cmd.flags.has('local-gh') && value === undefined) return { method: 'localGh' }
  if (!value || ctx.cmd.flags.has('local-gh'))
    throw invalid(
      ctx,
      '请提供 GitHub 主页、数字 ID 或 --local-gh。',
      'Pass a GitHub profile, numeric ID, or --local-gh.',
    )
  return { method: value.startsWith('https://') ? 'profileUrl' : 'userId', value }
}

function draftOf(ctx: OpContext): ExternalSourceDraft {
  const text = ctx.cmd.options.get('draft')
  let raw: unknown
  try {
    raw = JSON.parse(text ?? '')
  } catch {
    /* 确认和报错都不显示命令中的 JSON。 */
  }
  const request = { source: raw }
  if (
    !isExternalMethodParams(EXTERNAL_METHOD.sourcePreview, request) ||
    request.source.writePolicy.managedPush
  )
    throw invalid(
      ctx,
      '请提供有效的来源 JSON。托管推送不受支持。',
      'Pass valid source JSON. Managed push is unavailable.',
    )
  return request.source
}

export const expectedOf = (ctx: OpContext): number => {
  const raw = ctx.cmd.options.get('revision')
  const revision = raw ? Number(raw) : NaN
  if (!raw || !/^\d+$/u.test(raw) || !Number.isSafeInteger(revision))
    throw invalid(
      ctx,
      '请用 --revision 指定查看配置时看到的版本；新来源用 0。',
      'Pass the revision you reviewed with --revision. Use 0 for a new source.',
    )
  return revision
}

export const writing = (ctx: OpContext, device: string, detail: string) =>
  ctx.confirm([{ kind: 'external', device, detail }])

export const EXTERNAL_CONFIG_OPS: Record<string, OpSpec> = {
  'external-owner resolve': {
    args: [0, 1],
    flags: ['local-gh'],
    usage: 'external-owner resolve <profile-url|user-id> | --local-gh',
    summary: { zh: '解析 GitHub 个人账号', en: 'Resolve a GitHub user' },
    async run(ctx) {
      const owner = await ctx.run('external.owner.resolve', ownerInput(ctx))
      return { text: who(owner), data: owner }
    },
  },
  'external-owner get': {
    args: [0, 0],
    options,
    usage: 'external-owner get [--device <id>]',
    summary: { zh: '查看全局账号和设备同步状态', en: 'Show the account and device sync' },
    async run(ctx) {
      if (ctx.cmd.options.has('device')) {
        const device = await getDevice(ctx)
        const data = await ctx.run('external.owner.get', { deviceId: device.id })
        return { text: data.owner ? who(data.owner) : ctx.say('未配置', 'Not configured'), data }
      }
      const global = await ctx.run('external.owner.global.get', {})
      const devices = global
        ? await ctx.run('external.owner.global.plan', { owner: global.owner })
        : []
      return {
        text: global
          ? [who(global.owner), ...devices.map((row) => `${row.deviceId}: ${row.state}`)].join('\n')
          : ctx.say('未配置', 'Not configured'),
        data: { global, devices },
      }
    },
  },
  'external-owner set': {
    args: [0, 1],
    flags: ['local-gh'],
    usage: 'external-owner set <profile-url|user-id> | --local-gh',
    summary: { zh: '设置并确认同步到设备', en: 'Set the account and confirm device sync' },
    async run(ctx) {
      const owner = await ctx.run('external.owner.resolve', ownerInput(ctx))
      const current = await ctx.run('external.owner.global.get', {})
      const plan = await ctx.run('external.owner.global.plan', { owner })
      const pending = plan.flatMap((row) =>
        row.state === 'different' && row.expectedRevision !== null
          ? [{ deviceId: row.deviceId, expectedRevision: row.expectedRevision }]
          : [],
      )
      await writing(
        ctx,
        refs(pending.map((row) => row.deviceId)),
        ctx.say(
          `设置 GitHub 账号 ${who(owner)} 并同步到列出的设备。`,
          `Set ${who(owner)} as the GitHub account and sync it to the listed devices.`,
        ),
      )
      const data = await ctx.run('external.owner.global.set', {
        owner,
        expectedRevision: current?.revision ?? 0,
        operationId: newOperation(ctx),
        devices: pending,
      })
      return {
        text: [who(owner), ...data.devices.map((row) => `${row.deviceId}: ${row.state}`)].join(
          '\n',
        ),
        data,
      }
    },
  },
  'device-source list': {
    args: [0, 0],
    options,
    usage: 'device-source list [--device <id>]',
    summary: { zh: '列出设备外部来源', en: 'List external sources on a device' },
    async run(ctx) {
      const device = await getDevice(ctx)
      const data = await ctx.run('external.source.list', { deviceId: device.id })
      return {
        text:
          data.sources
            .map(
              ({ source, runtime }) =>
                `${source.sourceId} · r${source.revision} · ${runtime?.state ?? (source.enabled ? 'enabled' : 'paused')}`,
            )
            .join('\n') || ctx.say('没有外部来源。', 'No external sources.'),
        data,
      }
    },
  },
  'device-source preview': {
    args: [0, 0],
    options: [...options, 'draft'],
    usage: 'device-source preview --draft <source-json> [--device <id>]',
    summary: {
      zh: '预览来源过去 24 小时的匹配',
      en: 'Preview source matches from the last 24 hours',
    },
    async run(ctx) {
      const device = await getDevice(ctx)
      const data = await ctx.run('external.source.preview', {
        deviceId: device.id,
        source: draftOf(ctx),
      })
      return {
        text: ctx.say(
          `匹配 ${data.matches.length} 项，诊断 ${data.diagnostics.length} 项。`,
          `${data.matches.length} matches, ${data.diagnostics.length} diagnostics.`,
        ),
        data,
      }
    },
  },
  'device-source upsert': {
    args: [0, 0],
    options: [...options, 'draft', 'revision'],
    usage: 'device-source upsert --draft <source-json> --revision <n> [--device <id>]',
    summary: { zh: '保存设备来源策略', en: 'Save a device source policy' },
    async run(ctx) {
      const device = await getDevice(ctx)
      const source = draftOf(ctx)
      const expectedRevision = expectedOf(ctx)
      const preview = await ctx.run('external.source.preview', { deviceId: device.id, source })
      await writing(
        ctx,
        ctx.nameOf(device),
        ctx.say(
          `保存来源 ${source.sourceId}。近 24 小时匹配 ${preview.matches.length} 项，诊断 ${preview.diagnostics.length} 项；仓库：${refs(source.repos.map((one) => `${one.owner}/${one.name}`))}；自动提醒：${source.unattended?.autoNotify ? '开' : '关'}。`,
          `Save ${source.sourceId}. Last 24 hours: ${preview.matches.length} matches, ${preview.diagnostics.length} diagnostics. Repositories: ${refs(source.repos.map((one) => `${one.owner}/${one.name}`))}. Automatic reminders: ${source.unattended?.autoNotify ? 'on' : 'off'}.`,
        ),
      )
      const data = await ctx.run('external.source.upsert', {
        deviceId: device.id,
        source,
        expectedRevision,
        operationId: newOperation(ctx),
      })
      return { text: `${data.source.sourceId} · r${data.source.revision}`, data }
    },
  },
  'device-source check': {
    args: [1, 1],
    options,
    usage: 'device-source check <source-id> [--device <id>]',
    summary: { zh: '检查来源与无人值守就绪状态', en: 'Check source and unattended readiness' },
    async run(ctx) {
      const device = await getDevice(ctx)
      const data = await ctx.run('external.source.check', {
        deviceId: device.id,
        sourceId: ctx.cmd.positionals[0] ?? '',
      })
      return {
        text:
          [
            ...Object.entries(data.readiness ?? {}).map(
              ([name, value]) => `${name}: ${value.state}`,
            ),
            ...data.diagnostics.map((item) => `${item.check}: ${item.state} · ${item.code}`),
            ...(data.agentGhIdentity
              ? [`gh: @${data.agentGhIdentity.login} · ${data.agentGhIdentity.userId}`]
              : []),
          ].join('\n') || ctx.say('未验证', 'Unverified'),
        data,
      }
    },
  },
  ...Object.fromEntries(
    (['pause', 'resume'] as const).map((action): [string, OpSpec] => [
      `device-source ${action}`,
      {
        args: [1, 1],
        options,
        usage: `device-source ${action} <source-id> [--device <id>]`,
        summary:
          action === 'pause'
            ? { zh: '暂停来源', en: 'Pause a source' }
            : { zh: '恢复来源', en: 'Resume a source' },
        async run(ctx) {
          const device = await getDevice(ctx)
          const sourceId = ctx.cmd.positionals[0] ?? ''
          const { source } = await ctx.run('external.source.get', { deviceId: device.id, sourceId })
          if (action === 'resume')
            await writing(
              ctx,
              ctx.nameOf(device),
              ctx.say(`恢复来源 ${sourceId}。`, `Resume source ${sourceId}.`),
            )
          const data = await ctx.run(`external.source.${action}`, {
            deviceId: device.id,
            sourceId,
            expectedRevision: source.revision,
            operationId: newOperation(ctx),
          })
          return { text: `${sourceId} · ${action}`, data }
        },
      },
    ]),
  ),
  'device-autostart status': {
    args: [0, 0],
    options,
    usage: 'device-autostart status [--device <id>]',
    summary: { zh: '查看设备服务自启状态', en: 'Show device service autostart' },
    async run(ctx) {
      const device = await getDevice(ctx)
      const data = await ctx.run('external.autostart.status', { deviceId: device.id })
      return {
        text: `${data.serviceManager}: ${data.state}${data.requiresLogin ? ctx.say('（登录后运行）', ' (runs after sign-in)') : ''}`,
        data,
      }
    },
  },
  ...Object.fromEntries(
    (['enable', 'disable'] as const).map((action): [string, OpSpec] => [
      `device-autostart ${action}`,
      {
        args: [0, 0],
        options,
        flags:
          action === 'enable'
            ? ['takeover', 'allow-linger', 'confirm-stop', 'resume-after-restart']
            : ['confirm-stop', 'resume-after-restart'],
        usage: `device-autostart ${action} [--device <id>] [--confirm-stop] [--resume-after-restart]${action === 'enable' ? ' [--takeover] [--allow-linger]' : ''}`,
        summary:
          action === 'enable'
            ? { zh: '启用设备服务自启', en: 'Enable device service autostart' }
            : { zh: '卸载设备服务自启', en: 'Remove device service autostart' },
        async run(ctx) {
          const device = await getDevice(ctx)
          const status = await ctx.run('external.autostart.status', { deviceId: device.id })
          await writing(
            ctx,
            ctx.nameOf(device),
            ctx.say(
              `${action === 'enable' ? '启用' : '卸载'}设备自启。${ctx.cmd.flags.size ? `选项：${refs([...ctx.cmd.flags])}。` : ''}`,
              `${action === 'enable' ? 'Enable' : 'Remove'} device autostart.${ctx.cmd.flags.size ? ` Options: ${refs([...ctx.cmd.flags])}.` : ''}`,
            ),
          )
          const common = {
            deviceId: device.id,
            expectedRevision: status.revision,
            operationId: newOperation(ctx),
            confirmStop: ctx.cmd.flags.has('confirm-stop'),
            resumeAfterRestart: ctx.cmd.flags.has('resume-after-restart'),
          }
          const data =
            action === 'enable'
              ? await ctx.run('external.autostart.enable', {
                  ...common,
                  takeover: ctx.cmd.flags.has('takeover'),
                  allowLinger: ctx.cmd.flags.has('allow-linger'),
                })
              : await ctx.run('external.autostart.disable', common)
          return {
            text:
              data.state === 'accepted'
                ? ctx.say(
                    '设备已接受；重连后请查看 status 确认实际结果。',
                    'Accepted. Run status after the device reconnects to confirm.',
                  )
                : data.status.state,
            data,
          }
        },
      },
    ]),
  ),
}
