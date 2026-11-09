// 模拟完全访问会话，通过正式工具宿主验证不会冻结或挂等待卡。
import assert from 'node:assert/strict'
import test from 'node:test'
import { createClientToolHost } from '../../client-tools/host.mjs'
import {
  CLIENT_TOOL,
  type ClientToolInvocation,
  type ClientToolToCore,
} from '../../client-tools/types.mjs'

const invocation = (
  fullAccess: boolean,
  kind: 'local' | 'ssh' = 'local',
): ClientToolInvocation => ({
  fullAccess,
  id: 'call',
  threadId: 'session',
  turnId: 'turn',
  callId: 'tool',
  namespace: 'litch_browser',
  tool: 'request_sign_in',
  arguments: { reason: '上传应用', origin: 'https://appstoreconnect.apple.com' },
  device: { id: kind, kind, name: kind, target: kind === 'ssh' ? 'fixture' : null },
  harness: 'codex',
  cwd: null,
})
const settle = async () => {
  for (let i = 0; i < 8; i++) await Promise.resolve()
}

for (const kind of ['local', 'ssh'] as const)
  test(`完全访问 ${kind} 登录立即返回，执行器不冻结标签；后续工具仍可运行`, async () => {
    const sent: ClientToolToCore[] = []
    let executed = 0
    let notices = 0
    const host = createClientToolHost(
      [
        {
          namespace: 'litch_browser',
          call: async () => {
            executed++
            return { success: true, contentItems: [] }
          },
        },
      ],
      (message) => sent.push(message),
      () => {},
      () => {
        notices++
      },
    )
    host.handle({ type: CLIENT_TOOL, op: 'call', invocation: invocation(true, kind) })
    await settle()
    assert.equal(executed, 0)
    assert.equal(notices, 1)
    assert.equal(sent.length, 1)
    const result = sent[0]
    assert.equal(result?.op, 'result')
    if (result?.op === 'result') {
      assert.equal(result.response.success, false)
      assert.match(JSON.stringify(result.response), /not been completed/)
      assert.match(JSON.stringify(result.response), /API/)
    }
    host.handle({
      type: CLIENT_TOOL,
      op: 'call',
      invocation: { ...invocation(true, kind), id: 'next', tool: 'snapshot' },
    })
    await settle()
    assert.equal(executed, 1)
    assert.equal(sent.filter((m) => m.op === 'ask' || m.op === 'hold').length, 0)
    host.reset()
  })

test('完全访问网站和下载只允许本次', async () => {
  const sent: ClientToolToCore[] = []
  const host = createClientToolHost(
    [
      {
        namespace: 'litch_browser',
        call: async (_call, context) => {
          assert.equal(
            await context.ask({
              kind: 'site',
              origin: 'https://example.com',
              url: 'https://example.com',
            }),
            'once',
          )
          const download = await new Promise((resolve) =>
            context.show?.(
              {
                kind: 'browserDownload',
                filename: 'fixture.txt',
                origin: 'https://example.com',
                totalBytes: 5,
              },
              resolve,
            ),
          )
          assert.equal(download, 'once')
          return { success: true, contentItems: [] }
        },
      },
    ],
    (message) => sent.push(message),
  )
  host.handle({
    type: CLIENT_TOOL,
    op: 'call',
    invocation: { ...invocation(true), tool: 'downloads' },
  })
  await settle()
  assert.deepEqual(
    sent.map((message) => message.op),
    ['result'],
  )
  host.reset()
})

test('非完全访问保留原登录卡片等待', async () => {
  const sent: ClientToolToCore[] = []
  const host = createClientToolHost(
    [
      {
        namespace: 'litch_browser',
        call: async (_call, context) => {
          await context.ask({ kind: 'chromeSignIn', origin: 'https://example.com', reason: '登录' })
          return { success: true, contentItems: [] }
        },
      },
    ],
    (message) => sent.push(message),
  )
  host.handle({ type: CLIENT_TOOL, op: 'call', invocation: invocation(false) })
  await settle()
  assert.deepEqual(
    sent.map((message) => message.op),
    ['ask'],
  )
  const ask = sent[0]
  assert.ok(ask?.op === 'ask')
  host.handle({ type: CLIENT_TOOL, op: 'answer', askId: ask.askId, answer: 'decline' })
  await settle()
  assert.ok(sent.some((message) => message.op === 'result'))
  host.reset()
})

for (const showing of [false, true])
  test(`完全访问不改变 Computer Use 自身审批（show=${showing}）`, async () => {
    const sent: ClientToolToCore[] = []
    const host = createClientToolHost(
      [
        {
          namespace: 'litch_computer',
          call: async (_call, context) => {
            const ask = {
              kind: 'computerSelf' as const,
              id: 'self',
              nonce: 'nonce',
              desktopId: null,
            }
            const answer = showing
              ? await new Promise((resolve) => context.show?.(ask, resolve))
              : await context.ask(ask)
            assert.equal(answer, 'once')
            return { success: true, contentItems: [] }
          },
        },
      ],
      (message) => sent.push(message),
    )
    host.handle({
      type: CLIENT_TOOL,
      op: 'call',
      invocation: { ...invocation(true), namespace: 'litch_computer', tool: 'get_app_state' },
    })
    await settle()
    assert.deepEqual(
      sent.map((message) => message.op),
      ['ask'],
    )
    const ask = sent[0]
    assert.ok(ask?.op === 'ask')
    host.handle({ type: CLIENT_TOOL, op: 'answer', askId: ask.askId, answer: 'once' })
    await settle()
    assert.ok(sent.some((message) => message.op === 'result'))
    host.reset()
  })
