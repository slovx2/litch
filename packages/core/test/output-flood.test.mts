// 命令狂打日志：经整条链路（假的对面 → 真的核心 → 真的通道 → 界面的数据副本）量几样和机器快慢无关的数：
// 核心和界面各留着多少字、每一帧界面要重画的那一框有多少字、切走再切回来重新订阅时快照有多大、通道上一共发了多少字。
// 改之前核心和副本都把输出一路接下去，前三样随输出变长而涨（4 MB 的输出，每一帧界面上要重排的字平均两百万），
// 下面的断言都不过。另一组看三条路（实时接、读历史、中途恢复）得到的命令条目是不是同一个样子。
import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Thread, ThreadItem } from '../../protocol/src/index.mjs'
import {
  type CommandItem,
  connectChannel,
  createPortPair,
  createReplica,
  type ItemView,
  keys,
  OUTPUT_KEEP,
  type SessionView,
  serveChannel,
  type TurnView,
} from '../src/index.mjs'
import { thread, turn } from './fixtures.mjs'
import { settle } from './helpers.mjs'
import { setup, started, where } from './world.mjs'

const FRAME = 16
/** 上游 codex 一条增量至多这么大 */
const DELTA = 8 * 1024
const PER_FRAME = 8

/** 一行一行的日志，每行带着序号。只有 ASCII：省掉的字节数就等于字数，好对账 */
function log(from: number, chars: number): string {
  let text = ''
  for (let n = from; text.length < chars; n++) text += `[${String(n).padStart(7, '0')}] ok\n`
  return text.slice(0, chars)
}

const command = (id: string, output: string | null, status: 'inProgress' | 'completed') =>
  ({
    type: 'commandExecution',
    id,
    pluginId: null,
    scriptPath: null,
    command: 'npm run build',
    cwd: '/work/app',
    processId: null,
    source: 'agent',
    status,
    commandActions: [],
    aggregatedOutput: output,
    exitCode: status === 'completed' ? 0 : null,
    durationMs: status === 'completed' ? 1000 : null,
  }) satisfies ThreadItem

type World = ReturnType<typeof setup>

/** 把会话经真的通道接到界面的数据副本上，顺手数通道上一共发了多少字 */
function screen(world: World) {
  const [uiPort, corePort] = createPortPair()
  let wire = 0
  const post = corePort.post.bind(corePort)
  corePort.post = (message) => {
    wire += JSON.stringify(message).length
    post(message)
  }
  serveChannel(corePort, world.core, { clock: world.time.clock })
  const replica = createReplica(connectChannel(uiPort))
  replica.openSession(where.deviceId, where.sessionId)
  const { store } = replica
  /** 界面的副本里那条命令 */
  const item = (): CommandItem | null => {
    for (const turnId of store.get<string[]>(keys.turnIds(where.deviceId, where.sessionId)) ?? []) {
      const entry = store.get<TurnView>(keys.turn(where.deviceId, where.sessionId, turnId))
      for (const id of entry?.itemIds ?? []) {
        const found = store.get<ItemView>(keys.item(where.deviceId, where.sessionId, id))
        if (found?.kind === 'command') return found
      }
    }
    return null
  }
  return { wire: () => wire, item }
}

/** 核心手里那一份：另开一个订阅拿快照（切走再切回来、重连之后界面重新订阅，拿到的就是它） */
function snapshot(world: World): SessionView {
  let view: SessionView | null = null
  const stop = world.core.subscribe(
    { kind: 'session', ...where },
    { snapshot: (data) => (view = data as SessionView), delta() {}, error() {} },
  )
  stop()
  assert.ok(view, '会话开着，快照应当当场给')
  return view
}

const commandIn = (view: SessionView): CommandItem => {
  const found = Object.values(view.items).find((entry) => entry.kind === 'command')
  assert.ok(found?.kind === 'command', '视图里应当有那条命令')
  return found
}

/** 界面展开着那条命令时，那一框里有多少字：开头一截加末尾一截（省略记号是界面自己的一行，不算） */
const shown = (item: CommandItem | null): number =>
  item ? item.output.length + (item.elided?.tail.length ?? 0) : 0

const frame = async (world: World) => {
  world.time.advance(FRAME)
  await settle()
}

