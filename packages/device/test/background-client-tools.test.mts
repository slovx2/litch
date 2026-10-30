// biome-ignore-all lint/complexity/useLiteralKeys: 方括号仅用于单测检查私有状态，不扩大生产接口。
// 后台子会话只由内部 EngineLink 订阅，桌面从未恢复过它。
import assert from 'node:assert/strict'
import test from 'node:test'
import { clientToolSpecs } from '../../protocol/src/client-tools-specs.mjs'
import { FakeCodex } from './fake-codex.mjs'
import { FakeControl, managed } from './fake-control.mjs'
import { FakeEngine, resultOf } from './fake-engine.mjs'
import type { FakeUpstream } from './fake-upstream.mjs'
import { rig, settle } from './helpers.mjs'
import { brief, TREE, text } from './tree-kit.mjs'

const OK = { success: true, contentItems: [{ type: 'inputText', text: '后台浏览器已执行' }] }

async function background(
  parentHarness = 'claude-code',
  childHarness = 'codex',
  computerActions = true,
) {
  const claude = new FakeEngine('claude-code')
  const pi = new FakeEngine('pi')
  const codex = new FakeCodex([])
  const engines: Record<string, FakeUpstream> = { 'claude-code': claude, pi, codex }
  const control = new FakeControl([
    managed('claude-code'),
    managed('pi'),
    { ...managed('codex'), native: true },
  ])
  const env = rig(
    {},
    {},
    {
      control,
      dial: (socket) => (engines[socket.slice('fake://'.length)] as FakeUpstream).connector,
      wrapUpReminder: false,
    },
  )
  const client = env.connect()
  await client.initialize(TREE, {
    litchClientTools: { namespaces: ['litch_browser', 'litch_computer'], computerActions },
  })
  const { thread } = await client.call('thread/start', {
    harness: parentHarness,
    cwd: env.stateDir,
    dynamicTools: clientToolSpecs(['litch_browser', 'litch_computer']),
  })
  await client.call('turn/start', { threadId: thread.id, input: text('派出后台会话') })
  const parent = parentHarness === 'pi' ? pi : claude
  const started = await parent.callTool(thread.id, 'litch_sessions', 'start', {
    title: '后台浏览器',
    ...brief('打开浏览器'),
    kind: 'fresh',
    harness: childHarness,
    initiation: 'user_asked',
    worktree: false,
    wake_parent: false,
  })
  const childId = resultOf(started?.answer).thread_id
  assert.ok(childId, JSON.stringify(started))
  const engine = engines[childHarness]
  assert.ok(engine)
  const internal = engine.connections.find((connection) =>
    connection.raw.some((raw) => JSON.parse(raw).method === 'thread/start'),
  )
  assert.ok(internal)
  const send = (namespace = 'litch_browser', tool = 'navigate') => {
    const frame = {
      id: 'background-call',
      method: 'item/tool/call',
      params: {
        threadId: childId,
        turnId: `turn-of-${childId}`,
        callId: 'background-tool',
        namespace,
        tool,
        arguments: { url: 'http://localhost/' },
      },
    }
    internal.send(frame)
    return frame
  }
  return { ...env, client, codex, engine, internal, childId, send }
}

test('M16：Claude 父派出原生 Codex 子，未打开的子会话能执行浏览器并返回', async () => {
  const env = await background()
  try {
    env.send()
    const call = await env.client.waitFor((frame) => frame.method === 'item/tool/call', 500)
    env.client.answer(call.id, OK)
    await settle()
    assert.ok(
      env.codex.connections
        .flatMap((one) => one.answers)
        .some((frame) => frame.id === 'background-call' && frame.result?.success),
    )
  } finally {
    await env.close()
  }
})

test('M16：Pi 父派出 Claude 子，适配器内部连接声明转交能力，CU 也能返回', async () => {
  const env = await background('pi', 'claude-code')
  try {
    const result = (env.engine as FakeEngine).callTool(
      env.childId,
      'litch_computer',
      'list_apps',
      {},
    )
    const call = await env.client.waitFor((frame) => frame.method === 'item/tool/call', 500)
    env.client.answer(call.id, OK)
    assert.deepEqual((await result)?.answer.result, OK)
    assert.equal((env.engine as FakeEngine).subscribers.get(env.childId)?.length, 1)
  } finally {
    await env.close()
  }
})

