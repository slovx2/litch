// 私有控制面登录任务。只有指定的一次性用户码可进入等待快照；令牌始终由设备内部持有。
import { randomUUID } from 'node:crypto'
import { realpathSync, rmSync, statSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { managerNow } from '../manager-store.mjs'
import { readGithubGhToken, runGithubGhDeviceLogin } from './github/gh-auth-process.mjs'
import { locateSystemGithubConfig, resolveBundledGithubCli } from './github/gh-version.mjs'
import { digest, GithubWriteFault, isManagedGithubToken } from './github/write-api.mjs'
import type {
  ExternalGithubSecrets,
  GithubDeviceIdentity,
  PreparedGithubGhAuthorization,
} from './secrets.mjs'
import { ExternalPrivateFiles, privateName } from './secrets-files.mjs'
import {
  type GITHUB_GH_VERIFICATION_URL,
  type GithubGhAccount,
  type GithubGhScope,
  requestedGithubGhScopes,
} from './secrets-oauth-probe.mjs'
import type { GithubResolvedRepository, VerifiedGithubRepo } from './secrets-probe.mjs'

export interface GithubIdentityAuthorization {
  account: GithubGhAccount
  scopes: string[]
  repositories: GithubResolvedRepository[]
  repositoriesTruncated?: boolean
  isOwner: boolean
  identity?: GithubDeviceIdentity
}
type LoginPhase =
  | { state: 'waiting'; userCode: string; verificationUrl: typeof GITHUB_GH_VERIFICATION_URL }
  | { state: 'succeeded'; needsConfirmation: boolean; result: GithubIdentityAuthorization }
  | { state: 'canceled' | 'timed_out' | 'expired' }
  | { state: 'error'; code: string }
export type GithubIdentityLogin = LoginPhase & {
  loginId: string
  revision: number
  expiresAt: number
}

interface Job {
  id: string
  signature: string
  controller: AbortController
  expiresAt: number
  state?: GithubIdentityLogin
  first: Promise<GithubIdentityLogin>
  resolveFirst: (state: GithubIdentityLogin) => void
  done: Promise<void>
  pending?: PreparedGithubGhAuthorization
  confirmTimer?: NodeJS.Timeout
  confirmOperationId?: string
}

interface Options {
  secrets: ExternalGithubSecrets
  stateDirectory: string
  runtimeRoot: string
  /** 仅由私有设备控制面解析的系统 gh 配置目录；协议不接收任意设备路径。 */
  systemGithubConfig?: () => string | undefined
  changed?: (event: { loginId: string; revision: number }) => void
  loginTimeoutMs?: number
  promptTimeoutMs?: number
  ownerConfirmationTimeoutMs?: number
  now?: () => number
}

const deviceCodeSeconds = 900
const terminalRetentionSeconds = 1800

export class GithubGhAuthorizationService {
  private readonly options: Options
  private readonly root: ExternalPrivateFiles
  private readonly jobs = new Map<string, Job>()
  private readonly requests = new Map<string, Job>()
  private readonly now: () => number
  private closed = false

  static create(options: Options): GithubGhAuthorizationService {
    return new GithubGhAuthorizationService(options)
  }

  private constructor(options: Options) {
    this.options = options
    this.now = options.now ?? managerNow
    this.root = new ExternalPrivateFiles(join(options.stateDirectory, 'external-gh-logins'))
    // 设备状态锁下，上一进程遗留目录不可能仍属于本进程的有效登录。
    for (const key of this.root.keys())
      if (/^attempt-[0-9a-f-]{36}$/.test(key))
        rmSync(this.root.path(key), { recursive: true, force: true })
  }

  add(input: { operationId: string; scopes: readonly string[] }): Promise<GithubIdentityLogin> {
    const scopes = requestedGithubGhScopes(input.scopes)
    return this.begin(input.operationId, JSON.stringify(['device', scopes]), async (job) => {
      const ghPath = await resolveBundledGithubCli(this.options.runtimeRoot)
      const directory = this.root.path(`attempt-${job.id}`)
      const files = new ExternalPrivateFiles(directory)
      try {
        await runGithubGhDeviceLogin({
          ghPath,
          configDirectory: files.directory,
          scopes,
          signal: job.controller.signal,
          promptTimeoutMs: this.options.promptTimeoutMs ?? 20_000,
          onCode: ({ userCode, verificationUrl }) => {
            this.transition(
              job,
              { state: 'waiting', userCode, verificationUrl },
              this.now() + deviceCodeSeconds,
            )
          },
        })
        const token = await readGithubGhToken({
          ghPath,
          configDirectory: files.directory,
          signal: job.controller.signal,
        })
        // 获取后先清理 gh 临时配置；其后的步骤只需要内存中的令牌。
        rmSync(directory, { recursive: true, force: true })
        await this.verify(job, input.operationId, token, scopes)
      } finally {
        rmSync(directory, { recursive: true, force: true })
      }
    })
  }

  importLogin(input: {
    operationId: string
    configDirectory?: string
    accountLogin?: string
  }): Promise<GithubIdentityLogin> {
    const requested =
      input.configDirectory ?? this.options.systemGithubConfig?.() ?? locateSystemGithubConfig()
    return this.begin(
      input.operationId,
      JSON.stringify(['import', requested, input.accountLogin]),
      async (job) => {
        let directory: string
        try {
          if (!requested || !isAbsolute(requested)) throw new Error()
          directory = realpathSync(requested)
          if (!statSync(directory).isDirectory()) throw new Error()
        } catch {
          throw new GithubWriteFault('github_gh_import_configuration_unavailable')
        }
        const token = await readGithubGhToken({
          ghPath: await resolveBundledGithubCli(this.options.runtimeRoot),
          configDirectory: directory,
          workingDirectory: this.root.directory,
          signal: job.controller.signal,
          useHostKeyring: true,
          ...(input.accountLogin ? { accountLogin: input.accountLogin } : {}),
        })
        await this.verify(job, input.operationId, token, requestedGithubGhScopes([]))
      },
    )
  }

  paste(input: { operationId: string; token: string }): Promise<GithubIdentityLogin> {
    return this.begin(
      input.operationId,
      JSON.stringify(['paste', digest(input.token)]),
      async (job) => {
        const { identity } = await this.options.secrets.addIdentity({
          ...input,
          signal: job.controller.signal,
        })
        const credential = identity.credentials.find(
          (row) =>
            row.state === 'active' &&
            row.credentialKind === 'fine_grained' &&
            this.options.secrets.credentialWasWrittenBy(row.credentialRef, input.operationId),
        )
        if (!credential) throw new GithubWriteFault('github_credential_unavailable')
        const snapshot = this.options.secrets.active(credential.credentialRef)
        this.transition(job, {
          state: 'succeeded',
          needsConfirmation: false,
          result: {
            account: { userId: identity.botUserId, login: identity.login },
            scopes: [],
            ...repositories(snapshot.repos),
            isOwner: false,
            identity,
          },
        })
      },
    )
  }

  get(loginId: string): GithubIdentityLogin {
    const job = this.job(loginId)
    this.expireOwner(job)
    if (!job.state) throw new GithubWriteFault('github_gh_login_not_ready')
    return job.state
  }

  /** 等当前登录步骤结束；owner 仍需另一次确认。设备关闭也用同一个完成句柄。 */
  async wait(loginId: string): Promise<GithubIdentityLogin> {
    await this.job(loginId).done
    return this.get(loginId)
  }

  async cancel(input: { loginId: string; operationId: string }): Promise<GithubIdentityLogin> {
    this.checkOperation(input.operationId)
    const job = this.job(input.loginId)
    this.expireOwner(job)
    if (job.pending) {
      this.clearPending(job)
      this.transition(job, { state: 'canceled' })
    } else if (!job.state || job.state.state === 'waiting') {
      job.controller.abort(new GithubWriteFault('github_gh_login_canceled'))
      await job.done
    }
    return this.get(input.loginId)
  }

  confirm(input: {
    loginId: string
    expectedRevision: number
    operationId: string
  }): GithubIdentityLogin {
    this.checkOperation(input.operationId)
    const job = this.job(input.loginId)
    this.expireOwner(job)
    if (
      job.state?.state === 'succeeded' &&
      !job.state.needsConfirmation &&
      job.confirmOperationId === input.operationId
    )
      return job.state
    if (job.state?.revision !== input.expectedRevision || !job.pending)
      throw new GithubWriteFault('github_gh_login_revision_changed')
    const prepared = job.pending
    this.clearPending(job)
    try {
      const identity = this.options.secrets.commitGhAuthorization(prepared, input.operationId, true)
      job.confirmOperationId = input.operationId
      return this.transition(job, {
        state: 'succeeded',
        needsConfirmation: false,
        result: fromProof(prepared, identity),
      })
    } catch (error) {
      return this.transition(job, { state: 'error', code: safeFault(error) })
    }
  }

  async close(): Promise<void> {
    this.closed = true
    for (const job of this.jobs.values()) {
      this.clearPending(job)
      job.controller.abort(new GithubWriteFault('github_gh_login_canceled'))
    }
    await Promise.all([...this.jobs.values()].map((job) => job.done))
    this.jobs.clear()
    this.requests.clear()
  }

  private async verify(
    job: Job,
    operationId: string,
    token: string,
    scopes: readonly GithubGhScope[],
  ) {
    const prepared = await this.options.secrets.prepareGhAuthorization(
      token,
      scopes,
      job.controller.signal,
    )
    if (job.controller.signal.aborted) throw job.controller.signal.reason
    if (!prepared.probe.isOwner) {
      const identity = this.options.secrets.commitGhAuthorization(prepared, operationId)
      this.transition(job, {
        state: 'succeeded',
        needsConfirmation: false,
        result: fromProof(prepared, identity),
      })
      return
    }
    job.pending = prepared
    const waitMs = this.options.ownerConfirmationTimeoutMs ?? 600_000
    job.confirmTimer = setTimeout(() => {
      if (!job.pending) return
      this.clearPending(job)
      this.transition(job, { state: 'expired' })
    }, waitMs)
    job.confirmTimer.unref()
    this.transition(
      job,
      { state: 'succeeded', needsConfirmation: true, result: fromProof(prepared) },
      this.now() + Math.ceil(waitMs / 1000),
    )
  }

  private begin(
    operationId: string,
    signature: string,
    work: (job: Job) => Promise<void>,
  ): Promise<GithubIdentityLogin> {
    this.checkOperation(operationId)
    if (this.closed) throw new GithubWriteFault('github_gh_login_service_closed')
    this.prune()
    const previous = this.requests.get(operationId)
    if (previous) {
      if (previous.signature !== signature)
        throw new GithubWriteFault('github_gh_login_operation_conflict')
      return previous.state ? Promise.resolve(previous.state) : previous.first
    }
    if (this.jobs.size >= 64) throw new GithubWriteFault('github_gh_login_capacity')
    let resolveFirst!: Job['resolveFirst']
    const first = new Promise<GithubIdentityLogin>((resolve) => {
      resolveFirst = resolve
    })
    const job: Job = {
      id: randomUUID(),
      signature,
      controller: new AbortController(),
      expiresAt: this.now() + deviceCodeSeconds,
      first,
      resolveFirst,
      done: Promise.resolve(),
    }
    this.jobs.set(job.id, job)
    this.requests.set(operationId, job)
    job.done = Promise.resolve().then(async () => {
      const timeout = setTimeout(
        () => job.controller.abort(new GithubWriteFault('github_gh_login_timed_out')),
        this.options.loginTimeoutMs ?? 960_000,
      )
      try {
        if (job.controller.signal.aborted) throw job.controller.signal.reason
        await work(job)
      } catch (error) {
        const code = safeFault(job.controller.signal.aborted ? job.controller.signal.reason : error)
        if (code === 'github_gh_login_canceled') this.transition(job, { state: 'canceled' })
        else if (code === 'github_gh_login_timed_out') this.transition(job, { state: 'timed_out' })
        else if (code === 'github_gh_device_code_expired')
          this.transition(job, { state: 'expired' })
        else this.transition(job, { state: 'error', code })
      } finally {
        clearTimeout(timeout)
      }
    })
    return first
  }

  private transition(job: Job, phase: LoginPhase, expiresAt = job.expiresAt): GithubIdentityLogin {
    const state = { loginId: job.id, revision: (job.state?.revision ?? 0) + 1, expiresAt, ...phase }
    job.expiresAt = expiresAt
    job.state = state
    job.resolveFirst(state)
    try {
      this.options.changed?.({ loginId: state.loginId, revision: state.revision })
    } catch {
      // 通知失败不会使已验证的快照丢失。
    }
    return state
  }

  private checkOperation(operationId: string): void {
    if (!privateName(operationId) || isManagedGithubToken(operationId))
      throw new GithubWriteFault('github_gh_login_operation_invalid')
  }

  private job(loginId: string): Job {
    const job = this.jobs.get(loginId)
    if (!job) throw new GithubWriteFault('github_gh_login_not_found')
    return job
  }

  private clearPending(job: Job): void {
    if (job.confirmTimer) clearTimeout(job.confirmTimer)
    delete job.pending
    delete job.confirmTimer
  }

  private expireOwner(job: Job): void {
    if (job.pending && this.now() >= job.expiresAt) {
      this.clearPending(job)
      this.transition(job, { state: 'expired' })
    }
  }

  private prune(): void {
    const now = this.now()
    for (const [operationId, job] of this.requests) {
      this.expireOwner(job)
      if (
        job.state &&
        job.state.state !== 'waiting' &&
        !job.pending &&
        job.expiresAt + terminalRetentionSeconds <= now
      ) {
        this.jobs.delete(job.id)
        this.requests.delete(operationId)
      }
    }
  }
}

function safeFault(error: unknown): string {
  return error instanceof GithubWriteFault ? error.code : 'github_gh_authorization_failed'
}

function repositories(repos: readonly VerifiedGithubRepo[]) {
  return {
    repositories: repos
      .slice(0, 100)
      .map(({ repoId, name, owner, url, defaultBranch, defaultLabelId }) => ({
        repoId,
        name,
        owner,
        url,
        defaultBranch,
        ...(defaultLabelId ? { defaultLabelId } : {}),
      })),
    ...(repos.length > 100 ? { repositoriesTruncated: true } : {}),
  }
}

function fromProof(
  prepared: PreparedGithubGhAuthorization,
  identity?: GithubDeviceIdentity,
): GithubIdentityAuthorization {
  const { probe } = prepared
  return {
    account: probe.account,
    scopes: [...probe.scopes],
    ...repositories(probe.repos),
    isOwner: probe.isOwner,
    ...(probe.repositoriesTruncated ? { repositoriesTruncated: true } : {}),
    ...(identity ? { identity } : {}),
  }
}
