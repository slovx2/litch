import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import type { HarnessFeatures } from '../../protocol/src/harness-capabilities.mjs'
import type { RpcPeer, WireMessage } from '../../shared/src/types.mjs'
import { harnessDeclaration } from '../src/declaration.mjs'
import { PiServer } from '../src/server.mjs'
import { assertResponse } from './schema.mjs'

// 这个文件守着 `runtime/info` 里的结构化声明（src/declaration.mts）和实际行为一致：
// 声明支持的调了确实成，声明不支持的确实没有。改了声明或对应的实现，这里要跟着过。
// 这里是没打开审批的声明，也就是默认的样子；打开之后的声明和行为在 approvals.test.mts。
const declaration = harnessDeclaration(false)
const features = declaration.features as HarnessFeatures

type Reply = { text?: string; tools?: Array<{ name: string; args: unknown }> }
type Step = Reply | ((body: any) => Reply | Promise<Reply>)

// 真实 Pi SDK 加本地假模型；独立的临时目录，结束时全部清掉。
async function harness() {
  const root = await mkdtemp(join(tmpdir(), 'pi-declaration-'))
  const agentDir = join(root, 'agent'),
    cwd = join(root, 'project')
  await mkdir(agentDir)
  await mkdir(cwd)
  const previous = process.env.PI_CODING_AGENT_DIR
  process.env.PI_CODING_AGENT_DIR = agentDir
  // 排了步骤的请求按步骤应答，没排的回一句话。
  const requests: any[] = []
  const steps: Step[] = []
  const http = createServer(async (req, res) => {
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    const body = JSON.parse(Buffer.concat(chunks).toString())
    requests.push(body)
    const step = steps.shift() ?? { text: `回答${requests.length}` }
    const reply = typeof step === 'function' ? await step(body) : step
    if (res.destroyed) return
    const base = {
      id: `mock_${requests.length}`,
      object: 'chat.completion.chunk',
      created: 1,
      model: body.model,
    }
    const calls = reply.tools?.map((tool, index) => ({
      index,
      id: `call_${requests.length}_${index}`,
      type: 'function',
      function: { name: tool.name, arguments: JSON.stringify(tool.args) },
    }))
    res.writeHead(200, { 'Content-Type': 'text/event-stream' })
    res.write(
      `data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: { role: 'assistant', ...(calls ? { tool_calls: calls } : { content: reply.text ?? 'ok' }) }, finish_reason: null }] })}\n\n`,
    )
    res.write(
      `data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: calls ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } })}\n\n`,
    )
    res.end('data: [DONE]\n\n')
  })
  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve))
  await writeFile(
    join(agentDir, 'models.json'),
    JSON.stringify({
      providers: {
        gate: {
          baseUrl: `http://127.0.0.1:${(http.address() as any).port}/v1`,
          api: 'openai-completions',
          apiKey: 'test-only',
          models: [
            {
              id: 'gate',
              name: 'Gate',
              reasoning: false,
              input: ['text', 'image'],
              contextWindow: 32000,
              maxTokens: 1024,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            },
          ],
        },
      },
    }),
  )
  await writeFile(
    join(agentDir, 'settings.json'),
    JSON.stringify({
      defaultProvider: 'gate',
      defaultModel: 'gate',
      retry: { enabled: false },
      compaction: { keepRecentTokens: 0 },
    }),
  )
  const server = new PiServer(join(root, 'state'))
  const messages: any[] = []
  const peer: RpcPeer = {
    id: 'desktop',
    close() {},
    send(message: WireMessage) {
      messages.push(message)
    },
  }
  let sequence = 0
  const call = async (method: string, params: any = {}) => {
    const id = ++sequence
    await server.handle(peer, { jsonrpc: '2.0', id, method, params })
    const reply = messages.find((m) => m.id === id && !m.method)
    assert.ok(reply, `缺少 ${method} 响应`)
    return reply
  }
  const ok = async (method: string, params: any = {}) => {
    const reply = await call(method, params)
    assert.equal(reply.error, undefined, `${method}: ${JSON.stringify(reply.error)}`)
    assertResponse(method, reply.result)
    return reply.result
  }
  const wait = async (predicate: (m: any) => boolean): Promise<any> => {
    for (let waited = 0; waited < 30000; waited += 20) {
      const found = messages.find(predicate)
      if (found) return found
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
    throw new Error('等待消息超时')
  }
  const completed = async (turnId: string) =>
    (await wait((m) => m.method === 'turn/completed' && m.params.turn.id === turnId)).params.turn
  return {
    root,
    cwd,
    requests,
    steps,
    messages,
    call,
    ok,
    wait,
    completed,
    // 按声明调用：声明支持的必须成功，声明不支持的必须被拒绝。
    async declared(supported: boolean, method: string, params: any): Promise<any> {
      if (supported) return ok(method, params)
      const reply = await call(method, params)
      assert.ok(reply.error, `${method} 声明为不支持，调用却成功了`)
      return null
    },
    async run(threadId: string, input: any[]): Promise<any> {
      const { turn } = await ok('turn/start', { threadId, input })
      const done = await completed(turn.id)
      assert.equal(done.status, 'completed', JSON.stringify(done.error))
      return done
    },
    async close(): Promise<void> {
      await server.close()
      http.closeAllConnections()
      await new Promise<void>((resolve) => http.close(() => resolve()))
      if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR
      else process.env.PI_CODING_AGENT_DIR = previous
      await rm(root, { recursive: true, force: true })
    },
  }
}

