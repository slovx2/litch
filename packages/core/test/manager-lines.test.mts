import assert from 'node:assert/strict'
import { test } from 'node:test'
import { type ManagerLineView, managerLineRows } from '../src/index.mjs'

const line = (threadId: string, patch: Partial<ManagerLineView> = {}): ManagerLineView => ({
  threadId,
  parentThreadId: 'm',
  title: threadId,
  harness: 'claude',
  cwd: '/w',
  status: 'idle',
  running: false,
  startedAt: 1000,
  elapsedSeconds: null,
  branch: null,
  ahead: null,
  merged: null,
  worktreeExists: null,
  report: null,
  unverified: [],
  ...patch,
})

test('工作线：等人与出错在前，运行中、后台、空闲依次，同组最近动静新的在前；已合并另成一组', () => {
  const lines = [
    line('idle-new', { startedAt: 9000 }),
    line('run-old', { status: 'running', startedAt: 2000 }),
    line('merged', { merged: true, report: { text: '好了', at: 8000 } }),
    line('wait', { startedAt: 1000 }),
    line('run-new', { status: 'running', report: { text: '进展', at: 7000 } }),
    line('bg', { startedAt: 3000 }),
    line('merged-old', { merged: true }),
  ]
  const summaries: Record<
    string,
    {
      status: 'idle' | 'running' | 'waiting' | 'error'
      background?: { running: number }
      updatedAt: number
    }
  > = {
    wait: { status: 'waiting', updatedAt: 1500 },
    bg: { status: 'idle', background: { running: 1 }, updatedAt: 3500 },
  }
  const { active, ended } = managerLineRows(lines, (id) => summaries[id] as never)
  assert.deepEqual(
    active.map((row) => [row.line.threadId, row.state]),
    [
      ['wait', 'waiting'],
      ['run-new', 'running'],
      ['run-old', 'running'],
      ['bg', 'background'],
      ['idle-new', 'idle'],
    ],
  )
  assert.equal(active[0]?.at, 1500, '最近动静取回报、会话更新、开线中最晚的')
  assert.deepEqual(
    ended.map((row) => row.line.threadId),
    ['merged', 'merged-old'],
  )
})

test('工作线：会话摘要比看板的线状态新，以摘要为准', () => {
  const { active } = managerLineRows(
    [line('a', { status: 'running', running: true })],
    () => ({ status: 'error', updatedAt: 5 }) as never,
  )
  assert.equal(active[0]?.state, 'error')
})
