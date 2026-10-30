// 脚本层契约检查：实际工具说明、真实事件格式经过三种模型接口；先构建 packages/device。
import assert from 'node:assert/strict'
import test from 'node:test'
import { managerTools } from '../packages/device/dist/device/src/manager-rules.mjs'
import { MANAGER_TOOLS } from '../packages/device/dist/protocol/src/client-tools-manager.mjs'
import {
  MANAGER_DEFAULT_CONTACT,
  MANAGER_DEFAULT_DISPATCH,
} from '../packages/device/dist/protocol/src/manager.mjs'
import { formatSessionEvent } from '../packages/device/dist/protocol/src/session-tree.mjs'
import { anthropicReply } from './client-fixture-anthropic.mjs'
import {
  MANAGER_ANSWERS_HEARD,
  MANAGER_ENDED,
  MANAGER_HEARD,
  MANAGER_OPENED,
  MANAGER_SPACE,
} from './client-fixture-manager.mjs'
import { completedManagerTurn, managerReply } from './client-fixture-manager-check.mjs'
import { sessionsReply, sessionsResponses } from './client-fixture-sessions.mjs'

const snapshot = (status) => ({
  status: { type: 'idle' },
  turns: [
    {
      id: 'turn-1',
      status,
      completedAt: status === 'completed' ? 1 : null,
      items: [
        {
          type: 'userMessage',
          content: [
            {
              type: 'text',
              text: '<litch-session-event kind="manager-end">结束</litch-session-event>',
            },
          ],
        },
        { type: 'agentMessage', text: '已完成' },
      ],
    },
  ],
})
const completion = (status, threadId = 'thread-1', turnId = 'turn-1') => ({
  method: 'turn/completed',
  params: { threadId, turn: { id: turnId, status } },
})

test('经理等待：idle 加瞬时 interrupted 不是终态；同回合完整快照随后完成才通过', async () => {
  let reads = 0
  const client = {
    frames: [completion('completed')],
    call: async () => ({ thread: snapshot(++reads === 1 ? 'interrupted' : 'completed') }),
  }
  assert.equal(
    await managerReply(client, 'thread-1', '已完成', 'manager-end', null, { pollMs: 1 }),
    '已完成',
  )
  assert.equal(reads, 2, '真实完成通知不能替代尚未完整的快照')
})

test('经理等待：真实中断/失败通知立即失败，其他会话或回合的通知不能串入', () => {
  for (const status of ['interrupted', 'failed'])
    assert.throws(
      () =>
        completedManagerTurn(
          snapshot('completed'),
          [completion(status)],
          'thread-1',
          null,
          'turn-1',
        ),
      new RegExp(status),
    )
  assert.throws(
    () => completedManagerTurn(snapshot('failed'), [], 'thread-1', null, 'turn-1'),
    /failed/,
  )
  assert.equal(
    completedManagerTurn(
      snapshot('interrupted'),
      [completion('completed', 'other')],
      'thread-1',
      null,
      'turn-1',
    ),
    null,
  )
  assert.equal(
    completedManagerTurn(
      snapshot('interrupted'),
      [completion('completed', 'thread-1', 'other')],
      'thread-1',
      null,
      'turn-1',
    ),
    null,
  )
  assert.equal(completedManagerTurn(snapshot('completed'), [], 'thread-1', null, 'other'), null)
  assert.equal(
    completedManagerTurn(snapshot('completed'), [], 'thread-1', 'manager-open', null),
    null,
  )
})

test('经理等待：订阅前发生的真实中断不能无限等待，超时包含最后快照', async () => {
  const client = { frames: [], call: async () => ({ thread: snapshot('interrupted') }) }
  await assert.rejects(
    managerReply(client, 'thread-1', '已完成', null, 'turn-1', { timeout: 10, pollMs: 1 }),
    /等待超时.*interrupted/,
  )
})

