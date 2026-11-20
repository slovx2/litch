import type { ExternalIdentity } from '../../../protocol/src/external-sources.mjs'
import type { OpContext, OpSpec } from './context.mjs'
import { expectedOf, getDevice, invalid, newOperation, writing } from './ops-external.mjs'
import { authorizationText, confirmExternalOwner } from './ops-external-login.mjs'

function identityText(identity: ExternalIdentity) {
  return `@${identity.login} · ${identity.identityId} · ${identity.botUserId}`
}
const numeric = (value: string) => /^[1-9]\d*$/u.test(value)

async function mutate(
  ctx: OpContext,
  action: 'paste' | 'rotate' | 'revoke',
  identityId?: string,
  credentialRef?: string,
) {
  if (ctx.cmd.flags.has('stdin'))
    throw invalid(
      ctx,
      '--stdin 只支持在目标设备本机运行。',
      '--stdin is available only when run on the target device.',
    )
  const device = await getDevice(ctx)
  const target =
    identityId && credentialRef
      ? `${identityId} / ${credentialRef}`
      : ctx.say('新 GitHub 身份', 'new GitHub identity')
  const args = { deviceId: device.id, operationId: newOperation(ctx) }
  const identity =
    action === 'paste'
      ? null
      : (await ctx.run('external.identity.list', argsOf(device.id))).identities.find(
          (one) => one.identityId === identityId,
        )
  const credential = identity?.credentials.find((one) => one.credentialRef === credentialRef)
  if (action !== 'paste' && (!identity || !credential))
    throw invalid(
      ctx,
      '没有这份凭据。请先查看身份列表。',
      'Credential not found. Check the identity list.',
    )
  const scope =
    identity && credential
      ? {
          ...args,
          identityId: identity.identityId,
          credentialRef: credential.credentialRef,
          expectedGeneration: credential.generation,
        }
      : null
  if (action === 'revoke' && scope) {
    await writing(
      ctx,
      ctx.nameOf(device),
      ctx.say(`撤销 GitHub 凭据 ${target}。`, `Revoke GitHub credential ${target}.`),
    )
    const data = await ctx.run('external.identity.revoke', scope)
    return { text: identityText(data.identity), data }
  }
  const release = ctx.caller.hold()
  try {
    const value = await ctx.ui({ kind: 'external.token', device: ctx.nameOf(device), target })
    if (typeof value !== 'string' || !value || value.length > 4096)
      throw invalid(ctx, '未提供有效令牌。', 'No valid token was entered.')
    if (scope) {
      const data = await ctx.run('external.identity.rotate', { ...scope, token: value })
      return { text: identityText(data.identity), data }
    }
    const login = await ctx.run('external.identity.paste', { ...args, token: value })
    const data = await confirmExternalOwner(ctx, device, login)
    return { text: authorizationText(ctx, data), data }
  } finally {
    release()
  }
}

const argsOf = (deviceId: string) => ({ deviceId })

