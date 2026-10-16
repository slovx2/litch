import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { claudeCliCommand } from './fixtures/claude-cli.mjs'
import { MockLLM, type ModelRequest } from './fixtures/mock-llm.mjs'
import { descendants, killAll } from './fixtures/process-tree.mjs'
import { ProtocolClient } from './fixtures/protocol-client.mjs'

const toolId = () => `toolu_${randomUUID().replace(/-/g, '').slice(0, 20)}`
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

// 追问回合里有两件事在同一个 CLI 进程里并发：被恢复的子代理作答，父会话带着 SendMessage 的工具结果
// 发下一次请求。子代理先结束，它的结束通知就随工具结果并进父会话的这次请求，整个回合 3 次模型请求；
// 父会话的请求先发出，通知另起一轮，共 4 次。先后由 CLI 内部时序决定，慢机器上两种都会出现，
// 所以追问回合的应答不能按固定次数排，要由用例把先后定下来。
type FollowUpOrder = 'parent-first' | 'child-first'
type FollowUp = { order: FollowUpOrder; parentAsked: () => void; afterParentAsked: Promise<void> }

// 父子请求可能交错到达，按请求内容路由而不是按到达顺序。
function subagentRouter(
  home: string,
  mode: 'background' | 'foreground',
  subDelayMs = 0,
  followUp?: FollowUp,
) {
  return async (request: ModelRequest) => {
    const messages = (request.messages ?? []) as Array<Record<string, any>>
    const first = JSON.stringify(messages[0]?.content ?? '')
    const lastAssistant = messages.map((message) => message.role).lastIndexOf('assistant')
    const tail = messages.slice(lastAssistant + 1)
    const tailText = JSON.stringify(tail)
    const tailHasToolResult = tail.some(
      (message) =>
        Array.isArray(message.content) &&
        message.content.some((block: any) => block.type === 'tool_result'),
    )
    if (first.includes('SUBAGENT_MAIN')) {
      if (lastAssistant < 0)
        return [
          { type: 'text', text: 'MAIN_BEFORE_AGENT' },
          {
            type: 'tool_use',
            id: toolId(),
            name: 'Agent',
            input: {
              description: '读取探针文件',
              prompt: 'SUBAGENT_CHILD 读取 a.txt 并返回内容',
              subagent_type: 'general-purpose',
              ...(mode === 'foreground' ? { run_in_background: false } : {}),
            },
          },
        ]
      // 追问回合：模型故意写错收件人并改写正文，适配器必须改回用户原文。
      if (tailText.includes('subagent-follow-up') && !tailHasToolResult)
        return [
          {
            type: 'tool_use',
            id: toolId(),
            name: 'SendMessage',
            input: { to: 'someone-else', message: 'PARAPHRASED_BY_MODEL' },
          },
        ]
      const notified = tailText.includes('task-notification')
      if (followUp && tailHasToolResult) {
        // 父会话拿到 SendMessage 的工具结果之后的收尾请求。
        if (followUp.order === 'parent-first') {
          if (notified)
            throw new Error('子代理的回答还没放行，结束通知不该出现在父会话的收尾请求里')
          followUp.parentAsked()
          return [{ type: 'text', text: 'MAIN_AFTER_TOOL_RESULT' }]
        }
        if (!notified)
          throw new Error('父会话发出收尾请求时子代理还没结束：钩子拖住父会话的时间不够')
        return [{ type: 'text', text: 'MAIN_AFTER_NOTIFICATION' }]
      }
      if (notified) {
        if (followUp?.order === 'child-first')
          throw new Error('结束通知已随工具结果送达，不该再另起一轮')
        return [{ type: 'text', text: 'MAIN_AFTER_NOTIFICATION' }]
      }
      if (tailHasToolResult) return [{ type: 'text', text: 'MAIN_AFTER_TOOL_RESULT' }]
      throw new Error('父会话收到未预期的请求')
    }
    if (first.includes('SUBAGENT_CHILD')) {
      if (lastAssistant < 0)
        return [
          { type: 'text', text: 'CHILD_TEXT_BEFORE_TOOL' },
          {
            type: 'tool_use',
            id: toolId(),
            name: 'Read',
            input: { file_path: join(home, 'a.txt') },
          },
        ]
      if (tailText.includes('CHILD_FOLLOWUP')) {
        if (tailText.includes('PARAPHRASED_BY_MODEL')) throw new Error('子代理收到的不是用户原文')
        // 回答扣到父会话的收尾请求发出之后，结束通知只能另起一轮。
        if (followUp?.order === 'parent-first') await followUp.afterParentAsked
        return [{ type: 'text', text: `CHILD_FOLLOWUP_ANSWER 此前共 ${messages.length} 条消息` }]
      }
      if (subDelayMs) await sleep(subDelayMs)
      return [{ type: 'text', text: 'CHILD_DONE 文件内容是 probe-file-content: 42' }]
    }
    throw new Error('收到无法归属的模型请求')
  }
}

