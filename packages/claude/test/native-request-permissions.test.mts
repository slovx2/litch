import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { access, mkdir, mkdtemp, readFile, realpath, rm, symlink } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { permissionToolName } from '../src/permission-grants.mjs'
import { saveArtifact } from './fixtures/artifacts.mjs'
import { MockLLM, type ModelRequest } from './fixtures/mock-llm.mjs'
import { ProtocolClient } from './fixtures/protocol-client.mjs'

interface Fixture {
  home: string
  cwd: string
  a: string
  b: string
  url: string
  model: MockLLM
  client: ProtocolClient
}
interface Step {
  name: string
  input: Record<string, unknown>
  error?: boolean
  inspect?: (result: Record<string, any>) => void
}
async function fixture(run: (f: Fixture) => Promise<void>) {
  const home = await realpath(await mkdtemp(join(tmpdir(), 'native-permission-grants-')))
  const model = new MockLLM(),
    url = await model.start()
  const f = {
    home,
    cwd: join(home, 'project'),
    a: join(home, 'a'),
    b: join(home, 'b'),
    url,
    model,
    client: await ProtocolClient.start(home, url),
  }
  for (const path of [f.cwd, f.a, f.b]) await mkdir(path)
  try {
    await run(f)
    model.assertConsumed()
  } finally {
    await f.client.close()
    await model.close()
    await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
}
async function thread(f: Fixture, extra: Record<string, unknown> = {}): Promise<string> {
  const result = await f.client.request('thread/start', {
    cwd: f.cwd,
    sandbox: 'read-only',
    approvalPolicy: 'on-request',
    ...extra,
  })
  return result.thread.id
}
function resultFor(request: ModelRequest, id: string): Record<string, any> {
  const result = request.messages
    .flatMap((m: any) => (Array.isArray(m.content) ? m.content : []))
    .find((b: any) => b.type === 'tool_result' && b.tool_use_id === id)
  assert.ok(result, '必须收到真实 SDK 工具结果')
  return result
}
async function execute(
  f: Fixture,
  threadId: string,
  steps: Step[],
  params: Record<string, unknown> = {},
) {
  const ids = steps.map(() => `toolu_${randomUUID().replaceAll('-', '')}`)
  const tool = (index: number) => {
    const step = steps[index]
    assert.ok(step)
    return { type: 'tool_use', id: ids[index], name: step.name, input: step.input }
  }
  const first = steps[0]
  assert.ok(first)
  f.model.enqueue((request) => {
    assert.ok(
      request.tools.some((t: any) => t.name === first.name),
      '模型必须实际看到真实工具定义',
    )
    assert.ok(request.tools.some((t: any) => t.name === permissionToolName))
    return [tool(0)]
  })
  steps.forEach((step, index) => {
    f.model.enqueue((request) => {
      const id = ids[index]
      assert.ok(id)
      const result = resultFor(request, id)
      assert.equal(result.is_error === true, step.error === true, `${step.name} 工具结果状态错误`)
      step.inspect?.(result)
      return index + 1 < steps.length
        ? [tool(index + 1)]
        : [{ type: 'text', text: '权限与真实副作用验证完成' }]
    })
  })
  const { turn } = await f.client.request('turn/start', {
    threadId,
    input: [{ type: 'text', text: '执行明确的权限边界测试' }],
    ...params,
  })
  const completed = await f.client.completed(turn.id)
  assert.equal(
    completed.status,
    'completed',
    JSON.stringify({ error: completed.error, unexpected: f.model.unexpected }),
  )
}
const write = (file_path: string, content: string, error = false): Step => ({
  name: 'Write',
  input: { file_path, content },
  error,
})
const grant = (
  permissions: Record<string, unknown>,
  error = false,
  inspect?: Step['inspect'],
): Step => ({
  name: permissionToolName,
  input: { permissions, reason: '请求测试明确列出的权限' },
  error,
  ...(inspect ? { inspect } : {}),
})
const files = (...write: string[]) => ({ fileSystem: { read: null, write } })
const ordinaryApproval = () => ({ decision: 'accept' })
const textResult = (result: Record<string, any>): string =>
  (Array.isArray(result.content) ? result.content : [{ text: result.content }])
    .map((x: any) => x.text ?? '')
    .join('')
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((accept) => {
    resolve = accept
  })
  return { promise, resolve }
}

