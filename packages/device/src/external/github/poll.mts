import { type GithubBoundPull, validGithubSha } from './actions.mjs'
import { type GithubActorEvidence, verifyGithubBot } from './identity.mjs'
import { githubPageTag } from './poll-pages.mjs'
import {
  type GithubScanContext,
  type GithubStreamResult,
  githubDay,
  githubPollFault,
  scanGithubStream,
} from './poll-scan.mjs'
import type { GithubPollFault, GithubPollStore, GithubScope, GithubStream } from './poll-state.mjs'
import {
  type GithubApi,
  GithubFault,
  type GithubRepository,
  githubId,
  githubNumber,
  githubObject,
  verifyGithubRepository,
} from './read-api.mjs'

export type {
  GithubAccessGate,
  GithubCursor,
  GithubGap,
  GithubObjectObservation,
  GithubPageChanges,
  GithubPageProof,
  GithubPollEvent,
  GithubPollFault,
  GithubPollStore,
  GithubPullCandidate,
  GithubPullObservation,
  GithubStream,
  GithubStreamKey,
} from './poll-state.mjs'
export { SqliteGithubPollStore } from './poll-store.mjs'

export interface GithubPollOptions {
  sourceId: string
  repo: GithubRepository
  botUserId: string
  // 由来源启用时的 GitHub 服务端时钟确定。所有流使用同一启用点，重启不重设。
  enabledAt: number
  newStreamAt?: number
  api: GithubApi
  store: GithubPollStore
  boundPulls?: readonly { number: number; workflowIds?: readonly string[] }[]
  boundSubjects?: readonly { number: number; pull: boolean; since: number }[]
  pageBudget?: number
  reviewBudget?: number
  reconcile?: boolean
  resume?: boolean
}

export interface GithubPollResult {
  streams: readonly GithubStreamResult[]
  bot?: GithubActorEvidence
  fault?: GithubPollFault
}

const flights = new WeakMap<GithubPollStore, Map<string, Promise<GithubPollResult>>>()

export function pollGithubRepository(options: GithubPollOptions): Promise<GithubPollResult> {
  if (
    !options.sourceId ||
    !githubId(options.botUserId) ||
    !githubId(options.repo.repoId) ||
    !Number.isSafeInteger(options.enabledAt) ||
    options.enabledAt <= 0 ||
    !githubNumber(options.pageBudget ?? 8) ||
    !githubNumber(options.reviewBudget ?? 4) ||
    options.boundPulls?.some(
      (pull) => !githubNumber(pull.number) || pull.workflowIds?.some((id) => !githubId(id)),
    )
  ) {
    throw new TypeError('Invalid GitHub poll configuration')
  }
  const active = flights.get(options.store) ?? new Map<string, Promise<GithubPollResult>>()
  flights.set(options.store, active)
  const key = JSON.stringify([options.sourceId, options.repo.repoId])
  const existing = active.get(key)
  if (existing) return existing
  const poll = pollOnce(options).finally(() => active.delete(key))
  active.set(key, poll)
  return poll
}