export const EXTERNAL_IDENTITY_CONFIG_OPS: Record<string, OpSpec> = {
  'device-identity list': {
    args: [0, 0],
    options: ['device'],
    usage: 'device-identity list [--device <id>]',
    summary: {
      zh: '列出 GitHub 身份和公开凭据状态',
      en: 'List GitHub identities and credential status',
    },
    async run(ctx) {
      const device = await getDevice(ctx)
      const data = await ctx.run('external.identity.list', argsOf(device.id))
      return {
        text:
          data.identities
            .flatMap((identity) => [
              identityText(identity),
              ...identity.credentials.map(
                (one) =>
                  `  ${one.credentialRef} · ${one.credentialKind === 'oauth' ? (one.scopes?.join(', ') ?? 'OAuth') : one.resourceOwnerId} · ${one.state} · g${one.generation}`,
              ),
            ])
            .join('\n') || ctx.say('未授权 GitHub 身份。', 'No GitHub identities yet.'),
        data,
      }
    },
  },
  'device-identity repositories': {
    args: [0, 0],
    options: ['device', 'identity', 'cursor'],
    usage: 'device-identity repositories [--identity <id>] [--cursor <cursor>] [--device <id>]',
    summary: {
      zh: '查看 GitHub 身份可访问的仓库',
      en: 'List repositories accessible to GitHub identities',
    },
    async run(ctx) {
      const device = await getDevice(ctx)
      const identityId = ctx.cmd.options.get('identity')
      const cursor = ctx.cmd.options.get('cursor')
      const data = await ctx.run('external.identity.repositories', {
        deviceId: device.id,
        ...(identityId ? { identityId } : {}),
        ...(cursor ? { cursor } : {}),
      })
      return {
        text:
          [
            ...data.repositories.map(
              (repo) =>
                `${repo.repoId} · ${repo.owner}/${repo.name} · ${repo.grants
                  .filter((one) => one.read)
                  .map((grant) => grant.identityId)
                  .join(', ')}`,
            ),
            ...(data.nextCursor ? [`--cursor ${data.nextCursor}`] : []),
          ].join('\n') || ctx.say('没有可访问的仓库。', 'No accessible repositories.'),
        data,
      }
    },
  },
  'device-identity paste': {
    args: [0, 0],
    options: ['device'],
    flags: ['stdin'],
    usage: 'device-identity paste [--device <id>] [--stdin]',
    summary: {
      zh: '高级：安全输入细粒度令牌',
      en: 'Advanced: securely enter a fine-grained token',
    },
    run: (ctx) => mutate(ctx, 'paste'),
  },
  'device-identity rotate': {
    args: [2, 2],
    options: ['device'],
    flags: ['stdin'],
    usage: 'device-identity rotate <identity-id> <credential-ref> [--device <id>] [--stdin]',
    summary: { zh: '安全输入新令牌并轮换凭据', en: 'Rotate a GitHub credential' },
    run: (ctx) => mutate(ctx, 'rotate', ctx.cmd.positionals[0], ctx.cmd.positionals[1]),
  },
  'device-identity revoke': {
    args: [2, 2],
    options: ['device'],
    usage: 'device-identity revoke <identity-id> <credential-ref> [--device <id>]',
    summary: { zh: '撤销指定资源所有者的凭据', en: 'Revoke a resource owner’s credential' },
    run: (ctx) => mutate(ctx, 'revoke', ctx.cmd.positionals[0], ctx.cmd.positionals[1]),
  },
  'device-source credential': {
    args: [1, 3],
    options: ['device'],
    flags: ['stdin'],
    usage:
      'device-source credential configure | rotate <identity-id> <credential-ref> [--device <id>] [--stdin]',
    summary: {
      zh: '配置或轮换 GitHub 身份的凭据',
      en: 'Configure or rotate a GitHub identity credential',
    },
    run(ctx) {
      const [action, identityId, ref] = ctx.cmd.positionals
      if (action === 'configure' && !identityId && !ref) return mutate(ctx, 'paste')
      if (action === 'rotate' && identityId && ref) return mutate(ctx, 'rotate', identityId, ref)
      throw invalid(
        ctx,
        '请使用 configure 或 rotate <身份 ID> <凭据引用>。',
        'Use configure or rotate <identity-id> <credential-ref>.',
      )
    },
  },
  'device-source manager': {
    args: [2, 2],
    options: ['device', 'identity', 'repos', 'inject', 'revision'],
    usage:
      'device-source manager get|set <manager-id> [--identity <id|none> --repos <id,id> --inject on|off --revision <n>] [--device <id>]',
    summary: {
      zh: '查看或保存经理的 GitHub 身份与仓库分配',
      en: 'Read or save a manager’s GitHub assignment',
    },
    async run(ctx) {
      const device = await getDevice(ctx)
      const [action, managerId] = ctx.cmd.positionals as [string, string]
      const args = { deviceId: device.id, managerId }
      if (action === 'get') {
        const data = await ctx.run('external.manager.assignment.get', args)
        return {
          text: `${data.managerId} · ${data.identityId ?? '-'} · ${data.repoIds.join(', ')} · r${data.revision}`,
          data,
        }
      }
      const rawIdentity = ctx.cmd.options.get('identity')
      const repoIds = [
        ...new Set(
          (ctx.cmd.options.get('repos') ?? '')
            .split(',')
            .map((id) => id.trim())
            .filter(Boolean),
        ),
      ]
      if (
        action !== 'set' ||
        !rawIdentity ||
        !repoIds.every(numeric) ||
        (rawIdentity === 'none' && repoIds.length)
      )
        throw invalid(
          ctx,
          '请指定身份和仓库数字 ID；清除分配使用 --identity none。',
          'Pass an identity and numeric repository IDs; use --identity none to clear the assignment.',
        )
      const identityId = rawIdentity === 'none' ? null : rawIdentity
      const expectedRevision = expectedOf(ctx)
      const injectCredentials = ctx.switchOf('inject') ?? true
      await writing(
        ctx,
        ctx.nameOf(device),
        ctx.say(
          `保存经理 ${managerId} 的 GitHub 身份：${identityId ?? '无'}；仓库：${repoIds.join(', ') || '无'}；凭据注入：${injectCredentials ? '开' : '关'}。`,
          `Assign GitHub identity ${identityId ?? 'none'} to ${managerId}. Repositories: ${repoIds.join(', ') || 'none'}. Credential injection: ${injectCredentials ? 'on' : 'off'}.`,
        ),
      )
      const data = await ctx.run('external.manager.assignment.set', {
        ...args,
        identityId,
        repoIds,
        injectCredentials,
        expectedRevision,
        operationId: newOperation(ctx),
      })
      return { text: `${data.managerId} · r${data.revision}`, data }
    },
  },
}