test('长输出：命令狂打 4 MB 日志，核心和界面留着的、每一帧要重画的、重新订阅的快照都不随输出涨', async () => {
  const world = setup()
  world.core.start()
  await settle()
  const ui = screen(world)
  await settle()
  await world.command('session.send', { ...where, text: '跑个构建' })
  await settle()
  const server = world.peer.last()
  const base = { threadId: 'a', turnId: 'srv-1' }
  server.notify('turn/started', { threadId: 'a', turn: started('srv-1') })
  server.notify('item/started', {
    ...base,
    item: command('c1', null, 'inProgress'),
    startedAtMs: 0,
  })
  await settle()
  await frame(world)

  const total = 4 * 1024 * 1024
  const full = log(1, total)
  const wireBefore = ui.wire()
  let frames = 0
  let redrawn = 0
  let most = 0
  for (let at = 0; at < full.length; ) {
    for (let index = 0; index < PER_FRAME && at < full.length; index++, at += DELTA) {
      const delta = full.slice(at, at + DELTA)
      server.notify('item/commandExecution/outputDelta', { ...base, itemId: 'c1', delta })
    }
    await settle()
    await frame(world)
    frames++
    const now = shown(ui.item())
    redrawn += now
    most = Math.max(most, now)
  }
  const sent = ui.wire() - wireBefore

  // 界面的副本：一直不超过上限，开头是最前那几行，末尾是最后那几行，省了多少对得上
  const seen = ui.item()
  assert.ok(seen?.elided, '超过上限的输出应当省过')
  assert.ok(most <= OUTPUT_KEEP, `界面的副本里最多留过 ${most} 个字，上限 ${OUTPUT_KEEP}`)
  assert.ok(seen.output.startsWith('[0000001] ok\n'))
  assert.ok(full.endsWith(seen.elided.tail))
  assert.equal(seen.output.length + seen.elided.bytes + seen.elided.tail.length, total)
  // 每一帧界面上那一框要重排的字有上限：总数和帧数成正比，不随已有的输出涨
  assert.ok(
    redrawn <= frames * OUTPUT_KEEP,
    `${frames} 帧里界面一共要重排 ${redrawn} 个字，上限 ${frames * OUTPUT_KEEP}`,
  )
  // 通道上发的就是增量本身：一共发的字和输出写成 JSON 差不多，不是每一帧把整条输出重发一遍
  const json = JSON.stringify(full).length
  assert.ok(sent <= json * 1.02 + 20_000, `通道上发了 ${sent} 个字，输出写成 JSON 是 ${json}`)

  // 核心手里的那一份和界面的一样；重新订阅时的快照只有上限那么大
  const core = commandIn(snapshot(world))
  assert.deepEqual(
    { output: core.output, elided: core.elided },
    {
      output: seen.output,
      elided: seen.elided,
    },
  )
  const size = JSON.stringify(snapshot(world)).length
  assert.ok(size <= OUTPUT_KEEP + 20_000, `重新订阅时的快照有 ${size} 个字`)
})

/** 打开会话 a，看它里面那条命令在核心和界面的副本里各是什么样子 */
async function opened(threads: Thread[], feed?: (world: World) => Promise<void>) {
  const world = setup(threads)
  world.core.start()
  await settle()
  const ui = screen(world)
  await settle()
  await frame(world)
  await feed?.(world)
  const core = commandIn(snapshot(world))
  const seen = ui.item()
  assert.ok(seen, '界面的副本里应当有那条命令')
  return {
    core: { output: core.output, elided: core.elided },
    ui: { output: seen.output, elided: seen.elided },
  }
}

