import assert from 'node:assert/strict'
import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { approvalHarness, pause } from './approval-harness.mjs'

// 临时会话（ephemeral）照上游（rust-v0.162.0-alpha.20 的 thread_processor.rs，thread/start、thread/fork 那两段）：
// 不落盘（Pi 这边是不写原生会话文件）、不进 thread/list、会话对象 ephemeral 为 true、path 为空，
// 会话级的通知只给订阅着它的连接（仓库根 AGENTS.md 里的约定）；上游在它没有订阅者、闲着时卸载它，
// 卸载了就没了（没有可以重新载入的记录），之后按会话号找答“没有这个会话”。
// 官方桌面端改名时（会话“…”→重命名→保存）发的就是一个带 ephemeral 的 thread/fork，在上面跑一个回合起描述，再退订。
// 真实 Pi SDK、回环上的假模型。

/** 原生会话目录（代理目录下的 sessions）里现有的会话文件 */
function nativeFiles(agentDir: string): string[] {
  const directory = join(agentDir, 'sessions')
  if (!existsSync(directory)) return []
  return readdirSync(directory, { recursive: true })
    .map(String)
    .filter((name) => name.endsWith('.jsonl'))
    .sort()
}

const about = (m: any): string | undefined => m.params?.threadId ?? m.params?.thread?.id

type Connection = Awaited<ReturnType<Awaited<ReturnType<typeof approvalHarness>>['connect']>>

/** 等这个会话没了：释放是请求应答之后的事，按会话号读答“没有这个会话” */
async function gone(who: Connection, threadId: string): Promise<void> {
  for (let waited = 0; ; waited += 10) {
    const reply = await who.call('thread/read', { threadId })
    if (reply.error) {
      assert.equal(reply.error.message, `thread not found: ${threadId}`)
      return
    }
    assert.ok(waited < 10000, `临时会话 ${threadId} 一直没有卸载`)
    await pause(10)
  }
}

test('EPHEMERAL-PI-001：临时分叉不写原生会话文件、不进列表、通知只给建它的连接，退订之后就没了', {
  timeout: 60000,
}, async () => {
  const h = await approvalHarness({ approvals: false })
  try {
    // 官方桌面端（不声明扩展）和同一台机器上的另一条连接（Litch 侧栏）
    const desktop = await h.connect('desktop')
    const other = await h.connect('other')
    const source = (await desktop.ok('thread/start', { cwd: h.cwd, model: 'gate/gate' })).thread.id
    const first = await desktop.start(source, '第一轮')
    await desktop.completed(first)
    await desktop.ok('thread/name/set', { threadId: source, name: '源会话' })
    const files = nativeFiles(h.agentDir)
    assert.equal(files.length, 1, '前提：源会话有自己的原生会话文件')

    const fork = (await desktop.ok('thread/fork', { threadId: source, ephemeral: true })).thread
    assert.notEqual(fork.id, source)
    assert.deepEqual(
      [fork.ephemeral, fork.path, fork.forkedFromId, fork.name, fork.preview],
      [true, null, source, '源会话', '第一轮'],
    )
    assert.deepEqual(
      fork.turns.map((turn: any) => turn.id),
      [first],
      '应答里带着源会话的回合',
    )
    const started = await desktop.until(
      '临时分叉的 thread/started',
      (m) => m.method === 'thread/started' && m.params.thread.id === fork.id,
    )
    assert.equal(started.params.thread.ephemeral, true)

    // 桌面端在上面跑一个回合起描述：模型拿到的是源会话的历史，原生会话目录里还是只有源会话那一个文件
    const asked = h.requests.length
    const helper = await desktop.start(fork.id, '起个描述')
    assert.equal((await desktop.completed(helper)).status, 'completed')
    assert.match(JSON.stringify(h.requests.slice(asked).at(-1).messages), /第一轮/)
    assert.deepEqual(nativeFiles(h.agentDir), files, '临时分叉不该写原生会话文件')

    // 不进列表，哪条连接来列都一样
    for (const who of [desktop, other])
      assert.deepEqual(
        (await who.ok('thread/list', {})).data.map((thread: any) => thread.id),
        [source],
        `${who.peer.id} 列出的会话`,
      )

    // 退订之后卸载：按会话号找答“没有这个会话”，库里也不留
    assert.deepEqual(await desktop.ok('thread/unsubscribe', { threadId: fork.id }), {
      status: 'unsubscribed',
    })
    await gone(desktop, fork.id)
    assert.ok(!h.server.store.threads().some((thread) => thread.id === fork.id))
    assert.equal((await desktop.ok('thread/loaded/list')).data.includes(fork.id), false)
    assert.deepEqual(nativeFiles(h.agentDir), files)

    // 另一条连接从头到尾收不到它的任何通知（新建、状态、改名、关闭都算）
    assert.deepEqual(
      other.messages.filter((m) => about(m) === fork.id),
      [],
      '临时会话的通知不给别的连接',
    )
    // 源会话照旧
    assert.equal((await desktop.ok('thread/read', { threadId: source })).thread.turns.length, 1)
    assert.deepEqual(h.invalid, [], '往来消息必须符合协议 schema')
  } finally {
    await h.dispose()
  }
})

