// 合同：Litch 在原生 codex 上新建会话、发消息时，最后到 codex 手里的 thread/start、turn/start 它都收。
// 0.8.0 带的工具定义过不了 codex 的校验，整个 thread/start 被拒，用户在 Codex 上一个会话都建不成；
// 当时的自检都对着模拟核心或 Claude、Pi 的夹具，那两家不查这一条，所以没被发现。
// 这里走真的核心：界面那条命令（session.create、session.send）带上会用到的全部东西（工作区、模型、强度、
// 权限档、计划模式、技能、提到的文件、图片，和这台桌面能执行的全部工具定义），对面是假的聚合面，
// 原生 codex 那个 harness 的声明用设备进程替它报的那一份。核心发出去的参数再照设备进程转给 codex 时的做法改一遍
// （摘掉聚合面自己的 harness、projectId，配上权限档配套的审批策略，packages/device/src/session.mts 的 forward），
// 交给 packages/shared/test/codex-params.mts 照上游的约束核对。不起 codex，没有外部依赖，几百毫秒。
// 真的 codex 上从界面走一遍在 apps/desktop/scripts/check-first-turn.mjs。
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { NATIVE_CODEX_DIALECT } from '../../device/src/native-codex.mjs'
import { CLIENT_TOOL_NAMESPACE } from '../../protocol/src/client-tools.mjs'
import { clientToolSpecs } from '../../protocol/src/client-tools-specs.mjs'
import { codexRejects } from '../../shared/test/codex-params.mjs'
import { type ClientToolPort, createCore } from '../src/index.mjs'
import { deviceWorld } from './device-world.mjs'
import { harness, model } from './fake-device.mjs'
import { fakeOpener, RpcFailure } from './fake-server.mjs'
import { project, thread, turn } from './fixtures.mjs'
import { fakeClock, settle } from './helpers.mjs'
import { watchSession } from './wire.mjs'

// 1x1 的 PNG
const PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
const NAMESPACES = Object.values(CLIENT_TOOL_NAMESPACE)
/** 主进程那一头：能执行全部命名空间（浏览器、Computer Use，和测试用的回声） */
const tools: ClientToolPort = { namespaces: () => NAMESPACES, post() {}, listen() {} }

/** 设备进程替原生 codex 报的声明（扩展、能力位、权限预设），和真的一样 */
async function codexDeclaration() {
  const info = (await NATIVE_CODEX_DIALECT.describe(
    { userAgent: 'litch/0.160.0 (Mac OS 26.0.0; arm64)' },
    () => Promise.reject(new Error('这一版没有 permissionProfile/list')),
  )) as Record<string, any>
  return {
    extensions: info.extensions,
    features: info.features,
    permissionPresets: info.permissionPresets,
  }
}

/** 设备进程转给原生 codex 之前对参数做的事（session.mts 的 forward、native-codex.mts 的 outgoing） */
function forwarded(method: string, params: Record<string, unknown>): Record<string, unknown> {
  const wire = JSON.parse(JSON.stringify(params)) as Record<string, unknown>
  const { harness: _harness, ...rest } = wire
  const plain =
    method === 'thread/start'
      ? Object.fromEntries(Object.entries(rest).filter(([key]) => key !== 'projectId'))
      : rest
  return NATIVE_CODEX_DIALECT.outgoing(method, plain) ?? plain
}

async function codexWorld() {
  const world = deviceWorld(
    [
      harness('codex', {
        displayName: 'Codex',
        declaration: await codexDeclaration(),
        models: [
          model('gpt-5.5', {
            isDefault: true,
            supportedReasoningEfforts: [
              { reasoningEffort: 'medium', description: '' },
              { reasoningEffort: 'high', description: '' },
            ],
            inputModalities: ['text', 'image'],
          } as never),
        ],
      }),
    ],
    {
      clientTools: tools,
      prepare(device) {
        device.extensions.push('deviceWorkspaces')
        device.projects.push(project('w1', '应用', '/work/app'))
      },
    },
  )
  world.core.start()
  await settle()
  return world
}

test('建会话：全部工具定义、工作区、模型强度权限、计划模式、技能、文件、图片都带上，codex 收', async () => {
  const { command, sent } = await codexWorld()
  await command('session.create', {
    harness: 'codex',
    workspaceId: 'w1',
    cwd: '/work/app',
    text: '看一下首页',
    images: [{ url: PNG, name: 'a.png' }],
    extras: [
      { kind: 'skill', name: 'review', path: '/work/app/.agents/skills/review/SKILL.md' },
      { kind: 'file', name: 'index.ts', path: 'src/index.ts' },
    ],
    settings: { model: 'gpt-5.5', effort: 'high', permission: ':workspace', mode: 'plan' },
  })
  const [start] = sent('thread/start')
  const [turn] = sent('turn/start')
  assert.ok(start && turn, '核心应该发了 thread/start 和 turn/start')
  // 工具定义整份都带上了：codex 是对整份做校验的
  assert.deepEqual(
    (start.dynamicTools as { name: string }[] | undefined)?.map((entry) => entry.name),
    NAMESPACES,
  )
  assert.deepEqual(codexRejects('thread/start', forwarded('thread/start', start)), [])
  assert.deepEqual(codexRejects('turn/start', forwarded('turn/start', turn)), [])
})

