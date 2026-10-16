import assert from 'node:assert/strict'
import test from 'node:test'
import { PendingInteractions } from '../src/pending-interactions.mjs'
import type { RpcPeer, WireMessage } from '../src/types.mjs'

// 这个线程此刻该由哪些连接来答：这些用例里只有一条或者没有。
const holding = (target: RpcPeer | null): RpcPeer[] => (target ? [target] : [])

function peer(id: string): RpcPeer & { messages: WireMessage[] } {
  const messages: WireMessage[] = []
  return {
    id,
    messages,
    send: (message) => {
      messages.push(message)
    },
    close: () => {},
  }
}

test('MCP 请求级取消只结束指定交互，迟到回答无效', async () => {
  const pending = new PendingInteractions()
  const owner = peer('owner')
  const abort = new AbortController()
  const cancelled = assert.rejects(
    pending.request(
      () => [owner],
      'mcpServer/elicitation/request',
      'cancelled',
      { threadId: 'same-thread' },
      { signal: abort.signal },
    ),
    /已取消/,
  )
  const unaffected = pending.request(() => [owner], 'mcpServer/elicitation/request', 'unaffected', {
    threadId: 'same-thread',
  })
  abort.abort()
  pending.resolve(owner, { jsonrpc: '2.0', id: 'cancelled', result: { action: 'accept' } })
  pending.resolve(owner, { jsonrpc: '2.0', id: 'unaffected', result: { action: 'decline' } })
  await cancelled
  assert.deepEqual(await unaffected, { action: 'decline' })
  await assert.rejects(
    pending.request(
      () => [owner],
      'mcpServer/elicitation/request',
      'already-cancelled',
      { threadId: 'same-thread' },
      { signal: abort.signal },
    ),
    /已取消/,
  )
  assert.equal(owner.messages.length, 2)
})

test('APPROVAL-001：相同请求 ID 不能由另一个连接回答，首次回答生效', async () => {
  const pending = new PendingInteractions()
  const owner = peer('owner')
  const other = peer('other')
  const result = pending.request(() => [owner], 'item/tool/call', 'same-id', { threadId: 'thread' })
  pending.resolve(other, { jsonrpc: '2.0', id: 'same-id', result: 'foreign' })
  pending.resolve(owner, { jsonrpc: '2.0', id: 'same-id', result: 'first' })
  pending.resolve(owner, { jsonrpc: '2.0', id: 'same-id', result: 'duplicate' })
  assert.equal(await result, 'first')
})

test('人工交互等待超过两分钟或一天仍可回答，且只完成一次', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  for (const elapsedMs of [120_001, 86_400_000]) {
    const pending = new PendingInteractions()
    const owner = peer('owner')
    const abort = new AbortController()
    let finished = 0
    const result = pending.request(
      () => [owner],
      'item/tool/call',
      'waiting',
      { threadId: 'thread' },
      {
        signal: abort.signal,
        onFinished: () => {
          finished++
        },
      },
    )
    t.mock.timers.tick(elapsedMs)
    assert.equal(finished, 0)
    pending.resolve(owner, { jsonrpc: '2.0', id: 'waiting', result: 'confirmed' })
    assert.equal(await result, 'confirmed')
    abort.abort()
    pending.close()
    pending.resolve(owner, { jsonrpc: '2.0', id: 'waiting', result: 'duplicate' })
    assert.equal(finished, 1)
  }
})

test('APPROVAL-002：工具调用所在的连接断开、回合中断与关闭使旧请求失效', async () => {
  const pending = new PendingInteractions()
  const owner = peer('owner')
  const disconnect = pending.request(() => [owner], 'item/tool/call', 'disconnect', {
    threadId: 'a',
  })
  const disconnected = assert.rejects(disconnect, /连接已关闭/)
  pending.dropPeer(owner.id)
  await disconnected
  const interrupt = pending.request(() => [owner], 'item/tool/call', 'interrupt', { threadId: 'a' })
  const interrupted = assert.rejects(interrupt, /中断/)
  const unrelated = pending.request(() => [owner], 'item/tool/call', 'unrelated', { threadId: 'b' })
  pending.cancelThread('a')
  pending.resolve(owner, { jsonrpc: '2.0', id: 'unrelated', result: 'ok' })
  await interrupted
  assert.equal(await unrelated, 'ok')
  const stopped = assert.rejects(
    pending.request(() => [owner], 'item/tool/call', 'stop', { threadId: 'a' }),
    /停止/,
  )
  pending.close()
  pending.resolve(owner, { jsonrpc: '2.0', id: 'stop', result: 'late' })
  await stopped
})

