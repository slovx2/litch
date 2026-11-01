import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Turn } from '../../protocol/src/index.mjs'
import { formatSessionEvent } from '../../protocol/src/session-tree.mjs'
import { recoverMessage, restartMessage } from '../../protocol/src/system-messages.mjs'
import { commentsBlock } from '../src/projection/comments.mjs'
import { inputHistory } from '../src/projection/input-history.mjs'
import { projectTurn } from '../src/projection/session.mjs'
import { agentText, turn, userText } from './fixtures.mjs'

function history(turns: Turn[]): string[] {
  const projected = turns.map((value) => projectTurn(value))
  const items = new Map(
    projected.flatMap((value) => value.items.map((item) => [item.id, item] as const)),
  )
  return inputHistory(
    projected.map((value) => value.turn),
    (id) => items.get(id),
  )
}

test('历史排除收件箱和会话通信，仍保留同回合中的用户输入', () => {
  const peer = {
    ...userText('peer', '收件箱内容'),
    litchPeer: { name: '同事', session: 's', mode: 'bypass' },
  }
  const message = '[Litch] Message from session (other), not typed by the user:\n\n会话发来的话'
  assert.deepEqual(
    history([
      turn('t', [
        userText('u', '用户原话'),
        peer,
        userText('send', message),
        userText('next', '用户插话'),
      ]),
    ]),
    ['用户原话', '用户插话'],
  )
})

test('经理事件和子会话回报不进历史，附带的用户正文仍可回忆', () => {
  const events = [
    formatSessionEvent({
      kind: 'manager-open',
      notes: [],
      manager: { managerId: 'm', text: '开始工作' },
    }),
    formatSessionEvent({ kind: 'notes', notes: [] }),
    formatSessionEvent({ kind: 'wake', notes: [] }),
    formatSessionEvent({ kind: 'remind', notes: [] }),
  ]
  assert.deepEqual(
    history(
      events.map((event, i) =>
        turn(String(i), [userText('event', event), userText('mixed', `${event}\n用户正文 ${i}`)]),
      ),
    ),
    events.map((_, i) => `用户正文 ${i}`),
  )
})

test('定时任务与重启恢复提示词不进历史，系统回合里的后续插话和用户队列保留', () => {
  const scheduled = '[Scheduled task run]\nTask: 日报\nTrigger: schedule\n---\n整理日报'
  const restart = turn('restart', [
    userText('r', restartMessage('11111111-1111-1111-1111-111111111111')),
    userText('recover', recoverMessage('继续')),
  ])
  // 使用真实系统消息拼法；按条目来源过滤，不按整个回合删除。
  const scheduledTurn = {
    ...turn('schedule', [userText('s', scheduled), userText('u', '调整日报')]),
    litchOrigin: 'schedule',
  }
  const background = {
    ...turn('background', [userText('u', '后台插话')]),
    litchOrigin: 'backgroundTask',
  }
  const native = {
    ...turn('native', [agentText('a', '后台已完成'), userText('u', '原生后台插话')]),
    litchOrigin: 'backgroundTask',
  }
  const queued = { ...turn('queue', [userText('u', '排队输入')]), litchOrigin: 'queue' }
  const goal = {
    ...turn('goal', [userText('continue', '继续目标'), userText('u', '目标插话')]),
    litchOrigin: 'goal',
  }
  assert.deepEqual(history([restart, scheduledTurn, background, native, queued, goal]), [
    '调整日报',
    '后台插话',
    '原生后台插话',
    '排队输入',
    '目标插话',
  ])
})

test('正文保持空白和 Markdown，忽略空消息、评论注入，并合并相邻重复输入', () => {
  const block = commentsBlock([{ kind: 'comment', itemId: 'a', quote: '引用', note: '评论' }])
  assert.deepEqual(
    history([
      turn('t', [
        userText('a', ''),
        userText('b', block),
        userText('c', `${block}\n\n  **正文**`),
        userText('d', '  **正文**'),
        userText('e', '最后\n一行'),
      ]),
    ]),
    ['  **正文**', '最后\n一行'],
  )
})
