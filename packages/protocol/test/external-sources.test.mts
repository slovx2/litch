import assert from 'node:assert/strict'
import test from 'node:test'
import { Ajv2019 } from 'ajv/dist/2019.js'
import autostart from '../../../protocol/extensions/device-autostart.json' with { type: 'json' }
import external from '../../../protocol/extensions/external-sources.json' with { type: 'json' }
import manager from '../../../protocol/extensions/manager.json' with { type: 'json' }
import {
  DEVICE_AUTOSTART_METHOD as AUTO,
  DEVICE_AUTOSTART_CHANGED,
  DEVICE_AUTOSTART_EXTENSION,
  type DeviceAutostartRequests,
  isDeviceAutostartMutationParams,
} from '../src/device-autostart.mjs'
import {
  EXTERNAL_ANSWER_PROJECTION_SAMPLE,
  EXTERNAL_NOTIFICATION,
  EXTERNAL_SOURCES_EXTENSION,
  type ExternalInboxEvent,
  type ExternalMandate,
  type ExternalRef,
  type ExternalRequests,
  type ExternalSourceDraft,
  projectExternalManagerPayload,
  EXTERNAL_METHOD as RPC,
} from '../src/external-sources.mjs'
import { isExternalAnswerSource, isExternalMethodParams } from '../src/external-validation.mjs'
import { managerIssueFixture } from '../src/manager-issues.mjs'

const ajv = new Ajv2019({ strict: false })
for (const schema of [autostart, external, manager])
  ajv.addSchema(schema, schema === manager ? 'manager' : schema.extension)

function assertWire(
  schema: typeof autostart | typeof external,
  method: string,
  field: 'params' | 'result',
  value: unknown,
) {
  const i = schema.parts.findIndex((part) => part.name === method)
  assert.notEqual(i, -1)
  const validate = ajv.compile({ $ref: `${schema.extension}#/parts/${i}/${field}` })
  assert.ok(validate(value), JSON.stringify(validate.errors))
}

const revision = { operationId: 'op', expectedRevision: 0 }
const subject = {
  provider: 'github',
  repoId: '9007199254740993',
  number: '1',
  kind: 'issue',
  url: 'https://github.com/example/repo/issues/1',
} as const
const ref = {
  ...subject,
  managerId: 'm',
  issueId: 'X-1',
  origin: 'intake',
  createdAt: 2,
} as const satisfies ExternalRef
const scope = {
  repoId: subject.repoId,
  subjectKey: 'github/9007199254740993/1',
  actions: ['comment'],
} as const
const mandate = {
  mandateId: 'mandate',
  managerId: 'm',
  issueId: 'X-1',
  subjectKey: scope.subjectKey,
  decision: 'accept',
  requesterUserId: '3',
  observedRole: 'triage',
  eventKeys: ['event'],
  ruleId: 'label',
  rulesVersion: 1,
  routeId: 'route',
  acceptedBy: 'm',
  acceptedAt: 3,
  authorizedScope: { ...scope, actions: [...scope.actions] },
  policyRevision: 1,
} satisfies ExternalMandate
const source = {
  sourceId: 's',
  provider: 'github',
  enabled: false,
  credentialRef: 'cred',
  botUserId: '2',
  interval: 120,
  minRole: 'triage',
  triggers: { mention: true, assignment: true, reviewRequest: true, label: true, labelIds: ['3'] },
  writePolicy: { comment: true, draftPr: true, status: false, managedPush: false },
  repos: [
    {
      repoId: subject.repoId,
      url: 'https://github.com/example/repo',
      owner: 'example',
      name: 'repo',
      localRoot: '/work',
      allowedBase: ['main'],
      headNamespace: 'litch/',
    },
  ],
  routes: [
    { routeId: 'r', stableManagerId: 'm', priority: 1, repoIds: [subject.repoId], enabled: true },
  ],
} satisfies ExternalSourceDraft
const owner = {
  provider: 'github',
  userId: '3',
  loginCache: 'owner',
  profileUrl: 'https://github.com/owner',
  method: 'userId',
} as const
const credential = { credentialRef: 'cred', expectedGeneration: 1, operationId: 'op' }
const inbox = {
  seq: 1,
  revision: 1,
  eventKey: 'event',
  sourceId: 's',
  subjectKey: scope.subjectKey,
  subject,
  kind: 'labeled',
  sourceEventId: '11',
  actorId: '3',
  actorRoleAtCheck: 'triage',
  occurredAt: 1,
  observedAt: 2,
  status: 'pending_triage',
  eventUrl: subject.url,
  contentVersion: 'hash',
} satisfies ExternalInboxEvent
const { seq: _seq, revision: _revision, ...preview } = inbox

