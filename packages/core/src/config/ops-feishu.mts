// litch config 的飞书应用操作。App Secret 不经命令行输入：新应用用创建向导，手动填写和换 Secret 在桌面端做。
import {
  FEISHU_RETENTION_DAYS,
  FEISHU_REVIEW_TTL_HOURS,
  type FeishuApp,
  type FeishuChat,
  type FeishuSpeechMode,
} from '../../../protocol/src/feishu.mjs'
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

// —— 群 ——

function chatLine(ctx: OpContext, chat: FeishuChat): string {
  const state = chat.access
    ? chat.access.speech === 'free'
      ? ctx.say('已接入·自由发言', 'accessed·free')
      : ctx.say('已接入·审批发言', 'accessed·approval')
    : ctx.say('未接入', 'not accessed')
  const marks = [
    chat.external ? ctx.say('外部群', 'external') : '',
    chat.botPresent ? '' : ctx.say('机器人已不在群里', 'bot removed'),
    chat.status === 'dissolved' ? ctx.say('已解散', 'dissolved') : '',
  ].filter(Boolean)
  return [chat.chatId, chat.name, state, ...marks].join(' · ')
}

async function chatsOf(ctx: OpContext, deviceId: string, appId: string): Promise<FeishuChat[]> {
  const view = await ctx.first({ kind: 'feishuChats', deviceId, appId })
  return view.value?.chats ?? []
}

/** 第二个位置参数是群：chat_id 或唯一的群名 */
async function chatOf(ctx: OpContext, deviceId: string, appId: string): Promise<FeishuChat> {
  const id = ctx.cmd.positionals[1]
  const rows = await chatsOf(ctx, deviceId, appId)
  const exact = rows.find((chat) => chat.chatId === id)
  const named = rows.filter((chat) => chat.name === id)
  if (exact) return exact
  if (named.length === 1 && named[0]) return named[0]
  throw invalid(
    ctx,
    '群不存在或名称不唯一；请先列出群并使用 chat_id。',
    'Chat missing or name ambiguous; list chats and use the chat_id.',
  )
}

function speechOf(ctx: OpContext): FeishuSpeechMode | undefined {
  const value = ctx.cmd.options.get('speech')
  if (value === undefined) return undefined
  if (value === 'free' || value === 'approval') return value
  throw invalid(ctx, '--speech 只能是 free 或 approval。', '--speech must be free or approval.')
}

function intOption(ctx: OpContext, name: string, range: { min: number; max: number }) {
  const raw = ctx.cmd.options.get(name)
  if (raw === undefined) return undefined
  const value = Number(raw)
  if (!Number.isSafeInteger(value) || value < range.min || value > range.max)
    throw invalid(
      ctx,
      `--${name} 要在 ${range.min} 到 ${range.max} 之间。`,
      `--${name} must be between ${range.min} and ${range.max}.`,
    )
  return value
}

/** --wakers 逗号分隔的成员名或 open_id，按当前成员表解析；名字不唯一就报错，不猜 */
async function wakersOf(
  ctx: OpContext,
  deviceId: string,
  appId: string,
  chatId: string,
): Promise<string[] | undefined> {
  const raw = ctx.cmd.options.get('wakers')
  if (raw === undefined) return undefined
  const wanted = raw
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
  if (!wanted.length) return []
  const { members } = await ctx.run('feishu.chat.members', { deviceId, appId, chatId })
  return wanted.map((item) => {
    const byId = members.find((member) => member.openId === item)
    const byName = members.filter((member) => member.name === item)
    if (byId) return byId.openId
    if (byName.length === 1 && byName[0]) return byName[0].openId
    throw invalid(
      ctx,
      `叫醒名单里的“${item}”不是群成员或重名；请用 feishu-chat members 查 open_id。`,
      `“${item}” is not a member or the name is ambiguous; look up the open_id with feishu-chat members.`,
    )
  })
}