test('EPHEMERAL-PI-002：临时新建的会话跑过回合也不写原生会话文件，建它的连接断开之后就没了', {
  timeout: 60000,
}, async () => {
  const h = await approvalHarness({ approvals: false })
  try {
    const helper = await h.connect('helper')
    const other = await h.connect('other')
    const thread = (
      await helper.ok('thread/start', { cwd: h.cwd, model: 'gate/gate', ephemeral: true })
    ).thread
    assert.deepEqual([thread.ephemeral, thread.path], [true, null])
    const turn = await helper.start(thread.id, '起个标题')
    assert.equal((await helper.completed(turn)).status, 'completed')
    assert.deepEqual(nativeFiles(h.agentDir), [], '临时会话不该写原生会话文件')
    assert.deepEqual((await other.ok('thread/list', {})).data, [])

    // 建它的连接断开：没人订阅了，卸载掉，之后哪条连接按会话号找都答“没有这个会话”，也不会再载入成一个空会话
    h.server.closePeer(helper.peer)
    await gone(other, thread.id)
    const resumed = await other.call('thread/resume', { threadId: thread.id })
    assert.equal(resumed.error?.message, `thread not found: ${thread.id}`)
    assert.deepEqual(
      other.messages.filter((m) => about(m) === thread.id),
      [],
      '临时会话的通知不给别的连接',
    )
    assert.deepEqual(h.invalid, [], '往来消息必须符合协议 schema')
  } finally {
    await h.dispose()
  }
})

test('EPHEMERAL-PI-003：临时会话的回合被打断之后会话还在，下一个回合接着原来的上下文', {
  timeout: 60000,
}, async () => {
  const h = await approvalHarness({ approvals: false })
  try {
    const c = await h.connect('helper')
    const threadId = (
      await c.ok('thread/start', { cwd: h.cwd, model: 'gate/gate', ephemeral: true })
    ).thread.id
    await c.completed(await c.start(threadId, '暗号是甲乙丙'))
    // 第二轮的模型请求一直不答，等用例打断它
    let release = () => {}
    h.steps.push(
      () =>
        new Promise((resolve) => {
          release = () => resolve({ text: '晚了' })
        }),
    )
    const asked = h.requests.length
    const hung = await c.start(threadId, '第二轮')
    await c.until('第二轮请求了模型', () => h.requests.length > asked)
    await c.ok('turn/interrupt', { threadId, turnId: hung })
    assert.equal((await c.completed(hung)).status, 'interrupted')
    release()
    // 内存里的会话是它唯一的一份：打断时不能丢掉，丢了下一轮就成了一个什么都没有的新会话
    const before = h.requests.length
    const third = await c.start(threadId, '第三轮')
    assert.equal((await c.completed(third)).status, 'completed')
    assert.match(JSON.stringify(h.requests.slice(before).at(-1).messages), /暗号是甲乙丙/)
    assert.deepEqual(
      (await c.ok('thread/read', { threadId, includeTurns: true })).thread.turns.map(
        (turn: any) => turn.status,
      ),
      ['completed', 'interrupted', 'completed'],
    )
    assert.deepEqual(nativeFiles(h.agentDir), [])
    assert.deepEqual(h.invalid, [], '往来消息必须符合协议 schema')
  } finally {
    await h.dispose()
  }
})