async function pollOnce(options: GithubPollOptions): Promise<GithubPollResult> {
  const { api, store, repo, sourceId } = options
  const scope: GithubScope = { sourceId, repoId: repo.repoId }
  const source = { sourceId }
  async function setGate(key: typeof scope | typeof source, fault: GithubPollFault) {
    await store.setGate(key, { generation: api.generation, fault })
  }
  async function checkGate(key: typeof scope | typeof source) {
    const gate = await store.getGate(key)
    if (!gate) return
    if (
      !options.resume &&
      gate.generation === api.generation &&
      (gate.fault.paused || (gate.fault.retryAt ?? 0) > api.now())
    ) {
      return gate.fault
    }
    await store.setGate(key, null)
  }
  const gate = (await checkGate(source)) ?? (await checkGate(scope))
  if (gate) return { streams: [], fault: gate }
  let bot: GithubActorEvidence
  try {
    bot = await verifyGithubBot(api, options.botUserId)
  } catch (error) {
    if (!(error instanceof GithubFault)) throw error
    const fault = githubPollFault(error, 'credential')
    await setGate(source, fault)
    return { streams: [], fault }
  }
  let repoResponse: Awaited<ReturnType<typeof verifyGithubRepository>>
  try {
    repoResponse = await verifyGithubRepository(api, repo)
  } catch (error) {
    if (!(error instanceof GithubFault)) throw error
    const fault = githubPollFault(error, 'repository')
    await setGate(fault.scope === 'credential' ? source : scope, fault)
    return { streams: [], bot, fault }
  }
  // 保留少量可见性缓冲，轮询上界只取本轮已认证的服务端时间。
  const scanTo = repoResponse.serverTime - 5_000
  const context = {
    api,
    store,
    repo,
    bot,
    scanTo,
    enabledAt: options.enabledAt,
    budget: options.pageBudget ?? 8,
    issuesDisabled: githubObject(repoResponse.body).has_issues === false,
    ...(options.resume ? { resume: true } : {}),
  }
  const streams: GithubStreamResult[] = []
  let fault: GithubPollFault | undefined
  async function scan(
    stream: GithubStream,
    number?: number,
    bound?: GithubBoundPull,
    boundPeers?: readonly GithubBoundPull[],
    since?: number,
  ) {
    const ctx: GithubScanContext = {
      ...context,
      key: { ...scope, stream },
      ...(since !== undefined
        ? { newStreamAt: Math.max(since, options.newStreamAt ?? context.enabledAt) }
        : options.newStreamAt !== undefined
          ? { newStreamAt: options.newStreamAt }
          : {}),
      ...(number !== undefined ? { number } : {}),
      ...(bound ? { bound } : {}),
      ...(boundPeers ? { boundPeers } : {}),
    }
    const result = await scanGithubStream(ctx)
    streams.push(result)
    const current = result.cursor.fault
    if (current?.scope === 'credential' || current?.scope === 'repository') {
      fault = current
      await setGate(current.scope === 'credential' ? source : scope, current)
    }
    return result
  }
  // 活跃绑定先核对当前 head；低频的仓库核对不影响通知的时钟。
  const heads: GithubBoundPull[] = []
  for (const binding of [...(options.boundPulls ?? [])].sort((a, b) => a.number - b.number)) {
    const { pull } = await scan(`pull:${binding.number}`, binding.number)
    if (fault) return { streams, bot, fault }
    if (pull && validGithubSha(pull.headSha)) {
      const { number, headSha, headRepoId } = pull
      heads.push({
        number,
        headSha,
        ...(headRepoId ? { headRepoId } : {}),
        ...(binding.workflowIds ? { workflowIds: [...binding.workflowIds].sort() } : {}),
      })
    }
  }
  for (const head of heads) {
    await scan(
      `runs:${head.number}`,
      head.number,
      head,
      heads.filter((peer) => peer.headSha === head.headSha),
    )
    if (fault) return { streams, bot, fault }
  }
  for (const subject of options.boundSubjects ?? []) {
    await scan(
      `subject-comments:${subject.number}`,
      subject.number,
      undefined,
      undefined,
      subject.since,
    )
    if (fault) return { streams, bot, fault }
    if (subject.pull)
      await scan(
        `subject-review-comments:${subject.number}`,
        subject.number,
        undefined,
        undefined,
        subject.since,
      )
    if (fault) return { streams, bot, fault }
  }
  if (options.reconcile !== false) {
    for (const stream of ['issues', 'issue-comments', 'review-comments', 'issue-events'] as const) {
      await scan(stream)
      if (fault) return { streams, bot, fault }
    }
  }
  for (const number of await store.listReviewCandidates(
    scope,
    Math.max(options.enabledAt, scanTo - 30 * githubDay),
    options.reviewBudget ?? 4,
    {
      tag: githubPageTag(api, bot),
      ...(options.reconcile === false ? { boundOnly: true } : {}),
      ...(options.boundPulls
        ? { boundNumbers: options.boundPulls.map((pull) => pull.number) }
        : {}),
      ...(options.resume ? { resume: true } : {}),
    },
  )) {
    await scan(`reviews:${number}`, number)
    if (fault) return { streams, bot, fault }
  }
  return { streams, bot }
}
