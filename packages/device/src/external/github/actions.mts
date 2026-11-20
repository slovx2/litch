import {
  type GithubApi,
  GithubFault,
  type GithubRepository,
  githubId,
  githubNumber,
  githubObject,
  githubPermalink,
  githubRepoPath,
  githubTime,
} from './read-api.mjs'

export interface GithubBoundPull {
  number: number
  headSha: string
  headRepoId?: string
  workflowIds?: readonly string[]
}

export interface GithubRunKey {
  repoId: string
  runId: string
  attempt: number
  headSha: string
  workflowId: string
  pullNumber: number
}

export interface GithubRunWatch extends GithubRunKey {
  deadline: number
}

export interface GithubRunSnapshot {
  status: string
  conclusion: string | null
  occurredAt: number
  permalink: string
}

export type GithubRunObservation =
  | { state: 'completed' | 'waiting'; snapshot: GithubRunSnapshot }
  | {
      state: 'unknown'
      reason: 'deadline' | 'evidence-mismatch' | GithubFault['kind']
      snapshot?: GithubRunSnapshot
    }

export type GithubRunDiscovery =
  | { state: 'matched'; key: GithubRunKey }
  | {
      state: 'association-pending'
      repoId: string
      runId: string
      attempt: number
      headSha: string
      workflowId: string
    }
  | { state: 'unrelated' }

export function validGithubSha(sha: unknown): sha is string {
  return typeof sha === 'string' && /^[a-f\d]{40}$/.test(sha)
}

function runIdentity(raw: unknown) {
  const run = githubObject(raw)
  const repoId = githubId(githubObject(run.repository).id)
  const runId = githubId(run.id)
  const attempt = githubNumber(run.run_attempt)
  const workflowId = githubId(run.workflow_id)
  const headSha = run.head_sha
  return repoId && runId && attempt && workflowId && validGithubSha(headSha)
    ? { repoId, runId, attempt, workflowId, headSha }
    : undefined
}

export function discoverGithubRun(
  raw: unknown,
  repo: GithubRepository,
  bound: readonly GithubBoundPull[],
): GithubRunDiscovery {
  const key = runIdentity(raw)
  if (!key || key.repoId !== repo.repoId) throw new GithubFault('invalid-response')
  const run = githubObject(raw)
  const headRepoId = githubId(githubObject(run.head_repository).id)
  const candidates = bound.filter(
    (pr) =>
      pr.headSha === key.headSha &&
      (!pr.headRepoId || pr.headRepoId === headRepoId) &&
      (!pr.workflowIds || pr.workflowIds.includes(key.workflowId)),
  )
  if (candidates.length === 0) return { state: 'unrelated' }
  const associations = Array.isArray(run.pull_requests) ? run.pull_requests.map(githubObject) : []
  const matching = [
    ...new Set(
      associations.flatMap((pr) => {
        const base = githubObject(pr.base)
        const head = githubObject(pr.head)
        const number = githubNumber(pr.number)
        return number &&
          githubId(githubObject(base.repo).id) === key.repoId &&
          head.sha === key.headSha &&
          candidates.some(
            (candidate) =>
              candidate.number === number &&
              (!candidate.headRepoId ||
                candidate.headRepoId === githubId(githubObject(head.repo).id)),
          )
          ? [number]
          : []
      }),
    ),
  ]
  const [pullNumber] = matching
  return matching.length === 1 && pullNumber !== undefined
    ? { state: 'matched', key: { ...key, pullNumber } }
    : { state: 'association-pending', ...key }
}

export function githubRunSnapshot(raw: unknown, repo: GithubRepository): GithubRunSnapshot {
  const run = githubObject(raw)
  const runId = githubId(run.id)
  const occurredAt = githubTime(run.updated_at)
  const status = run.status
  const conclusion = run.conclusion ?? null
  if (
    !runId ||
    occurredAt === undefined ||
    typeof status !== 'string' ||
    !/^[a-z_]{1,32}$/.test(status) ||
    (conclusion !== null && (typeof conclusion !== 'string' || !/^[a-z_]{1,32}$/.test(conclusion)))
  ) {
    throw new GithubFault('invalid-response')
  }
  return {
    status,
    conclusion,
    occurredAt,
    permalink: githubPermalink(repo, `actions/runs/${runId}`),
  }
}

export async function readGithubRunAttempt(
  api: GithubApi,
  repo: GithubRepository,
  key: GithubRunKey,
): Promise<GithubRunSnapshot> {
  if (
    key.repoId !== repo.repoId ||
    !githubId(key.runId) ||
    !githubId(key.workflowId) ||
    !githubNumber(key.attempt) ||
    !githubNumber(key.pullNumber) ||
    !validGithubSha(key.headSha)
  ) {
    throw new TypeError('Invalid GitHub Actions watch')
  }
  const path = `${githubRepoPath(repo)}/actions/runs/${key.runId}`
  let raw = (await api.get(path)).body
  let identity = runIdentity(raw)
  if (!identity || identity.repoId !== key.repoId || identity.runId !== key.runId) {
    throw new GithubFault('invalid-response')
  }
  if (identity.attempt > key.attempt) {
    raw = (await api.get(`${path}/attempts/${key.attempt}`)).body
    identity = runIdentity(raw)
  }
  if (
    !identity ||
    identity.repoId !== key.repoId ||
    identity.runId !== key.runId ||
    identity.attempt !== key.attempt ||
    identity.headSha !== key.headSha ||
    identity.workflowId !== key.workflowId
  ) {
    throw new GithubFault('invalid-response')
  }
  return githubRunSnapshot(raw, repo)
}

export async function observeGithubRun(
  api: GithubApi,
  repo: GithubRepository,
  watch: GithubRunWatch,
  currentPull: GithubBoundPull,
): Promise<GithubRunObservation> {
  if (
    watch.pullNumber !== currentPull.number ||
    watch.headSha !== currentPull.headSha ||
    (currentPull.workflowIds && !currentPull.workflowIds.includes(watch.workflowId))
  ) {
    return { state: 'unknown', reason: 'evidence-mismatch' }
  }
  try {
    const snapshot = await readGithubRunAttempt(api, repo, watch)
    if (snapshot.status === 'completed' && snapshot.conclusion)
      return { state: 'completed', snapshot }
    if (api.now() >= watch.deadline) return { state: 'unknown', reason: 'deadline', snapshot }
    return { state: 'waiting', snapshot }
  } catch (error) {
    if (!(error instanceof GithubFault)) throw error
    return { state: 'unknown', reason: error.kind }
  }
}
