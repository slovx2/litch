// 分页看板的草稿判断面（没点开过的对象用卡头补）与收起卡头上的草稿标记。
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { liveManagerDrafts, managerDraftMark, pagedDraftBoard } from '../src/index.mjs'

const head = (id: string, kind: string, status: string, revision = 1) => ({
  id,
  kind,
  status,
  revision,
})

test('没点开过的决策用卡头补状态：草稿照常计数、可提交，在别处答复的是 ended', () => {
  const empty = { decisions: [], changes: [] }
  const drafts = {
    decisions: [
      { decisionId: 'D-2', revision: 1, optionId: 'b', text: '' },
      { decisionId: 'D-7', revision: 1, optionId: 'a', text: '' },
    ],
    requests: [],
    posts: [],
  }
  // 不补卡头：两条都当成 ended，提交条少算、漏交
  assert.equal(liveManagerDrafts(empty, drafts).count, 0)
  const board = pagedDraftBoard(empty, [
    head('D-2', 'decision', 'open'),
    head('D-7', 'decision', 'answered', 1),
    head('D-7', 'decision', 'answered', 2),
  ])
  const live = liveManagerDrafts(board, drafts)
  assert.equal(live.count, 1)
  assert.deepEqual(
    live.answers.map((one) => one.decisionId),
    ['D-2'],
  )
  assert.deepEqual([...live.ended.decisions], ['D-7'], '同一对象取版本最高的卡头')
})

test('详情为准：已点开的对象不被卡头覆盖；经理未审核的建议仍算待开始', () => {
  const board = pagedDraftBoard(
    { decisions: [{ id: 'D-1', status: 'open', revision: 3 }], changes: [] },
    [head('D-1', 'decision', 'answered', 2), head('S-1', 'suggestion', 'review')],
  )
  assert.deepEqual(board.decisions, [{ id: 'D-1', status: 'open', revision: 3 }])
  assert.deepEqual(board.posts?.find((one) => one.id === 'S-1')?.fields, { status: 'pending' })
})

test('卡头标记：写了什么、照常、待确认、已失效；什么都没写是 null', () => {
  const board = pagedDraftBoard({ decisions: [], changes: [] }, [
    head('D-1', 'decision', 'open', 2),
    head('D-2', 'decision', 'ignored', 2),
    head('R-1', 'request', 'open'),
  ])
  const decision = (id: string, revision: number, extra: object) => ({
    decisionId: id,
    revision,
    optionId: null,
    text: '',
    ...extra,
  })
  assert.equal(managerDraftMark(board, 'D-1', {}), null)
  assert.deepEqual(
    managerDraftMark(board, 'D-1', {
      decision: decision('D-1', 2, { optionId: 'a', question: '为什么' }),
    }),
    { state: 'live', optionId: 'a', text: false, question: true, delivered: false },
  )
  // 一直待定、版本变了：先确认
  assert.equal(
    managerDraftMark(board, 'D-1', { decision: decision('D-1', 1, { text: '说明' }) })?.state,
    'conflict',
  )
  assert.equal(
    managerDraftMark(board, 'D-2', { decision: decision('D-2', 1, { text: '说明' }) })?.state,
    'ended',
  )
  assert.deepEqual(
    managerDraftMark(board, 'R-1', {
      request: { requestId: 'R-1', revision: 1, delivered: true, text: '' },
      post: { id: 'R-1', revision: 1, question: '' },
    }),
    { state: 'live', optionId: null, text: false, question: false, delivered: true },
  )
})
