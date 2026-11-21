import type { GithubRunDiscovery } from './actions.mjs'
import {
  discoverGithubRun,
  type GithubBoundPull,
  githubRunSnapshot,
  readGithubRunAttempt,
} from './actions.mjs'
import type { GithubActorEvidence } from './identity.mjs'
import {
  githubActionStub,
  githubActionType,
  githubCommentNumber,
  githubCommentParent,
  githubContentCandidate,
  githubContentChange,
  githubPullCandidate,
  githubPullObservation,
  githubPullTerminal,
  githubRunEvent,
  githubSubjectObservation,
  githubVerifiedAction,
  requiredNumber,
  requiredTime,
  subjectKind,
} from './poll-events.mjs'
import { githubListPath, githubNextPage } from './poll-pages.mjs'
import type {
  GithubActionStub,
  GithubContentCandidate,
  GithubDetailTask,
  GithubGap,
  GithubObjectObservation,
  GithubPollEvent,
  GithubPollStore,
  GithubPullCandidate,
  GithubPullObservation,
  GithubScan,
  GithubStreamKey,
  GithubSubjectKind,
  GithubSubjectObservation,
} from './poll-state.mjs'
import {
  type GithubApi,
  GithubFault,
  type GithubRepository,
  githubObject,
  githubRepoPath,
  githubSubjectNumber,
  type JsonObject,
} from './read-api.mjs'

export interface GithubProcessContext {
  api: GithubApi
  repo: GithubRepository
  bot: GithubActorEvidence
  store: GithubPollStore
  key: GithubStreamKey
  enabledAt: number
  scan: GithubScan
  bound?: GithubBoundPull
  boundPeers?: readonly GithubBoundPull[]
  number?: number
}

export function githubPageChanges() {
  return {
    subjects: [] as GithubSubjectObservation[],
    events: [] as GithubPollEvent[],
    observations: [] as GithubObjectObservation[],
    candidates: [] as GithubPullCandidate[],
    pulls: [] as GithubPullObservation[],
    runs: [] as Exclude<GithubRunDiscovery, { state: 'unrelated' }>[],
    gaps: [] as GithubGap[],
  }
}

type Changes = ReturnType<typeof githubPageChanges>

function within(ctx: GithubProcessContext, at: number): boolean {
  return at >= ctx.scan.from && at <= ctx.scan.to
}

function emitTimed(ctx: GithubProcessContext, event: GithubPollEvent, changes: Changes) {
  const at = event.occurredAt * 1000
  if (at >= ctx.enabledAt && within(ctx, at)) changes.events.push(event)
}

async function content(
  ctx: GithubProcessContext,
  candidate: GithubContentCandidate,
  kind: GithubSubjectKind,
  changes: Changes,
) {
  const previous =
    changes.observations.findLast((row) => row.objectKey === candidate.objectKey) ??
    (await ctx.store.getObservation(ctx.key, candidate.objectKey))
  const result = githubContentChange(
    candidate,
    previous,
    ctx.repo,
    kind,
    ctx.bot.userId,
    ctx.enabledAt,
    ctx.scan.to,
    ctx.api.now(),
  )
  if (result.observation) changes.observations.push(result.observation)
  if (result.event) changes.events.push(result.event)
}

async function addPull(
  ctx: GithubProcessContext,
  raw: JsonObject,
  changes: Changes,
  number: number,
  expectedId?: string,
) {
  const pull = githubPullObservation(raw, ctx.repo, number, expectedId)
  changes.subjects.push(githubSubjectObservation(raw, ctx.repo, 'pull'))
  changes.pulls.push(pull)
  changes.candidates.push(githubPullCandidate(raw, ctx.scan.to, ctx.key.stream.startsWith('pull:')))
  if (within(ctx, pull.updatedAt))
    await content(ctx, githubContentCandidate(raw, 'pull', number, ctx.bot), 'pull', changes)
  const terminal = githubPullTerminal(raw, pull, ctx.repo)
  if (terminal) emitTimed(ctx, terminal, changes)
}

