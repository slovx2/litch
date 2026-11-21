import type {
  ExternalCursor,
  ExternalObservation,
  ExternalPollCheckpoint,
  ExternalStore,
} from '../../external-store.mjs'
import { decodeCheckpoint, encodeCheckpoint } from './poll-checkpoint.mjs'
import { GithubEvidenceStore } from './poll-evidence-store.mjs'
import type {
  GithubAccessGate,
  GithubCursor,
  GithubGap,
  GithubObjectObservation,
  GithubPageChanges,
  GithubPageProof,
  GithubPollStore,
  GithubPullCandidate,
  GithubPullObservation,
  GithubReviewSelection,
  GithubScope,
  GithubStreamKey,
} from './poll-state.mjs'
import { githubNumber } from './read-api.mjs'

const repoStream = 'github:repository'
const accessStream = 'github:access'
const singleton = 'state'
const twoDays = 2 * 24 * 60 * 60_000
const seconds = (ms: number) => Math.floor(ms / 1000)
const write = (bucket: string, key: string, value: object | null): ExternalPollCheckpoint => ({
  bucket,
  key,
  value: value === null ? null : encodeCheckpoint(value),
})

interface ReviewSchedule {
  number: number
  attemptedAt: number
  tag: string
  blocked: boolean
  retryAt?: number
}

type RunDiscovery = NonNullable<GithubPageChanges['runs']>[number]

function gapKey(gap: GithubGap): string {
  return JSON.stringify([
    gap.reason,
    gap.from / 1000,
    gap.to / 1000,
    gap.subjectNumber === undefined ? null : String(gap.subjectNumber),
  ])
}

function externalCursor(
  key: GithubStreamKey,
  cursor: GithubCursor,
  gap?: GithubGap,
): ExternalCursor {
  const { scan, checkedAt, stopped, fault, nextPollAt } = cursor
  const backoffReason = fault?.reason ?? stopped
  const backoff = Math.max(fault?.retryAt ?? 0, nextPollAt ?? 0)
  return {
    ...key,
    coveredThrough: seconds(cursor.coveredThrough),
    ...(checkedAt !== undefined ? { checkedAt: seconds(checkedAt) } : {}),
    ...(backoff ? { backoffUntil: Math.ceil(backoff / 1000) } : {}),
    ...(backoffReason ? { backoffReason } : {}),
    ...(gap ? { gap: { from: seconds(gap.from), to: seconds(gap.to), reason: gap.reason } } : {}),
    ...(scan
      ? {
          window: {
            from: seconds(scan.from),
            to: seconds(scan.to),
            expiresAt: Math.ceil(scan.expiresAt / 1000),
            ...(scan.next ? { nextPage: scan.next } : {}),
          },
        }
      : {}),
  }
}

function externalObservation(row: GithubObjectObservation): ExternalObservation {
  const { objectKey, subjectKey, objectId, observedAt, updatedAt, hash, mentioned } = row
  return {
    objectKey,
    subjectKey,
    objectId,
    observedAt: observedAt / 1000,
    updatedAt: updatedAt / 1000,
    contentHash: hash,
    mentionsBot: mentioned,
    seen: true,
  }
}

function mergeCandidate(
  previous: GithubPullCandidate | undefined,
  next: GithubPullCandidate,
): GithubPullCandidate {
  // 目录页的旧快照不能覆盖新状态；来自评论或请求的发现时间独立保留。
  const discoveredAt = Math.min(next.discoveredAt, next.updatedAt ?? next.discoveredAt)
  if (!previous) return { ...next, discoveredAt }
  const known =
    next.updatedAt !== undefined && next.updatedAt < (previous.updatedAt ?? 0)
      ? previous
      : { ...previous, ...next }
  return { ...known, discoveredAt: Math.max(previous.discoveredAt, discoveredAt) }
}

export class SqliteGithubPollStore implements GithubPollStore {
  readonly evidence: GithubEvidenceStore
  private readonly store: ExternalStore
  private readonly now: () => number

  constructor(store: ExternalStore, now = Date.now) {
    this.store = store
    this.now = now
    this.evidence = new GithubEvidenceStore(store)
  }

  async getGate(key: { sourceId: string; repoId?: string }): Promise<GithubAccessGate | undefined> {
    return this.checkpoint(
      { sourceId: key.sourceId, repoId: key.repoId ?? '', stream: accessStream },
      'gate',
      singleton,
    )
  }

  async setGate(
    key: { sourceId: string; repoId?: string },
    gate: GithubAccessGate | null,
  ): Promise<void> {
    this.store.writePollCheckpoints({ ...key, stream: accessStream }, [
      write('gate', singleton, gate),
    ])
  }

  async getCursor(key: GithubStreamKey): Promise<GithubCursor | undefined> {
    return this.checkpoint(key, 'cursor', singleton)
  }

  async getObservation(
    scope: GithubScope,
    objectKey: string,
  ): Promise<GithubObjectObservation | undefined> {
    const observed = this.store.latestObservation(scope.sourceId, scope.repoId, objectKey)
    if (observed?.contentHash === undefined) return undefined
    const { subjectKey, objectId, observedAt, updatedAt, contentHash: hash, mentionsBot } = observed
    return {
      objectKey,
      subjectKey,
      objectId,
      observedAt: Math.round(observedAt * 1000),
      updatedAt: Math.round(updatedAt * 1000),
      hash,
      mentioned: mentionsBot ?? false,
    }
  }

  async getPage(key: GithubStreamKey, path: string): Promise<GithubPageProof | undefined> {
    return this.checkpoint(key, 'page', path)
  }

