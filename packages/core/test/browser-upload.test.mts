import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createToolCalls } from '../src/device/tool-calls.mjs'
import { CLIENT_TOOL, type ToolToCore, type ToolToMain } from '../src/model-client-tools.mjs'
import { createToolHub } from '../src/tool-hub.mjs'
import { fakeClock, settle } from './helpers.mjs'

test('上传反向 IPC 只读活跃调用绑定设备和原始路径，取消后忽略晚到结果', async () => {
  const sent: ToolToMain[] = []
  let receive!: (message: ToolToCore) => void
  const hub = createToolHub(
    {
      namespaces: () => ['litch_browser'],
      post: (message) => {
        sent.push(message)
      },
      listen: (handler) => {
        receive = handler
      },
    },
    () => {},
  )
  const reads: { device: string; path: string }[] = []
  let finishRead: (() => void) | undefined
  const make = (device: string) =>
    createToolCalls({
      deviceId: device,
      clock: fakeClock().clock,
      hub,
      device: () => ({ id: device, name: device, kind: 'ssh', target: null }),
      allowed: () => true,
      context: () => ({ harness: null, cwd: null }),
      showAsk: () => () => {},
      log() {},
      async uploadRead(params) {
        reads.push({ device, path: params.path })
        if (params.path === '/slow')
          await new Promise<void>((resolve) => {
            finishRead = resolve
          })
        return { size: 4, version: device, mtimeMs: 0 }
      },
    })
  const a = make('a')
  const b = make('b')
  const call = (calls: ReturnType<typeof make>, tool: string, paths: string[]) =>
    calls.serverRequest(
      'item/tool/call',
      {
        namespace: 'litch_browser',
        tool,
        arguments: { paths },
        threadId: 'thread',
        turnId: 'turn',
        callId: 'c',
      },
      'rpc',
    )!
  const pa = call(a, 'upload', ['/same', '/slow'])
  const pb = call(b, 'upload', ['/same'])
  const invocations = sent.filter((message) => message.op === 'call')
  assert.equal(invocations.length, 2)
  const ia = invocations[0]!.invocation.id
  const ib = invocations[1]!.invocation.id
  const request = (id: string, requestId: string, path: string) =>
    receive({
      type: CLIENT_TOOL,
      op: 'uploadRead',
      id,
      requestId,
      params: { action: 'stat', path },
    })
  request(ia, 'a-same', '/same')
  request(ib, 'b-same', '/same')
  request(ia, 'wrong', '/desktop-secret')
  await settle()
  const replies = sent.filter((message) => message.op === 'uploadReadResult')
  assert.equal(replies.find((message) => message.requestId === 'a-same')?.result?.version, 'a')
  assert.equal(replies.find((message) => message.requestId === 'b-same')?.result?.version, 'b')
  assert.match(
    replies.find((message) => message.requestId === 'wrong')?.error ?? '',
    /not authorized/,
  )
  assert.deepEqual(reads, [
    { device: 'a', path: '/same' },
    { device: 'b', path: '/same' },
  ])
  request(ia, 'late', '/slow')
  a.offline()
  await pa
  finishRead?.()
  request(ia, 'after-cancel', '/same')
  await settle()
  assert.equal(
    sent.some(
      (message) =>
        message.op === 'uploadReadResult' && ['late', 'after-cancel'].includes(message.requestId),
    ),
    false,
  )
  b.offline()
  await pb
  const wrongTool = call(a, 'evaluate', ['/same'])
  const last = sent.filter((message) => message.op === 'call').at(-1)!
  request(last.invocation.id, 'wrong-tool', '/same')
  await settle()
  const denied = sent.find(
    (message) => message.op === 'uploadReadResult' && message.requestId === 'wrong-tool',
  )
  assert.ok(denied?.op === 'uploadReadResult')
  assert.match(denied.error ?? '', /not authorized/)
  a.offline()
  await wrongTool
})
