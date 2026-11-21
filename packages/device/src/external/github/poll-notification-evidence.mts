import type { GithubActorEvidence } from './identity.mjs'
import {
  githubCommentNumber,
  githubContentCandidate,
  githubContentChange,
  githubSubjectObservation,
  githubVerifiedAction,
} from './poll-events.mjs'
import type { GithubPageChanges, GithubPollStore, GithubScope } from './poll-state.mjs'
import {
  type GithubTimelinePage,
  githubTimelinePath,
  recentGithubTimelinePage,
} from './poll-timeline.mjs'
import {
  type GithubApi,
  GithubFault,
  type GithubRepository,
  githubId,
  githubObject,
  githubRepoPath,
  githubSubjectNumber,
  githubTime,
} from './read-api.mjs'

const relevant = new Set(['mention', 'team_mention', 'assign', 'review_requested', 'comment'])

interface NotificationEvidenceOptions {
  api: GithubApi
  store: GithubPollStore
  scope: GithubScope
  repo: GithubRepository
  bot: GithubActorEvidence
  botIds: ReadonlySet<string>
  boundNumbers: ReadonlySet<number>
}

function contentAddress(raw: unknown, repo: GithubRepository, number: number) {
  if (typeof raw !== 'string') return
  try {
    const url = new URL(raw)
    if (
      url.origin !== 'https://api.github.com' ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      return
    const base = githubRepoPath(repo)
    for (const prefix of [base, `/repositories/${repo.repoId}`]) {
      if (!url.pathname.toLowerCase().startsWith(`${prefix.toLowerCase()}/`)) continue
      const suffix = url.pathname.slice(prefix.length)
      const comment = /^\/(issues|pulls)\/comments\/([1-9][0-9]*)$/.exec(suffix)
      if (comment)
        return {
          kind: comment[1] === 'issues' ? 'issue-comment' : 'review-comment',
          id: comment[2],
          path: base + suffix,
        } as const
      const review = /^\/pulls\/([1-9][0-9]*)\/reviews\/([1-9][0-9]*)$/.exec(suffix)
      if (review && Number(review[1]) === number)
        return { kind: 'review', id: review[2], path: base + suffix } as const
    }
  } catch {
    return
  }
}

/** 通知只提供线索。身份、动作和版本必须从原始 GitHub 资源核对。 */
export async function notificationEvidence(
  ctx: NotificationEvidenceOptions,
  row: Record<string, unknown>,
  from: number,
): Promise<GithubPageChanges> {
  const { api, repo, bot } = ctx
  const reason = typeof row.reason === 'string' ? row.reason : ''
  if (!relevant.has(reason) || githubId(githubObject(row.repository).id) !== repo.repoId) return {}
  const subject = githubObject(row.subject)
  const pull = subject.type === 'PullRequest'
  if (!pull && subject.type !== 'Issue') return {}
  const kind = pull ? 'pull' : 'issue'
  const family = pull ? 'pulls' : 'issues'
  const number = githubSubjectNumber(subject.url, repo, family)
  if (!number || (reason === 'comment' && !ctx.boundNumbers.has(number))) return {}
  const root = githubRepoPath(repo)
  const raw = githubObject((await api.get(`${root}/${family}/${number}`)).body)
  if (
    raw.number !== number ||
    (pull && githubId(githubObject(githubObject(raw.base).repo).id) !== repo.repoId) ||
    (!pull && raw.pull_request)
  )
    throw new GithubFault('invalid-response')

  const subjects = [githubSubjectObservation(raw, repo, kind)]
  if (reason === 'assign' || reason === 'review_requested') {
    if (reason === 'review_requested' && !pull) return {}
    const action = reason === 'assign' ? 'assigned' : 'review_requested'
    const events: NonNullable<GithubPageChanges['events']>[number][] = []
    let path: GithubTimelinePage | null = { path: githubTimelinePath(repo, number) }
    const until = (githubTime(row.updated_at) ?? api.now()) + 5_000
    for (let page = 0; path && page < 8; page++) {
      const timeline = await recentGithubTimelinePage(api, repo, path, from)
      for (const stub of timeline.actions) {
        const target = action === 'assigned' ? stub.assigneeId : stub.reviewerId
        if (stub.action !== action || target !== bot.userId || stub.at > until) continue
        const event = githubVerifiedAction(repo, number, kind, stub, stub)
        if (event && !ctx.botIds.has(event.actorEvidence?.userId ?? '')) events.push(event)
      }
      // 一条通知指向一个主题版本；更早动作由仓库兜底核对。
      if (events.length) break
      path = timeline.next
    }
    return { subjects, events: events.sort((a, b) => a.occurredAt - b.occurredAt) }
  }

  const address = contentAddress(subject.latest_comment_url, repo, number)
  if (
    subject.latest_comment_url != null &&
    !address &&
    githubSubjectNumber(subject.latest_comment_url, repo, family) !== number
  )
    return { subjects }
  let content = raw
  if (address) {
    if (!pull && address.kind !== 'issue-comment') return { subjects }
    content = githubObject((await api.get(address.path)).body)
    if (
      githubId(content.id) !== address.id ||
      (address.kind === 'review'
        ? githubSubjectNumber(content.pull_request_url, repo, 'pulls') !== number
        : githubCommentNumber(content, repo, address.kind) !== number)
    )
      throw new GithubFault('invalid-response')
  } else if (reason === 'comment') return { subjects }

  const candidate = githubContentCandidate(content, address?.kind ?? kind, number, bot)
  const previous = await ctx.store.getObservation(ctx.scope, candidate.objectKey)
  if (
    candidate.updatedAt < from ||
    !candidate.actor ||
    ctx.botIds.has(candidate.actor.userId) ||
    (!candidate.mentioned && !ctx.boundNumbers.has(number)) ||
    // Issue/PR 的 updated_at 也会因评论而变化，不能把旧正文当作新通知。
    (!address &&
      candidate.createdAt < from &&
      (candidate.updatedAt !== githubTime(row.updated_at) ||
        !previous ||
        previous.hash === candidate.hash))
  )
    return { subjects }
  const { observation, event } = githubContentChange(
    candidate,
    // 仓库流若刚记录了同一版本，仍用原来的事件键提升它的入箱优先级。
    previous?.updatedAt === candidate.updatedAt && previous.hash === candidate.hash
      ? undefined
      : previous,
    repo,
    kind,
    bot.userId,
    from,
    api.now(),
    api.now(),
  )
  return {
    subjects,
    ...(observation ? { observations: [observation] } : {}),
    ...(event ? { events: [event] } : {}),
  }
}
