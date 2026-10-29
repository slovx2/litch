import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { access, chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import type { HarnessFeatures, PermissionPreset } from '../../protocol/src/harness-capabilities.mjs'
import { harnessDeclaration } from '../src/harness-declaration.mjs'
import { requireClaudeCliFor } from './fixtures/claude-cli.mjs'
import { assertRuntimeInfo } from './fixtures/extension-wire.mjs'
import { MockLLM, type ModelRequest } from './fixtures/mock-llm.mjs'
import { ProtocolClient } from './fixtures/protocol-client.mjs'

// 这个文件守着 `runtime/info` 里的结构化声明（src/harness-declaration.mts）和实际行为一致：
// 声明支持的调了确实成，声明不支持的确实没有。改了声明或对应的实现，这里要跟着过。
// 另外两类审批以外的细节各有专门的用例：权限申请（native-request-permissions）、
// MCP 征询（native-mcp-elicitation）、回退换原生历史（native-revert）、分叉位置（native-fork-position）。
const declared = harnessDeclaration('agent-sdk-sidecar')
const features = declared.features as HarnessFeatures
const presets = declared.permissionPresets as PermissionPreset[]

const exists = (path: string): Promise<boolean> =>
  access(path).then(
    () => true,
    () => false,
  )

const text = (value: string) => [{ type: 'text', text: value }]

// 按声明调用：声明支持的必须成功，声明不支持的必须被拒绝。
async function call(client: ProtocolClient, supported: boolean, method: string, params: unknown) {
  if (supported) return client.request(method, params)
  const response = await client.raw(method, params)
  assert.ok(response.error, `${method} 声明为不支持，调用却成功了`)
  return null
}

async function run(client: ProtocolClient, threadId: string, prompt: string): Promise<any> {
  const { turn } = await client.request('turn/start', { threadId, input: text(prompt) })
  const completed = await client.completed(turn.id)
  assert.equal(completed.status, 'completed', JSON.stringify(completed.error))
  return completed
}

const sawNotification = (client: ProtocolClient, method: string, turnId: string): boolean =>
  client.trace.some((entry) => entry.method === method && entry.params.turnId === turnId)

test('DECL-001：runtime/info 带结构化声明，原有字段原样保留', async () => {
  const home = await mkdtemp(join(tmpdir(), 'declaration-info-'))
  // 应答里的 CLI 版本和校验和要读真实的 CLI。
  await requireClaudeCliFor(home)
  const client = await ProtocolClient.start(home, 'http://127.0.0.1:1', true)
  try {
    const { result } = await client.raw('runtime/info')
    assertRuntimeInfo(result)
    assert.equal(result.engine, 'claude-code')
    assert.equal(result.releaseReady, false)
    assert.deepEqual(result.capabilities, [
      'history.pagination',
      'submission.idempotency',
      'dynamicTools',
      'nativeSession.rollback',
    ])
    const { displayName, badge, extensions, features: wired, permissionPresets } = result
    assert.deepEqual(
      { displayName, badge, extensions, features: wired, permissionPresets },
      declared,
    )
    assert.deepEqual([displayName, badge], ['Claude Code', 'CC'])
    // 后台命令、监视、子代理都停得掉（stop_task）
    assert.equal(wired.stopBackground, true)
    assert.equal(wired.stopAgent, true)
    assert.deepEqual(extensions, [
      'filePreview',
      'declineWithNote',
      'planConfirmation',
      'clientTools',
      'harnessConfig',
      'backgroundTasks',
    ])
    assert.deepEqual(
      presets.map((preset) => [preset.id, preset.risk, preset.requiresConfirmation]),
      [
        [':read-only', 'low', false],
        [':workspace', 'medium', false],
        [':danger-full-access', 'high', true],
      ],
    )
    // 测试用的模拟运行时照原生运行方式的样子做，报同一份声明。
    assert.deepEqual(harnessDeclaration('mock'), declared)
    // 实验性的运行方式没有逐项核对过：只报名字和徽标，不报能力位。
    for (const runtime of ['agent-http', 'agentapi', 'claude-p', 'codex-proxy'] as const)
      assert.deepEqual(harnessDeclaration(runtime), { displayName: 'Claude Code', badge: 'CC' })
  } finally {
    await client.close()
    await rm(home, { recursive: true, force: true })
  }
})

test('声明的 filePreview 确实支持限量读取，并拒绝未声明连接', async () => {
  for (const enabled of [false, true]) {
    const home = await mkdtemp(join(tmpdir(), 'declaration-preview-'))
    const client = await ProtocolClient.start(
      home,
      'http://127.0.0.1:1',
      true,
      'api-key',
      {},
      {
        litchExtensions: enabled ? ['filePreview'] : [],
      },
    )
    try {
      const path = join(home, 'image')
      await writeFile(path, Buffer.from([0, 255, 1, 2]))
      const params = { path, litchPreview: { root: home, maxBytes: 4 } }
      const reply = await client.raw('fs/readFile', params)
      if (!enabled) {
        assert.equal(reply.error?.code, -32602)
        continue
      }
      assert.deepEqual(reply.result, { dataBase64: 'AP8BAg==' })
      const rejected = await client.raw('fs/readFile', {
        ...params,
        litchPreview: { root: home, maxBytes: 1 },
      })
      assert.equal(rejected.error?.code, -32004)
      assert.deepEqual(rejected.error?.data, {
        litchPreview: { kind: 'tooLarge', bytes: 4, limit: 1 },
      })
    } finally {
      await client.close()
      await rm(home, { recursive: true, force: true })
    }
  }
})

test('DECL-002：能力位和权限预设与协议行为一致（模拟运行时）', { timeout: 120_000 }, async () => {
  const home = await mkdtemp(join(tmpdir(), 'declaration-mock-'))
  const repo = join(home, 'repo')
  await mkdir(repo)
  const git = (...args: string[]) =>
    execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', ...args], {
      cwd: repo,
      stdio: 'ignore',
    })
  await writeFile(join(repo, 'tracked.md'), 'tracked\n')
  git('init', '-q')
  git('add', '.')
  git('commit', '-q', '-m', 'init')
  const client = await ProtocolClient.start(home, 'http://127.0.0.1:1', true)
  const asked: string[] = []
  client.onServerRequest = async (method) => {
    asked.push(method)
    return method === 'item/tool/requestUserInput'
      ? { answers: { q0: { answers: ['OAuth'] } } }
      : { decision: 'accept' }
  }
  try {
    // 权限预设：每个声明的标识建会话时都认，会话设置里报的就是它。
    for (const preset of presets) {
      const started = await client.request('thread/start', { cwd: repo, permissions: preset.id })
      assert.equal(started.activePermissionProfile.id, preset.id)
    }
    const { thread } = await client.request('thread/start', {
      cwd: repo,
      permissions: ':workspace',
    })
    const threadId = thread.id

    // 审批的种类：命令走命令审批，改文件走文件改动审批。
    await run(client, threadId, 'approval')
    assert.equal(
      asked.includes('item/commandExecution/requestApproval'),
      features.approvals.kinds.includes('command'),
    )
    const target = join(repo, 'declared.txt')
    const wrote = await run(
      client,
      threadId,
      'create a file named declared.txt with exactly this content: DECLARED',
    )
    assert.equal(
      asked.includes('item/fileChange/requestApproval'),
      features.approvals.kinds.includes('fileChange'),
    )
    assert.equal(await readFile(target, 'utf8'), 'DECLARED')
    // 本回合差异：工作目录是 git 仓库时有。
    assert.equal(sawNotification(client, 'turn/diff/updated', wrote.id), features.turnDiff)

    // 待办进度与提问。
    const planned = await run(client, threadId, 'todo')
    assert.equal(sawNotification(client, 'turn/plan/updated', planned.id), features.planUpdates)
    await run(client, threadId, 'ask user question check')
    assert.equal(asked.includes('item/tool/requestUserInput'), features.userInput)

    // 过程说明与最终回答：消息开始时不带阶段值，结束时才有。
    const plain = await run(client, threadId, 'hello')
    const phases = (method: string) =>
      client.trace
        .filter(
          (entry) =>
            entry.method === method &&
            entry.params.turnId === plain.id &&
            entry.params.item.type === 'agentMessage',
        )
        .map((entry) => entry.params.item.phase)
    assert.equal(features.agentMessagePhase, 'onCompleted')
    assert.deepEqual(phases('item/started'), [null])
    assert.deepEqual(phases('item/completed'), ['final_answer'])

    // 发起回合接受的输入种类：五种都收，两种图片都到了运行时。
    await writeFile(join(home, 'pixel.png'), Buffer.from('iVBORw0KGgo=', 'base64'))
    const inputs: Record<string, unknown> = {
      text: { type: 'text', text: 'image input check' },
      image: { type: 'image', url: 'data:image/png;base64,iVBORw0KGgo=' },
      localImage: { type: 'localImage', path: join(home, 'pixel.png') },
      skill: { type: 'skill', name: 'declared-skill', path: join(home, 'SKILL.md') },
      mention: { type: 'mention', name: 'tracked.md', path: join(repo, 'tracked.md') },
    }
    assert.deepEqual(Object.keys(inputs), features.inputTypes)
    const multimodal = await client.request('turn/start', {
      threadId,
      input: features.inputTypes.map((type) => inputs[type]),
    })
    const echoed = await client.completed(multimodal.turn.id)
    assert.equal(echoed.status, 'completed', JSON.stringify(echoed.error))
    const answer = client.trace.find(
      (entry) =>
        entry.method === 'item/completed' &&
        entry.params.turnId === echoed.id &&
        entry.params.item.type === 'agentMessage',
    ).params.item.text
    assert.equal(answer.match(/image\/png/g)?.length, 2, answer)

    // 引导、设备侧队列、打断：都在同一个进行中的回合上试。
    const { turn: held } = await client.request('turn/start', {
      threadId,
      input: text('mock background shells'),
    })
    await client.notification('turn/started', (params) => params.turn.id === held.id)
    const steered = await call(client, features.steer, 'turn/steer', {
      threadId,
      expectedTurnId: held.id,
      input: text('追加一句'),
    })
    assert.equal(steered.turnId, held.id)
    // 插话接受的输入种类：声明的都收（图片也收，不再拒）
    assert.ok(features.steerInputTypes.every((type) => type in inputs))
    const steeredAll = await client.request('turn/steer', {
      threadId,
      expectedTurnId: held.id,
      input: features.steerInputTypes.map((type) => inputs[type]),
    })
    assert.equal(steeredAll.turnId, held.id)
    const queued = await call(client, features.queue, 'thread/queue/add', {
      threadId,
      clientUserMessageId: randomUUID(),
      input: text('排队的一句'),
    })
    const listed = await client.request('thread/queue/list', { threadId })
    assert.deepEqual(
      listed.data.map((entry: any) => entry.id),
      [queued.queuedSubmission.id],
    )
    await client.request('thread/queue/delete', {
      threadId,
      queuedSubmissionId: queued.queuedSubmission.id,
    })
    await call(client, features.interrupt, 'turn/interrupt', { threadId, turnId: held.id })
    assert.equal((await client.completed(held.id)).status, 'interrupted')

    // 改名、手动压缩、分叉。
    await call(client, features.rename, 'thread/name/set', { threadId, name: '声明测试' })
    assert.equal((await client.request('thread/read', { threadId })).thread.name, '声明测试')
    const finished = new Set(
      client.trace
        .filter((entry) => entry.method === 'turn/completed')
        .map((entry) => entry.params.turn.id),
    )
    await call(client, features.compact, 'thread/compact/start', { threadId })
    const compacted = await client.notification(
      'turn/completed',
      (params) => params.threadId === threadId && !finished.has(params.turn.id),
    )
    assert.equal(compacted.turn.status, 'completed')

    // 归档与恢复、删除。
    const spare = (await client.request('thread/start', { cwd: repo })).thread.id
    await call(client, features.archive, 'thread/archive', { threadId: spare })
    await call(client, features.archive, 'thread/unarchive', { threadId: spare })
    await call(client, features.delete, 'thread/delete', { threadId: spare })
    await client.raw('thread/read', { threadId: spare }, -32602)
    // 分叉和回退要有原生的消息边界，模拟运行时没有：在 DECL-003 里用真实 CLI 试。
  } finally {
    await client.close()
    await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})

