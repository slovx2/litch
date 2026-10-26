// Litch 替用户发的话（定时任务、子会话的简报、在这里做、litch_sessions.send）在对话里认回来的样子。
// 拼法和设备进程对得上由设备包里的单测守着（session-tree、session-tools、task-scheduler），这里只看投影
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { formatSessionEvent, type ThreadItem } from '../../protocol/src/index.mjs'
import { localUserMessage, projectItem } from '../src/index.mjs'

const user = (text: string) =>
  projectItem({
    type: 'userMessage',
    id: 'u',
    content: [{ type: 'text', text, text_elements: [] }],
  } as unknown as ThreadItem)

const TASK = [
  '[Scheduled task run]',
  'This message was sent automatically by a scheduled task on this device, not typed by a person just now.',
  'Task: 整理日报',
  'Trigger: run now (started by hand)',
  'Scheduled for: 2026-10-26 09:00 (Asia/Shanghai)',
  'Current time: 2026-10-26 09:00 (Asia/Shanghai)',
  'No one is watching this run.',
  'The task instructions follow.',
  '---',
  '把今天的提交整理成日报。\n---\n分仓库写。',
].join('\n')

test('系统消息：定时任务的那条认出任务名、是不是手动、分隔线后面的提示词；text 照旧是全文', () => {
  const item = user(TASK)
  assert.ok(item.kind === 'userMessage')
  assert.equal(item.text, TASK)
  assert.deepEqual(item.system, {
    kind: 'scheduledTask',
    task: '整理日报',
    manual: true,
    prompt: '把今天的提交整理成日报。\n---\n分仓库写。',
  })
})

test('系统消息：“在这里做”前面攒着回报的，回报和卡片各认各的；两种语言的引导语都认', () => {
  const event = formatSessionEvent({
    kind: 'notes',
    notes: [{ threadId: 'c1', title: '子任务', status: 'completed', excerpt: '好了' }],
  })
  const item = user(`${event}在这里做：修侧栏\n\n去掉复古皮肤的前缀。`)
  assert.ok(item.kind === 'userMessage')
  assert.equal(item.event?.notes[0]?.threadId, 'c1')
  assert.deepEqual(item.system, { kind: 'here', title: '修侧栏', prompt: '去掉复古皮肤的前缀。' })
  const english = user('Do it here: Fix sidebar\n\nDrop the prefix.')
  assert.equal(english.kind === 'userMessage' && english.system?.kind, 'here')
  // 本机先显示出来的那条（客户端自己排进输入队列发的）也一样
  const local = localUserMessage(
    'l',
    { text: '在这里做：修侧栏\n\n去掉前缀。', images: [], extras: [] },
    false,
  )
  assert.equal(local.system?.kind, 'here')
})

test('系统消息：子会话的简报认出哪一种、父会话、任务', () => {
  const text = [
    '[Litch] Another session on this device started this one: "主会话" (p1, pi). You cannot see that conversation; the user can open this session and talk to you directly.',
    '',
    'Background:\n这一轮在提速 CI。',
    '',
    'Task: 查构建',
    '',
    '找出最慢的三步。',
    '',
    'When you are done, end your turn with a short summary of the result and anything left open.',
  ].join('\n')
  const item = user(text)
  assert.ok(item.kind === 'userMessage')
  assert.deepEqual(item.system, {
    kind: 'briefing',
    mode: 'fresh',
    parent: { id: 'p1', harness: 'pi', title: '主会话' },
    title: '查构建',
    background: '这一轮在提速 CI。',
    prompt: '找出最慢的三步。',
  })
})

test('系统消息：litch_sessions.send 发来的当成别的会话发来的消息，只留原话，能点回发来的会话', () => {
  const item = user(
    '[Litch] Message from session "主会话" (t-9), not typed by the user:\n\n先跑单测\n\n(To answer, send a message back with litch_sessions.send to thread_id t-9; your reply in this conversation does not reach that session.)',
  )
  assert.ok(item.kind === 'userMessage')
  assert.equal(item.text, '先跑单测')
  assert.deepEqual(item.peer, { name: '主会话', session: null, thread: 't-9', bypass: false })
  assert.equal(item.system, undefined)
  const untitled = user('[Litch] Message from session (t-9), not typed by the user:\n\nhi')
  assert.equal(untitled.kind === 'userMessage' && untitled.peer?.name, null)
})

test('系统消息：格式不全的、用户自己打的照常是用户的话', () => {
  for (const text of [
    '[Scheduled task run]\n没有分隔线',
    '在这里做：只有一行',
    '[Litch] Another session on this device started this one: 坏的',
    '[Litch] Message from session (t-9) hi',
    '帮我看看 [Scheduled task run]',
  ]) {
    const item = user(text)
    assert.ok(item.kind === 'userMessage')
    assert.equal(item.system, undefined, text)
    assert.equal(item.peer, undefined, text)
    assert.equal(item.text, text)
  }
})