export function githubDetailGap(ctx: GithubProcessContext, task: GithubDetailTask): GithubGap {
  const number =
    task.kind === 'run'
      ? task.key.pullNumber
      : task.kind === 'parent'
        ? task.candidate.number
        : task.number
  return {
    from: ctx.scan.from,
    to: ctx.scan.to,
    reason: 'evidence-unavailable',
    status: 'pending',
    subjectNumber: number,
  }
}

export async function processGithubDetail(ctx: GithubProcessContext, task: GithubDetailTask) {
  const changes = githubPageChanges()
  const base = githubRepoPath(ctx.repo)
  let continuation: GithubDetailTask | undefined
  if (task.kind === 'parent') {
    const raw = githubObject((await ctx.api.get(`${base}/issues/${task.candidate.number}`)).body)
    if (requiredNumber(raw.number) !== task.candidate.number)
      throw new GithubFault('invalid-response')
    const kind = subjectKind(raw)
    if (kind === 'pull') changes.candidates.push(githubPullCandidate(raw, ctx.scan.to))
    await content(ctx, task.candidate, kind, changes)
  } else if (task.kind === 'pull') {
    const raw = githubObject((await ctx.api.get(`${base}/pulls/${task.number}`)).body)
    await addPull(ctx, raw, changes, task.number, task.expectedId)
  } else if (task.kind === 'run') {
    const snapshot = await readGithubRunAttempt(ctx.api, ctx.repo, task.key)
    emitTimed(ctx, githubRunEvent(ctx.repo, task.key, snapshot), changes)
  } else {
    const path = task.next ?? githubListPath(`${base}/issues/${task.number}/timeline`)
    const response = await ctx.api.get(path)
    if (!Array.isArray(response.body)) throw new GithubFault('invalid-response')
    const remaining = new Map(task.remaining.map((stub) => [stub.id, stub]))
    for (const item of response.body) {
      const row = githubObject(item)
      const id = typeof row.id === 'string' ? row.id : undefined
      const expected = id ? remaining.get(id) : undefined
      const kind = githubActionType(row)
      // 不同资源（例如评论、review）的数字 ID 不是同一命名空间。
      if (!expected || expected.action !== kind) continue
      const event = githubVerifiedAction(
        ctx.repo,
        task.number,
        task.subjectKind,
        expected,
        githubActionStub(row, kind),
      )
      if (event) {
        remaining.delete(expected.id)
        emitTimed(ctx, event, changes)
      }
    }
    const next = githubNextPage(response.headers, path, ctx.repo)
    if (remaining.size && next) continuation = { ...task, remaining: [...remaining.values()], next }
    else if (remaining.size) changes.gaps.push(githubDetailGap(ctx, task))
  }
  return { changes, continuation }
}

