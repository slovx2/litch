// 就绪信息使用与 Agent 相同的启动路径，不给该进程另加凭据，也不阻止无人值守。
import { isAbsolute } from 'node:path'
import type { ExternalDiagnostic } from '../../../protocol/src/external-sources.mjs'
import { managerNow } from '../manager-store.mjs'
import { login, numericId, object, parseExternalGithubJson } from './github/write-api.mjs'
import type { ExternalGithubSecrets } from './secrets.mjs'

export type ExternalProbeLauncher = (invocation: {
  executable: string
  args: string[]
  signal: AbortSignal
}) => Promise<string>

export function checkIdentityRepositoryWrites(input: {
  secrets: ExternalGithubSecrets
  identityId: string
  repositories: readonly { repoId: string; owner: string; name: string }[]
}): Array<ExternalDiagnostic & { repoId: string; repository: string; botLogin: string }> {
  const identity = input.secrets.identity(input.identityId)
  return input.repositories.map(({ repoId, owner, name }) => {
    let code = 'github_robot_needs_repository_write_access'
    try {
      const active = input.secrets.activeForRepository(repoId, input.identityId)
      if (active.repos.find((repo) => repo.repoId === repoId)?.writeAccess !== 'missing')
        code = 'github_repository_write_permission_unverified'
      if (
        (['issue', 'pull_request'] as const).some((kind) =>
          input.secrets.feedbackWriteMissing(active, repoId, kind),
        )
      )
        code = 'github_feedback_write_permission_required'
    } catch {
      /* 未获得仓库权限的凭据不可用于写入。 */
    }
    return {
      check: 'identity_repository_write',
      state: 'unverified',
      code,
      repoId,
      repository: `${owner}/${name}`,
      botLogin: identity.login,
    }
  })
}

export async function probeAgentGithubIdentity(input: {
  ghPath: string
  ownerUserId: string
  launch: ExternalProbeLauncher
  now?: () => number
}): Promise<
  ExternalDiagnostic & {
    identity?: { userId: string; login: string; isOwner: boolean; checkedAt: number }
  }
> {
  const check = 'agent_github_identity'
  const unverified = {
    check,
    state: 'unverified',
    code: 'agent_github_identity_unverified',
  } as const
  if (!isAbsolute(input.ghPath) || !numericId(input.ownerUserId)) return unverified
  const signal = AbortSignal.timeout(10_000)
  let onTimeout: (() => void) | undefined
  try {
    const raw = await Promise.race([
      input.launch({
        executable: input.ghPath,
        args: ['api', '--hostname', 'github.com', '--method', 'GET', '--', '/user'],
        signal,
      }),
      new Promise<never>((_, reject) => {
        onTimeout = () => reject(new Error('agent_gh_probe_timeout'))
        signal.addEventListener('abort', onTimeout, { once: true })
      }),
    ])
    if (Buffer.byteLength(raw) > 128 * 1024) return unverified
    const account = object(parseExternalGithubJson(raw))
    const userId = numericId(account.id)
    if (!userId || !login(account.login)) return unverified
    const checkedAt = (input.now ?? managerNow)()
    const isOwner = userId === input.ownerUserId
    const identity = { userId, login: account.login, isOwner, checkedAt }
    // 这个 code 是警告；即使使用 owner 登录，设备也不干预 Agent 的 gh。
    return isOwner
      ? {
          check,
          state: 'unverified',
          code: 'agent_github_owner_login_may_feed_back',
          checkedAt,
          identity,
        }
      : { check, state: 'ok', code: 'agent_github_owner_login_not_detected', checkedAt, identity }
  } catch {
    return unverified
  } finally {
    if (onTimeout) signal.removeEventListener('abort', onTimeout)
  }
}