test('APPROVAL-008：没有客户端在看时请求一直留着，有连接订阅后送达，回答照常生效', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const pending = new PendingInteractions()
  let subscriber: ReturnType<typeof peer> | null = null
  const finishedWith: Array<string | null> = []
  const result = pending.request(
    () => holding(subscriber),
    'item/fileChange/requestApproval',
    'held',
    { threadId: 'thread' },
    { onFinished: (holders) => finishedWith.push(holders[0]?.id ?? null) },
  )
  assert.equal(pending.has('thread'), true)
  assert.deepEqual(pending.unattended(), ['thread'])
  // 不设超时：过多久都还在等。
  t.mock.timers.tick(7 * 86_400_000)
  pending.reroute()
  assert.deepEqual(pending.unattended(), ['thread'])

  const late = peer('late')
  subscriber = late
  pending.reroute()
  assert.deepEqual(late.messages, [
    {
      jsonrpc: '2.0',
      id: 'held',
      method: 'item/fileChange/requestApproval',
      params: { threadId: 'thread' },
    },
  ])
  assert.deepEqual(pending.unattended(), [])
  // 已经在它手里的请求不重复发送。
  pending.reroute()
  assert.equal(late.messages.length, 1)
  pending.resolve(late, { jsonrpc: '2.0', id: 'held', result: { decision: 'accept' } })
  assert.deepEqual(await result, { decision: 'accept' })
  assert.deepEqual(finishedWith, ['late'])
  assert.equal(pending.has('thread'), false)
})

test('APPROVAL-009：拿着请求的连接断开后请求不作废，原样送给下一个订阅者；订阅换了连接则改送并通知原连接', async () => {
  const withdrawn: string[] = []
  const pending = new PendingInteractions((from, threadId, id) =>
    withdrawn.push(`${from.id}:${threadId}:${id}`),
  )
  const first = peer('first')
  const second = peer('second')
  const third = peer('third')
  let subscriber: ReturnType<typeof peer> | null = first
  const result = pending.request(() => holding(subscriber), 'item/tool/requestUserInput', 'kept', {
    threadId: 'thread',
  })
  assert.equal(first.messages.length, 1)

  // 连接断开：请求回到没人可送。
  subscriber = null
  pending.dropPeer(first.id)
  pending.reroute()
  assert.deepEqual(pending.unattended(), ['thread'])
  assert.deepEqual(withdrawn, [], '断开的连接不需要通知')

  subscriber = second
  pending.reroute()
  assert.deepEqual(second.messages, first.messages, '请求 ID 与内容不变')

  // 订阅换成另一条连接，原来那条还连着：改送，并让原连接撤掉卡片。
  subscriber = third
  pending.reroute()
  assert.deepEqual(third.messages, first.messages)
  assert.deepEqual(withdrawn, ['second:thread:kept'])
  pending.resolve(second, { jsonrpc: '2.0', id: 'kept', result: 'stale' })
  pending.resolve(third, { jsonrpc: '2.0', id: 'kept', result: 'current' })
  assert.equal(await result, 'current')
})

test('APPROVAL-010：工具调用没送出去时同样等订阅者；送出之后不换连接、不重发', async () => {
  const withdrawn: string[] = []
  const pending = new PendingInteractions((from) => withdrawn.push(from.id))
  const first = peer('first')
  const second = peer('second')
  let subscriber: ReturnType<typeof peer> | null = null
  const result = pending.request(() => holding(subscriber), 'item/tool/call', 'tool', {
    threadId: 'thread',
  })
  assert.deepEqual(pending.unattended(), ['thread'])
  subscriber = first
  pending.reroute()
  assert.equal(first.messages.length, 1)

  // 客户端可能已经执行了这次调用：订阅换了连接也不送第二次。
  subscriber = second
  pending.reroute()
  assert.equal(second.messages.length, 0)
  assert.deepEqual(withdrawn, [])
  pending.resolve(first, { jsonrpc: '2.0', id: 'tool', result: 'done' })
  assert.equal(await result, 'done')
})

