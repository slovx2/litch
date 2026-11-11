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
  await new Promise((resolve) => setTimeout(resolve, 75))
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
  await new Promise((resolve) => setTimeout(resolve, 75))
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

test('讨论子能力门禁：旧 I-255 白名单接受默认列表、混合记忆与讨论打开；新能力保留字段', async () => {
  let supported = false
  const calls: { method: string; params: any }[] = []
  const issue = structuredClone(managerIssueFixture.newOrdinary)
  const host: ManagersHost = {
    deviceId: 'fixture',
    online: () => true,
    supported: () => true,
    features: () => ({
      issues: true,
      issueDiscussions: supported,
      posts: true,
      feedback: true,
      ignore: true,
    }),
    changed() {},
    log() {},
    fail: (e) => new ChannelError('internal', String(e)),
    request: (async (method: string, params: any) => {
      calls.push({ method, params: structuredClone(params) })
      // 复刻 I-255 两处字段白名单：漏发一个新字段就按旧设备返回 -32602。
      const allow = (value: object, keys: string[]) => {
        for (const key of Object.keys(value))
          if (!keys.includes(key)) throw new Error(`-32602 Unknown field: ${key}`)
      }
      if (method === M.list) {
        allow(params, [
          'managerId',
          'kinds',
          'statuses',
          'authors',
          'followUp',
          'unread',
          'order',
          'cursor',
          'limit',
          ...(supported ? ['discussionsOnly'] : []),
        ])
        return { page: { query: params, entries: [], total: 0, nextCursor: null } }
      }
      if (method === M.update)
        allow(params.patch, [
          'title',
          'body',
          'status',
          'followUp',
          'source',
          'related',
          ...(supported ? ['discussionOpened'] : []),
        ])
      return { issue }
    }) as ManagersHost['request'],
  }
  const service = createManagers(host)
  const query = {
    managerId: 'manager',
    kinds: ['ordinary', 'report'] as ('ordinary' | 'report')[],
    discussionsOnly: true,
    order: 'newest' as const,
  }
  const page = await service.issue(M.list, query)
  assert.deepEqual(calls.at(-1)?.params.kinds, ['ordinary'])
  assert.equal('discussionsOnly' in (calls.at(-1)?.params ?? {}), false)
  assert.deepEqual(page.page.query, query, '返回页仍使用 UI 查询键，不能一直加载中')
  const marker = {
    managerId: 'manager',
    id: 'X-1' as const,
    revision: 1,
    patch: { discussionOpened: true as const },
    why: '打开讨论',
  }
  await service.issue(M.update, marker)
  await settle()
  assert.equal(
    calls.some((c) => c.method === M.update),
    false,
    '纯标记退为读取，不能发空 update',
  )
  await service.issue(M.update, { ...marker, patch: { ...marker.patch, title: '保留原有编辑' } })
  await settle()
  assert.deepEqual(calls.find((c) => c.method === M.update)?.params.patch, {
    title: '保留原有编辑',
  })
  supported = true
  await service.issue(M.list, query)
  assert.equal(calls.at(-1)?.params.discussionsOnly, true)
  assert.deepEqual(calls.at(-1)?.params.kinds, ['ordinary', 'report'])
  await service.issue(M.update, marker)
  await settle()
  assert.equal(calls.findLast((c) => c.method === M.update)?.params.patch.discussionOpened, true)
  // 原查询已经被缓存；降级后写入触发刷新，仍不能漏发新字段。
  supported = false
  const start = calls.length
  await service.issue(M.follow, {
    managerId: 'manager',
    id: 'X-1',
    revision: 1,
    state: 'on',
    why: '跟进',
  })
  await new Promise((resolve) => setTimeout(resolve, 75))
  assert.ok(calls.slice(start).some((c) => c.method === M.list))
  assert.ok(calls.slice(start).every((c) => !('discussionsOnly' in c.params)))
})