const text = (value: string) => [{ type: 'text', text: value }]

// 一个像素的 PNG。
const PIXEL =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

test('Pi：runtime/info 带结构化声明，原有字段原样保留', { timeout: 60000 }, async () => {
  const h = await harness()
  try {
    await h.ok('initialize')
    const info = await h.ok('runtime/info')
    assert.equal(info.engine, 'pi')
    assert.equal(info.releaseReady, false)
    assert.deepEqual(info.capabilities, [
      'history.pagination',
      'submission.idempotency',
      'dynamicTools',
      'nativeSession.rollback',
      'nativeSession.revert.paginated',
      'nativeSession.rollback.paginated',
    ])
    const { displayName, badge, extensions, features: wired, permissionPresets } = info
    assert.deepEqual(
      { displayName, badge, extensions, features: wired, permissionPresets },
      declaration,
    )
    assert.deepEqual([displayName, badge], ['Pi', 'PI'])
    // 没打开审批时不发审批，扩展只有计划确认（交了计划之后的那一问只对声明了的连接问）和客户端工具。
    assert.deepEqual(extensions, ['planConfirmation', 'clientTools'])
    assert.deepEqual(features.approvals, { kinds: [], uncovered: [] })
    // 只有一档，没得选：不用确认，也不能切换。
    assert.deepEqual(
      permissionPresets.map((preset: any) => [
        preset.id,
        preset.risk,
        preset.requiresConfirmation,
        preset.switchInSession,
        preset.switchDuringTurn,
      ]),
      [[':danger-full-access', 'high', false, false, false]],
    )
  } finally {
    await h.close()
  }
})

