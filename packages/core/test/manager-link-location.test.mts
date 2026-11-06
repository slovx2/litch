import assert from 'node:assert/strict'
import test from 'node:test'
import { mockPosts, sampleReport } from '../src/mock/manager-posts.mjs'
import { sampleManagers } from '../src/mock/sample-manager.mjs'
import { managerObjectLocation } from '../src/projection/manager-paging.mjs'

const makeBoard = () => {
  const board = sampleManagers('local', 1_800_000_000, 'zh-CN').boards[0]
  assert.ok(board)
  board.posts = [...mockPosts(board), sampleReport(1_800_000_000, 'zh-CN')]
  return board
}
for (const [status, filter] of [
  ['open', 'open'],
  ['answered', 'answered'],
  ['expired', 'closed'],
  ['withdrawn', 'closed'],
  ['ignored', 'ignored'],
] as const)
  test(`决策链接按当前 ${status} 状态定位到 ${filter}`, () => {
    const board = makeBoard()
    const decision = board.decisions[0]
    assert.ok(decision)
    decision.status = status
    assert.deepEqual(managerObjectLocation(board, decision.id), {
      kind: 'decision',
      status: filter,
    })
  })
for (const status of ['backlog', 'running', 'review', 'blocked', 'done', 'deferred'] as const)
  test(`事项链接定位到 ${status}，不误用待处理合并分组`, () => {
    const board = makeBoard()
    const item = board.items[0]
    assert.ok(item)
    item.status = status
    assert.deepEqual(managerObjectLocation(board, item.id), { kind: 'item', status })
  })
for (const status of ['open', 'replied', 'delivered', 'cancelled'] as const)
  test(`请求链接定位到 ${status}`, () => {
    const board = makeBoard()
    const request = board.requests?.[0]
    assert.ok(request)
    request.status = status
    assert.deepEqual(managerObjectLocation(board, request.id), { kind: 'request', status })
  })
for (const unread of [true, false])
  test(`报告链接定位到${unread ? '未读' : '已读'}`, () => {
    const board = makeBoard()
    const report = board.posts?.find((post) => post.kind === 'report')
    assert.ok(report)
    report.unread = unread
    assert.deepEqual(managerObjectLocation(board, report.id), {
      kind: 'report',
      status: unread ? 'unread' : 'read',
    })
  })
test('未到的详情不猜分组；后续答复、撤回及重开使用新状态，不缓存首次落点', () => {
  const board = makeBoard()
  const decision = board.decisions[0]
  assert.ok(decision)
  board.decisions = []
  assert.equal(managerObjectLocation(board, decision.id), null)
  assert.equal(managerObjectLocation(board, 'D-9999'), null)
  board.decisions = [decision]
  for (const status of ['answered', 'withdrawn', 'open'] as const) {
    decision.status = status
    assert.equal(
      managerObjectLocation(board, decision.id)?.status,
      status === 'withdrawn' ? 'closed' : status,
    )
  }
})
