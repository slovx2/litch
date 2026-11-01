import assert from 'node:assert/strict'
import test from 'node:test'
import { anthropicReply } from './client-fixture-anthropic.mjs'

test('计划夹具先加载真实延迟工具，发现不推进业务步骤', () => {
  const prompt = {
    role: 'user',
    content: [
      {
        type: 'text',
        text: '<system-reminder>\nThe following deferred tools are now available via ToolSearch. Their schemas are NOT loaded — calling them directly will fail with InputValidationError. Use ToolSearch with query "select:<name>[,<name>...]" to load tool schemas before calling them:\nExitPlanMode\n</system-reminder>',
      },
      { type: 'text', text: '出个计划' },
    ],
  }
  const tools = [{ name: 'ToolSearch' }]
  const first = anthropicReply('claude-code', { messages: [prompt], tools }, 0)
  assert.deepEqual(first, [{ tool: 'ToolSearch', input: { query: 'select:ExitPlanMode' } }])
  const messages = [
    prompt,
    {
      role: 'assistant',
      content: [{ type: 'tool_use', name: 'ToolSearch', id: 'load', input: first[0].input }],
    },
    {
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: 'load',
          content: [{ type: 'tool_reference', tool_name: 'ExitPlanMode' }],
        },
      ],
    },
  ]
  assert.throws(() => anthropicReply('claude-code', { messages, tools }, 0), /工具定义未加载/)
  const loaded = anthropicReply(
    'claude-code',
    { messages, tools: [...tools, { name: 'ExitPlanMode', defer_loading: true }] },
    0,
  )
  assert.equal(loaded.at(-1).tool, 'ExitPlanMode')
  const system = { role: 'system', content: prompt.content.slice(0, 1) }
  assert.deepEqual(
    anthropicReply(
      'claude-code',
      { messages: [system, { ...prompt, content: prompt.content.slice(1) }], tools },
      0,
    ),
    first,
  )
  assert.equal(
    anthropicReply('claude-code', { messages: [prompt], tools: [{ name: 'ExitPlanMode' }] }, 0).at(
      -1,
    ).tool,
    'ExitPlanMode',
  )
})