test('长输出：实时一段一段接、读历史拿到整段、中途恢复拿到半截再接，三条路得到的命令条目一模一样', async () => {
  // 带一点非 ASCII 的字：省掉的字节数和字数不一样，两边都要数对
  let full = ''
  for (let n = 1; full.length < 1_200_000; n++) full += `[${n}] 编译模块 … ok\n`

  // 一、实时：回合里一条命令，输出按 8 KB 一段来
  const live = await opened([thread({ id: 'a', turns: [] })], async (world) => {
    await world.command('session.send', { ...where, text: '跑个构建' })
    await settle()
    const server = world.peer.last()
    const base = { threadId: 'a', turnId: 'srv-1' }
    server.notify('turn/started', { threadId: 'a', turn: started('srv-1') })
    server.notify('item/started', {
      ...base,
      item: command('c1', null, 'inProgress'),
      startedAtMs: 0,
    })
    for (let at = 0; at < full.length; at += DELTA) {
      const delta = full.slice(at, at + DELTA)
      server.notify('item/commandExecution/outputDelta', { ...base, itemId: 'c1', delta })
      if ((at / DELTA) % PER_FRAME === PER_FRAME - 1) {
        await settle()
        await frame(world)
      }
    }
    await settle()
    await frame(world)
  })

  // 二、读历史：回合已经结束，对面给的是整段输出
  const read = await opened([
    thread({ id: 'a', turns: [turn('t1', [command('c1', full, 'completed')])] }),
  ])

  // 三、中途恢复：回合还在跑，对面给的是到这一刻为止的输出（37%），之后的按 3000 个字一段接着来
  const half = Math.floor(full.length * 0.37)
  const resumed = await opened(
    [
      thread({
        id: 'a',
        turns: [
          turn('t1', [command('c1', full.slice(0, half), 'inProgress')], {
            status: 'inProgress',
          }),
        ],
      }),
    ],
    async (world) => {
      const server = world.peer.last()
      for (let at = half; at < full.length; at += 3000) {
        const delta = full.slice(at, at + 3000)
        server.notify('item/commandExecution/outputDelta', {
          threadId: 'a',
          turnId: 't1',
          itemId: 'c1',
          delta,
        })
      }
      await settle()
      await frame(world)
    },
  )

  assert.ok(read.core.elided, '超过上限的输出应当省过')
  for (const [name, got] of [
    ['实时', live],
    ['中途恢复', resumed],
  ] as const) {
    assert.deepEqual(got.core, read.core, `${name}：核心里的样子和读历史的不一样`)
    assert.deepEqual(got.ui, read.core, `${name}：界面的副本和读历史的不一样`)
  }
  assert.deepEqual(read.ui, read.core)
  assert.equal(
    read.core.elided.bytes,
    new TextEncoder().encode(
      full.slice(read.core.output.length, read.core.output.length + read.core.elided.chars),
    ).length,
  )
})

test('长输出：一帧里来几百 KB（快的命令一口气打出来），通道上每一帧发给界面的只有上限那么多，界面看到的和核心的一样', async () => {
  const world = setup()
  world.core.start()
  await settle()
  const ui = screen(world)
  await settle()
  await world.command('session.send', { ...where, text: '跑个构建' })
  await settle()
  const server = world.peer.last()
  const base = { threadId: 'a', turnId: 'srv-1' }
  server.notify('turn/started', { threadId: 'a', turn: started('srv-1') })
  server.notify('item/started', {
    ...base,
    item: command('c1', null, 'inProgress'),
    startedAtMs: 0,
  })
  await settle()
  await frame(world)

  // 带一点非 ASCII 和代理对：省掉的字节数和字数不一样，切的地方还不能拆开代理对
  let full = ''
  for (let n = 1; full.length < 6 * 1024 * 1024; n++) full += `[${n}] 编译 😀 … ok\n`
  /** 每一帧 64 段、一段 8 KB：一帧 512 KB */
  const burst = 64
  let frames = 0
  let most = 0
  const sent = ui.wire()
  for (let at = 0; at < full.length; ) {
    for (let index = 0; index < burst && at < full.length; index++, at += DELTA) {
      const delta = full.slice(at, at + DELTA)
      server.notify('item/commandExecution/outputDelta', { ...base, itemId: 'c1', delta })
    }
    const before = ui.wire()
    await settle()
    await frame(world)
    frames++
    most = Math.max(most, ui.wire() - before)
    // 每一帧过后界面的副本和核心手里的一样
    const core = commandIn(snapshot(world))
    const seen = ui.item()
    assert.deepEqual(
      { output: seen?.output, elided: seen?.elided },
      { output: core.output, elided: core.elided },
      `第 ${frames} 帧之后界面的副本和核心的不一样`,
    )
  }
  const total = ui.wire() - sent
  // 一帧至多发头尾那么多（开头 16K、末尾 64K 到 80K，再加上 JSON 的壳），不是一帧 512 KB
  const bound = OUTPUT_KEEP + 2 * 16 * 1024 + 4096
  assert.ok(most <= bound, `一帧里通道上最多发了 ${most} 个字，上限 ${bound}`)
  assert.ok(total <= frames * bound, `${frames} 帧一共发了 ${total} 个字`)
  assert.ok(
    total * 4 < JSON.stringify(full).length,
    `一共发了 ${total} 个字，输出有 ${full.length} 个字`,
  )
  // 末尾是最后那几行
  const seen = ui.item()
  assert.ok(seen?.elided && full.endsWith(seen.elided.tail))
})
