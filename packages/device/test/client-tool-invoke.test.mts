// 命令行经聚合面发来的客户端工具调用（clientTools 扩展的 litch/clientTool/invoke，实现在 src/client-tool-invoke.mts）。
// 调用者是这台机器上的一个进程（litch-machine），不握手；设备进程挑一条声明过的 Litch 连接，
// 向它发 litch/clientTool/call，应答原样交回。看挑得对不对、有歧义时怎么说、两头断开时怎么收拾。
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { Ajv } from 'ajv'
import { CLIENT_TOOL_METHOD } from '../../protocol/src/client-tools.mjs'
import { FakeUpstream } from './fake-upstream.mjs'
import { REPO, rig, settle, type TestClient } from './helpers.mjs'

const MACHINE = 'litch_machine'
const OK = { success: true, contentItems: [{ type: 'inputText', text: 'done' }] }

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

/** 一台设备，上面一个假的 pi；它的 turn/start 会向各连接发 turn/started（真的引擎只发给订阅者，这里够用） */
function setup() {
  const pi = new FakeUpstream('pi', [
    { id: 'p1', updatedAt: 300 },
    { id: 'p2', updatedAt: 100 },
  ])
  pi.handlers['turn/start'] = (params) => {
    const turn = { id: `turn-of-${params.threadId}`, status: 'inProgress' }
    queueMicrotask(() => pi.notify('turn/started', { threadId: params.threadId, turn }))
    return { turn }
  }
  return { env: rig({ pi }), pi }
}

type Env = ReturnType<typeof setup>['env']

/** 一条 Litch 连接：声明 namespaces，报主机名 hostname。namespaces 为 null：不声明 clientTools（官方桌面端、移动端） */
async function litch(
  env: Env,
  hostname: string | null,
  namespaces: string[] | null = [MACHINE],
): Promise<TestClient> {
  const client = env.connect()
  if (!namespaces) await client.initialize()
  else
    await client.initialize(['harness', 'clientTools'], {
      litchClientTools: {
        namespaces,
        ...(hostname ? { desktop: { hostname, name: `${hostname} 的桌面` } } : {}),
      },
    })
  return client
}

const detached = (client: TestClient) =>
  client.requests.filter((frame) => frame.method === CLIENT_TOOL_METHOD.call)

const invoke = (caller: TestClient, more: Record<string, unknown> = {}) =>
  caller.call(CLIENT_TOOL_METHOD.invoke, {
    namespace: MACHINE,
    tool: 'exec',
    arguments: { command: 'uname -a' },
    threadId: null,
    ...more,
  })

test('INVOKE-001：没有 Litch 连着时当场回 noExecutor；调用者不用握手', async () => {
  const { env } = setup()
  try {
    const phone = await litch(env, null, null)
    const caller = env.connect()
    const result = await invoke(caller)
    check('ToolCallResponse', result)
    assert.equal(result.success, false)
    assert.match(result.contentItems[0].text, /^\[litch:noExecutor\] /)
    assert.equal(detached(phone).length, 0)
  } finally {
    await env.close()
  }
})

test('INVOKE-002：只有一台声明了的，交给它；参数合扩展定义，应答原样交回；没声明的连接收不到', async () => {
  const { env } = setup()
  try {
    const phone = await litch(env, null, null)
    const browserOnly = await litch(env, 'other', ['litch_browser'])
    const mac = await litch(env, 'mac')
    const caller = env.connect()
    const pending = invoke(caller, { threadId: 'p1' })
    const call = await mac.waitFor((frame) => frame.method === CLIENT_TOOL_METHOD.call)
    check('DetachedCallParams', call.params)
    const params = call.params as any
    assert.equal(params.namespace, MACHINE)
    assert.equal(params.tool, 'exec')
    assert.deepEqual(params.arguments, { command: 'uname -a' })
    assert.equal(params.threadId, 'p1')
    assert.equal(params.turnId, null, '这个会话没有在跑的回合')
    mac.answer(call.id, OK)
    assert.deepEqual(await pending, OK)
    for (const one of [phone, browserOnly]) assert.equal(detached(one).length, 0)
  } finally {
    await env.close()
  }
})

test('INVOKE-003：不止一台、又找不到会话时回 ambiguous 并列出主机名；带 desktop 只交给对得上的那台', async () => {
  const { env } = setup()
  try {
    const a = await litch(env, 'alpha.local')
    const b = await litch(env, 'beta')
    const caller = env.connect()
    const result = await invoke(caller)
    check('FailureResponse', result)
    assert.match(
      result.contentItems[0].text,
      /^\[litch:ambiguous\] .*alpha\.local.*beta.*--desktop/,
    )
    // 带了会话号但没人订阅、没人在跑：一样有歧义
    const again = await invoke(caller, { threadId: 'p2' })
    assert.match(again.contentItems[0].text, /^\[litch:ambiguous\] /)
    const pending = invoke(caller, { desktop: 'ALPHA' })
    const call = await a.waitFor((frame) => frame.method === CLIENT_TOOL_METHOD.call)
    a.answer(call.id, OK)
    assert.deepEqual(await pending, OK)
    assert.equal(detached(b).length, 0)
    const missing = await invoke(caller, { desktop: 'gamma' })
    assert.match(missing.contentItems[0].text, /^\[litch:noExecutor\] .*gamma.*alpha\.local/)
  } finally {
    await env.close()
  }
})

