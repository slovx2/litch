import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { MockLLM, type ModelRequest } from './fixtures/mock-llm.mjs'
import { ProtocolClient } from './fixtures/protocol-client.mjs'

// 子代理看门狗按每个子代理“多久没有动静”算：子代理一直在干活（工具调用、正文），总时长超过时限也不算失联；
// 一点动静都没有满了时限，Litch 只停那一个，回合和别的子代理照常。主模型用 SendMessage 续跑已结束的子代理时，续跑的过程进子线程的
// 一个新回合，也归看门狗管。真实 CLI 加回环上的假模型，看门狗时限用环境变量调小。

const toolId = () => `toolu_${randomUUID().replace(/-/g, '').slice(0, 20)}`
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

type Messages = Array<Record<string, any>>

const toolResults = (messages: Messages): number =>
  messages.filter(
    (message) =>
      Array.isArray(message.content) &&
      message.content.some((block: any) => block.type === 'tool_result'),
  ).length

// 子代理每一步跑一条 sleep 1 的命令，steps 步之后回答；父会话派出它、拿到结果后收尾。
function busyChild(steps: number, background: boolean) {
  return (request: ModelRequest) => {
    const messages = (request.messages ?? []) as Messages
    const first = JSON.stringify(messages[0]?.content ?? '')
    const all = JSON.stringify(messages)
    if (first.includes('BUSY_CHILD')) {
      if (toolResults(messages) < steps)
        return [{ type: 'tool_use', id: toolId(), name: 'Bash', input: { command: 'sleep 1' } }]
      return [{ type: 'text', text: 'CHILD_DONE' }]
    }
    if (!all.includes('"Agent"'))
      return [
        {
          type: 'tool_use',
          id: toolId(),
          name: 'Agent',
          input: {
            description: '一直在干活',
            prompt: 'BUSY_CHILD 跑几条命令',
            subagent_type: 'general-purpose',
            ...(background ? {} : { run_in_background: false }),
          },
        },
      ]
    return [{ type: 'text', text: 'MAIN_DONE' }]
  }
}

