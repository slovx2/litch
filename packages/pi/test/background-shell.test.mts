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
  withStopNotice,
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

test('用户停的：不唤醒，下一轮开头交给模型一次；模型停的、模型自己看过的不交', async () => {
  const { root, shells, finished, cleanup } = rig()
  const start = (command: string) =>
    runShellTool(shells, { threadId: 't1', cwd: root, tool: 'start', arguments: { command } })
  const waitEnd = async () => {
    for (let i = 0; i < 100 && shells.runningCount('t1') > 0; i++)
      await new Promise((done) => setTimeout(done, 50))
  }
  try {
    await start('sleep 60')
    await start('sleep 60')
    await start('sleep 60')
    assert.equal(shells.takeStopNotice('t1'), null)
    assert.equal(shells.stop('t1', 'shell-1', 'user'), true)
    assert.equal(shells.stop('t1', 'shell-2', 'model'), true)
    assert.equal(shells.stop('t1', 'shell-3', 'user'), true)
    await waitEnd()
    await new Promise((done) => setTimeout(done, 400))
    assert.equal(finished.length, 0)
    // 模型自己 read 过 shell-3：它知道了，不再说
    const read = await runShellTool(shells, {
      threadId: 't1',
      cwd: root,
      tool: 'read',
      arguments: { id: 'shell-3' },
    })
    assert.match(read.text, /stopped by the user/)
    const notice = shells.takeStopNotice('t1')
    assert.ok(notice)
    assert.match(notice, /^<litch-background-notice>/)
    assert.match(
      notice,
      /Background task shell-1 was stopped by the user after \d+s\. Command: sleep 60/,
    )
    assert.doesNotMatch(notice, /shell-2|shell-3/)
    // 不是唤醒那段：重读历史时不会被当成一轮后台唤醒
    assert.equal(isShellEventText(notice), false)
    assert.equal(isShellEventText(withStopNotice('hi', notice)), false)
    assert.equal(withStopNotice('hi', notice), `hi\n\n${notice}`)
    assert.equal(withStopNotice('hi', null), 'hi')
    // 只交一次
    assert.equal(shells.takeStopNotice('t1'), null)
    // list 过的也算看到了
    await start('sleep 60')
    shells.stop('t1', 'shell-4', 'user')
    await waitEnd()
    await runShellTool(shells, { threadId: 't1', cwd: root, tool: 'list', arguments: {} })
    assert.equal(shells.takeStopNotice('t1'), null)
    // 会话删掉了：不留
    await start('sleep 60')
    shells.stop('t1', 'shell-5', 'user')
    await waitEnd()
    shells.forget('t1')
    assert.equal(shells.takeStopNotice('t1'), null)
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

const alive = (pid: number | null): boolean => {
  if (pid === null) return false
  try {
    process.kill(-pid, 0)
    return true
  } catch {
    return false
  }
}
const pause = (ms: number) => new Promise((done) => setTimeout(done, ms))

test('命令把进程放到后台（x &、输出重定向走的守护进程）：shell 退出了任务还算在跑，组里都结束才算结束', async () => {
  const { root, shells, finished, nextFinish, cleanup } = rig()
  try {
    // 放到后台、输出还走管道的：等它跑完，输出收得到
    const late = shells.start('t1', { command: '(sleep 0.6; echo late) & echo early' }, root)
    // 输出重定向走、一直不结束的：停的时候连它一起停
    const daemon = shells.start('t1', { command: 'sleep 60 > /dev/null 2>&1 & echo started' }, root)
    await pause(400)
    assert.equal(shells.get('t1', late.id)?.status, 'running')
    assert.equal(shells.get('t1', daemon.id)?.status, 'running')
    assert.equal(finished.length, 0, 'shell 退出时没有当成结束去唤醒')
    const finishing = nextFinish()
    await finishing
    assert.equal(shells.get('t1', late.id)?.status, 'completed')
    const read = await shells.read('t1', late.id)
    assert.match(read.output, /early[\s\S]*late/)
    assert.deepEqual(
      finished.flat().map((task) => task.id),
      [late.id],
    )
    assert.ok(alive(daemon.pid))
    assert.equal(shells.stop('t1', daemon.id, 'user'), true)
    for (let i = 0; i < 100 && shells.runningCount('t1') > 0; i++) await pause(50)
    assert.equal(shells.get('t1', daemon.id)?.status, 'stopped')
    assert.equal(alive(daemon.pid), false, '组里放到后台的那个也停了')
  } finally {
    await cleanup()
  }
})

test('运行时退出：shell 已经退出、组里还有活的也一起结束，不白等宽限', async () => {
  const { root, shells, cleanup } = rig()
  try {
    const daemon = shells.start('t1', { command: 'sleep 60 > /dev/null 2>&1 &' }, root)
    await pause(300)
    assert.equal(shells.get('t1', daemon.id)?.status, 'running')
    const started = Date.now()
    await shells.close()
    assert.ok(Date.now() - started < 2_000, `close 用了 ${Date.now() - started}ms`)
    assert.equal(shells.get('t1', daemon.id)?.stoppedBy, 'shutdown')
    assert.equal(alive(daemon.pid), false)
  } finally {
    await cleanup()
  }
})

test('日志写不进去（目录没了）：运行时不退出，任务照常结束、输出照样计数', async () => {
  const { root, shells, nextFinish, cleanup } = rig()
  try {
    const finishing = nextFinish()
    const task = shells.start('t1', { command: 'echo lost' }, root)
    // 日志文件是异步打开的：这时把目录删掉，打开就失败
    rmSync(join(root, 'logs', 't1'), { recursive: true, force: true })
    await finishing
    assert.equal(shells.get('t1', task.id)?.status, 'completed')
    assert.ok((shells.get('t1', task.id)?.totalBytes ?? 0) > 0)
  } finally {
    await cleanup()
  }
})
