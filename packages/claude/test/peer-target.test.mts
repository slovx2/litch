// 收件箱地址认回会话（peer-target.mts）：发往 uds:<套接字路径> 的 SendMessage 写成对方的名字，
// 按本机的进程登记、这个会话里收到过的消息、Litch 自己的会话认；读原生记录（native-history.mts）时也一样。
import assert from 'node:assert/strict'
import test from 'node:test'
import type { LitchPeer } from '../../protocol/src/peer-messages.mjs'
import { type NativeMessage, projectNativeHistory } from '../src/native-history.mjs'
import type { RegistryEntry } from '../src/native-owner.mjs'
import { resolvePeer, udsSocket } from '../src/peer-target.mjs'
import { toolUseItem, withPeerTarget } from '../src/tool-items.mjs'

const ADDRESS = 'uds:/tmp/cc-socks/887369.sock'

const entry = (fields: Partial<RegistryEntry>): RegistryEntry => ({
  pid: 887369,
  sessionId: 'native-1',
  procStart: null,
  status: 'idle',
  entrypoint: 'sdk-ts',
  socket: '/tmp/cc-socks/887369.sock',
  name: null,
  hostSessionId: null,
  ...fields,
})

test('PEER-TARGET-001：只认 uds: 开头的收件箱地址', () => {
  assert.equal(udsSocket(ADDRESS), '/tmp/cc-socks/887369.sock')
  assert.equal(udsSocket(' uds:/run/user/0/cc-socks/1.sock '), '/run/user/0/cc-socks/1.sock')
  assert.equal(udsSocket('修 CI'), null)
  assert.equal(udsSocket('bridge:abc'), null)
  // 按名字发的不用认，照原样写
  assert.equal(resolvePeer('修 CI', { registry: () => [entry({ name: 'x' })] }), null)
})

test('PEER-TARGET-002：按登记认，是 Litch 的会话时换成 Litch 里的标题并带会话号', () => {
  const registry = () => [
    entry({ pid: 1, socket: '/tmp/cc-socks/1.sock', name: '别人' }),
    entry({ name: 'workspace-19', hostSessionId: 'local_abc' }),
  ]
  assert.deepEqual(resolvePeer(ADDRESS, { registry }), {
    name: 'workspace-19',
    session: 'local_abc',
  })
  const thread = (sessionId: string) =>
    sessionId === 'native-1' ? { id: 'thread-9', name: '修 CI' } : null
  assert.deepEqual(resolvePeer(ADDRESS, { registry, thread }), {
    name: '修 CI',
    session: 'local_abc',
    thread: 'thread-9',
  })
  // Litch 的会话还没起标题：用登记名
  assert.deepEqual(
    resolvePeer(ADDRESS, { registry, thread: () => ({ id: 'thread-9', name: null }) }),
    { name: 'workspace-19', session: 'local_abc', thread: 'thread-9' },
  )
})

test('PEER-TARGET-003：登记里没有（对方退了）、读不了时按收到过的消息认；都认不出是 null', () => {
  const seen = new Map<string, LitchPeer>([
    [ADDRESS, { name: '终端里的 Claude', session: 'local_x', mode: 'bypass' }],
  ])
  // 发出去的这一边不带对方的权限档
  assert.deepEqual(resolvePeer(ADDRESS, { seen, registry: () => [] }), {
    name: '终端里的 Claude',
    session: 'local_x',
  })
  const broken = () => {
    throw new Error('EACCES')
  }
  assert.deepEqual(resolvePeer(ADDRESS, { seen, registry: broken }), {
    name: '终端里的 Claude',
    session: 'local_x',
  })
  assert.equal(resolvePeer(ADDRESS, { registry: () => [entry({ socket: '/other.sock' })] }), null)
  assert.equal(resolvePeer(ADDRESS, {}), null)
})

