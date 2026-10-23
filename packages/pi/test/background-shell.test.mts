// 后台 shell 的共享部分（packages/shared/src/background-shell.mts）：起、读、停、集合、自己退出时的唤醒批次、
// 挤掉旧记录、运行时退出。Pi、OpenCode、ACP 三个入口用的是同一份，放在这里测一遍。
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import {
  BackgroundShells,
  backgroundShellEnabled,
  formatShellEvent,
  isShellEventText,
  runShellTool,
  type ShellTask,
} from '../../shared/src/background-shell.mjs'

function rig() {
  const root = mkdtempSync(join(tmpdir(), 'litch-bg-shell-'))
  const changed: string[] = []
  const finished: ShellTask[][] = []
  let waiting: (() => void) | null = null
  const shells = new BackgroundShells(join(root, 'logs'), {
    changed: (threadId) => changed.push(threadId),
    finished: (_threadId, tasks) => {
      finished.push(tasks)
      waiting?.()
    },
  })
  const nextFinish = () =>
    new Promise<void>((done) => {
      waiting = done
    })
  const cleanup = async () => {
    await shells.close()
    rmSync(root, { recursive: true, force: true })
  }
  return { root, shells, changed, finished, nextFinish, cleanup }
}

test('开关：只认 1 和 0，没写过按默认', () => {
  assert.equal(backgroundShellEnabled({ CHA_BACKGROUND_SHELL: '1' }), true)
  assert.equal(backgroundShellEnabled({ CHA_BACKGROUND_SHELL: '0' }), false)
})

test('起一个命令：回合外跑完，集合里记 completed，交给 finished 唤醒，读得到输出', async () => {
  const { root, shells, changed, finished, nextFinish, cleanup } = rig()
  try {
    const done = nextFinish()
    const started = await runShellTool(shells, {
      threadId: 't1',
      cwd: root,
      tool: 'start',
      arguments: { command: 'echo hello; echo oops 1>&2; exit 0', title: '打招呼' },
      itemId: 'call-1',
      turnId: 'turn-1',
    })
    assert.equal(started.isError, false, started.text)
    assert.match(started.text, /Started background task shell-1/)
    assert.equal(shells.collection('t1')[0]?.status, 'running')
    assert.equal(shells.terminals('t1').length, 1)
    await done
    const [task] = shells.collection('t1')
    assert.equal(task?.status, 'completed')
    assert.equal(task?.title, '打招呼')
    assert.equal(task?.itemId, 'call-1')
    assert.equal(task?.turnId, 'turn-1')
    assert.ok(task?.endedAt)
    assert.equal(finished.length, 1)
    assert.ok(changed.length >= 2)
    const read = await runShellTool(shells, {
      threadId: 't1',
      cwd: root,
      tool: 'read',
      arguments: { id: 'shell-1' },
    })
    assert.match(read.text, /completed \(exit code 0\)/)
    assert.match(read.text, /hello/)
    assert.match(read.text, /oops/)
    const event = await formatShellEvent(finished[0] ?? [])
    assert.ok(isShellEventText(event))
    assert.match(event, /shell-1 exited: completed/)
    assert.match(event, /hello/)
    // 别的会话看不到
    const other = await runShellTool(shells, {
      threadId: 't2',
      cwd: root,
      tool: 'read',
      arguments: { id: 'shell-1' },
    })
    assert.equal(other.isError, true)
  } finally {
    await cleanup()
  }
})

test('退出码非零记 failed；read 的 wait_seconds 等到它结束就回', async () => {
  const { root, shells, cleanup } = rig()
  try {
    await runShellTool(shells, {
      threadId: 't1',
      cwd: root,
      tool: 'start',
      arguments: { command: 'sleep 0.3; echo late; exit 3' },
    })
    const began = Date.now()
    const read = await runShellTool(shells, {
      threadId: 't1',
      cwd: root,
      tool: 'read',
      arguments: { id: 'shell-1', wait_seconds: 30 },
    })
    assert.ok(Date.now() - began < 10_000)
    assert.match(read.text, /failed \(exit code 3\)/)
    assert.match(read.text, /late/)
  } finally {
    await cleanup()
  }
})

test('模型停的、用户停的记 stopped，不交给 finished；连它起的子进程一起停', async () => {
  const { root, shells, finished, cleanup } = rig()
  try {
    await runShellTool(shells, {
      threadId: 't1',
      cwd: root,
      tool: 'start',
      arguments: { command: 'sleep 60 & sleep 60; wait' },
    })
    await runShellTool(shells, {
      threadId: 't1',
      cwd: root,
      tool: 'start',
      arguments: { command: 'sleep 60' },
    })
    const stopped = await runShellTool(shells, {
      threadId: 't1',
      cwd: root,
      tool: 'stop',
      arguments: { id: 'shell-1' },
    })
    assert.match(stopped.text, /Stopping shell-1/)
    assert.equal(shells.stopThread('t1', 'user'), 1)
    const waitEnd = async () => {
      for (let i = 0; i < 100 && shells.runningCount('t1') > 0; i++)
        await new Promise((done) => setTimeout(done, 50))
    }
    await waitEnd()
    const tasks = Object.fromEntries(
      shells.list('t1').map((task) => [task.id, [task.status, task.stoppedBy]]),
    )
    assert.deepEqual(tasks, { 'shell-1': ['stopped', 'model'], 'shell-2': ['stopped', 'user'] })
    await new Promise((done) => setTimeout(done, 400))
    assert.equal(finished.length, 0)
    const list = await runShellTool(shells, {
      threadId: 't1',
      cwd: root,
      tool: 'list',
      arguments: {},
    })
    assert.match(list.text, /stopped by you/)
    assert.match(list.text, /stopped by the user/)
  } finally {
    await cleanup()
  }
})

test('参数不对、目录不存在按失败答', async () => {
  const { root, shells, cleanup } = rig()
  try {
    const empty = await runShellTool(shells, {
      threadId: 't1',
      cwd: root,
      tool: 'start',
      arguments: {},
    })
    assert.equal(empty.isError, true)
    const missing = await runShellTool(shells, {
      threadId: 't1',
      cwd: root,
      tool: 'start',
      arguments: { command: 'true', cwd: 'nope/not-here' },
    })
    assert.equal(missing.isError, true)
    assert.match(missing.text, /does not exist/)
    const unknown = await runShellTool(shells, {
      threadId: 't1',
      cwd: root,
      tool: 'nope',
      arguments: {},
    })
    assert.equal(unknown.isError, true)
  } finally {
    await cleanup()
  }
})

test('运行时退出：在跑的整组结束、记 stopped、不唤醒；删会话连日志一起删', async () => {
  const { root, shells, finished, cleanup } = rig()
  try {
    const task = shells.start('t1', { command: 'sleep 60' }, root)
    const gone = shells.start('t2', { command: 'echo bye' }, root)
    await new Promise((done) => setTimeout(done, 500))
    shells.forget('t2')
    assert.equal(existsSync(gone.log), false)
    assert.deepEqual(shells.list('t2'), [])
    await shells.close()
    for (let i = 0; i < 40 && task.status === 'running'; i++)
      await new Promise((done) => setTimeout(done, 50))
    assert.equal(task.status, 'stopped')
    assert.equal(task.stoppedBy, 'shutdown')
    assert.equal(
      finished.flat().some((t) => t.id === task.id),
      false,
    )
    assert.throws(() => shells.start('t1', { command: 'true' }, root), /shutting down/)
  } finally {
    await cleanup()
  }
})
