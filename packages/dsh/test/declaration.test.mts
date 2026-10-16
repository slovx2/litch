import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'
import type { HarnessFeatures, PermissionPreset } from '../../protocol/src/harness-capabilities.mjs'
import { declaration } from '../src/declaration.mjs'
import { DshServer } from '../src/server.mjs'
import { client, isolate, violations } from './client.mjs'
import { type MockBlock, scripted } from './mock-model.mjs'

// 这个文件守着 `runtime/info` 里的结构化声明（src/declaration.mts）和实际行为一致：
// 声明支持的调了确实成，声明不支持的调了确实被拒。改了声明或对应的实现，这里要跟着过。
const features = declaration.features as HarnessFeatures
const presets = declaration.permissionPresets as PermissionPreset[]

const text = (value: string) => [{ type: 'text', text: value }]

// 一个像素的 PNG。
const PIXEL =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

// 模型收到的全部工具结果，拼成一段文字。
const toolResults = (requests: any[]): string =>
  JSON.stringify(
    requests
      .flatMap((body) => body.messages ?? [])
      .flatMap((message: any) => (Array.isArray(message.content) ? message.content : []))
      .filter((block: any) => block.type === 'tool_result'),
  )

type Scene = Awaited<ReturnType<typeof isolate>> & {
  server: DshServer
  desktop: ReturnType<typeof client>
}

// 一个 dsh 引擎、一个回环模型、一个假客户端；握手时可以声明扩展。
async function scene(
  respond: (body: any) => MockBlock[],
  capabilities: Record<string, unknown> | null = null,
): Promise<Scene> {
  const env = await isolate((body) =>
    body.tools?.length ? respond(body) : [{ type: 'text', chunks: ['mock 标题'] }],
  )
  const server = new DshServer(join(env.root, 'home'))
  const desktop = client(server)
  await desktop.call('initialize', { clientInfo: { name: 'test', version: '0' }, capabilities })
  return { ...env, server, desktop }
}

async function dispose(s: Scene): Promise<void> {
  await s.server.close()
  await s.restore()
}

// 按声明调用：声明支持的必须成功；声明不支持的必须答“方法不存在”，不能假装成功。
async function declared(s: Scene, supported: boolean, method: string, params: unknown) {
  if (supported) return s.desktop.call(method, params)
  await assert.rejects(
    s.desktop.call(method, params),
    (error: any) => error.code === -32601,
    `${method} 声明为不支持，应当答 -32601`,
  )
  return null
}

async function run(s: Scene, threadId: string, input: unknown[]): Promise<any> {
  const before = s.desktop.notifications.length
  await s.desktop.call('turn/start', { threadId, input })
  const done = await s.desktop.until(
    'turn/completed',
    (params) =>
      params.threadId === threadId &&
      s.desktop.notifications.findIndex((entry) => entry.params === params) >= before,
  )
  return done.turn
}

test('dsh：runtime/info 带结构化声明，原有字段原样保留', { timeout: 120000 }, async () => {
  const s = await scene(() => [{ type: 'text', chunks: ['好的。'] }])
  try {
    const info = await s.desktop.call('runtime/info')
    assert.equal(info.engine, 'dsh')
    assert.equal(info.releaseReady, false)
    assert.deepEqual(info.capabilities, ['submission.idempotency'])
    const { displayName, badge, extensions, features: wired, permissionPresets } = info
    assert.deepEqual(
      { displayName, badge, extensions, features: wired, permissionPresets },
      declaration,
    )
    // 名字是产品自己的叫法（它的 --help 里自称 DeepSeek Harness，界面里用简称 DSH），dsh 是命令名
    assert.deepEqual([displayName, badge], ['DSH', 'DS'])
    // dsh 的审批带不了话：不支持 declineWithNote。
    assert.deepEqual(extensions, [])
    assert.deepEqual(
      presets.map((preset) => [preset.id, preset.risk, preset.requiresConfirmation]),
      [
        [':read-only', 'low', false],
        [':workspace', 'medium', false],
        [':danger-full-access', 'high', true],
      ],
    )
    assert.deepEqual([...violations], [], '往来消息必须符合协议 schema')
  } finally {
    await dispose(s)
  }
})

