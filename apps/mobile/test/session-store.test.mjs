// 会话存储（src/core/session-store.ts）接在模拟核心上：和手机上 mock 装法同一条数据路径（核心 → 内存端口 → 订阅 → 行）。
// 新建会话收到流式回答、流式时尾巴单独交出、审批答完回合接着走、展开一组只重算那个回合、停了就不再交。
import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { growingRows, SessionStore } from '../src/core/session-store.ts'
import { acquireStore, releaseStore } from '../src/core/store-cache.ts'
import { mockChannel, until } from './helpers.mjs'

const cleanup = []
afterEach(() => {
  for (const done of cleanup.splice(0)) done()
})

async function open(text, options) {
  const mock = mockChannel(options)
  const { sessionId } = await mock.channel.command('session.create', {
    deviceId: 'local',
    cwd: null,
    text,
  })
  const store = new SessionStore(mock.channel, 'local', sessionId)
  cleanup.push(() => {
    store.stop()
    mock.close()
  })
  return { store, channel: mock.channel, sessionId }
}

/** 新的在前的行，倒回成从旧到新再看种类 */
const kinds = (rows) => rows.map((row) => row.type).toReversed()
const finished = (store) => {
  const { rows, running } = store.getSnapshot()
  return !running && rows[0]?.type === 'status' && rows[0].status === 'completed'
}

test('新建会话：收到回答，回合结束后是用户消息、回答、状态行', async () => {
  const { store } = await open('你好')
  store.start()
  await until(() => finished(store), { what: '回合结束' })
  const { rows, error } = store.getSnapshot()
  assert.equal(error, null)
  assert.deepEqual(kinds(rows), ['user', 'md', 'status'])
  assert.equal(rows.at(-1).text, '你好')
  assert.ok(rows[1].text.length > 0, '回答有字')
  const meta = store.getMeta()
  assert.equal(meta.running, false)
  assert.equal(meta.lastTurn.status, 'completed')
  assert.ok(store.stats.publishes > 1, '流式时交了不止一次')
})

test('流式时尾巴单独交出：列表里没有正在长的回答，写完才并回列表', async () => {
  // 慢一点流，好在中途看
  const { store } = await open('长回答', { chunkMs: 20 })
  store.setSplitTail(true)
  store.start()
  const tail = await until(() => (store.getTail().rows.length >= 2 ? store.getTail() : null), {
    what: '尾巴',
  })
  assert.equal(tail.rows[0].type, 'status')
  assert.equal(tail.rows[0].status, 'running')
  assert.equal(tail.rows[1].type, 'md')
  assert.equal(tail.rows[1].live, true)
  assert.ok(
    store.getSnapshot().rows.every((row) => !(row.type === 'md' && row.live)),
    '列表里没有在流式的块',
  )
  await until(() => finished(store), { timeoutMs: 20000, what: '长回答写完' })
  assert.deepEqual(store.getTail().rows, [])
  assert.ok(store.getSnapshot().rows.some((row) => row.type === 'md'))
})

test('往上翻着看时尾巴并回列表：最底下会长高的是状态行和正在流的那一块，回合结束后没有', async () => {
  const { store } = await open('长回答', { chunkMs: 20 })
  store.setSplitTail(true)
  store.start()
  await until(() => (store.getTail().rows.length >= 2 ? true : null), { what: '尾巴' })
  assert.equal(growingRows(store.getSnapshot()), 0, '贴底时它们在尾巴里，不在列表里')
  store.setSplitTail(false)
  assert.deepEqual(store.getTail().rows, [])
  // 字刚好停在块的边上时最后一块已经封口、新的一块还没开始，等到正在长的那一块
  const rows = await until(
    () => (store.getSnapshot().rows[1]?.open ? store.getSnapshot().rows : null),
    {
      what: '正在长的那一块',
    },
  )
  assert.equal(rows[0].type, 'status')
  assert.equal(rows[1].type, 'md')
  assert.equal(growingRows(store.getSnapshot()), 2)
  await until(() => finished(store), { timeoutMs: 20000, what: '长回答写完' })
  assert.equal(growingRows(store.getSnapshot()), 0)
})

test('挑锚点的 FlashList 补丁对得上装的版本（升级 FlashList 时要重做补丁）', async () => {
  const { readdirSync, readFileSync } = await import('node:fs')
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  const version = pkg.dependencies['@shopify/flash-list']
  const patches = readdirSync(new URL('../patches/', import.meta.url))
  assert.ok(patches.includes(`@shopify+flash-list+${version}.patch`), patches.join(', '))
})

