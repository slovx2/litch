// litch_machine 的 exec、process 和进程表：对着假机器（machine-kit.test.mts），时钟是假的。
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { MACHINE_LIMITS } from '../../protocol/src/client-tools-machine.mjs'
import { createMachineExecutor } from '../src/device/machine/executor.mjs'
import { OWNER_AWAY_MS } from '../src/device/machine/processes.mjs'
import { fakeClock } from './helpers.mjs'
import { FakeMachine, fakeContext, later, textOf } from './machine-kit.test.mjs'

const flush = async (rounds = 8) => {
  for (let at = 0; at < rounds; at++) await later()
}

function world(denied: string[] = []) {
  const time = fakeClock()
  const desktop = new FakeMachine('desktop', 'desktop')
  const executor = createMachineExecutor({ clock: time.clock, random: () => 0.5 })
  const ctx = fakeContext([desktop], { denied })
  return { time, desktop, executor, ...ctx }
}

test('exec：跑完回退出码和合并的输出，进程号那一行摘掉，审批按 mutate 问一次，记一条', async () => {
  const { desktop, executor, context, asks, logs } = world()
  let changes = 0
  executor.onProcessesChanged(() => changes++)
  desktop.onExec = (proc) => {
    proc.emit('stdout', 'hello ')
    proc.emit('stderr', 'warn\n')
    proc.emit('stdout', 'world\n')
    proc.exit(3)
  }
  const response = await executor.call('exec', { command: 'echo hi', cwd: '~' }, context)
  assert.equal(response.success, true)
  const text = textOf(response)
  assert.match(text, /exit_code: 3/)
  assert.match(text, /hello warn\nworld/)
  assert.doesNotMatch(text, /litch-pid/)
  assert.equal(asks.length, 1)
  assert.equal(asks[0]?.class, 'mutate')
  assert.deepEqual(
    { action: asks[0]?.ask.action, command: asks[0]?.ask.command, cwd: asks[0]?.ask.cwd },
    { action: 'exec', command: 'echo hi', cwd: '/Users/song' },
  )
  const proc = desktop.execs[0]
  assert.deepEqual(proc?.command.slice(3), ['/bin/zsh', 'echo hi'])
  assert.equal(proc?.cwd, '/Users/song')
  // 没给 stdin、也不先回：标准输入起来就关
  assert.equal(proc?.stdinClosed, true)
  assert.deepEqual(logs, [{ tool: 'exec', summary: 'echo hi', result: 'ok', flagged: false }])
  assert.deepEqual(executor.processes(), [])
  assert.equal(changes, 2)
  // 进程收尾之后不再收这台机器的通知
  assert.equal(desktop.listeners, 0)
})

test('exec：输出超过上限掐掉中间，留头留尾并写明省了多少字节', async () => {
  const { desktop, executor, context } = world()
  const big = `HEAD${'x'.repeat(100_000)}TAIL`
  desktop.onExec = (proc) => {
    proc.emit('stdout', big)
    proc.exit(0)
  }
  const text = textOf(await executor.call('exec', { command: 'cat big' }, context))
  assert.match(text, /^output:\nHEAD/m)
  assert.match(text, /TAIL$/)
  const omitted = Number(/\[\.\.\. (\d+) bytes omitted \.\.\.\]/.exec(text)?.[1])
  assert.ok(omitted > 0)
  assert.ok(text.length < MACHINE_LIMITS.outputBytes + 500)
  assert.equal(big.length - omitted <= MACHINE_LIMITS.outputBytes, true)
})