// 按指定的先后排好追问回合的应答。parent-first：转交、子代理作答、父会话收尾、通知触发的续跑；
// child-first：转交、子代理作答、带着结束通知的父会话收尾。
function enqueueFollowUp(model: MockLLM, home: string, order: FollowUpOrder): void {
  let parentAsked!: () => void
  const afterParentAsked = new Promise<void>((resolve) => {
    parentAsked = resolve
  })
  const followUp: FollowUp = { order, parentAsked, afterParentAsked }
  for (let index = 0; index < (order === 'parent-first' ? 4 : 3); index++)
    model.enqueue(subagentRouter(home, 'foreground', 0, followUp))
}

// child-first 用：SendMessage 返回后先执行这个钩子，父会话晚几秒才发下一次请求，
// 被恢复的子代理在这期间答完并结束。
async function holdParentAfterSendMessage(home: string, seconds: number): Promise<void> {
  await mkdir(join(home, '.claude'), { recursive: true })
  await writeFile(
    join(home, '.claude', 'settings.json'),
    JSON.stringify({
      hooks: {
        PostToolUse: [
          {
            matcher: 'SendMessage',
            hooks: [{ type: 'command', command: `sleep ${seconds}`, timeout: 30 }],
          },
        ],
      },
    }),
  )
}

// 回合没有完成时，把它的错误和模型端记下的意外请求带进失败信息。
async function assertCompleted(client: ProtocolClient, model: MockLLM, turnId: string) {
  const turn = await client.completed(turnId)
  assert.equal(
    turn.status,
    'completed',
    JSON.stringify({ error: turn.error, unexpectedModelRequests: model.unexpected }),
  )
  return turn
}

async function childThreads(client: ProtocolClient, parentId: string) {
  const started = client.trace
    .filter((message) => message.method === 'thread/started')
    .map((message) => message.params.thread)
    .filter((thread) => thread.id !== parentId)
  return Promise.all(
    started.map(
      async (thread) =>
        (await client.request('thread/read', { threadId: thread.id, includeTurns: true })).thread,
    ),
  )
}

const agentTexts = (thread: any): string[] =>
  thread.turns.flatMap((turn: any) =>
    turn.items.filter((item: any) => item.type === 'agentMessage').map((item: any) => item.text),
  )

