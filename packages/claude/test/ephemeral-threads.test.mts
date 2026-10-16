import assert from 'node:assert/strict'
import { join } from 'node:path'
import test from 'node:test'
import { CodexClaudeAppServer } from '../src/server.mjs'
import { SessionStore } from '../src/store.mjs'
import type { ClaudeRuntime } from '../src/types.mjs'
import {
  type Connection,
  openStage,
  type Stage,
  sayAndFinish,
  type TurnScript,
} from './fixtures/in-process.mjs'

// 临时会话（ephemeral）照上游的语义（rust-v0.162.0-alpha.20 的 thread_processor.rs）：
// 只有请求里带了 ephemeral: true 的新建、分叉才是临时的；应答和 thread/started 里如实写着，
// 不进 thread/list，会话级的通知只给订阅着它的连接（根 AGENTS.md 的约定）。

const text = (value: string) => [{ type: 'text', text: value }]
const settle = () => new Promise((resolve) => setTimeout(resolve, 30))

async function withStage(name: string, run: (stage: Stage) => Promise<void>): Promise<void> {
  const stage = await openStage(name)
  try {
    await run(stage)
  } finally {
    await stage.dispose()
  }
}

// 一条连接收到的、关于某个会话的通知（thread/started 的会话号在 thread 里）。
const about = (connection: Connection, threadId: string, from = 0) =>
  connection.trace
    .slice(from)
    .filter((message) => message.method && message.id === undefined)
    .filter(
      (message) => message.params?.threadId === threadId || message.params?.thread?.id === threadId,
    )

// 一个说过一句话的普通会话，分叉要有东西可带。
async function talkedThread(stage: Stage, owner: Connection): Promise<string> {
  const { thread } = await owner.request('thread/start', { cwd: stage.directory })
  stage.script = sayAndFinish('好的')
  const { turn } = await owner.request('turn/start', {
    threadId: thread.id,
    input: text('出个计划'),
  })
  assert.equal((await owner.completed(turn.id)).status, 'completed')
  return thread.id
}

const listed = async (connection: Connection): Promise<string[]> =>
  (await connection.request('thread/list', {})).data.map((thread: { id: string }) => thread.id)

test('EPH-001：侧聊那样带 ephemeral 的分叉是临时会话：应答、新建通知里如实写着，别的连接收不到、列表里没有', async () => {
  await withStage('ephemeral-fork', async (stage) => {
    const owner = await stage.connect('owner')
    const bystander = await stage.connect('bystander')
    const parent = await talkedThread(stage, owner)
    await settle()
    const mark = bystander.trace.length
    // 官方桌面端开侧聊时的分叉（照解包代码里的参数形状）
    const side = await owner.request('thread/fork', {
      threadId: parent,
      cwd: stage.directory,
      threadSource: 'user',
      developerInstructions: '你在一段侧聊里',
      excludeTurns: true,
      ephemeral: true,
    })
    const sideId: string = side.thread.id
    assert.equal(side.thread.ephemeral, true, '应答里的会话是临时的')
    await settle()
    const started = owner
      .notifications('thread/started')
      .find((message) => message.params.thread.id === sideId)
    assert.ok(started, '分叉的连接收到新建通知')
    assert.equal(started.params.thread.ephemeral, true, '新建通知里的会话是临时的')
    assert.deepEqual(about(bystander, sideId, mark), [], '别的连接收不到临时会话的任何通知')
    assert.ok(!(await listed(bystander)).includes(sideId), '临时会话不进 thread/list')
    assert.equal(
      (await bystander.request('thread/read', { threadId: sideId })).thread.ephemeral,
      true,
      '读到的也是临时的',
    )

    // 上游只看这一次请求带没带 ephemeral：从临时会话分出来、没要临时的，就是普通会话
    const kept = await owner.request('thread/fork', { threadId: sideId, cwd: stage.directory })
    assert.equal(kept.thread.ephemeral, false, '没要临时的分叉不跟着源会话变成临时的')
    await settle()
    assert.ok(
      bystander
        .notifications('thread/started')
        .some((message) => message.params.thread.id === kept.thread.id),
      '普通分叉照旧发给所有连接',
    )
    assert.ok((await listed(bystander)).includes(kept.thread.id))
    assert.ok((await listed(bystander)).includes(parent), '源会话还在列表里')
    assert.ok(!(await listed(bystander)).includes(sideId))
  })
})