test('dsh：能力位与协议行为一致；审批请求里不列“拒绝并附说明”', { timeout: 180000 }, async () => {
  const escalate = { sandbox_permissions: 'danger-full-access', justification: '测试提权审批。' }
  const read: MockBlock = { type: 'tool_use', name: 'read', input: { file_path: 'a.txt' } }
  const s = await scene(
    scripted({
      ASK_COMMAND: [
        [
          {
            type: 'tool_use',
            name: 'bash',
            input: {
              command: 'printf one; sleep 1; printf two',
              description: '提权的命令',
              ...escalate,
            },
          },
        ],
      ],
      ASK_FILE: [
        [read],
        [
          {
            type: 'tool_use',
            name: 'edit',
            input: { file_path: 'a.txt', old_string: 'hello', new_string: 'world', ...escalate },
          },
        ],
      ],
      SLOW: [[{ type: 'text', chunks: Array.from({ length: 80 }, () => '慢 '), delayMs: 100 }]],
    }),
    // 握手时声明了 declineWithNote 也一样：dsh 做不到，就不列，不假装支持。
    { litchExtensions: ['declineWithNote'] },
  )
  try {
    const { desktop } = s
    await writeFile(join(s.cwd, 'a.txt'), 'hello\n')
    const asked: any[] = []
    desktop.onRequest((request) => {
      asked.push(request)
      return { decision: 'accept' }
    })
    // 权限预设：每个声明的标识建会话时都认。
    for (const preset of presets)
      assert.equal(
        (await desktop.call('thread/start', { cwd: s.cwd, permissions: preset.id })).permissions,
        preset.id,
      )
    const started = await desktop.call('thread/start', { cwd: s.cwd, permissions: ':read-only' })
    const threadId = started.thread.id

    // 审批的种类：模型申请放宽沙箱时才问。命令走命令审批，改文件的工具走文件改动审批。
    const command = await run(s, threadId, text('ASK_COMMAND'))
    assert.equal(command.status, 'completed', JSON.stringify(command.error))
    const edit = await run(s, threadId, text('ASK_FILE'))
    assert.equal(edit.status, 'completed', JSON.stringify(edit.error))
    assert.deepEqual(
      asked.map((request) => request.method),
      [
        ...(features.approvals.kinds.includes('command')
          ? ['item/commandExecution/requestApproval']
          : []),
        ...(features.approvals.kinds.includes('fileChange')
          ? ['item/fileChange/requestApproval']
          : []),
      ],
    )
    assert.equal(
      await readFile(join(s.cwd, 'a.txt'), 'utf8'),
      'world\n',
      toolResults(s.model.requests).slice(-800),
    )
    // 决定只有 dsh 真的区分的那几种，没有“拒绝并附说明”。
    assert.deepEqual(asked[0].params.availableDecisions, ['accept', 'decline', 'cancel'])
    assert.equal('availableDecisions' in asked[1].params, false)
    // 命令的输出不是增量：没有输出增量通知，结果随条目结束一次给全。
    const methods = new Set(desktop.notifications.map((entry) => entry.method))
    assert.equal(methods.has('item/commandExecution/outputDelta'), features.commandOutputDelta)
    const ran = command.items.find((item: any) => item.type === 'commandExecution')
    assert.match(ran.aggregatedOutput, /onetwo/)
    // 不发本回合差异和待办进度；这几个回合里除了审批没有别的服务端请求。不转发 MCP 征询；
    // 提问（features.userInput）要模型调提问工具才有，在 questions.test.mts 里。
    assert.equal(methods.has('turn/diff/updated'), features.turnDiff)
    assert.equal(methods.has('turn/plan/updated'), features.planUpdates)
    assert.equal(features.mcpElicitation, false)
    assert.equal(features.userInput, true)
    assert.equal(asked.length, 2)
    // 过程说明与最终回答：流式开始时一律先报成最终回答，消息结束时才准。
    assert.equal(features.agentMessagePhase, 'onCompleted')

    // 发起回合接受的输入种类。
    await writeFile(join(s.root, 'pixel.png'), Buffer.from(PIXEL, 'base64'))
    const inputs: Record<string, unknown> = {
      text: { type: 'text', text: '看图' },
      image: { type: 'image', url: `data:image/png;base64,${PIXEL}` },
      localImage: { type: 'localImage', path: join(s.root, 'pixel.png') },
      skill: { type: 'skill', name: 'declared-skill', path: join(s.root, 'SKILL.md') },
      mention: { type: 'mention', name: 'a.txt', path: join(s.cwd, 'a.txt') },
    }
    assert.deepEqual(Object.keys(inputs), features.inputTypes)
    const seen = s.model.requests.length
    const multimodal = await run(
      s,
      threadId,
      features.inputTypes.map((type) => inputs[type]),
    )
    assert.equal(multimodal.status, 'completed', JSON.stringify(multimodal.error))
    const images = (body: any) =>
      (body.messages ?? [])
        .flatMap((message: any) => (Array.isArray(message.content) ? message.content : []))
        .filter((part: any) => part.type === 'image').length
    assert.ok(
      s.model.requests.slice(seen).some((body) => images(body) === 2),
      '两种图片都到了模型',
    )

    // 引导与打断：在同一个进行中的回合上试。插话也收图片。
    const before = desktop.notifications.length
    const { turn } = await desktop.call('turn/start', { threadId, input: text('SLOW') })
    await desktop.until(
      'item/agentMessage/delta',
      (params) => params.turnId === turn.id && params.delta.includes('慢'),
    )
    assert.deepEqual(features.steerInputTypes, features.inputTypes)
    const steered = await declared(s, features.steer, 'turn/steer', {
      threadId,
      expectedTurnId: turn.id,
      input: [inputs.text, inputs.image],
    })
    assert.equal(steered.turnId, turn.id)
    await declared(s, features.interrupt, 'turn/interrupt', { threadId, turnId: turn.id })
    const stopped = await desktop.until(
      'turn/completed',
      (params) =>
        params.turn.id === turn.id &&
        desktop.notifications.findIndex((entry) => entry.params === params) >= before,
    )
    assert.equal(stopped.turn.status, 'interrupted')

    // 改名、归档与恢复：支持。
    await declared(s, features.rename, 'thread/name/set', { threadId, name: '声明测试' })
    await declared(s, features.archive, 'thread/archive', { threadId })
    await declared(s, features.archive, 'thread/unarchive', { threadId })
    // 压缩、分叉、回退、设备侧队列、删除：声明不支持，调了答“方法不存在”。
    const turnId = command.id
    await declared(s, features.compact, 'thread/compact/start', { threadId })
    await declared(s, features.fork, 'thread/fork', { threadId })
    await declared(s, features.revert.byTurnId, 'thread/revert', { threadId, beforeTurnId: turnId })
    await declared(s, features.revert.byCount, 'thread/rollback', { threadId, numTurns: 1 })
    await declared(s, features.queue, 'thread/queue/add', {
      threadId,
      clientUserMessageId: 'queued',
      input: text('排队的一句'),
    })
    await declared(s, features.delete, 'thread/delete', { threadId })
    assert.equal((await desktop.call('thread/read', { threadId })).thread.name, '声明测试')
    assert.deepEqual([...violations], [], '往来消息必须符合协议 schema')
  } finally {
    await dispose(s)
  }
})