test('exec 先回、process read 长轮询拿新输出，序号接得上，退出之后报退出码', async () => {
  const { time, desktop, executor, context } = world()
  const pending = executor.call('exec', { command: 'make', yield_ms: 1000 }, context)
  await flush()
  const proc = desktop.execs[0]
  assert.ok(proc)
  proc.emit('stdout', 'step 1\n')
  await flush()
  time.advance(1000)
  const first = textOf(await pending)
  assert.match(first, /process_id: p1/)
  assert.match(first, /still running/)
  assert.match(first, /step 1/)
  const seq = Number(/seq: (\d+)/.exec(first)?.[1])
  assert.equal(seq, 7)
  assert.equal(executor.processes().length, 1)
  assert.equal(executor.processes()[0]?.command, 'make')
  // 先回时标准输入留着
  assert.equal(proc.stdinClosed, false)

  // 没有新输出：等着，直到来了一段
  const reading = executor.call(
    'process',
    { process_id: 'p1', action: 'read', wait_ms: 5000 },
    context,
  )
  await flush()
  let settled = false
  reading.then(() => {
    settled = true
  })
  await flush()
  assert.equal(settled, false)
  proc.emit('stdout', 'step 2\n')
  const second = textOf(await reading)
  assert.match(second, /step 2/)
  assert.doesNotMatch(second, /step 1/)
  assert.match(second, /status: running/)

  // 给了 after_seq 就从那里读
  const again = textOf(
    await executor.call('process', { process_id: 'p1', action: 'read', after_seq: 0 }, context),
  )
  assert.match(again, /step 1\nstep 2/)

  // 等到点也没有输出：照样回
  const idle = executor.call(
    'process',
    { process_id: 'p1', action: 'read', wait_ms: 2000 },
    context,
  )
  await flush()
  time.advance(2000)
  assert.match(textOf(await idle), /status: running/)

  proc.exit(0)
  await flush()
  assert.deepEqual(executor.processes(), [])
  const last = textOf(
    await executor.call('process', { process_id: 'p1', action: 'read', wait_ms: 1000 }, context),
  )
  assert.match(last, /exit_code: 0/)
})

test('exec 的 stdin 写完关掉；process write 要先审批，写进标准输入', async () => {
  const { time, desktop, executor, context, asks } = world()
  const first = executor.call('exec', { command: 'cat', stdin: 'abc' }, context)
  await flush()
  assert.equal(desktop.execs[0]?.stdin, 'abc')
  assert.equal(desktop.execs[0]?.stdinClosed, true)
  desktop.execs[0]?.exit(0)
  assert.match(textOf(await first), /exit_code: 0/)

  const second = executor.call('exec', { command: 'python3 -i', yield_ms: 0 }, context)
  await flush()
  time.advance(0)
  assert.match(textOf(await second), /process_id: p2/)
  const write = await executor.call(
    'process',
    { process_id: 'p2', action: 'write', input: 'print(1)\n' },
    context,
  )
  assert.equal(write.success, true)
  assert.equal(desktop.execs[1]?.stdin, 'print(1)\n')
  assert.equal(asks.at(-1)?.ask.action, 'process')
  assert.equal(asks.at(-1)?.class, 'mutate')

  // 起来就关了标准输入的进程写不了
  const third = executor.call('exec', { command: 'sleep 100', timeout_ms: 200_000 }, context)
  await flush()
  time.advance(MACHINE_LIMITS.yieldMaxMs)
  assert.match(textOf(await third), /process_id: p3/)
  const refused = await executor.call(
    'process',
    { process_id: 'p3', action: 'write', input: 'x' },
    context,
  )
  assert.equal(refused.success, false)
  assert.match(textOf(refused), /\[litch:invalid\].*stdin of this process is closed/)
})

test('process signal：SIGINT 按进程组号发，SIGKILL 和 kill 直接结束', async () => {
  const { desktop, executor, context } = world()
  const pending = executor.call('exec', { command: 'server', yield_ms: 0 }, context)
  await flush()
  await pending
  const proc = desktop.execs[0]
  const sent = await executor.call(
    'process',
    { process_id: 'p1', action: 'signal', signal: 'SIGTERM' },
    context,
  )
  assert.equal(sent.success, true, textOf(sent))
  assert.deepEqual(desktop.signals, [{ signal: 'TERM', pid: proc?.pid }])
  const killed = await executor.call('process', { process_id: 'p1', action: 'kill' }, context)
  assert.match(textOf(killed), /status: killed/)
  assert.deepEqual(executor.processes(), [])
  await flush()
  assert.equal(desktop.requests.filter((one) => one.method === 'process/kill').length, 1)
  const after = await executor.call('process', { process_id: 'p1', action: 'signal' }, context)
  assert.match(textOf(after), /\[litch:invalid\].*already ended/)
})

test('审批的几种结果：拒绝（带话）、没人答、取消，都不动手，记录照实记', async () => {
  const time = fakeClock()
  const desktop = new FakeMachine('desktop', 'desktop')
  const executor = createMachineExecutor({ clock: time.clock })
  const { context, logs } = fakeContext([desktop], {
    answers: [{ kind: 'declined', note: '别删' }, { kind: 'expired' }, { kind: 'cancelled' }],
  })
  const declined = await executor.call('exec', { command: 'rm -rf build' }, context)
  assert.equal(declined.success, false)
  assert.match(textOf(declined), /^\[litch:declined\].*"别删".*Do not retry/)
  const expired = await executor.call('exec', { command: 'rm -rf build' }, context)
  assert.match(textOf(expired), /^\[litch:declined\].*did not answer/)
  const cancelled = await executor.call('write_file', { path: '~/a.txt', content: 'x' }, context)
  assert.match(textOf(cancelled), /^\[litch:failed\]/)
  assert.equal(desktop.execs.length, 0)
  assert.throws(() => desktop.fs.read('/Users/song/a.txt'))
  assert.deepEqual(
    logs.map((one) => one.result),
    ['declined', 'expired', 'failed'],
  )
})

