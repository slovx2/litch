import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import {
  backgroundBash,
  cliProcesses,
  commandAlive,
  disposeScene,
  lastUserText,
  listTerminals,
  readTurns,
  runTurn,
  type Scene,
  say,
  startScene,
  uniqueSleep,
  until,
} from './fixtures/background-scene.mjs'
import { deferred } from './fixtures/deferred.mjs'

const turnsStarted = (scene: Scene): string[] =>
  scene.client.trace
    .filter((message) => message.method === 'turn/started')
    .map((message) => message.params.turn.id)

// 回合结束后协议层要算一次工作区差异才发终态。用一个可以随时变慢的 git 把这段收尾拉长，
// 让“运行时已经交还回合、协议层还没收完”的窗口足够宽。
async function sceneWithSlowWrapUp(name: string): Promise<{
  scene: Scene
  slow: (on: boolean) => Promise<void>
  dispose: () => Promise<void>
}> {
  const tools = await mkdtemp(join(tmpdir(), `${name}-git-`))
  const flag = join(tools, 'slow')
  await mkdir(join(tools, 'bin'))
  const git = join(tools, 'bin', 'git')
  await writeFile(git, `#!/bin/sh\n[ -f "${flag}" ] && sleep 2\nexec /usr/bin/git "$@"\n`)
  await chmod(git, 0o755)
  const scene = await startScene(name, {
    PATH: `${join(tools, 'bin')}:${dirname(process.execPath)}:/usr/bin:/bin`,
  })
  const run = (...args: string[]): void => {
    execFileSync('/usr/bin/git', args, { cwd: scene.workspace, stdio: 'ignore' })
  }
  await writeFile(join(scene.workspace, 'README.md'), 'wrap-up\n')
  run('init', '-q')
  run('add', '.')
  run('-c', 'user.name=test', '-c', 'user.email=test@localhost', 'commit', '-q', '-m', 'init')
  return {
    scene,
    slow: async (on) => (on ? writeFile(flag, '') : rm(flag, { force: true })),
    dispose: async () => {
      await disposeScene(scene)
      await rm(tools, { recursive: true, force: true })
    },
  }
}

test('上一回合还在收尾时后台命令结束：续跑的一轮等收尾完再成为回合，不被丢弃', {
  timeout: 90_000,
}, async () => {
  const { scene, slow, dispose } = await sceneWithSlowWrapUp('native-bg-wrapup')
  const command = `${uniqueSleep(1)} && echo WRAP_DONE`
  try {
    scene.model.enqueue(backgroundBash('toolu_wrap', command))
    scene.model.enqueue(async () => {
      await slow(true)
      return [{ type: 'text', text: '已在后台启动' }]
    })
    // 命令在第一回合收尾期间结束，CLI 随即自己续跑。
    scene.model.enqueue(async (request) => {
      assert.match(lastUserText(request), /task-notification/)
      await slow(false)
      return [{ type: 'text', text: '收尾期间结束的命令也有回音' }]
    })
    const first = await runTurn(scene, '在后台启动一条很快结束的命令')
    assert.equal(first.status, 'completed')
    await until('自行续跑的回合开始', () => turnsStarted(scene).length === 2, 8_000)
    const spontaneousId = turnsStarted(scene)[1] as string
    assert.equal((await scene.client.completed(spontaneousId)).status, 'completed')

    const methods = scene.client.trace.map((message) => [message.method, message.params?.turn?.id])
    const firstDone = methods.findIndex(([m, id]) => m === 'turn/completed' && id === first.id)
    const secondStart = methods.findIndex(([m, id]) => m === 'turn/started' && id === spontaneousId)
    assert.ok(firstDone >= 0 && firstDone < secondStart, '续跑的回合要在上一回合结束之后才开始')
    const turns = await readTurns(scene)
    assert.equal(turns.length, 2)
    assert.match(JSON.stringify(turns[1].items), /收尾期间结束的命令也有回音/)
    scene.model.assertConsumed()
  } finally {
    await dispose()
  }
})

