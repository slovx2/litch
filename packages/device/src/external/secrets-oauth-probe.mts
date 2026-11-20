// GitHub CLI 负责 OAuth。这里仅核验它拿到的令牌，不参与设备码协议。
import {
  type GithubSender,
  GithubWriteFault,
  isGithubScopedToken,
  login,
  numericId,
  object,
  repoName,
} from './github/write-api.mjs'
import type { GithubCredentialProbe, VerifiedGithubRepo } from './secrets-probe.mjs'

// 合入 F 的同名协议约定后可以共享类型；设备仍须独立校验收到的值。
export const GITHUB_GH_REQUIRED_SCOPES = ['repo', 'read:org', 'gist'] as const
export const GITHUB_GH_OPTIONAL_SCOPES = ['workflow', 'read:packages', 'write:packages'] as const
export type GithubGhScope = (
  | typeof GITHUB_GH_REQUIRED_SCOPES
  | typeof GITHUB_GH_OPTIONAL_SCOPES
)[number]
export const GITHUB_GH_VERIFICATION_URL = 'https://github.com/login/device' as const

export function requestedGithubGhScopes(scopes: readonly string[]): GithubGhScope[] {
  const allowed: readonly string[] = [...GITHUB_GH_REQUIRED_SCOPES, ...GITHUB_GH_OPTIONAL_SCOPES]
  if (scopes.length > allowed.length || scopes.some((scope) => !allowed.includes(scope)))
    throw new GithubWriteFault('github_gh_scope_invalid')
  const requested = new Set([...GITHUB_GH_REQUIRED_SCOPES, ...scopes])
  return allowed.filter((scope): scope is GithubGhScope => requested.has(scope))
}

export interface GithubGhAccount {
  userId: string
  login: string
}
export interface GithubOAuthProbe extends GithubCredentialProbe {
  account: GithubGhAccount
  scopes: string[]
  isOwner: boolean
  repositoriesTruncated?: boolean
}

function grantsScope(scopes: ReadonlySet<string>, scope: GithubGhScope): boolean {
  if (scopes.has(scope)) return true
  if (scope === 'read:org') return scopes.has('write:org') || scopes.has('admin:org')
  if (scope === 'read:packages') return scopes.has('write:packages')
  return false
}

export async function probeGithubGhToken(
  send: GithubSender,
  token: string,
  ownerUserId: string,
  scopes: readonly GithubGhScope[],
  signal?: AbortSignal,
): Promise<GithubOAuthProbe> {
  if (!isGithubScopedToken(token)) throw new GithubWriteFault('github_gh_token_unsupported')
  const get = (path: string) => send(token, path, signal ? { signal } : undefined)
  const response = await get('/user')
  const account = object(response.body)
  const botUserId = numericId(account.id)
  if (!botUserId || !login(account.login) || account.type !== 'User')
    throw new GithubWriteFault('github_bot_identity_unverified')
  const actual = new Set(response.oauthScopes ?? [])
  if ([...GITHUB_GH_REQUIRED_SCOPES, ...scopes].some((scope) => !grantsScope(actual, scope)))
    throw new GithubWriteFault('github_oauth_scopes_insufficient')
  const owner = object((await get(`/user/${ownerUserId}`)).body)
  if (numericId(owner.id) !== ownerUserId || owner.type !== 'User')
    throw new GithubWriteFault('github_owner_identity_unverified')

  // OAuth 列表可跨组织和私人仓库。每个仓库记各自所有者 ID，供实际操作再次核验。
  const repos = new Map<string, VerifiedGithubRepo>()
  let truncated = false
  for (let page = 1; page <= 20; page++) {
    const selected = await get(
      `/user/repos?affiliation=owner,collaborator,organization_member&per_page=100&page=${page}`,
    )
    if (!Array.isArray(selected.body))
      throw new GithubWriteFault('github_repository_list_unverified')
    for (const raw of selected.body) {
      const repo = object(raw)
      const owner = object(repo.owner)
      const repoId = numericId(repo.id)
      const resourceOwnerId = numericId(owner.id)
      if (
        !repoId ||
        !resourceOwnerId ||
        !login(owner.login) ||
        !repoName(repo.name) ||
        typeof repo.default_branch !== 'string' ||
        !repo.default_branch ||
        typeof repo.full_name !== 'string' ||
        repo.full_name.toLowerCase() !== `${owner.login}/${repo.name}`.toLowerCase()
      )
        throw new GithubWriteFault('github_repository_unverified')
      const role = object(repo.permissions)
      repos.set(repoId, {
        repoId,
        resourceOwnerId,
        owner: owner.login,
        name: repo.name,
        url: `https://github.com/${owner.login}/${repo.name}`,
        defaultBranch: repo.default_branch,
        writeAccess: role.push === false ? 'missing' : 'unverified',
        feedbackWriteAccess:
          role.push === false &&
          role.triage === false &&
          role.maintain !== true &&
          role.admin !== true
            ? 'missing'
            : 'unverified',
      })
    }
    if (!selected.next) break
    if (page === 20) truncated = true
  }
  return {
    botUserId,
    botLogin: account.login,
    resourceOwnerId: botUserId,
    account: { userId: botUserId, login: account.login },
    scopes: [...actual].sort(),
    repos: [...repos.values()],
    isOwner: botUserId === ownerUserId,
    ...(response.expiresAt !== undefined ? { expiresAt: response.expiresAt } : {}),
    ...(truncated ? { repositoriesTruncated: true } : {}),
    diagnostics: [{ check: 'identity', state: 'ok', code: 'github_oauth_identity_verified' }],
  }
}