test('APPROVAL-011：不属于任何线程的请求只跟发起它的连接走，连接断开即失效', async () => {
  const pending = new PendingInteractions()
  const owner = peer('owner')
  let connected: ReturnType<typeof peer> | null = owner
  const threadless = pending.request(
    () => holding(connected),
    'mcpServer/elicitation/request',
    'probe',
    {
      threadId: null,
    },
  )
  const closed = assert.rejects(threadless, /连接已关闭/)
  connected = null
  pending.dropPeer(owner.id)
  await closed
  assert.deepEqual(pending.unattended(), [])
  // 发起时连接已经不在：没有线程可订阅，等不来别的连接。
  await assert.rejects(
    pending.request(() => [], 'mcpServer/elicitation/request', 'gone', { threadId: null }),
    /连接已关闭/,
  )
})

test('APPROVAL-012：带协议扩展内容的请求按要送去的连接给参数，改送别的连接时重新给一份', async () => {
  const pending = new PendingInteractions()
  // 握手时声明了扩展的连接收到带扩展的那份，没声明的收到标准的那份。
  const standard = { threadId: 'thread', availableDecisions: ['accept', 'decline'] }
  const extended = { threadId: 'thread', availableDecisions: ['accept', 'decline', 'extra'] }
  const plain = peer('plain')
  const aware = peer('aware')
  const paramsFor = (target: RpcPeer) => (target === aware ? extended : standard)
  let subscriber: ReturnType<typeof peer> | null = plain
  const result = pending.request(
    () => holding(subscriber),
    'item/commandExecution/requestApproval',
    'shaped',
    standard,
    { paramsFor },
  )
  const sent = (params: unknown) => [
    { jsonrpc: '2.0', id: 'shaped', method: 'item/commandExecution/requestApproval', params },
  ]
  assert.deepEqual(plain.messages, sent(standard))

  // 订阅换到声明过的连接：同一条请求、同一个 ID，参数换成带扩展的那份。
  subscriber = aware
  pending.reroute()
  assert.deepEqual(aware.messages, sent(extended))

  // 再换回没声明的连接（原来那条断开后重连）：收到的还是标准的那份，扩展内容不会跟过去。
  const later = peer('later')
  subscriber = later
  pending.dropPeer(aware.id)
  pending.reroute()
  assert.deepEqual(later.messages, sent(standard))
  pending.resolve(later, { jsonrpc: '2.0', id: 'shaped', result: { decision: 'decline' } })
  assert.deepEqual(await result, { decision: 'decline' })
})

test('APPROVAL-013：决定类请求发给全部订阅连接，请求号相同；先答的生效，迟到的应答无效', async () => {
  const withdrawn: string[] = []
  const pending = new PendingInteractions((from) => withdrawn.push(from.id))
  const first = peer('first')
  const second = peer('second')
  const finishedWith: string[][] = []
  const result = pending.request(
    () => [first, second],
    'item/commandExecution/requestApproval',
    'shared',
    { threadId: 'thread' },
    { onFinished: (holders) => finishedWith.push(holders.map((holder) => holder.id)) },
  )
  assert.equal(first.messages.length, 1)
  assert.deepEqual(second.messages, first.messages)
  assert.deepEqual(pending.unattended(), [])

  pending.resolve(second, { jsonrpc: '2.0', id: 'shared', result: { decision: 'decline' } })
  pending.resolve(first, { jsonrpc: '2.0', id: 'shared', result: { decision: 'accept' } })
  assert.deepEqual(await result, { decision: 'decline' })
  assert.deepEqual(finishedWith, [['first', 'second']], '结束时告知拿着这条请求的每条连接，只一次')
  assert.deepEqual(withdrawn, [], '有了结果不算撤回')
})

