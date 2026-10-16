import assert from 'node:assert/strict'
import test from 'node:test'
import { backgroundTerminals, paginateBackgroundTerminals } from '../src/background-terminals.mjs'
import { ProtocolError } from '../src/protocol-contract.mjs'
import type { ThreadItem } from '../src/types.mjs'

const shells = [
  { taskId: 'task-b', toolUseId: 'toolu_b', command: 'sleep 2', seq: 1 },
  { taskId: 'task-a', toolUseId: 'toolu_a', command: 'sleep 1', seq: 0 },
  { taskId: 'task-c', toolUseId: null, command: '', seq: 2 },
]
const items = [
  { type: 'commandExecution', id: 'item-a', processId: 'claude:toolu_a' },
] as unknown as ThreadItem[]

test('后台终端按启动顺序映射到 Bash 条目，缺少条目时回退到工具调用或任务标识', () => {
  const listed = backgroundTerminals(shells, '/work', items)
  assert.deepEqual(
    listed.map((entry) => [entry.taskId, entry.terminal.itemId, entry.terminal.processId]),
    [
      ['task-a', 'item-a', 'claude:toolu_a'],
      ['task-b', 'toolu_b', 'claude:toolu_b'],
      ['task-c', 'task-c', 'claude-task:task-c'],
    ],
  )
  assert.deepEqual(listed[0]?.terminal, {
    itemId: 'item-a',
    processId: 'claude:toolu_a',
    command: 'sleep 1',
    cwd: '/work',
    osPid: null,
    cpuPercent: null,
    rssKb: null,
  })
})

test('后台终端分页与原生一致：limit 至少为 1，cursor 为上一页最后一项，失效 cursor 返回空页', () => {
  const terminals = backgroundTerminals(shells, '/work', items).map((entry) => entry.terminal)
  const ids = (page: { data: Array<{ processId: string }> }) => page.data.map((t) => t.processId)
  const all = paginateBackgroundTerminals(terminals, null, null)
  assert.equal(all.data.length, 3)
  assert.equal(all.nextCursor, null)
  const first = paginateBackgroundTerminals(terminals, undefined, 0)
  assert.deepEqual(ids(first), ['claude:toolu_a'])
  assert.equal(first.nextCursor, 'claude:toolu_a')
  const second = paginateBackgroundTerminals(terminals, first.nextCursor, 1)
  assert.deepEqual(ids(second), ['claude:toolu_b'])
  assert.equal(second.nextCursor, 'claude:toolu_b')
  const last = paginateBackgroundTerminals(terminals, second.nextCursor, 5)
  assert.deepEqual(ids(last), ['claude-task:task-c'])
  assert.equal(last.nextCursor, null)
  assert.deepEqual(paginateBackgroundTerminals(terminals, 'claude:gone', 5), {
    data: [],
    nextCursor: null,
  })
  assert.deepEqual(paginateBackgroundTerminals([], null, null), { data: [], nextCursor: null })
  assert.throws(() => paginateBackgroundTerminals(terminals, 1, null), ProtocolError)
  assert.throws(() => paginateBackgroundTerminals(terminals, null, -1), ProtocolError)
})