test('PERMISSION-010：真实自有 MCP 部分授权，只读外部根不开放 cwd、其他目录、符号链接或网络', {
  timeout: 90_000,
}, async () => {
  await fixture(async (f) => {
    let hits = 0,
      permissionRequests = 0
    const site = createServer((_req, res) => {
      hits++
      res.end('GRANTED_NETWORK')
    })
    await new Promise<void>((resolve) => site.listen(0, '127.0.0.1', resolve))
    try {
      const address = site.address()
      assert.ok(address && typeof address !== 'string')
      const command = `curl --fail --silent --show-error --max-time 3 http://127.0.0.1:${address.port}`
      await symlink(f.b, join(f.a, 'escape'))
      const target = join(f.a, 'allowed.txt')
      f.client.onServerRequest = async (method, params) => {
        if (method !== 'item/permissions/requestApproval') return ordinaryApproval()
        permissionRequests++
        assert.equal(params.cwd, f.cwd)
        assert.deepEqual(params.permissions.fileSystem.write, [f.a, f.b])
        assert.equal(params.permissions.network.enabled, true)
        assert.ok(
          f.client.trace.some(
            (m) =>
              m.method === 'item/started' &&
              m.params.item.id === params.itemId &&
              m.params.item.tool === permissionToolName,
          ),
          '审批必须绑定真实 MCP 调用投影',
        )
        await assert.rejects(access(target))
        assert.equal(hits, 0)
        return { permissions: files(f.a), strictAutoReview: null }
      }
      const id = await thread(f)
      const config = await f.client.request('config/read', {})
      await execute(f, id, [
        grant({ ...files(f.a, f.b), network: { enabled: true } }, false, (result) => {
          const text = (Array.isArray(result.content) ? result.content : [{ text: result.content }])
            .map((x: any) => x.text ?? '')
            .join('')
          const answer = JSON.parse(text.split('\n')[0] ?? '')
          assert.deepEqual(answer, { permissions: files(f.a), scope: 'turn' })
        }),
        write(target, 'PERMISSION_GRANTED'),
        write(join(f.cwd, 'forbidden.txt'), 'no', true),
        write(join(f.b, 'forbidden.txt'), 'no', true),
        write(join(f.a, 'escape', 'forbidden.txt'), 'no', true),
        { name: 'Bash', input: { command }, error: true },
      ])
      assert.equal(await readFile(target, 'utf8'), 'PERMISSION_GRANTED')
      for (const file of [join(f.cwd, 'forbidden.txt'), join(f.b, 'forbidden.txt')])
        await assert.rejects(access(file))
      assert.equal(hits, 0)
      assert.equal(permissionRequests, 1)
      assert.deepEqual(
        await f.client.request('config/read', {}),
        config,
        '授权不能修改默认持久化配置',
      )
      const next = join(f.a, 'next-turn.txt')
      await execute(f, id, [write(next, 'no', true)])
      await assert.rejects(access(next))
      await saveArtifact('permission-grants', {
        partialGrant: [f.a],
        deniedRoots: [f.cwd, f.b],
        networkHits: hits,
        turnGrantExpired: true,
      })
    } finally {
      await new Promise<void>((resolve) => site.close(() => resolve()))
    }
  })
})

test('PERMISSION-010：严格审核、超范围答案和空授权均不能产生当前或后续写权限', {
  timeout: 90_000,
}, async () => {
  await fixture(async (f) => {
    const answers = [
      { permissions: files(f.a), scope: 'session', strictAutoReview: true },
      { permissions: files(f.b), scope: 'session' },
      { permissions: { network: { enabled: true } }, scope: 'session' },
      { permissions: {}, scope: 'session' },
    ]
    let requests = 0
    f.client.onServerRequest = async (method) =>
      method === 'item/permissions/requestApproval' ? answers[requests++] : ordinaryApproval()
    const id = await thread(f)
    for (let index = 0; index < answers.length; index++) {
      const file = join(f.a, `rejected-${index}.txt`)
      await execute(f, id, [
        grant(files(f.a), index < 3, (result) => {
          if (index === 0) assert.match(textResult(result), /strictAutoReview/)
          if (index === 1 || index === 2) assert.match(textResult(result), /超出权限提案/)
        }),
        write(file, 'no', true),
      ])
      await assert.rejects(access(file))
    }
    const next = join(f.a, 'rejected-next.txt')
    await execute(f, id, [write(next, 'no', true)])
    await assert.rejects(access(next))
    assert.equal(requests, answers.length)
  })
})

