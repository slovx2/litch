import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { chmod, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { DshRuntime, EXIT_TIMING, type ExitTiming } from '../src/runtime.mjs'

// 关 dsh 的做法（DshRuntime）。dsh 只认头一个结束信号：收场途中再来一个，它丢下收尾立刻退出，
// 刚完成的回合可能还没落盘。此前适配器在两处会补上第二个：dsh 自己先收场、断开连接的时候；
// 主进程给整个进程组发了信号（dsh 已经收到）之后适配器自己再发。另外只等 3 秒就强杀，比 dsh 自己的上限短。
// 这里对着假的 dsh（fake-dsh.mts，信号上的反应照真的写），时序才是确定的；真的 dsh 在 shutdown-entry.test.mts。

const FAKE = fileURLToPath(new URL('./fake-dsh.mjs', import.meta.url))
const pause = (ms: number) => new Promise<void>((done) => setTimeout(done, ms))

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

interface Stage {
  runtime: DshRuntime
  // 连接被对面断开时交给上层的那一下
  closed: Error[]
  // 假 dsh 记下的经过，按先后：<第几个进程>:<事件>
  story(): string[]
  pids(): number[]
  restore(): Promise<void>
}

async function stage(
  options: {
    windDownMs?: number
    stuck?: boolean
    noCookie?: boolean
    dropMs?: number
    timing?: ExitTiming
  } = {},
): Promise<Stage> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'dsh-exit-')))
  const cli = join(root, 'dsh')
  await writeFile(cli, `#!/bin/sh\nexec '${process.execPath}' '${FAKE}' "$@"\n`)
  await chmod(cli, 0o755)
  const log = join(root, 'fake.log')
  const saved = { ...process.env }
  Object.assign(process.env, {
    CHA_DSH_CLI: cli,
    FAKE_DSH_LOG: log,
    FAKE_DSH_WIND_DOWN_MS: String(options.windDownMs ?? 50),
    FAKE_DSH_STUCK: options.stuck ? '1' : '',
    FAKE_DSH_NO_COOKIE: options.noCookie ? '1' : '',
    FAKE_DSH_DROP_MS: options.dropMs === undefined ? '' : String(options.dropMs),
  })
  const closed: Error[] = []
  const runtime = new DshRuntime(
    join(root, 'home'),
    {
      waterfall: async () => ({ kind: 'next' }),
      emit: () => {},
      closed: (error) => closed.push(error),
    },
    options.timing,
  )
  const entries = (): any[] =>
    readFileSync(log, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
  const pids = (): number[] =>
    entries()
      .filter((entry) => entry.event === 'start')
      .map((entry) => entry.pid)
  return {
    runtime,
    closed,
    pids,
    story: () => {
      const order = pids()
      return entries().map(
        (entry) =>
          `${order.indexOf(entry.pid) + 1}:${entry.event}${entry.how ? `:${entry.how}` : ''}`,
      )
    },
    async restore() {
      for (const pid of pids()) if (alive(pid)) process.kill(pid, 'SIGKILL')
      for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key]
      Object.assign(process.env, saved)
      await rm(root, { recursive: true, force: true })
    },
  }
}

test('等 dsh 收场的时限：平时比 dsh 自己的上限长，被信号要求退出时比主进程给运行时的时限短', () => {
  // dsh 收到结束信号后给自己 5 秒，到点自己退出
  assert.ok(EXIT_TIMING.graceMs > 5000)
  // 主进程停运行时：给进程组发结束信号，等这么久就整组强杀
  const serve = readFileSync(resolve('cmd/codex-harness-adapter/serve.go'), 'utf8')
  const wait =
    /hostplatform\.Terminate\(process\)[\s\S]{0,160}?time\.After\((\d+) \* time\.Second\)/.exec(
      serve,
    )
  assert.ok(wait, '主进程停运行时的写法变了，这里的核对要跟着改')
  assert.ok(EXIT_TIMING.signalledGraceMs < Number(wait[1]) * 1000)
  assert.ok(EXIT_TIMING.hangupWaitMs < EXIT_TIMING.signalledGraceMs)
})

test('dsh：平常地关是发一次结束信号、等它收尾完，收尾要三秒多也等，不强杀', {
  timeout: 60000,
}, async () => {
  const s = await stage({ windDownMs: 3500 })
  try {
    await s.runtime.remote()
    const [pid] = s.pids()
    await s.runtime.close()
    assert.deepEqual(s.story(), ['1:start', '1:signal', '1:exit:clean'])
    assert.ok(!alive(pid as number))
  } finally {
    await s.restore()
  }
})