  async listReviewCandidates(
    scope: GithubScope,
    recentSince: number,
    limit: number,
    { boundNumbers = [], resume, tag }: GithubReviewSelection = {},
  ): Promise<readonly number[]> {
    const key = { ...scope, stream: repoStream }
    const numbers = new Set(boundNumbers)
    for (const candidate of this.checkpoints<GithubPullCandidate>(key, 'pull-candidate')) {
      const { number, state, discoveredAt, updatedAt, closedAt } = candidate
      if (state === 'open' || Math.max(discoveredAt, updatedAt ?? 0, closedAt ?? 0) >= recentSince)
        numbers.add(number)
    }
    const now = this.now()
    const schedule = new Map(
      this.checkpoints<ReviewSchedule>(key, 'review-schedule').map((row) => [row.number, row]),
    )
    return [...numbers]
      .filter((number) => {
        const row = schedule.get(number)
        return (
          !row ||
          resume ||
          (tag !== undefined && tag !== row.tag) ||
          (!row.blocked && (row.retryAt ?? 0) <= now)
        )
      })
      .sort(
        (a, b) =>
          (schedule.get(a)?.attemptedAt ?? 0) - (schedule.get(b)?.attemptedAt ?? 0) || a - b,
      )
      .slice(0, limit)
  }

  runDiscoveries(scope: GithubScope): RunDiscovery[] {
    return this.checkpoints({ ...scope, stream: repoStream }, 'run')
  }

  pullSnapshot(scope: GithubScope, number: number): GithubPullObservation | undefined {
    return this.checkpoint({ ...scope, stream: repoStream }, 'pull', String(number))
  }

  async commit(
    key: GithubStreamKey,
    cursor: GithubCursor,
    changes: GithubPageChanges,
  ): Promise<void> {
    const at = this.now()
    this.store.transaction(() => {
      const local: ExternalPollCheckpoint[] = [write('cursor', singleton, cursor)]
      const shared: ExternalPollCheckpoint[] = []
      const repoKey = { ...key, stream: repoStream }
      const gaps = new Map(this.checkpoints<GithubGap>(key, 'gap').map((gap) => [gapKey(gap), gap]))
      for (const gap of changes.gaps ?? []) {
        const id = gapKey(gap)
        gaps.set(id, gap)
        local.push(write('gap', id, gap))
      }
      const gap = [...gaps.values()]
        .filter((row) => row.status !== 'resolved')
        .sort((a, b) => b.to - a.to)[0]
      const previous = this.checkpoint<GithubCursor>(key, 'cursor', singleton)
      if (cursor.repairAt !== undefined && cursor.repairAt !== previous?.repairAt) {
        // ETag 证明仅复用两天；在周期性回扫完成后清理无用的完整 URL。
        for (const proof of this.checkpoints<GithubPageProof>(key, 'page')) {
          if (proof.checkedAt < at - twoDays && proof.path !== changes.proof?.path)
            local.push(write('page', proof.path, null))
        }
      }
      if (changes.proof) local.push(write('page', changes.proof.path, changes.proof))
      const candidates = new Map<number, GithubPullCandidate>()
      for (const candidate of changes.candidates ?? []) {
        const id = candidate.number
        candidates.set(
          id,
          mergeCandidate(
            candidates.get(id) ?? this.checkpoint(repoKey, 'pull-candidate', String(id)),
            candidate,
          ),
        )
      }
      for (const [id, candidate] of candidates)
        shared.push(write('pull-candidate', String(id), candidate))
      for (const pull of changes.pulls ?? []) {
        const before = this.pullSnapshot(key, pull.number)
        if (!before || before.updatedAt <= pull.updatedAt)
          shared.push(write('pull', String(pull.number), pull))
      }
      for (const run of changes.runs ?? []) {
        const { runId, attempt } = run.state === 'matched' ? run.key : run
        const id = `${runId}/${attempt}`
        const before = this.checkpoint<RunDiscovery>(repoKey, 'run', id)
        if (run.state === 'matched' || before?.state !== 'matched')
          shared.push(write('run', id, run))
      }
      if (key.stream.startsWith('reviews:')) {
        const number = githubNumber(Number(key.stream.slice('reviews:'.length)))
        const retryAt = Math.max(
          cursor.fault?.retryAt ?? 0,
          cursor.scan ? 0 : (cursor.nextPollAt ?? 0),
        )
        if (number)
          shared.push(
            write('review-schedule', String(number), {
              number,
              attemptedAt: at,
              tag: cursor.tag,
              blocked: !!cursor.fault?.paused,
              ...(retryAt ? { retryAt } : {}),
            } satisfies ReviewSchedule),
          )
      }
      this.store.commitPollPage({
        cursor: externalCursor(key, cursor, gap),
        observations: (changes.observations ?? []).map(externalObservation),
        checkpoints: local,
      })
      this.store.writePollCheckpoints(repoKey, shared)
      this.evidence.stage(key, changes.events ?? [], seconds(at))
      for (const subject of changes.subjects ?? [])
        this.store.observeSubject(
          key.sourceId,
          {
            ...subject,
            updatedAt: seconds(subject.updatedAt),
          },
          seconds(at),
        )
    })
  }

  private checkpoint<T extends object>(
    key: GithubScope & { stream: string },
    bucket: string,
    id: string,
  ): T | undefined {
    return decodeCheckpoint<T>(
      this.store.pollCheckpoint(key.sourceId, key.repoId, key.stream, bucket, id),
    )
  }

  private checkpoints<T extends object>(
    key: GithubScope & { stream: string },
    bucket: string,
  ): T[] {
    return this.store
      .pollCheckpoints(key.sourceId, key.repoId, key.stream, bucket)
      .map((value) => decodeCheckpoint<T>(value))
      .filter((value) => value !== undefined)
  }
}