test('SUBAGENT-001：默认后台派出的子代理在父回合内等到真实结果', { timeout: 120_000 }, async () => {
  const home = await mkdtemp(join(tmpdir(), 'native-subagent-bg-'))
  await writeFile(join(home, 'a.txt'), 'probe-file-content: 42\n')
  const model = new MockLLM()
  const client = await ProtocolClient.start(home, await model.start())
  try {
    const { thread } = await client.request('thread/start', {
      cwd: home,
      sandbox: 'danger-full-access',
      approvalPolicy: 'never',
    })
    // 父 2 次 + 子 2 次 + 后台通知触发的父续跑 1 次。
    for (let index = 0; index < 5; index++) model.enqueue(subagentRouter(home, 'background', 1500))
    const { turn } = await client.request('turn/start', {
      threadId: thread.id,
      input: [{ type: 'text', text: 'SUBAGENT_MAIN 请派子代理读取 a.txt' }],
    })
    assert.equal((await client.completed(turn.id)).status, 'completed')
    const [child] = await childThreads(client, thread.id)
    assert.ok(child, '应创建子线程')
    assert.equal(child.turns.at(-1).status, 'completed')
    const texts = agentTexts(child)
    assert.equal(texts.at(-1), 'CHILD_DONE 文件内容是 probe-file-content: 42')
    assert.ok(!texts.join('\n').includes('Async agent launched'), '启动回执不能当作子代理结果')
    // 子线程必须先于父回合结束。
    const childDone = client.trace.findIndex(
      (message) => message.method === 'turn/completed' && message.params.threadId === child.id,
    )
    const parentDone = client.trace.findIndex(
      (message) => message.method === 'turn/completed' && message.params.threadId === thread.id,
    )
    assert.ok(childDone >= 0 && childDone < parentDone)
    const parent = (
      await client.request('thread/read', { threadId: thread.id, includeTurns: true })
    ).thread
    const parentTexts = agentTexts(parent)
    assert.ok(parentTexts.includes('MAIN_AFTER_TOOL_RESULT'))
    assert.ok(parentTexts.includes('MAIN_AFTER_NOTIFICATION'), '后台通知触发的续跑属于同一回合')
    assert.ok(!parentTexts.join('\n').includes('CHILD_'), '子代理文本不能混入父线程')
    const wait = parent.turns[0].items.find(
      (item: any) => item.type === 'collabAgentToolCall' && item.tool === 'wait',
    )
    assert.equal(wait.status, 'completed')
    model.assertConsumed()
  } finally {
    await client.close()
    await model.close()
    await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})

test('SUBAGENT-002：前台子代理结果不带内部包装，过程写入子线程', { timeout: 120_000 }, async () => {
  const home = await mkdtemp(join(tmpdir(), 'native-subagent-fg-'))
  await writeFile(join(home, 'a.txt'), 'probe-file-content: 42\n')
  const model = new MockLLM()
  const client = await ProtocolClient.start(home, await model.start())
  try {
    const { thread } = await client.request('thread/start', {
      cwd: home,
      sandbox: 'danger-full-access',
      approvalPolicy: 'never',
    })
    for (let index = 0; index < 4; index++) model.enqueue(subagentRouter(home, 'foreground'))
    const { turn } = await client.request('turn/start', {
      threadId: thread.id,
      input: [{ type: 'text', text: 'SUBAGENT_MAIN 请派子代理读取 a.txt' }],
    })
    assert.equal((await client.completed(turn.id)).status, 'completed')
    const [child] = await childThreads(client, thread.id)
    assert.ok(child, '应创建子线程')
    const texts = agentTexts(child)
    assert.equal(texts.at(-1), 'CHILD_DONE 文件内容是 probe-file-content: 42')
    assert.ok(!texts.join('\n').includes('Subagent hand-back'), '内部包装前缀不能出现在子线程')
    assert.deepEqual(
      texts,
      ['CHILD_TEXT_BEFORE_TOOL', 'CHILD_DONE 文件内容是 probe-file-content: 42'],
      '子代理的中间文本与最终结果各出现一次',
    )
    const items = child.turns[0].items
    const readIndex = items.findIndex(
      (item: any) => item.type !== 'userMessage' && item.type !== 'agentMessage',
    )
    assert.ok(readIndex > 0, '子代理的工具调用应投影到子线程')
    assert.equal(items[readIndex].status, 'completed')
    const parent = (
      await client.request('thread/read', { threadId: thread.id, includeTurns: true })
    ).thread
    assert.ok(!agentTexts(parent).join('\n').includes('CHILD_'), '子代理文本不能混入父线程')
    assert.ok(
      !parent.turns[0].items.some(
        (item: any) =>
          item.type !== 'collabAgentToolCall' &&
          item.type !== 'userMessage' &&
          JSON.stringify(item).includes('a.txt'),
      ),
      '子代理的工具调用不能混入父线程',
    )
    model.assertConsumed()
  } finally {
    await client.close()
    await model.close()
    await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})

test('SUBAGENT-003：新旧模型都向 CLI 暴露 TodoWrite 清单工具', { timeout: 120_000 }, async () => {
  const home = await mkdtemp(join(tmpdir(), 'native-todo-tools-'))
  const model = new MockLLM()
  const client = await ProtocolClient.start(home, await model.start())
  try {
    const { thread } = await client.request('thread/start', { cwd: home })
    model.enqueue(() => [
      {
        type: 'tool_use',
        id: toolId(),
        name: 'TodoWrite',
        input: {
          todos: [{ content: '第一步', status: 'in_progress', activeForm: '正在做第一步' }],
        },
      },
    ])
    model.enqueue(() => [{ type: 'text', text: 'TODO_DONE' }])
    const { turn } = await client.request('turn/start', {
      threadId: thread.id,
      input: [{ type: 'text', text: '列一个任务清单' }],
    })
    assert.equal((await client.completed(turn.id)).status, 'completed')
    const tools = ((model.requests[0]?.tools ?? []) as Array<{ name: string }>).map(
      (tool) => tool.name,
    )
    assert.ok(tools.includes('TodoWrite'), `CLI 应提供 TodoWrite，实际：${tools.join(',')}`)
    assert.ok(!tools.includes('TaskCreate'), '不应同时提供适配器未映射的 TaskCreate')
    const plan = await client.notification(
      'turn/plan/updated',
      (params) => params.turnId === turn.id,
    )
    assert.deepEqual(plan.plan, [{ step: '第一步', status: 'inProgress' }])
    // 工具真实执行成功，而不是被 CLI 以“无此工具”拒绝。
    const followUp = JSON.stringify(model.requests[1]?.messages.at(-1))
    assert.ok(!followUp.includes('No such tool'), followUp.slice(0, 400))
    model.assertConsumed()
  } finally {
    await client.close()
    await model.close()
    await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})

test('SUBAGENT-004：在子线程追问会带着子代理原有上下文继续', { timeout: 120_000 }, async () => {
  const home = await mkdtemp(join(tmpdir(), 'native-subagent-relay-'))
  await writeFile(join(home, 'a.txt'), 'probe-file-content: 42\n')
  const model = new MockLLM()
  const client = await ProtocolClient.start(home, await model.start())
  try {
    const { thread } = await client.request('thread/start', {
      cwd: home,
      sandbox: 'danger-full-access',
      approvalPolicy: 'never',
    })
    for (let index = 0; index < 4; index++) model.enqueue(subagentRouter(home, 'foreground'))
    const first = await client.request('turn/start', {
      threadId: thread.id,
      input: [{ type: 'text', text: 'SUBAGENT_MAIN 请派子代理读取 a.txt' }],
    })
    assert.equal((await client.completed(first.turn.id)).status, 'completed')
    const [child] = await childThreads(client, thread.id)
    assert.ok(child, '应创建子线程')
    await client.request('thread/resume', { threadId: child.id })
    enqueueFollowUp(model, home, 'parent-first')
    const followUp = await client.request('turn/start', {
      threadId: child.id,
      input: [{ type: 'text', text: 'CHILD_FOLLOWUP 刚才读到的数值是多少' }],
    })
    // 追问回合里再追加输入只会到主模型，必须明确拒绝而不是悄悄丢掉。
    const steer = await client.raw(
      'turn/steer',
      {
        threadId: child.id,
        expectedTurnId: followUp.turn.id,
        input: [{ type: 'text', text: '再补一句' }],
      },
      -32009,
    )
    assert.match(steer.error.message, /追问/)
    await assertCompleted(client, model, followUp.turn.id)
    // 追问回合自己的应答必须正好用完，剩下的会被父线程下一回合的请求吃掉。
    model.assertConsumed()
    const after = (await client.request('thread/read', { threadId: child.id, includeTurns: true }))
      .thread
    assert.equal(after.turns.length, 2)
    const answers = after.turns[1].items
      .filter((item: any) => item.type === 'agentMessage')
      .map((item: any) => item.text)
    assert.equal(answers.length, 1, '子线程只显示子代理自己的回答')
    const seen = /^CHILD_FOLLOWUP_ANSWER 此前共 (\d+) 条消息$/.exec(answers[0])
    assert.ok(seen, answers[0])
    assert.ok(Number(seen[1]) > 3, '子代理应带着此前的上下文被恢复')
    const parent = (
      await client.request('thread/read', { threadId: thread.id, includeTurns: true })
    ).thread
    assert.equal(parent.turns.length, 1, '追问不在父线程里新增回合')
    assert.ok(!JSON.stringify(parent).includes('CHILD_FOLLOWUP'))
    // 父线程随后仍能在同一会话上继续。
    model.enqueue(() => [{ type: 'text', text: 'MAIN_NEXT_TURN' }])
    const next = await client.request('turn/start', {
      threadId: thread.id,
      input: [{ type: 'text', text: '继续主任务' }],
    })
    await assertCompleted(client, model, next.turn.id)
    assert.ok(
      JSON.stringify(model.requests.at(-1)?.messages).includes('CHILD_FOLLOWUP_ANSWER'),
      '父会话应知道子代理追问的结果',
    )
    model.assertConsumed()
  } finally {
    await client.close()
    await model.close()
    await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})

test('SUBAGENT-010：父线程留着后台命令时在子线程追问，复用父线程的进程', {
  timeout: 120_000,
}, async () => {
  const home = await mkdtemp(join(tmpdir(), 'native-subagent-live-'))
  await writeFile(join(home, 'a.txt'), 'probe-file-content: 42\n')
  const model = new MockLLM()
  const client = await ProtocolClient.start(home, await model.start())
  const command = `sleep 60.${String(process.hrtime.bigint()).slice(-6)}`
  const cliPids = (): number[] =>
    descendants(client.process.pid as number)
      .filter((row) => row.command.startsWith(claudeCliCommand()))
      .map((row) => row.pid)
  const commandAlive = (): boolean =>
    descendants(client.process.pid as number).some((row) => row.command === command)
  try {
    const { thread } = await client.request('thread/start', {
      cwd: home,
      sandbox: 'danger-full-access',
      approvalPolicy: 'never',
    })
    for (let index = 0; index < 4; index++) model.enqueue(subagentRouter(home, 'foreground'))
    const first = await client.request('turn/start', {
      threadId: thread.id,
      input: [{ type: 'text', text: 'SUBAGENT_MAIN 请派子代理读取 a.txt' }],
    })
    assert.equal((await client.completed(first.turn.id)).status, 'completed')
    const [child] = await childThreads(client, thread.id)
    assert.ok(child, '应创建子线程')
    await client.request('thread/resume', { threadId: child.id })

    // 父线程起一条后台命令，回合结束后进程留下。
    model.enqueue(() => [
      {
        type: 'tool_use',
        id: toolId(),
        name: 'Bash',
        input: { command, run_in_background: true, description: 'background' },
      },
    ])
    model.enqueue(() => [{ type: 'text', text: 'MAIN_BACKGROUND_STARTED' }])
    const second = await client.request('turn/start', {
      threadId: thread.id,
      input: [{ type: 'text', text: '在后台启动一条长命令' }],
    })
    assert.equal((await client.completed(second.turn.id)).status, 'completed')
    const live = cliPids()
    assert.equal(live.length, 1, '父线程的进程应留下')
    assert.equal(commandAlive(), true)

    enqueueFollowUp(model, home, 'parent-first')
    const followUp = await client.request('turn/start', {
      threadId: child.id,
      input: [{ type: 'text', text: 'CHILD_FOLLOWUP 刚才读到的数值是多少' }],
    })
    await assertCompleted(client, model, followUp.turn.id)
    model.assertConsumed()
    assert.deepEqual(cliPids(), live, '追问没有另起进程')
    assert.equal(commandAlive(), true, '父线程的后台命令不受追问影响')
    const after = (await client.request('thread/read', { threadId: child.id, includeTurns: true }))
      .thread
    const answers = after.turns[1].items
      .filter((item: any) => item.type === 'agentMessage')
      .map((item: any) => item.text)
    assert.equal(answers.length, 1, '子线程只显示子代理自己的回答')
    assert.match(answers[0], /^CHILD_FOLLOWUP_ANSWER/)

    // 追问结束后父线程照常继续，普通回合不再受“只许转交”的限制。
    model.enqueue(() => [{ type: 'text', text: 'MAIN_NEXT_TURN' }])
    const next = await client.request('turn/start', {
      threadId: thread.id,
      input: [{ type: 'text', text: '继续主任务' }],
    })
    await assertCompleted(client, model, next.turn.id)
    assert.deepEqual(cliPids(), live)
    model.assertConsumed()
  } finally {
    const tree = descendants(client.process.pid as number).map((row) => row.pid)
    await client.close()
    await model.close()
    killAll(tree)
    await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})

test('SUBAGENT-005：父回合进行中或没有可恢复记录时，子线程拒绝接收输入', {
  timeout: 120_000,
}, async () => {
  const home = await mkdtemp(join(tmpdir(), 'native-subagent-busy-'))
  await writeFile(join(home, 'a.txt'), 'probe-file-content: 42\n')
  const model = new MockLLM()
  const client = await ProtocolClient.start(home, await model.start())
  try {
    const { thread } = await client.request('thread/start', {
      cwd: home,
      sandbox: 'danger-full-access',
      approvalPolicy: 'never',
    })
    for (let index = 0; index < 5; index++) model.enqueue(subagentRouter(home, 'background', 2500))
    const { turn } = await client.request('turn/start', {
      threadId: thread.id,
      input: [{ type: 'text', text: 'SUBAGENT_MAIN 请派子代理读取 a.txt' }],
    })
    const started = await client.notification(
      'thread/started',
      (params) => params.thread.id !== thread.id,
    )
    // 子代理仍在后台运行，父回合未结束：不能另起一个进程恢复同一个会话。
    await client.raw(
      'turn/start',
      { threadId: started.thread.id, input: [{ type: 'text', text: '插话' }] },
      -32009,
    )
    assert.equal((await client.completed(turn.id)).status, 'completed')
    model.assertConsumed()
  } finally {
    await client.close()
    await model.close()
    await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})

test('SUBAGENT-006：后台子代理运行期间中断，父子回合都结束且会话可继续', {
  timeout: 120_000,
}, async () => {
  const home = await mkdtemp(join(tmpdir(), 'native-subagent-stop-'))
  await writeFile(join(home, 'a.txt'), 'probe-file-content: 42\n')
  const model = new MockLLM()
  const client = await ProtocolClient.start(home, await model.start())
  try {
    const { thread } = await client.request('thread/start', {
      cwd: home,
      sandbox: 'danger-full-access',
      approvalPolicy: 'never',
    })
    // 父 2 次 + 子 2 次；子代理第二次请求挂起 20 秒，中断发生在它返回之前。
    for (let index = 0; index < 4; index++)
      model.enqueue(subagentRouter(home, 'background', 20_000))
    const { turn } = await client.request('turn/start', {
      threadId: thread.id,
      input: [{ type: 'text', text: 'SUBAGENT_MAIN 请派子代理读取 a.txt' }],
    })
    // 父回合在等后台子代理，这段正文还没有收尾，只能按增量判断它已经出现。
    await client.notification(
      'item/agentMessage/delta',
      (params) => params.threadId === thread.id && params.delta.includes('MAIN_AFTER_TOOL_RESULT'),
    )
    const child = await client.notification(
      'thread/started',
      (params) => params.thread.id !== thread.id,
    )
    await client.notification(
      'item/started',
      (params) => params.threadId === child.thread.id && params.item.type === 'mcpToolCall',
    )
    // 等子代理的第二次模型请求挂起后再中断，四个步骤恰好用完。
    for (let waited = 0; model.requests.length < 4; waited += 20) {
      assert.ok(waited < 15_000, '子代理没有发出第二次模型请求')
      await sleep(20)
    }
    const interruptedAt = Date.now()
    await client.request('turn/interrupt', { threadId: thread.id, turnId: turn.id })
    assert.equal((await client.completed(turn.id)).status, 'interrupted')
    assert.ok(Date.now() - interruptedAt < 10_000, '中断不应等后台子代理跑完')
    const [childThread] = await childThreads(client, thread.id)
    assert.notEqual(childThread.turns.at(-1).status, 'inProgress', '子线程回合不能悬着')
    assert.ok(!agentTexts(childThread).join('\n').includes('CHILD_DONE'))
    // 中断后同一会话还能继续。
    model.enqueue(async () => [{ type: 'text', text: 'AFTER_INTERRUPT_OK' }])
    const next = await client.request('turn/start', {
      threadId: thread.id,
      input: [{ type: 'text', text: '继续' }],
    })
    assert.equal((await client.completed(next.turn.id)).status, 'completed')
    const parent = (
      await client.request('thread/read', { threadId: thread.id, includeTurns: true })
    ).thread
    assert.ok(agentTexts(parent).includes('AFTER_INTERRUPT_OK'))
  } finally {
    await client.close()
    await model.close()
    await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})

// 桌面端不把打开之后的实时更新应用到临时线程：子线程带着临时标记时，运行中打开只能看到
// 打开那一刻的内容，摘要里一直是运行中。下面三个用例固定对应的协议行为。
const childNotifications = (client: ProtocolClient, childId: string, from: number) =>
  client.trace
    .slice(from)
    .filter((message) => message.method && message.params?.threadId === childId)

test('SUBAGENT-007：运行中打开的子线程不是临时线程，之后的正文、结束与空闲状态照常送达', {
  timeout: 120_000,
}, async () => {
  const home = await mkdtemp(join(tmpdir(), 'native-subagent-open-'))
  await writeFile(join(home, 'a.txt'), 'probe-file-content: 42\n')
  const model = new MockLLM()
  const client = await ProtocolClient.start(home, await model.start())
  try {
    const { thread } = await client.request('thread/start', {
      cwd: home,
      sandbox: 'danger-full-access',
      approvalPolicy: 'never',
    })
    for (let index = 0; index < 5; index++) model.enqueue(subagentRouter(home, 'background', 2500))
    const { turn } = await client.request('turn/start', {
      threadId: thread.id,
      input: [{ type: 'text', text: 'SUBAGENT_MAIN 请派子代理读取 a.txt' }],
    })
    const started = await client.notification(
      'thread/started',
      (params) => params.thread.id !== thread.id,
    )
    const childId = started.thread.id
    assert.equal(started.thread.ephemeral, false, '子线程不能标成临时线程')
    // 桌面在子代理运行中打开子线程时发的就是这个请求。
    const opened = await client.request('thread/resume', { threadId: childId })
    assert.equal(opened.thread.ephemeral, false)
    assert.equal(opened.thread.status.type, 'active', '打开时子代理应仍在运行')
    const openedAt = client.trace.length
    assert.equal((await client.completed(turn.id)).status, 'completed')
    const later = childNotifications(client, childId, openedAt)
    assert.ok(
      later.some(
        (message) =>
          message.method === 'item/completed' &&
          message.params.item.type === 'agentMessage' &&
          message.params.item.text === 'CHILD_DONE 文件内容是 probe-file-content: 42',
      ),
      '打开之后才写出的最后一段正文要以通知送达',
    )
    assert.ok(
      later.some(
        (message) =>
          message.method === 'turn/completed' && message.params.turn.status === 'completed',
      ),
      '子线程回合结束要以通知送达',
    )
    assert.ok(
      later.some(
        (message) =>
          message.method === 'thread/status/changed' && message.params.status.type === 'idle',
      ),
      '子线程变为空闲要以通知送达',
    )
    const child = (await client.request('thread/read', { threadId: childId, includeTurns: true }))
      .thread
    assert.equal(child.ephemeral, false)
    assert.equal(child.status.type, 'idle')
    const parent = (
      await client.request('thread/read', { threadId: thread.id, includeTurns: true })
    ).thread
    const wait = parent.turns[0].items.find(
      (item: any) => item.type === 'collabAgentToolCall' && item.tool === 'wait',
    )
    assert.equal(
      wait.agentsStates[childId].status,
      'completed',
      '父线程里子代理的状态不能停在运行中',
    )
    model.assertConsumed()
  } finally {
    await client.close()
    await model.close()
    await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})

test('SUBAGENT-008：追问的回答送到非临时的子线程，子线程的名字前后一致', {
  timeout: 120_000,
}, async () => {
  const home = await mkdtemp(join(tmpdir(), 'native-subagent-name-'))
  await writeFile(join(home, 'a.txt'), 'probe-file-content: 42\n')
  const model = new MockLLM()
  const client = await ProtocolClient.start(home, await model.start())
  try {
    const { thread } = await client.request('thread/start', {
      cwd: home,
      sandbox: 'danger-full-access',
      approvalPolicy: 'never',
    })
    for (let index = 0; index < 4; index++) model.enqueue(subagentRouter(home, 'foreground'))
    const first = await client.request('turn/start', {
      threadId: thread.id,
      input: [{ type: 'text', text: 'SUBAGENT_MAIN 请派子代理读取 a.txt' }],
    })
    assert.equal((await client.completed(first.turn.id)).status, 'completed')
    const started = await client.notification(
      'thread/started',
      (params) => params.thread.id !== thread.id,
    )
    const childId = started.thread.id
    // 标签页用的是子线程出现时的名字，列表行用的是之后读到的名字，两处必须是同一个。
    const nickname = started.thread.agentNickname
    assert.match(nickname, /^agent-[0-9a-f]{12}$/)
    const sameName = (value: any, where: string) => {
      assert.equal(value.agentNickname, nickname, `${where}的昵称变了`)
      assert.equal(value.source.subAgent.thread_spawn.agent_nickname, nickname, where)
      assert.equal(value.ephemeral, false, `${where}被标成临时线程`)
    }
    sameName(
      (await client.request('thread/read', { threadId: childId, includeTurns: false })).thread,
      '结束后读取',
    )
    // 桌面在子线程回合结束后会重新恢复它。
    sameName((await client.request('thread/resume', { threadId: childId })).thread, '恢复')
    enqueueFollowUp(model, home, 'parent-first')
    const askedAt = client.trace.length
    const followUp = await client.request('turn/start', {
      threadId: childId,
      input: [{ type: 'text', text: 'CHILD_FOLLOWUP 刚才读到的数值是多少' }],
    })
    await assertCompleted(client, model, followUp.turn.id)
    const later = childNotifications(client, childId, askedAt)
    assert.ok(
      later.some(
        (message) =>
          message.method === 'item/completed' &&
          message.params.turnId === followUp.turn.id &&
          message.params.item.type === 'agentMessage' &&
          /^CHILD_FOLLOWUP_ANSWER /.test(message.params.item.text),
      ),
      '追问的回答要以通知送到子线程',
    )
    sameName(
      (await client.request('thread/read', { threadId: childId, includeTurns: false })).thread,
      '追问后读取',
    )
    const listed = await client.request('thread/list', {
      parentThreadId: thread.id,
      sourceKinds: ['subAgentThreadSpawn'],
    })
    assert.deepEqual(
      listed.data.map((item: any) => item.id),
      [childId],
    )
    sameName(listed.data[0], '列表')
    model.assertConsumed()
  } finally {
    await client.close()
    await model.close()
    await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})

test('SUBAGENT-009：默认线程列表不含子线程，按父线程、祖先或来源才查得到', {
  timeout: 120_000,
}, async () => {
  const home = await mkdtemp(join(tmpdir(), 'native-subagent-list-'))
  await writeFile(join(home, 'a.txt'), 'probe-file-content: 42\n')
  const model = new MockLLM()
  const client = await ProtocolClient.start(home, await model.start())
  try {
    const { thread } = await client.request('thread/start', {
      cwd: home,
      sandbox: 'danger-full-access',
      approvalPolicy: 'never',
    })
    for (let index = 0; index < 4; index++) model.enqueue(subagentRouter(home, 'foreground'))
    const { turn } = await client.request('turn/start', {
      threadId: thread.id,
      input: [{ type: 'text', text: 'SUBAGENT_MAIN 请派子代理读取 a.txt' }],
    })
    assert.equal((await client.completed(turn.id)).status, 'completed')
    const [child] = await childThreads(client, thread.id)
    assert.ok(child, '应创建子线程')
    const ids = async (params: Record<string, unknown>) =>
      (await client.request('thread/list', params)).data.map((item: any) => item.id)
    // 与 Codex 原生一致：不指定来源或来源为空时只列用户自己的线程。
    assert.deepEqual(await ids({}), [thread.id])
    assert.deepEqual(await ids({ sourceKinds: [], archived: false, modelProviders: null }), [
      thread.id,
    ])
    // 桌面查子代理时固定带来源，按父线程或祖先线程查。
    const spawn = ['subAgentThreadSpawn']
    assert.deepEqual(await ids({ parentThreadId: thread.id, sourceKinds: spawn }), [child.id])
    assert.deepEqual(await ids({ ancestorThreadId: thread.id, sourceKinds: spawn }), [child.id])
    assert.deepEqual(await ids({ sourceKinds: spawn }), [child.id])
    // 按关系查且不指定来源时不限来源；来源给了空数组则仍只列用户自己的线程。
    assert.deepEqual(await ids({ parentThreadId: thread.id }), [child.id])
    assert.deepEqual(await ids({ parentThreadId: thread.id, sourceKinds: [] }), [])
    const both = await client.raw(
      'thread/list',
      { parentThreadId: thread.id, ancestorThreadId: thread.id },
      -32600,
    )
    assert.match(both.error.message, /parentThreadId/)
    model.assertConsumed()
  } finally {
    await client.close()
    await model.close()
    await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})

// 慢机器上被恢复的子代理会先于父会话的收尾请求结束：结束通知不再另起一轮，而是随 SendMessage 的
// 工具结果一起送到父会话，整个追问回合少一次模型请求。结果必须与另一种先后（SUBAGENT-004）相同。
test('SUBAGENT-011：子代理先于父会话收尾结束时，追问照常完成，父线程可继续', {
  timeout: 120_000,
}, async () => {
  const home = await mkdtemp(join(tmpdir(), 'native-subagent-fold-'))
  await writeFile(join(home, 'a.txt'), 'probe-file-content: 42\n')
  await holdParentAfterSendMessage(home, 2)
  const model = new MockLLM()
  const client = await ProtocolClient.start(home, await model.start())
  try {
    const { thread } = await client.request('thread/start', {
      cwd: home,
      sandbox: 'danger-full-access',
      approvalPolicy: 'never',
    })
    for (let index = 0; index < 4; index++) model.enqueue(subagentRouter(home, 'foreground'))
    const first = await client.request('turn/start', {
      threadId: thread.id,
      input: [{ type: 'text', text: 'SUBAGENT_MAIN 请派子代理读取 a.txt' }],
    })
    await assertCompleted(client, model, first.turn.id)
    const [child] = await childThreads(client, thread.id)
    assert.ok(child, '应创建子线程')
    await client.request('thread/resume', { threadId: child.id })
    const before = model.requests.length
    enqueueFollowUp(model, home, 'child-first')
    const followUp = await client.request('turn/start', {
      threadId: child.id,
      input: [{ type: 'text', text: 'CHILD_FOLLOWUP 刚才读到的数值是多少' }],
    })
    await assertCompleted(client, model, followUp.turn.id)
    model.assertConsumed()
    assert.equal(model.requests.length - before, 3, '结束通知随工具结果送达，不另起一轮')
    const wrapUp = JSON.stringify(model.requests.at(-1)?.messages.at(-1))
    assert.match(wrapUp, /tool_result/)
    assert.match(wrapUp, /task-notification/)
    const after = (await client.request('thread/read', { threadId: child.id, includeTurns: true }))
      .thread
    assert.equal(after.turns.length, 2)
    const answers = after.turns[1].items
      .filter((item: any) => item.type === 'agentMessage')
      .map((item: any) => item.text)
    assert.equal(answers.length, 1, '子线程只显示子代理自己的回答')
    assert.match(answers[0], /^CHILD_FOLLOWUP_ANSWER 此前共 \d+ 条消息$/)
    const parent = (
      await client.request('thread/read', { threadId: thread.id, includeTurns: true })
    ).thread
    assert.equal(parent.turns.length, 1, '追问不在父线程里新增回合')
    assert.ok(!JSON.stringify(parent).includes('CHILD_FOLLOWUP'))
    // 父线程随后仍能在同一会话上继续，并且知道追问的结果。
    model.enqueue(() => [{ type: 'text', text: 'MAIN_NEXT_TURN' }])
    const next = await client.request('turn/start', {
      threadId: thread.id,
      input: [{ type: 'text', text: '继续主任务' }],
    })
    await assertCompleted(client, model, next.turn.id)
    assert.ok(
      JSON.stringify(model.requests.at(-1)?.messages).includes('CHILD_FOLLOWUP_ANSWER'),
      '父会话应知道子代理追问的结果',
    )
    model.assertConsumed()
  } finally {
    await client.close()
    await model.close()
    await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})