const chatOptions = ['device', 'speech', 'wakers', 'retention', 'review-ttl'] as const

const FEISHU_CHAT_OPS: Record<string, OpSpec> = {
  'feishu-chat list': {
    args: [1, 1],
    options,
    flags: ['refresh'],
    usage: 'feishu-chat list <app-id> [--refresh] [--device <id>]',
    summary: { zh: '列出机器人所在的群和接入状态', en: 'List chats the bot is in' },
    async run(ctx) {
      const device = await getDevice(ctx)
      const app = await appOf(ctx, device.id)
      const data = ctx.cmd.flags.has('refresh')
        ? await ctx.run('feishu.chat.list', {
            deviceId: device.id,
            appId: app.appId,
            refresh: true,
          })
        : { chats: await chatsOf(ctx, device.id, app.appId) }
      return {
        text:
          data.chats.map((chat) => chatLine(ctx, chat)).join('\n') ||
          ctx.say('机器人还没进任何群。', 'The bot is not in any chat.'),
        data,
      }
    },
  },
  'feishu-chat members': {
    args: [2, 2],
    options,
    usage: 'feishu-chat members <app-id> <chat> [--device <id>]',
    summary: { zh: '列出群成员（叫醒名单从这里选）', en: 'List chat members' },
    async run(ctx) {
      const device = await getDevice(ctx)
      const app = await appOf(ctx, device.id)
      const chat = await chatOf(ctx, device.id, app.appId)
      const data = await ctx.run('feishu.chat.members', {
        deviceId: device.id,
        appId: app.appId,
        chatId: chat.chatId,
        refresh: true,
      })
      return { text: data.members.map((m) => `${m.openId} · ${m.name}`).join('\n'), data }
    },
  },
  'feishu-chat access': {
    args: [2, 2],
    options: chatOptions,
    flags: ['confirm-external', 'no-wake-bound'],
    usage:
      'feishu-chat access <app-id> <chat> --speech free|approval [--wakers <a,b>] [--no-wake-bound] [--retention <days>] [--review-ttl <hours>] [--confirm-external] [--device <id>]',
    summary: { zh: '接入一个群（必须选发言模式）', en: 'Access a chat (speech mode required)' },
    async run(ctx) {
      const device = await getDevice(ctx)
      const app = await appOf(ctx, device.id)
      const chat = await chatOf(ctx, device.id, app.appId)
      const speech = speechOf(ctx)
      if (!speech)
        throw invalid(
          ctx,
          '接入时必须用 --speech 选发言模式（free 或 approval）。',
          'Choose a speech mode with --speech (free or approval).',
        )
      if (chat.external && !ctx.cmd.flags.has('confirm-external'))
        throw invalid(
          ctx,
          '这是外部群，群里有组织外的人；确认后加 --confirm-external 再接入。',
          'This chat includes people outside the organization; add --confirm-external to proceed.',
        )
      const wakers = (await wakersOf(ctx, device.id, app.appId, chat.chatId)) ?? []
      await writing(
        ctx,
        ctx.nameOf(device),
        ctx.say(
          `接入飞书群“${chat.name}”，${speech === 'free' ? '自由发言（经理发言不经审批）' : '审批发言'}。`,
          `Access the Feishu chat “${chat.name}” with ${speech === 'free' ? 'free speech (no approval)' : 'approval speech'}.`,
        ),
      )
      const data = await ctx.run('feishu.chat.access', {
        deviceId: device.id,
        appId: app.appId,
        chatId: chat.chatId,
        expectedRevision: chat.revision,
        speech,
        ...(chat.external ? { confirmExternal: true } : {}),
        wakeBound: !ctx.cmd.flags.has('no-wake-bound'),
        wakers,
        retentionDays:
          intOption(ctx, 'retention', FEISHU_RETENTION_DAYS) ?? FEISHU_RETENTION_DAYS.default,
        reviewTtlHours:
          intOption(ctx, 'review-ttl', FEISHU_REVIEW_TTL_HOURS) ?? FEISHU_REVIEW_TTL_HOURS.default,
      })
      return { text: chatLine(ctx, data.chat), data }
    },
  },
  'feishu-chat update': {
    args: [2, 2],
    options: chatOptions,
    flags: ['wake-bound', 'no-wake-bound'],
    usage:
      'feishu-chat update <app-id> <chat> [--speech free|approval] [--wakers <a,b>] [--wake-bound|--no-wake-bound] [--retention <days>] [--review-ttl <hours>] [--device <id>]',
    summary: { zh: '改已接入群的设置', en: 'Change an accessed chat' },
    async run(ctx) {
      const device = await getDevice(ctx)
      const app = await appOf(ctx, device.id)
      const chat = await chatOf(ctx, device.id, app.appId)
      const speech = speechOf(ctx)
      const wakers = await wakersOf(ctx, device.id, app.appId, chat.chatId)
      const retentionDays = intOption(ctx, 'retention', FEISHU_RETENTION_DAYS)
      const reviewTtlHours = intOption(ctx, 'review-ttl', FEISHU_REVIEW_TTL_HOURS)
      const wakeBound = ctx.cmd.flags.has('wake-bound')
        ? true
        : ctx.cmd.flags.has('no-wake-bound')
          ? false
          : undefined
      await writing(
        ctx,
        ctx.nameOf(device),
        ctx.say(
          `修改飞书群“${chat.name}”的接入设置${speech ? `，发言模式改为${speech === 'free' ? '自由发言（经理发言不经审批）' : '审批发言'}` : ''}。`,
          `Change the settings of the Feishu chat “${chat.name}”${speech ? `; speech becomes ${speech === 'free' ? 'free (no approval)' : 'approval'}` : ''}.`,
        ),
      )
      const data = await ctx.run('feishu.chat.update', {
        deviceId: device.id,
        appId: app.appId,
        chatId: chat.chatId,
        expectedRevision: chat.revision,
        ...(speech ? { speech } : {}),
        ...(wakers ? { wakers } : {}),
        ...(wakeBound === undefined ? {} : { wakeBound }),
        ...(retentionDays === undefined ? {} : { retentionDays }),
        ...(reviewTtlHours === undefined ? {} : { reviewTtlHours }),
      })
      return { text: chatLine(ctx, data.chat), data }
    },
  },
  'feishu-chat unaccess': {
    args: [2, 2],
    options,
    flags: ['keep-records'],
    usage: 'feishu-chat unaccess <app-id> <chat> [--keep-records] [--device <id>]',
    summary: { zh: '取消接入；默认同时删除这个群的记录', en: 'Stop accessing a chat' },
    async run(ctx) {
      const device = await getDevice(ctx)
      const app = await appOf(ctx, device.id)
      const chat = await chatOf(ctx, device.id, app.appId)
      const keep = ctx.cmd.flags.has('keep-records')
      await writing(
        ctx,
        ctx.nameOf(device),
        keep
          ? ctx.say(
              `取消接入飞书群“${chat.name}”，记录按保留期清理。`,
              `Stop accessing the Feishu chat “${chat.name}”; records expire on schedule.`,
            )
          : ctx.say(
              `取消接入飞书群“${chat.name}”，并删除这个群的全部记录。不可撤销。`,
              `Stop accessing the Feishu chat “${chat.name}” and delete all its records. This cannot be undone.`,
            ),
      )
      const data = await ctx.run('feishu.chat.unaccess', {
        deviceId: device.id,
        appId: app.appId,
        chatId: chat.chatId,
        expectedRevision: chat.revision,
        deleteRecords: !keep,
      })
      return { text: chatLine(ctx, data.chat), data }
    },
  },
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
  ...FEISHU_CHAT_OPS,
}