test('PEER-TARGET-004：收到的消息补上 Litch 会话，发送方自报的会话号和档位留着', () => {
  const base: LitchPeer = { name: 'peer-bypass', session: 'local_from', mode: 'bypass' }
  const registry = () => [entry({ name: 'peer-bypass' })]
  const thread = () => ({ id: 'thread-2', name: '写文档' })
  assert.deepEqual(resolvePeer(ADDRESS, { registry, thread }, base), {
    name: '写文档',
    session: 'local_from',
    thread: 'thread-2',
    mode: 'bypass',
  })
  // 认不出时原样给回去
  assert.deepEqual(resolvePeer(ADDRESS, {}, base), base)
})

test('PEER-TARGET-005：SendMessage 的条目认出收件方时写名字、带 litchPeer，认不出原样', () => {
  const send = toolUseItem(
    { toolUseId: 't1', toolName: 'SendMessage', input: { to: ADDRESS, message: 'hi' } },
    '/w',
    [],
    'i1',
  )
  assert.equal(send.type === 'mcpToolCall' && send.tool, `SendMessage ${ADDRESS}`)
  const named = withPeerTarget(send, () => ({ name: '修 CI', thread: 'thread-9' }))
  assert.equal(named.type === 'mcpToolCall' && named.tool, 'SendMessage 修 CI')
  assert.deepEqual(named.type === 'mcpToolCall' && named.litchPeer, {
    name: '修 CI',
    thread: 'thread-9',
  })
  // 参数里照旧是原始地址
  assert.deepEqual(named.type === 'mcpToolCall' && named.arguments, { to: ADDRESS, message: 'hi' })
  // 只认出了会话号：条目上带 litchPeer，名字还是地址（客户端写成可读的说法）
  const bare = withPeerTarget(send, () => ({ session: 'local_x' }))
  assert.equal(bare.type === 'mcpToolCall' && bare.tool, `SendMessage ${ADDRESS}`)
  assert.equal(
    withPeerTarget(send, () => null),
    send,
  )
  const read = toolUseItem(
    { toolUseId: 't2', toolName: 'Read', input: { file_path: '/w/a.ts', to: ADDRESS } },
    '/w',
    [],
  )
  assert.equal(
    withPeerTarget(read, () => ({ name: 'x' })),
    read,
  )
})

test('PEER-TARGET-006：读原生记录时回信按前面收到的消息认出收件方', () => {
  const messages: NativeMessage[] = [
    {
      type: 'user',
      uuid: 'u1',
      message: { role: 'user', content: [{ type: 'text', text: '<cross-session-message …>' }] },
      origin: {
        kind: 'peer',
        from: ADDRESS,
        name: 'Litch远程连接song-debian Claude报错',
        fromSession: 'local_c437',
        fromMode: 'bypass',
        body: '我这边有未提交的改动',
      },
    },
    {
      type: 'assistant',
      uuid: 'a1',
      message: {
        role: 'assistant',
        content: [
          {
            type: 'tool_use',
            id: 'toolu_1',
            name: 'SendMessage',
            input: { to: ADDRESS, summary: '回复', message: '只提交了自己的文件' },
          },
        ],
      },
    },
  ]
  const { turns } = projectNativeHistory('thread-1', messages, '/w', {
    peers: { registry: () => [] },
  })
  const items = turns.flatMap((turn) => turn.items)
  const send = items.find((item) => item.type === 'mcpToolCall')
  assert.equal(
    send?.type === 'mcpToolCall' && send.tool,
    'SendMessage Litch远程连接song-debian Claude报错',
  )
  assert.deepEqual(send?.type === 'mcpToolCall' && send.litchPeer, {
    name: 'Litch远程连接song-debian Claude报错',
    session: 'local_c437',
  })
  // 收到的那条照旧是发送方自报的
  const received = items.find((item) => item.type === 'userMessage')
  assert.deepEqual(received?.type === 'userMessage' && received.litchPeer, {
    name: 'Litch远程连接song-debian Claude报错',
    session: 'local_c437',
    mode: 'bypass',
  })
})
