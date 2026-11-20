import {
  EXTERNAL_IDENTITY_OPTIONAL_SCOPES,
  EXTERNAL_IDENTITY_REQUIRED_SCOPES,
  type ExternalIdentityLogin,
  type ExternalIdentityScope,
} from '../../../protocol/src/external-sources.mjs'
import type { DeviceView } from '../model.mjs'
import type { OpContext, OpSpec } from './context.mjs'
import { getDevice, invalid, newOperation, writing } from './ops-external.mjs'

export function authorizationText(ctx: OpContext, login: ExternalIdentityLogin): string {
  switch (login.state) {
    case 'waiting':
      return ctx.say(
        `授权码：${login.userCode}。请用机器人账号打开 ${login.verificationUrl}。授权页显示 GitHub CLI。登录 ID：${login.loginId}`,
        `Code: ${login.userCode}. Open ${login.verificationUrl} with the bot account. The authorization page shows GitHub CLI. Login ID: ${login.loginId}`,
      )
    case 'succeeded': {
      const result = login.result
      return [
        `@${result.account.login} · ${result.account.userId}`,
        ...(result.scopes.length ? [result.scopes.join(', ')] : []),
        ...result.repositories.map((repo) => `${repo.owner}/${repo.name}`),
        ...(result.repositoriesTruncated
          ? [ctx.say('还有其他仓库。', 'More repositories are available.')]
          : []),
        ...(login.needsConfirmation
          ? [
              ctx.say(
                '这是你的 GitHub 账号，尚未保存。',
                'This is your GitHub account. It has not been saved.',
              ),
            ]
          : []),
      ].join('\n')
    }
    case 'canceled':
      return ctx.say('授权已取消。', 'Authorization canceled.')
    case 'timed_out':
      return ctx.say('授权等待超时。', 'Authorization timed out.')
    case 'expired':
      return ctx.say('授权已过期。', 'Authorization expired.')
    case 'error':
      return ctx.say(`授权失败：${login.code}。`, `Authorization failed: ${login.code}.`)
  }
}

export async function confirmExternalOwner(
  ctx: OpContext,
  device: DeviceView,
  login: ExternalIdentityLogin,
) {
  if (login.state !== 'succeeded' || !login.needsConfirmation) return login
  const name = `@${login.result.account.login}`
  await writing(
    ctx,
    ctx.nameOf(device),
    ctx.say(
      `${name} 是你的 GitHub 账号。若分配给经理，它发的评论会被视为你的评论。确认授权？`,
      `${name} is your GitHub account. If assigned to a manager, its comments will appear to come from you. Authorize it?`,
    ),
  )
  return ctx.run('external.identity.login.confirm', {
    deviceId: device.id,
    loginId: login.loginId,
    expectedRevision: login.revision,
    operationId: newOperation(ctx),
  })
}

const describe = (ctx: OpContext, data: ExternalIdentityLogin) => ({
  text: authorizationText(ctx, data),
  data,
})

export const EXTERNAL_LOGIN_CONFIG_OPS: Record<string, OpSpec> = {
  'device-identity add': {
    args: [0, 0],
    options: ['device', 'scopes'],
    usage: 'device-identity add [--scopes <workflow,read:packages,write:packages>] [--device <id>]',
    summary: {
      zh: '用 GitHub CLI 设备码授权 GitHub 身份',
      en: 'Authorize a GitHub identity with a GitHub CLI device code',
    },
    async run(ctx) {
      const device = await getDevice(ctx)
      const optional = (ctx.cmd.options.get('scopes') ?? '')
        .split(',')
        .map((value) => value.trim())
        .filter(Boolean)
      const scopes = new Set<ExternalIdentityScope>(EXTERNAL_IDENTITY_REQUIRED_SCOPES)
      for (const item of optional) {
        const known = EXTERNAL_IDENTITY_OPTIONAL_SCOPES.find((scope) => scope === item)
        if (known) scopes.add(known)
        else if (!EXTERNAL_IDENTITY_REQUIRED_SCOPES.some((scope) => scope === item))
          throw invalid(ctx, '请使用帮助中列出的权限。', 'Use the scopes listed in help.')
      }
      return describe(
        ctx,
        await ctx.run('external.identity.add', {
          deviceId: device.id,
          operationId: newOperation(ctx),
          scopes: [...scopes],
        }),
      )
    },
  },
  'device-identity import': {
    args: [0, 0],
    options: ['device'],
    usage: 'device-identity import [--device <id>]',
    summary: {
      zh: '导入设备上已登录的 gh 账号',
      en: 'Import the account already signed in to gh on the device',
    },
    async run(ctx) {
      const device = await getDevice(ctx)
      await writing(
        ctx,
        ctx.nameOf(device),
        ctx.say(
          '读取设备已登录的 gh 凭据，核验并保存到 Litch。',
          'Read the signed-in gh credential on the device, verify it, and save it to Litch.',
        ),
      )
      return describe(
        ctx,
        await confirmExternalOwner(
          ctx,
          device,
          await ctx.run('external.identity.import', {
            deviceId: device.id,
            operationId: newOperation(ctx),
          }),
        ),
      )
    },
  },
  'device-identity login': {
    args: [2, 2],
    options: ['device'],
    usage: 'device-identity login status|cancel|confirm <login-id> [--device <id>]',
    summary: {
      zh: '查询、取消或确认身份授权',
      en: 'Check, cancel, or confirm an identity authorization',
    },
    async run(ctx) {
      const device = await getDevice(ctx)
      const [action, loginId = ''] = ctx.cmd.positionals
      const scope = { deviceId: device.id, loginId }
      if (action === 'cancel')
        return describe(
          ctx,
          await ctx.run('external.identity.login.cancel', {
            ...scope,
            operationId: newOperation(ctx),
          }),
        )
      if (action !== 'status' && action !== 'confirm')
        throw invalid(ctx, '请使用 status、cancel 或 confirm。', 'Use status, cancel or confirm.')
      const login = await ctx.run('external.identity.login.get', scope)
      return describe(
        ctx,
        action === 'confirm' ? await confirmExternalOwner(ctx, device, login) : login,
      )
    },
  },
}
