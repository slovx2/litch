import assert from 'node:assert/strict'
import { access, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  backgroundBash,
  commandAlive,
  lastUserText,
  type Scene,
  say,
  uniqueSleep,
  until,
} from './fixtures/background-scene.mjs'
import { MockLLM } from './fixtures/mock-llm.mjs'
import { descendants, killAll } from './fixtures/process-tree.mjs'
import { ProtocolClient } from './fixtures/protocol-client.mjs'

interface Approval {
  method: string
  turnId: string
}

// 需要审批的线程：写文件要用户确认，测试端一律接受并记下来。
async function approvalScene(name: string): Promise<Scene & { approvals: Approval[] }> {
  const home = await mkdtemp(join(tmpdir(), `${name}-`))
  const workspace = join(home, 'workspace')
  await mkdir(workspace)
  const model = new MockLLM()
  const client = await ProtocolClient.start(home, await model.start())
  const approvals: Approval[] = []
  client.onServerRequest = async (method, params) => {
    approvals.push({ method, turnId: params.turnId })
    return { decision: 'accept' }
  }
  const { thread } = await client.request('thread/start', {
    cwd: workspace,
    approvalPolicy: 'on-request',
    sandbox: 'danger-full-access',
  })
  return { home, workspace, model, client, threadId: thread.id, approvals }
}

