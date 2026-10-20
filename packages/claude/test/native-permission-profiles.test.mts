import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { buildCliConfigLayer, setCliConfigLayer } from '../src/cli-config.mjs'
import { deniedTool } from '../src/runtime-permissions.mjs'
import type { RuntimeTurnContext } from '../src/types.mjs'
import { openStage, type Stage, sayAndFinish } from './fixtures/in-process.mjs'
import { MockLLM } from './fixtures/mock-llm.mjs'
import { ProtocolClient, protocolEnv } from './fixtures/protocol-client.mjs'

// 协议层怎么认 `-c` 给的自定义权限档位（PROFILE-* 是规则本身）：thread/start、turn/start 认档位名和
// runtimeWorkspaceRoots，default_permissions 管不带权限的新会话，回合拿到的规则与工具检查是同一份。

const text = (value: string) => [{ type: 'text', text: value }]

// root：用例自己的目录（真实路径），先建好，-c 里的路径要用它
async function withProfiles(
  name: string,
  overrides: (root: string) => string[],
  run: (stage: Stage, root: string) => Promise<void>,
): Promise<void> {
  const root = realpathSync(mkdtempSync(join(tmpdir(), `${name}-root-`)))
  setCliConfigLayer(buildCliConfigLayer(overrides(root)))
  const stage = await openStage(name)
  try {
    await run(stage, root)
  } finally {
    await stage.dispose()
    setCliConfigLayer({})
    rmSync(root, { recursive: true, force: true })
  }
}

function saasOverrides(root: string, extra: string[] = []): string[] {
  const filesystem = `{ "${root}/ws" = "deny", "${root}/ws/A" = "write", "${root}/cfg" = "deny" }`
  return [
    'approval_policy="never"',
    'permissions.saas.extends=":workspace"',
    `permissions.saas.filesystem=${filesystem}`,
    'permissions.saas.network={ enabled = true, allow_local_binding = true }',
    'model_provider="ignored"',
    ...extra,
  ]
}

function layout(root: string): { own: string; other: string } {
  const own = join(root, 'ws/A')
  mkdirSync(own, { recursive: true })
  mkdirSync(join(root, 'ws/B'), { recursive: true })
  mkdirSync(join(root, 'shared'), { recursive: true })
  writeFileSync(join(root, 'ws/B/secret'), 'SECRET_OF_B')
  return { own, other: join(root, 'shared') }
}

async function captureTurn(
  stage: Stage,
  connection: Awaited<ReturnType<Stage['connect']>>,
  params: Record<string, unknown>,
): Promise<RuntimeTurnContext> {
  let captured: RuntimeTurnContext | undefined
  stage.script = async (context, handlers) => {
    captured = context
    await sayAndFinish('好的')(context, handlers)
  }
  const { turn } = await connection.request('turn/start', { input: text('干活'), ...params })
  assert.equal((await connection.completed(turn.id)).status, 'completed')
  assert.ok(captured)
  return captured
}

test('PROFILE-PROTO-001：thread/start、turn/start 认 -c 定义的档位和 runtimeWorkspaceRoots', async () => {
  await withProfiles('profile-proto', saasOverrides, async (stage, root) => {
    const { own, other } = layout(root)
    const client = await stage.connect('client')
    const listed = await client.request('permissionProfile/list', {})
    assert.ok(listed.data.some((profile: { id: string }) => profile.id === 'saas'))
    const started = await client.request('thread/start', {
      cwd: own,
      permissions: 'saas',
      runtimeWorkspaceRoots: [own, other],
    })
    assert.equal(started.permissions, 'saas')
    assert.deepEqual(started.activePermissionProfile, { id: 'saas', extends: null })
    assert.deepEqual(started.runtimeWorkspaceRoots, [own, other])
    assert.equal(started.approvalPolicy, 'never')
    assert.equal(started.sandbox.type, 'workspaceWrite')
    assert.equal(started.sandbox.networkAccess, true)
    assert.ok(started.sandbox.writableRoots.includes(other))
    const context = await captureTurn(stage, client, {
      threadId: started.thread.id,
      permissions: 'saas',
    })
    assert.equal(context.sandboxMode, 'workspace-write')
    assert.ok(context.fileSystem)
    assert.deepEqual(context.fileSystem.workspaceRoots, [own, other])
    assert.match(
      String(deniedTool(context, 'Read', { file_path: join(root, 'ws/B/secret') })),
      /禁止读取/,
    )
    assert.equal(deniedTool(context, 'Write', { file_path: join(other, 'x') }), null)
    // 只换审批策略不动档位；选内置档位就回到旧的规则
    const kept = await captureTurn(stage, client, {
      threadId: started.thread.id,
      approvalPolicy: 'on-request',
    })
    assert.ok(kept.fileSystem)
    const builtin = await captureTurn(stage, client, {
      threadId: started.thread.id,
      permissions: ':workspace',
    })
    assert.equal(builtin.fileSystem, undefined)
    const unknown = await client.raw('turn/start', {
      threadId: started.thread.id,
      input: text('x'),
      permissions: 'nope',
    })
    assert.equal(unknown.error?.code, -32602)
    const badRoots = await client.raw('thread/start', {
      cwd: own,
      permissions: 'saas',
      runtimeWorkspaceRoots: ['relative'],
    })
    assert.equal(badRoots.error?.code, -32602)
  })
})

