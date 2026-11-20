import type { GithubBoundPull } from './actions.mjs'
import type { GithubActorEvidence } from './identity.mjs'
import { canReuseGithubPage, githubListPath, githubNextPage, githubPageTag } from './poll-pages.mjs'
import {
  type GithubProcessContext,
  githubDetailGap,
  processGithubDetail,
  processGithubPage,
} from './poll-process.mjs'
import type {
  GithubCursor,
  GithubGap,
  GithubPageProof,
  GithubPollFault,
  GithubPollStore,
  GithubPullObservation,
  GithubScan,
  GithubStreamKey,
} from './poll-state.mjs'
import { type GithubApi, GithubFault, type GithubRepository, githubRepoPath } from './read-api.mjs'

export const githubDay = 24 * 60 * 60_000
const overlap = 10 * 60_000
const offlineLimit = 30 * githubDay
const scanTtl = 6 * 60 * 60_000

export interface GithubScanContext {
  api: GithubApi
  store: GithubPollStore
  key: GithubStreamKey
  repo: GithubRepository
  bot: GithubActorEvidence
  enabledAt: number
  scanTo: number
  budget: number
  issuesDisabled: boolean
  resume?: boolean
  number?: number
  bound?: GithubBoundPull
  boundPeers?: readonly GithubBoundPull[]
}

export function githubPollFault(
  error: GithubFault,
  at: 'credential' | 'repository' | 'stream' | 'target',
  disabled = false,
): GithubPollFault {
  const { kind, retryAt } = error
  const fields = (
    scope: GithubPollFault['scope'],
    paused: boolean,
    reason: GithubPollFault['reason'],
  ): GithubPollFault => ({
    kind,
    scope,
    paused,
    reason,
    ...(retryAt !== undefined ? { retryAt } : {}),
  })
  if (kind === 'authentication') return fields('credential', true, 'credential-rejected')
  if (kind === 'repository-changed') return fields('repository', true, 'repository-changed')
  if (kind === 'not-found') {
    if (at === 'repository') return fields(at, true, 'repository-unavailable')
    return fields(
      at,
      at !== 'target',
      disabled
        ? 'feature-disabled'
        : at === 'target'
          ? 'target-unavailable'
          : 'endpoint-unavailable',
    )
  }
  if (kind === 'disabled') return fields(at, at !== 'target', 'feature-disabled')
  if (kind === 'permission') return fields(at, true, 'permission-denied')
  return fields(
    kind === 'primary-rate' || kind === 'secondary-rate' ? 'credential' : at,
    false,
    'retry',
  )
}

function startPath(ctx: GithubScanContext, from: number): string {
  const base = githubRepoPath(ctx.repo)
  const since = new Date(Math.floor(from / 1000) * 1000 - 1000).toISOString().replace('.000Z', 'Z')
  switch (ctx.key.stream) {
    case 'issues':
      return githubListPath(`${base}/issues`, {
        state: 'all',
        sort: 'updated',
        direction: 'asc',
        since,
      })
    case 'issue-events':
      return githubListPath(`${base}/issues/events`)
    case 'issue-comments':
      return githubListPath(`${base}/issues/comments`, { sort: 'updated', direction: 'asc', since })
    case 'review-comments':
      return githubListPath(`${base}/pulls/comments`, { sort: 'updated', direction: 'asc', since })
    case 'pull-catalog':
      return githubListPath(`${base}/pulls`, { state: 'all', sort: 'updated', direction: 'desc' })
    default:
      if (ctx.key.stream.startsWith('pull:')) return `${base}/pulls/${ctx.number}`
      if (ctx.key.stream.startsWith('reviews:'))
        return githubListPath(`${base}/pulls/${ctx.number}/reviews`)
      if (ctx.bound) return githubListPath(`${base}/actions/runs`, { head_sha: ctx.bound.headSha })
      throw new TypeError('Unknown GitHub stream')
  }
}

function scanGap(
  scan: GithubScan,
  reason: GithubGap['reason'],
  status: GithubGap['status'],
): GithubGap {
  return { reason, status, from: scan.from, to: scan.to }
}

function completedCursor(cursor: GithubCursor, scan: GithubScan, at: number): GithubCursor {
  const { scan: _scan, fault: _fault, ...rest } = cursor
  return {
    ...rest,
    checkedAt: at,
    coveredThrough: scan.kind === 'forward' ? scan.to : cursor.coveredThrough,
    repairAt: scan.kind === 'repair' ? at : (cursor.repairAt ?? at),
  }
}

