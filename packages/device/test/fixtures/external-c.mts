import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { TestContext } from 'node:test'
import {
  type ExternalEvent,
  type ExternalIssueId,
  type ExternalSourceDraft,
  externalSubjectKey,
} from '../../../protocol/src/external-sources.mjs'
import {
  MANAGER_DEFAULT_CONTACT,
  MANAGER_DEFAULT_DISPATCH,
  type Manager,
} from '../../../protocol/src/manager.mjs'
import { managerIssueFixture } from '../../../protocol/src/manager-issues.mjs'
import { ExternalDispatch, type ExternalDispatchHost } from '../../src/external/dispatch.mjs'
import {
  ExternalFeedback,
  type ExternalFeedbackHost,
  type ExternalFeedbackIntent,
} from '../../src/external/feedback.mjs'
import { SqliteGithubPollStore } from '../../src/external/github/poll-store.mjs'
import { ExternalIntakeService } from '../../src/external/intake.mjs'
import { ExternalManagerTools } from '../../src/external/manager-tools.mjs'
import {
  type ExternalManagerTurn,
  type ExternalMandateHost,
  ExternalMandateService,
} from '../../src/external/mandate.mjs'
import { type ExternalLinkHost, ExternalLinkService } from '../../src/external/mandate-link.mjs'
import type { ExternalConfigurationSnapshot } from '../../src/external/routing.mjs'
import { ExternalStore } from '../../src/external-store.mjs'
import { ManagerBoardWriter } from '../../src/manager-board.mjs'
import { ManagerStore, openManagerDatabase } from '../../src/manager-store.mjs'

