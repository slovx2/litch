import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
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

// shell_environment_policy：-c 给进程级的，线程的 config 叠在上面（表按键合并），回合拿到合并后的规则
test('PROFILE-PROTO-006：shell_environment_policy 照 codex 叠 -c 与线程 config', async () => {
  await withProfiles(
    'profile-shell-env',
    () => [
      'shell_environment_policy.exclude=["BROWSER_MCP_*"]',
      'shell_environment_policy.set.TMPDIR="/srv/tmp"',
    ],
    async (stage) => {
      const client = await stage.connect('client')
      const plain = await client.request('thread/start', { cwd: stage.directory })
      const base = await captureTurn(stage, client, { threadId: plain.thread.id })
      assert.deepEqual(base.shellEnvironment, {
        inherit: 'all',
        ignoreDefaultExcludes: true,
        exclude: ['BROWSER_MCP_*'],
        set: { TMPDIR: '/srv/tmp' },
        includeOnly: [],
      })
      const scoped = await client.request('thread/start', {
        cwd: stage.directory,
        config: {
          shell_environment_policy: { inherit: 'core', set: { CLI_TOKEN: 'c' } },
          'shell_environment_policy.set.PATH': '/opt/bin',
        },
      })
      // codex 把线程 config 接在 -c 后面当覆盖：整张表给的就整张换掉 -c 那张，带点的键只改那一项
      const context = await captureTurn(stage, client, { threadId: scoped.thread.id })
      assert.deepEqual(context.shellEnvironment, {
        inherit: 'core',
        ignoreDefaultExcludes: true,
        exclude: [],
        set: { CLI_TOKEN: 'c', PATH: '/opt/bin' },
        includeOnly: [],
      })
      const dotted = await client.request('thread/start', {
        cwd: stage.directory,
        config: { 'shell_environment_policy.set.EXTRA': 'x' },
      })
      const added = await captureTurn(stage, client, { threadId: dotted.thread.id })
      assert.deepEqual(added.shellEnvironment?.exclude, ['BROWSER_MCP_*'])
      assert.deepEqual(added.shellEnvironment?.set, { TMPDIR: '/srv/tmp', EXTRA: 'x' })
      const bad = await client.raw('thread/start', {
        cwd: stage.directory,
        config: { shell_environment_policy: { inherit: 'some' } },
      })
      assert.equal(bad.error?.code, -32602)
    },
  )
})