export async function processGithubPage(ctx: GithubProcessContext, body: unknown) {
  const stream = ctx.key.stream
  const changes = githubPageChanges()
  const tasks: GithubDetailTask[] = []
  const timelines = new Map<number, { subjectKind: GithubSubjectKind; stubs: GithubActionStub[] }>()
  let before: number | null = null
  const recent = (at: number) => {
    if (at > ctx.scan.to) before = before === null ? at : Math.min(before, at)
    return within(ctx, at)
  }
  if (stream.startsWith('pull:')) {
    const raw = githubObject(body)
    recent(requiredTime(raw.updated_at))
    await addPull(ctx, raw, changes, requiredNumber(ctx.number))
    return { changes, tasks, before, rows: 1 }
  }
  const batch = stream.startsWith('runs:') ? githubObject(body).workflow_runs : body
  if (!Array.isArray(batch) || batch.length > 100) throw new GithubFault('invalid-response')
  for (const item of batch) {
    const raw = githubObject(item)
    if (stream === 'issues') {
      const at = requiredTime(raw.updated_at)
      if (!recent(at)) continue
      const number = requiredNumber(raw.number)
      const kind = subjectKind(raw)
      if (kind === 'issue') {
        changes.subjects.push(githubSubjectObservation(raw, ctx.repo, kind))
        await content(ctx, githubContentCandidate(raw, kind, number, ctx.bot), kind, changes)
      }
      if (kind === 'pull') {
        changes.candidates.push(githubPullCandidate(raw, ctx.scan.to))
        // Issues 与 Pulls 的对象 ID 不共用；用固定仓库数字 ID 和共享编号核对。
        tasks.push({ kind: 'pull', number })
      }
    } else if (stream === 'issue-events') {
      const action = githubActionType(raw)
      if (!action) continue
      if (
        (action === 'review_requested' || action === 'review_request_removed') &&
        raw.requested_team &&
        !raw.requested_reviewer
      )
        continue
      const stub = githubActionStub(raw, action)
      if (!recent(stub.at) || stub.at < ctx.enabledAt) continue
      const issue = githubObject(raw.issue)
      const number = requiredNumber(issue.number)
      const kind = subjectKind(issue)
      if (kind === 'pull') {
        changes.candidates.push({ number, discoveredAt: stub.at })
        if (action === 'closed') {
          tasks.push({ kind: 'pull', number })
          continue
        }
      }
      const group = timelines.get(number) ?? { subjectKind: kind, stubs: [] }
      group.stubs.push(stub)
      timelines.set(number, group)
    } else if (
      stream === 'issue-comments' ||
      stream === 'review-comments' ||
      stream.startsWith('subject-comments:') ||
      stream.startsWith('subject-review-comments:')
    ) {
      if (!recent(requiredTime(raw.updated_at))) continue
      const kind =
        stream === 'issue-comments' || stream.startsWith('subject-comments:')
          ? 'issue-comment'
          : 'review-comment'
      const number = githubCommentNumber(raw, ctx.repo, kind)
      if (ctx.number !== undefined && ctx.number !== number)
        throw new GithubFault('invalid-response')
      const candidate = githubContentCandidate(raw, kind, number, ctx.bot)
      const parent =
        kind === 'review-comment' ? 'pull' : githubCommentParent(candidate, raw, ctx.repo)
      if (parent === 'pull') changes.candidates.push({ number, discoveredAt: candidate.updatedAt })
      if (parent) await content(ctx, candidate, parent, changes)
      else tasks.push({ kind: 'parent', candidate })
    } else if (stream.startsWith('reviews:')) {
      if (raw.state === 'PENDING' || raw.submitted_at == null) continue
      const number = requiredNumber(ctx.number)
      if (githubSubjectNumber(raw.pull_request_url, ctx.repo, 'pulls') !== number)
        throw new GithubFault('invalid-response')
      const candidate = githubContentCandidate(raw, 'review', number, ctx.bot)
      // 已知的 review 即使提交很早也要比对摘要；没有编辑时间不能靠 since。
      recent(candidate.updatedAt)
      if (candidate.updatedAt <= ctx.scan.to) {
        await content(ctx, candidate, 'pull', changes)
      }
    } else if (stream.startsWith('runs:') && ctx.bound) {
      const run = discoverGithubRun(raw, ctx.repo, ctx.boundPeers ?? [ctx.bound])
      if (
        run.state === 'unrelated' ||
        (run.state === 'matched' && run.key.pullNumber !== ctx.bound.number)
      )
        continue
      const snapshot = githubRunSnapshot(raw, ctx.repo)
      if (!recent(snapshot.occurredAt)) continue
      changes.runs.push(run)
      if (run.state === 'matched') tasks.push({ kind: 'run', key: run.key })
    }
  }
  for (const [number, timeline] of timelines) {
    tasks.push({
      kind: 'timeline',
      number,
      subjectKind: timeline.subjectKind,
      remaining: timeline.stubs,
    })
  }
  return { changes, tasks, before, rows: batch.length }
}