test('PERMISSION-010：真实 Bash 仅在明确授予的目录和网络内执行，Turn 结束后失效', {
  timeout: 90_000,
}, async () => {
  await fixture(async (f) => {
    let hits = 0
    const site = createServer((_req, res) => {
      hits++
      res.end('NETWORK_GRANTED')
    })
    await new Promise<void>((resolve) => site.listen(0, '127.0.0.1', resolve))
    try {
      const address = site.address()
      assert.ok(address && typeof address !== 'string')
      const permissions = { ...files(f.a), network: { enabled: true } }
      f.client.onServerRequest = async (method) =>
        method === 'item/permissions/requestApproval'
          ? { permissions, scope: 'turn' }
          : ordinaryApproval()
      const curl = `curl --fail --silent --show-error --max-time 3 http://127.0.0.1:${address.port}`
      const bash = (command: string, error = false): Step => ({
        name: 'Bash',
        input: { command, dangerouslyDisableSandbox: true },
        error,
      })
      const id = await thread(f)
      await execute(f, id, [
        grant(permissions),
        bash(`printf OS_GRANTED > '${join(f.a, 'bash.txt')}'`),
        bash(`printf no > '${join(f.cwd, 'bash-no.txt')}'`, true),
        bash(`printf no > '${join(f.b, 'bash-no.txt')}'`, true),
        bash(curl),
      ])
      assert.equal(await readFile(join(f.a, 'bash.txt'), 'utf8'), 'OS_GRANTED')
      for (const dir of [f.cwd, f.b]) await assert.rejects(access(join(dir, 'bash-no.txt')))
      assert.equal(hits, 1)
      await execute(f, id, [
        bash(curl, true),
        bash(`printf no > '${join(f.a, 'expired.txt')}'`, true),
      ])
      assert.equal(hits, 1)
      await assert.rejects(access(join(f.a, 'expired.txt')))
      await saveArtifact('permission-os-effects', {
        networkHits: hits,
        grantedRootWrite: true,
        cwdAndOtherRootDenied: true,
        turnExpired: true,
      })
    } finally {
      await new Promise<void>((resolve) => site.close(() => resolve()))
    }
  })
})

test('PERMISSION-010：禁用权限申请及计划模式均不发出权限审批或开放普通写入', {
  timeout: 90_000,
}, async () => {
  await fixture(async (f) => {
    let requests = 0
    f.client.onServerRequest = async (method) => {
      if (method === 'item/permissions/requestApproval') requests++
      return ordinaryApproval()
    }
    for (const approvalPolicy of [
      'never',
      {
        granular: {
          sandbox_approval: true,
          rules: true,
          skill_approval: true,
          request_permissions: false,
          mcp_elicitations: true,
        },
      },
    ]) {
      const id = await thread(f, { approvalPolicy })
      await execute(f, id, [grant(files(f.a), true), write(join(f.a, 'disabled.txt'), 'no', true)])
    }
    const id = await thread(f)
    await execute(f, id, [grant(files(f.a), true), write(join(f.a, 'plan.txt'), 'no', true)], {
      collaborationMode: {
        mode: 'plan',
        settings: {
          model: 'claude-sonnet-4-6',
          reasoning_effort: null,
          developer_instructions: null,
        },
      },
    })
    assert.equal(requests, 0)
    for (const name of ['disabled.txt', 'plan.txt']) await assert.rejects(access(join(f.a, name)))
  })
})