test('自行续跑的回合正在收尾时用户发来消息：按新回合提交，消息不丢', {
  timeout: 90_000,
}, async () => {
  const { scene, slow, dispose } = await sceneWithSlowWrapUp('native-bg-join-late')
  const command = `${uniqueSleep(1)} && echo JOIN_DONE`
  try {
    scene.model.enqueue(backgroundBash('toolu_join_late', command))
    scene.model.enqueue(say('已在后台启动'))
    scene.model.enqueue(async () => {
      await slow(true)
      return [{ type: 'text', text: 'NOTIFICATION_ROUND_REPLY' }]
    })
    assert.equal((await runTurn(scene, '在后台启动一条很快结束的命令')).status, 'completed')
    await until('自行续跑的回合开始', () => turnsStarted(scene).length === 2)
    const spontaneousId = turnsStarted(scene)[1] as string
    await until('续跑的回答开始写出', () =>
      scene.client.trace.some(
        (message) =>
          message.method === 'item/agentMessage/delta' && message.params.turnId === spontaneousId,
      ),
    )
    // 正文之后紧跟着就是这一轮的结束；稍等片刻，运行时里它已经结束，协议层还在算差异。
    await new Promise((resolve) => setTimeout(resolve, 600))
    assert.equal(
      scene.client.trace.some(
        (message) =>
          message.method === 'turn/completed' && message.params.turn.id === spontaneousId,
      ),
      false,
      '用例前提：续跑的回合还没有收尾完',
    )
    scene.model.enqueue(async (request) => {
      assert.match(lastUserText(request), /LATE_USER_MESSAGE/)
      await slow(false)
      return [{ type: 'text', text: '收到了迟到的消息' }]
    })
    const { turn } = await scene.client.request('turn/start', {
      threadId: scene.threadId,
      clientUserMessageId: 'late-user-message',
      input: [{ type: 'text', text: 'LATE_USER_MESSAGE' }],
    })
    assert.notEqual(turn.id, spontaneousId, '续跑的回合已经结束，这条消息应是一个新回合')
    assert.equal((await scene.client.completed(turn.id)).status, 'completed')
    const turns = await readTurns(scene)
    assert.equal(turns.length, 3)
    assert.equal(JSON.stringify(turns).split('LATE_USER_MESSAGE').length - 1, 1, '消息只出现一次')
    assert.match(JSON.stringify(turns[2].items), /收到了迟到的消息/)
    scene.model.assertConsumed()
  } finally {
    await dispose()
  }
})

test('打断带后台命令的回合：排着队的追加指令一并取消，不会在打断之后自己跑起来', {
  timeout: 90_000,
}, async () => {
  const scene = await startScene('native-bg-interrupt-queued')
  const command = uniqueSleep(60)
  const held = deferred()
  try {
    scene.model.enqueue(backgroundBash('toolu_queued', command))
    scene.model.enqueue(async () => {
      await held.promise
      return [{ type: 'text', text: '不会送达' }]
    })
    const { turn } = await scene.client.request('turn/start', {
      threadId: scene.threadId,
      input: [{ type: 'text', text: '在后台启动一条长命令' }],
    })
    await until('第二次模型请求到达', () => scene.model.requests.length === 2)
    await until('后台命令在列表里', async () => (await listTerminals(scene)).length === 1)
    const [cli] = cliProcesses(scene)
    assert.ok(cli)
    // 模型请求还挂着，这条追加指令只能在 CLI 里排队。
    await scene.client.request('turn/steer', {
      threadId: scene.threadId,
      expectedTurnId: turn.id,
      input: [{ type: 'text', text: 'QUEUED_STEER_MESSAGE' }],
    })
    await scene.client.request('turn/interrupt', { threadId: scene.threadId, turnId: turn.id })
    assert.equal((await scene.client.completed(turn.id)).status, 'interrupted')
    held.resolve()

    await new Promise((resolve) => setTimeout(resolve, 3_000))
    assert.equal(turnsStarted(scene).length, 1, '打断之后不应再有回合自己开始')
    assert.equal(
      scene.model.requests.some((request) => /QUEUED_STEER_MESSAGE/.test(lastUserText(request))),
      false,
      '被取消的追加指令不应到达模型',
    )
    assert.equal(commandAlive(command), true, '后台命令不受打断影响')
    assert.deepEqual(
      cliProcesses(scene).map((row) => row.pid),
      [cli.pid],
    )
  } finally {
    held.resolve()
    await disposeScene(scene)
  }
})
