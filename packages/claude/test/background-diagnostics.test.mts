import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { BackgroundTaskTracker, backgroundDigest } from '../src/background-tasks.mjs'

// 后台任务的诊断（debug.jsonl）：电平信号里消失的、消失后又回来的、CLI 退出收掉的各记一行，
// 摘要只有标识、种类、状态，不带标题（标题是命令）

const level = (tasks: Array<Record<string, unknown>>) => ({
  type: 'system',
  subtype: 'background_tasks_changed',
  tasks,
})

const flushed = () => new Promise((resolve) => setImmediate(resolve))

test('BG-DIAG-001 电平信号漏报：消失记 levelDropped，回来记 reappeared，CLI 退出记 closeAll', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'bg-diag-'))
  const file = join(dir, 'debug.jsonl')
  process.env.CHA_CLAUDE_DEBUG_LOG = file
  try {
    const tracker = new BackgroundTaskTracker(() => 1_000)
    const shell = { task_id: 'b1', task_type: 'local_bash', description: 'secret command text' }
    tracker.apply('t', level([shell]), 'turn-1')
    tracker.apply('t', level([]), 'turn-2')
    tracker.apply('t', level([shell]), 'turn-2')
    tracker.closeAll('t')
    await flushed()
    const lines = readFileSync(file, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .filter((entry) => String(entry.event).startsWith('background.'))
    assert.deepEqual(
      lines.map((entry) => entry.event),
      ['background.levelDropped', 'background.reappeared', 'background.closeAll'],
    )
    assert.equal(lines[0]?.taskId, 'b1')
    assert.equal(lines[0]?.turnId, 'turn-2')
    assert.equal(lines[1]?.was, 'completed')
    assert.equal(JSON.stringify(lines).includes('secret command text'), false)
  } finally {
    delete process.env.CHA_CLAUDE_DEBUG_LOG
    rmSync(dir, { recursive: true, force: true })
  }
})

test('BG-DIAG-002 集合摘要：在跑几个、一共几个、前 10 个的标识种类状态，不带标题', () => {
  const tasks = Array.from({ length: 12 }, (_, index) => ({
    id: `b${index}`,
    kind: 'shell' as const,
    title: 'secret command text',
    status: index < 2 ? ('running' as const) : ('completed' as const),
  }))
  const digest = backgroundDigest(tasks)
  assert.equal(digest.running, 2)
  assert.equal(digest.total, 12)
  assert.equal(digest.tasks.length, 10)
  assert.deepEqual(digest.tasks[0], { id: 'b0', kind: 'shell', status: 'running' })
  assert.equal(JSON.stringify(digest).includes('secret'), false)
})