function finishPage(ctx: GithubScanContext, cursor: GithubCursor, scan: GithubScan, at: number) {
  if (scan.next) return { cursor: { ...cursor, scan }, gaps: [] }
  if (ctx.key.stream.startsWith('runs:') && scan.rows >= 1000) {
    // 带过滤条件的 Actions 列表最多返回 1000 条；保存已可验证的事件，水位保留。
    const { scan: _scan, ...rest } = cursor
    return {
      cursor: { ...rest, stopped: 'platform-limit' as const },
      gaps: [scanGap(scan, 'platform-limit', 'pending')],
    }
  }
  const finished = completedCursor(cursor, scan, at)
  if (ctx.key.stream === 'pull-catalog') {
    finished.nextPollAt = Math.max(finished.nextPollAt ?? 0, at + githubDay)
  }
  const gaps: GithubGap[] = []
  if (scan.pendingGap) gaps.push(scanGap(scan, 'page-budget', 'resolved'))
  if (scan.expiredRange)
    gaps.push({ ...scan.expiredRange, reason: 'expired-scan', status: 'resolved' })
  return { cursor: finished, gaps }
}

async function getGithubPage(
  ctx: GithubScanContext,
  cursor: GithubCursor,
  scan: GithubScan,
  path: string,
) {
  const proof = await ctx.store.getPage(ctx.key, path)
  const reusable = canReuseGithubPage(proof, ctx.key, path, cursor.tag, scan, ctx.api.now())
    ? proof
    : undefined
  let response = await ctx.api.get(path, reusable?.etag)
  let reused: GithubPageProof | undefined
  if (response.status === 304) {
    const headerMatches =
      !response.headers.has('link') ||
      githubNextPage(response.headers, path, ctx.repo) === reusable?.next
    if (reusable && headerMatches) reused = { ...reusable, checkedAt: ctx.api.now() }
    else response = await ctx.api.get(path)
  }
  if (response.status === 304 && !reused) throw new GithubFault('invalid-response')
  return {
    response,
    reused,
    next: reused ? reused.next : githubNextPage(response.headers, path, ctx.repo),
  }
}

export interface GithubStreamResult {
  key: GithubStreamKey
  cursor: GithubCursor
  pull?: GithubPullObservation
}

