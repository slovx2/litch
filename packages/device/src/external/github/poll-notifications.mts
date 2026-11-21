import { notificationEvidence } from './poll-notification-evidence.mjs'
import { githubListPath, githubNextPage, githubPageTag } from './poll-pages.mjs'
import { githubPageChanges } from './poll-process.mjs'
import { githubPollFault } from './poll-scan.mjs'
import type { GithubCursor, GithubPollFault, GithubStreamKey } from './poll-state.mjs'
import { GithubFault, githubId, githubObject, githubRepoPath, githubTime } from './read-api.mjs'

const overlap = 5_000
const pageBudget = 4
const minimumInterval = 60_000

type Options = Parameters<typeof notificationEvidence>[0] & {
  enabledAt: number
  interval: number
}

export async function pollGithubNotifications(options: Options): Promise<GithubCursor> {
  const { api, bot, enabledAt, interval, repo, scope, store } = options
  const key: GithubStreamKey = { ...scope, stream: `notifications:${bot.userId}` }
  const tag = githubPageTag(api, bot, githubRepoPath(repo))
  const previous = await store.getCursor(key)
  const same = previous?.tag === tag
  const cursor: GithubCursor = {
    ...(same && previous ? previous : {}),
    tag,
    coveredThrough: Math.max(enabledAt, previous?.coveredThrough ?? enabledAt),
  }
  const at = api.now()
  if (same && Math.max(cursor.nextPollAt ?? 0, cursor.fault?.retryAt ?? 0) > at) return cursor

  const from = Math.max(enabledAt, cursor.coveredThrough - overlap)
  // since 是严格的下界；额外回退一秒保留同秒抵达的通知。
  const first = githubListPath(`${githubRepoPath(repo)}/notifications`, {
    all: 'true',
    since: new Date(Math.floor(from / 1000) * 1000 - 1000).toISOString().replace('.000Z', 'Z'),
  })
  const state = cursor.notifications ?? { seen: [] }
  const pending = state.pending?.path === first ? state.pending : undefined
  const conditional = state.conditional?.path === first && !pending ? state.conditional : undefined
  const versions = new Map(
    state.seen
      .filter(({ updatedAt }) => updatedAt >= from)
      .map((row) => [`${row.id}/${row.updatedAt}`, row]),
  )
  const seen = () => [...versions.values()]
  let path = pending?.next ?? first
  let newestAt = pending?.newestAt ?? cursor.coveredThrough
  let nextAt = at + Math.max(interval, minimumInterval)
  let fault: GithubPollFault | undefined
  let headers = conditional
  let changes = githubPageChanges()

  for (let page = 0; page < pageBudget; page++) {
    try {
      const response = await api.get(path, headers?.etag, headers?.modified)
      const wait = response.headers.get('x-poll-interval')
      if (wait && /^\d{1,7}$/.test(wait)) nextAt = Math.max(nextAt, api.now() + Number(wait) * 1000)
      if (response.status === 304) {
        if (!headers) throw new GithubFault('invalid-response')
        path = ''
        break
      }
      if (!Array.isArray(response.body) || response.body.length > 100)
        throw new GithubFault('invalid-response')
      const next = githubNextPage(response.headers, path, repo)
      const etag = response.headers.get('etag') ?? undefined
      const modified = response.headers.get('last-modified') ?? undefined
      headers =
        !next && path === first && (etag || modified)
          ? { path, ...(etag ? { etag } : {}), ...(modified ? { modified } : {}) }
          : undefined
      changes = githubPageChanges()
      let pageFault: GithubFault | undefined
      for (const row of response.body.map(githubObject)) {
        const id = githubId(row.id)
        const updated = githubTime(row.updated_at)
        if (!id || updated === undefined) throw new GithubFault('invalid-response')
        newestAt = Math.max(newestAt, updated)
        const version = `${id}/${updated}`
        if (updated < from || versions.has(version)) continue
        try {
          const evidence = await notificationEvidence(options, row, from)
          changes.subjects.push(...(evidence.subjects ?? []))
          changes.observations.push(...(evidence.observations ?? []))
          changes.events.push(...(evidence.events ?? []))
        } catch (error) {
          if (!(error instanceof GithubFault)) throw error
          if (error.kind !== 'not-found' && error.kind !== 'disabled') {
            pageFault ??= error
            if (error.kind === 'primary-rate' || error.kind === 'secondary-rate') break
            continue
          }
        }
        versions.set(version, { id, updatedAt: updated })
      }
      if (pageFault) throw pageFault
      path = next ?? ''
      if (!path) break
      // 每页的去重、证据和续点一起提交。失败或重启不会重放已处理的条目。
      await store.commit(
        key,
        {
          ...cursor,
          nextPollAt: nextAt,
          notifications: { seen: seen(), pending: { path: first, next: path, newestAt } },
        },
        changes,
      )
      changes = githubPageChanges()
    } catch (error) {
      if (!(error instanceof GithubFault)) throw error
      fault = githubPollFault(error, 'stream')
      headers = undefined
      break
    }
  }

  const coveredThrough = path ? cursor.coveredThrough : newestAt
  const result: GithubCursor = {
    tag,
    coveredThrough,
    checkedAt: at,
    nextPollAt: nextAt,
    ...(fault ? { fault } : {}),
    notifications: {
      seen: seen(),
      ...(path ? { pending: { path: first, next: path, newestAt } } : {}),
      ...(!path && headers ? { conditional: headers } : {}),
    },
  }
  await store.commit(key, result, changes)
  return result
}