test('所有 RPC 样本都通过定义和入站校验；公开结果不接收凭据、正文和私有载荷', () => {
  assert.equal(external.extension, EXTERNAL_SOURCES_EXTENSION)
  const params = {
    [RPC.ownerGet]: {},
    [RPC.ownerSet]: { ...revision, owner },
    [RPC.credentialConfigure]: {
      token: 'fixture-only',
      repoIds: [subject.repoId],
      operationId: 'op',
    },
    [RPC.credentialRotate]: { ...credential, token: 'fixture-only' },
    [RPC.credentialRevoke]: credential,
    [RPC.sourceList]: {},
    [RPC.sourceGet]: { sourceId: 's' },
    [RPC.sourceUpsert]: { ...revision, source },
    [RPC.sourcePreview]: { source },
    [RPC.sourcePause]: { ...revision, sourceId: 's' },
    [RPC.sourceResume]: { ...revision, sourceId: 's' },
    [RPC.sourceCheck]: { sourceId: 's' },
    [RPC.inboxList]: { status: 'pending_triage', limit: 100, repoId: subject.repoId },
    [RPC.inboxGet]: { eventKey: 'event' },
    [RPC.inboxTriage]: {
      action: 'merge',
      intakeId: 'i',
      expectedRevision: 1,
      idempotencyKey: 'op',
      issueId: 'X-1',
      expectedIssueRevision: 2,
    },
    [RPC.outboxList]: { state: 'unknown', managerId: 'm' },
    [RPC.outboxGet]: { operationId: 'op' },
    [RPC.outboxReconcile]: { operationId: 'op' },
    [RPC.outboxCancel]: { ...revision, targetOperationId: 'target-op' },
  } satisfies { [M in keyof ExternalRequests]: ExternalRequests[M]['params'] }
  const sourceStatus = {
    source: { ...source, revision: 1, rulesVersion: 1, createdAt: 0 },
    coverage: [],
  }
  const credentialResult = {
    credential: {
      provider: 'github',
      credentialRef: 'cred',
      botUserId: '2',
      resourceOwnerId: '4',
      createdAt: 1,
      lastVerifiedAt: 2,
      state: 'active',
      generation: 1,
    },
  } as const
  const outbox = {
    seq: 1,
    operationId: 'op',
    sourceId: 's',
    managerId: 'm',
    issueId: 'X-1',
    targetRef: subject,
    action: 'comment',
    state: 'queued',
    revision: 1,
    attempts: 0,
  } as const
  const result = {
    [RPC.ownerGet]: { owner: null },
    [RPC.ownerSet]: { owner: { ...owner, configuredBy: 'device-admin', revision: 1 } },
    [RPC.credentialConfigure]: credentialResult,
    [RPC.credentialRotate]: credentialResult,
    [RPC.credentialRevoke]: { credential: { ...credentialResult.credential, state: 'revoked' } },
    [RPC.sourceList]: { sources: [sourceStatus] },
    [RPC.sourceGet]: sourceStatus,
    [RPC.sourceUpsert]: sourceStatus,
    [RPC.sourcePreview]: { matches: [preview], diagnostics: [] },
    [RPC.sourcePause]: sourceStatus,
    [RPC.sourceResume]: sourceStatus,
    [RPC.sourceCheck]: { diagnostics: [] },
    [RPC.inboxList]: { entries: [inbox], nextBeforeSeq: null },
    [RPC.inboxGet]: { events: [inbox], intake: null },
    [RPC.inboxTriage]: {
      outcome: 'applied',
      intake: {
        intakeId: 'i',
        sourceId: 's',
        subjectKey: scope.subjectKey,
        subject,
        eventKeys: ['event'],
        autoNotifyUntil: 100,
        status: 'processed',
        revision: 2,
        managerId: 'm',
        issueId: 'X-1',
      },
      ref,
      mandate,
    },
    [RPC.outboxList]: { entries: [outbox], nextBeforeSeq: null },
    [RPC.outboxGet]: outbox,
    [RPC.outboxReconcile]: { receipt: null, diagnostics: [] },
    [RPC.outboxCancel]: { ...outbox, state: 'canceled', revision: 2 },
  } satisfies { [M in keyof ExternalRequests]: ExternalRequests[M]['result'] }
  for (const method of Object.values(RPC)) {
    assertWire(external, method, 'params', params[method])
    assertWire(external, method, 'result', result[method])
    assert.equal(isExternalMethodParams(method, params[method]), true)
    assert.equal(isExternalMethodParams(method, { ...params[method], unexpected: true }), false)
  }
  for (const method of Object.values(EXTERNAL_NOTIFICATION))
    assertWire(external, method, 'params', {
      sourceId: 's',
      revision: 1,
      ...(method === EXTERNAL_NOTIFICATION.sourcesChanged ? {} : { pending: 1, managerId: 'm' }),
    })
  const credentialSchema = ajv.compile({ $ref: `${external.extension}#/definitions/Credential` })
  assert.equal(credentialSchema({ ...credentialResult.credential, token: 'forbidden' }), false)
  const outboxSchema = ajv.compile({ $ref: `${external.extension}#/definitions/OutboxSummary` })
  assert.equal(outboxSchema({ ...outbox, payloadRef: 'private' }), false)
  assert.equal(isExternalMethodParams(RPC.inboxList, { repoId: Number(subject.repoId) }), false)
  assert.equal(
    isExternalMethodParams(RPC.inboxTriage, {
      ...params[RPC.inboxTriage],
      expectedIssueRevision: undefined,
    }),
    false,
  )
})