test('INVOKE-004：按会话挑：发起当前回合的那台优先，其次最早订阅的；回合结束后看订阅者', async () => {
  const { env, pi } = setup()
  try {
    const a = await litch(env, 'alpha')
    const b = await litch(env, 'beta')
    const caller = env.connect()
    await a.call('thread/resume', { threadId: 'p1' })
    await b.call('thread/resume', { threadId: 'p1' })
    await b.call('turn/start', { threadId: 'p1', input: [] })
    await settle()
    const first = invoke(caller, { threadId: 'p1' })
    const call = await b.waitFor((frame) => frame.method === CLIENT_TOOL_METHOD.call)
    assert.equal((call.params as any).turnId, 'turn-of-p1')
    assert.equal((call.params as any).harness, 'pi')
    b.answer(call.id, OK)
    assert.deepEqual(await first, OK)
    assert.equal(detached(a).length, 0)
    // 回合结束：发起者不再算数，交给最早订阅的 a
    pi.notify('turn/completed', { threadId: 'p1', turn: { id: 'turn-of-p1', status: 'completed' } })
    await settle()
    const second = invoke(caller, { threadId: 'p1' })
    const next = await a.waitFor((frame) => frame.method === CLIENT_TOOL_METHOD.call)
    assert.equal((next.params as any).turnId, null)
    a.answer(next.id, OK)
    assert.deepEqual(await second, OK)
    // 带了 desktop 时只在对得上的那台里按会话挑
    const third = invoke(caller, { threadId: 'p1', desktop: 'beta' })
    await settle()
    assert.equal(detached(b).length, 2)
    b.answer(detached(b)[1]?.id, OK)
    assert.deepEqual(await third, OK)
  } finally {
    await env.close()
  }
})

test('INVOKE-005：调用者断开时撤回，执行方收到 serverRequest/resolved；之后它再答也没事', async () => {
  const { env } = setup()
  try {
    const mac = await litch(env, 'mac')
    const caller = env.connect()
    void invoke(caller).catch(() => {})
    const call = await mac.waitFor((frame) => frame.method === CLIENT_TOOL_METHOD.call)
    caller.close()
    const resolved = await mac.waitFor((frame) => frame.method === 'serverRequest/resolved')
    assert.deepEqual(resolved.params, { threadId: null, requestId: call.id })
    mac.answer(call.id, OK)
    await settle()
  } finally {
    await env.close()
  }
})

test('INVOKE-006：执行方断开时替它回 failed，不改交给别人', async () => {
  const { env } = setup()
  try {
    const a = await litch(env, 'alpha')
    const b = await litch(env, 'beta')
    const caller = env.connect()
    const pending = invoke(caller, { desktop: 'alpha' })
    await a.waitFor((frame) => frame.method === CLIENT_TOOL_METHOD.call)
    a.close()
    const result = await pending
    check('FailureResponse', result)
    assert.match(result.contentItems[0].text, /^\[litch:failed\] /)
    assert.equal(detached(b).length, 0)
  } finally {
    await env.close()
  }
})

test('INVOKE-007：执行方回的错误原样交回；参数不对是请求错误；desktops 列出连着的桌面端', async () => {
  const { env } = setup()
  try {
    await litch(env, null, null)
    const mac = await litch(env, 'mac')
    await litch(env, 'other', ['litch_browser'])
    const caller = env.connect()
    const desktops = await caller.call(CLIENT_TOOL_METHOD.desktops)
    check('DesktopsResult', desktops)
    assert.deepEqual(desktops, {
      desktops: [
        { hostname: 'mac', name: 'mac 的桌面', namespaces: [MACHINE] },
        { hostname: 'other', name: 'other 的桌面', namespaces: ['litch_browser'] },
      ],
    })
    const pending = caller.fails(CLIENT_TOOL_METHOD.invoke, {
      namespace: MACHINE,
      tool: 'exec',
      arguments: {},
      threadId: null,
    })
    const call = await mac.waitFor((frame) => frame.method === CLIENT_TOOL_METHOD.call)
    mac.sendRaw(JSON.stringify({ id: call.id, error: { code: -32000, message: '坏了', data: 1 } }))
    assert.deepEqual(await pending, { code: -32000, message: '坏了', data: 1 })
    const bad = await caller.fails(CLIENT_TOOL_METHOD.invoke, { namespace: 'browser', tool: 'x' })
    assert.equal(bad.code, -32602)
    // 别的方法照旧要先握手
    const refused = await caller.fails('thread/list', {})
    assert.equal(refused.code, -32600)
  } finally {
    await env.close()
  }
})
