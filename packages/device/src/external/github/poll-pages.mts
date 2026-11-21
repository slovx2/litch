import type { GithubActorEvidence } from './identity.mjs'
import type { GithubPageProof, GithubScan, GithubStreamKey } from './poll-state.mjs'
import {
  GITHUB_API_VERSION,
  type GithubApi,
  GithubFault,
  type GithubRepository,
  githubRepoPath,
} from './read-api.mjs'

const apiHost = 'https://api.github.com'

export function githubPageTag(api: GithubApi, bot: GithubActorEvidence, filter = ''): string {
  return JSON.stringify([
    GITHUB_API_VERSION,
    api.generation,
    bot.userId,
    bot.login.toLowerCase(),
    filter,
  ])
}

export function githubListPath(path: string, query: Record<string, string> = {}): string {
  return `${path}?${new URLSearchParams({ per_page: '100', ...query })}`
}

export function githubNextPage(
  headers: Headers,
  path: string,
  repo: GithubRepository,
  relation: 'next' | 'last' | 'prev' = 'next',
): string | null {
  let next: string | null = null
  for (const match of (headers.get('link') ?? '').matchAll(
    /<([^>]+)>\s*;\s*rel="?([^";,\s]+)"?/g,
  )) {
    if (match[2] !== relation) continue
    if (next || !match[1]) throw new GithubFault('invalid-response')
    try {
      const current = new URL(path, apiHost)
      const url = new URL(match[1], current)
      const byName = githubRepoPath(repo)
      const byId = `/repositories/${repo.repoId}`
      const canonical = (value: string) =>
        value.startsWith(`${byName}/`) ? byId + value.slice(byName.length) : value
      if (
        url.origin !== apiHost ||
        url.username ||
        url.password ||
        url.hash ||
        canonical(url.pathname) !== canonical(current.pathname)
      )
        throw new Error()
      // 只接续同一查询的下一页。明确拒绝跨仓库、参数变化、跳页和循环。
      const page = url.searchParams.getAll('page')
      const currentPage = Number(current.searchParams.get('page') ?? '1')
      if (
        page.length !== 1 ||
        !/^[1-9]\d*$/.test(page[0] ?? '') ||
        (relation === 'last'
          ? Number(page[0]) <= currentPage
          : Number(page[0]) !== currentPage + (relation === 'next' ? 1 : -1))
      )
        throw new Error()
      current.searchParams.delete('page')
      url.searchParams.delete('page')
      current.searchParams.sort()
      url.searchParams.sort()
      if (current.searchParams.toString() !== url.searchParams.toString()) throw new Error()
      next = `${url.pathname}${new URL(match[1], new URL(path, apiHost)).search}`
    } catch {
      throw new GithubFault('invalid-response')
    }
  }
  if (!next && new RegExp(`\\brel\\s*=\\s*"?${relation}\\b`).test(headers.get('link') ?? ''))
    throw new GithubFault('invalid-response')
  return next
}

export function canReuseGithubPage(
  proof: GithubPageProof | undefined,
  key: GithubStreamKey,
  path: string,
  tag: string,
  scan: GithubScan,
  now: number,
): proof is GithubPageProof {
  // reviews 必须比较当前对象版本；未提供编辑时间的 review 不能用历史窗口判定。
  return (
    !key.stream.startsWith('reviews:') &&
    !key.stream.startsWith('pull:') &&
    !!proof &&
    proof.path === path &&
    proof.tag === tag &&
    proof.from <= scan.from &&
    (proof.before === null || scan.to < proof.before) &&
    now - proof.checkedAt <= 2 * 24 * 60 * 60_000
  )
}