test('Pi：能力位和权限预设与协议行为一致', { timeout: 120000 }, async () => {
  const h = await harness()
  try {
    // 握手时声明了扩展也一样：没打开审批时不产出扩展内容。
    await h.ok('initialize', {
      clientInfo: { name: 'test', version: '0' },
      capabilities: { litchExtensions: ['declineWithNote'] },
    })
    // 权限预设只有“完全访问”：客户端选别的档也不会变，会话报的始终是它。
    const started = await h.ok('thread/start', {
      cwd: h.cwd,
      model: 'gate/gate',
      permissions: ':read-only',
    })
    const threadId = started.thread.id
    assert.equal(started.thread.activePermissionProfile, ':danger-full-access')
    assert.equal(started.approvalPolicy, 'never')
    assert.deepEqual(started.sandbox, { type: 'dangerFullAccess' })

    // 不发审批：命令和改文件都直接执行。命令的输出一段一段地来。
    h.steps.push(
      {
        tools: [
          { name: 'bash', args: { command: 'printf one; sleep 1.5; printf two' } },
          { name: 'write', args: { path: join(h.cwd, 'direct.txt'), content: 'DIRECT' } },
        ],
      },
      { text: '都做完了' },
    )
    const worked = await h.run(threadId, text('运行命令并写文件'))
    assert.equal(existsSync(join(h.cwd, 'direct.txt')), true)
    const requested = h.messages.filter((m) => m.method && m.id !== undefined)
    assert.deepEqual(
      requested.map((m) => m.method),
      [],
      '没有任何服务端请求（审批、提问）',
    )
    const during = (method: string, turnId: string) =>
      h.messages.filter((m) => m.method === method && m.params.turnId === turnId)
    const deltas = during('item/commandExecution/outputDelta', worked.id)
    assert.equal(deltas.map((m) => m.params.delta).join(''), 'onetwo')
    assert.equal(deltas.length > 1, features.commandOutputDelta)
    // 不发本回合差异，也不发待办进度。
    assert.equal(during('turn/diff/updated', worked.id).length > 0, features.turnDiff)
    assert.equal(during('turn/plan/updated', worked.id).length > 0, features.planUpdates)
    // 过程说明与最终回答：消息结束时才分得清。
    assert.equal(features.agentMessagePhase, 'onCompleted')
    const phases = during('item/completed', worked.id)
      .filter((m) => m.params.item.type === 'agentMessage')
      .map((m) => m.params.item.phase)
    assert.deepEqual(phases, ['final_answer'])

    // 发起回合接受的输入种类。
    await writeFile(join(h.root, 'pixel.png'), Buffer.from(PIXEL, 'base64'))
    const inputs: Record<string, unknown> = {
      text: { type: 'text', text: '看图' },
      image: { type: 'image', url: `data:image/png;base64,${PIXEL}` },
      localImage: { type: 'localImage', path: join(h.root, 'pixel.png') },
      skill: { type: 'skill', name: 'declared-skill', path: join(h.root, 'SKILL.md') },
      mention: { type: 'mention', name: 'direct.txt', path: join(h.cwd, 'direct.txt') },
    }
    assert.deepEqual(Object.keys(inputs), features.inputTypes)
    await h.run(
      threadId,
      features.inputTypes.map((type) => inputs[type]),
    )
    const images = (body: any) =>
      body.messages
        .flatMap((m: any) => (Array.isArray(m.content) ? m.content : []))
        .filter((part: any) => part.type === 'image_url').length
    assert.equal(
      images(h.requests.at(-1)),
      2,
      JSON.stringify(h.requests.at(-1).messages).slice(0, 1500),
    )

    // 引导、设备侧队列、打断：都在同一个进行中的回合上试。引导时图片也带得过去。
    let release!: () => void
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    h.steps.push(async () => {
      await held
      return { tools: [{ name: 'bash', args: { command: 'sleep 30' } }] }
    })
    const { turn } = await h.ok('turn/start', { threadId, input: text('等一下') })
    await h.wait((m) => m.method === 'turn/started' && m.params.turn.id === turn.id)
    assert.deepEqual(features.steerInputTypes, features.inputTypes)
    const steered = await h.declared(features.steer, 'turn/steer', {
      threadId,
      expectedTurnId: turn.id,
      input: [inputs.text, inputs.image],
    })
    assert.equal(steered.turnId, turn.id)
    const queued = await h.declared(features.queue, 'thread/queue/add', {
      threadId,
      clientUserMessageId: randomUUID(),
      input: text('排队的一句'),
    })
    assert.deepEqual(
      (await h.ok('thread/queue/list', { threadId })).data.map((entry: any) => entry.id),
      [queued.queuedSubmission.id],
    )
    await h.ok('thread/queue/delete', { threadId, queuedSubmissionId: queued.queuedSubmission.id })
    release()
    await h.wait(
      (m) =>
        m.method === 'item/started' &&
        m.params.turnId === turn.id &&
        m.params.item.type === 'commandExecution',
    )
    await h.declared(features.interrupt, 'turn/interrupt', { threadId, turnId: turn.id })
    assert.equal((await h.completed(turn.id)).status, 'interrupted')

    // 改名、分叉、回退、压缩、归档、删除。
    await h.declared(features.rename, 'thread/name/set', { threadId, name: '声明测试' })
    const fork = await h.declared(features.fork, 'thread/fork', { threadId })
    const forkId = fork.thread.id
    assert.equal(fork.thread.forkedFromId, threadId)
    const turnsOf = async (id: string) => (await h.ok('thread/turns/list', { threadId: id })).data
    const copied = await turnsOf(forkId)
    assert.ok(copied.length >= 2)
    await h.declared(features.revert.byCount, 'thread/rollback', { threadId: forkId, numTurns: 1 })
    const kept = await turnsOf(forkId)
    assert.equal(kept.length, copied.length - 1)
    await h.declared(features.revert.byTurnId, 'thread/revert', {
      threadId: forkId,
      beforeTurnId: kept[0].id,
    })
    const left = await turnsOf(forkId)
    assert.ok(left.length < kept.length)
    assert.equal(
      left.some((entry: any) => entry.id === kept[0].id),
      false,
      '指定的那一轮和它之后的都退掉了',
    )
    assert.equal((await turnsOf(threadId)).length, copied.length, '源会话不受分叉上的回退影响')
    // 回退只是在原生会话树上换一个位置：第一轮写的文件还在。
    assert.equal(existsSync(join(h.cwd, 'direct.txt')), !features.revert.restoresFiles)
    const sofar = h.messages.length
    await h.declared(features.compact, 'thread/compact/start', { threadId })
    const compacted = await h.wait(
      (m) =>
        m.method === 'turn/completed' &&
        m.params.threadId === threadId &&
        h.messages.indexOf(m) >= sofar,
    )
    assert.equal(compacted.params.turn.status, 'completed', JSON.stringify(compacted.params.turn))
    await h.declared(features.archive, 'thread/archive', { threadId: forkId })
    await h.declared(features.archive, 'thread/unarchive', { threadId: forkId })
    await h.declared(features.delete, 'thread/delete', { threadId: forkId })
    assert.ok((await h.call('thread/read', { threadId: forkId })).error, '删掉的会话读不到')
  } finally {
    await h.close()
  }
})
