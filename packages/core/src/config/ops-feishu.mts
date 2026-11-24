// litch config 的飞书应用操作。App Secret 不经命令行输入：新应用用创建向导，手动填写和换 Secret 在桌面端做。
import type { FeishuApp } from '../../../protocol/src/feishu.mjs'
import type { OpContext, OpSpec } from './context.mjs'
import { getDevice, invalid, newOperation, writing } from './ops-external.mjs'

const options = ['device'] as const

function line(app: FeishuApp): string {
  const manager = app.managerId ?? '-'
  const state = app.enabled ? app.connection.state : 'disabled'
  return `${app.appId} · ${app.name} · ${manager} · ${state}`
}

async function apps(ctx: OpContext, deviceId: string): Promise<FeishuApp[]> {
  const view = await ctx.first({ kind: 'feishuDevice', deviceId })
  if (!view.apps.available || !view.apps.value)
    throw invalid(
      ctx,
      '设备尚未提供飞书功能；请检查连接与设备版本。',
      'Feishu is not available on this device; check the connection and device version.',
    )
  return view.apps.value
}

async function appOf(ctx: OpContext, deviceId: string): Promise<FeishuApp> {
  const id = ctx.cmd.positionals[0]
  const rows = await apps(ctx, deviceId)
  const exact = rows.find((app) => app.appId === id)
  const named = rows.filter((app) => app.name === id)
  if (exact) return exact
  if (named.length === 1 && named[0]) return named[0]
  throw invalid(
    ctx,
    '应用不存在或名称不唯一；请先列出应用并使用 App ID。',
    'App missing or name ambiguous; list apps and use the App ID.',
  )
}

async function update(
  ctx: OpContext,
  patch: { managerId?: string | null; enabled?: boolean },
  detail: string,
) {
  const device = await getDevice(ctx)
  const app = await appOf(ctx, device.id)
  await writing(ctx, ctx.nameOf(device), detail.replace('{app}', `${app.name} (${app.appId})`))
  const data = await ctx.run('feishu.app.update', {
    deviceId: device.id,
    appId: app.appId,
    expectedRevision: app.revision,
    ...patch,
  })
  return { text: line(data.app), data }
}

