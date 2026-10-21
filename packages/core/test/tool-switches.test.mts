// 内置浏览器、Computer Use 按“设备 → harness”两级的开关：存法（没单独设过的跟设备一级、点设备一级清掉整列）、
// 设备的显示数据里每个 harness 一项、建会话时关着的不挂那组工具、调用时按会话所在的 harness 再查一次。
// 对着真的核心和假的聚合面（两个 harness）跑。任务卡那一列读设备设置，在 manage.test.mts 里。
import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { JsonRpcMessage } from '../../protocol/src/index.mjs'
import {
  type ClientToolPort,
  changeToolSwitches,
  checkSaved,
  type ToolToMain,
  toolSwitchesOf,
} from '../src/index.mjs'
import { deviceWorld, features } from './device-world.mjs'
import { harness } from './fake-device.mjs'
import { settle } from './helpers.mjs'

test('存法：没改过按默认；harness 没单独设过的跟设备一级；和设备一级一样的不记', () => {
  assert.deepEqual(toolSwitchesOf(undefined, null), { browser: true, computer: false })
  assert.deepEqual(toolSwitchesOf(undefined, 'pi'), { browser: true, computer: false })

  let kept = changeToolSwitches(undefined, { harness: 'pi', browser: false })
  assert.deepEqual(kept, { harnesses: { pi: { browser: false } } })
  assert.deepEqual(toolSwitchesOf(kept, 'pi'), { browser: false, computer: false })
  assert.deepEqual(toolSwitchesOf(kept, 'claude'), { browser: true, computer: false })
  assert.deepEqual(toolSwitchesOf(kept, null), { browser: true, computer: false })

  // 设回和设备一级一样：这一条不再记
  kept = changeToolSwitches(kept, { harness: 'pi', browser: true, computer: true })
  assert.deepEqual(kept, { harnesses: { pi: { computer: true } } })

  // 设备一级改了：这一列各 harness 单独设过的一并清掉，另一列不动；操作这台电脑照旧记在设备一级
  kept = changeToolSwitches(
    { browser: true, machine: true, harnesses: { pi: { browser: false, computer: true } } },
    { browser: false },
  )
  assert.deepEqual(kept, { browser: false, machine: true, harnesses: { pi: { computer: true } } })
  // 以后新装的 harness 跟设备一级
  assert.deepEqual(toolSwitchesOf(kept, 'gemini'), { browser: false, computer: false })
  kept = changeToolSwitches(kept, { computer: false })
  assert.deepEqual(kept, { browser: false, computer: false, machine: true })
})

test('存法：读回来时按 harness 那一层认得出的留下，认不出的丢掉', () => {
  const saved = checkSaved({
    localWire: null,
    remotes: [],
    tools: {
      local: {
        browser: false,
        harnesses: {
          pi: { browser: true, computer: 'yes' },
          'bad id': { browser: true },
          claude: { computer: true },
          empty: {},
        },
      },
      gone: { harnesses: { pi: { browser: false } } },
    },
  })
  assert.deepEqual(saved.tools, {
    local: { browser: false, harnesses: { pi: { browser: true }, claude: { computer: true } } },
  })
})

/** 主进程那一头：能执行浏览器和 Computer Use，记下核心交过来的调用 */
function fakeMain() {
  const posted: ToolToMain[] = []
  const port: ClientToolPort = {
    namespaces: () => ['litch_browser', 'litch_computer'],
    post: (message) => posted.push(structuredClone(message)),
    listen() {},
  }
  return { port, calls: () => posted.filter((message) => message.op === 'call') }
}

const declared = (id: string) =>
  harness(id, { declaration: { extensions: ['clientTools'], features: features() } })

async function twoHarnesses() {
  const main = fakeMain()
  const world = deviceWorld([declared('claude'), declared('pi')], { clientTools: main.port })
  world.core.start()
  await settle()
  /** 在这个 harness 上建一个会话，返回会话号和建会话时带的命名空间 */
  const create = async (on: string) => {
    const { sessionId } = (await world.command('session.create', {
      harness: on,
      workspaceId: null,
      cwd: '/work',
      text: '你好',
    })) as { sessionId: string }
    const start = world.sent('thread/start').at(-1) as { dynamicTools?: { name: string }[] }
    return { sessionId, tools: (start.dynamicTools ?? []).map((entry) => entry.name) }
  }
  /** 引擎在这个会话里调一次客户端工具 */
  const call = (threadId: string, namespace: string) =>
    world.peer.last().ask('item/tool/call', {
      threadId,
      turnId: 't1',
      callId: `c-${namespace}`,
      namespace,
      tool: 'tabs',
      arguments: {},
    })
  return { ...world, main, create, call }
}

