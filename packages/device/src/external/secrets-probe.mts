import type { ExternalDiagnostic } from '../../../protocol/src/external-sources.mjs'
import {
  type GithubSender,
  GithubWriteFault,
  githubPages,
  githubRepoPath,
  login,
  numericId,
  object,
  repoName,
} from './github/write-api.mjs'

export interface GithubResolvedRepository {
  repoId: string
  owner: string
  name: string
  url: string
  defaultBranch: string
  defaultLabelId?: string
}
export interface VerifiedGithubRepo extends GithubResolvedRepository {
  resourceOwnerId: string
  writeAccess: 'missing' | 'unverified'
  feedbackWriteAccess: 'missing' | 'unverified'
}

export async function resolveGithubRepositories(
  get: (path: string) => ReturnType<GithubSender>,
  repositories: readonly string[],
  allowedIds?: ReadonlySet<string>,
  oauth = false,
): Promise<{ repositories: GithubResolvedRepository[]; botUserId: string }> {
  if (
    !repositories.length ||
    repositories.length > 100 ||
    new Set(repositories.map((value) => value.toLowerCase())).size !== repositories.length
  )
    throw new GithubWriteFault('github_repository_selection_required')
  const parsed = repositories.map((value) => {
    const [owner, name, extra] = value.split('/')
    if (!login(owner) || !repoName(name) || extra !== undefined)
      throw new GithubWriteFault('github_repository_invalid')
    return { owner, name }
  })
  const self = object((await get('/user')).body)
  const botUserId = numericId(self.id)
  if (!botUserId || self.type !== 'User' || !login(self.login))
    throw new GithubWriteFault('github_bot_identity_unverified')
  const listed = await githubPages(
    get,
    `/user/repos?affiliation=owner,${oauth ? 'collaborator,' : ''}organization_member`,
  )
  const resolved: GithubResolvedRepository[] = []
  let resourceOwnerId: string | undefined
  for (const { owner, name } of parsed) {
    const fullName = `${owner}/${name}`
    const entry = listed.find(
      (item) =>
        typeof item.full_name === 'string' &&
        item.full_name.toLowerCase() === fullName.toLowerCase(),
    )
    const repoId = numericId(entry?.id)
    if (!repoId || (allowedIds && !allowedIds.has(repoId)))
      throw new GithubWriteFault('github_repository_not_selected_or_membership_required')
    const path = githubRepoPath({ owner, name, repoId })
    const metadata = object((await get(path)).body)
    const resourceOwner = object(metadata.owner)
    const resourceId = numericId(resourceOwner.id)
    if (
      !resourceId ||
      numericId(metadata.id) !== repoId ||
      typeof metadata.full_name !== 'string' ||
      metadata.full_name.toLowerCase() !== fullName.toLowerCase() ||
      typeof metadata.default_branch !== 'string' ||
      !metadata.default_branch ||
      !['User', 'Organization'].includes(String(resourceOwner.type))
    )
      throw new GithubWriteFault('github_repository_unverified')
    if (!oauth && resourceOwner.type === 'User' && resourceId !== botUserId)
      throw new GithubWriteFault('github_personal_repository_requires_resource_owner')
    if (!oauth && resourceOwnerId && resourceOwnerId !== resourceId)
      throw new GithubWriteFault('github_single_resource_owner_required')
    resourceOwnerId = resourceId
    const defaultLabelId = await githubDefaultLabel(get, path)
    resolved.push({
      repoId,
      owner,
      name,
      url: `https://github.com/${fullName}`,
      defaultBranch: metadata.default_branch,
      ...(defaultLabelId ? { defaultLabelId } : {}),
    })
  }
  return { repositories: resolved, botUserId }
}

async function githubDefaultLabel(get: (path: string) => ReturnType<GithubSender>, path: string) {
  try {
    const label = object((await get(`${path}/labels/litch`)).body)
    return typeof label.name === 'string' && label.name.toLowerCase() === 'litch'
      ? numericId(label.id)
      : undefined
  } catch (error) {
    if (!(error instanceof GithubWriteFault) || ![403, 404].includes(error.status ?? 0)) throw error
    return undefined
  }
}

export async function listGithubCredentialRepoIds(
  send: GithubSender,
  token: string,
  resourceOwnerId?: string,
): Promise<string[]> {
  const get = (path: string) => send(token, path)
  const listed = await githubPages(get, '/user/repos?affiliation=owner,organization_member')
  const selected = listed.filter(
    (repo) => resourceOwnerId === undefined || numericId(object(repo.owner).id) === resourceOwnerId,
  )
  const owners = new Set(selected.map((repo) => numericId(object(repo.owner).id)))
  if (owners.size > 1) throw new GithubWriteFault('github_single_resource_owner_required')
  const ids = selected
    .map((repo) => numericId(repo.id))
    .filter((id): id is string => id !== undefined)
  if (!ids.length) throw new GithubWriteFault('github_repository_selection_required')
  return [...new Set(ids)]
}
export interface GithubCredentialProbe {
  botUserId: string
  botLogin: string
  resourceOwnerId: string
  repos: VerifiedGithubRepo[]
  expiresAt?: number
  diagnostics: ExternalDiagnostic[]
}

