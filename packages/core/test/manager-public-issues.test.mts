import assert from 'node:assert/strict'
import test from 'node:test'
import {
  MANAGER_ISSUE_METHOD as M,
  type ManagerIssue,
  managerIssueFixture,
  MANAGER_ISSUE_NOTIFICATION as N,
} from '../../protocol/src/manager-issues.mjs'
import { ChannelError } from '../src/channel/protocol.mjs'
import { createManagers, type ManagersHost } from '../src/device/manager.mjs'
import { MockManagerIssues } from '../src/mock/mock-manager-issues.mjs'
import { sampleManagers } from '../src/mock/sample-manager.mjs'
import type { ManagerBoardTopicView } from '../src/model-manager.mjs'
import { managerIssueQueryKey } from '../src/model-manager-issues.mjs'
import {
  managerIssuePending,
  projectManagerIssue,
} from '../src/projection/manager-public-issues.mjs'
import { settle } from './helpers.mjs'

test('issue 时间投影与特殊状态：全部时间为毫秒，报告不计待处理', () => {
  const raw: ManagerIssue = {
    ...structuredClone(managerIssueFixture.newOrdinary),
    discussion: {
      comments: [
        {
          id: 'c',
          revision: 1,
          author: { kind: 'manager' },
          body: '回复',
          createdAt: 2,
          updatedAt: 3,
          replyTo: null,
        },
      ],
      questions: [
        {
          id: 'q',
          question: '问题',
          answer: '回答',
          at: 4,
          answeredAt: 5,
          status: 'completed',
          refreshed: false,
        },
      ],
      summary: null,
    },
  }
  const view = projectManagerIssue(raw)
  assert.equal(view.createdAt, raw.createdAt * 1000)
  assert.equal(view.discussion.comments[0]?.updatedAt, 3000)
  assert.equal(view.discussion.questions[0]?.answeredAt, 5000)
  assert.equal(view.followUp.changedAt, raw.followUp.changedAt * 1000)
  assert.equal(view.timeline[0]?.at, raw.timeline[0]!.at * 1000)
  assert.equal(managerIssuePending({ kind: 'report', status: 'unread' }), false)
  assert.equal(managerIssuePending({ kind: 'ordinary', status: 'blocked' }), true)
})

test('核心 issue 缓存经 managerBoard 发布；通知/重连对账，旧设备与离线不发送写入', async () => {
  const sample = sampleManagers('local', 1700000000, 'zh-CN')
  const manager = sample.managers[0]!
  const board = sample.boards[0]!
  let raw: ManagerIssue = structuredClone(managerIssueFixture.newOrdinary)
  let online = true,
    supported = true
  const calls: string[] = []
  const host: ManagersHost = {
    deviceId: 'd',
    online: () => online,
    supported: () => true,
    features: () => ({ posts: true, feedback: true, ignore: true, issues: supported }),
    changed() {},
    log() {},
    fail: (error) => new ChannelError('internal', String(error)),
    request: (async (method: string) => {
      calls.push(method)
      if (method === 'litch/manager/list') return { managers: [manager] }
      if (method === 'litch/manager/board/read') return { board }
      if (method === M.list)
        return {
          page: {
            query: { managerId: manager.id, order: 'newest' },
            entries: [
              {
                id: raw.id,
                kind: raw.kind,
                title: raw.title,
                preview: raw.body,
                status: raw.status,
                stateGroup: raw.stateGroup,
                author: raw.author.kind,
                followUp: raw.followUp.state,
                unread: raw.unread,
                revision: raw.revision,
                createdAt: raw.createdAt,
                updatedAt: raw.updatedAt,
              },
            ],
            total: 1,
            nextCursor: null,
          },
        }
      return { issue: structuredClone(raw) }
    }) as ManagersHost['request'],
  }
  const service = createManagers(host)
  let view: ManagerBoardTopicView | undefined
  const activity: unknown[] = []
  service.open({ snapshot() {}, delta: (ops: any[]) => activity.push(...ops), end() {} } as any)
  service.resync()
  await settle()
  service.openBoard(manager.id, {
    snapshot: (v: ManagerBoardTopicView) => {
      view = v
    },
    delta: (ops: any[]) => {
      for (const op of ops) view = op.view
    },
    end() {},
  } as any)
  const query = { managerId: manager.id, order: 'newest' as const }
  await service.issue(M.list, query)
  await service.issue(M.read, { managerId: manager.id, id: 'X-1' })
  await settle()
  assert.equal(view!.issues!.pages[managerIssueQueryKey(query)]?.entries[0]?.id, 'X-1')
  assert.equal(view!.issues!.details['X-1']?.createdAt, raw.createdAt * 1000)
  raw = { ...raw, title: '重连后的标题', unread: true, updatedAt: raw.updatedAt + 1 }
  const event = {
    managerId: manager.id,
    issueId: raw.id,
    eventId: 'event-1',
    kind: 'issue-comment',
    actor: 'manager',
    followUp: 'off',
    unread: true,
  }
  service.notification(N.activity, event)
  await settle()
  assert.equal(view!.issues!.details['X-1']?.title, raw.title)
  assert.equal(activity.filter((op: any) => op.op === 'manager.issueActivity').length, 1)
  service.notification(N.activity, event)
  await settle()
  assert.equal(activity.filter((op: any) => op.op === 'manager.issueActivity').length, 1)
  online = false
  service.offline()
  const count = calls.length
  await assert.rejects(
    service.issue(M.comment, {
      managerId: manager.id,
      id: raw.id,
      revision: raw.revision,
      body: '离线',
    }),
    { code: 'offline' },
  )
  assert.equal(calls.length, count)
  assert.equal(view!.issues!.details['X-1']?.unread, true)
  online = true
  raw = { ...raw, unread: false }
  service.resync()
  await settle()
  assert.equal(view!.issues!.details['X-1']?.unread, false)
  supported = false
  await assert.rejects(
    service.issue(M.create, { managerId: manager.id, title: '不支持', body: '' }),
    { code: 'unsupported' },
  )
})

test('mock 命令行为与协议一致，普通 X-n 不影响旧对象编号', () => {
  const board = sampleManagers('local', 1700000000, 'zh-CN').boards[0]!
  const mock = new MockManagerIssues()
  const created = mock.command(
    'd/m',
    board,
    'managers.issue.create',
    { managerId: board.managerId, title: '测试普通 issue', body: '', idempotencyKey: 'create' },
    10,
  ) as { issue: ManagerIssue }
  assert.equal(created.issue.id, 'X-1')
  const params = {
    managerId: board.managerId,
    id: 'X-1',
    revision: 1,
    body: '评论',
    idempotencyKey: 'comment',
  }
  const comment = mock.command('d/m', board, 'managers.issue.comment', params, 11) as {
    issue: ManagerIssue
  }
  assert.deepEqual(mock.command('d/m', board, 'managers.issue.comment', params, 12), comment)
  assert.equal(comment.issue.discussion.comments.length, 1)
  const updated = mock.command(
    'd/m',
    board,
    'managers.issue.update',
    {
      managerId: board.managerId,
      id: 'X-1',
      revision: 1,
      patch: { status: 'resolved', followUp: 'off' },
      why: '已解决',
    },
    13,
  ) as { issue: ManagerIssue }
  assert.equal(updated.issue.status, 'resolved')
  assert.equal(updated.issue.followUp.state, 'off')
  assert.equal(updated.issue.stateGroup, 'closed')
})