const spaces = managerTools({
  name: '验收经理',
  scope: '隔离验收',
  rules: '',
  dispatch: { ...MANAGER_DEFAULT_DISPATCH, maxRunningLines: 4 },
  contact: { ...MANAGER_DEFAULT_CONTACT },
})
const flat = spaces.flatMap((space) =>
  space.tools.map((tool, index) => ({
    ...tool,
    // 名字故意不包含操作名；命名空间说明可以加在工具说明前面。
    name: `hashed_${space.name}_${index}`,
    description: `${space.description}\n${tool.description}`,
  })),
)
const adapters = {
  claude: (said, result) => anthropic('claude-code', said, result),
  dsh: (said, result) => anthropic('dsh', said, result),
  pi(said, result) {
    const messages = [{ role: 'user', content: said }]
    if (result !== undefined)
      messages.push(
        { role: 'assistant', tool_calls: [{ id: 'call' }] },
        { role: 'tool', tool_call_id: 'call', content: result },
      )
    const reply = sessionsReply(
      { messages, tools: flat.map((tool) => ({ type: 'function', function: tool })) },
      said,
    )
    return reply?.tools ? { name: reply.tools[0].name, args: reply.tools[0].args } : reply?.text
  },
  codex(said, result) {
    const input = [{ role: 'user', content: said }]
    if (result !== undefined)
      input.push({ type: 'function_call_output', call_id: 'call', output: result })
    const reply = sessionsResponses({ input, tools: spaces }, said)
    return reply?.call
      ? {
          name: `${reply.call.namespace}.${reply.call.name}`,
          args: JSON.parse(reply.call.arguments),
        }
      : reply?.text
  },
}
function anthropic(harness, said, result) {
  const messages = [{ role: 'user', content: said }]
  if (result !== undefined)
    messages.push(
      { role: 'assistant', content: [{ type: 'tool_use', id: 'call', name: 'hashed', input: {} }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call', content: result }] },
    )
  const reply = anthropicReply(harness, { messages, tools: flat }, 0)[0]
  return reply.tool ? { name: reply.tool, args: reply.input } : reply.text
}

for (const [harness, reply] of Object.entries(adapters)) {
  test(`${harness}：八种经理操作按契约识别，结果原样回显`, () => {
    for (const tool of MANAGER_TOOLS.tools) {
      const args = { marker: '原样参数' }
      const said = `经理：${tool.name} ${JSON.stringify(args)}`
      const index = MANAGER_TOOLS.tools.indexOf(tool)
      assert.deepEqual(reply(said), {
        name: harness === 'codex' ? `litch_manager.${tool.name}` : `hashed_litch_manager_${index}`,
        args,
      })
      const raw = '{ "id": "D-1", "message": "第一行\\n第二行" }'
      assert.equal(reply(said, raw), `${MANAGER_HEARD}\n${raw}`)
      assert.ok(tool.description.startsWith(MANAGER_SPACE.marks[tool.name]))
    }
    assert.match(reply('经理：unknown {}'), /没有 unknown/)
    assert.match(reply('经理：add {坏参数}'), /参数不是 JSON/)
    // 引用父会话标题时，“经理：”不在行首，不能再调用一次。
    assert.notEqual(typeof reply('父会话标题：经理：add {}'), 'object')
  })

  test(`${harness}：经理开场、答复、结束事件不调工具，开线认经理专用说明`, () => {
    const manager = { managerId: 'm-1', text: '背景提过 D-99，但这次没有答它。' }
    for (const [kind, expected] of [
      ['manager-open', MANAGER_OPENED],
      ['manager-end', MANAGER_ENDED],
      ['manager-answers', `${MANAGER_ANSWERS_HEARD}D-1、D-2`],
    ]) {
      const answers = ['D-1', 'D-2'].map((decisionId) => ({
        decisionId,
        title: '是否继续？',
        optionId: null,
        optionLabel: null,
        text: '继续',
      }))
      const said = formatSessionEvent({
        kind,
        notes: [],
        manager: { ...manager, ...(kind === 'manager-answers' ? { answers } : {}) },
      })
      assert.equal(reply(said), expected)
    }
    const started = reply('会话：start {"title":"一条线"}')
    assert.equal(typeof started, 'object')
    assert.deepEqual(started.args, { title: '一条线' })
  })
}