// 线程 config 里的 skills（codex 的 SessionFlags 层）：按会话给 CLI 的 skillOverrides、disableBundledSkills
test('PROFILE-PROTO-007：线程 config 的 skills 按会话生效，盖过 -c 的', async () => {
  await withProfiles(
    'profile-thread-skills',
    () => ['skills.config=[{ name = "alpha", enabled = false }]'],
    async (stage) => {
      for (const name of ['alpha', 'beta']) {
        const dir = join(stage.directory, '.claude', 'skills', name)
        mkdirSync(dir, { recursive: true })
        writeFileSync(join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: d\n---\nBODY\n`)
      }
      const beta = join(stage.directory, '.claude', 'skills', 'beta', 'SKILL.md')
      const client = await stage.connect('client')
      const plain = await client.request('thread/start', { cwd: stage.directory })
      const base = await captureTurn(stage, client, { threadId: plain.thread.id })
      assert.deepEqual({ ...base.skillOverrides }, { alpha: 'off' })
      assert.equal(base.disableBundledSkills, undefined)
      // 整张 skills 表换掉 -c 的：alpha 回到开着，beta 按路径关，自带的关掉
      const scoped = await client.request('thread/start', {
        cwd: stage.directory,
        config: {
          skills: { config: [{ path: beta, enabled: false }], bundled: { enabled: false } },
        },
      })
      const context = await captureTurn(stage, client, { threadId: scoped.thread.id })
      assert.deepEqual({ ...context.skillOverrides }, { beta: 'off' })
      assert.equal(context.disableBundledSkills, true)
      // 恢复时给的 config 同样记下
      await client.request('thread/resume', {
        threadId: plain.thread.id,
        config: { 'skills.config': [{ name: 'beta', enabled: false }] },
      })
      const resumed = await captureTurn(stage, client, { threadId: plain.thread.id })
      assert.deepEqual({ ...resumed.skillOverrides }, { beta: 'off' })
      // 进程级的 skills/list 不受线程 config 影响（codex 的 skills/list 也不带线程）
      const listed = (await client.request('skills/list', { cwds: [stage.directory] })).data[0]
      assert.deepEqual(
        listed.skills.map((skill: { name: string; enabled: boolean }) => [
          skill.name,
          skill.enabled,
        ]),
        [
          ['alpha', false],
          ['beta', true],
        ],
      )
      for (const config of [
        { skills: 'x' },
        { skills: { bundled: { enabled: 'no' } } },
        { 'skills.config': [{ path: 'relative', enabled: false }] },
      ]) {
        const bad = await client.raw('thread/start', { cwd: stage.directory, config })
        assert.equal(bad.error?.code, -32602, JSON.stringify(config))
      }
    },
  )
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
  // 每一步都起新 CLI：留着的进程里 CLI 对同一个文件回“没变，参照上次”，看不出这一步的权限
  const client = await ProtocolClient.start(home, await model.start(), false, 'api-key', {
    CHA_CLAUDE_KEEP_ALIVE_IDLE_SECONDS: '0',
  })
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
    let current = thread.id
    const call = async (
      name: string,
      input: Record<string, unknown>,
      allowed: boolean,
      turnParams: Record<string, unknown> = { permissions: 'saas' },
    ) => {
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
        threadId: current,
        input: text(`第 ${sequence} 步`),
        ...turnParams,
      })
      const completed = await client.completed(turn.id)
      assert.equal(completed.status, 'completed', client.stderr.slice(-3000))
      model.assertConsumed()
      return output
    }
    assert.match(await call('Read', { file_path: join(own, 'mine.txt') }, true), /MINE/)
    assert.match(await call('Read', { file_path: join(home, 'ws/B/secret') }, false), /禁止读取/)
    // 工作目录外可读的文件照 codex 直接读，不走审批（never 下原先会被当成审批请求拒掉）
    writeFileSync(join(home, 'shared/note.txt'), 'SHARED')
    assert.match(await call('Read', { file_path: join(home, 'shared/note.txt') }, true), /SHARED/)
    // 链接指向禁读目录的，按真实路径拒
    symlinkSync(join(home, 'ws/B'), join(home, 'shared/b-link'))
    assert.match(
      await call('Read', { file_path: join(home, 'shared/b-link/secret') }, false),
      /禁止读取/,
    )
    const leaked = await call('Bash', { command: `cat ${join(home, 'ws/B/secret')}; true` }, true)
    assert.doesNotMatch(leaked, /SECRET_OF_B/)
    assert.match(leaked, /Operation not permitted|Permission denied|No such file/)
    await call('Bash', { command: 'printf ok > made.txt' }, true)
    assert.equal(readFileSync(join(own, 'made.txt'), 'utf8'), 'ok')
    // 工作区的 .claude 和 .codex、.git 一样只读：文件工具、命令都写不进去
    await call('Write', { file_path: join(own, '.claude/settings.json'), content: '{}' }, false)
    await call('Bash', { command: 'mkdir -p .claude/skills' }, false)
    assert.equal(existsSync(join(own, '.claude/settings.json')), false)
    assert.equal(existsSync(join(own, '.claude/skills')), false)
    // 线程 config 的 shell_environment_policy：只留基本变量加 set 的，CLI 自己的变量（模型地址等）不给命令
    const scoped = await client.request('thread/start', {
      cwd: own,
      permissions: 'saas',
      approvalPolicy: 'never',
      config: {
        shell_environment_policy: {
          inherit: 'core',
          set: { CLI_TOKEN: 'scoped', TMPDIR: join(own, 'tmp') },
        },
      },
    })
    current = scoped.thread.id
    const env = await call(
      'Bash',
      {
        command:
          'echo "T=$CLI_TOKEN A=${ANTHROPIC_BASE_URL:-none} L=${LITCH_THREAD_ID:+yes} D=$TMPDIR"',
      },
      true,
    )
    assert.ok(env.includes(`T=scoped A=none L=yes D=${join(own, 'tmp')}`), env)
    // CLI 自己的环境（模型凭据等）在 /proc/self/environ，文件类工具不许读（只有 Linux 有 /proc）
    if (process.platform === 'linux') {
      // 直接给 /proc/self/environ，CLI 自己也拦（当成设备文件）；经工作区里的链接绕过它的检查，由入口拦
      await call('Read', { file_path: '/proc/self/environ' }, false)
      symlinkSync('/proc/self/environ', join(own, 'env-link'))
      assert.match(await call('Read', { file_path: join(own, 'env-link') }, false), /禁止读取/)
    }
    // on-request、计划模式下读文件同样不发审批：可读的放行，禁读的直接拒
    const asking = await client.request('thread/start', {
      cwd: own,
      permissions: 'saas',
      approvalPolicy: 'on-request',
    })
    current = asking.thread.id
    const requests: string[] = []
    client.onServerRequest = async (method) => {
      requests.push(method)
      return { decision: 'decline' }
    }
    const plan = {
      permissions: 'saas',
      collaborationMode: {
        mode: 'plan',
        settings: {
          model: 'claude-sonnet-4-6',
          reasoning_effort: null,
          developer_instructions: null,
        },
      },
    }
    for (const turnParams of [{ permissions: 'saas' }, plan]) {
      assert.match(
        await call('Read', { file_path: join(home, 'shared/note.txt') }, true, turnParams),
        /SHARED/,
      )
      assert.match(
        await call('Read', { file_path: join(home, 'ws/B/secret') }, false, turnParams),
        /禁止读取/,
      )
    }
    // 计划文件默认放在工作区的 .claude/plans 下，计划模式里 CLI 给的那个照常能写
    let planFile = ''
    model.enqueue((request) => {
      const location = /create your plan at ([^\n]+?) using the Write tool/.exec(
        JSON.stringify(request).replaceAll('\\n', '\n'),
      )
      assert.ok(location, 'CLI 必须给出计划文件路径')
      planFile = location[1]!
      assert.ok(planFile.startsWith(join(own, '.claude/plans/')), planFile)
      return [
        {
          type: 'tool_use',
          id: 'toolu_plan',
          name: 'Write',
          input: { file_path: planFile, content: '# 计划' },
        },
      ]
    })
    model.enqueue((request) => {
      const result = request.messages
        .flatMap((m: any) => (Array.isArray(m.content) ? m.content : []))
        .find((b: any) => b.type === 'tool_result' && b.tool_use_id === 'toolu_plan') as any
      assert.notEqual(result?.is_error, true, JSON.stringify(result))
      return [{ type: 'text', text: '好' }]
    })
    const planned = await client.request('turn/start', {
      threadId: current,
      input: text('写计划'),
      ...plan,
    })
    assert.equal((await client.completed(planned.turn.id)).status, 'completed')
    model.assertConsumed()
    assert.equal(readFileSync(planFile, 'utf8'), '# 计划')
    // 内置档位整个磁盘可读：never 下读工作目录外的也放行
    const builtin = await client.request('thread/start', {
      cwd: own,
      sandbox: 'workspace-write',
      approvalPolicy: 'never',
    })
    current = builtin.thread.id
    assert.match(
      await call('Read', { file_path: join(home, 'ws/B/secret') }, true, {}),
      /SECRET_OF_B/,
    )
    assert.deepEqual(requests, [], '读文件不能发审批请求')
  } finally {
    await client.close()
    await model.close()
    rmSync(home, { recursive: true, force: true })
  }
})