test('dsh：权限档在回合进行中换了，同一回合里后面的工具调用就按新的一档', {
  timeout: 180000,
}, async () => {
  const edit = (from: string, to: string): MockBlock => ({
    type: 'tool_use',
    name: 'edit',
    input: { file_path: 'a.txt', old_string: from, new_string: to },
  })
  const read: MockBlock = { type: 'tool_use', name: 'read', input: { file_path: 'a.txt' } }
  const s = await scene(
    scripted({
      EDIT_NOW: [[read], [edit('hello', 'first')]],
      // 读完文件先慢慢说一段话再改：客户端趁这段时间换档。
      EDIT_LATER: [
        [read],
        [
          { type: 'text', chunks: Array.from({ length: 30 }, () => '等 '), delayMs: 100 },
          edit('hello', 'second'),
        ],
      ],
    }),
  )
  try {
    const { desktop } = s
    const file = join(s.cwd, 'a.txt')
    await writeFile(file, 'hello\n')
    const readOnly = presets.find((preset) => preset.id === ':read-only') as PermissionPreset
    const workspace = presets.find((preset) => preset.id === ':workspace') as PermissionPreset
    const { thread } = await desktop.call('thread/start', { cwd: s.cwd, permissions: readOnly.id })

    // 只读档：改文件被沙箱挡下，不来问（模型没有申请放宽）。
    const blocked = await run(s, thread.id, text('EDIT_NOW'))
    assert.equal(blocked.status, 'completed', JSON.stringify(blocked.error))
    assert.equal(await readFile(file, 'utf8'), 'hello\n')
    assert.match(toolResults(s.model.requests), /sandbox/i, '改文件是被沙箱挡下的')
    assert.equal(desktop.requests.length, 0)

    // 回合在只读档下开始，模型还在说话时换成工作区档：随后的改文件直接成功。
    const before = desktop.notifications.length
    const { turn } = await desktop.call('turn/start', {
      threadId: thread.id,
      input: text('EDIT_LATER'),
    })
    await desktop.until(
      'item/agentMessage/delta',
      (params) => params.turnId === turn.id && params.delta.includes('等'),
    )
    assert.equal(workspace.switchInSession, true)
    await desktop.call('thread/settings/update', { threadId: thread.id, permissions: workspace.id })
    const done = await desktop.until(
      'turn/completed',
      (params) =>
        params.turn.id === turn.id &&
        desktop.notifications.findIndex((entry) => entry.params === params) >= before,
    )
    assert.equal(done.turn.status, 'completed', JSON.stringify(done.turn.error))
    assert.equal(
      (await readFile(file, 'utf8')) === 'second\n',
      workspace.switchDuringTurn,
      `回合进行中换的档对这个回合后面的工具调用起作用 ${toolResults(s.model.requests).slice(-800)}`,
    )
    assert.equal(desktop.requests.length, 0)
    assert.equal(
      (await desktop.call('thread/read', { threadId: thread.id })).thread.activePermissionProfile,
      workspace.id,
    )
    assert.deepEqual([...violations], [], '往来消息必须符合协议 schema')
  } finally {
    await dispose(s)
  }
})

