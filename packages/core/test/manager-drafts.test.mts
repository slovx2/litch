import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  decisionDraftState,
  liveManagerDrafts,
  postDraftState,
  requestDraftState,
} from '../src/index.mjs'

const change = (revision: number, status: string, fields: string[]) => ({
  objectId: 'D-1',
  fields,
  after: { status, revision },
})

test('决策草稿：在别处答复后是 ended，重开后只经过状态变化就自动恢复并跟上版本', () => {
  const answered = {
    decisions: [{ id: 'D-1', status: 'answered' as const, revision: 3 }],
    changes: [change(3, 'answered', ['status', 'answer', 'revision', 'updatedAt'])],
  }
  assert.deepEqual(decisionDraftState(answered, 'D-1', 2), { state: 'ended', revision: 2 })
  // 草稿是对着已答复的那一版写的（修改答案）：照常
  assert.deepEqual(decisionDraftState(answered, 'D-1', 3, 3), { state: 'live', revision: 3 })
  const reopened = {
    decisions: [{ id: 'D-1', status: 'open' as const, revision: 4 }],
    changes: [change(4, 'open', ['status', 'answer', 'revision']), ...answered.changes],
  }
  assert.deepEqual(decisionDraftState(reopened, 'D-1', 2), { state: 'live', revision: 4 })
  // 中间改过问题：沿用先确认
  const reworded = {
    ...reopened,
    changes: [change(5, 'open', ['options', 'revision']), ...reopened.changes],
    decisions: [{ id: 'D-1', status: 'open' as const, revision: 5 }],
  }
  assert.deepEqual(decisionDraftState(reworded, 'D-1', 2), { state: 'conflict', revision: 2 })
  // 一直待定、只是版本变了（核对、追问回复）：沿用先确认
  const touched = {
    decisions: [{ id: 'D-1', status: 'open' as const, revision: 3 }],
    changes: [change(3, 'open', ['checked', 'revision'])],
  }
  assert.deepEqual(decisionDraftState(touched, 'D-1', 2), { state: 'conflict', revision: 2 })
  for (const status of ['ignored', 'withdrawn', 'expired'] as const)
    assert.equal(
      decisionDraftState({ decisions: [{ id: 'D-1', status, revision: 3 }], changes: [] }, 'D-1', 2)
        .state,
      'ended',
    )
  assert.equal(decisionDraftState({ decisions: [], changes: [] }, 'D-1', 2).state, 'ended')
})

test('请你做与议题追问草稿：取消、建议已处理是 ended；报告没有结束状态', () => {
  const board = {
    decisions: [],
    changes: [],
    requests: [
      { id: 'R-1', status: 'cancelled' as const, revision: 2 },
      { id: 'R-2', status: 'delivered' as const, revision: 3 },
    ],
    posts: [
      { id: 'R-1', kind: 'request' as const, revision: 2, fields: {} },
      { id: 'R-2', kind: 'request' as const, revision: 3, fields: {} },
      { id: 'P-1', kind: 'report' as const, revision: 1, fields: {} },
      { id: 'S-a', kind: 'suggestion' as const, revision: 1, fields: { status: 'started' } },
    ],
  }
  assert.equal(requestDraftState(board, 'R-1', 1).state, 'ended')
  assert.equal(requestDraftState(board, 'R-2', 3).state, 'live')
  // 在别处交付了：草稿结束；还待办而版本变了：先确认
  assert.equal(requestDraftState(board, 'R-2', 2).state, 'ended')
  assert.equal(
    requestDraftState(
      { ...board, requests: [{ id: 'R-2', status: 'open', revision: 3 }] },
      'R-2',
      2,
    ).state,
    'conflict',
  )
  assert.equal(postDraftState(board, 'R-1', 2).state, 'ended')
  assert.equal(postDraftState(board, 'R-2', 3).state, 'live')
  assert.equal(postDraftState(board, 'P-1', 1).state, 'live')
  assert.equal(postDraftState(board, 'S-a', 1).state, 'ended')
  assert.equal(postDraftState(board, 'P-9', 1).state, 'ended')
})