test('同一个经理负载按两条实际投递声明裁剪，旧版答复可过原严格契约', () => {
  const oldAnswer = ajv.compile({ $ref: 'manager#/definitions/Answer' })
  const issue = {
    ...managerIssueFixture.newOrdinary,
    externalRefs: [ref],
    intakeMandates: [mandate],
  }
  const payload = {
    detail: { issue },
    changes: [
      { fields: ['answerSource', 'answer'], after: { answer: EXTERNAL_ANSWER_PROJECTION_SAMPLE } },
    ],
  }
  const optedIn = new Set(['litchManager', 'litchManagerIssues', EXTERNAL_SOURCES_EXTENSION])
  const legacy = new Set(['litchManager', 'litchManagerIssues'])
  const rendered = [optedIn, legacy, new Set([EXTERNAL_SOURCES_EXTENSION])].map((declaration) =>
    projectExternalManagerPayload(payload, declaration),
  )
  assert.deepEqual(rendered[0], payload)
  for (const other of rendered.slice(1)) {
    assert.deepEqual(other?.detail.issue, managerIssueFixture.newOrdinary)
    assert.deepEqual(other?.changes[0]?.fields, ['answer'])
    assert.ok(oldAnswer(other?.changes[0]?.after.answer))
  }
  assert.ok(isExternalAnswerSource(EXTERNAL_ANSWER_PROJECTION_SAMPLE.answerSource))
  assert.equal(oldAnswer(payload.changes[0]?.after.answer), false)
  const onlyIssue = projectExternalManagerPayload(
    payload,
    new Set(['litchManagerIssues', EXTERNAL_SOURCES_EXTENSION]),
  )
  assert.deepEqual(onlyIssue.detail.issue.externalRefs, [ref])
  assert.ok(oldAnswer(onlyIssue.changes[0]?.after.answer))
})

test('自启受理和实际结果区分；仅启用可授权接管和 linger', () => {
  assert.equal(autostart.extension, DEVICE_AUTOSTART_EXTENSION)
  const enable = {
    ...revision,
    takeover: true,
    allowLinger: true,
    confirmStop: true,
    resumeAfterRestart: true,
  }
  const disable = { ...revision, confirmStop: true, resumeAfterRestart: true }
  const status = {
    revision: 1,
    serviceManager: 'launchd',
    state: 'enabled',
    requiresLogin: true,
    linger: 'notApplicable',
    lastOperation: { operationId: 'op', action: 'enable', state: 'completed' },
  } satisfies DeviceAutostartRequests[typeof AUTO.get]['result']
  assertWire(autostart, AUTO.get, 'params', {})
  assertWire(autostart, AUTO.get, 'result', status)
  assertWire(autostart, AUTO.enable, 'params', enable)
  assertWire(autostart, AUTO.enable, 'result', {
    state: 'accepted',
    operationId: 'op',
    reconnect: true,
  })
  assertWire(autostart, AUTO.disable, 'params', disable)
  assertWire(autostart, AUTO.disable, 'result', {
    state: 'completed',
    status: { ...status, state: 'disabled' },
  })
  assertWire(autostart, DEVICE_AUTOSTART_CHANGED, 'params', { revision: 1 })
  assert.ok(isDeviceAutostartMutationParams(AUTO.enable, enable))
  assert.ok(isDeviceAutostartMutationParams(AUTO.disable, disable))
  assert.equal(isDeviceAutostartMutationParams(AUTO.disable, enable), false)
  assert.equal(
    isDeviceAutostartMutationParams(AUTO.enable, { ...enable, confirmStop: 'true' }),
    false,
  )
})