test('审批：请求进会话层面的状态，答了“允许”之后请求没了、回合走完', async () => {
  const { store, channel, sessionId } = await open('要审批')
  store.start()
  const meta = await until(() => (store.getMeta()?.requests.length ? store.getMeta() : null), {
    what: '审批请求',
  })
  const [request] = meta.requests
  assert.equal(request.kind, 'approval')
  assert.ok(request.options.some((option) => option.role === 'accept'))
  assert.equal(meta.running, true)
  await channel.command('session.respond', {
    deviceId: 'local',
    sessionId,
    requestId: request.id,
    optionId: request.options.find((option) => option.role === 'accept').id,
  })
  await until(() => finished(store), { what: '答完之后回合结束' })
  assert.deepEqual(store.getMeta().requests, [])
  // 回合结束整段过程收成一行；点开它露出过程组
  const head = store.getSnapshot().rows.find((row) => row.type === 'process')
  assert.ok(head, '过程收成一行')
  store.toggle(head.key, head.turnId)
  // 命令那一步收在过程组里；展开后多出每一步和末尾的“收起”，只重算这个回合
  const group = store.getSnapshot().rows.find((row) => row.type === 'group')
  assert.ok(group, '有过程组')
  const before = store.getSnapshot().rows.length
  store.toggle(group.key, group.turnId)
  assert.equal(store.getSnapshot().rows.length, before + group.count + 1)
  assert.ok(store.getSnapshot().rows.some((row) => row.type === 'step'))
  // 新的在前：“收起”在步骤前面、摘要在它们后面（倒置后摘要在最上面）
  const order = kinds(store.getSnapshot().rows).filter((type) => /group|step/.test(type))
  assert.deepEqual(order.slice(0, 2), ['group', 'step'])
  assert.equal(order.at(-1), 'groupEnd')
})

test('子代理：派出的那一行跟着子线程的回合换状态，等待收在过程组里，会话层面带着子代理列表', async () => {
  const { store } = await open('用子代理')
  store.start()
  await until(() => finished(store), { timeoutMs: 20000, what: '子代理都停下、回合结束' })
  const folded = store.getSnapshot().rows
  assert.deepEqual(kinds(folded), ['user', 'process', 'md', 'status'])
  const head = folded.find((row) => row.type === 'process')
  assert.equal(head.agents, 3)
  assert.equal(head.agentsFailed, 1, '出错的子代理在收起行上标红')
  store.toggle(head.key, head.turnId)
  const { rows } = store.getSnapshot()
  assert.deepEqual(kinds(rows), ['user', 'process', 'agents', 'group', 'md', 'status'])
  const agents = rows.find((row) => row.type === 'agents')
  // 模拟核心和真的 Claude 入口一样：派出的那一条一直报“在跑”，状态以子线程为准
  assert.equal(agents.states, 'completed stopped failed')
  assert.equal(agents.threads.length, 3)
  assert.equal(rows.find((row) => row.type === 'group').count, 1)
  assert.deepEqual(
    store.getMeta().agents.map((agent) => agent.id),
    agents.item.agents.map((agent) => agent.threadId),
  )
})

test('回合里的用户消息、最后一条回答的全文', async () => {
  const { store } = await open('你好')
  store.start()
  await until(() => finished(store), { what: '回合结束' })
  const turnId = store.getMeta().lastTurn.id
  assert.equal(store.userMessage(turnId)?.text, '你好')
  assert.equal(store.userMessage('没有这个回合'), null)
  const md = store
    .getSnapshot()
    .rows.filter((row) => row.type === 'md')
    .map((row) => row.text)
  assert.ok(store.answerText(turnId)?.startsWith(md.at(-1).slice(0, 5)))
})

test('停了就不再交给界面', async () => {
  const { store, channel, sessionId } = await open('你好')
  store.start()
  await until(() => finished(store), { what: '回合结束' })
  store.stop()
  const publishes = store.stats.publishes
  await channel.command('session.send', { deviceId: 'local', sessionId, text: '再来一句' })
  await new Promise((done) => setTimeout(done, 200))
  assert.equal(store.stats.publishes, publishes)
})

test('刚看过的会话留着：再进来是同一个存储，用完的过期关掉', async (t) => {
  const mock = mockChannel()
  cleanup.push(() => mock.close())
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] })
  const a = acquireStore(mock.channel, 'local', 's-a')
  releaseStore(a)
  assert.equal(acquireStore(mock.channel, 'local', 's-a'), a, '离开后马上回来还是那一个')
  releaseStore(a)
  t.mock.timers.tick(60_001)
  const again = acquireStore(mock.channel, 'local', 's-a')
  assert.notEqual(again, a, '过了一分钟就关了')
  releaseStore(again)
  // 最多留三个：第四个离开时，离开最久的那个先关
  const stores = ['s1', 's2', 's3', 's4'].map((id) => acquireStore(mock.channel, 'local', id))
  for (const store of stores) {
    releaseStore(store)
    t.mock.timers.tick(10)
  }
  assert.notEqual(acquireStore(mock.channel, 'local', 's1'), stores[0])
  assert.equal(acquireStore(mock.channel, 'local', 's4'), stores[3])
  t.mock.timers.tick(120_000)
})

test('后台任务：报集合的会话不派生（meta.derived 是 null），回合说完时两条命令还在跑、会话不算在跑', async () => {
  const { store } = await open('起两个后台任务')
  store.start()
  await until(() => finished(store), { timeoutMs: 20000, what: '回合说完' })
  const meta = store.getMeta()
  assert.equal(meta.can.backgroundTasks, true)
  assert.equal(meta.derived, null)
  assert.equal(meta.running, false)
})
