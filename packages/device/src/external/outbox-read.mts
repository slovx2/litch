import {
  type ExternalIssueId,
  type ExternalSubject,
  externalSubjectKey,
} from '../../../protocol/src/external-sources.mjs'
import type { ExternalStore } from '../external-store.mjs'
import {
  digest,
  GithubWriteFault,
  githubRepoPath,
  numericId,
  object,
  redactGithubSecrets,
} from './github/write-api.mjs'
import { withIsolatedGithubGh } from './github/write-gh-read.mjs'
import type { ExternalGithubSecrets } from './secrets.mjs'

// H 从实际工具连接和工作线分派构造，禁止从工具参数拷贝 actor。
export type ExternalToolActor =
  | { kind: 'manager'; managerId: string; threadId: string }
  | { kind: 'workline'; managerId: string; threadId: string; issueId: ExternalIssueId }
export type ExternalReadSelection =
  | { eventKey: string }
  | { issueId: ExternalIssueId; repoId: string; number: string }

export function activeManager(
  store: ExternalStore,
  actor: Pick<ExternalToolActor, 'kind' | 'managerId' | 'threadId'>,
): boolean {
  const manager = store.manager.manager(actor.managerId)
  return (
    manager?.status === 'active' &&
    (actor.kind === 'workline' || manager.threadId === actor.threadId)
  )
}

export class ExternalGithubRead {
  private readonly options: {
    store: ExternalStore
    secrets: ExternalGithubSecrets
    ghPath: string
    isWorklineCurrent: (actor: Extract<ExternalToolActor, { kind: 'workline' }>) => boolean
  }
  constructor(options: ExternalGithubRead['options']) {
    this.options = options
  }

