// 原生 codex 的客户端工具调用由设备进程挑执行方（clientTools 扩展，protocol/extensions/client-tools.json；
// 实现在 src/client-tools.mts）。原生 codex 把同一个调用发给订阅着会话的每条连接，请求号相同，
// 从哪条连接答都算数；这里看设备进程是不是只放一条过去、没人能执行时替它回失败、各种了结时收拾干净。
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { Ajv } from 'ajv'
import { CLIENT_TOOL_NAMESPACE } from '../../protocol/src/client-tools.mjs'
import { clientToolSpecs } from '../../protocol/src/client-tools-specs.mjs'
import { codexVerdict } from '../../shared/test/codex-params.mjs'
import { codexRig, sentTo } from './codex-kit.mjs'
import { codexThread } from './fake-codex.mjs'
import type { FakeConnection } from './fake-upstream.mjs'
import { REPO, settle, type TestClient } from './helpers.mjs'

const THREAD = codexThread(1, 400).id
const TURN = `turn-of-${THREAD}`
const ECHO = 'litch_echo'
const NAMESPACES = Object.values(CLIENT_TOOL_NAMESPACE)
const OK = { success: true, contentItems: [{ type: 'inputText', text: 'ECHO hi' }] }

const definition = JSON.parse(
  readFileSync(join(REPO, 'protocol/extensions/client-tools.json'), 'utf8'),
)
const ajv = new Ajv({ strict: false, allErrors: true })
function check(name: string, value: unknown): void {
  const validate = ajv.compile({
    $ref: `#/definitions/${name}`,
    definitions: definition.definitions,
  })
  if (!validate(value))
    throw new Error(`${name} 和扩展定义对不上：${JSON.stringify(validate.errors)}`)
}

type Env = ReturnType<typeof codexRig>

/** 连一条客户端，返回它和它在假 codex 那一头的上游连接。namespaces 为 null：不声明 clientTools */
async function join_(
  env: Env,
  namespaces: string[] | null,
): Promise<{ client: TestClient; upstream: FakeConnection }> {
  const client = env.connect()
  if (namespaces)
    await client.initialize(['harness', 'clientTools'], { litchClientTools: { namespaces } })
  else await client.initialize()
  const upstream = env.codex.live.at(-1)
  assert.ok(upstream)
  return { client, upstream }
}

const calls = (client: TestClient) =>
  client.requests.filter((frame) => frame.method === 'item/tool/call')
const answersOf = (env: Env) => env.codex.connections.flatMap((connection) => connection.answers)
const resume = (client: TestClient) => client.call('thread/resume', { threadId: THREAD })
const start = (client: TestClient) =>
  client.call('turn/start', { threadId: THREAD, input: [{ type: 'text', text: '调' }] })

test('CLIENT-TOOLS-DEV-001：发起回合的连接声明了，调用只转给它；它没订阅、没收到那一份也一样，答复从它自己的连接回', async () => {
  const env = codexRig()
  try {
    const desktop = await join_(env, null)
    const litch = await join_(env, [ECHO])
    await resume(desktop.client)
    // Litch 没订阅，直接发起回合（原生 codex 不会因此让它订阅）
    await start(litch.client)
    const { id } = env.codex.toolCall(THREAD, ECHO, [desktop.upstream])
    const call = await litch.client.waitFor((frame) => frame.method === 'item/tool/call')
    assert.equal(call.id, id)
    check('ToolCallParams', call.params)
    litch.client.answer(call.id, OK)
    await settle()
    check('ToolCallResponse', OK)
    assert.equal(calls(desktop.client).length, 0, '官方桌面端收不到')
    assert.deepEqual(litch.upstream.answers, [{ id, result: OK }])
    assert.deepEqual(desktop.upstream.answers, [], '别的连接上的那份不替它答')
  } finally {
    await env.close()
  }
})

test('CLIENT-TOOLS-DEV-002：发起回合的连接没声明，转给最早订阅、声明了的连接；别的那几份不转也不答', async () => {
  const env = codexRig()
  try {
    const desktop = await join_(env, null)
    const other = await join_(env, ['litch_browser'])
    const first = await join_(env, [ECHO])
    const second = await join_(env, [ECHO])
    for (const one of [desktop, other, first, second]) await resume(one.client)
    await start(desktop.client)
    const { id } = env.codex.toolCall(THREAD, ECHO)
    const call = await first.client.waitFor((frame) => frame.method === 'item/tool/call')
    first.client.answer(call.id, OK)
    await settle()
    for (const one of [desktop, other, second]) assert.equal(calls(one.client).length, 0)
    assert.deepEqual(answersOf(env), [{ id, result: OK }], '原生 codex 只收到一份答复')
    assert.deepEqual(first.upstream.answers, [{ id, result: OK }])
  } finally {
    await env.close()
  }
})

