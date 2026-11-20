import assert from 'node:assert/strict'
import { closeSync, mkdtempSync, openSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import test, { type TestContext } from 'node:test'
import { type ExternalSubject, externalSubjectKey } from '../../protocol/src/external-sources.mjs'
import {
  MANAGER_DEFAULT_CONTACT,
  MANAGER_DEFAULT_DISPATCH,
  type Manager,
} from '../../protocol/src/manager.mjs'
import { managerIssueFixture } from '../../protocol/src/manager-issues.mjs'
import {
  ExternalStore,
  type ExternalTriageCommit,
  type NewExternalOutboxRecord,
} from '../src/external-store.mjs'
import { MANAGER_SCHEMA_VERSION, ManagerStore, openManagerDatabase } from '../src/manager-store.mjs'
import { MANAGER_V9_SQL } from './fixtures/manager-v9.mjs'

function folder(t: TestContext): string {
  const dir = mkdtempSync(join(tmpdir(), 'external-store-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}
function ledger(t: TestContext): ManagerStore {
  const dir = mkdtempSync(join(tmpdir(), 'external-store-'))
  const manager = new ManagerStore(openManagerDatabase(dir))
  t.after(() => {
    manager.close()
    rmSync(dir, { recursive: true, force: true })
  })
  return manager
}
function sampleManager(id: string): Manager {
  return {
    id,
    threadId: `${id}-thread`,
    name: id,
    scope: '测试',
    cwd: '/work',
    harness: 'codex',
    model: null,
    effort: null,
    template: 'blank',
    rules: '',
    status: 'active',
    createdAt: 1,
    updatedAt: 1,
    endedAt: null,
    pendingDecisions: 0,
    runningLines: 0,
    latestActivity: null,
    dispatch: { ...MANAGER_DEFAULT_DISPATCH },
    contact: { ...MANAGER_DEFAULT_CONTACT },
  }
}
const subject: ExternalSubject = {
  provider: 'github',
  repoId: '9007199254740993',
  number: '8',
  kind: 'issue',
  url: 'https://github.com/example/repo/issues/8',
}
const subjectKey = externalSubjectKey(subject)
const event = (eventKey: string, target = subject) => ({
  eventKey,
  sourceId: 's',
  subjectKey: externalSubjectKey(target),
  subject: target,
  kind: 'labeled' as const,
  sourceEventId: '891',
  actorId: '120',
  actorRoleAtCheck: 'triage' as const,
  occurredAt: 1,
  observedAt: 2,
  status: 'received' as const,
  eventUrl: target.url,
  contentVersion: null,
})
const intake = (
  store: ExternalStore,
  id: string,
  managerId: string,
  key: string,
  target = subject,
) => {
  store.insertInboxEvent(event(key, target))
  return store.collectIntake({
    intakeId: id,
    subject: target,
    subjectKey: externalSubjectKey(target),
    managerId,
    sourceId: 's',
    eventKeys: [key],
    autoNotifyUntil: 86_400,
  })
}
const evidence = (key: string, target = subject) => ({
  requesterUserId: '120',
  eventKeys: [key],
  observedRole: 'triage' as const,
  ruleId: 'label',
  rulesVersion: 2,
  policyRevision: 2,
  routeId: 'route',
  authorizedScope: {
    subjectKey: externalSubjectKey(target),
    repoId: target.repoId,
    actions: ['comment'] as ['comment'],
  },
})
const accept = (intakeId: string, managerId: string, key: string, target = subject) =>
  ({
    intakeId,
    managerId,
    expectedRevision: 1,
    idempotencyKey: 'idem',
    actorId: managerId,
    at: 3,
    action: 'accept',
    title: '本地工作标题',
    body: '内部工作范围',
    evidence: evidence(key, target),
  }) satisfies ExternalTriageCommit
const reply = (operationId: string): NewExternalOutboxRecord => ({
  operationId,
  idempotencyKey: operationId,
  targetRef: subject,
  action: 'comment',
  policyRevision: 2,
  sourceId: 's',
  actorThreadId: 'm-thread',
  managerId: 'm',
  payloadHash: 'hash',
  payloadRef: 'private/fixture',
})

function oldDatabase(dir: string): { store: ManagerStore; path: string } {
  const path = join(dir, 'manager.sqlite')
  closeSync(openSync(path, 'wx', 0o600))
  const store = new ManagerStore(new DatabaseSync(path))
  store.db.exec(MANAGER_V9_SQL)
  store.db.exec('PRAGMA journal_mode=WAL')
  store.saveManager(sampleManager('old'))
  assert.equal(store.nextIssueId('old'), 'X-1')
  store.saveIssue('old', 'X-1', managerIssueFixture.newOrdinary)
  store.saveIssueComment('old', 'X-1', 'comment', { body: '旧评论' })
  store.saveObject('old', {
    id: 'I-1',
    title: '旧派线',
    status: 'running',
    owner: { kind: 'line', threadId: 'line' },
    revision: 1,
    checked: null,
    createdAt: 1,
    updatedAt: 1,
    blockedBy: [],
    why: '',
    links: [],
    basis: [],
    unverified: [],
  })
  store.enqueue('old', '尚未投递')
  return { store, path }
}

test('v9 WAL 快照升级，保留编号、评论、派线与队列，外部功能初始为空', (t) => {
  const dir = folder(t)
  const previous = oldDatabase(dir)
  try {
    const store = new ManagerStore(openManagerDatabase(dir))
    try {
      assert.equal(
        store.db.prepare('PRAGMA user_version').get()?.user_version,
        MANAGER_SCHEMA_VERSION,
      )
      assert.deepEqual(new ExternalStore(store).config.sources(), [])
      assert.equal(store.nextIssueId('old'), 'X-2')
      assert.deepEqual(store.issueComments('old', 'X-1'), [{ body: '旧评论' }])
      const item = store.object('old', 'I-1')
      assert.ok(item && 'owner' in item)
      assert.deepEqual(item.owner, { kind: 'line', threadId: 'line' })
      assert.equal(store.deliveries('old')[0]?.text, '尚未投递')
      const backupPath = `${previous.path}.before-v10`
      const backup = new DatabaseSync(backupPath, { readOnly: true })
      try {
        assert.equal(backup.prepare('PRAGMA user_version').get()?.user_version, 9)
        assert.equal(backup.prepare('SELECT text FROM deliveries').get()?.text, '尚未投递')
        assert.equal(
          backup.prepare("SELECT value FROM counters WHERE kind='issue'").get()?.value,
          1,
        )
        if (process.platform !== 'win32') {
          for (const path of [
            previous.path,
            `${previous.path}-wal`,
            `${previous.path}-shm`,
            backupPath,
          ])
            assert.equal(statSync(path).mode & 0o777, 0o600)
        }
      } finally {
        backup.close()
      }
    } finally {
      store.close()
    }
  } finally {
    previous.store.close()
  }
})

test('迁移中后段碰撞会回滚先前建表和版本，仍能读取旧快照', (t) => {
  const dir = folder(t)
  const { path, store: old } = oldDatabase(dir)
  old.db.exec('CREATE TABLE external_mandates (collision INTEGER)')
  old.close()
  assert.throws(() => openManagerDatabase(dir), /external_mandates already exists/)
  const oldAgain = new DatabaseSync(path)
  try {
    assert.equal(oldAgain.prepare('PRAGMA user_version').get()?.user_version, 9)
    assert.deepEqual(
      oldAgain
        .prepare("SELECT name FROM sqlite_schema WHERE name LIKE 'external_%'")
        .all()
        .map((row) => row.name),
      ['external_mandates'],
    )
    assert.equal(oldAgain.prepare('SELECT count(*) n FROM issue_comments').get()?.n, 1)
    assert.equal(oldAgain.prepare('SELECT count(*) n FROM deliveries').get()?.n, 1)
  } finally {
    oldAgain.close()
  }
})

test('接单提交后回执可重放；写入最后阶段失败也不占号、不留半张 X-n', (t) => {
  const manager = ledger(t)
  manager.saveManager(sampleManager('m'))
  manager.saveManager(sampleManager('other'))
  const store = new ExternalStore(manager)
  const one = intake(store, 'candidate', 'm', 'one')
  const input = accept(one.intakeId, 'm', 'one')
  manager.db.exec(`CREATE TRIGGER reject_outbox BEFORE INSERT ON external_outbox BEGIN
    SELECT RAISE(ABORT, '模拟回写队列故障'); END`)
  assert.throws(() => store.commitTriage(input, { reply: reply('reply') }), /模拟回写队列故障/)
  assert.deepEqual(manager.issues('m'), [])
  assert.deepEqual(manager.issueChanges('m'), [])
  assert.equal(store.ref(subject), null)
  assert.equal(store.inboxEvent('one')?.status, 'pending_triage')
  assert.deepEqual(store.intake(one.intakeId), one)
  assert.equal(store.queue.outboxRecord('reply'), null)
  manager.db.exec('DROP TRIGGER reject_outbox')
  const result = store.commitTriage(input, { reply: reply('reply') })
  assert.equal(result.outcome, 'applied')
  if (result.outcome !== 'applied') return
  assert.equal(result.intake.issueId, 'X-1')
  assert.equal(result.mandate?.decision, 'accept')
  assert.equal(store.queue.outboxRecord('reply')?.mandateId, result.mandate?.mandateId)
  assert.deepEqual(store.commitTriage({ ...input, at: 4 }, { reply: reply('reply') }), result)
  const repeatedKey = store.commitTriage({ ...input, title: '换标题' }, { reply: reply('reply') })
  assert.equal(repeatedKey.outcome === 'conflict' && repeatedKey.reason, 'idempotency')
  const other = intake(store, 'other-candidate', 'other', 'two')
  const conflict = store.commitTriage(accept(other.intakeId, 'other', 'two'))
  assert.equal(conflict.outcome === 'conflict' && conflict.reason, 'binding')
  assert.deepEqual(conflict.ref, result.ref)
  assert.deepEqual(manager.issues('other'), [])

  const second = { ...subject, number: '9', url: 'https://github.com/example/repo/issues/9' }
  intake(store, 'merge', 'm', 'three', second)
  const merge = {
    ...accept('merge', 'm', 'three', second),
    action: 'merge',
    issueId: 'X-1',
    expectedIssueRevision: 0,
  } satisfies ExternalTriageCommit
  const stale = store.commitTriage(merge)
  assert.equal(stale.outcome === 'conflict' && stale.reason, 'issue_revision')
  assert.equal(store.commitTriage({ ...merge, expectedIssueRevision: 1 }).outcome, 'applied')
  assert.equal(store.mandates('m', 'X-1').length, 2)
  assert.equal(store.refs('m', 'X-1').length, 2)
  assert.equal(manager.issues('m').length, 1)
})

test('观察、分页证明、事件和游标同笔提交；跨来源去重并按设备序号分页', (t) => {
  const manager = ledger(t)
  const store = new ExternalStore(manager)
  const cursor = {
    sourceId: 's',
    repoId: subject.repoId,
    stream: 'issue-events',
    coveredThrough: 2,
  }
  const checkpoint = { bucket: 'page', key: 'page-2', value: { etag: 'fixture', count: 1 } }
  const obs = {
    objectKey: 'action:891',
    objectId: '891',
    subjectKey,
    observedAt: 2,
    updatedAt: 1,
    seen: true,
  }
  const bad = { ...event('bad'), sourceEventId: 'not-an-id' }
  assert.throws(() =>
    store.commitPollPage({
      cursor,
      observations: [obs],
      events: [event('ok'), bad],
      checkpoints: [checkpoint],
    }),
  )
  assert.equal(store.cursor('s', subject.repoId, cursor.stream), null)
  assert.equal(store.observation('s', subject.repoId, cursor.stream, obs.objectKey), null)
  assert.equal(
    store.pollCheckpoint('s', subject.repoId, cursor.stream, checkpoint.bucket, checkpoint.key),
    null,
  )
  assert.equal(store.inboxEvent('ok'), null)
  const stored = store.commitPollPage({
    cursor,
    observations: [obs],
    checkpoints: [checkpoint],
    events: [
      {
        ...event('ok'),
        evidence: {
          provider: 'github',
          externalEventKey: 'ok',
          subjectKey,
          kind: 'labeled',
          occurredAt: 1,
          actorEvidence: { userId: '120', login: 'collaborator' },
          targetEvidence: { subject, sourceEventId: '891', labelId: '33' },
          contentVersion: null,
          permalink: subject.url,
        },
      },
    ],
  })
  assert.equal(stored[0]?.inserted, true)
  assert.equal(store.eventEvidence('ok')?.targetEvidence.labelId, '33')
  assert.deepEqual(
    store.pollCheckpoint('s', subject.repoId, cursor.stream, checkpoint.bucket, checkpoint.key),
    checkpoint.value,
  )
  assert.deepEqual(store.observations('s', subjectKey), [obs])
  const again = store.insertInboxEvent({ ...event('ok'), sourceId: 'another' })
  assert.equal(again.inserted, false)
  assert.equal(again.record.sourceId, 's')
  const newer = store.insertInboxEvent({ ...event('later'), occurredAt: 0 }).record
  assert.deepEqual(store.inbox({ limit: 1, repoId: subject.repoId }), {
    entries: [newer],
    nextBeforeSeq: newer.seq,
  })
  assert.equal(store.inbox({ beforeSeq: newer.seq }).entries[0]?.eventKey, 'ok')
  assert.throws(
    () => store.commitPollPage({ cursor: { ...cursor, coveredThrough: 1 }, observations: [] }),
    /水位不能回退/,
  )
})

test('投递组确认不等于接单；写入租约超时后只对账，PR 回执和绑定一起落库', (t) => {
  const manager = ledger(t)
  manager.saveManager(sampleManager('m'))
  const store = new ExternalStore(manager)
  const candidate = intake(store, 'candidate', 'm', 'one')
  const group = {
    groupId: 'group',
    sourceId: 's',
    managerId: 'm',
    subjectKey,
    eventKeys: ['one'],
    availableAt: 5,
  }
  store.queue.queueDeliveryGroup(group)
  assert.equal(store.updateIntakeDelivery(candidate.intakeId, 1, group.groupId).outcome, 'applied')
  assert.equal(store.queue.stageDelivery('group', '设备事件：group', 4)?.state, 'queued')
  const staged = store.queue.stageDelivery('group', '设备事件：group', 5)
  assert.equal(staged?.state, 'sending')
  assert.equal(staged?.deliveryId, manager.deliveries('m')[0]?.id)
  assert.deepEqual(store.queue.stageDelivery('group', '设备事件：group', 6), staged)
  assert.equal(
    store.queue.finishDelivery('group', 'confirmed', 7, { turnId: 'turn' })?.turnId,
    'turn',
  )
  assert.deepEqual(manager.deliveries('m'), [])
  assert.equal(store.intake(candidate.intakeId)?.status, 'pending_triage')
  assert.equal(store.inboxEvent('one')?.status, 'pending_triage')

  assert.equal(
    store.commitTriage({ ...accept('candidate', 'm', 'one'), expectedRevision: 2 }).outcome,
    'applied',
  )
  const queued = store.queue.enqueueOutbox({
    ...reply('pr-op'),
    action: 'draft_pr',
    issueId: 'X-1',
  })
  assert.equal(queued.record.state, 'queued')
  assert.equal(
    store.queue.enqueueOutbox({ ...reply('different'), idempotencyKey: 'pr-op' }).inserted,
    false,
  )
  assert.equal(store.queue.beginWrite('pr-op', 1, 10, 15).outcome, 'applied')
  assert.equal(store.queue.expireWriteLeases(15)[0]?.state, 'unknown')
  assert.equal(store.queue.beginWrite('pr-op', 3, 15, 20).outcome, 'conflict')
  assert.equal(store.queue.cancelOutbox('pr-op', 3, 'admin', 16).outcome, 'conflict')
  const pr = {
    ...subject,
    kind: 'pull_request',
    number: '19',
    url: 'https://github.com/example/repo/pull/19',
  } as const
  const receipt = {
    objectId: '1001',
    url: pr.url,
    at: 20,
    botUserId: '4',
    verifiedBy: 'lookup',
  } as const
  const binding = {
    ...pr,
    managerId: 'm',
    issueId: 'X-1',
    createdAt: 20,
    origin: 'write_receipt',
  } as const
  manager.db.exec(`CREATE TRIGGER reject_confirm BEFORE UPDATE ON external_outbox BEGIN
    SELECT RAISE(ABORT, '模拟确认失败'); END`)
  assert.throws(
    () => store.queue.finishWrite('pr-op', 1, { outcome: 'confirmed', at: 20, receipt }, binding),
    /模拟确认失败/,
  )
  assert.equal(store.ref(pr), null)
  assert.equal(store.queue.outboxRecord('pr-op')?.state, 'unknown')
  manager.db.exec('DROP TRIGGER reject_confirm')
  assert.equal(
    store.queue.finishWrite('pr-op', 1, { outcome: 'confirmed', at: 21, receipt }, binding).outcome,
    'applied',
  )
  assert.deepEqual(store.ref(pr), binding)
  const view = store.queue.outbox({ managerId: 'm' }).entries[0]
  assert.ok(view)
  assert.equal(view.state, 'confirmed')
  assert.equal('payloadRef' in view, false)
  assert.equal(store.queue.writeAttempts('pr-op')[0]?.outcome, 'unknown')
})

test('同一仓库只有一个启用源，配置快照按版本可查，凭据只保存公开元数据', (t) => {
  const store = new ExternalStore(ledger(t))
  const draft = {
    sourceId: 'source-a',
    provider: 'github',
    botUserId: '120',
    credentialRef: 'credential',
    enabled: true,
    interval: 120,
    minRole: 'triage',
    triggers: {
      mention: true,
      assignment: true,
      reviewRequest: true,
      label: true,
      labelIds: ['2'],
    },
    writePolicy: { comment: true, draftPr: true, status: false, managedPush: false },
    repos: [
      {
        repoId: subject.repoId,
        owner: 'example',
        name: 'repo',
        url: 'https://github.com/example/repo',
        localRoot: '/work',
        allowedBase: ['main'],
        headNamespace: 'litch/',
      },
    ],
    routes: [],
  } as const
  const source = {
    ...draft,
    repos: draft.repos.map((repo) => ({ ...repo, allowedBase: [...repo.allowedBase] })),
    triggers: { ...draft.triggers, labelIds: [...draft.triggers.labelIds] },
    routes: [],
  }
  const first = store.config.saveSource(source, 0, 'op-a', 'admin')
  assert.equal(first.outcome, 'applied')
  assert.deepEqual(
    store.config.saveSource({ ...source, sourceId: 'source-b' }, 0, 'op-b', 'admin'),
    {
      outcome: 'conflict',
      record: first.record,
    },
  )
  assert.deepEqual(store.config.saveSource(source, 0, 'op-a', 'admin'), first)
  assert.equal(
    store.config.saveSource({ ...source, enabled: false }, 1, 'pause-a', 'admin').outcome,
    'applied',
  )
  assert.equal(
    store.config.saveSource({ ...source, sourceId: 'source-b' }, 0, 'op-b', 'admin').outcome,
    'applied',
  )
  assert.deepEqual(store.config.sourceRevision(source.sourceId, 1), first.record)
  const configure = {
    credentialRef: 'credential',
    provider: 'github',
    botUserId: '120',
    resourceOwnerId: '7',
    createdAt: 1,
    lastVerifiedAt: 1,
    state: 'active',
    generation: 1,
    token: 'test-must-not-be-stored',
  } as const
  assert.equal(store.config.saveCredential(configure, 0, 'op-c').outcome, 'applied')
  assert.doesNotMatch(
    JSON.stringify(store.config.credential('credential')),
    /test-must-not-be-stored/,
  )
  assert.doesNotMatch(
    JSON.stringify(store.audit('credential:credential')),
    /test-must-not-be-stored/,
  )
})