// 官方桌面端（26.1007）改名之后给会话起一句描述：从会话分出一个临时会话，带的是它自己的生成模型（gpt-*），
// 在里面跑一个带 outputSchema 的回合，取最后一条回答当 JSON 读出 description，然后退订。分叉失败时它不另起会话，
// 就没有描述。下面的参数照解包代码里的形状。
const DESCRIBE_SCHEMA = {
  type: 'object',
  properties: { description: { type: 'string', minLength: 1 } },
  required: ['description'],
  additionalProperties: false,
}

function describeFork(threadId: string, cwd: string): Record<string, unknown> {
  return {
    threadId,
    path: null,
    model: 'gpt-6-luna',
    modelProvider: null,
    serviceTier: null,
    cwd,
    approvalPolicy: 'never',
    permissions: ':read-only',
    runtimeWorkspaceRoots: [],
    config: { 'features.hooks': false, web_search: 'disabled', model_reasoning_effort: 'low' },
    ephemeral: true,
    excludeTurns: true,
    threadSource: 'thread_description',
  }
}

function describeTurn(threadId: string): Record<string, unknown> {
  return {
    threadId,
    clientUserMessageId: 'describe-1',
    input: text('给这个会话写一句描述'),
    cwd: null,
    approvalPolicy: null,
    permissions: ':read-only',
    runtimeWorkspaceRoots: [],
    model: null,
    effort: null,
    serviceTier: null,
    summary: 'none',
    personality: null,
    collaborationMode: null,
    outputSchema: DESCRIBE_SCHEMA,
  }
}

test('EPH-002：改名后起描述的临时分叉带着 Claude 认不出的模型，沿用源会话的模型跑完结构化回合', async () => {
  await withStage('ephemeral-describe', async (stage) => {
    const owner = await stage.connect('owner')
    const { thread } = await owner.request('thread/start', { cwd: stage.directory, model: 'opus' })
    const { turn } = await owner.request('turn/start', {
      threadId: thread.id,
      input: text('出个计划'),
    })
    assert.equal((await owner.completed(turn.id)).status, 'completed')

    const forked = await owner.raw('thread/fork', describeFork(thread.id, stage.directory))
    assert.equal(forked.error, undefined, JSON.stringify(forked.error))
    const describeId: string = forked.result.thread.id
    assert.equal(forked.result.thread.ephemeral, true)
    assert.equal(forked.result.model, 'opus', '沿用源会话的模型')
    assert.equal(forked.result.reasoningEffort, 'low')

    const used: Array<{ model: string | null; outputFormat: unknown }> = []
    stage.script = async (context, handlers) => {
      used.push({ model: context.model, outputFormat: context.outputFormat })
      const answer = JSON.stringify({ description: '出计划 拆步骤' })
      await handlers.onEvent({ type: 'text_delta', delta: answer })
      await handlers.onEvent({ type: 'completed', success: true, result: answer })
    }
    const described = await owner.request('turn/start', describeTurn(describeId))
    const completed = await owner.completed(described.turn.id)
    assert.equal(completed.status, 'completed', JSON.stringify(completed.error))
    assert.equal(used[0]?.model, 'opus', '结构化回合用源会话的模型')
    assert.ok(used[0]?.outputFormat, '输出格式交给了运行时')
    const answer = owner
      .notifications('item/completed')
      .filter((message) => message.params.threadId === describeId)
      .map((message) => message.params.item)
      .findLast((item) => item.type === 'agentMessage')
    assert.deepEqual(JSON.parse(answer.text), { description: '出计划 拆步骤' })
    await owner.request('thread/unsubscribe', { threadId: describeId })

    // 普通分叉要的还是这个模型：照旧拒绝，不悄悄换掉用户选的模型
    const persistent = await owner.raw('thread/fork', {
      ...describeFork(thread.id, stage.directory),
      ephemeral: false,
    })
    assert.equal(persistent.error?.code, -32602)
    assert.match(persistent.error?.message ?? '', /Codex 模型/)
  })
})

// 上游在会话没有订阅者、也不在跑了一阵之后卸载它（thread_lifecycle.rs，thread_unload_delay 默认 60 秒）；
// 临时会话没写过盘，卸载了就没了。这个入口照这个做，卸载时把库里的记录和 CLI 写下的会话记录一起删掉。
// 等多久由 CHA_CLAUDE_EPHEMERAL_UNLOAD_MS 定，下面的用例设成 0 或很短。