export async function scanGithubStream(ctx: GithubScanContext): Promise<GithubStreamResult> {
  const tag = githubPageTag(
    ctx.api,
    ctx.bot,
    ctx.bound ? JSON.stringify([ctx.bound, ctx.boundPeers]) : '',
  )
  const at = ctx.api.now()
  const previous = await ctx.store.getCursor(ctx.key)
  const {
    fault: _fault,
    stopped: _stopped,
    nextPollAt: _nextPollAt,
    ...cleared
  } = previous ?? { tag, coveredThrough: ctx.enabledAt }
  let cursor: GithubCursor = previous ?? cleared
  if (cursor.tag !== tag) {
    // 凭据/登录名变化需重新取页，但保留完整水位。head 变化按当前头重新建独立窗口。
    const headChanged = ctx.bound !== undefined && JSON.parse(cursor.tag)[4] !== JSON.parse(tag)[4]
    cursor = {
      tag,
      coveredThrough: cursor.coveredThrough,
      ...(headChanged ? { repairAt: at - githubDay } : {}),
    }
  } else if (ctx.resume) cursor = cleared
  if (
    cursor.stopped ||
    cursor.fault?.paused ||
    (cursor.fault?.retryAt ?? 0) > at ||
    (!cursor.scan && (cursor.nextPollAt ?? 0) > at)
  )
    return { key: ctx.key, cursor }
  let pull: GithubPullObservation | undefined
  let processingTarget = false
  let scan = cursor.scan
  const { fault: _oldFault, ...healthy } = cursor
  cursor = healthy
  if (!scan || scan.expiresAt <= at) {
    const gaps: GithubGap[] = []
    const expiredRange = scan?.expiredRange ?? (scan ? { from: scan.from, to: scan.to } : undefined)
    if (expiredRange) gaps.push({ ...expiredRange, reason: 'expired-scan', status: 'pending' })
    const cutoff = ctx.scanTo - offlineLimit
    if (ctx.scanTo <= cursor.coveredThrough && !scan) return { key: ctx.key, cursor }
    if (cursor.coveredThrough < cutoff) {
      gaps.push({
        reason: 'offline-limit',
        status: 'unrecoverable',
        from: cursor.coveredThrough,
        to: cutoff,
      })
    }
    const repaired = cursor.repairAt ?? at
    const floor = Math.max(cursor.coveredThrough, cutoff)
    const repair =
      ctx.key.stream !== 'pull-catalog' &&
      ctx.scanTo - floor < githubDay &&
      (scan ? scan.kind === 'repair' : at - repaired >= githubDay)
    const from = repair
      ? Math.max(cutoff, ctx.scanTo - githubDay)
      : Math.max(cutoff, floor - overlap)
    const to =
      ctx.key.stream === 'pull-catalog'
        ? ctx.scanTo
        : repair
          ? Math.min(ctx.scanTo, cursor.coveredThrough)
          : Math.min(ctx.scanTo, floor + githubDay)
    scan = {
      kind: repair ? 'repair' : 'forward',
      from,
      to,
      expiresAt: at + scanTtl,
      next: startPath(ctx, from),
      rows: 0,
      ...(expiredRange && from <= expiredRange.from && to >= expiredRange.to
        ? { expiredRange }
        : {}),
    }
    cursor = { ...cursor, scan }
    await ctx.store.commit(ctx.key, cursor, { gaps })
  }
  try {
    for (let used = 0; used < ctx.budget; used++) {
      const pending: GithubScan['pending'] = scan.pending
      const [task, ...rest] = pending?.tasks ?? []
      const processContext: GithubProcessContext = { ...ctx, scan }
      if (pending && task) {
        processingTarget = true
        const { changes, continuation } = await processGithubDetail(processContext, task)
        processingTarget = false
        const proof: GithubPageProof | undefined = changes.gaps.length ? undefined : pending.proof
        if (continuation || rest.length) {
          scan = {
            ...scan,
            pending: {
              next: pending.next,
              tasks: continuation ? [continuation, ...rest] : rest,
              ...(proof ? { proof } : {}),
            },
          }
          cursor = { ...cursor, scan }
          await ctx.store.commit(ctx.key, cursor, changes)
          continue
        }
        const { pending: _pending, ...withoutPending } = scan
        scan = { ...withoutPending, next: pending.next }
        const finished = finishPage(ctx, cursor, scan, at)
        cursor = finished.cursor
        await ctx.store.commit(ctx.key, cursor, {
          ...changes,
          ...(proof ? { proof } : {}),
          gaps: [...changes.gaps, ...finished.gaps],
        })
      } else if (scan.next) {
        const path: string = scan.next
        const { response, reused, next } = await getGithubPage(ctx, cursor, scan, path)
        const result: Awaited<ReturnType<typeof processGithubPage>> | undefined = reused
          ? undefined
          : await processGithubPage(processContext, response.body)
        const rows = reused?.rows ?? result?.rows ?? 0
        const etag = response.headers.get('etag')
        const proof: GithubPageProof | undefined =
          reused ??
          (etag
            ? {
                path,
                etag,
                from: scan.from,
                before: result?.before ?? null,
                tag: cursor.tag,
                next,
                checkedAt: at,
                rows,
              }
            : undefined)
        const wait = response.headers.get('x-poll-interval')
        if (wait && /^\d{1,7}$/.test(wait))
          cursor = {
            ...cursor,
            nextPollAt: Math.max(cursor.nextPollAt ?? 0, at + Number(wait) * 1000),
          }
        const changes = result?.changes ?? {}
        const tasks = result?.tasks ?? []
        pull = result?.changes.pulls[0] ?? pull
        scan = { ...scan, rows: scan.rows + rows }
        if (tasks.length) {
          scan = { ...scan, next, pending: { next, tasks, ...(proof ? { proof } : {}) } }
          cursor = { ...cursor, scan }
          await ctx.store.commit(ctx.key, cursor, changes)
          continue
        }
        scan = { ...scan, next }
        const finished = finishPage(ctx, cursor, scan, at)
        cursor = finished.cursor
        await ctx.store.commit(ctx.key, cursor, {
          ...changes,
          ...(proof ? { proof } : {}),
          gaps: [...(result?.changes.gaps ?? []), ...finished.gaps],
        })
      }
      if (!scan.next) return { key: ctx.key, cursor, ...(pull ? { pull } : {}) }
    }
    if (!scan.pendingGap) {
      scan = { ...scan, pendingGap: true }
      cursor = { ...cursor, scan }
      await ctx.store.commit(ctx.key, cursor, { gaps: [scanGap(scan, 'page-budget', 'pending')] })
    }
  } catch (error) {
    if (!(error instanceof GithubFault)) throw error
    const subject =
      processingTarget || (ctx.number !== undefined && !ctx.key.stream.startsWith('runs:'))
    const fault = githubPollFault(
      error,
      subject ? 'target' : 'stream',
      ctx.issuesDisabled && ctx.key.stream.startsWith('issue'),
    )
    cursor = { ...cursor, fault }
    const gaps =
      fault.reason === 'target-unavailable'
        ? [
            {
              ...scanGap(scan, 'evidence-unavailable', 'pending'),
              ...(scan.pending?.tasks[0]
                ? githubDetailGap({ ...ctx, scan }, scan.pending.tasks[0])
                : {}),
              status: 'pending' as const,
            },
          ]
        : []
    await ctx.store.commit(ctx.key, cursor, { gaps })
  }
  return { key: ctx.key, cursor, ...(pull ? { pull } : {}) }
}
