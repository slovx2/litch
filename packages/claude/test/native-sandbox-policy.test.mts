import assert from 'node:assert/strict'
import { access, mkdir, mkdtemp, readFile, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { MockLLM } from './fixtures/mock-llm.mjs'
import { ProtocolClient } from './fixtures/protocol-client.mjs'

test('PERMISSION-005：完整目录网络策略经重启保留并约束真实文件工具', {
  timeout: 60_000,
}, async () => {
  const home = await mkdtemp(join(tmpdir(), 'native-sandbox-policy-'))
  const workspace = join(home, 'workspace')
  const extra = join(home, 'extra')
  await mkdir(workspace)
  await mkdir(extra)
  await symlink(home, join(workspace, 'escape'))
  const model = new MockLLM()
  const url = await model.start()
  let client = await ProtocolClient.start(home, url)
  const policy = {
    type: 'workspaceWrite',
    writableRoots: [extra],
    networkAccess: false,
    excludeTmpdirEnvVar: true,
    excludeSlashTmp: true,
  }
  try {
    const { thread } = await client.request('thread/start', {
      cwd: workspace,
      sandbox: 'workspace-write',
      approvalPolicy: 'on-request',
    })
    await client.request('thread/settings/update', { threadId: thread.id, sandboxPolicy: policy })
    await client.close()
    client = await ProtocolClient.start(home, url)
    const restored = await client.request('thread/resume', { threadId: thread.id })
    assert.deepEqual(restored.sandbox, policy)
    assert.equal(model.requests.length, 0, '策略恢复不能发起模型请求')
    for (const invalid of [
      { sandboxPolicy: { ...policy, writableRoots: ['relative'] } },
      { sandboxPolicy: { ...policy, networkAccess: 'false' } },
      { sandboxPolicy: { type: 'readOnly', networkAccess: null } },
      { sandbox: 'read-only', sandboxPolicy: { type: 'dangerFullAccess' } },
      { permissions: ':danger-full-access', sandboxPolicy: { type: 'readOnly' } },
    ]) {
      await client.raw('turn/start', { threadId: thread.id, input: [], ...invalid }, -32602)
    }
    assert.equal(model.requests.length, 0, '非法策略不能先启动回合再异步失败')
    const approvals: unknown[] = []
    client.onServerRequest = async (method, params) => {
      assert.equal(method, 'item/fileChange/requestApproval')
      approvals.push(params)
      return { decision: 'accept' }
    }
    const cases = [
      { name: 'workspace', target: join(workspace, 'inside.txt'), allowed: true },
      { name: 'extra', target: join(extra, 'inside.txt'), allowed: true },
      { name: 'outside', target: join(home, 'outside.txt'), allowed: false },
      { name: 'symlink', target: join(workspace, 'escape', 'escaped.txt'), allowed: false },
    ]
    for (const scenario of cases) {
      const toolId = 'toolu_' + scenario.name
      model.enqueue(() => [
        {
          type: 'tool_use',
          id: toolId,
          name: 'Write',
          input: { file_path: scenario.target, content: scenario.name },
        },
      ])
      model.enqueue((request) => {
        const result = toolResult(request, toolId)
        assert.equal(result.is_error === true, !scenario.allowed, JSON.stringify(result))
        return [{ type: 'text', text: '目录边界验证完成' }]
      })
      const { turn } = await client.request('turn/start', {
        threadId: thread.id,
        input: [{ type: 'text', text: '测试目录 ' + scenario.name }],
      })
      assert.equal(
        (await client.completed(turn.id)).status,
        'completed',
        client.stderr.slice(-3000),
      )
      if (scenario.allowed) assert.equal(await readFile(scenario.target, 'utf8'), scenario.name)
      else await assert.rejects(access(scenario.target))
    }
    assert.equal(approvals.length, 2, '越界工具不能通过普通审批扩大授权')
    model.enqueue(() => [
      {
        type: 'tool_use',
        id: 'toolu_network',
        name: 'WebFetch',
        input: { url: url + '/blocked-fetch', prompt: '读取本地页面' },
      },
    ])
    model.enqueue((request) => {
      assert.equal(toolResult(request, 'toolu_network').is_error, true)
      return [{ type: 'text', text: '网络边界验证完成' }]
    })
    const turn = await client.request('turn/start', {
      threadId: thread.id,
      input: [{ type: 'text', text: '验证工具禁网' }],
    })
    assert.equal((await client.completed(turn.turn.id)).status, 'completed')
    const fork = await client.request('thread/fork', { threadId: thread.id })
    assert.deepEqual(fork.sandbox, policy, '分叉不能丢弃沙箱边界')
    const full = await client.request('thread/resume', {
      threadId: thread.id,
      permissions: ':danger-full-access',
      approvalPolicy: 'on-request',
    })
    assert.deepEqual(full.sandbox, { type: 'dangerFullAccess' })
    assert.equal(full.approvalPolicy, 'on-request', '显式审批策略优先于档位缺省值')
    await client.request('thread/settings/update', {
      threadId: thread.id,
      permissions: ':danger-full-access',
      approvalPolicy: 'never',
    })
    const unrestricted = await client.request('thread/resume', { threadId: thread.id })
    assert.equal(unrestricted.approvalPolicy, 'never')
    await client.request('thread/settings/update', {
      threadId: thread.id,
      sandboxPolicy: { type: 'readOnly', networkAccess: true },
      approvalPolicy: 'untrusted',
    })
    const readOnly = await client.request('thread/resume', { threadId: thread.id })
    assert.deepEqual(readOnly.sandbox, { type: 'readOnly', networkAccess: true })
    assert.equal(readOnly.approvalPolicy, 'untrusted')
    await client.request('thread/metadata/update', {
      threadId: thread.id,
      sandboxPolicy: policy,
      approvalPolicy: 'on-request',
    })
    const metadata = await client.request('thread/resume', { threadId: thread.id })
    assert.deepEqual(metadata.sandbox, policy, '元数据入口必须同步执行策略与展示档位')
    await client.raw(
      'thread/metadata/update',
      {
        threadId: thread.id,
        sandbox: 'read-only',
        sandboxPolicy: { type: 'dangerFullAccess' },
      },
      -32602,
    )
    model.assertConsumed()
  } finally {
    await client.close()
    await model.close()
    await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})

function toolResult(request: any, id: string): any {
  const result = request.messages
    .flatMap((message: any) => (Array.isArray(message.content) ? message.content : []))
    .find((block: any) => block.type === 'tool_result' && block.tool_use_id === id)
  assert.ok(result, '必须从真实模型上下文读取工具结果')
  return result
}
