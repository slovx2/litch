import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Turn } from '../../protocol/src/index.mjs'
import type { ItemView, RequestView } from '../src/model.mjs'
import { peekOf } from '../src/projection/peek.mjs'
import { projectTurn } from '../src/projection/session.mjs'

const peekTurn = (raw: unknown, requests: RequestView[] = []) => {
  const { turn, items } = projectTurn(raw as Turn)
  const byId = new Map<string, ItemView>(items.map((item) => [item.id, item]))
  return peekOf(turn, (id) => byId.get(id), requests)
}

test('回合结束：最后一条有字的回答；失败的回合带原因', () => {
  const done = peekTurn({
    id: 't1',
    status: 'completed',
    items: [
      { type: 'userMessage', id: 'u', content: [{ type: 'text', text: '帮我看看' }] },
      { type: 'agentMessage', id: 'a1', text: '先看一下目录' },
      { type: 'commandExecution', id: 'c', command: 'ls', status: 'completed' },
      { type: 'agentMessage', id: 'a2', text: '  看完了：一切正常。\n' },
      { type: 'agentMessage', id: 'a3', text: '   ' },
    ],
  })
  assert.deepEqual(done, { answer: '看完了：一切正常。', error: null, pending: null })

  const failed = peekTurn({
    id: 't2',
    status: 'failed',
    error: { message: '额度用完了' },
    items: [],
  })
  assert.deepEqual(failed, { answer: null, error: '额度用完了', pending: null })
  assert.deepEqual(
    peekOf(undefined, () => undefined, []),
    {
      answer: null,
      error: null,
      pending: null,
    },
  )
})

test('没打开的会话停下来等人：最后一个还在进行的命令、改动就是要批准的', () => {
  const command = peekTurn({
    id: 't1',
    status: 'inProgress',
    items: [
      { type: 'commandExecution', id: 'c1', command: 'ls', status: 'completed' },
      { type: 'commandExecution', id: 'c2', command: 'rm -rf build', status: 'inProgress' },
    ],
  })
  assert.deepEqual(command.pending, { kind: 'command', text: 'rm -rf build' })
  const files = peekTurn({
    id: 't1',
    status: 'inProgress',
    items: [
      {
        type: 'fileChange',
        id: 'f1',
        status: 'inProgress',
        changes: [
          { path: 'a.ts', kind: { type: 'update' }, diff: '' },
          { path: 'b.ts', kind: { type: 'add' }, diff: '' },
        ],
      },
    ],
  })
  assert.deepEqual(files.pending, { kind: 'fileChange', text: 'a.ts, b.ts' })
})

test('打开着的会话：按等着答复的第一个请求写', () => {
  const approval: RequestView = {
    id: 'r1',
    kind: 'approval',
    subject: 'command',
    itemId: null,
    command: 'npm publish',
    cwd: '/repo',
    reason: null,
    permissions: null,
    tool: null,
    options: [],
  }
  const question: RequestView = {
    id: 'r2',
    kind: 'question',
    itemId: null,
    questions: [
      {
        id: 'q',
        header: '选库',
        question: '用哪个数据库？',
        options: null,
        allowOther: true,
        secret: false,
      },
    ],
  }
  const turn = { id: 't', status: 'running', items: [] }
  assert.deepEqual(peekTurn(turn, [approval, question]).pending, {
    kind: 'command',
    text: 'npm publish',
  })
  assert.deepEqual(peekTurn(turn, [question]).pending, {
    kind: 'question',
    text: '用哪个数据库？',
  })
})