test('CLIENT-TOOLS-DEV-003：没有声明过的连接，设备进程当场替它回 noExecutor，只回一份', async () => {
  const env = codexRig()
  try {
    const desktop = await join_(env, null)
    const phone = await join_(env, null)
    for (const one of [desktop, phone]) await resume(one.client)
    await start(desktop.client)
    const { id } = env.codex.toolCall(THREAD, ECHO)
    await settle(120)
    for (const one of [desktop, phone]) assert.equal(calls(one.client).length, 0)
    const answers = answersOf(env)
    assert.equal(answers.length, 1, JSON.stringify(answers))
    assert.equal(answers[0].id, id)
    check('FailureResponse', answers[0].result)
    assert.match(answers[0].result.contentItems[0].text, /^\[litch:noExecutor\] .*litch_echo/)
    assert.ok(env.logs.some((line) => line.includes('没有能执行的连接')))
  } finally {
    await env.close()
  }
})

test('CLIENT-TOOLS-DEV-004：设备进程没看到订阅的连接收到了一份（比如子代理的会话），等一下其余几份，交给声明了的那条', async () => {
  const env = codexRig()
  try {
    const desktop = await join_(env, null)
    const litch = await join_(env, [ECHO])
    // 谁都没恢复会话，回合也不是经聚合面发起的：设备进程只能看收到了那一份的连接
    const { id } = env.codex.toolCall(THREAD, ECHO, [desktop.upstream])
    await settle(10)
    env.codex.live[1]?.send({
      id,
      method: 'item/tool/call',
      params: {
        threadId: THREAD,
        turnId: TURN,
        callId: 'call_tool_1',
        namespace: ECHO,
        tool: 'echo',
        arguments: { text: 'hi' },
      },
    })
    const call = await litch.client.waitFor((frame) => frame.method === 'item/tool/call')
    litch.client.answer(call.id, OK)
    await settle(120)
    assert.equal(calls(desktop.client).length, 0)
    assert.deepEqual(answersOf(env), [{ id, result: OK }])
  } finally {
    await env.close()
  }
})

test('CLIENT-TOOLS-DEV-005：执行方断开，设备进程从别的连接替它回 failed，不改交给别的声明了的连接', async () => {
  const env = codexRig()
  try {
    const desktop = await join_(env, null)
    const litch = await join_(env, [ECHO])
    const spare = await join_(env, [ECHO])
    for (const one of [desktop, litch, spare]) await resume(one.client)
    await start(desktop.client)
    const { id } = env.codex.toolCall(THREAD, ECHO)
    await litch.client.waitFor((frame) => frame.method === 'item/tool/call')
    litch.client.close()
    await settle()
    const answers = answersOf(env)
    assert.equal(answers.length, 1, JSON.stringify(answers))
    assert.equal(answers[0].id, id)
    check('FailureResponse', answers[0].result)
    assert.match(answers[0].result.contentItems[0].text, /^\[litch:failed\] /)
    assert.equal(calls(spare.client).length, 0)
    assert.equal(calls(desktop.client).length, 0)
  } finally {
    await env.close()
  }
})

test('CLIENT-TOOLS-DEV-006：回合结束了结还在等的调用：执行方收到“有结果了”，迟到的答复不再交给 codex', async () => {
  const env = codexRig()
  try {
    const litch = await join_(env, [ECHO])
    await resume(litch.client)
    await start(litch.client)
    env.codex.toolCall(THREAD, ECHO)
    const call = await litch.client.waitFor((frame) => frame.method === 'item/tool/call')
    env.codex.notify('turn/completed', {
      threadId: THREAD,
      turn: { id: TURN, status: 'interrupted', items: [] },
    })
    const resolved = await litch.client.waitFor(
      (frame) => frame.method === 'serverRequest/resolved',
    )
    assert.deepEqual(resolved.params, { threadId: THREAD, requestId: call.id })
    litch.client.answer(call.id, OK)
    await settle()
    assert.deepEqual(answersOf(env), [])
  } finally {
    await env.close()
  }
})

test('CLIENT-TOOLS-DEV-007：codex 说请求有结果了：只有执行方收到，带它看到的请求号；没收到调用的连接不收这条', async () => {
  const env = codexRig()
  try {
    const desktop = await join_(env, null)
    const litch = await join_(env, [ECHO])
    for (const one of [desktop, litch]) await resume(one.client)
    await start(desktop.client)
    const { id } = env.codex.toolCall(THREAD, ECHO)
    const call = await litch.client.waitFor((frame) => frame.method === 'item/tool/call')
    env.codex.resolved(THREAD, id)
    await litch.client.waitFor((frame) => frame.method === 'serverRequest/resolved')
    await settle()
    const resolvedOf = (client: TestClient) =>
      client.notifications.filter((frame) => frame.method === 'serverRequest/resolved')
    assert.equal(resolvedOf(litch.client).length, 1)
    assert.deepEqual(resolvedOf(litch.client)[0]?.params, { threadId: THREAD, requestId: call.id })
    assert.equal(resolvedOf(desktop.client).length, 0)
  } finally {
    await env.close()
  }
})

