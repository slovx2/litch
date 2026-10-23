import assert from 'node:assert/strict'
import { type ChildProcess, spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import type { Connection, Stage } from './fixtures/in-process.mjs'

// 别的会话 SendMessage 发来、这边的会话没有 CLI 时先唤醒它（29 号文档第七节）：协议层认目标、去重、等收场，
// 运行时在唤醒失败或回合结束时不再空等。不起 CLI：协议层用照剧本走的运行时，运行时这边直接调唤醒的等待。

// 认名字时要读本机登记（<配置目录>/sessions/），放进临时目录，不碰真实的 ~/.claude
const config = await mkdtemp(join(tmpdir(), 'peer-wake-'))
process.env.CLAUDE_CONFIG_DIR = config
const { openStage } = await import('./fixtures/in-process.mjs')
const { NativeClaudeRuntime } = await import('../src/native-runtime.mjs')

const children: ChildProcess[] = []
test.after(async () => {
  for (const child of children) child.kill('SIGKILL')
  await rm(config, { recursive: true, force: true })
})

async function withStage(name: string, run: (stage: Stage, app: Connection) => Promise<void>) {
  const stage = await openStage(name, { native: null })
  try {
    await run(stage, await stage.connect('app'))
  } finally {
    await stage.dispose()
  }
}

async function named(app: Connection, stage: Stage, name: string): Promise<string> {
  const { thread } = await app.request('thread/start', { cwd: stage.directory })
  await app.request('thread/name/set', { threadId: thread.id, name })
  return thread.id
}

const wakes = (app: Connection) =>
  app.notifications('turn/started').map((message) => message.params.threadId as string)

test('PEER-WAKE-001：按名字认目标：只认顶层的 Claude 会话、重名不认、登记里别的活进程叫这个名字时不认', async () => {
  await withStage('peer-wake-names', async (stage, app) => {
    const sender = await named(app, stage, '发送方')
    const target = await named(app, stage, '构建')
    // 同名的子代理线程不参与
    const child = await named(app, stage, '构建')
    stage.store.upsertThread({
      ...(stage.store.getThread(child) as any),
      threadSource: 'subagent',
      forkedFromId: target,
    })
    await named(app, stage, '重名')
    await named(app, stage, '重名')
    const codex = await named(app, stage, '别家')
    stage.store.upsertThread({ ...(stage.store.getThread(codex) as any), runtimeBackend: 'codex' })
    await named(app, stage, '桌面端那个')
    const desktop = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 120000)'], {
      stdio: 'ignore',
    })
    children.push(desktop)
    await once(desktop, 'spawn')
    await mkdir(join(config, 'sessions'), { recursive: true })
    await writeFile(
      join(config, 'sessions', `${desktop.pid}.json`),
      JSON.stringify({ pid: desktop.pid, sessionId: 'elsewhere', name: '桌面端那个' }),
    )

    const wake = stage.session().onPeerWake
    assert.ok(wake)
    for (const to of ['重名', '别家', '桌面端那个', 'main', 'a1b2c3d4e5f6a7b8', '构', '发送方'])
      assert.equal(await wake(to, sender), null, to)
    assert.deepEqual(wakes(app), [])

    const woken = await wake('构建 [ab12]', sender)
    assert.equal(woken?.key, target)
    await woken?.ended
    assert.deepEqual(wakes(app), [target])
  })
})

test('PEER-WAKE-002：两个发送方同时唤醒同一个会话只起一个回合；已有 CLI 时不起回合', async () => {
  await withStage('peer-wake-twice', async (stage, app) => {
    const target = await named(app, stage, '目标')
    let release = () => {}
    let entered = () => {}
    const running = new Promise<void>((resolve) => {
      entered = resolve
    })
    stage.script = async (_context, handlers) => {
      await new Promise<void>((resolve) => {
        release = resolve
        entered()
      })
      await handlers.onEvent({ type: 'completed', success: true, result: '' })
    }
    const wake = stage.session().onPeerWake
    assert.ok(wake)
    const [first, second] = await Promise.all([wake('目标', 'one'), wake('目标', 'two')])
    assert.equal(first?.key, target)
    assert.equal(second?.key, target)
    assert.deepEqual(wakes(app), [target], '只起一个唤醒回合')
    // 回合还在起：后来的发送方等同一个回合
    const third = await wake('目标', 'three')
    assert.equal(third?.key, target)
    assert.ok(third?.ended, '等这个回合结束')
    await running
    release()
    await Promise.all([first?.ended, third?.ended])
    assert.deepEqual(wakes(app), [target])

    const runtime = (stage.server as any).runtime
    runtime.cliProcessKeys = () => [target]
    assert.deepEqual(await wake('目标', 'four'), { key: target, ended: null })
    assert.deepEqual(wakes(app), [target], 'CLI 开着时不另起回合')
  })
})

test('PEER-WAKE-003：唤醒回合起不来时 ended 很快落定，不让发送方白等', async () => {
  await withStage('peer-wake-fail', async (stage, app) => {
    const target = await named(app, stage, '起不来')
    stage.script = async () => {
      throw new Error('CLI 起不来')
    }
    const wake = await stage.session().onPeerWake?.('起不来', 'sender')
    assert.equal(wake?.key, target)
    const started = Date.now()
    await wake?.ended
    assert.ok(Date.now() - started < 2_000)
    const turnId = app.notifications('turn/started')[0].params.turn.id
    assert.equal((await app.completed(turnId)).status, 'failed')
  })
})

test('PEER-WAKE-004：目标的进程正在收场时先等它退完再唤醒', async () => {
  await withStage('peer-wake-closing', async (stage, app) => {
    const target = await named(app, stage, '在收场')
    let closed = () => {}
    const closing = new Promise<void>((resolve) => {
      closed = resolve
    })
    const runtime = (stage.server as any).runtime
    runtime.closingSession = (threadId: string) => (threadId === target ? closing : null)
    const waking = stage.session().onPeerWake?.('在收场', 'sender')
    await new Promise((resolve) => setTimeout(resolve, 100))
    assert.deepEqual(wakes(app), [], '还在收场时不起回合')
    runtime.closingSession = () => null
    closed()
    const wake = await waking
    assert.equal(wake?.key, target)
    await wake?.ended
    assert.deepEqual(wakes(app), [target])
  })
})

test('PEER-WAKE-005：运行时的等待：唤醒失败或回合结束就放行；发给自己有名字的子代理不唤醒', async () => {
  const runtime = new NativeClaudeRuntime()
  const asked: string[] = []
  let answer: () => Promise<unknown> = async () => {}
  runtime.setSessionHandlers({
    onPeerWake: async (to: string) => {
      asked.push(to)
      return { key: 'target', ended: answer() }
    },
  } as any)
  const wakePeer = (from: string, to: string): Promise<void> => (runtime as any).wakePeer(from, to)

  answer = () => Promise.reject(new Error('起不来'))
  let started = Date.now()
  await wakePeer('sender', '目标')
  assert.ok(Date.now() - started < 1_500, '失败立即放行')

  answer = () => new Promise((resolve) => setTimeout(resolve, 300))
  started = Date.now()
  await wakePeer('sender', '目标')
  assert.ok(Date.now() - started < 1_500, '回合结束了还没就绪也放行')

  ;(runtime as any).agentNames.set('sender', new Set(['助手']))
  await wakePeer('sender', '助手 [ab12]')
  assert.deepEqual(asked, ['目标', '目标'])
})
