// 会话的系统通知发不发、发哪一种（src/notify/session-notice.ts）：回合结束、出错、停下来等审批或回答才发；
// 定时任务跑出来的不发（TaskNotices 发），子会话、别的应用派出来的会话回合结束不发、要人处理照发。
// 跑法：npm run test --prefix packages/ui（Node 直接读 .ts，不用先构建）。
import assert from 'node:assert/strict'
import { test } from 'node:test'

const { sessionNoticeOf } = await import('../src/notify/session-notice.ts')

const session = (over = {}) => ({
  id: 's',
  status: 'idle',
  waitingFor: null,
  task: null,
  lineage: null,
  nativeLineage: null,
  ...over,
})
const running = session({ status: 'running' })

test('回合结束、出错、要审批、要回答各是一种；别的变化不发', () => {
  assert.equal(sessionNoticeOf(running, session()), 'done')
  assert.equal(sessionNoticeOf(running, session({ status: 'error' })), 'failed')
  assert.equal(
    sessionNoticeOf(running, session({ status: 'waiting', waitingFor: 'approval' })),
    'approval',
  )
  assert.equal(
    sessionNoticeOf(running, session({ status: 'waiting', waitingFor: 'answer' })),
    'answer',
  )
  // 一直在等同一件事（标题改了之类）：不再发
  const waiting = session({ status: 'waiting', waitingFor: 'approval' })
  assert.equal(sessionNoticeOf(waiting, { ...waiting, title: 'x' }), null)
  // 答完接着跑、闲着的会话标成已读：不发
  assert.equal(sessionNoticeOf(waiting, running), null)
  assert.equal(sessionNoticeOf(session(), session({ unread: false })), null)
  // 刚出现的会话不发
  assert.equal(sessionNoticeOf(undefined, session()), null)
})

test('定时任务跑出来的不发；子会话回合结束不发，要人处理照发', () => {
  const run = { kind: 'run', taskId: 't', runId: 'r', trigger: 'manual', scheduledFor: 0 }
  assert.equal(sessionNoticeOf(running, session({ task: run })), null)
  const child = { lineage: { parentId: 'p' } }
  assert.equal(sessionNoticeOf({ ...running, ...child }, session(child)), null)
  assert.equal(
    sessionNoticeOf({ ...running, ...child }, session({ ...child, status: 'waiting' })),
    'approval',
  )
  const native = { nativeLineage: { app: 'claude-desktop', parentId: null, createdAt: 0 } }
  assert.equal(sessionNoticeOf({ ...running, ...native }, session(native)), null)
})