async function scene(timeoutMs: number) {
  const home = await mkdtemp(join(tmpdir(), 'native-subagent-activity-'))
  await writeFile(join(home, 'a.txt'), 'probe-file-content\n')
  const model = new MockLLM()
  const client = await ProtocolClient.start(home, await model.start(), false, 'api-key', {
    CHA_CLAUDE_SUBAGENT_TIMEOUT_MS: String(timeoutMs),
  })
  const { thread } = await client.request('thread/start', {
    cwd: home,
    sandbox: 'danger-full-access',
    approvalPolicy: 'never',
  })
  const dispose = async () => {
    await client.close()
    await model.close()
    await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
  return { home, model, client, threadId: thread.id as string, dispose }
}

async function readThread(client: ProtocolClient, threadId: string) {
  return (await client.request('thread/read', { threadId, includeTurns: true })).thread
}

function childThreadId(client: ProtocolClient, parentId: string): string {
  const started = client.trace.find(
    (message) => message.method === 'thread/started' && message.params.thread.id !== parentId,
  )
  assert.ok(started, '应建出子线程')
  return started.params.thread.id
}

for (const background of [false, true])
  test(`ACTIVITY-00${background ? 2 : 1}：${background ? '后台' : '前台'}子代理一直有动静，总时长超过看门狗时限也照常完成`, {
    timeout: 120_000,
  }, async () => {
    // 时限 3 秒，子代理跑 5 条 sleep 1：总时长 6 秒左右，任意两次动静之间不到 3 秒。
    const s = await scene(3000)
    try {
      s.model.fallback = busyChild(5, background)
      const started = Date.now()
      const { turn } = await s.client.request('turn/start', {
        threadId: s.threadId,
        input: [{ type: 'text', text: 'BUSY_MAIN 派子代理' }],
      })
      const done = await s.client.completed(turn.id)
      assert.equal(done.status, 'completed', JSON.stringify(done.error))
      assert.ok(Date.now() - started > 3000, '用例要让子代理的总时长超过看门狗时限')
      const child = await readThread(s.client, childThreadId(s.client, s.threadId))
      assert.equal(child.turns.at(-1).status, 'completed')
    } finally {
      await s.dispose()
    }
  })

test('ACTIVITY-003：前台子代理一点动静都没有，满了时限 Litch 只停它：子线程失败，主模型接着做完', {
  timeout: 120_000,
}, async () => {
  const s = await scene(2000)
  try {
    const busy = busyChild(0, false)
    const seen: string[] = []
    s.model.fallback = async (request) => {
      const first = JSON.stringify((request.messages as Messages)[0]?.content ?? '')
      // 子代理的模型请求一直不回：没有任何动静
      if (first.includes('BUSY_CHILD')) await sleep(20_000)
      if (JSON.stringify(request.messages).includes('Litch stopped the subagent')) seen.push('note')
      return busy(request)
    }
    const started = Date.now()
    const { turn } = await s.client.request('turn/start', {
      threadId: s.threadId,
      input: [{ type: 'text', text: 'BUSY_MAIN 派子代理' }],
    })
    const done = await s.client.completed(turn.id)
    assert.equal(done.status, 'completed', JSON.stringify(done.error))
    assert.ok(Date.now() - started < 18_000, '不该等到子代理自己回来')
    assert.ok(seen.includes('note'), '主模型应收到 Litch 停掉子代理的说明')
    const child = await readThread(s.client, childThreadId(s.client, s.threadId))
    assert.equal(child.turns.at(-1).status, 'failed')
    assert.match(JSON.stringify(child.turns.at(-1).error), /Litch stopped this subagent/)
  } finally {
    await s.dispose()
  }
})

test('ACTIVITY-004：两个后台子代理一个没动静，看门狗只停它；另一个照常做完，回合不失败，主模型知道是 Litch 停的', {
  timeout: 120_000,
}, async () => {
  // 时限 2.5 秒：SILENT 的头一次模型请求 20 秒不回；BUSY 跑 5 条 sleep 1，一直有动静
  const s = await scene(2500)
  try {
    const busy = busyChild(5, true)
    const seen: string[] = []
    s.model.fallback = async (request) => {
      const messages = (request.messages ?? []) as Messages
      const first = JSON.stringify(messages[0]?.content ?? '')
      const all = JSON.stringify(messages)
      if (first.includes('SILENT_CHILD')) {
        await sleep(20_000)
        return [{ type: 'text', text: 'SILENT_DONE' }]
      }
      if (first.includes('BUSY_CHILD')) return busy(request)
      if (!all.includes('"Agent"'))
        return [
          {
            type: 'tool_use',
            id: toolId(),
            name: 'Agent',
            input: {
              description: '没动静',
              prompt: 'SILENT_CHILD 等着',
              subagent_type: 'general-purpose',
            },
          },
          {
            type: 'tool_use',
            id: toolId(),
            name: 'Agent',
            input: {
              description: '一直在干活',
              prompt: 'BUSY_CHILD 跑几条命令',
              subagent_type: 'general-purpose',
            },
          },
        ]
      if (all.includes('Litch stopped the subagent')) seen.push('note')
      return [{ type: 'text', text: 'MAIN_OK' }]
    }
    const started = Date.now()
    const { turn } = await s.client.request('turn/start', {
      threadId: s.threadId,
      input: [{ type: 'text', text: 'TWO_MAIN 派两个子代理' }],
    })
    const done = await s.client.completed(turn.id)
    assert.equal(done.status, 'completed', JSON.stringify(done.error))
    assert.ok(Date.now() - started < 18_000, '没动静的子代理应被单独停掉，不该等到它自己回来')
    assert.ok(seen.includes('note'), '主模型应收到 Litch 停掉子代理的说明')
    const children = s.client.trace
      .filter(
        (message) => message.method === 'thread/started' && message.params.thread.id !== s.threadId,
      )
      .map((message) => message.params.thread.id as string)
    assert.equal(children.length, 2)
    const turns = await Promise.all(
      children.map(async (id) => (await readThread(s.client, id)).turns.at(-1)),
    )
    const failed = turns.filter((childTurn: any) => childTurn.status === 'failed')
    const completed = turns.filter((childTurn: any) => childTurn.status === 'completed')
    assert.equal(failed.length, 1, JSON.stringify(turns.map((t: any) => t.status)))
    assert.equal(completed.length, 1)
    assert.match(JSON.stringify(failed[0].error), /Litch stopped this subagent/)
  } finally {
    await s.dispose()
  }
})

// 第一回合派出前台子代理并结束；第二回合主模型用 SendMessage 续跑它。续跑的子代理每步跑 resumeCommand，
// resumeSteps 步之后回答；resumeStall 毫秒是它头一次模型请求晚回的时间（制造“没有动静”）。
function resumeRouter(home: string, resumeSteps: number, resumeStall = 0) {
  return async (request: ModelRequest) => {
    const messages = (request.messages ?? []) as Messages
    const first = JSON.stringify(messages[0]?.content ?? '')
    const all = JSON.stringify(messages)
    if (first.includes('RESUME_CHILD')) {
      if (!all.includes('RESUME_AGAIN')) return [{ type: 'text', text: 'CHILD_FIRST_DONE' }]
      const after = messages.findIndex((message) =>
        JSON.stringify(message).includes('RESUME_AGAIN'),
      )
      const steps = toolResults(messages.slice(after + 1))
      if (steps === 0 && resumeStall) await sleep(resumeStall)
      if (steps < resumeSteps)
        return [
          {
            type: 'tool_use',
            id: toolId(),
            name: steps === 0 ? 'Read' : 'Bash',
            input: steps === 0 ? { file_path: join(home, 'a.txt') } : { command: 'sleep 1' },
          },
        ]
      return [{ type: 'text', text: 'CHILD_RESUMED_DONE' }]
    }
    if (!all.includes('"Agent"'))
      return [
        {
          type: 'tool_use',
          id: toolId(),
          name: 'Agent',
          input: {
            description: '可续跑的子代理',
            prompt: 'RESUME_CHILD 先回答一次',
            subagent_type: 'general-purpose',
            run_in_background: false,
          },
        },
      ]
    if (!all.includes('MAIN_SECOND')) return [{ type: 'text', text: 'MAIN_FIRST_DONE' }]
    if (!all.includes('"SendMessage"')) {
      const agentId = /agentId: ([0-9a-f]+)/.exec(all)?.[1]
      assert.ok(agentId, '第一回合的子代理结果里应有 agentId')
      return [
        {
          type: 'tool_use',
          id: toolId(),
          name: 'SendMessage',
          input: { to: agentId, message: 'RESUME_AGAIN 再看一遍 a.txt' },
        },
      ]
    }
    const lastAssistant = messages.map((message) => message.role).lastIndexOf('assistant')
    if (JSON.stringify(messages.slice(lastAssistant + 1)).includes('task-notification'))
      return [{ type: 'text', text: 'MAIN_AFTER_RESUME' }]
    return [{ type: 'text', text: 'MAIN_WAITING' }]
  }
}

async function firstTurn(s: Awaited<ReturnType<typeof scene>>) {
  const { turn } = await s.client.request('turn/start', {
    threadId: s.threadId,
    input: [{ type: 'text', text: 'MAIN_FIRST 派子代理' }],
  })
  assert.equal((await s.client.completed(turn.id)).status, 'completed')
  return childThreadId(s.client, s.threadId)
}

test('RESUME-001：主模型用 SendMessage 续跑已结束的子代理，续跑过程是子线程上的一个新回合', {
  timeout: 120_000,
}, async () => {
  // 时限 3 秒，续跑的子代理读一次文件、跑 4 条 sleep 1：一直有动静，不该被看门狗打断
  const s = await scene(3000)
  try {
    s.model.fallback = resumeRouter(s.home, 5)
    const childId = await firstTurn(s)
    const { turn } = await s.client.request('turn/start', {
      threadId: s.threadId,
      input: [{ type: 'text', text: 'MAIN_SECOND 再问问子代理' }],
    })
    const done = await s.client.completed(turn.id)
    assert.equal(done.status, 'completed', JSON.stringify(done.error))
    const child = await readThread(s.client, childId)
    assert.equal(child.turns.length, 2, '续跑在子线程上另起一个回合')
    const resumed = child.turns[1]
    assert.equal(resumed.status, 'completed')
    const types = resumed.items.map((item: any) => item.type)
    assert.equal(types[0], 'userMessage')
    assert.match(JSON.stringify(resumed.items[0]), /RESUME_AGAIN 再看一遍 a\.txt/)
    assert.ok(
      resumed.items.some(
        (item: any) => item.type !== 'userMessage' && item.type !== 'agentMessage',
      ),
      '续跑里的工具调用投影到子线程',
    )
    const texts = resumed.items
      .filter((item: any) => item.type === 'agentMessage')
      .map((item: any) => item.text)
    assert.equal(texts.at(-1), 'CHILD_RESUMED_DONE')
    // 子线程的回合开始、结束都通知了，结束在父回合结束之前
    const childStarted = s.client.trace.filter(
      (message) => message.method === 'turn/started' && message.params.threadId === childId,
    )
    assert.equal(childStarted.length, 2)
    const childDone = s.client.trace.findLastIndex(
      (message) => message.method === 'turn/completed' && message.params.threadId === childId,
    )
    const parentDone = s.client.trace.findLastIndex(
      (message) => message.method === 'turn/completed' && message.params.threadId === s.threadId,
    )
    assert.ok(childDone >= 0 && childDone < parentDone)
    const parent = await readThread(s.client, s.threadId)
    assert.ok(!JSON.stringify(parent.turns[1].items).includes('CHILD_RESUMED_DONE'))
  } finally {
    await s.dispose()
  }
})

test('RESUME-002：续跑的子代理一点动静都没有，满了时限 Litch 只停它：子线程的这一回合失败，父回合照常结束', {
  timeout: 120_000,
}, async () => {
  const s = await scene(2000)
  try {
    s.model.fallback = resumeRouter(s.home, 1, 20_000)
    const childId = await firstTurn(s)
    const { turn } = await s.client.request('turn/start', {
      threadId: s.threadId,
      input: [{ type: 'text', text: 'MAIN_SECOND 再问问子代理' }],
    })
    const done = await s.client.completed(turn.id)
    assert.equal(done.status, 'completed', JSON.stringify(done.error))
    const child = await readThread(s.client, childId)
    assert.equal(child.turns.length, 2)
    assert.equal(child.turns[1].status, 'failed')
    assert.match(JSON.stringify(child.turns[1].error), /Litch stopped this subagent/)
  } finally {
    await s.dispose()
  }
})
