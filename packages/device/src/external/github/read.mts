import { execFile } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { type GithubActorEvidence, githubActor } from './identity.mjs'
import {
  GITHUB_API_VERSION,
  GithubFault,
  type GithubRepository,
  githubId,
  githubNumber,
  githubObject,
  githubPermalink,
  githubRepoPath,
  githubSubjectNumber,
  type JsonObject,
  parseGithubJson,
} from './read-api.mjs'
import {
  type GithubContentKind,
  githubBody,
  githubContentAnchor,
  githubContentHash,
  githubContentTimes,
  githubContentVersion,
} from './read-content.mjs'

export type GithubReadTarget =
  | { kind: 'issue' | 'pull'; number: number; objectId?: string }
  | { kind: 'issue-comment'; number: number; parentKind: 'issue' | 'pull'; objectId: string }
  | { kind: 'review' | 'review-comment'; number: number; objectId: string }

export interface GithubBodyRead {
  kind: GithubContentKind
  number: number
  objectId: string
  actorEvidence: GithubActorEvidence
  contentVersion: string
  permalink: string
  body: string
  truncated: boolean
}

export interface GithubGhReadOptions {
  // 由设备解析的可信绝对路径及经设备授权的凭据，不能来自工具参数。
  ghPath: string
  token: string
  signal?: AbortSignal
}

async function ghGet(
  options: GithubGhReadOptions,
  directory: string,
  endpoint: string,
): Promise<JsonObject> {
  const env: NodeJS.ProcessEnv = {
    GH_TOKEN: options.token,
    GH_HOST: 'github.com',
    GH_CONFIG_DIR: directory,
    GH_PROMPT_DISABLED: '1',
    GH_NO_UPDATE_NOTIFIER: '1',
    GH_NO_EXTENSION_UPDATE_NOTIFIER: '1',
    GH_PAGER: 'cat',
    HOME: directory,
    USERPROFILE: directory,
    XDG_CONFIG_HOME: directory,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_TERMINAL_PROMPT: '0',
    NO_COLOR: '1',
    ...(process.platform === 'win32' && process.env.SystemRoot
      ? { SystemRoot: process.env.SystemRoot }
      : {}),
  }
  const stdout = await new Promise<string>((resolve, reject) => {
    execFile(
      options.ghPath,
      [
        'api',
        '--hostname',
        'github.com',
        '--method',
        'GET',
        '--header',
        'Accept: application/vnd.github+json',
        '--header',
        `X-GitHub-Api-Version: ${GITHUB_API_VERSION}`,
        '--',
        endpoint,
      ],
      {
        env,
        cwd: directory,
        encoding: 'utf8',
        timeout: 20_000,
        maxBuffer: 2 * 1024 * 1024,
        windowsHide: true,
        killSignal: 'SIGKILL',
        ...(options.signal ? { signal: options.signal } : {}),
      },
      (error, body) => {
        // 子进程的异常和 stderr 都可能含命令或正文，不向上透传。
        if (error) reject(new GithubFault('transient'))
        else resolve(body)
      },
    )
  })
  return githubObject(parseGithubJson(stdout))
}

function boundedText(content: string): { body: string; truncated: boolean } {
  const buffer = Buffer.from(content)
  const maxBytes = 64 * 1024
  if (buffer.length <= maxBytes) return { body: content, truncated: false }
  let end = maxBytes
  while (((buffer[end] ?? 0) & 0xc0) === 0x80) end--
  return { body: buffer.subarray(0, end).toString('utf8'), truncated: true }
}

export async function readGithubBody(
  options: GithubGhReadOptions,
  repo: GithubRepository,
  target: GithubReadTarget,
): Promise<GithubBodyRead> {
  if (
    !isAbsolute(options.ghPath) ||
    !options.token.trim() ||
    /[\s\u0000-\u001f]/.test(options.token) ||
    !githubNumber(target.number) ||
    (target.objectId !== undefined && !githubId(target.objectId))
  ) {
    throw new TypeError('Invalid GitHub read configuration')
  }
  const repository = githubRepoPath(repo)
  const directory = await mkdtemp(join(tmpdir(), 'litch-gh-read-'))
  try {
    const get = (path: string) => ghGet(options, directory, path)
    const verified = await get(repository)
    if (
      githubId(verified.id) !== repo.repoId ||
      typeof verified.full_name !== 'string' ||
      verified.full_name.toLowerCase() !== `${repo.owner}/${repo.name}`.toLowerCase()
    ) {
      throw new GithubFault('repository-changed')
    }
    const { kind, number, objectId } = target
    let raw: JsonObject
    let parent: 'issues' | 'pull'
    if (kind === 'issue-comment') {
      parent = target.parentKind === 'pull' ? 'pull' : 'issues'
      raw = await get(`${repository}/issues/comments/${objectId}`)
      if (githubSubjectNumber(raw.issue_url, repo, 'issues') !== number)
        throw new GithubFault('invalid-response')
      // issue comments 在 issue 和 PR 共用；链接类型由实际父对象决定。
      const issue = await get(`${repository}/issues/${number}`)
      if (
        githubNumber(issue.number) !== number ||
        Boolean(issue.pull_request) !== (parent === 'pull')
      ) {
        throw new GithubFault('invalid-response')
      }
    } else if (kind === 'review-comment') {
      parent = 'pull'
      raw = await get(`${repository}/pulls/comments/${objectId}`)
      if (githubSubjectNumber(raw.pull_request_url, repo, 'pulls') !== number)
        throw new GithubFault('invalid-response')
    } else if (kind === 'review') {
      parent = 'pull'
      raw = await get(`${repository}/pulls/${number}/reviews/${objectId}`)
      if (
        raw.state === 'PENDING' ||
        githubSubjectNumber(raw.pull_request_url, repo, 'pulls') !== number
      ) {
        throw new GithubFault('invalid-response')
      }
    } else {
      parent = kind === 'pull' ? 'pull' : 'issues'
      raw = await get(`${repository}/${kind === 'pull' ? 'pulls' : 'issues'}/${number}`)
      if (githubNumber(raw.number) !== number || (kind === 'issue' && raw.pull_request)) {
        throw new GithubFault('invalid-response')
      }
      if (
        kind === 'pull' &&
        githubId(githubObject(githubObject(raw.base).repo).id) !== repo.repoId
      ) {
        throw new GithubFault('invalid-response')
      }
    }
    const observedId = githubId(raw.id)
    const actorEvidence = githubActor(raw.user)
    if (!observedId || (objectId && observedId !== objectId) || !actorEvidence)
      throw new GithubFault('invalid-response')
    const content = githubBody(raw)
    const { updated } = githubContentTimes(raw, kind)
    return {
      kind,
      number,
      objectId: observedId,
      actorEvidence,
      contentVersion: githubContentVersion(updated, githubContentHash(content)),
      permalink: githubPermalink(
        repo,
        `${parent}/${number}${githubContentAnchor(kind, observedId)}`,
      ),
      ...boundedText(content),
    }
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}