// 回合里 CLI 报出自己的会话号（真实运行时是 init 消息），再说一句话结束。
const withSession =
  (sessionId: string, reply: string): TurnScript =>
  async (context, handlers) => {
    await handlers.onEvent({ type: 'session', claudeSessionId: sessionId })
    await sayAndFinish(reply)(context, handlers)
  }

async function gone(connection: Connection, threadId: string): Promise<void> {
  const deadline = Date.now() + 5_000
  while (Date.now() < deadline) {
    const reply = await connection.raw('thread/read', { threadId })
    if (reply.error) {
      assert.equal(reply.error.message, `thread not found: ${threadId}`)
      return
    }
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error(`临时会话 ${threadId} 一直没卸载`)
}

async function withUnloadDelay(ms: number, run: () => Promise<void>): Promise<void> {
  const previous = process.env.CHA_CLAUDE_EPHEMERAL_UNLOAD_MS
  process.env.CHA_CLAUDE_EPHEMERAL_UNLOAD_MS = String(ms)
  try {
    await run()
  } finally {
    if (previous === undefined) delete process.env.CHA_CLAUDE_EPHEMERAL_UNLOAD_MS
    else process.env.CHA_CLAUDE_EPHEMERAL_UNLOAD_MS = previous
  }
}

test('EPH-003：临时会话最后一个订阅者退订之后卸载：读不到了，CLI 的会话记录也删了；普通会话退订了照旧在', async () => {
  await withUnloadDelay(0, () =>
    withStage('ephemeral-unsubscribe', async (stage) => {
      const owner = await stage.connect('owner')
      const parent = await talkedThread(stage, owner)
      // 起标题用的那种临时会话
      const { thread: helper } = await owner.request('thread/start', {
        cwd: stage.directory,
        ephemeral: true,
      })
      stage.script = withSession('title-session', '{"title":"出个计划"}')
      const titled = await owner.request('turn/start', {
        threadId: helper.id,
        input: text('起个标题'),
      })
      assert.equal((await owner.completed(titled.turn.id)).status, 'completed')
      assert.equal(
        (await owner.request('thread/unsubscribe', { threadId: helper.id })).status,
        'unsubscribed',
      )
      assert.ok(
        owner
          .notifications('thread/closed')
          .some((message) => message.params.threadId === helper.id),
        '退订的连接照旧收到关闭',
      )
      await gone(owner, helper.id)
      assert.deepEqual(stage.deletedSessions, [
        { sessionId: 'title-session', cwd: stage.directory },
      ])

      await owner.request('thread/unsubscribe', { threadId: parent })
      await settle()
      assert.equal(
        (await owner.request('thread/read', { threadId: parent })).thread.id,
        parent,
        '普通会话退订了照旧在',
      )
      assert.equal(stage.deletedSessions.length, 1, '普通会话的记录不动')
    }),
  )
})

test('EPH-004：开着侧聊的连接断开，侧聊卸载；别的连接还订阅着时不卸载', async () => {
  await withUnloadDelay(0, () =>
    withStage('ephemeral-disconnect', async (stage) => {
      const owner = await stage.connect('owner')
      const watcher = await stage.connect('watcher')
      const parent = await talkedThread(stage, owner)
      const side = await owner.request('thread/fork', {
        threadId: parent,
        cwd: stage.directory,
        excludeTurns: true,
        ephemeral: true,
      })
      const sideId: string = side.thread.id
      stage.script = withSession('side-session', '侧聊里说一句')
      const said = await owner.request('turn/start', { threadId: sideId, input: text('问一句') })
      assert.equal((await owner.completed(said.turn.id)).status, 'completed')
      // 另一条连接也订阅着：第一条断开不卸载
      await watcher.request('thread/resume', { threadId: sideId })
      owner.disconnect()
      await settle()
      assert.equal((await watcher.request('thread/read', { threadId: sideId })).thread.id, sideId)
      assert.deepEqual(stage.deletedSessions, [])
      watcher.disconnect()
      const reader = await stage.connect('reader')
      await gone(reader, sideId)
      assert.deepEqual(stage.deletedSessions, [{ sessionId: 'side-session', cwd: stage.directory }])
      assert.ok(
        (await reader.request('thread/list', {})).data.some((t: { id: string }) => t.id === parent),
        '源会话还在',
      )
    }),
  )
})

test('EPH-005：没人订阅时回合还在跑，跑完了再卸载；时限之内又订阅了就留着', async () => {
  await withUnloadDelay(0, () =>
    withStage('ephemeral-busy', async (stage) => {
      const owner = await stage.connect('owner')
      const { thread } = await owner.request('thread/start', {
        cwd: stage.directory,
        ephemeral: true,
      })
      let release!: () => void
      const gate = new Promise<void>((resolve) => {
        release = resolve
      })
      stage.script = async (context, handlers) => {
        await handlers.onEvent({ type: 'session', claudeSessionId: 'busy-session' })
        await gate
        await sayAndFinish('跑完了')(context, handlers)
      }
      await owner.request('turn/start', { threadId: thread.id, input: text('慢慢跑') })
      await owner.notification('turn/started')
      owner.disconnect()
      const reader = await stage.connect('reader')
      await new Promise((resolve) => setTimeout(resolve, 100))
      assert.equal(
        (await reader.request('thread/read', { threadId: thread.id })).thread.id,
        thread.id,
        '回合还在跑，不卸载',
      )
      release()
      await gone(reader, thread.id)
      assert.deepEqual(stage.deletedSessions, [{ sessionId: 'busy-session', cwd: stage.directory }])
    }),
  )
  await withUnloadDelay(300, () =>
    withStage('ephemeral-back', async (stage) => {
      const owner = await stage.connect('owner')
      const { thread } = await owner.request('thread/start', {
        cwd: stage.directory,
        ephemeral: true,
      })
      await owner.request('thread/unsubscribe', { threadId: thread.id })
      // 卸载之前又订阅了（上游在时限之内也能接着用）
      await owner.request('thread/resume', { threadId: thread.id })
      await new Promise((resolve) => setTimeout(resolve, 600))
      assert.equal(
        (await owner.request('thread/read', { threadId: thread.id })).thread.id,
        thread.id,
      )
    }),
  )
})

test('EPH-006：入口重启时，上次留下的临时会话（还没到时限就退出了）连同 CLI 的会话记录一起删掉', async () => {
  await withStage('ephemeral-leftover', async (stage) => {
    const owner = await stage.connect('owner')
    const parent = await talkedThread(stage, owner)
    const { thread: helper } = await owner.request('thread/start', {
      cwd: stage.directory,
      ephemeral: true,
    })
    stage.script = withSession('leftover-session', '标题')
    const titled = await owner.request('turn/start', {
      threadId: helper.id,
      input: text('起个标题'),
    })
    assert.equal((await owner.completed(titled.turn.id)).status, 'completed')
    await stage.server.stop()

    const deleted: Array<{ sessionId: string; cwd: string }> = []
    const runtime: ClaudeRuntime = {
      deleteSession: async (sessionId, cwd) => void deleted.push({ sessionId, cwd }),
      runTurn: async () => {},
      steer: async () => {},
      interrupt: async () => {},
      stop: async () => {},
    }
    const store = new SessionStore(join(stage.directory, 'state.sqlite'))
    const server = new CodexClaudeAppServer(store, runtime)
    try {
      assert.equal(store.getThread(helper.id), null, '临时会话的记录删了')
      assert.ok(store.getThread(parent), '普通会话照旧在')
      await new Promise((resolve) => setTimeout(resolve, 30))
      assert.deepEqual(deleted, [{ sessionId: 'leftover-session', cwd: stage.directory }])
    } finally {
      await server.stop()
    }
  })
})

test('EPH-007：退订分叉出来的会话就是退订了，不因为这条连接还看着源会话又被挂回去；侧聊这样退订之后照常卸载', async () => {
  await withUnloadDelay(0, () =>
    withStage('fork-unsubscribe', async (stage) => {
      const owner = await stage.connect('owner')
      const parent = await talkedThread(stage, owner)
      const kept = await owner.request('thread/fork', { threadId: parent, cwd: stage.directory })
      await owner.request('thread/unsubscribe', { threadId: kept.thread.id })
      await settle()
      const loaded: string[] = (await owner.request('thread/loaded/list', {})).data
      assert.ok(!loaded.includes(kept.thread.id), `退订了的分叉不再挂着：${loaded}`)
      assert.ok(loaded.includes(parent), '源会话照旧订阅着')

      // 官方桌面端关侧聊、起完描述都是这样：源会话还开着，只退订那个临时分叉
      const side = await owner.request('thread/fork', {
        threadId: parent,
        cwd: stage.directory,
        excludeTurns: true,
        ephemeral: true,
      })
      await owner.request('thread/unsubscribe', { threadId: side.thread.id })
      await gone(owner, side.thread.id)
      assert.equal(
        (await owner.request('thread/read', { threadId: kept.thread.id })).thread.id,
        kept.thread.id,
        '普通分叉照旧在',
      )
    }),
  )
})