const toolId = () => `toolu_${randomUUID().replace(/-/g, '').slice(0, 20)}`

const toolResults = (request: ModelRequest): any[] =>
  (request.messages ?? [])
    .flatMap((message: any) => (Array.isArray(message.content) ? message.content : []))
    .filter((block: any) => block.type === 'tool_result')

test('DECL-003：命令输出在结束时一次给全；回合进行中换的权限档到下一个回合才起作用', {
  timeout: 120_000,
}, async () => {
  const home = await mkdtemp(join(tmpdir(), 'declaration-native-'))
  const model = new MockLLM()
  const client = await ProtocolClient.start(home, await model.start())
  const asked: string[] = []
  client.onServerRequest = async (method) => {
    asked.push(method)
    return { decision: 'accept' }
  }
  try {
    const workspace = presets.find((preset) => preset.id === ':workspace') as PermissionPreset
    const full = presets.find((preset) => preset.id === ':danger-full-access') as PermissionPreset
    const { thread } = await client.request('thread/start', {
      cwd: home,
      permissions: workspace.id,
    })
    const threadId = thread.id

    // 第一个回合在“工作区”档下开始；模型的应答扣到会话换成“完全访问”之后才放行。
    let release!: () => void
    const switched = new Promise<void>((resolve) => {
      release = resolve
    })
    model.enqueue(async () => {
      await switched
      return [
        {
          type: 'tool_use',
          id: toolId(),
          name: 'Write',
          input: { file_path: join(home, 'first.txt'), content: 'FIRST' },
        },
      ]
    })
    model.enqueue(() => [{ type: 'text', text: 'FIRST_DONE' }])
    const first = await client.request('turn/start', { threadId, input: text('写第一个文件') })
    await client.notification('turn/started', (params) => params.turn.id === first.turn.id)
    await client.request('thread/settings/update', { threadId, permissions: full.id })
    const updated = await client.notification(
      'thread/settings/updated',
      (params) => params.threadSettings.activePermissionProfile?.id === full.id,
    )
    assert.equal(updated.threadId, threadId)
    release()
    assert.equal((await client.completed(first.turn.id)).status, 'completed')
    assert.equal(await readFile(join(home, 'first.txt'), 'utf8'), 'FIRST')
    // 正在进行的回合还是按开始时的那一档来问。
    assert.equal(asked.includes('item/fileChange/requestApproval'), !full.switchDuringTurn)
    model.assertConsumed()

    // 下一个回合用的是新的一档：命令不经审批直接执行。
    asked.length = 0
    model.enqueue(() => [
      {
        type: 'tool_use',
        id: toolId(),
        name: 'Bash',
        input: { command: 'printf one; sleep 1; printf two', description: 'two prints' },
      },
    ])
    model.enqueue((request) => {
      assert.match(JSON.stringify(toolResults(request).at(-1)), /onetwo/)
      return [{ type: 'text', text: 'SECOND_DONE' }]
    })
    const second = await run(client, threadId, '运行一条命令')
    assert.equal(asked.length === 0, full.switchInSession)
    // 命令跑了一秒、中间有两次输出，客户端只在结束时收到一段。
    const deltas = client.trace.filter(
      (entry) =>
        entry.method === 'item/commandExecution/outputDelta' && entry.params.turnId === second.id,
    )
    assert.equal(deltas.length > 1, features.commandOutputDelta)
    assert.equal(deltas.map((entry) => entry.params.delta).join(''), 'onetwo')
    model.assertConsumed()

    // 分叉带走全部回合；回退按个数、按回合标识都收。回退不动文件系统：第一轮写的文件还在。
    const fork = await call(client, features.fork, 'thread/fork', { threadId })
    const forkId = fork.thread.id
    assert.equal(fork.thread.forkedFromId, threadId)
    const turnsOf = async (id: string) =>
      (await client.request('thread/turns/list', { threadId: id })).data
    assert.equal((await turnsOf(forkId)).length, 2)
    await call(client, features.revert.byCount, 'thread/rollback', {
      threadId: forkId,
      numTurns: 1,
    })
    const kept = await turnsOf(forkId)
    assert.equal(kept.length, 1)
    await call(client, features.revert.byTurnId, 'thread/revert', {
      threadId: forkId,
      beforeTurnId: kept[0].id,
    })
    assert.deepEqual(await turnsOf(forkId), [])
    assert.equal((await turnsOf(threadId)).length, 2, '源会话不受分叉上的回退影响')
    assert.equal(await exists(join(home, 'first.txt')), !features.revert.restoresFiles)
  } finally {
    await client.close()
    await model.close()
    await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})

// 一个假的 git，放在被测进程 PATH 的最前面。回合开始时适配器要先问一次“这里是不是 git 仓库”
// （取 diff 基线），武装之后这一问停在这里，等用例放行；别的调用一律答“不在仓库里”。
// 用它把“换档正好落在回合启动的等待里”这个先后定下来，不靠机器快慢。
async function gatedGit(home: string) {
  const directory = join(home, 'git-gate')
  const [armed, entered, opened] = ['armed', 'entered', 'opened'].map((name) =>
    join(directory, name),
  ) as [string, string, string]
  await mkdir(directory)
  await writeFile(
    join(directory, 'git'),
    [
      '#!/bin/sh',
      `if [ "$*" = "rev-parse --is-inside-work-tree" ] && [ -e '${armed}' ]; then`,
      `  : > '${entered}'`,
      `  while [ ! -e '${opened}' ]; do sleep 0.05; done`,
      'fi',
      'exit 128',
      '',
    ].join('\n'),
  )
  await chmod(join(directory, 'git'), 0o755)
  return {
    path: `${directory}:${dirname(process.execPath)}:/usr/bin:/bin`,
    arm: () => writeFile(armed, ''),
    open: () => writeFile(opened, ''),
    async entered(): Promise<void> {
      const deadline = Date.now() + 45_000
      while (!(await exists(entered))) {
        if (Date.now() > deadline) throw new Error('回合开始后适配器没有来问 git')
        await new Promise((resolve) => setTimeout(resolve, 20))
      }
    },
  }
}

test('DECL-005：换档落在回合刚开始、还没组好运行环境的时候，这个回合仍然整个按开始时的那一档', {
  timeout: 120_000,
}, async () => {
  const home = await mkdtemp(join(tmpdir(), 'declaration-settle-'))
  const git = await gatedGit(home)
  const model = new MockLLM()
  const client = await ProtocolClient.start(home, await model.start(), false, 'api-key', {
    PATH: git.path,
  })
  const asked: string[] = []
  client.onServerRequest = async (method) => {
    asked.push(method)
    return { decision: 'accept' }
  }
  try {
    const workspace = presets.find((preset) => preset.id === ':workspace') as PermissionPreset
    const full = presets.find((preset) => preset.id === ':danger-full-access') as PermissionPreset
    const { thread } = await client.request('thread/start', {
      cwd: home,
      permissions: workspace.id,
    })
    model.enqueue(() => [
      {
        type: 'tool_use',
        id: toolId(),
        name: 'Write',
        input: { file_path: join(home, 'early.txt'), content: 'EARLY' },
      },
    ])
    model.enqueue(() => [{ type: 'text', text: 'EARLY_DONE' }])
    await git.arm()
    const { turn } = await client.request('turn/start', {
      threadId: thread.id,
      input: text('写一个文件'),
    })
    // 回合已经开始，适配器正等着 git 回话：这时候换档。
    await git.entered()
    await client.request('thread/settings/update', { threadId: thread.id, permissions: full.id })
    await client.notification(
      'thread/settings/updated',
      (params) => params.threadSettings.activePermissionProfile?.id === full.id,
    )
    await git.open()
    assert.equal((await client.completed(turn.id)).status, 'completed')
    // 权限模式和沙箱策略是同一档的：照“工作区”档问过，同意后写成了。两样各取一档的话，
    // 这次写入会被当成越界直接拒掉，问都不问。
    assert.equal(await readFile(join(home, 'early.txt'), 'utf8'), 'EARLY')
    assert.equal(asked.includes('item/fileChange/requestApproval'), !full.switchDuringTurn)
    model.assertConsumed()
  } finally {
    await client.close()
    await model.close()
    await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})

// 父子两路请求可能交错到达，按请求内容路由。
function delegating(home: string, background: boolean) {
  return (request: ModelRequest) => {
    const messages = (request.messages ?? []) as Array<Record<string, any>>
    const first = JSON.stringify(messages[0]?.content ?? '')
    const answered = messages.some((message) => message.role === 'assistant')
    if (first.includes('DECLARED_PARENT'))
      return answered
        ? [{ type: 'text', text: 'PARENT_DONE' }]
        : [
            {
              type: 'tool_use',
              id: toolId(),
              name: 'Agent',
              input: {
                description: '写一个文件',
                prompt: 'DECLARED_CHILD 写 child.txt',
                subagent_type: 'general-purpose',
                ...(background ? {} : { run_in_background: false }),
              },
            },
          ]
    if (first.includes('DECLARED_CHILD'))
      return answered
        ? [{ type: 'text', text: 'CHILD_DONE' }]
        : [
            {
              type: 'tool_use',
              id: toolId(),
              name: 'Write',
              input: { file_path: join(home, 'child.txt'), content: 'CHILD' },
            },
          ]
    throw new Error('收到无法归属的模型请求')
  }
}

for (const background of [false, true])
  test(`DECL-004：${background ? '后台' : '前台'}子代理里的改文件调用也来问用户，同意后才执行`, {
    timeout: 120_000,
  }, async () => {
    const home = await mkdtemp(join(tmpdir(), 'declaration-subagent-'))
    const model = new MockLLM()
    const client = await ProtocolClient.start(home, await model.start())
    const asked: Array<{ method: string; params: any; written: boolean }> = []
    client.onServerRequest = async (method, params) => {
      asked.push({ method, params, written: await exists(join(home, 'child.txt')) })
      return { decision: 'accept' }
    }
    try {
      const { thread } = await client.request('thread/start', {
        cwd: home,
        permissions: ':workspace',
      })
      model.fallback = delegating(home, background)
      const { turn } = await client.request('turn/start', {
        threadId: thread.id,
        input: text('DECLARED_PARENT 派子代理写 child.txt'),
      })
      const completed = await client.completed(turn.id)
      assert.equal(
        completed.status,
        'completed',
        JSON.stringify({ error: completed.error, unexpected: model.unexpected }),
      )
      const approvals = asked.filter((entry) => entry.method === 'item/fileChange/requestApproval')
      const covered = !features.approvals.uncovered.includes('subagents')
      assert.equal(approvals.length === 1, covered, JSON.stringify(asked))
      if (covered) {
        assert.equal(
          approvals[0]?.params.threadId,
          thread.id,
          '子代理的审批挂在父会话上，由父会话的订阅者来答',
        )
        assert.equal(approvals[0]?.written, false, '问的时候文件还没写')
        assert.equal(await readFile(join(home, 'child.txt'), 'utf8'), 'CHILD')
      }
    } finally {
      await client.close()
      await model.close()
      await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
    }
  })