test('CLIENT-TOOLS-DEV-008：了结之后再到的那一份（恢复会话时补发的）直接丢掉，不再转、不再答', async () => {
  const env = codexRig()
  try {
    const litch = await join_(env, [ECHO])
    const late = await join_(env, [ECHO])
    await resume(litch.client)
    await start(litch.client)
    const { id, params } = env.codex.toolCall(THREAD, ECHO, [litch.upstream])
    const call = await litch.client.waitFor((frame) => frame.method === 'item/tool/call')
    litch.client.answer(call.id, OK)
    await settle()
    // 另一条连接这时才恢复会话，codex 把还在等的请求补发给它（这里假装答复还没到 codex）
    await resume(late.client)
    late.upstream.send({ id, method: 'item/tool/call', params })
    await settle()
    assert.equal(calls(late.client).length, 0)
    assert.equal(calls(litch.client).length, 1)
    assert.deepEqual(answersOf(env), [{ id, result: OK }])
  } finally {
    await env.close()
  }
})

test('CLIENT-TOOLS-DEV-009：别的命名空间照旧发给每条订阅连接；握手时我们的键不带给原生 codex', async () => {
  const env = codexRig()
  try {
    const desktop = await join_(env, null)
    const litch = await join_(env, [ECHO])
    for (const one of [desktop, litch]) await resume(one.client)
    const { id } = env.codex.toolCall(THREAD, 'fixture_tools')
    for (const one of [desktop, litch]) {
      const call = await one.client.waitFor((frame) => frame.method === 'item/tool/call')
      assert.equal(call.id, id)
    }
    for (const greeting of env.codex.greetings) {
      assert.equal('litchExtensions' in greeting.capabilities, false)
      assert.equal('litchClientTools' in greeting.capabilities, false)
    }
    // 经聚合面的原生 codex 报 clientTools：路由是设备进程替它做的
    const info = await litch.client.call('runtime/info')
    const codex = info.harnesses.find((harness: any) => harness.id === 'codex')
    assert.ok(codex.extensions.includes('clientTools'), JSON.stringify(codex.extensions))
  } finally {
    await env.close()
  }
})

test('CLIENT-TOOLS-DEV-010：退订了的连接不再按订阅者挑', async () => {
  const env = codexRig()
  try {
    const desktop = await join_(env, null)
    const gone = await join_(env, [ECHO])
    const stay = await join_(env, [ECHO])
    for (const one of [desktop, gone, stay]) await resume(one.client)
    await gone.client.call('thread/unsubscribe', { threadId: THREAD })
    await start(desktop.client)
    env.codex.toolCall(THREAD, ECHO, [desktop.upstream, stay.upstream])
    const call = await stay.client.waitFor((frame) => frame.method === 'item/tool/call')
    stay.client.answer(call.id, OK)
    await settle()
    assert.equal(calls(gone.client).length, 0)
  } finally {
    await env.close()
  }
})

test('CLIENT-TOOLS-DEV-011：带着 Litch 的全部工具定义经聚合面建会话，到 codex 手里的参数它收；过不了它校验的，原话带回客户端', async () => {
  const env = codexRig()
  try {
    const litch = await join_(env, NAMESPACES)
    const params = {
      harness: 'codex',
      cwd: '/work/codex',
      permissions: ':workspace',
      dynamicTools: clientToolSpecs(NAMESPACES),
    }
    const started = await litch.client.call('thread/start', params)
    assert.ok(started.thread.id)
    const [seen] = sentTo(env.codex, 'thread/start')
    // 聚合面的 harness 摘掉了，权限档配套的审批策略配上了；codex 不认识的字段一个都没有
    assert.equal('harness' in seen, false)
    assert.equal(seen.approvalPolicy, 'on-request')
    assert.deepEqual(codexVerdict('thread/start', seen), { rejects: [], ignored: [] })

    // 0.8.0 那样的定义：命名空间说明超过 1024 个字，codex 整个拒绝。设备进程不能把它换成“不支持”
    const [first, ...rest] = clientToolSpecs(NAMESPACES)
    assert.ok(first)
    const failure = await litch.client.fails('thread/start', {
      ...params,
      dynamicTools: [{ ...first, description: '字'.repeat(1025) }, ...rest],
    })
    assert.equal(failure.code, -32600)
    assert.match(failure.message, /说明有 1025 个字/)
  } finally {
    await env.close()
  }
})
