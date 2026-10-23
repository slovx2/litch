// 打 `@` 弹出的单子里“会话”那一组：挑哪些、怎么排、选中后正文里写成什么、删了字就不再带。
// 不起浏览器：session-hits.ts 只有判断。跑法：npm run test --prefix packages/ui。
import assert from 'node:assert/strict'
import { test } from 'node:test'

const { insertMention, keepMentioned, MATCHED_SESSIONS, RECENT_SESSIONS, sessionHits } =
  await import('../src/composer/session-hits.ts')

const one = (id, title, more = {}) => ({
  id,
  title,
  harness: 'claude-code',
  workspace: '',
  workspaceId: null,
  cwd: `/w/${id}`,
  updatedAt: 0,
  ...more,
})

const ids = (list) => list.map((entry) => entry.id)

test('没打字：最近更新的几个，去掉当前会话和已经提到的', () => {
  const all = Array.from({ length: 9 }, (_, at) => one(`s${at}`, `会话${at}`, { updatedAt: at }))
  const got = sessionHits(all, {
    query: '',
    current: 's8',
    workspaceId: null,
    bound: new Set(['s7']),
  })
  assert.equal(got.length, RECENT_SESSIONS)
  assert.deepEqual(ids(got), ['s6', 's5', 's4', 's3', 's2'])
})

test('打了字：按对上的程度排，一样好的同工作区在前、再按最近；打了斜杠一个都不出', () => {
  const all = [
    one('a', '修 CI 缓存', { workspaceId: 'w2', updatedAt: 9 }),
    one('b', '修 CI', { workspaceId: 'w1', updatedAt: 1 }),
    one('c', '写文档', { workspace: '修理铺', updatedAt: 5 }),
    one('d', '别的', { cwd: '/x/修' }),
  ]
  const got = sessionHits(all, { query: '修', current: null, workspaceId: 'w1', bound: new Set() })
  // 都是开头对上的：同工作区的 b 先，再按最近（a、c），d 只有目录末段对上，也是开头
  assert.deepEqual(ids(got), ['b', 'a', 'c', 'd'])
  assert.deepEqual(
    sessionHits(all, { query: 'src/', current: null, workspaceId: null, bound: new Set() }),
    [],
  )
  const many = Array.from({ length: 20 }, (_, at) => one(`m${at}`, `任务${at}`))
  assert.equal(
    sessionHits(many, { query: '任务', current: null, workspaceId: null, bound: new Set() }).length,
    MATCHED_SESSIONS,
  )
})

test('选中：@查询 换成 @[标题] 加一个空格；后面本来是空白就不加', () => {
  assert.deepEqual(insertMention('看 @修', { start: 2, end: 4 }, '修 CI'), {
    text: '看 @[修 CI] ',
    caret: 10,
  })
  assert.deepEqual(insertMention('@修 的结论', { start: 0, end: 2 }, '修 CI'), {
    text: '@[修 CI] 的结论',
    caret: 7,
  })
})

test('删了字就不带：正文里没有 @[标题] 的会话丢掉，都在的返回原数组', () => {
  const extras = [
    { kind: 'session', threadId: 'a', title: '甲' },
    { kind: 'file', name: 'x', path: 'x' },
    { kind: 'session', threadId: 'b', title: '乙' },
  ]
  assert.equal(keepMentioned(extras, '@[甲] 和 @[乙]'), extras)
  assert.deepEqual(
    keepMentioned(extras, '只剩 @[乙]').map((extra) => extra.kind + (extra.threadId ?? '')),
    ['file', 'sessionb'],
  )
})
