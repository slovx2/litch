import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { access, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import {
  type ApprovalPolicy,
  allowsApproval,
  approvalFlows,
  isApprovalPolicy,
} from '../src/approval-policy.mjs'
import { deniedTool } from '../src/runtime-permissions.mjs'
import { normalizeDecision } from '../src/server-helpers.mjs'
import type { RuntimeTurnContext } from '../src/types.mjs'
import { MockLLM } from './fixtures/mock-llm.mjs'
import { ProtocolClient } from './fixtures/protocol-client.mjs'

const granular = (enabled: boolean): ApprovalPolicy => ({
  granular: {
    sandbox_approval: true,
    rules: enabled,
    skill_approval: false,
    request_permissions: false,
    mcp_elicitations: false,
  },
})

test('PERMISSION-008：只读结构化输出使用真实 SDK，不扩大文件或同名外部工具权限', {
  timeout: 60_000,
}, async () => {
  const home = await mkdtemp(join(tmpdir(), 'native-structured-permission-'))
  const model = new MockLLM()
  const client = await ProtocolClient.start(home, await model.start())
  try {
    const { thread } = await client.request('thread/start', {
      cwd: home,
      ephemeral: true,
      approvalPolicy: 'never',
      sandbox: 'read-only',
    })
    const outputSchema = {
      type: 'object',
      properties: { title: { type: 'string' }, description: { type: 'string' } },
      required: ['title', 'description'],
      additionalProperties: false,
    }
    const value = { title: randomUUID(), description: randomUUID() }
    const forbidden = join(home, 'forbidden.txt')
    model.enqueue(() => [
      {
        type: 'tool_use',
        id: 'toolu_structured_forbidden',
        name: 'Write',
        input: { file_path: forbidden, content: '禁止写入' },
      },
    ])
    model.enqueue((request) => {
      const result = request.messages
        .flatMap((message: any) => (Array.isArray(message.content) ? message.content : []))
        .find((block: any) => block.tool_use_id === 'toolu_structured_forbidden')
      assert.equal(result?.is_error, true)
      const formatTool = request.tools.find((entry: any) => entry.name === 'StructuredOutput')
      assert.deepEqual(formatTool.input_schema, outputSchema)
      return [
        { type: 'tool_use', id: 'toolu_structured_output', name: 'StructuredOutput', input: value },
      ]
    })
    const { turn } = await client.request('turn/start', {
      threadId: thread.id,
      input: [{ type: 'text', text: '返回符合 schema 的标题。' }],
      outputSchema,
    })
    assert.equal((await client.completed(turn.id)).status, 'completed')
    const history = await client.request('thread/read', { threadId: thread.id, includeTurns: true })
    const answer = history.thread.turns
      .at(-1)
      .items.find((item: any) => item.type === 'agentMessage')
    assert.deepEqual(JSON.parse(answer.text), value)
    assert.equal(model.requests.length, 2, '结构化输出成功后不应循环重试模型')
    await assert.rejects(access(forbidden))
    const context = {
      cwd: home,
      threadId: thread.id,
      sandboxMode: 'read-only',
      approvalPolicy: 'never',
      planMode: true,
      outputFormat: { type: 'json_schema', schema: outputSchema },
    } as RuntimeTurnContext
    assert.equal(deniedTool(context, 'StructuredOutput', value), null)
    for (const name of ['Write', 'mcp__external__StructuredOutput'])
      assert.notEqual(deniedTool(context, name, { file_path: join(home, 'forbidden.txt') }), null)
    assert.notEqual(deniedTool({ ...context, outputFormat: null }, 'StructuredOutput', value), null)
    for (let attempt = 0; attempt < 5; attempt++)
      model.enqueue(() => [
        {
          type: 'tool_use',
          id: `toolu_invalid_structured_${attempt}`,
          name: 'StructuredOutput',
          input: { title: 42, description: false },
        },
      ])
    const invalid = await client.request('turn/start', {
      threadId: thread.id,
      input: [{ type: 'text', text: '返回无效格式用于验证失败语义' }],
      outputSchema,
    })
    assert.equal((await client.completed(invalid.turn.id)).status, 'failed')
    const failedHistory = await client.request('thread/read', {
      threadId: thread.id,
      includeTurns: true,
    })
    assert.deepEqual(
      JSON.parse(
        failedHistory.thread.turns[0].items.find((item: any) => item.type === 'agentMessage').text,
      ),
      value,
    )
    assert.equal(
      failedHistory.thread.turns.at(-1).items.some((item: any) => item.type === 'agentMessage'),
      false,
    )
    await assert.rejects(access(forbidden))
    model.assertConsumed()
  } finally {
    await client.close()
    await model.close()
    await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})

test('PERMISSION-008：计划中输出结构化结果，确认退出后仍保持只读权限和历史', {
  timeout: 60_000,
}, async () => {
  const home = await mkdtemp(join(tmpdir(), 'native-structured-plan-'))
  const model = new MockLLM()
  const client = await ProtocolClient.start(home, await model.start())
  try {
    const { thread } = await client.request('thread/start', {
      cwd: home,
      approvalPolicy: 'on-request',
      sandbox: 'read-only',
    })
    const outputSchema = {
      type: 'object',
      properties: { title: { type: 'string' } },
      required: ['title'],
      additionalProperties: false,
    }
    const firstValue = { title: randomUUID() }
    const secondValue = { title: randomUUID() }
    model.enqueue(() => [
      {
        type: 'tool_use',
        id: 'toolu_structured_plan',
        name: 'StructuredOutput',
        input: firstValue,
      },
    ])
    await client.request('thread/settings/update', {
      threadId: thread.id,
      collaborationMode: {
        mode: 'plan',
        settings: {
          model: 'claude-sonnet-4-6',
          reasoning_effort: null,
          developer_instructions: null,
        },
      },
    })
    const first = await client.request('turn/start', {
      threadId: thread.id,
      input: [{ type: 'text', text: '在计划模式输出结构化结果' }],
      outputSchema,
    })
    assert.equal((await client.completed(first.turn.id)).status, 'completed')
    const modes = () =>
      client.trace
        .filter((entry) => entry.method === 'thread/settings/updated')
        .map((entry) => entry.params.threadSettings.collaborationMode.mode)
    assert.equal(modes().at(-1), 'plan')
    let confirmations = 0
    client.onServerRequest = async (method, params) => {
      assert.equal(method, 'item/tool/requestUserInput')
      assert.equal(params.questions[0].id, 'execute_plan')
      confirmations++
      return { answers: { execute_plan: { answers: ['执行计划'] } } }
    }
    const forbidden = join(home, 'after-plan.txt')
    model.enqueue(() => [
      { type: 'tool_use', id: 'toolu_structured_exit', name: 'ExitPlanMode', input: {} },
    ])
    model.enqueue((request) => {
      const result = request.messages
        .flatMap((message: any) => (Array.isArray(message.content) ? message.content : []))
        .find((block: any) => block.tool_use_id === 'toolu_structured_exit')
      assert.notEqual(result?.is_error, true)
      assert.ok(result)
      return [
        {
          type: 'tool_use',
          id: 'toolu_after_structured_exit',
          name: 'Write',
          input: { file_path: forbidden, content: '禁止写入' },
        },
      ]
    })
    model.enqueue((request) => {
      const result = request.messages
        .flatMap((message: any) => (Array.isArray(message.content) ? message.content : []))
        .find((block: any) => block.tool_use_id === 'toolu_after_structured_exit')
      assert.equal(result?.is_error, true)
      return [
        {
          type: 'tool_use',
          id: 'toolu_structured_finish',
          name: 'StructuredOutput',
          input: secondValue,
        },
      ]
    })
    const second = await client.request('turn/start', {
      threadId: thread.id,
      input: [{ type: 'text', text: '确认退出计划后尝试写文件，再返回结构化结果' }],
      outputSchema,
    })
    assert.equal((await client.completed(second.turn.id)).status, 'completed')
    assert.equal(confirmations, 1)
    assert.equal(modes().at(-1), 'default')
    await assert.rejects(access(forbidden))
    const history = await client.request('thread/read', { threadId: thread.id, includeTurns: true })
    const answers = history.thread.turns.map((turn: any) =>
      JSON.parse(turn.items.find((item: any) => item.type === 'agentMessage').text),
    )
    assert.deepEqual(answers, [firstValue, secondValue])
    assert.equal(model.requests.length, 4)
    model.assertConsumed()
  } finally {
    await client.close()
    await model.close()
    await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})

test('未提供的策略修订对象和未知审批不能静默升级为会话授权', () => {
  for (const decision of [
    { acceptWithExecpolicyAmendment: {} },
    { applyNetworkPolicyAmendment: { network_policy_amendment: { action: 'deny' } } },
    'allow-all',
    null,
  ])
    assert.equal(normalizeDecision({ decision }), 'decline')
  assert.equal(normalizeDecision({ decision: 'acceptForSession' }), 'acceptForSession')
})

test('审批策略严格遵循固定 schema，未知值和旧别名不扩大权限', () => {
  for (const value of ['on-request', 'untrusted', 'never', granular(true)])
    assert.equal(isApprovalPolicy(value), true)
  for (const value of [
    'on-failure',
    'unless-trusted',
    'always',
    [],
    {},
    { granular: { rules: true } },
    { granular: { ...(granular(true) as any).granular, rules: 'true' } },
  ])
    assert.equal(isApprovalPolicy(value), false)
  for (const flow of approvalFlows) assert.equal(allowsApproval('never', flow), false)
  assert.equal(allowsApproval(granular(false), 'rules'), false)
  assert.equal(allowsApproval(granular(true), 'rules'), true)
})

const cases: Array<{
  name: string
  policy: ApprovalPolicy
  sandbox: string
  writes: boolean
  approvals: number
}> = [
  {
    name: 'untrusted 发起用户审批',
    policy: 'untrusted',
    sandbox: 'danger-full-access',
    writes: true,
    approvals: 1,
  },
  {
    name: 'never 加只读禁止写入',
    policy: 'never',
    sandbox: 'read-only',
    writes: false,
    approvals: 0,
  },
  {
    name: '细粒度规则关闭则拒绝',
    policy: granular(false),
    sandbox: 'danger-full-access',
    writes: false,
    approvals: 0,
  },
  {
    name: '细粒度规则开启可审批',
    policy: granular(true),
    sandbox: 'danger-full-access',
    writes: true,
    approvals: 1,
  },
]

for (const scenario of cases) {
  test('PERMISSION-004：' + scenario.name + '，重启后保留相同策略', {
    timeout: 60_000,
  }, async () => {
    const home = await mkdtemp(join(tmpdir(), 'native-policy-'))
    const model = new MockLLM()
    const url = await model.start()
    let client = await ProtocolClient.start(home, url)
    try {
      const { thread } = await client.request('thread/start', {
        cwd: home,
        approvalPolicy: scenario.policy,
        sandbox: scenario.sandbox,
      })
      await client.close()
      client = await ProtocolClient.start(home, url)
      const resumed = await client.request('thread/resume', { threadId: thread.id })
      assert.deepEqual(resumed.approvalPolicy, scenario.policy)
      let approvals = 0
      client.onServerRequest = async (method) => {
        assert.equal(method, 'item/fileChange/requestApproval')
        approvals++
        return { decision: 'accept' }
      }
      const target = join(home, 'permission-output.txt')
      model.enqueue(() => [
        {
          type: 'tool_use',
          id: 'toolu_policy_write',
          name: 'Write',
          input: { file_path: target, content: 'policy checked' },
        },
      ])
      model.enqueue((request) => {
        const result = request.messages
          .flatMap((m: any) => (Array.isArray(m.content) ? m.content : []))
          .find(
            (b: any) => b.type === 'tool_result' && b.tool_use_id === 'toolu_policy_write',
          ) as any
        assert.ok(result, '必须存在真实 CLI 的工具结果')
        assert.equal(result.is_error === true, !scenario.writes)
        return [{ type: 'text', text: '策略验证完成' }]
      })
      const { turn } = await client.request('turn/start', {
        threadId: thread.id,
        input: [{ type: 'text', text: '写入验证文件' }],
      })
      assert.equal((await client.completed(turn.id)).status, 'completed')
      assert.equal(approvals, scenario.approvals)
      if (scenario.writes) assert.equal(await readFile(target, 'utf8'), 'policy checked')
      else await assert.rejects(access(target))
      model.assertConsumed()
    } finally {
      await client.close()
      await model.close()
      await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
    }
  })
}

for (const enabled of [false, true]) {
  test('PERMISSION-004：MCP 提问开关 ' + enabled + ' 不改变工具审批语义', {
    timeout: 60_000,
  }, async () => {
    const home = await mkdtemp(join(tmpdir(), 'native-mcp-policy-'))
    const target = join(home, 'mcp-policy.txt')
    const model = new MockLLM()
    const client = await ProtocolClient.start(home, await model.start())
    try {
      let questions = 0
      let approvals = 0
      client.onServerRequest = async (method, params) => {
        assert.equal(method, 'mcpServer/elicitation/request')
        // 工具调用的审批和服务自己发来的提问是同一种请求，靠 _meta 里的 codex_approval_kind 分开
        if (params._meta?.codex_approval_kind === 'mcp_tool_call') {
          approvals++
          return { action: 'accept', content: {}, _meta: null }
        }
        questions++
        assert.equal(enabled, true, '关闭时不能向客户端发送 MCP 提问')
        return { action: 'accept', content: { value: 'POLICY_CONFIRMED' } }
      }
      model.enqueue(() => [
        {
          type: 'tool_use',
          id: 'toolu_mcp_policy',
          name: 'mcp__fixture__confirm_fixture',
          input: {},
        },
      ])
      model.enqueue((request) => {
        const results = request.messages
          .flatMap((message: any) => (Array.isArray(message.content) ? message.content : []))
          .filter((block: any) => block.type === 'tool_result')
        assert.match(
          JSON.stringify(results),
          new RegExp('MCP_ACTION_' + (enabled ? 'accept' : 'decline')),
        )
        return [{ type: 'text', text: 'MCP 策略已验证' }]
      })
      const policy = granular(true) as { granular: Record<string, boolean> }
      policy.granular.mcp_elicitations = enabled
      const { thread } = await client.request('thread/start', {
        cwd: home,
        sandbox: 'danger-full-access',
        approvalPolicy: policy,
        config: {
          mcp_servers: {
            fixture: {
              command: process.execPath,
              args: [resolve('packages/claude/test/fixtures/mcp-interactive-server.mjs')],
              env: { FIXTURE_EFFECT_PATH: target },
            },
          },
        },
      })
      const { turn } = await client.request('turn/start', {
        threadId: thread.id,
        input: [{ type: 'text', text: '调用需要确认的 MCP 工具' }],
      })
      assert.equal((await client.completed(turn.id)).status, 'completed')
      assert.equal(approvals, 1, '工具执行授权与表单回答分别处理')
      assert.equal(questions, enabled ? 1 : 0)
      if (enabled) assert.equal(await readFile(target, 'utf8'), 'POLICY_CONFIRMED\n')
      else await assert.rejects(access(target))
      model.assertConsumed()
    } finally {
      await client.close()
      await model.close()
      await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
    }
  })
}
