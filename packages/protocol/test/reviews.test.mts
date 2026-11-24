import assert from 'node:assert/strict'
import test from 'node:test'
import { Ajv2019 } from 'ajv/dist/2019.js'
import reviews from '../../../protocol/extensions/reviews.json' with { type: 'json' }
import {
  isReviewsMethod,
  isReviewsMethodParams,
  REVIEWS_EXTENSION,
  REVIEWS_METHOD,
  REVIEWS_NOTIFICATION,
  type Review,
  type ReviewsNotifications,
  type ReviewsRequests,
} from '../src/reviews.mjs'

const ajv = new Ajv2019({ strict: false })
ajv.addSchema(reviews, reviews.extension)

function wire(name: string, field: 'params' | 'result', value: unknown): boolean {
  const i = reviews.parts.findIndex((part) => part.name === name)
  assert.notEqual(i, -1, name)
  const validate = ajv.compile({ $ref: `${reviews.extension}#/parts/${i}/${field}` })
  return validate(value) as boolean
}

const review = {
  reviewId: 'A-1',
  revision: 1,
  kind: 'speech',
  provider: 'feishu',
  scope: 'cli_0123456789abcdef/oc_example1',
  subjectRef: 'op-sample-1',
  requestedBy: { managerId: 'm-1', threadId: 't-1', turnId: 'u-1' },
  preview: {
    kind: 'speech',
    provider: 'feishu',
    appId: 'cli_0123456789abcdef',
    appName: '示例机器人',
    target: { kind: 'chat', id: 'oc_example1', name: '示例项目群' },
    replyTo: { messageId: 'om_parent', text: '原话' },
    actingAs: { type: 'bot' },
    mentions: [{ openId: 'ou_alice', name: '示例成员甲' }],
    parts: [
      { format: 'post', text: '@示例成员甲 示例发言' },
      { format: 'image', name: 'shot.png', size: 1024 },
    ],
    cli: { method: 'POST', path: '/open-apis/im/v1/messages/:id/reply', action: 'reply' },
  },
  payloadHash: 'a'.repeat(64),
  state: 'pending',
  createdAt: 10,
  expiresAt: 100,
} satisfies Review
const decided = {
  ...review,
  revision: 2,
  state: 'rejected',
  decidedBy: { via: 'litch' },
  decidedAt: 20,
  reason: '措辞不对',
} satisfies Review

const samples: {
  [M in keyof ReviewsRequests]: [ReviewsRequests[M]['params'], ReviewsRequests[M]['result']]
} = {
  [REVIEWS_METHOD.list]: [
    { states: ['pending'], managerId: 'm-1', before: 'A-9', limit: 20 },
    { reviews: [review], next: 'A-1' },
  ],
  [REVIEWS_METHOD.get]: [{ reviewId: 'A-1' }, { review }],
  [REVIEWS_METHOD.decide]: [
    { reviewId: 'A-1', decision: 'reject', reason: '措辞不对', expectedRevision: 1 },
    { review: decided },
  ],
}

test('每个方法的样本都通过定义和入站校验', () => {
  assert.equal(reviews.extension, REVIEWS_EXTENSION)
  const methods = reviews.parts.filter((part) => part.kind === 'Method').map((part) => part.name)
  assert.deepEqual(methods.sort(), Object.values(REVIEWS_METHOD).sort())
  for (const [method, [params, result]] of Object.entries(samples)) {
    assert.ok(isReviewsMethod(method))
    assert.ok(wire(method, 'params', params), `${method} params`)
    assert.ok(wire(method, 'result', result), `${method} result`)
    assert.ok(isReviewsMethodParams(method, params), `${method} 入站`)
  }
  const notifications: ReviewsNotifications = {
    [REVIEWS_NOTIFICATION.changed]: { reviewId: 'A-1', revision: 2, managerId: 'm-1' },
  }
  for (const [name, value] of Object.entries(notifications))
    assert.ok(wire(name, 'params', value), name)
})

test('入站校验拒绝畸形参数', () => {
  const decide = REVIEWS_METHOD.decide
  assert.equal(isReviewsMethodParams(decide, { reviewId: 'A-1', decision: 'approve' }), false)
  assert.equal(
    isReviewsMethodParams(decide, { reviewId: 'X-1', decision: 'approve', expectedRevision: 1 }),
    false,
  )
  assert.equal(
    isReviewsMethodParams(decide, {
      reviewId: 'A-1',
      decision: 'maybe',
      expectedRevision: 1,
    }),
    false,
  )
  assert.equal(
    isReviewsMethodParams(decide, {
      reviewId: 'A-1',
      decision: 'approve',
      expectedRevision: 1,
      reason: '长'.repeat(501),
    }),
    false,
  )
  assert.equal(isReviewsMethodParams(REVIEWS_METHOD.list, { states: [] }), false)
  assert.equal(isReviewsMethod('litch/reviews/unknown'), false)
  assert.equal(
    wire(REVIEWS_METHOD.get, 'result', { review: { ...review, payloadHash: 'x' } }),
    false,
  )
})