export async function probeGithubCredential(
  send: GithubSender,
  token: string,
  ownerId: string,
  repoIds: readonly string[],
): Promise<GithubCredentialProbe> {
  if (
    !numericId(ownerId) ||
    !repoIds.length ||
    repoIds.length > 100 ||
    repoIds.some((id) => !numericId(id)) ||
    new Set(repoIds).size !== repoIds.length
  )
    throw new GithubWriteFault('github_repository_selection_required')
  const get = (path: string) => send(token, path)
  const user = await get('/user')
  const bot = object(user.body)
  const botUserId = numericId(bot.id)
  if (!botUserId || !login(bot.login) || bot.type !== 'User')
    throw new GithubWriteFault('github_bot_identity_unverified')
  const owner = object((await get(`/user/${ownerId}`)).body)
  if (numericId(owner.id) !== ownerId || owner.type !== 'User')
    throw new GithubWriteFault('github_owner_identity_unverified')
  if (botUserId === ownerId) throw new GithubWriteFault('github_dedicated_bot_required')
  // 公有仓库匿名可读；先查令牌可列出的成员仓库，避免用公有 API 的成功响应充当权限证明。
  const listed = await githubPages(get, '/user/repos?affiliation=owner,organization_member')
  const repos: VerifiedGithubRepo[] = []
  let resourceOwnerId: string | undefined
  for (const repoId of repoIds) {
    const entry = listed.find((repo) => numericId(repo.id) === repoId)
    if (!entry) {
      // 仅为诊断查询公开元数据；成功也不能绕过上面的明确作用域检查。
      const visible = await get(`/repositories/${repoId}`).catch(() => null)
      const visibleOwner = object(object(visible?.body).owner)
      if (
        visibleOwner.type === 'User' &&
        numericId(visibleOwner.id) &&
        numericId(visibleOwner.id) !== botUserId
      )
        throw new GithubWriteFault('github_personal_repository_requires_resource_owner')
      throw new GithubWriteFault('github_repository_not_selected_or_membership_required')
    }
    const repoOwner = object(entry.owner)
    const id = numericId(repoOwner.id)
    if (!id || !login(repoOwner.login) || !repoName(entry.name))
      throw new GithubWriteFault('github_repository_unverified')
    if (repoOwner.type === 'User' && id !== botUserId)
      throw new GithubWriteFault('github_personal_repository_requires_resource_owner')
    if (repoOwner.type !== 'User' && repoOwner.type !== 'Organization')
      throw new GithubWriteFault('github_resource_owner_unverified')
    if (resourceOwnerId && id !== resourceOwnerId)
      throw new GithubWriteFault('github_single_resource_owner_required')
    resourceOwnerId = id
    const repo = { repoId, owner: repoOwner.login, name: entry.name }
    const path = githubRepoPath(repo)
    const metadata = object((await get(path)).body)
    if (
      numericId(metadata.id) !== repoId ||
      numericId(object(metadata.owner).id) !== id ||
      typeof metadata.default_branch !== 'string' ||
      !metadata.default_branch ||
      typeof metadata.full_name !== 'string' ||
      metadata.full_name.toLowerCase() !== `${repo.owner}/${repo.name}`.toLowerCase()
    )
      throw new GithubWriteFault('github_repository_unverified')
    for (const [endpoint, shape] of [
      ['/issues?per_page=1', undefined],
      ['/pulls?per_page=1', undefined],
      ['/actions/runs?per_page=1', 'workflow_runs'],
    ] as const) {
      const response = (await get(`${path}${endpoint}`)).body
      if (!Array.isArray(shape ? object(response)[shape] : response))
        throw new GithubWriteFault('github_required_read_endpoint_unverified')
    }
    const permissions = object(metadata.permissions)
    const listedPermissions = object(entry.permissions)
    const defaultLabelId = await githubDefaultLabel(get, path)
    repos.push({
      ...repo,
      resourceOwnerId: id,
      url: `https://github.com/${repo.owner}/${repo.name}`,
      defaultBranch: metadata.default_branch,
      ...(defaultLabelId ? { defaultLabelId } : {}),
      writeAccess:
        permissions.push === false || listedPermissions.push === false ? 'missing' : 'unverified',
      feedbackWriteAccess: [permissions, listedPermissions].some(
        (role) =>
          role.push === false &&
          role.triage === false &&
          role.maintain !== true &&
          role.admin !== true,
      )
        ? 'missing'
        : 'unverified',
    })
  }
  if (!resourceOwnerId) throw new GithubWriteFault('github_resource_owner_unverified')
  return {
    botUserId,
    botLogin: bot.login,
    resourceOwnerId,
    repos,
    ...(user.expiresAt !== undefined ? { expiresAt: user.expiresAt } : {}),
    diagnostics: [
      { check: 'identity', state: 'ok', code: 'github_separate_bot_verified' },
      { check: 'read', state: 'ok', code: 'github_selected_repositories_readable' },
      { check: 'write', state: 'unverified', code: 'github_read_does_not_prove_write_permission' },
    ],
  }
}