test('PERMISSION-010：session 仅同 adapter 内存跨 Turn，其他会话和重启后不继承', {
  timeout: 90_000,
}, async () => {
  await fixture(async (f) => {
    f.client.onServerRequest = async (method) =>
      method === 'item/permissions/requestApproval'
        ? { permissions: files(f.a), scope: 'session' }
        : ordinaryApproval()
    const id = await thread(f)
    await execute(f, id, [grant(files(f.a)), write(join(f.a, 'first.txt'), 'first')])
    await execute(f, id, [write(join(f.a, 'second.txt'), 'second')])
    assert.equal(await readFile(join(f.a, 'second.txt'), 'utf8'), 'second')
    const foreign = await thread(f)
    await execute(f, foreign, [write(join(f.a, 'foreign.txt'), 'no', true)])
    await assert.rejects(access(join(f.a, 'foreign.txt')))
    await execute(f, id, [write(join(f.a, 'plan-session.txt'), 'no', true)], {
      collaborationMode: {
        mode: 'plan',
        settings: {
          model: 'claude-sonnet-4-6',
          reasoning_effort: null,
          developer_instructions: null,
        },
      },
    })
    await assert.rejects(access(join(f.a, 'plan-session.txt')))
    await f.client.close()
    f.client = await ProtocolClient.start(f.home, f.url)
    f.client.onServerRequest = async () => {
      throw new Error('恢复后的越界工具应直接拒绝，不能暗中重授旧权限')
    }
    await f.client.request('thread/resume', { threadId: id })
    await execute(f, id, [write(join(f.a, 'resumed.txt'), 'no', true)], {
      collaborationMode: {
        mode: 'default',
        settings: {
          model: 'claude-sonnet-4-6',
          reasoning_effort: null,
          developer_instructions: null,
        },
      },
    })
    await assert.rejects(access(join(f.a, 'resumed.txt')))
    await saveArtifact('permission-scope', {
      sessionAcrossTurns: true,
      foreignThreadDenied: true,
      runtimeRestartExpired: true,
    })
  })
})

test('PERMISSION-010：取消真实权限申请后的迟到 session 答案不能恢复授权', {
  timeout: 90_000,
}, async () => {
  await fixture(async (f) => {
    const pending = deferred<void>()
    const answer = deferred<unknown>()
    f.client.onServerRequest = async (method) => {
      if (method !== 'item/permissions/requestApproval') return ordinaryApproval()
      pending.resolve()
      return answer.promise
    }
    const id = await thread(f)
    f.model.enqueue(() => [
      {
        type: 'tool_use',
        id: 'toolu_cancel_permission',
        name: permissionToolName,
        input: { permissions: files(f.a) },
      },
    ])
    const { turn } = await f.client.request('turn/start', {
      threadId: id,
      input: [{ type: 'text', text: '申请目录权限并等待明确答案' }],
    })
    await Promise.race([
      pending.promise,
      delay(10_000, undefined, { ref: false }).then(() => {
        throw new Error('未收到真实权限申请')
      }),
    ])
    await f.client.request('turn/interrupt', { threadId: id, turnId: turn.id })
    assert.equal((await f.client.completed(turn.id)).status, 'interrupted')
    answer.resolve({ permissions: files(f.a), scope: 'session' })
    await delay(50)
    const file = join(f.a, 'late.txt')
    await execute(f, id, [write(file, 'no', true)])
    await assert.rejects(access(file))
    await saveArtifact('permission-cancel', {
      interrupted: true,
      lateSessionAnswerIgnored: true,
      realWriteDenied: true,
    })
  })
})

test('PERMISSION-010：未知权限输入明确失败，内部 MCP 保留名不能被外部服务覆盖', {
  timeout: 90_000,
}, async () => {
  await fixture(async (f) => {
    let requests = 0
    f.client.onServerRequest = async () => {
      requests++
      return ordinaryApproval()
    }
    const id = await thread(f)
    await execute(f, id, [
      grant({ ...files(f.a), unknown: true }, true, (result) =>
        assert.match(textResult(result), /未知或尚不支持/),
      ),
      write(join(f.a, 'invalid.txt'), 'no', true),
    ])
    assert.equal(requests, 0)
    await assert.rejects(access(join(f.a, 'invalid.txt')))
    const before = f.model.requests.length
    for (const name of ['codex_harness_adapter_permissions', 'codex.harness.adapter.permissions']) {
      const reserved = await thread(f, { config: { mcp_servers: { [name]: { url: f.url } } } })
      const { turn } = await f.client.request('turn/start', {
        threadId: reserved,
        input: [{ type: 'text', text: '验证保留服务身份' }],
      })
      const completed = await f.client.completed(turn.id)
      assert.equal(completed.status, 'failed')
      assert.match(JSON.stringify(completed.error), /保留名称/)
    }
    assert.equal(f.model.requests.length, before, '保留名冲突必须在模型执行前失败')
  })
})
