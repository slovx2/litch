import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'
import {
  adapterTree,
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
import { survivors } from './fixtures/process-tree.mjs'

const turnsStarted = (scene: Scene): string[] =>
  scene.client.trace
    .filter((message) => message.method === 'turn/started')
    .map((message) => message.params.turn.id)

const commandCompletions = (scene: Scene): any[] =>
  scene.client.trace
    .filter(
      (message) =>
        message.method === 'item/completed' && message.params.item.type === 'commandExecution',
    )
    .map((message) => message.params)

const mentionsNotification = (request: any): boolean =>
  /task-notification/.test(JSON.stringify(request.messages))

test('自行续跑进行中用户发来消息：并入那个回合，消息不丢，回合在消息被处理后才结束', {
  timeout: 90_000,
}, async () => {
  const scene = await startScene('native-bg-join')
  const command = uniqueSleep(2)
  const held = deferred()
  try {
    scene.model.enqueue(backgroundBash('toolu_join', command))
    scene.model.enqueue(say('已在后台启动'))
    // 通知触发的那一轮先挂住，这时用户再发消息。
    scene.model.enqueue(async (request) => {
      assert.match(lastUserText(request), /task-notification/)
      await held.promise
      return [{ type: 'text', text: '后台命令结束了' }]
    })
    scene.model.enqueue((request) => {
      assert.match(lastUserText(request), /并入的用户消息/)
      return [{ type: 'text', text: '这是对用户消息的回答' }]
    })
    await runTurn(scene, '在后台启动一条短命令')
    await until('自行续跑的回合开始', () => turnsStarted(scene).length === 2)
    const spontaneousId = turnsStarted(scene)[1] as string
    await until('通知那一轮的模型请求到达', () => scene.model.requests.length === 3)

    const joined = await scene.client.request('turn/start', {
      threadId: scene.threadId,
      input: [{ type: 'text', text: '并入的用户消息' }],
      clientUserMessageId: 'join-1',
    })
    assert.equal(joined.turn.id, spontaneousId, '应答返回的是正在进行的那个回合')
    // 同一条消息重复提交仍然得到同一个回合，不会再送一遍。
    const again = await scene.client.request('turn/start', {
      threadId: scene.threadId,
      input: [{ type: 'text', text: '并入的用户消息' }],
      clientUserMessageId: 'join-1',
    })
    assert.equal(again.turn.id, spontaneousId)
    held.resolve()

    const completed = await scene.client.completed(spontaneousId)
    assert.equal(completed.status, 'completed')
    assert.equal(turnsStarted(scene).length, 2, '没有为这条消息另开回合')
    const turns = await readTurns(scene)
    assert.equal(turns.length, 2)
    const text = JSON.stringify(turns[1].items)
    assert.match(text, /并入的用户消息/)
    assert.match(text, /这是对用户消息的回答/)
    assert.equal(scene.model.requests.length, 4)
    scene.model.assertConsumed()
  } finally {
    held.resolve()
    await disposeScene(scene)
  }
})

test('命令结束时用户回合正在进行：通知并入这个回合，不另开回合', {
  timeout: 90_000,
}, async () => {
  const scene = await startScene('native-bg-inturn')
  const command = uniqueSleep(2)
  const held = deferred()
  try {
    scene.model.enqueue(backgroundBash('toolu_inturn', command))
    scene.model.enqueue(say('已在后台启动'))
    await runTurn(scene, '在后台启动一条短命令')

    // 第二回合的模型请求挂到命令结束之后才返回。
    scene.model.enqueue(async () => {
      await held.promise
      return [{ type: 'text', text: '第二回合的回答' }]
    })
    scene.model.fallback = (request) => {
      assert.ok(mentionsNotification(request))
      return [{ type: 'text', text: '知道命令结束了' }]
    }
    const { turn } = await scene.client.request('turn/start', {
      threadId: scene.threadId,
      input: [{ type: 'text', text: '第二回合' }],
    })
    await until('命令条目收尾', () => commandCompletions(scene).length === 1)
    held.resolve()
    const completed = await scene.client.completed(turn.id)
    assert.equal(completed.status, 'completed')
    // 回合要等通知触发的那一轮也跑完才结束。
    assert.ok(scene.model.requests.some(mentionsNotification), '通知应送到模型')
    await new Promise((resolve) => setTimeout(resolve, 3_000))
    assert.equal(turnsStarted(scene).length, 2, '通知并入用户回合，不另开回合')
    const turns = await readTurns(scene)
    assert.match(JSON.stringify(turns[1].items), /第二回合的回答/)
    assert.match(JSON.stringify(turns[1].items), /知道命令结束了/)
  } finally {
    held.resolve()
    await disposeScene(scene)
  }
})

test('命令在回合中途结束、通知随后面的请求送达：回合照常结束，不为通知多等', {
  timeout: 90_000,
}, async () => {
  const scene = await startScene('native-bg-folded')
  try {
    // 读文件之后的钩子把主循环拖住 3 秒，后台命令在这期间结束。CLI 取走待办的结束通知，
    // 随读文件的结果一起送给模型，不再为它另起一轮；SDK 流里对此没有记号。
    await mkdir(join(scene.workspace, '.claude'))
    await writeFile(
      join(scene.workspace, '.claude', 'settings.json'),
      JSON.stringify({
        hooks: {
          PostToolUse: [
            { matcher: 'Read', hooks: [{ type: 'command', command: 'sleep 3', timeout: 30 }] },
          ],
        },
      }),
    )
    const readme = join(scene.workspace, 'README.md')
    await writeFile(readme, 'folded\n')
    scene.model.enqueue(backgroundBash('toolu_folded', 'sleep 1 && echo FOLDED_DONE'))
    scene.model.enqueue(() => [
      { type: 'tool_use', id: 'toolu_folded_read', name: 'Read', input: { file_path: readme } },
    ])
    // 之后还有几次请求由 CLI 定（通知随工具结果送达是一次），这里只记最后一次到达的时间。
    let lastRequestAt = 0
    scene.model.fallback = () => {
      lastRequestAt = Date.now()
      return [{ type: 'text', text: '读完了，命令也结束了' }]
    }
    const { turn } = await scene.client.request('turn/start', {
      threadId: scene.threadId,
      input: [{ type: 'text', text: '在后台启动一条短命令，再读一下 README' }],
    })
    const completed = await scene.client.completed(turn.id)
    const waited = Date.now() - lastRequestAt
    assert.equal(completed.status, 'completed')
    assert.ok(
      scene.model.requests.slice(2).some(mentionsNotification),
      '通知应在这个回合里送到模型',
    )
    // 通知到达已久，它触发的那一轮不会再来：回合结束时不该再等那两秒。
    assert.ok(waited < 1_500, `最后一次模型请求之后过了 ${waited} 毫秒回合才结束`)
    const [ended] = commandCompletions(scene)
    assert.equal(ended?.item.status, 'completed')
    assert.match(ended?.item.aggregatedOutput ?? '', /FOLDED_DONE/)
    await new Promise((resolve) => setTimeout(resolve, 3_000))
    assert.equal(turnsStarted(scene).length, 1, '通知已在这个回合里处理，不另开回合')
  } finally {
    await disposeScene(scene)
  }
})

test('两条后台命令同时结束：只产生一个自行续跑的回合', { timeout: 90_000 }, async () => {
  const scene = await startScene('native-bg-pair', { CHA_CLAUDE_KEEP_ALIVE_IDLE_SECONDS: '0' })
  const suffix = String(process.hrtime.bigint()).slice(-6)
  const both = deferred()
  try {
    scene.model.enqueue(() => [
      {
        type: 'tool_use',
        id: 'toolu_pair_a',
        name: 'Bash',
        input: { command: `sleep 2.${suffix}`, run_in_background: true, description: 'a' },
      },
      {
        type: 'tool_use',
        id: 'toolu_pair_b',
        name: 'Bash',
        input: { command: `sleep 2.${suffix}`, run_in_background: true, description: 'b' },
      },
    ])
    scene.model.enqueue(say('两条都启动了'))
    // 两条命令结束的先后差多少由机器决定，慢的时候差得出一整轮模型请求：前一条的通知引出的回合
    // 已经结束，后一条的通知就只能另起一个回合。所以等两条的通知都到了 CLI 手里再回话，
    // 后到的那条不管是同一批到的还是晚一步到的，都只能并进这个回合
    scene.model.fallback = async () => {
      await both.promise
      return [{ type: 'text', text: '知道了' }]
    }
    const first = await runTurn(scene, '启动两条后台命令')
    const tree = adapterTree(scene).map((row) => row.pid)
    await until('两条命令的条目都收尾', () => commandCompletions(scene).length === 2)
    both.resolve()
    for (const completion of commandCompletions(scene)) {
      assert.equal(completion.turnId, first.id)
      assert.equal(completion.item.status, 'completed')
    }
    await until('自行续跑的回合开始', () => turnsStarted(scene).length >= 2)
    await scene.client.completed(turnsStarted(scene)[1] as string)
    assert.deepEqual(await survivors(tree, 10_000), [], '全部结束后进程应退出')
    assert.equal(turnsStarted(scene).length, 2, '两条通知合成一个回合')
    const turns = await readTurns(scene)
    assert.equal(turns.length, 2)
    assert.match(JSON.stringify(turns[1].items), /知道了/)
  } finally {
    both.resolve()
    await disposeScene(scene)
  }
})

test('回合之间改模型：下一回合的请求用新模型，进程不重启，后台命令还在', {
  timeout: 90_000,
}, async () => {
  const scene = await startScene('native-bg-model')
  const command = uniqueSleep(60)
  try {
    scene.model.enqueue(backgroundBash('toolu_model', command))
    scene.model.enqueue(say('已在后台启动'))
    await runTurn(scene, '在后台启动一条长命令')
    const [cli] = cliProcesses(scene)
    assert.ok(cli)
    const before = String(scene.model.requests.at(-1)?.model)

    scene.model.enqueue(say('换了模型'))
    const { turn } = await scene.client.request('turn/start', {
      threadId: scene.threadId,
      input: [{ type: 'text', text: '用另一个模型回答' }],
      model: 'claude-opus-4-8',
      effort: 'low',
    })
    assert.equal((await scene.client.completed(turn.id)).status, 'completed')
    const after = String(scene.model.requests.at(-1)?.model)
    assert.notEqual(after, before, '模型应已切换')
    assert.match(after, /opus/)
    assert.deepEqual(
      cliProcesses(scene).map((row) => row.pid),
      [cli.pid],
      '改模型不需要重启进程',
    )
    assert.equal(commandAlive(command), true)
  } finally {
    await disposeScene(scene)
  }
})

test('回合之间改工作目录：进程重启，后台命令停止并说明原因', { timeout: 90_000 }, async () => {
  const scene = await startScene('native-bg-restart')
  const command = uniqueSleep(60)
  try {
    scene.model.enqueue(backgroundBash('toolu_restart', command))
    scene.model.enqueue(say('已在后台启动'))
    const first = await runTurn(scene, '在后台启动一条长命令')
    const [cli] = cliProcesses(scene)
    assert.ok(cli)

    scene.model.enqueue(say('换了目录'))
    const { turn } = await scene.client.request('turn/start', {
      threadId: scene.threadId,
      input: [{ type: 'text', text: '换个目录继续' }],
      cwd: scene.home,
    })
    assert.equal((await scene.client.completed(turn.id)).status, 'completed')
    assert.equal(commandAlive(command), false, '旧进程连同后台命令一起结束')
    assert.deepEqual(await survivors([cli.pid], 3_000), [])
    const [completion] = commandCompletions(scene)
    assert.equal(completion?.turnId, first.id)
    assert.equal(completion?.item.status, 'failed')
    const warning = scene.client.trace.find(
      (message) => message.method === 'warning' && /重新启动/.test(message.params.message),
    )
    assert.ok(warning, '应告诉用户后台命令为什么停了')
    assert.deepEqual(await listTerminals(scene), [])
  } finally {
    await disposeScene(scene)
  }
})