export function externalFixture(t: TestContext) {
  const path = mkdtempSync(join(tmpdir(), 'litch-c-'))
  const manager = new ManagerStore(openManagerDatabase(path))
  t.after(() => {
    manager.close()
    rmSync(path, { recursive: true, force: true })
  })
  const store = new ExternalStore(manager)
  const poll = new SqliteGithubPollStore(store)
  const clock = { at: 1_700_000_100 }
  const context: ExternalManagerTurn = {
    managerId: 'm1',
    threadId: 'm1-thread',
    harness: 'codex',
    turnId: 'active-turn',
  }
  const makeManager = (id = 'm1'): Manager => ({
    id,
    threadId: `${id}-thread`,
    name: id,
    cwd: path,
    harness: 'codex',
    scope: '',
    model: null,
    effort: null,
    template: 'blank',
    dispatch: { ...MANAGER_DEFAULT_DISPATCH },
    contact: { ...MANAGER_DEFAULT_CONTACT },
    rules: '',
    status: 'active',
    pendingDecisions: 0,
    runningLines: 0,
    latestActivity: null,
    createdAt: 1,
    updatedAt: 1,
    endedAt: null,
  })
  manager.saveManager(makeManager())
  manager.saveManager(makeManager('m2'))
  const repo = {
    repoId: '9007199254740993',
    owner: 'test',
    name: 'repo',
    url: 'https://github.com/test/repo',
    localRoot: path,
    allowedBase: ['main'],
    headNamespace: 'agent/',
  }
  const draft: ExternalSourceDraft = {
    sourceId: 'source-A',
    credentialRef: 'cred',
    enabled: true,
    provider: 'github',
    botUserId: '200',
    triggers: { mention: true, assignment: true, reviewRequest: true, label: true, labelIds: [] },
    repos: [repo],
    routes: [],
    minRole: 'triage',
    interval: 60,
    writePolicy: { comment: true, draftPr: false, status: false, managedPush: false },
  }
  const source = (patch: Partial<ExternalSourceDraft> = {}) => {
    const revision = store.config.source(draft.sourceId)?.revision ?? 0
    const result = store.config.saveSource(
      { ...draft, ...patch },
      revision,
      `source-${revision}`,
      'operator',
    )
    assert.equal(result.outcome, 'applied')
    return result.record
  }
  source()
  let config: ExternalConfigurationSnapshot = {
    revision: 1,
    identities: [
      { identityId: 'bot-1', botUserId: '200', login: 'litch-bot' },
      { identityId: 'bot-2', botUserId: '201', login: 'litch-bot-two' },
      { identityId: 'bot-idle', botUserId: '202', login: 'litch-unused' },
    ],
    repositories: [{ repoId: repo.repoId, pollIdentity: 'bot-1' }],
    assignments: [{ managerId: 'm1', identityId: 'bot-1', repoIds: [repo.repoId] }],
  }
  const configuration = () => config
  const changeConfiguration = (patch: Partial<Omit<ExternalConfigurationSnapshot, 'revision'>>) => {
    config = { ...config, ...patch, revision: config.revision + 1 }
  }
  const addresses = new Map<string, readonly string[]>()
  store.config.saveCredential(
    {
      credentialRef: 'cred',
      provider: 'github',
      botUserId: '200',
      resourceOwnerId: '1',
      state: 'active',
      generation: 1,
      createdAt: 1,
      lastVerifiedAt: 1,
    },
    0,
    'creds',
  )
  store.config.setOwner(
    {
      provider: 'github',
      userId: '100',
      method: 'userId',
      loginCache: 'owner',
      profileUrl: 'https://github.com/owner',
    },
    'operator',
    0,
    'owner',
  )
  const sent: Array<{ text: string; eventId: string; deliveryId: string }> = []
  const feedbackWrites: ExternalFeedbackIntent[] = []
  const feedbackHost: ExternalFeedbackHost = {
    configuration,
    async enqueue(intent) {
      feedbackWrites.push(intent)
      return 'queued'
    },
  }
  const feedback = new ExternalFeedback(store, feedbackHost)
  const dispatchHost: ExternalDispatchHost = {
    configuration,
    feedback,
    now: () => clock.at,
    canDeliver: () => true,
    async send(request) {
      const prepared = request.prepare()
      const sentMessage = prepared && request.beforeSend(prepared)
      if (!sentMessage) return { outcome: 'not_sent' }
      sent.push(sentMessage)
      return { outcome: 'confirmed', turnId: 'external-turn' }
    },
  }
  const dispatch = new ExternalDispatch(store, dispatchHost)
  const mandateHost: ExternalMandateHost = {
    configuration,
    now: () => clock.at,
    isCurrentTurn: (turn) => turn.turnId === 'active-turn',
    lookupGithubRole: async (_source, _repo, actor) => ({
      state: 'verified',
      eligible: actor.userId === '300',
      roleName: actor.userId === '300' ? 'triage' : 'read',
    }),
    recheckEvent: async ({ event }) => ({
      event,
      agentMarked: false,
      addressedBotIds:
        addresses.get(event.externalEventKey) ??
        (event.targetEvidence.mentionedBotId ? [event.targetEvidence.mentionedBotId] : []),
    }),
  }
  const mandates = new ExternalMandateService(store, mandateHost)
  const intake = new ExternalIntakeService(
    store,
    (...args) => mandateHost.lookupGithubRole(...args),
    dispatch.queue,
    (...args) => mandateHost.recheckEvent(...args),
    configuration,
    { service: feedback, waitReason: dispatch.feedbackReason },
  )
  const board = new ManagerBoardWriter(manager, () => false)
  const linkHost: ExternalLinkHost = {
    configuration,
    now: () => clock.at,
    async inspectSubject({ number, kind }) {
      return {
        subject: {
          provider: 'github',
          repoId: repo.repoId,
          number,
          kind,
          url: `${repo.url}/${kind === 'pull_request' ? 'pull' : 'issues'}/${number}`,
        },
        actorUserId: '200',
        head: { repoId: repo.repoId, ref: 'agent/a' },
        agentMarked: true,
      }
    },
  }
  const links = new ExternalLinkService(store, mandates, linkHost)
  const tools = new ExternalManagerTools(store, mandates, board, links)
  const scope = { sourceId: draft.sourceId, repoId: repo.repoId }
  let eventNum = 2000
  function event(
    kind: ExternalEvent['kind'],
    opt: {
      number?: number
      actor?: string | null
      pr?: boolean
      target?: Partial<ExternalEvent['targetEvidence']>
      at?: number
      contentVersion?: string | null
      suffix?: string
    } = {},
  ): ExternalEvent {
    const number = String(opt.number ?? 1)
    const pr = opt.pr ?? kind === 'pull_request'
    const subject = {
      provider: 'github',
      kind: pr ? 'pull_request' : 'issue',
      repoId: repo.repoId,
      number,
      url: `${repo.url}/${pr ? 'pull' : 'issues'}/${number}`,
    } as const
    const sourceEventId = String(++eventNum)
    const actor = opt.actor === undefined ? '300' : opt.actor
    return {
      provider: 'github',
      externalEventKey: `github/${repo.repoId}/event/${sourceEventId}`,
      subjectKey: externalSubjectKey(subject),
      kind,
      occurredAt: opt.at ?? clock.at,
      actorEvidence: actor
        ? { userId: actor, login: actor === '300' ? 'author' : 'untrusted-name' }
        : null,
      targetEvidence: { subject, sourceEventId, ...opt.target },
      permalink: subject.url + (opt.suffix ?? ''),
      contentVersion: opt.contentVersion ?? null,
    }
  }
  function issue(managerId = 'm1', patch = {}) {
    const id = manager.nextIssueId(managerId)
    manager.saveIssue(managerId, id, { ...managerIssueFixture.newOrdinary, id, ...patch })
    return id
  }
  function bind(event: ExternalEvent, issueId: ExternalIssueId, managerId = 'm1') {
    return store.bindRef({
      ...event.targetEvidence.subject,
      issueId,
      managerId,
      origin: 'manual',
      createdAt: clock.at,
    })
  }
  async function collect(...events: ExternalEvent[]) {
    poll.evidence.stage(scope, events, clock.at)
    await intake.consumeGithub(poll.evidence, scope, clock.at, {
      snapshotLabels: async (_source, _repo, event) => event,
      inspectSubject: linkHost.inspectSubject,
    })
    return events.map((event) => store.inboxEvent(event.externalEventKey))
  }
  return {
    feedback,
    feedbackHost,
    feedbackWrites,
    addresses,
    configuration,
    changeConfiguration,
    clock,
    source,
    makeManager,
    manager,
    store,
    poll,
    scope,
    repo,
    draft,
    context,
    event,
    intake,
    dispatch,
    dispatchHost,
    mandateHost,
    mandates,
    linkHost,
    links,
    tools,
    board,
    collect,
    issue,
    bind,
    sent,
  }
}