test('APPROVAL-014：多了订阅连接只补送给新来的；少了的那条被撤回，它再答不算；断开的只摘掉它自己', async () => {
  const withdrawn: string[] = []
  const pending = new PendingInteractions((from, threadId, id) =>
    withdrawn.push(`${from.id}:${threadId}:${id}`),
  )
  const first = peer('first')
  const second = peer('second')
  const third = peer('third')
  let subscribers: RpcPeer[] = [first]
  const result = pending.request(() => subscribers, 'item/tool/requestUserInput', 'kept', {
    threadId: 'thread',
  })

  // 又来一条连接订阅：只有它收到，原来那条既不重复收也不被撤回。
  subscribers = [first, second]
  pending.reroute()
  pending.reroute()
  assert.equal(first.messages.length, 1)
  assert.deepEqual(second.messages, first.messages)
  assert.deepEqual(withdrawn, [])

  // 先来的那条断开：请求还在另一条手里，不算无人在看。
  subscribers = [second]
  pending.dropPeer(first.id)
  pending.reroute()
  assert.deepEqual(pending.unattended(), [])
  assert.deepEqual(withdrawn, [], '断开的连接不需要通知')

  // 第三条来了、第二条退订（还连着）：第二条被告知撤回，它之后的回答不算。
  subscribers = [third]
  pending.reroute()
  assert.deepEqual(third.messages, first.messages)
  assert.deepEqual(withdrawn, ['second:thread:kept'])
  pending.resolve(second, { jsonrpc: '2.0', id: 'kept', result: 'stale' })
  pending.resolve(third, { jsonrpc: '2.0', id: 'kept', result: 'current' })
  assert.equal(await result, 'current')
})

test('APPROVAL-015：每条连接按自己的声明拿参数；最后一个拿着请求的连接断开后回到无人可送', async () => {
  const pending = new PendingInteractions()
  const standard = { threadId: 'thread', availableDecisions: ['accept', 'decline'] }
  const extended = { threadId: 'thread', availableDecisions: ['accept', 'decline', 'extra'] }
  const plain = peer('plain')
  const aware = peer('aware')
  let subscribers: RpcPeer[] = [plain, aware]
  const result = pending.request(
    () => subscribers,
    'item/commandExecution/requestApproval',
    'shaped',
    standard,
    { paramsFor: (target) => (target === aware ? extended : standard) },
  )
  const sent = (params: unknown) => [
    { jsonrpc: '2.0', id: 'shaped', method: 'item/commandExecution/requestApproval', params },
  ]
  assert.deepEqual(plain.messages, sent(standard))
  assert.deepEqual(aware.messages, sent(extended))

  subscribers = []
  pending.dropPeer(plain.id)
  assert.deepEqual(pending.unattended(), [])
  pending.dropPeer(aware.id)
  pending.reroute()
  assert.deepEqual(pending.unattended(), ['thread'], '一条都不剩了才算没人在看，请求照旧留着')

  const later = peer('later')
  subscribers = [later]
  pending.reroute()
  assert.deepEqual(later.messages, sent(standard))
  pending.resolve(later, { jsonrpc: '2.0', id: 'shaped', result: { decision: 'accept' } })
  assert.deepEqual(await result, { decision: 'accept' })
})

test('APPROVAL-016：送出去的工具调用只在一条连接手里，别的连接订阅了也不补送', async () => {
  const pending = new PendingInteractions()
  const first = peer('first')
  const second = peer('second')
  let targets: RpcPeer[] = [first]
  const result = pending.request(() => targets, 'item/tool/call', 'tool', { threadId: 'thread' })
  targets = [first, second]
  pending.reroute()
  assert.equal(second.messages.length, 0, '工具调用可能已经产生副作用，不能再交给别的连接执行一次')
  pending.resolve(second, { jsonrpc: '2.0', id: 'tool', result: 'foreign' })
  pending.resolve(first, { jsonrpc: '2.0', id: 'tool', result: 'done' })
  assert.equal(await result, 'done')
})
