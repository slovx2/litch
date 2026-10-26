// 会话的系统通知发不发、发哪一种（src/notify/session-notice.ts）：回合结束、出错、停下来等审批或回答才发；
// 定时任务跑出来的不发（TaskNotices 发）；子会话照发；别的应用派出来的会话在侧栏里藏着时什么都不发（照 Claude 桌面端）。
// 正文怎么写（noticeBodyOf）：回答去掉 Markdown 掐到 100 字，出错写原因，审批写要做的事，提问写问题。
// 跑法：npm run test --prefix packages/ui（Node 直接读 .ts，不用先构建）。
import assert from 'node:assert/strict'
import { test } from 'node:test'

const { clipText, noticeBodyOf, plainText, sessionNoticeOf, slotOf } = await import(
  '../src/notify/session-notice.ts'
)

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

test('定时任务跑出来的不发；子会话照发；藏着的派出会话什么都不发，显示出来以后照发', () => {
  const run = { kind: 'run', taskId: 't', runId: 'r', trigger: 'manual', scheduledFor: 0 }
  assert.equal(sessionNoticeOf(running, session({ task: run })), null)
  const child = { lineage: { parentId: 'p' } }
  assert.equal(sessionNoticeOf({ ...running, ...child }, session(child)), 'done')
  assert.equal(
    sessionNoticeOf({ ...running, ...child }, session({ ...child, status: 'waiting' })),
    'approval',
  )
  const native = { nativeLineage: { app: 'claude-desktop', parentId: null, createdAt: 0 } }
  const waiting = session({ ...native, status: 'waiting', waitingFor: 'answer' })
  assert.equal(sessionNoticeOf({ ...running, ...native }, session(native), true), null)
  assert.equal(sessionNoticeOf({ ...running, ...native }, waiting, true), null)
  assert.equal(sessionNoticeOf({ ...running, ...native }, session(native), false), 'done')
  assert.equal(sessionNoticeOf({ ...running, ...native }, waiting, false), 'answer')
})

test('每个会话两条：回合结束、出错占一条，审批、回答占另一条', () => {
  assert.deepEqual(['done', 'failed', 'approval', 'answer'].map(slotOf), [
    'turn',
    'turn',
    'ask',
    'ask',
  ])
})

const say = (text) => (typeof text === 'string' ? text : `[${text.key}]`)
const peek = (over = {}) => ({ answer: null, error: null, pending: null, ...over })

test('回合结束写回答的开头：去掉 Markdown，空白并成一个，掐到 100 字', () => {
  assert.equal(
    plainText(
      '## 结果\n\n- 改了 **两处**，见 [说明](https://x.y)\n```ts\nconst a = 1\n```\n`npm test` 过了',
    ),
    '结果 改了 两处，见 说明 const a = 1 npm test 过了',
  )
  const long = '好'.repeat(150)
  assert.equal(clipText(long), `${'好'.repeat(99)}…`)
  assert.equal(clipText('😀'.repeat(100)), '😀'.repeat(100), '按字数，不按 UTF-16 单元')
  assert.deepEqual(noticeBodyOf('done', peek({ answer: '**完成了**\n\n一切正常' }), say), {
    key: 'plain',
    text: '完成了 一切正常',
  })
  assert.equal(noticeBodyOf('done', peek({ answer: '```\n```' }), say), null)
  assert.equal(noticeBodyOf('done', null, say), null, '要不到：退回不带内容的那句')
})

test('出错写原因，审批写要做的事，提问写问题本身；对不上的不写', () => {
  assert.deepEqual(noticeBodyOf('failed', peek({ error: '额度\n用完了' }), say), {
    key: 'notify.session.failedWith',
    text: '额度 用完了',
  })
  assert.equal(noticeBodyOf('failed', peek({ answer: '答了一半' }), say), null)
  const command = peek({ pending: { kind: 'command', text: 'rm -rf build' } })
  assert.deepEqual(noticeBodyOf('approval', command, say), {
    key: 'notify.session.run',
    text: 'rm -rf build',
  })
  const tool = peek({ pending: { kind: 'tool', text: { key: 'tool.x' } } })
  assert.deepEqual(noticeBodyOf('approval', tool, say), {
    key: 'notify.session.tool',
    text: '[tool.x]',
  })
  const question = peek({ pending: { kind: 'question', text: '用 **哪个** 库？' } })
  assert.deepEqual(noticeBodyOf('answer', question, say), { key: 'plain', text: '用 哪个 库？' })
  assert.equal(noticeBodyOf('answer', command, say), null)
  assert.equal(noticeBodyOf('approval', question, say), null)
})