test('之后的消息：换权限档、退出计划模式也照样收', async () => {
  const { core, command, sent, side, peer, fake } = await codexWorld()
  const { sessionId } = (await command('session.create', {
    harness: 'codex',
    workspaceId: null,
    cwd: '/work/app',
    text: '先说一句',
    settings: { model: 'gpt-5.5', effort: 'medium', permission: ':read-only', mode: 'plan' },
  })) as { sessionId: string }
  assert.ok(side.sessions.has(sessionId))
  // 界面切过去看着它（建好之后界面就是这么做的）：之后的消息才发得出去
  watchSession(core, sessionId)
  await settle()
  for (const [permission, mode] of [
    [':danger-full-access', 'default'],
    [':workspace', 'plan'],
  ]) {
    // 上一个回合先结束：回合进行中发的消息是排着的
    peer.last().notify('turn/completed', {
      threadId: sessionId,
      turn: turn(`srv-${fake.turnSeq}`, [], { status: 'completed' }),
    })
    await settle()
    await command('session.configure', { sessionId, settings: { permission, mode } })
    await command('session.send', { sessionId, text: `换成 ${permission}` })
    await settle()
  }
  const turns = sent('turn/start')
  assert.equal(turns.length, 3, '头一句和后面两句各发一次 turn/start')
  for (const params of turns)
    assert.deepEqual(codexRejects('turn/start', forwarded('turn/start', params)), [])
})

test('只有 codex 的远程机器（直接连它的常驻服务，中间没有设备进程）：核心自己发的参数 codex 也收', async () => {
  // 这条路上没有设备进程替它摘参数、配审批策略，也没有声明：核心按“没有声明”的规矩带工具定义和审批策略
  const unknown = (method: string) => () => {
    throw new RpcFailure(-32600, `Invalid request: unknown variant \`${method}\``)
  }
  const peer = fakeOpener({
    'runtime/info': unknown('runtime/info'),
    'thread/list': () => ({ data: [], nextCursor: null, backwardsCursor: null }),
    'model/list': () => ({ data: [], nextCursor: null }),
    'thread/start': () => ({ thread: thread({ id: 'new', turns: [] }), model: 'gpt-5.5' }),
    'turn/start': () => ({ turn: turn('srv-1', [], { status: 'inProgress' }) }),
  })
  const core = createCore({
    clock: fakeClock().clock,
    version: '9.9.9',
    log: () => {},
    clientTools: tools,
    devices: [
      {
        id: 'box',
        name: '远程',
        host: 'dev@box',
        kind: 'ssh',
        target: { kind: 'host', host: 'box', port: 22, user: 'dev', keyFile: null },
        wire: 'green',
        open: peer.open,
      },
    ],
  })
  core.start()
  await settle()
  const never = { aborted: false, addEventListener() {} }
  await core.command(
    'session.create',
    {
      deviceId: 'box',
      cwd: '/home/dev/app',
      text: '看一下首页',
      images: [{ url: PNG, name: 'a.png' }],
      settings: { model: 'gpt-5.5', effort: 'high', permission: ':workspace', mode: 'plan' },
    },
    never,
  )
  const seen = (method: string) =>
    peer
      .last()
      .seen.filter((entry) => entry.method === method)
      .map((entry) => JSON.parse(JSON.stringify(entry.params)))
  const [start] = seen('thread/start')
  const [first] = seen('turn/start')
  assert.ok(start && first)
  assert.deepEqual(
    (start.dynamicTools as { name: string }[] | undefined)?.map((entry) => entry.name),
    NAMESPACES,
  )
  assert.deepEqual(codexRejects('thread/start', start), [])
  assert.deepEqual(codexRejects('turn/start', first), [])
})

test('核对本身：codex 会拒的几种都认得出来', () => {
  const [spec] = clientToolSpecs([CLIENT_TOOL_NAMESPACE.echo])
  assert.ok(spec)
  const long = { ...spec, description: '字'.repeat(1025) }
  const base = { cwd: '/work', dynamicTools: [long] }
  assert.match(codexRejects('thread/start', base).join('\n'), /说明有 1025 个字/)
  assert.match(
    codexRejects('thread/start', {
      cwd: '/work',
      dynamicTools: [{ ...spec, name: 'browser' }],
    }).join('\n'),
    /保留名/,
  )
  const badSchema = {
    ...spec,
    tools: spec.tools.map((tool) => ({
      ...tool,
      inputSchema: { type: 'object', required: 'text' },
    })),
  }
  assert.match(
    codexRejects('thread/start', { cwd: '/work', dynamicTools: [badSchema] }).join('\n'),
    /required 不是字符串数组/,
  )
  assert.match(
    codexRejects('thread/start', {
      cwd: '/work',
      permissions: ':workspace',
      sandbox: 'read-only',
    }).join('\n'),
    /不能和 sandbox 一起给/,
  )
  // 它不认识的字段不报错，只是悄悄丢掉：等于没发
  assert.match(
    codexRejects('thread/start', { cwd: '/work', harness: 'codex' }).join('\n'),
    /多出字段 harness/,
  )
  const remote = { threadId: 't', input: [{ type: 'image', url: 'https://example.com/a.png' }] }
  assert.match(codexRejects('turn/start', remote).join('\n'), /远程地址的图片/)
})