async function dispose(scene: Scene): Promise<void> {
  const tree = descendants(scene.client.process.pid as number).map((row) => row.pid)
  await scene.client.close()
  await scene.model.close()
  killAll(tree)
  await rm(scene.home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
}

const turnsStarted = (scene: Scene): string[] =>
  scene.client.trace
    .filter((message) => message.method === 'turn/started')
    .map((message) => message.params.turn.id)

const writeFileTool = (id: string, path: string) => () => [
  { type: 'tool_use', id, name: 'Write', input: { file_path: path, content: 'WRITTEN\n' } },
]

test('自行续跑的回合里需要审批的调用：请求带这个回合的 ID，接受后执行', {
  timeout: 90_000,
}, async () => {
  const scene = await approvalScene('native-bg-approve')
  const target = join(scene.workspace, 'approved.txt')
  try {
    scene.model.enqueue(backgroundBash('toolu_approve', uniqueSleep(2)))
    scene.model.enqueue(say('已在后台启动'))
    scene.model.enqueue((request) => {
      assert.match(lastUserText(request), /task-notification/)
      return writeFileTool('toolu_write', target)()
    })
    scene.model.enqueue(say('已经写好'))
    const { turn } = await scene.client.request('turn/start', {
      threadId: scene.threadId,
      input: [{ type: 'text', text: '在后台启动一条短命令' }],
    })
    assert.equal((await scene.client.completed(turn.id)).status, 'completed')
    await until('自行续跑的回合开始', () => turnsStarted(scene).length === 2)
    const spontaneousId = turnsStarted(scene)[1] as string
    assert.equal((await scene.client.completed(spontaneousId)).status, 'completed')

    assert.equal(await readFile(target, 'utf8'), 'WRITTEN\n')
    // 这个线程里 Bash 不需要确认，写文件需要：唯一的一次审批属于自行续跑的回合。
    assert.deepEqual(scene.approvals, [
      { method: 'item/fileChange/requestApproval', turnId: spontaneousId },
    ])
    scene.model.assertConsumed()
  } finally {
    await dispose(scene)
  }
})

test('线程无人订阅时命令结束：状态变化仍通知到连接，回合停在需要审批的调用上；重新订阅后收到请求并继续', {
  timeout: 90_000,
}, async () => {
  const scene = await approvalScene('native-bg-detached')
  const target = join(scene.workspace, 'held.txt')
  const long = uniqueSleep(60)
  try {
    scene.model.enqueue(() => [
      {
        type: 'tool_use',
        id: 'toolu_short',
        name: 'Bash',
        input: { command: uniqueSleep(2), run_in_background: true, description: 'short' },
      },
      {
        type: 'tool_use',
        id: 'toolu_long',
        name: 'Bash',
        input: { command: long, run_in_background: true, description: 'long' },
      },
    ])
    scene.model.enqueue(say('两条都启动了'))
    scene.model.enqueue(writeFileTool('toolu_held', target))
    scene.model.enqueue(say('已经写好'))
    const { turn } = await scene.client.request('turn/start', {
      threadId: scene.threadId,
      input: [{ type: 'text', text: '启动两条后台命令' }],
    })
    assert.equal((await scene.client.completed(turn.id)).status, 'completed')
    const approvalsBefore = scene.approvals.length
    assert.deepEqual(
      await scene.client.request('thread/unsubscribe', { threadId: scene.threadId }),
      { status: 'unsubscribed' },
    )
    const mark = scene.client.trace.length
    const statuses = (): any[] =>
      scene.client.trace
        .slice(mark)
        .filter((message) => message.method === 'thread/status/changed')
        .map((message) => message.params.status)

    // 没有连接订阅这个线程：状态变化发给所有连接，客户端据此知道它在等人。
    await until(
      '线程停在等待确认上',
      () => statuses().some((status) => status.activeFlags?.includes('waitingOnApproval')),
      30_000,
    )
    await new Promise((resolve) => setTimeout(resolve, 1_500))
    assert.equal(statuses()[0].type, 'active', '状态变化应通知到没有订阅它的连接')
    assert.equal(
      scene.client.trace.slice(mark).some((message) => message.method === 'turn/started'),
      false,
      '回合内容只发给订阅者',
    )
    assert.equal(scene.approvals.length, approvalsBefore, '无人订阅时确认请求留着不发')
    assert.equal(scene.model.requests.length, 3, '也不当作拒绝告诉模型')
    await assert.rejects(access(target), { code: 'ENOENT' })

    // 重新订阅：留着的请求随即送达（测试端一律接受），回合继续到结束。
    const resumed = await scene.client.request('thread/resume', { threadId: scene.threadId })
    const waiting = resumed.thread.turns.at(-1)
    assert.equal(waiting.status, 'inProgress')
    assert.equal((await scene.client.completed(waiting.id)).status, 'completed')
    assert.deepEqual(scene.approvals.slice(approvalsBefore), [
      { method: 'item/fileChange/requestApproval', turnId: waiting.id },
    ])
    assert.equal(await readFile(target, 'utf8'), 'WRITTEN\n')
    assert.equal(statuses().at(-1).type, 'idle')
    assert.equal(commandAlive(long), true, '退订不关闭进程，另一条命令还在跑')
    scene.model.assertConsumed()
  } finally {
    await dispose(scene)
  }
})

test('自行续跑的回合开始之后才退订：代表这一轮的连接不再收到回合内容和确认请求，请求留到有人订阅', {
  timeout: 90_000,
}, async () => {
  const scene = await approvalScene('native-bg-unsub-mid')
  const target = join(scene.workspace, 'late.txt')
  // 续跑回合的第一次模型请求先压着不答：这时退订，回合已经开始、还没走到需要确认的调用
  let release: () => void = () => {}
  const held = new Promise<void>((resolve) => {
    release = resolve
  })
  try {
    scene.model.enqueue(backgroundBash('toolu_mid', uniqueSleep(2)))
    scene.model.enqueue(say('已在后台启动'))
    scene.model.enqueue(async () => {
      await held
      return writeFileTool('toolu_late', target)()
    })
    scene.model.enqueue(say('已经写好'))
    const { turn } = await scene.client.request('turn/start', {
      threadId: scene.threadId,
      input: [{ type: 'text', text: '在后台启动一条短命令' }],
    })
    assert.equal((await scene.client.completed(turn.id)).status, 'completed')
    // 这时还订阅着：续跑回合的开始照常收到
    await until('自行续跑的回合开始', () => turnsStarted(scene).length === 2)
    await until('续跑回合问到了模型', () => scene.model.requests.length === 3)
    const approvalsBefore = scene.approvals.length
    assert.deepEqual(
      await scene.client.request('thread/unsubscribe', { threadId: scene.threadId }),
      { status: 'unsubscribed' },
    )
    const mark = scene.client.trace.length
    release()

    await until(
      '线程停在等待确认上',
      () =>
        scene.client.trace
          .slice(mark)
          .some(
            (message) =>
              message.method === 'thread/status/changed' &&
              message.params.status.activeFlags?.includes('waitingOnApproval'),
          ),
      30_000,
    )
    await new Promise((resolve) => setTimeout(resolve, 1_500))
    assert.deepEqual(
      scene.client.trace
        .slice(mark)
        .map((message) => message.method)
        .filter((method) => typeof method === 'string' && /^(item|turn)\//.test(method)),
      [],
      '退订之后回合内容不再发给这条连接',
    )
    assert.equal(scene.approvals.length, approvalsBefore, '退订之后确认请求留着不发')
    await assert.rejects(access(target), { code: 'ENOENT' })

    // 重新订阅：留着的请求随即送达（测试端一律接受），回合继续到结束
    const resumed = await scene.client.request('thread/resume', { threadId: scene.threadId })
    const waiting = resumed.thread.turns.at(-1)
    assert.equal(waiting.status, 'inProgress')
    assert.equal((await scene.client.completed(waiting.id)).status, 'completed')
    assert.deepEqual(scene.approvals.slice(approvalsBefore), [
      { method: 'item/fileChange/requestApproval', turnId: waiting.id },
    ])
    assert.equal(await readFile(target, 'utf8'), 'WRITTEN\n')
    scene.model.assertConsumed()
  } finally {
    release()
    await dispose(scene)
  }
})