test('exec 的命令里提到禁止位置时填 flagged：原样、展开、$HOME、相对、解开链接的写法', async () => {
  const { desktop, executor, context, asks, logs } = world(['~/.ssh', '~/.aws', '~/secrets'])
  desktop.fs.mkdirp('/Users/song/.ssh')
  desktop.fs.mkdirp('/Volumes/vault/secrets')
  desktop.fs.link('/Users/song/secrets', '/Volumes/vault/secrets')
  desktop.onExec = (proc) => proc.exit(0)
  const flaggedFor = async (command: string, cwd?: string) => {
    await executor.call('exec', { command, ...(cwd ? { cwd } : {}) }, context)
    return asks.at(-1)?.ask.flagged
  }
  assert.deepEqual(await flaggedFor('cat ~/.ssh/id_ed25519'), ['~/.ssh'])
  assert.deepEqual(await flaggedFor('ls /Users/song/.ssh'), ['~/.ssh'])
  assert.deepEqual(await flaggedFor('cat "$HOME/.aws/credentials"'), ['~/.aws'])
  assert.deepEqual(await flaggedFor('tar cf x.tar .ssh'), ['~/.ssh'])
  assert.deepEqual(await flaggedFor('cat /Volumes/vault/secrets/key'), ['~/secrets'])
  // macOS 不分大小写
  assert.deepEqual(await flaggedFor('cat ~/.SSH/id'), ['~/.ssh'])
  // 名字相近的不算
  assert.deepEqual(await flaggedFor('ls ~/.sshx ~/.awsome'), [])
  // 工作目录本身在禁止位置里也算
  assert.deepEqual(await flaggedFor('ls', '~/.ssh'), ['~/.ssh'])
  assert.equal(logs.at(-1)?.flagged, true)
  assert.equal(logs.at(-2)?.flagged, false)
})

test('进程归属：别的设备看不到；会话所在设备断开 10 分钟后结束，回来了就不结束', async () => {
  const time = fakeClock()
  const desktop = new FakeMachine('desktop', 'desktop')
  const executor = createMachineExecutor({ clock: time.clock })
  const a = fakeContext([desktop], { deviceId: 'dev-a' })
  const b = fakeContext([desktop], { deviceId: 'dev-b' })
  const start = async (context: typeof a.context) => {
    const pending = executor.call(
      'exec',
      { command: 'sleep 1000', yield_ms: 0, timeout_ms: 600_000 },
      context,
    )
    await flush()
    return textOf(await pending)
  }
  assert.match(await start(a.context), /p1/)
  assert.match(await start(b.context), /p2/)
  const foreign = await executor.call('process', { process_id: 'p1', action: 'kill' }, b.context)
  assert.match(textOf(foreign), /\[litch:invalid\] No process p1/)
  assert.equal(executor.processes().length, 2)
  assert.deepEqual(
    executor.processes().map((one) => [one.id, one.owner.deviceId, one.targetId]),
    [
      ['p1', 'dev-a', 'desktop'],
      ['p2', 'dev-b', 'desktop'],
    ],
  )

  // 断开 10 分钟：dev-a 的结束，dev-b 的不动
  executor.ownerPresence('dev-a', false)
  time.advance(OWNER_AWAY_MS)
  assert.deepEqual(
    executor.processes().map((one) => one.id),
    ['p2'],
  )
  await flush()
  assert.equal(desktop.execs[0]?.done, true)
  assert.equal(desktop.execs[1]?.done, false)

  assert.equal(executor.kill('p2'), true)
  assert.equal(executor.kill('p2'), false)
  assert.match(await start(a.context), /p3/)
  assert.match(await start(b.context), /p4/)
  executor.stopAll('dev-b')
  assert.deepEqual(
    executor.processes().map((one) => one.id),
    ['p3'],
  )
  executor.dispose()
  assert.deepEqual(executor.processes(), [])
  const after = await executor.call('machines', {}, a.context)
  assert.match(textOf(after), /\[litch:failed\]/)
})