const failure = (message: JsonRpcMessage) =>
  (message as { result?: { success: boolean; contentItems: { text?: string }[] } }).result

test('显示数据：设备一级两个，加上每个 harness 三样；只改一个 harness 时设备一级和别的 harness 不动', async () => {
  const { device, command } = await twoHarnesses()
  assert.deepEqual(device()?.tools, {
    browser: true,
    computer: false,
    harnesses: {
      claude: { taskCards: null, browser: true, computer: false },
      pi: { taskCards: null, browser: true, computer: false },
    },
  })
  await command('device.tools.set', { harness: 'pi', browser: false, computer: true })
  await settle()
  assert.deepEqual(device()?.tools, {
    browser: true,
    computer: false,
    harnesses: {
      claude: { taskCards: null, browser: true, computer: false },
      pi: { taskCards: null, browser: false, computer: true },
    },
  })
  // 设备一级：整列跟着走
  await command('device.tools.set', { browser: true, computer: false })
  await settle()
  assert.deepEqual(device()?.tools.harnesses?.pi, {
    taskCards: null,
    browser: true,
    computer: false,
  })

  // 认不出的 harness、带着 harness 改“操作这台电脑”都不收
  await assert.rejects(command('device.tools.set', { harness: '../x', browser: true }), {
    code: 'invalid',
  })
  await assert.rejects(command('device.tools.set', { harness: 'pi', machine: true }), {
    code: 'invalid',
  })
})

test('建会话：这个 harness 关着的不挂那组工具；开着的挂上（Computer Use 默认关，默认不挂）', async () => {
  const { create, command } = await twoHarnesses()
  assert.ok((await create('claude')).tools.includes('litch_browser'))
  assert.ok(!(await create('claude')).tools.includes('litch_computer'))

  await command('device.tools.set', { harness: 'pi', browser: false })
  await command('device.tools.set', { harness: 'claude', computer: true })
  const pi = await create('pi')
  assert.ok(!pi.tools.includes('litch_browser'))
  assert.ok(!pi.tools.includes('litch_computer'))
  const claude = await create('claude')
  assert.ok(claude.tools.includes('litch_browser'))
  assert.ok(claude.tools.includes('litch_computer'))
})

test('调用时：按会话所在的 harness 再查一次，建会话之后才关掉的下一次调用就挡住', async () => {
  const { create, command, call, main } = await twoHarnesses()
  const claude = await create('claude')
  const pi = await create('pi')

  await command('device.tools.set', { harness: 'pi', browser: false })
  const refused = failure(await call(pi.sessionId, 'litch_browser'))
  assert.equal(refused?.success, false)
  assert.match(refused?.contentItems[0]?.text ?? '', /^\[litch:disabled\] .*browser/)
  assert.equal(main.calls().length, 0)

  // 另一个 harness 的会话不受影响，交给主进程
  void call(claude.sessionId, 'litch_browser')
  await settle()
  assert.equal(main.calls().length, 1)
  const invocation = main.calls()[0] as Extract<ToolToMain, { op: 'call' }>
  assert.equal(invocation.invocation.harness, 'claude')

  // 已经建好、带着工具的会话：关掉之后下一次就挡住
  await command('device.tools.set', { harness: 'claude', browser: false })
  const later = failure(await call(claude.sessionId, 'litch_browser'))
  assert.match(later?.contentItems[0]?.text ?? '', /^\[litch:disabled\]/)
  assert.equal(main.calls().length, 1)

  // Computer Use 默认关：设备一级打开之后两个 harness 都能用
  assert.match(
    failure(await call(pi.sessionId, 'litch_computer'))?.contentItems[0]?.text ?? '',
    /^\[litch:disabled\] .*Computer Use/,
  )
  await command('device.tools.set', { computer: true })
  void call(pi.sessionId, 'litch_computer')
  await settle()
  assert.equal(main.calls().length, 2)
})
