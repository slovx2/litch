// 设备配置是服务端的授权边界；客户端传来的仓库名、根目录和采集凭据都须复核。
import { realpath } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import type {
  ExternalConfiguration,
  ExternalManagerAssignment,
  ExternalRepo,
  ExternalSourceDraft,
} from '../../../protocol/src/external-sources.mjs'
import { ProtocolError } from '../../../shared/src/protocol-contract.mjs'
import type { ExternalConfigResult, ExternalStore } from '../external-store.mjs'
import { git, gitMaybe } from '../worktree-git.mjs'
import { GithubWriteFault } from './github/write-api.mjs'
import { repositoryRouting, validateExternalRoutes } from './routing.mjs'
import type { ExternalGithubSecrets } from './secrets.mjs'

export function configurationResult<T>(result: ExternalConfigResult<T>): T {
  if (result.outcome === 'applied') return result.record
  throw Object.assign(new ProtocolError(-32000, 'External configuration revision changed'), {
    data: { code: 'revision_conflict' },
  })
}

export function externalInput(code: string): never {
  throw new GithubWriteFault(code)
}

export class ExternalDeviceConfiguration {
  private readonly store: ExternalStore
  private readonly secrets: ExternalGithubSecrets
  constructor(store: ExternalStore, secrets: ExternalGithubSecrets) {
    this.store = store
    this.secrets = secrets
  }

  snapshot = (): ExternalConfiguration => ({
    revision: this.store.config.revision(),
    // 撤销的身份仍参加数字 ID 防循环；只读和写探针另外核验活动凭据。
    identities: this.secrets.identities().map(({ identityId, botUserId, login }) => ({
      identityId,
      botUserId,
      login,
    })),
    repositories: this.store.config.sources().flatMap(({ repos }) =>
      repos.map((repo) => ({
        repoId: repo.repoId,
        pollIdentity: repo.pollIdentity ?? null,
        labelRoutes: repo.labelRoutes ?? [],
        ...(repo.immediateFeedback === undefined
          ? {}
          : { immediateFeedback: repo.immediateFeedback }),
        ...(repo.immediateFeedbackLanguage === undefined
          ? {}
          : {
              immediateFeedbackLanguage: repo.immediateFeedbackLanguage,
            }),
      })),
    ),
    assignments: this.store.config.assignments(),
  })

  assignmentForManager = (managerId: string) => {
    const { identityId, repoIds, injectCredentials } = this.store.config.assignment(managerId)
    return identityId ? { identityId, repoIds, injectCredentials: injectCredentials ?? true } : null
  }

  async checkRoot(repo: ExternalRepo): Promise<string> {
    if (!isAbsolute(repo.localRoot)) externalInput('github_local_root_invalid')
    try {
      const path = await realpath(repo.localRoot)
      const top = await realpath(
        await git(path, ['rev-parse', '--show-toplevel'], {
          timeoutMs: 5000,
        }),
      )
      if (top !== path) externalInput('github_local_root_invalid')
      const remote = await gitMaybe(path, ['config', '--local', '--get', 'remote.origin.url'])
      const parsed =
        /^(?:(?:https:\/\/|ssh:\/\/git@)github\.com\/|git@github\.com:)([\w.-]+)\/([\w.-]+)$/i.exec(
          remote ?? '',
        )
      if (
        !parsed ||
        `${parsed[1]}/${parsed[2]?.replace(/\.git$/i, '')}`.toLowerCase() !==
          `${repo.owner}/${repo.name}`.toLowerCase()
      )
        externalInput('github_local_origin_mismatch')
      return path
    } catch (error) {
      if (error instanceof GithubWriteFault) throw error
      externalInput('github_local_root_invalid')
    }
  }

  private validate(repo: ExternalRepo, configuration: ExternalConfiguration): void {
    const errors = validateExternalRoutes(
      repo,
      repositoryRouting(configuration, repo.repoId),
      (id) => this.store.manager.manager(id),
    )
    if (errors[0]) externalInput(errors[0])
  }

  prepareSource(draft: ExternalSourceDraft): Promise<ExternalSourceDraft> {
    return this.normalizeSource(draft)
  }