export const FEISHU_CONFIG_OPS: Record<string, OpSpec> = {
  'feishu-app list': {
    args: [0, 0],
    options,
    usage: 'feishu-app list [--device <id>]',
    summary: { zh: '列出设备上的飞书应用', en: 'List Feishu apps on a device' },
    async run(ctx) {
      const device = await getDevice(ctx)
      const data = await apps(ctx, device.id)
      return {
        text: data.map(line).join('\n') || ctx.say('没有飞书应用。', 'No Feishu apps.'),
        data: { apps: data },
      }
    },
  },
  'feishu-app register': {
    args: [1, 1],
    options,
    usage: 'feishu-app register <bot-name> [--device <id>]',
    summary: { zh: '开始创建向导，返回飞书创建页地址', en: 'Start the app creation wizard' },
    async run(ctx) {
      const device = await getDevice(ctx)
      const name = (ctx.cmd.positionals[0] ?? '').trim()
      if (!name || [...name].length > 30)
        throw invalid(
          ctx,
          '机器人名不能为空，最多 30 个字。',
          'The bot name must be 1–30 characters.',
        )
      await writing(
        ctx,
        ctx.nameOf(device),
        ctx.say(`在飞书创建机器人“${name}”。`, `Create the Feishu bot “${name}”.`),
      )
      const data = await ctx.run('feishu.app.register.begin', {
        deviceId: device.id,
        operationId: newOperation(ctx),
        name,
      })
      const { registration } = data
      return {
        text: [
          `${registration.registrationId} · ${registration.state}`,
          registration.url ?? '',
          ctx.say(
            '在浏览器打开上面的地址完成创建；用 feishu-app registration 查看结果。',
            'Open the address above to finish; check the result with feishu-app registration.',
          ),
        ]
          .filter(Boolean)
          .join('\n'),
        data,
      }
    },
  },
  'feishu-app registration': {
    args: [1, 1],
    options,
    usage: 'feishu-app registration <registration-id> [--device <id>]',
    summary: { zh: '查看创建向导的结果', en: 'Show the creation wizard result' },
    async run(ctx) {
      const device = await getDevice(ctx)
      const data = await ctx.run('feishu.app.register.get', {
        deviceId: device.id,
        registrationId: ctx.cmd.positionals[0] ?? '',
      })
      const { registration } = data
      return {
        text: [registration.state, registration.appId, registration.error]
          .filter(Boolean)
          .join(' · '),
        data,
      }
    },
  },
  'feishu-app assign': {
    args: [2, 2],
    options,
    usage: 'feishu-app assign <app-id> <manager-id|none> [--device <id>]',
    summary: { zh: '把应用分配给经理', en: 'Assign an app to a manager' },
    async run(ctx) {
      const target = ctx.cmd.positionals[1] ?? ''
      const managerId = target === 'none' ? null : target
      return update(
        ctx,
        { managerId },
        managerId
          ? ctx.say(`把 {app} 分配给经理 ${managerId}。`, `Assign {app} to manager ${managerId}.`)
          : ctx.say('取消 {app} 的经理分配。', 'Unassign {app}.'),
      )
    },
  },
  'feishu-app enable': {
    args: [1, 1],
    options,
    usage: 'feishu-app enable <app-id> [--device <id>]',
    summary: { zh: '启用应用（连上飞书）', en: 'Enable an app' },
    run: (ctx) => update(ctx, { enabled: true }, ctx.say('启用 {app}。', 'Enable {app}.')),
  },
  'feishu-app disable': {
    args: [1, 1],
    options,
    usage: 'feishu-app disable <app-id> [--device <id>]',
    summary: { zh: '停用应用（断开飞书）', en: 'Disable an app' },
    run: (ctx) => update(ctx, { enabled: false }, ctx.say('停用 {app}。', 'Disable {app}.')),
  },
  'feishu-app check': {
    args: [1, 1],
    options,
    usage: 'feishu-app check <app-id> [--device <id>]',
    summary: { zh: '检查应用的权限、事件和回调', en: 'Check app scopes, events and callbacks' },
    async run(ctx) {
      const device = await getDevice(ctx)
      const app = await appOf(ctx, device.id)
      const data = await ctx.run('feishu.app.check', { deviceId: device.id, appId: app.appId })
      const capability = data.app.capability
      return {
        text: capability
          ? [
              capability.state,
              ...capability.missingScopes,
              ...capability.missingEvents,
              ...capability.missingCallbacks,
            ].join('\n')
          : 'unknown',
        data,
      }
    },
  },
  'feishu-app upgrade': {
    args: [1, 1],
    options,
    usage: 'feishu-app upgrade <app-id> [--device <id>]',
    summary: {
      zh: '补申请缺少的权限并提交发布',
      en: 'Request missing scopes and submit a version',
    },
    async run(ctx) {
      const device = await getDevice(ctx)
      const app = await appOf(ctx, device.id)
      await writing(
        ctx,
        ctx.nameOf(device),
        ctx.say(
          `为 ${app.name} 补申请缺少的权限、事件和回调，并提交新版本给企业管理员审核。`,
          `Request the missing scopes, events and callbacks for ${app.name} and submit a new version for admin review.`,
        ),
      )
      const data = await ctx.run('feishu.app.upgrade', {
        deviceId: device.id,
        appId: app.appId,
        operationId: newOperation(ctx),
      })
      return { text: data.app.capability?.publish?.state ?? data.app.capability?.state ?? '', data }
    },
  },
  'feishu-app remove': {
    args: [1, 1],
    options,
    usage: 'feishu-app remove <app-id> [--device <id>]',
    summary: {
      zh: '移除应用并删除保存的 App Secret',
      en: 'Remove an app and its stored App Secret',
    },
    async run(ctx) {
      const device = await getDevice(ctx)
      const app = await appOf(ctx, device.id)
      await writing(
        ctx,
        ctx.nameOf(device),
        ctx.say(
          `移除 ${app.name} (${app.appId})：断开飞书，删除设备上保存的 App Secret。不可撤销。`,
          `Remove ${app.name} (${app.appId}): disconnect and delete the stored App Secret. This cannot be undone.`,
        ),
      )
      const data = await ctx.run('feishu.app.remove', {
        deviceId: device.id,
        appId: app.appId,
        expectedRevision: app.revision,
      })
      return { text: ctx.say('已移除。', 'Removed.'), data }
    },
  },
}