test('草稿计数：决策在别处答复后计数归零、不随提交发出，卡片据 ended 出提示；重开后恢复可提交', () => {
  const draft = { decisionId: 'D-1', revision: 2, optionId: 'a', text: '同意' }
  const drafts = { decisions: [draft], requests: [], posts: [] }
  const open = {
    decisions: [{ id: 'D-1', status: 'open' as const, revision: 2 }],
    changes: [],
  }
  const before = liveManagerDrafts(open, drafts)
  assert.equal(before.count, 1)
  assert.deepEqual(before.answers, [draft])
  const answered = {
    decisions: [{ id: 'D-1', status: 'answered' as const, revision: 3 }],
    changes: [change(3, 'answered', ['status', 'answer', 'revision'])],
  }
  const after = liveManagerDrafts(answered, drafts)
  assert.equal(after.count, 0)
  assert.deepEqual(after.answers, [])
  assert.equal(after.conflict, false)
  assert.deepEqual([...after.ended.decisions], ['D-1'])
  const reopened = {
    decisions: [{ id: 'D-1', status: 'open' as const, revision: 4 }],
    changes: [change(4, 'open', ['status', 'answer', 'revision']), ...answered.changes],
  }
  const back = liveManagerDrafts(reopened, drafts)
  assert.equal(back.count, 1)
  assert.deepEqual(back.answers, [{ ...draft, revision: 4 }])
  assert.equal(back.conflict, false)
  assert.equal(back.ended.decisions.size, 0)
  // 看板没读到时照旧全算
  assert.equal(liveManagerDrafts(null, drafts).count, 1)
  // 请你做取消、议题追问的建议已处理：同样不计
  const other = liveManagerDrafts(
    {
      decisions: [],
      changes: [],
      requests: [{ id: 'R-1', status: 'cancelled', revision: 2 }],
      posts: [{ id: 'S-a', kind: 'suggestion', revision: 1, fields: { status: 'dismissed' } }],
    },
    {
      decisions: [],
      requests: [{ requestId: 'R-1', revision: 1, delivered: true, text: '' }],
      posts: [{ id: 'S-a', revision: 1, question: '为什么？' }],
    },
  )
  assert.equal(other.count, 0)
  assert.deepEqual([...other.ended.requests], ['R-1'])
  assert.deepEqual([...other.ended.posts], ['S-a'])
})

test('新版本选项和文字草稿都保留并要求确认，已结束仍可查看', () => {
  const draft = { decisionId: 'D-1', revision: 1, optionId: 'a', text: '' }
  const board = { decisions: [{ id: 'D-1', revision: 2, status: 'open' as const }], changes: [] }
  const project = (patch = {}) =>
    liveManagerDrafts(board, {
      decisions: [{ ...draft, ...patch }],
      requests: [],
      posts: [],
    })
  assert.equal(project().count, 1)
  assert.equal(project().conflict, true)
  assert.equal(project({ optionId: null }).count, 0)
  assert.equal(project({ text: '保留说明' }).count, 1)
  assert.equal(project({ text: '保留说明' }).conflict, true)
  assert.equal(project({ question: '待发追问' }).conflict, true)
  const ended = liveManagerDrafts(
    { ...board, decisions: [{ id: 'D-1', revision: 2, status: 'ignored' }] },
    {
      decisions: [draft],
      requests: [],
      posts: [],
    },
  )
  assert.equal(ended.count, 0)
  assert.equal(ended.ended.decisions.has('D-1'), true)
})

test('非待定或已删除的决策不计草稿，同版也不能冒充主动修改答复', () => {
  const draft = { decisionId: 'D-1', revision: 1, optionId: 'a', text: '保留' }
  for (const status of ['answered', 'expired', 'withdrawn', 'ignored'] as const) {
    const board = { decisions: [{ id: 'D-1', status, revision: 1 }], changes: [] }
    const result = liveManagerDrafts(board, { decisions: [draft], requests: [], posts: [] })
    assert.equal(result.count, 0, status)
    assert.equal(result.conflict, false, status)
    assert.deepEqual(result.answers, [])
    assert.equal(result.ended.decisions.has('D-1'), true)
  }
  assert.equal(
    liveManagerDrafts(
      { decisions: [], changes: [] },
      { decisions: [draft], requests: [], posts: [] },
    ).count,
    0,
  )
  assert.equal(draft.text, '保留', '不删除本地内容')
})

test('已答复后仍可主动追问，追问不会恢复同一份草稿里的遗留答案', () => {
  const board = {
    decisions: [{ id: 'D-1', status: 'answered' as const, revision: 2 }],
    changes: [],
  }
  const draft = {
    decisionId: 'D-1',
    revision: 2,
    optionId: 'a',
    text: '旧答案',
    question: '新追问',
  }
  const live = liveManagerDrafts(board, { decisions: [draft], requests: [], posts: [] })
  assert.deepEqual(live.answers, [])
  assert.equal(live.questions.length, 1)
  assert.equal(live.count, 1)
  assert.equal(live.ended.decisions.size, 0)
})