test('PROFILE-PROTO-002：default_permissions 管不带权限的新会话，审批策略照 -c', async () => {
  await withProfiles(
    'profile-default',
    (root) => saasOverrides(root, ['default_permissions="saas"']),
    async (stage, root) => {
      const { own } = layout(root)
      const client = await stage.connect('client')
      const config = (await client.request('config/read', {})).config
      assert.equal(config.default_permissions, 'saas')
      assert.equal(config.approval_policy, 'never')
      const started = await client.request('thread/start', { cwd: own })
      assert.equal(started.permissions, 'saas')
      assert.equal(started.approvalPolicy, 'never')
      const context = await captureTurn(stage, client, { threadId: started.thread.id })
      assert.ok(context.fileSystem)
      assert.deepEqual(context.fileSystem.workspaceRoots, [own])
      // 显式给了旧式沙箱的不用默认档位
      const legacy = await client.request('thread/start', { cwd: own, sandbox: 'read-only' })
      assert.equal(legacy.permissions, ':read-only')
    },
  )
})

test('PROFILE-PROTO-003：没给 -c 时与原来一样，自定义档位名照旧回 -32602', async () => {
  await withProfiles(
    'profile-none',
    () => [],
    async (stage) => {
      const client = await stage.connect('client')
      const rejected = await client.raw('thread/start', {
        cwd: stage.directory,
        permissions: 'saas',
      })
      assert.equal(rejected.error?.code, -32602)
      const started = await client.request('thread/start', {
        cwd: stage.directory,
        permissions: ':workspace',
        runtimeWorkspaceRoots: [],
      })
      assert.deepEqual(started.runtimeWorkspaceRoots, [stage.directory])
      const context = await captureTurn(stage, client, { threadId: started.thread.id })
      assert.equal(context.fileSystem, undefined)
      assert.equal(context.sandboxMode, 'workspace-write')
    },
  )
})

// 子代理追问是在父会话的 CLI 里跑的一轮：禁读规则必须照父会话的档位，不能按子线程自己的空设置退回旧沙箱
test('PROFILE-PROTO-005：子代理追问回合带着父会话的档位和禁读', async () => {
  await withProfiles('profile-subagent', saasOverrides, async (stage, root) => {
    const { own } = layout(root)
    const client = await stage.connect('client')
    const started = await client.request('thread/start', { cwd: own, permissions: 'saas' })
    stage.script = async (_context, handlers) => {
      await handlers.onEvent({ type: 'session', claudeSessionId: 'parent-session' })
      await handlers.onEvent({
        type: 'tool_use',
        toolUseId: 'task-1',
        toolName: 'Task',
        input: { description: '查一查', prompt: 'investigate' },
      })
      await new Promise((resolve) => setTimeout(resolve, 30))
      await handlers.onEvent({
        type: 'tool_result',
        toolUseId: 'task-1',
        content: "查完了\nagentId: deadbeefcafef00d (use SendMessage with to: 'deadbeefcafef00d')",
      })
      await handlers.onEvent({ type: 'completed', success: true, result: '汇总' })
    }
    const { turn } = await client.request('turn/start', {
      threadId: started.thread.id,
      input: text('派一个子代理'),
    })
    assert.equal((await client.completed(turn.id)).status, 'completed')
    const child = client.trace.find(
      (message) =>
        message.method === 'thread/started' && message.params.thread.threadSource === 'subagent',
    )?.params.thread
    assert.ok(child, '子线程已建')
    const resumed = await client.request('thread/resume', { threadId: child.id })
    assert.equal(resumed.permissions, 'saas', '子线程报的档位与父会话一致')
    // 追问回合要真的经 SendMessage 转交出去才算完成
    let context: RuntimeTurnContext | undefined
    stage.script = async (captured, handlers) => {
      context = captured
      await handlers.onEvent({
        type: 'tool_use',
        toolUseId: 'send-1',
        toolName: 'SendMessage',
        input: { to: 'deadbeefcafef00d', message: '再查一下' },
      })
      await handlers.onEvent({ type: 'tool_result', toolUseId: 'send-1', content: '已送达' })
      await handlers.onEvent({ type: 'completed', success: true, result: '好' })
    }
    const relayed = await client.request('turn/start', {
      threadId: child.id,
      input: text('再查一下'),
    })
    assert.equal((await client.completed(relayed.turn.id)).status, 'completed')
    assert.ok(context?.subagentRelay, '这是一轮追问')
    assert.equal(context.sandboxMode, 'workspace-write')
    assert.ok(context.fileSystem)
    assert.match(
      String(deniedTool(context, 'Read', { file_path: join(root, 'ws/B/secret') })),
      /禁止读取/,
    )
  })
})

