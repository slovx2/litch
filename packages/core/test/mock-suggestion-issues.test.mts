import assert from 'node:assert/strict'
import test from 'node:test'
import type { ManagerIssuePage } from '../../protocol/src/manager-issues.mjs'
import { mockPosts } from '../src/mock/manager-posts.mjs'
import { createMockCore } from '../src/mock/mock-core.mjs'
import { MockManagerIssues } from '../src/mock/mock-manager-issues.mjs'
import type { ManagerBoardTopicView, ManagerBoardView } from '../src/model-manager.mjs'
import type { SuggestionsView } from '../src/model-suggestions.mjs'
import { fakeClock } from './helpers.mjs'

test('模拟建议了结后同步帖子、issue 详情和已订阅的筛选页', async () => {
  const time = fakeClock()
  const core = createMockCore({ clock: time.clock, chunkMs: 0 })
  const signal = new AbortController().signal
  let inbox: SuggestionsView | undefined
  let board: ManagerBoardTopicView | undefined
  const stop = core.subscribe(
    { kind: 'suggestions', deviceId: 'local' },
    {
      snapshot: (value) => {
        inbox = value as SuggestionsView
      },
      delta: (ops) => {
        inbox = (ops[0] as { view: SuggestionsView }).view
      },
      error: (error) => {
        throw error
      },
    },
  )
  const stopBoard = core.subscribe(
    { kind: 'managerBoard', deviceId: 'local', managerId: 'm1' },
    {
      snapshot: (value) => {
        board = value as ManagerBoardTopicView
      },
      delta: (ops) => {
        board = (ops[0] as { view: ManagerBoardTopicView }).view
      },
      error: (error) => {
        throw error
      },
    },
  )
  try {
    await core.command(
      'session.send',
      { deviceId: 'local', sessionId: 'manager-k2', text: '收尾建议' },
      signal,
    )
    time.advance(20_000)
    assert.ok(inbox)
    const rows = inbox.suggestions.filter((row) => row.managerId === 'm1')
    assert.equal(rows.length, 2)
    const row = rows[0]
    assert.ok(row)
    const where = { deviceId: 'local', managerId: 'm1' }
    const list = () =>
      core.command(
        'managers.issues.list',
        { ...where, kinds: ['suggestion'], statuses: ['pending'] },
        signal,
      ) as Promise<{ page: ManagerIssuePage }>
    assert.equal((await list()).page.total, 2)
    const id = `S-${row.proposal.id}`
    await core.command('managers.issue.read', { ...where, id }, signal)
    await core.command(
      'session.proposal.dismiss',
      { deviceId: 'local', sessionId: row.source.threadId, proposalId: row.proposal.id },
      signal,
    )
    const projected = board?.issues
    assert.ok(projected)
    assert.equal(projected.details[id]?.status, 'dismissed')
    const pending = Object.values(projected.pages).find((page) =>
      page.query.statuses?.includes('pending'),
    )
    assert.ok(pending)
    assert.equal(pending.total, 1)
    assert.ok(pending.entries.every((entry) => entry.id !== id))
    assert.equal((await list()).page.total, 1)

    const sourceBoard = board?.board
    assert.ok(sourceBoard)
    // 使用同一份提案权威输入验证其他了结方式，不通过“从活动列表消失”猜状态。
    for (const [raw, expected] of [
      ['started', 'started'],
      ['here', 'started'],
      ['withdrawn', 'dismissed'],
      ['expired', 'expired'],
    ] as const) {
      const source = { ...row, proposal: { ...row.proposal, status: raw, settledAt: 21_000 } }
      const data: ManagerBoardView = { ...sourceBoard, posts: [] }
      data.posts = mockPosts(data, [source])
      const issues = new MockManagerIssues()
      const result = issues.command(
        'isolated',
        data,
        'managers.issues.list',
        { kinds: ['suggestion'], statuses: [expected] },
        22_000,
      ) as { page: { total: number; entries: { status: string }[] } }
      assert.equal(result.page.total, 1, raw)
      assert.equal(result.page.entries[0]?.status, expected, raw)
    }
  } finally {
    stop()
    stopBoard()
  }
})