test('exec 到点被对面结束（124）报超时；调用被中止时结束进程', async () => {
  const time = fakeClock()
  const desktop = new FakeMachine('desktop', 'desktop')
  const executor = createMachineExecutor({ clock: time.clock })
  const { context, abort } = fakeContext([desktop])
  const pending = executor.call('exec', { command: 'sleep 9', timeout_ms: 2000 }, context)
  await flush()
  time.advance(2000)
  desktop.execs[0]?.exit(124)
  assert.match(textOf(await pending), /timed out after 2000 ms/)

  const second = executor.call('exec', { command: 'sleep 9' }, context)
  await flush()
  abort()
  const response = await second
  assert.match(textOf(response), /^\[litch:failed\] The call was cancelled/)
  await flush()
  assert.equal(desktop.execs[1]?.done, true)
  assert.deepEqual(executor.processes(), [])
})

test('参数不对、不认识的机器和工具：回 invalid，不动手', async () => {
  const { executor, context, desktop } = world()
  assert.match(
    textOf(await executor.call('exec', {}, context)),
    /\[litch:invalid\] command must be/,
  )
  assert.match(
    textOf(await executor.call('exec', { command: 'ls', machine: 'nas' }, context)),
    /unknown or offline.*machines/,
  )
  assert.match(
    textOf(await executor.call('exec', { command: 'ls', timeout_ms: 1 }, context)),
    /timeout_ms must be/,
  )
  assert.match(
    textOf(await executor.call('exec', { command: 'ls', cwd: 'relative' }, context)),
    /cwd must be an absolute/,
  )
  assert.match(
    textOf(await executor.call('nope', {}, context)),
    /\[litch:invalid\] litch_machine has no tool/,
  )
  assert.equal(desktop.execs.length, 0)
})

test('machines：列出各台，桌面端带审批方式和访问范围，连不上的照实说', async () => {
  const time = fakeClock()
  const desktop = new FakeMachine('desktop', 'desktop', {
    name: "Song's MacBook",
    hostname: 'songs-mbp',
  })
  const session = new FakeMachine('session', 'session', {
    name: 'dev-box',
    system: 'Linux x86_64',
    home: '/home/song',
    shell: '/bin/bash',
  })
  const other = new FakeMachine('nas', 'other')
  other.online = false
  const executor = createMachineExecutor({ clock: time.clock })
  const { context } = fakeContext([desktop, session, other], { denied: ['~/.ssh'] })
  const text = textOf(await executor.call('machines', {}, context))
  assert.match(
    text,
    /- desktop \(the user's desktop running Litch, the controller\): "Song's MacBook", host songs-mbp, macOS 26.5 arm64/,
  )
  assert.match(text, /Approval: session .*Access: custom .*Blocked locations: ~\/\.ssh\./)
  assert.match(
    text,
    /- session \(where this conversation runs\): "dev-box".*Linux x86_64.*home \/home\/song, shell \/bin\/bash$/m,
  )
  assert.match(text, /- nas \(another machine\): not reachable/)
})

test('会话所在的设备断开又回来：取消计时，进程留着', async () => {
  const time = fakeClock()
  const desktop = new FakeMachine('desktop', 'desktop')
  const executor = createMachineExecutor({ clock: time.clock })
  const { context } = fakeContext([desktop], { deviceId: 'dev-a' })
  const pending = executor.call(
    'exec',
    { command: 'sleep 1000', yield_ms: 0, timeout_ms: 600_000 },
    context,
  )
  await flush()
  await pending
  executor.ownerPresence('dev-a', false)
  time.advance(300_000)
  executor.ownerPresence('dev-a', true)
  time.advance(305_000)
  assert.equal(executor.processes().length, 1)
  await flush()
  assert.equal(desktop.execs[0]?.done, false)
})

test('对面一直不报退出（连接断了）：到期限加一段之后当它丢了', async () => {
  const time = fakeClock()
  const desktop = new FakeMachine('desktop', 'desktop')
  const executor = createMachineExecutor({ clock: time.clock })
  const { context } = fakeContext([desktop])
  const pending = executor.call(
    'exec',
    { command: 'sleep 1000', yield_ms: 0, timeout_ms: 5000 },
    context,
  )
  await flush()
  await pending
  time.advance(20_000)
  await flush()
  assert.deepEqual(executor.processes(), [])
  const read = await executor.call('process', { process_id: 'p1', action: 'read' }, context)
  assert.match(textOf(read), /lost the connection/)
})