test('dsh：子代理申请放宽沙箱时不会来问用户，直接被拒绝', { timeout: 180000 }, async () => {
  const s = await scene(
    scripted({
      // 子代理的任务：一上来就申请放宽沙箱去跑命令。
      CHILD_TASK: [
        [
          {
            type: 'tool_use',
            name: 'bash',
            input: {
              command: 'printf child > child.txt',
              description: '子代理提权的命令',
              sandbox_permissions: 'danger-full-access',
              justification: '测试子代理的提权。',
            },
          },
        ],
      ],
      SPAWN: [
        [
          {
            type: 'tool_use',
            name: 'subagent',
            input: { description: '跑一条命令', prompt: 'CHILD_TASK 运行一条需要提权的命令' },
          },
        ],
      ],
    }),
  )
  try {
    const { desktop } = s
    desktop.onRequest(() => ({ decision: 'accept' }))
    const { thread } = await desktop.call('thread/start', { cwd: s.cwd, permissions: ':workspace' })
    await desktop.call('turn/start', { threadId: thread.id, input: text('SPAWN') })
    // 子代理拿到这次调用的结果（被拒绝）之后会再问一次模型：等到那次请求。
    // 子代理有自己的会话：它的模型请求第一条消息就是交给它的任务。
    const childResult = (): string =>
      toolResults(
        s.model.requests.filter((body) =>
          JSON.stringify(body.messages?.[0]?.content ?? '').includes('CHILD_TASK 运行'),
        ),
      )
    for (let waited = 0; waited < 60000 && !/rejected/.test(childResult()); waited += 50)
      await new Promise((resolve) => setTimeout(resolve, 50))
    assert.match(childResult(), /rejected/, '子代理的提权被拒绝')
    assert.equal(
      desktop.requests.length === 0,
      features.approvals.uncovered.includes('subagents'),
      '子代理的提权没有来问用户',
    )
    await assert.rejects(readFile(join(s.cwd, 'child.txt')), '被拒绝的命令没有执行')
    await desktop.until('turn/completed', (params) => params.threadId === thread.id)
    assert.deepEqual([...violations], [], '往来消息必须符合协议 schema')
  } finally {
    await dispose(s)
  }
})
