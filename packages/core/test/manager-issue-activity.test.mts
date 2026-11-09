import assert from 'node:assert/strict'
import test from 'node:test'
import type { ManagerIssueTimelineEntry } from '../../protocol/src/manager-issues.mjs'
import { managerIssueActivity } from '../src/projection/manager-issue-activity.mjs'

const at = Date.UTC(2026, 10, 9)
const event = (
  id: string,
  patch: Partial<ManagerIssueTimelineEntry> = {},
): ManagerIssueTimelineEntry => ({
  id,
  kind: 'edited',
  actor: 'manager',
  at,
  summary: '补充验证范围',
  ...patch,
})

test('活动只留经理实质更新；用户反馈、关系、依据、开关及缺时间记录保持原数据但不显示', () => {
  const timeline = [
    event('body', { changeId: 'body' }),
    event('status', { kind: 'status' }),
    event('user', { actor: 'user', kind: 'status' }),
    event('comment', { kind: 'comment' }),
    event('link', { kind: 'relation', summary: 'D-1 → /Users/dev/app' }),
    event('basis', { changeId: 'basis' }),
    event('switch', { changeId: 'switch' }),
    event('missing', { at: 0 }),
    event('nan', { at: Number.NaN }),
    event('projection', { summary: 'D-1 → feature/sample' }),
    event('open', { summary: '展开讨论' }),
    event('read', { kind: 'read' }),
  ]
  const before = structuredClone(timeline)
  const changes = [
    { id: 'body', fields: ['body', 'basis'] },
    { id: 'basis', fields: ['basis', 'links'] },
    { id: 'switch', fields: ['discussionOpened'] },
  ]
  assert.deepEqual(
    managerIssueActivity(timeline, changes).map((x) => x.id),
    ['body', 'status'],
  )
  assert.deepEqual(timeline, before, '过滤不得删改存量事件')
})

test('经理更新原因中的本机路径不进入活动行；评论正文不受影响', () => {
  for (const path of [
    '/Users/dev/app',
    '/Volumes/example/app',
    '/home/dev/app',
    '/root/app',
    'C:\\Users\\dev\\app',
  ]) {
    const input = event(path, { summary: `更新 ${path} 的方案` })
    assert.equal(managerIssueActivity([input])[0]?.summary, '')
    assert.equal(managerIssueActivity([event(path, { summary: `更新：${path}` })])[0]?.summary, '')
    assert.match(input.summary, /更新/)
  }
  assert.equal(managerIssueActivity([event('normal')])[0]?.summary, '补充验证范围')
})
