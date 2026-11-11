import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'
import { MockRuntime } from '../src/mock-runtime.mjs'
import { projectNativeHistory } from '../src/native-history.mjs'
import { NativeClaudeRuntime } from '../src/native-runtime.mjs'
import { CodexClaudeAppServer } from '../src/server.mjs'
import { SessionStore } from '../src/store.mjs'
import {
  CLAUDE_REMINDERS,
  ReminderPrefix,
  withoutReminderPrefix,
} from '../src/system-reminders.mjs'
import type { RuntimeEvent, RuntimeTurnContext, ThreadItem } from '../src/types.mjs'
import { MockLLM } from './fixtures/mock-llm.mjs'
import { ProtocolClient } from './fixtures/protocol-client.mjs'

const context: RuntimeTurnContext = {
  threadId: 'reminder-thread',
  turnId: 'reminder-turn',
  prompt: '虚构任务',
  cwd: process.cwd(),
  runtimeType: null,
  model: null,
  effort: null,
  claudeSessionId: null,
  forkSession: false,
  mcpServers: null,
  allowedTools: null,
  addDirs: [],
  outputFormat: null,
  approvalPolicy: 'never',
  sandboxMode: 'danger-full-access',
  systemPromptAddendum: null,
  planMode: false,
  imageInputs: [],
}
const assistant = (text: string, id = 'answer') => ({
  type: 'assistant',
  uuid: id,
  message: { id, role: 'assistant', content: [{ type: 'text', text }] },
})

for (const reminder of CLAUDE_REMINDERS) {
  test(`已知提醒精确前缀：${reminder.slice(0, 18)}`, () => {
    for (let split = 0; split <= reminder.length; split++) {
      const prefix = new ReminderPrefix()
      assert.equal(prefix.push(reminder.slice(0, split)), '', '任何可能前缀都不能闪现')
      assert.equal(prefix.push(`${reminder.slice(split)}\n\n中文回答`), '中文回答')
      assert.equal(prefix.push('继续'), '继续')
    }
    const prefix = new ReminderPrefix()
    assert.equal(prefix.push(reminder.slice(0, 20)), '')
    assert.equal(prefix.push('不同'), `${reminder.slice(0, 20)}不同`, '不匹配时立即放出')
    assert.equal(withoutReminderPrefix(`${reminder}\n\n${reminder}\n\n正文`), '正文')
    assert.equal(withoutReminderPrefix(reminder), '')
    for (const normal of [
      `> ${reminder}`,
      `解释：${reminder}`,
      `${reminder}X`,
      reminder.slice(0, 40),
    ])
      assert.equal(withoutReminderPrefix(normal), normal)
  })
}

test('SDK 消息形状：忽略系统附件、isMeta、renderedRole，工具结果不转成助手正文', async () => {
  const text = `${CLAUDE_REMINDERS[0]}\n\n后续回答`
  const runtime = new NativeClaudeRuntime()
  const script: Record<string, unknown>[] = [
    {
      type: 'attachment',
      uuid: 'todo-attachment',
      attachment: { type: 'todo_reminder', content: [], itemCount: 0 },
      renderedRole: 'system',
      rendered: [{ type: 'text', text: CLAUDE_REMINDERS[0] }],
    },
    { ...assistant('技能列表'), isMeta: true },
    { ...assistant('文件已修改'), renderedRole: 'system' },
    {
      type: 'assistant',
      narration_block_indexes: [0],
      message: {
        id: 'narrated-reminder',
        content: [{ type: 'thinking', thinking: CLAUDE_REMINDERS[0] }],
      },
    },
    {
      type: 'user',
      isMeta: true,
      message: { role: 'user', content: '<system-reminder>待办列表</system-reminder>' },
    },
    { type: 'stream_event', event: { type: 'message_start', message: { id: 'answer' } } },
    {
      type: 'assistant',
      message: {
        id: 'answer',
        content: [{ type: 'thinking', thinking: '先思考虚构任务', signature: 'sample' }],
      },
    },
    ...Array.from(text, (part) => ({
      type: 'stream_event',
      event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: part } },
    })),
    assistant(text),
    { type: 'result', subtype: 'success', result: text },
  ]
  Reflect.set(runtime, 'sdk', {
    query: async function* () {
      yield* script
    },
  })
  const events: RuntimeEvent[] = []
  try {
    await runtime.runTurn(context, {
      onEvent: (event) => {
        events.push(event)
      },
      onPermissionRequest: async () => ({ decision: 'accept' }),
      onUserInputRequest: async () => ({ answers: {} }),
    })
    assert.equal(
      events
        .filter((e) => e.type === 'text_delta')
        .map((e) => e.delta)
        .join(''),
      '后续回答',
    )
  } finally {
    await runtime.stop()
  }
})

