import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { TestContext } from 'node:test'
import type {
  GithubAccessGate,
  GithubCursor,
  GithubGap,
  GithubObjectObservation,
  GithubPageChanges,
  GithubPageProof,
  GithubPollEvent,
  GithubPollStore,
  GithubPullCandidate,
  GithubPullObservation,
  GithubStreamKey,
} from '../src/external/github/poll.mjs'
import type { GithubScope } from '../src/external/github/poll-state.mjs'
import {
  type GithubRepository,
  githubApiForLoopbackTest,
} from '../src/external/github/read-api.mjs'

export const start = Date.parse('2026-02-10T00:00:00Z')
export const repo: GithubRepository = { owner: 'org', name: 'sample', repoId: '9007199254740993' }
export const base = '/repos/org/sample'
export const apiHost = 'https://api.github.com'
export const sourceId = 'mock-source'
export const actor = { id: 42, login: 'source-user' }
export const bot = { id: 99, login: 'litch-bot' }
export const head = 'a'.repeat(40)
export const iso = (at: number) => new Date(at).toISOString().replace('.000Z', 'Z')
export const repoJson = `{"id":${repo.repoId},"full_name":"org/sample","has_issues":true}`

export const issue = (id: number, number: number, at: number, extra = {}) => ({
  id,
  number,
  created_at: iso(at),
  updated_at: iso(at),
  body: '',
  user: actor,
  state: 'open',
  ...extra,
})
export const pullIssue = (at: number) =>
  issue(101, 2, at, { pull_request: { url: `${apiHost}${base}/pulls/2` } })
export const pull = (at: number, extra = {}) =>
  issue(102, 2, at, {
    base: { repo: { id: repo.repoId } },
    head: { sha: head, repo: { id: repo.repoId } },
    ...extra,
  })

interface Reply {
  status?: number
  body?: unknown
  raw?: string
  headers?: Record<string, string>
}
export async function githubFixture(
  t: TestContext,
  route: (url: URL, request: IncomingMessage, now: number) => Reply | undefined,
  initial = start + 60_000,
) {
  let now = initial
  const requests: {
    method: string | undefined
    path: string
    query: string
    etag: string | undefined
    modifiedSince: string | undefined
    version: string | undefined
  }[] = []
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', apiHost)
    requests.push({
      method: req.method,
      path: url.pathname,
      query: url.search,
      etag: req.headers['if-none-match'],
      modifiedSince: req.headers['if-modified-since'],
      version: req.headers['x-github-api-version'] as string | undefined,
    })
    const reply =
      route(url, req, now) ??
      (url.pathname === '/user'
        ? { body: bot }
        : url.pathname === base
          ? { raw: repoJson }
          : url.pathname === `${base}/actions/runs`
            ? { body: { workflow_runs: [] } }
            : { body: [] })
    res.writeHead(reply.status ?? 200, {
      date: new Date(now).toUTCString(),
      'content-type': 'application/json',
      ...reply.headers,
    })
    res.end(reply.raw ?? JSON.stringify(reply.body ?? null))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('未监听回环地址')
  const origin = `http://127.0.0.1:${address.port}`
  const client = (generation = 'fixture-1') =>
    githubApiForLoopbackTest(origin, {
      token: 'mock-token',
      generation,
      now: () => now,
      jitter: () => 0,
    })
  return {
    api: client(),
    client,
    requests,
    advance: (ms: number) => {
      now += ms
    },
    now: () => now,
  }
}

const scopeKey = (scope: { sourceId: string; repoId?: string }) =>
  `${scope.sourceId}/${scope.repoId ?? ''}`
const streamKey = (key: GithubStreamKey) => `${scopeKey(key)}/${key.stream}`

export class MemoryGithubStore implements GithubPollStore {
  readonly cursors = new Map<string, GithubCursor>()
  readonly events = new Map<string, GithubPollEvent>()
  readonly gates = new Map<string, GithubAccessGate>()
  readonly pages = new Map<string, GithubPageProof>()
  readonly observations = new Map<string, GithubObjectObservation>()
  readonly candidates = new Map<number, GithubPullCandidate>()
  readonly pulls = new Map<number, GithubPullObservation>()
  readonly runs: NonNullable<GithubPageChanges['runs']>[number][] = []
  readonly gaps: Array<GithubGap & { stream: string }> = []

  async getGate(key: { sourceId: string; repoId?: string }) {
    return structuredClone(this.gates.get(scopeKey(key)))
  }

  async setGate(key: { sourceId: string; repoId?: string }, gate: GithubAccessGate | null) {
    if (gate) this.gates.set(scopeKey(key), structuredClone(gate))
    else this.gates.delete(scopeKey(key))
  }

  async getCursor(key: GithubStreamKey) {
    return structuredClone(this.cursors.get(streamKey(key)))
  }

  async getPage(key: GithubStreamKey, path: string) {
    return structuredClone(this.pages.get(`${streamKey(key)} ${path}`))
  }

  async getObservation(scope: GithubScope, objectKey: string) {
    return structuredClone(this.observations.get(`${scopeKey(scope)}/${objectKey}`))
  }

  async listReviewCandidates(scope: GithubScope, recentSince: number, limit: number) {
    const list = []
    for (const row of this.candidates.values()) {
      if (
        !row.bound &&
        row.state !== 'open' &&
        row.discoveredAt < recentSince &&
        (row.updatedAt ?? 0) < recentSince &&
        (row.closedAt ?? 0) < recentSince
      )
        continue
      const cursor = await this.getCursor({ ...scope, stream: `reviews:${row.number}` })
      if (!cursor?.fault?.paused) list.push({ number: row.number, at: cursor?.checkedAt ?? 0 })
    }
    return list
      .sort((a, b) => a.at - b.at || a.number - b.number)
      .slice(0, limit)
      .map((row) => row.number)
  }

  async commit(key: GithubStreamKey, cursor: GithubCursor, changes: GithubPageChanges) {
    this.cursors.set(streamKey(key), structuredClone(cursor))
    for (const row of changes.events ?? [])
      if (!this.events.has(row.externalEventKey))
        this.events.set(row.externalEventKey, structuredClone(row))
    for (const row of changes.observations ?? [])
      this.observations.set(`${scopeKey(key)}/${row.objectKey}`, structuredClone(row))
    for (const row of changes.candidates ?? []) {
      const previous = this.candidates.get(row.number)
      if (row.updatedAt !== undefined && (previous?.updatedAt ?? 0) > row.updatedAt) continue
      this.candidates.set(row.number, { ...previous, ...row })
    }
    for (const row of changes.pulls ?? []) this.pulls.set(row.number, structuredClone(row))
    for (const row of changes.gaps ?? []) this.gaps.push({ ...row, stream: key.stream })
    for (const row of changes.runs ?? []) this.runs.push(structuredClone(row))
    if (changes.proof)
      this.pages.set(`${streamKey(key)} ${changes.proof.path}`, structuredClone(changes.proof))
  }
}