  private async normalizeSource(draft: ExternalSourceDraft): Promise<ExternalSourceDraft> {
    const repo = draft.repos[0]
    if (draft.repos.length !== 1 || !repo || draft.routes.length)
      externalInput('github_source_requires_single_repository')
    const credential = this.secrets.activeForRepository(repo.repoId, repo.pollIdentity ?? undefined)
    const verified = credential.repos.find((value) => value.repoId === repo.repoId)
    if (
      !verified ||
      verified.owner.toLowerCase() !== repo.owner.toLowerCase() ||
      verified.name.toLowerCase() !== repo.name.toLowerCase()
    )
      externalInput('github_repository_changed')
    const localRoot = await this.checkRoot({ ...repo, ...verified })
    if (!this.secrets.isCurrent(credential.metadata))
      externalInput('github_credential_generation_changed')
    const next = {
      ...repo,
      owner: verified.owner,
      name: verified.name,
      url: verified.url,
      localRoot,
    }
    return {
      ...draft,
      repos: [next],
      credentialRef: credential.metadata.credentialRef,
      botUserId: credential.metadata.botUserId,
      writePolicy: { ...draft.writePolicy, managedPush: false },
    }
  }

  saveSource(
    draft: ExternalSourceDraft,
    expectedRevision: number,
    operationId: string,
    verifiedAt?: number,
  ) {
    const [repo] = draft.repos
    if (!repo) externalInput('github_source_requires_single_repository')
    return this.store.transaction(() => {
      if (
        draft.enabled &&
        this.secrets.activeForRepository(repo.repoId, repo.pollIdentity ?? undefined).metadata
          .credentialRef !== draft.credentialRef
      )
        externalInput('github_credential_generation_changed')
      const source = this.store.config.source(draft.sourceId)
      if (source && !source.repos.some(({ repoId }) => repoId === repo.repoId))
        externalInput('github_source_repository_immutable')
      if (
        this.store.config
          .sources()
          .some(
            (other) =>
              other.sourceId !== draft.sourceId &&
              other.repos.some(({ repoId }) => repoId === repo.repoId),
          )
      )
        externalInput('github_repository_already_configured')
      const current = this.snapshot()
      this.validate(repo, {
        ...current,
        repositories: [
          ...current.repositories.filter((entry) => entry.repoId !== repo.repoId),
          {
            repoId: repo.repoId,
            pollIdentity: repo.pollIdentity ?? null,
            labelRoutes: repo.labelRoutes ?? [],
          },
        ],
      })
      return configurationResult(
        this.store.config.saveSource(
          draft,
          expectedRevision,
          operationId,
          'device-admin',
          verifiedAt,
        ),
      )
    })
  }

  async setAssignment(
    input: Omit<ExternalManagerAssignment, 'revision'> & {
      expectedRevision: number
      operationId: string
    },
  ): Promise<ExternalManagerAssignment> {
    const { managerId, repoIds, identityId, injectCredentials, expectedRevision, operationId } =
      input
    if (new Set(repoIds).size !== repoIds.length || (!identityId && repoIds.length))
      externalInput('github_assignment_invalid')
    const structural: Omit<ExternalManagerAssignment, 'revision'> = {
      managerId,
      repoIds,
      identityId,
      injectCredentials: injectCredentials ?? true,
    }
    const before = this.snapshot()
    const repos = this.store.config.sources().flatMap(({ repos }) => repos)
    for (const repoId of repoIds) {
      const repo = repos.find((entry) => entry.repoId === repoId)
      if (!repo || !identityId) externalInput('github_repository_not_configured')
      this.secrets.activeForRepository(repoId, identityId)
      await this.checkRoot(repo)
    }
    return configurationResult(
      this.store.config.saveAssignment(structural, expectedRevision, operationId, () => {
        if (before.revision !== this.store.config.revision())
          externalInput('github_configuration_changed')
        if (this.store.manager.manager(managerId)?.status !== 'active')
          externalInput('target_inactive')
        if (identityId) this.secrets.identity(identityId)
        const after = {
          ...before,
          assignments: [
            ...before.assignments.filter((entry) => entry.managerId !== managerId),
            { ...structural, revision: expectedRevision + 1 },
          ],
        }
        for (const repo of repos) this.validate(repo, after)
      }),
    )
  }
}