test('原生历史：meta 不开回合；文件/技能/待办提醒都不进入正文，复述清理不丢工具', () => {
  const messages = [
    { type: 'user', uuid: 'human', message: { content: '任务' } },
    { type: 'user', uuid: 'meta', isMeta: true, message: { content: '技能可用' } },
    {
      type: 'user',
      uuid: 'wrapped',
      message: { content: '<system-reminder>文件已修改</system-reminder>' },
    },
    assistant(CLAUDE_REMINDERS[0], 'hidden'),
    {
      type: 'assistant',
      uuid: 'tool',
      message: {
        content: [
          { type: 'tool_use', id: 'bash', name: 'Bash', input: { command: 'echo sample' } },
        ],
      },
    },
    {
      type: 'user',
      uuid: 'result',
      message: {
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'bash',
            content: '<system-reminder>待办提醒</system-reminder>\noutput',
          },
        ],
      },
    },
    assistant(`${CLAUDE_REMINDERS[1]}\n\n正常回答`, 'visible'),
    assistant(CLAUDE_REMINDERS[0], 'trailing-hidden'),
  ]
  for (const running of [false, true]) {
    const { turns } = projectNativeHistory('thread', messages, '/work/sample', { running })
    assert.equal(turns.length, 1)
    assert.equal(turns[0]?.items.filter((i) => i.type === 'userMessage').length, 1)
    assert.deepEqual(
      turns[0]?.items.filter((i) => i.type === 'agentMessage').map((i) => i.text),
      ['正常回答'],
    )
    assert.equal(turns[0]?.items.find((i) => i.type === 'commandExecution')?.status, 'completed')
    if (!running)
      assert.equal(turns[0]?.items.find((i) => i.type === 'agentMessage')?.phase, 'final_answer')
  }
})

test('历史库读取时去前缀和纯提醒条目，磁盘原文保留', async () => {
  const home = await mkdtemp(join(tmpdir(), 'reminder-store-'))
  const store = new SessionStore(join(home, 'state.sqlite'))
  const server = new CodexClaudeAppServer(store, new MockRuntime())
  const item: ThreadItem = {
    type: 'agentMessage',
    id: 'raw',
    text: CLAUDE_REMINDERS[0],
    phase: null,
    memoryCitation: null,
  }
  try {
    // 复用夹具创建合法线程，不接触用户库。
    let threadId = ''
    await server.handle(
      {
        id: 'store',
        close() {},
        send(message: any) {
          threadId = message.result?.thread?.id ?? threadId
        },
      },
      { id: 1, method: 'thread/start', params: { cwd: home } },
    )
    store.upsertTurn({
      id: 'old',
      threadId,
      status: 'completed',
      startedAt: 1,
      completedAt: 2,
      durationMs: 1000,
      items: [item, { ...item, id: 'body', text: `${item.text}\n\n回答` }],
      diff: '',
      error: null,
    })
    assert.deepEqual(
      store.getTurn('old')?.items.map((i) => ('text' in i ? i.text : '')),
      ['回答'],
    )
    assert.deepEqual(
      store.listTurns(threadId)[0]?.items.map((i) => i.id),
      ['body'],
    )
    const disk = new DatabaseSync(join(home, 'state.sqlite'), { readOnly: true })
    try {
      assert.ok(
        String(
          disk.prepare('SELECT items_json FROM turns WHERE id = ?').get('old')?.items_json,
        ).includes(CLAUDE_REMINDERS[0]),
      )
    } finally {
      disk.close()
    }
  } finally {
    await server.stop()
    await rm(home, { recursive: true, force: true })
  }
})

test('真实隔离 CLI + 回环假模型：提醒不闪现，纯提醒无空助手条目，普通/事件提示共用路径', {
  timeout: 120_000,
}, async () => {
  const home = await mkdtemp(join(tmpdir(), 'reminder-cli-'))
  const model = new MockLLM()
  const client = await ProtocolClient.start(home, await model.start())
  try {
    const { thread } = await client.request('thread/start', { cwd: home })
    for (const [index, output] of [
      CLAUDE_REMINDERS[0],
      `${CLAUDE_REMINDERS[1]}\n\n正常回答`,
    ].entries()) {
      model.enqueue(() => [{ type: 'text', text: output }])
      const { turn } = await client.request('turn/start', {
        threadId: thread.id,
        input: [
          {
            type: 'text',
            text: index
              ? '<litch-session-event kind="report">虚构回报</litch-session-event>'
              : '虚构任务',
          },
        ],
      })
      assert.equal((await client.completed(turn.id)).status, 'completed')
      const { thread: read } = await client.request('thread/read', {
        threadId: thread.id,
        includeTurns: true,
      })
      const answer = read.turns
        .find((t: any) => t.id === turn.id)
        .items.filter((i: any) => i.type === 'agentMessage')
      if (!index)
        assert.deepEqual(
          read.turns.find((t: any) => t.id === turn.id).items.map((i: any) => i.type),
          ['userMessage'],
          '纯提醒不生成空过程条目',
        )
      assert.deepEqual(
        answer.map((i: any) => i.text),
        index ? ['正常回答'] : [],
      )
      const deltas = client.trace
        .filter((m) => m.method === 'item/agentMessage/delta' && m.params.turnId === turn.id)
        .map((m) => m.params.delta)
        .join('')
      assert.equal(deltas, index ? '正常回答' : '')
      model.assertConsumed()
    }
  } finally {
    await client.close()
    await model.close()
    await rm(home, { recursive: true, force: true })
  }
})