test('dsh：它自己先收场（那头断开了连接）时不再给它发信号；下一次用到等它退干净再另起一个', {
  timeout: 60000,
}, async () => {
  const s = await stage({ windDownMs: 400 })
  try {
    const remote = await s.runtime.remote()
    const [first] = s.pids() as [number]
    process.kill(first, 'SIGTERM')
    for (let waited = 0; waited < 5000 && !s.closed.length; waited += 5) await pause(5)
    assert.equal(s.closed.length, 1, '连接断开要告诉上层')
    assert.ok(alive(first), '连接断开的时候它还在收尾')
    // 紧接着就用：新的在旧的退出之后才起
    assert.notEqual(await s.runtime.remote(), remote)
    assert.deepEqual(s.story(), ['1:start', '1:signal', '1:exit:clean', '2:start'])
    await s.runtime.close()
    assert.deepEqual(s.story().slice(4), ['2:signal', '2:exit:clean'])
  } finally {
    await s.restore()
  }
})

test('dsh：连接断了、进程却没在收场的，等过了它自己的收场上限才发那一次信号，它照常收尾，不强杀', {
  timeout: 60000,
}, async () => {
  const timing = { graceMs: 700, signalledGraceMs: 500, hangupWaitMs: 100 }
  const s = await stage({ dropMs: 50, windDownMs: 100, timing })
  try {
    const remote = await s.runtime.remote()
    const [first] = s.pids() as [number]
    for (let waited = 0; waited < 5000 && !s.closed.length; waited += 5) await pause(5)
    const dropped = Date.now()
    assert.equal(s.closed.length, 1, '连接断开要告诉上层')
    assert.deepEqual(s.story(), ['1:start'])
    // 后面起的那个不断连接
    process.env.FAKE_DSH_DROP_MS = ''
    assert.notEqual(await s.runtime.remote(), remote)
    assert.ok(Date.now() - dropped >= timing.graceMs - 50, '没到点不发信号')
    assert.deepEqual(s.story(), ['1:start', '1:signal', '1:exit:clean', '2:start'])
    assert.ok(!alive(first))
    await s.runtime.close()
    assert.deepEqual(s.story().slice(4), ['2:signal', '2:exit:clean'])
  } finally {
    await s.restore()
  }
})

test('dsh：适配器被结束信号要求退出时，dsh 也收到了同一个信号的不再发第二个，没收到的等一小会儿由适配器发', {
  timeout: 60000,
}, async () => {
  // 同一个进程组里的 dsh 已经收到了
  const both = await stage({ windDownMs: 300 })
  try {
    await both.runtime.remote()
    const [pid] = both.pids() as [number]
    process.kill(pid, 'SIGTERM')
    await both.runtime.close(true)
    assert.deepEqual(both.story(), ['1:start', '1:signal', '1:exit:clean'])
    assert.ok(!alive(pid))
  } finally {
    await both.restore()
  }
  // 信号只发给了适配器
  const alone = await stage({ windDownMs: 300, timing: { ...EXIT_TIMING, hangupWaitMs: 200 } })
  try {
    await alone.runtime.remote()
    const began = Date.now()
    await alone.runtime.close(true)
    assert.ok(Date.now() - began >= 200 + 300, '先等它断开连接，没等到才发信号')
    assert.deepEqual(alone.story(), ['1:start', '1:signal', '1:exit:clean'])
  } finally {
    await alone.restore()
  }
})

test('dsh：收了信号不收场的到点强杀，被结束信号要求退出时的时限更短', {
  timeout: 60000,
}, async () => {
  const timing = { graceMs: 1200, signalledGraceMs: 500, hangupWaitMs: 100 }
  for (const signalled of [false, true]) {
    const s = await stage({ stuck: true, timing })
    try {
      await s.runtime.remote()
      const [pid] = s.pids() as [number]
      const began = Date.now()
      await s.runtime.close(signalled)
      const took = Date.now() - began
      const limit = signalled ? timing.signalledGraceMs : timing.graceMs
      assert.ok(took >= limit - 50 && took < limit + 1500, `用了 ${took} 毫秒`)
      assert.ok(!alive(pid))
      // 没有收尾完的那一条：是被强杀的；信号只发过一次
      assert.deepEqual(s.story(), ['1:start', '1:signal'])
    } finally {
      await s.restore()
    }
  }
})

test('dsh：起来了却连不上的进程不留着，下一次另起之前先把它送走', { timeout: 60000 }, async () => {
  const s = await stage({ noCookie: true })
  try {
    for (let attempt = 0; attempt < 2; attempt++)
      await assert.rejects(s.runtime.remote(), /没有换到会话 cookie/)
    await s.runtime.close()
    assert.deepEqual(s.story(), [
      '1:start',
      '1:signal',
      '1:exit:clean',
      '2:start',
      '2:signal',
      '2:exit:clean',
    ])
    assert.ok(s.pids().every((pid) => !alive(pid)))
  } finally {
    await s.restore()
  }
})
