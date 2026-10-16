import assert from 'node:assert/strict'
import { access, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { MockLLM } from './fixtures/mock-llm.mjs'
import { ProtocolClient } from './fixtures/protocol-client.mjs'

test('PERMISSION-006：真实 Bash 的工作区、网络、只读和计划边界', {
  timeout: 60_000,
}, async () => {
  const home = await mkdtemp(join(tmpdir(), 'native-bash-sandbox-'))
  const workspace = join(home, 'workspace')
  await mkdir(workspace)
  let hits = 0
  const site = createServer((_req, res) => {
    hits++
    res.end('LOCAL_SITE_OK')
  })
  await new Promise<void>((resolve) => site.listen(0, '127.0.0.1', resolve))
  const address = site.address()
  assert.ok(address && typeof address !== 'string')
  const url = 'http://127.0.0.1:' + address.port
  const model = new MockLLM()
  const client = await ProtocolClient.start(home, await model.start())
  try {
    const approvals: string[] = []
    client.onServerRequest = async (method, params) => {
      assert.equal(method, 'item/commandExecution/requestApproval')
      approvals.push(params.command)
      return { decision: 'accept' }
    }
    const { thread } = await client.request('thread/start', {
      cwd: workspace,
      sandbox: 'workspace-write',
      approvalPolicy: 'on-request',
    })
    const policy = {
      type: 'workspaceWrite',
      writableRoots: [],
      networkAccess: false,
      excludeTmpdirEnvVar: true,
      excludeSlashTmp: true,
    }
    let sequence = 0
    const run = async (command: string, success: boolean, params: Record<string, unknown> = {}) => {
      const id = 'toolu_bash_' + sequence++
      model.enqueue(() => [{ type: 'tool_use', id, name: 'Bash', input: { command } }])
      model.enqueue((request) => {
        const result = request.messages
          .flatMap((m: any) => (Array.isArray(m.content) ? m.content : []))
          .find((b: any) => b.type === 'tool_result' && b.tool_use_id === id) as any
        assert.ok(result, '命令结果必须进入真实原生上下文')
        assert.equal(result.is_error === true, !success, JSON.stringify(result))
        return [{ type: 'text', text: 'Bash 约束验证完成' }]
      })
      const { turn } = await client.request('turn/start', {
        threadId: thread.id,
        input: [{ type: 'text', text: '执行边界测试 ' + sequence }],
        ...params,
      })
      const completed = await client.completed(turn.id)
      assert.equal(
        completed.status,
        'completed',
        JSON.stringify({ completed, errors: model.unexpected }) + client.stderr.slice(-5000),
      )
    }
    const inside = 'printf allowed > inside.txt'
    await run(inside, true, { sandboxPolicy: policy })
    assert.equal(await readFile(join(workspace, 'inside.txt'), 'utf8'), 'allowed')
    assert.ok(approvals.includes(inside), '用户审批必须显示原始命令')
    assert.ok(
      approvals.every((command) => !command.includes('sandbox-exec') && !command.includes('bwrap')),
    )
    await run('printf forbidden > ../outside.txt', false)
    await assert.rejects(access(join(home, 'outside.txt')))

    const connect =
      'require("node:http").get(' +
      JSON.stringify(url) +
      ',r=>{r.resume();r.on("end",()=>process.exit(0))}).on("error",()=>process.exit(42));setTimeout(()=>process.exit(43),2000)'
    const quoted = (value: string) => "'" + value.replaceAll("'", "'\"'\"'") + "'"
    const network = quoted(process.execPath) + ' -e ' + quoted(connect)
    await run(network, false)
    assert.equal(hits, 0, '禁止联网必须在实际站点没有请求')
    await run(network, true, { sandboxPolicy: { ...policy, networkAccess: true } })
    assert.equal(hits, 1, '显式联网授权必须能访问本地站点')
    await run('printf forbidden > readonly.txt', false, {
      sandboxPolicy: { type: 'readOnly', networkAccess: false },
    })
    await assert.rejects(access(join(workspace, 'readonly.txt')))
    await run('cat inside.txt', true)
    await run('printf forbidden > plan-write.txt', false, {
      permissions: ':danger-full-access',
      collaborationMode: {
        mode: 'plan',
        settings: {
          model: 'claude-sonnet-4-6',
          reasoning_effort: null,
          developer_instructions: null,
        },
      },
    })
    await assert.rejects(access(join(workspace, 'plan-write.txt')))
    const approvalsBeforeFull = approvals.length
    await run('printf unrestricted > ../full-access.txt', true, {
      collaborationMode: {
        mode: 'default',
        settings: {
          model: 'claude-sonnet-4-6',
          reasoning_effort: null,
          developer_instructions: null,
        },
      },
    })
    assert.equal(await readFile(join(home, 'full-access.txt'), 'utf8'), 'unrestricted')
    assert.equal(approvals.length, approvalsBeforeFull, '完全访问不能额外请求普通命令审批')
    model.assertConsumed()
  } finally {
    await client.close()
    await model.close()
    await new Promise<void>((resolve) => site.close(() => resolve()))
    await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})
