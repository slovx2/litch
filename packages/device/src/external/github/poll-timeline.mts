import { githubActionStub, githubActionType } from './poll-events.mjs'
import { githubListPath, githubNextPage } from './poll-pages.mjs'
import {
  type GithubApi,
  GithubFault,
  type GithubRepository,
  githubObject,
  githubRepoPath,
  githubTime,
} from './read-api.mjs'

export function githubTimelinePath(repo: GithubRepository, number: number): string {
  return githubListPath(`${githubRepoPath(repo)}/issues/${number}/timeline`, { page: '1' })
}

export interface GithubTimelinePage {
  path: string
  backwards?: true
}

/** GitHub 的主题时间线从旧到新。先取末页，再向前核对当前窗口。 */
export async function recentGithubTimelinePage(
  api: GithubApi,
  repo: GithubRepository,
  { path, backwards }: GithubTimelinePage,
  from: number,
) {
  const response = await api.get(path)
  if (!Array.isArray(response.body) || response.body.length > 100)
    throw new GithubFault('invalid-response')
  const next = backwards ? null : githubNextPage(response.headers, path, repo)
  if (next && new URL(path, 'https://api.github.com').searchParams.get('page') === '1') {
    const last = githubNextPage(response.headers, path, repo, 'last')
    if (last) return { actions: [], next: { path: last, backwards: true } as const }
  }
  const rows = response.body.map(githubObject)
  const old =
    rows.length > 0 &&
    rows.every((row) => (githubTime(row.created_at ?? row.submitted_at) ?? from) < from)
  const actions = rows.flatMap((row) => {
    const kind = githubActionType(row)
    if (!kind || (githubTime(row.created_at) ?? 0) < from) return []
    if (
      (kind === 'review_requested' || kind === 'review_request_removed') &&
      row.requested_team &&
      !row.requested_reviewer
    )
      return []
    return [githubActionStub(row, kind)]
  })
  const previous = backwards && !old ? githubNextPage(response.headers, path, repo, 'prev') : null
  const continuation: GithubTimelinePage | null = next
    ? { path: next }
    : previous
      ? { path: previous, backwards: true }
      : null
  return { actions, next: continuation }
}