test('M16：执行方离开后立即 noExecutor，不借用无关或未声明能力的连接', async () => {
  const env = await background()
  try {
    const stranger = env.connect()
    await stranger.initialize(TREE, { litchClientTools: { namespaces: ['litch_browser'] } })
    const plain = env.connect()
    await plain.initialize(['harness'])
    await plain.call('thread/resume', { threadId: env.childId })
    env.client.close()
    await settle()
    env.send()
    await settle(150)
    const answer = env.internal.answers.find((frame) => frame.id === 'background-call')
    assert.match(
      answer?.result.contentItems[0].text ?? '',
      /\[litch:noExecutor\].*当前没有可执行的桌面端/,
    )
    assert.equal(stranger.requests.length, 0)
    assert.equal(plain.requests.length, 0)
  } finally {
    await env.close()
  }
})

test('M16：执行中断线回 failed，不重复投给其他桌面；随后恢复不补执行', async () => {
  const env = await background()
  try {
    const frame = env.send()
    await env.client.waitFor((one) => one.method === 'item/tool/call', 500)
    env.client.close()
    await settle()
    const answer = env.internal.answers.find((one) => one.id === frame.id)
    assert.match(answer?.result.contentItems[0].text ?? '', /\[litch:failed\].*可能只做了一半/)
    const next = env.connect()
    await next.initialize(TREE, { litchClientTools: { namespaces: ['litch_browser'] } })
    await next.call('thread/resume', { threadId: env.childId })
    const upstream = env.codex.live.find(
      (one) =>
        one !== env.internal &&
        one.raw.some((raw) => {
          const request = JSON.parse(raw)
          return request.method === 'thread/resume' && request.params.threadId === env.childId
        }),
    )
    assert.ok(upstream)
    upstream.send(frame)
    await settle(100)
    assert.equal(next.requests.length, 0)
  } finally {
    await env.close()
  }
})

for (const cancelled of ['resolved', 'interrupted'] as const)
  test(`M16：${cancelled} 撤回调用，迟答及打开会话后的补发都不执行`, async () => {
    const env = await background()
    try {
      const frame = env.send()
      const call = await env.client.waitFor((one) => one.method === 'item/tool/call', 500)
      env.internal.send(
        cancelled === 'resolved'
          ? {
              method: 'serverRequest/resolved',
              params: { threadId: env.childId, requestId: frame.id },
            }
          : {
              method: 'turn/completed',
              params: {
                threadId: env.childId,
                turn: { id: frame.params.turnId, status: 'interrupted', items: [] },
              },
            },
      )
      await env.client.waitFor((one) => one.method === 'serverRequest/resolved', 500)
      env.client.answer(call.id, OK)
      await env.client.call('thread/resume', { threadId: env.childId })
      // 订阅完成后，同一请求在内部连接和客户端上游各补送一次。
      for (const upstream of env.codex.live) upstream.send(frame)
      await settle(100)
      assert.equal(env.client.requests.length, 1)
      assert.equal(env.codex.connections.flatMap((one) => one.answers).length, 0)
    } finally {
      await env.close()
    }
  })

test('M16：继承命名空间不能绕过 CU 批量能力声明', async () => {
  const env = await background('claude-code', 'codex', false)
  try {
    env.send('litch_computer', 'run_actions')
    await settle(150)
    assert.match(env.internal.answers[0]?.result.contentItems[0].text ?? '', /\[litch:noExecutor\]/)
    assert.equal(env.client.requests.length, 0)
  } finally {
    await env.close()
  }
})

for (const via of ['internal', 'client', 'archive'] as const)
  test(`M16：${via} 会话清理入口释放继承连接和去重状态`, async () => {
    const env = await background()
    try {
      const router = env.device['host'].clientTools
      env.send()
      const call = await env.client.waitFor((frame) => frame.method === 'item/tool/call')
      env.client.answer(call.id, OK)
      await settle()
      assert.equal(router['byRequest'].size, 0)
      assert.ok(router['done'].size > 0)
      assert.ok(router['inherited'].has(env.childId))
      if (via === 'archive') await env.client.call('thread/archive', { threadId: env.childId })
      else {
        const upstream =
          via === 'internal' ? env.internal : env.codex.live.find((one) => one !== env.internal)
        assert.ok(upstream)
        upstream.send({ method: 'thread/closed', params: { threadId: env.childId } })
      }
      await settle()
      assert.equal(router['byRequest'].size, 0)
      assert.equal(router['done'].size, 0)
      assert.equal(router['inherited'].has(env.childId), false)
    } finally {
      await env.close()
    }
  })