  async read(actor: ExternalToolActor, selection: ExternalReadSelection) {
    const { store, secrets, ghPath, isWorklineCurrent } = this.options
    const resolve = () => {
      if (!activeManager(store, actor) || (actor.kind === 'workline' && !isWorklineCurrent(actor)))
        throw new GithubWriteFault('external_read_forbidden')
      let subject: ExternalSubject
      let sourceId: string | undefined
      let detail: { kind: 'comment' | 'review' | 'review_comment'; id: string } | undefined
      if ('eventKey' in selection) {
        const event = store.inboxEvent(selection.eventKey)
        if (
          !event ||
          event.managerId !== actor.managerId ||
          event.reason === 'ignored' ||
          !['pending_triage', 'processed', 'notified'].includes(event.status)
        )
          throw new GithubWriteFault('external_event_not_approved')
        subject = event.subject
        sourceId = event.sourceId
        if (
          event.kind === 'comment' ||
          event.kind === 'review' ||
          event.kind === 'review_comment'
        ) {
          if (!numericId(event.sourceEventId))
            throw new GithubWriteFault('external_event_not_approved')
          detail = { kind: event.kind, id: event.sourceEventId }
        }
        if (actor.kind === 'workline') {
          const ref = store.ref(subject)
          if (ref?.managerId !== actor.managerId || ref.issueId !== actor.issueId)
            throw new GithubWriteFault('external_read_forbidden')
        }
      } else {
        const ref = store.ref({
          provider: 'github',
          repoId: selection.repoId,
          number: selection.number,
        })
        if (
          !ref ||
          ref.managerId !== actor.managerId ||
          ref.issueId !== selection.issueId ||
          (actor.kind === 'workline' && actor.issueId !== ref.issueId)
        )
          throw new GithubWriteFault('external_read_forbidden')
        subject = ref
      }
      const source = sourceId
        ? store.config.source(sourceId)
        : store.config
            .sources()
            .find((s) => s.enabled && s.repos.some((repo) => repo.repoId === subject.repoId))
      const repo = source?.repos.find((entry) => entry.repoId === subject.repoId)
      if (!source?.enabled || !repo || !numericId(subject.number))
        throw new GithubWriteFault('external_source_not_available')
      return { source, repo, subject, detail }
    }
    const { source, repo, subject, detail } = resolve()
    const credential = secrets.active(source.credentialRef, repo.repoId)
    if (credential.metadata.botUserId !== source.botUserId)
      throw new GithubWriteFault('github_bot_identity_changed')
    const beforeRead = (): void => {
      const fresh = resolve()
      if (
        fresh.source.revision !== source.revision ||
        fresh.source.sourceId !== source.sourceId ||
        externalSubjectKey(fresh.subject) !== externalSubjectKey(subject) ||
        fresh.subject.kind !== subject.kind ||
        fresh.detail?.id !== detail?.id ||
        fresh.detail?.kind !== detail?.kind ||
        !secrets.isCurrent(credential.metadata)
      )
        throw new GithubWriteFault('external_read_scope_changed')
    }
    const path = githubRepoPath(repo)
    const verifiedOwner = credential.repos.find(
      (allowed) => allowed.repoId === repo.repoId,
    )?.resourceOwnerId
    return withIsolatedGithubGh({ ghPath, token: credential.token, beforeRead }, async (get) => {
      const actual = await get(path)
      if (
        numericId(actual.id) !== repo.repoId ||
        !verifiedOwner ||
        numericId(object(actual.owner).id) !== verifiedOwner ||
        typeof actual.full_name !== 'string' ||
        actual.full_name.toLowerCase() !== `${repo.owner}/${repo.name}`.toLowerCase()
      )
        throw new GithubWriteFault('github_repository_unverified')
      const parentPath = `${path}/${subject.kind === 'issue' ? 'issues' : 'pulls'}/${subject.number}`
      const parent = await get(parentPath)
      if (
        numericId(parent.number) !== subject.number ||
        (subject.kind === 'issue' && parent.pull_request) ||
        (subject.kind === 'pull_request' &&
          numericId(object(object(parent.base).repo).id) !== repo.repoId)
      )
        throw new GithubWriteFault('github_thread_unverified')
      let item = parent
      let anchor = ''
      if (detail) {
        if (detail.kind !== 'comment' && subject.kind !== 'pull_request')
          throw new GithubWriteFault('github_thread_unverified')
        item = await get(
          detail.kind === 'comment'
            ? `${path}/issues/comments/${detail.id}`
            : detail.kind === 'review'
              ? `${parentPath}/reviews/${detail.id}`
              : `${path}/pulls/comments/${detail.id}`,
        )
        const family = detail.kind === 'comment' ? 'issues' : 'pulls'
        const link = detail.kind === 'comment' ? item.issue_url : item.pull_request_url
        if (
          numericId(item.id) !== detail.id ||
          !matchesGithubThread(link, path, repo.repoId, family, subject.number) ||
          (detail.kind === 'review' &&
            (item.state === 'PENDING' || typeof item.submitted_at !== 'string'))
        )
          throw new GithubWriteFault('github_thread_unverified')
        anchor =
          detail.kind === 'comment'
            ? `#issuecomment-${detail.id}`
            : detail.kind === 'review'
              ? `#pullrequestreview-${detail.id}`
              : `#discussion_r${detail.id}`
      }
      const userId = numericId(object(item.user).id)
      const id = numericId(item.id)
      const timestamp = item.updated_at ?? item.submitted_at
      const body = item.body === null ? '' : item.body
      if (
        !userId ||
        !id ||
        typeof body !== 'string' ||
        typeof timestamp !== 'string' ||
        !Number.isFinite(Date.parse(timestamp))
      )
        throw new GithubWriteFault('github_read_evidence_invalid')
      beforeRead()
      const fullText = redactGithubSecrets(body)
      const buffer = Buffer.from(fullText)
      let end = Math.min(buffer.length, 64 * 1024)
      while (((buffer[end] ?? 0) & 0xc0) === 0x80) end--
      const owner = store.config.owner('github')
      return {
        evidence: {
          objectId: id,
          authorUserId: userId,
          owner: owner?.userId === userId,
          kind: detail?.kind ?? subject.kind,
          repoId: subject.repoId,
          number: subject.number,
          url: `https://github.com/${repo.owner}/${repo.name}/${subject.kind === 'issue' ? 'issues' : 'pull'}/${subject.number}${anchor}`,
          revision: `${new Date(timestamp).toISOString()}/${digest(body)}`,
        },
        externalText: {
          body: buffer.subarray(0, end).toString('utf8'),
          truncated: end !== buffer.length,
        },
      }
    })
  }
}

export function matchesGithubThread(
  url: unknown,
  repoPath: string,
  repoId: string,
  family: 'issues' | 'pulls',
  number: string,
): boolean {
  if (typeof url !== 'string') return false
  const suffix = `/${family}/${number}`
  return [repoPath, `/repositories/${repoId}`].some(
    (prefix) => url.toLowerCase() === `https://api.github.com${prefix}${suffix}`.toLowerCase(),
  )
}