// 起一个真的适配器进程（模拟运行时），命令行带 -c，读一次 config/read
async function adapterWith(
  args: string[],
): Promise<{ code: number | null; out: any; err: string }> {
  const home = mkdtempSync(join(tmpdir(), 'profile-cli-'))
  try {
    const child = spawn(
      process.execPath,
      [fileURLToPath(new URL('../src/adapter.mjs', import.meta.url)), 'app-server', ...args],
      { env: protocolEnv(home, 'http://127.0.0.1:9', true) },
    )
    let err = ''
    child.stderr.on('data', (chunk) => {
      err += String(chunk)
    })
    const lines = createInterface({ input: child.stdout })
    const replies = new Map<number, any>()
    lines.on('line', (line) => {
      const message = JSON.parse(line)
      if (message.id != null && !message.method) replies.set(message.id, message)
    })
    const exited = new Promise<number | null>((resolve) => child.once('close', resolve))
    child.stdin.write(
      `${JSON.stringify({ id: 1, method: 'initialize', params: { clientInfo: { name: 't', title: null, version: '1' }, capabilities: null } })}\n`,
    )
    child.stdin.write(`${JSON.stringify({ id: 2, method: 'config/read', params: {} })}\n`)
    const deadline = Date.now() + 30_000
    const done = await Promise.race([
      exited.then((code) => ({ code })),
      (async () => {
        while (!replies.has(2) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20))
        return null
      })(),
    ])
    if (done) return { code: done.code, out: null, err }
    child.stdin.end()
    return { code: await exited, out: replies.get(2), err }
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
}

test('PROFILE-PROTO-004：命令行的 -c 进到 config/read；档位写错了进程起不来', {
  timeout: 60_000,
}, async () => {
  const ok = await adapterWith([
    '--listen',
    'stdio://',
    '-c',
    'approval_policy="never"',
    '-c',
    'permissions.ro.extends=":read-only"',
    '-c',
    'default_permissions="ro"',
    '-c',
    'features.multi_agent=true',
  ])
  assert.ok(ok.out?.result, ok.err)
  assert.equal(ok.out.result.config.approval_policy, 'never')
  assert.equal(ok.out.result.config.default_permissions, 'ro')
  assert.equal(ok.out.result.config.features, undefined)
  const bad = await adapterWith([
    '-c',
    'permissions.x.extends=":danger-full-access"',
    '-c',
    'default_permissions="x"',
  ])
  assert.notEqual(bad.code, 0)
  assert.match(bad.err, /不能继承内置档位/)
})

// 这一版 CLI 没有单独的 Grep、Glob 工具（搜索走 Bash），它们的检查由 PROFILE-004 覆盖
test('PROFILE-REAL-001：真实 CLI 里 Read 和 Bash 都按档位禁读，自己的工作区照常读写', {
  timeout: 120_000,
}, async () => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'profile-real-')))
  const { own } = layout(home)
  writeFileSync(join(own, 'mine.txt'), 'MINE')
  const model = new MockLLM()
  const client = await ProtocolClient.start(home, await model.start())
  try {
    await client.request('config/value/write', {
      keyPath: 'permissions',
      mergeStrategy: 'replace',
      value: {
        saas: {
          extends: ':workspace',
          filesystem: { [join(home, 'ws')]: 'deny', [own]: 'write' },
        },
      },
    })
    const { thread } = await client.request('thread/start', {
      cwd: own,
      permissions: 'saas',
      approvalPolicy: 'never',
      runtimeWorkspaceRoots: [own],
    })
    let sequence = 0
    const call = async (name: string, input: Record<string, unknown>, allowed: boolean) => {
      const id = `toolu_profile_${sequence++}`
      let output = ''
      model.enqueue(() => [{ type: 'tool_use', id, name, input }])
      model.enqueue((request) => {
        const result = request.messages
          .flatMap((m: any) => (Array.isArray(m.content) ? m.content : []))
          .find((b: any) => b.type === 'tool_result' && b.tool_use_id === id) as any
        assert.ok(result, `${name} 的结果必须回到模型`)
        output = JSON.stringify(result.content)
        assert.equal(
          result.is_error === true,
          !allowed,
          `${name} ${JSON.stringify(input)}：${output}`,
        )
        return [{ type: 'text', text: '好' }]
      })
      const { turn } = await client.request('turn/start', {
        threadId: thread.id,
        input: text(`第 ${sequence} 步`),
        permissions: 'saas',
      })
      const completed = await client.completed(turn.id)
      assert.equal(completed.status, 'completed', client.stderr.slice(-3000))
      model.assertConsumed()
      return output
    }
    assert.match(await call('Read', { file_path: join(own, 'mine.txt') }, true), /MINE/)
    assert.match(await call('Read', { file_path: join(home, 'ws/B/secret') }, false), /禁止读取/)
    const leaked = await call('Bash', { command: `cat ${join(home, 'ws/B/secret')}; true` }, true)
    assert.doesNotMatch(leaked, /SECRET_OF_B/)
    assert.match(leaked, /Operation not permitted|Permission denied|No such file/)
    await call('Bash', { command: 'printf ok > made.txt' }, true)
    assert.equal(readFileSync(join(own, 'made.txt'), 'utf8'), 'ok')
  } finally {
    await client.close()
    await model.close()
    rmSync(home, { recursive: true, force: true })
  }
})
