import assert from 'node:assert/strict'
import { generateKeyPairSync, sign } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { approvalSignedText } from '../../../../../packages/protocol/src/client-approvals.mjs'
import { TrustedPhones } from '../../approvals/store.mjs'
import { installPhoneApprovals, PhoneApprovals } from '../../approvals/verify.mjs'
import type {
  ClientToolAnswer,
  ClientToolAsk,
  ClientToolContext,
  ClientToolInvocation,
} from '../../client-tools/types.mjs'
import { createComputerExecutor, type HelperAccess } from '../executor.mjs'
import { ComputerSelfGuard } from '../self-guard.mjs'

function invocation(
  tool = 'click',
  app = 'Litch',
  threadId = 'a',
  deviceId = 'local',
): ClientToolInvocation {
  return {
    id: 'call',
    callId: 'call',
    threadId,
    turnId: 'turn',
    namespace: 'litch_computer',
    tool,
    arguments: { app, x: 10, y: 10 },
    harness: 'codex',
    cwd: null,
    device: {
      id: deviceId,
      name: deviceId,
      kind: deviceId === 'local' ? 'local' : 'ssh',
      target: null,
    },
  }
}
function fixture(
  guard = new ComputerSelfGuard(),
  protectedTarget = (app: unknown) => app !== 'TextEdit',
) {
  const calls: { method: string; params: Record<string, unknown> }[] = []
  const asks: ClientToolAsk[] = []
  let answer: ClientToolAnswer | null = 'once'
  const client = {
    async request(method: string, params: Record<string, unknown> = {}) {
      calls.push({ method, params })
      if (method === 'inspectTarget') return { self: protectedTarget(params.app), pid: 42 }
      if (method === 'permissions') return { accessibility: true, screenRecording: true }
      if (method === 'listApps') return { apps: [] }
      if (method === 'getAppState')
        return {
          app: { name: 'Litch', bundleId: 'io.github.slovx2.litch' },
          window: { title: 'test' },
          screenshot: { width: 10, height: 10, mime: 'image/png', data: '' },
          text: 'state',
          diff: false,
        }
      return { text: 'done' }
    },
  }
  const helper: HelperAccess = {
    client: async () => client,
    connected: client,
    restart: async () => {},
  }
  const context: ClientToolContext = {
    signal: new AbortController().signal,
    ask: async (ask) => {
      asks.push(ask)
      return answer
    },
  }
  const executor = createComputerExecutor({ helper, selfGuard: guard })
  return {
    guard,
    executor,
    context,
    calls,
    asks,
    setAnswer: (value: ClientToolAnswer | null) => {
      answer = value
    },
    run: (call = invocation()) => executor.call(call, context),
    inputs: () =>
      calls.filter((call) =>
        [
          'click',
          'typeText',
          'pressKey',
          'scroll',
          'setValue',
          'drag',
          'selectText',
          'getAppState',
        ].includes(call.method),
      ),
  }
}

test('自身每种输入与观察都先问；拒绝不读窗口不发送输入，非自身和清单不问', async () => {
  const f = fixture()
  f.setAnswer('decline')
  for (const tool of [
    'click',
    'type_text',
    'press_key',
    'scroll',
    'set_value',
    'drag',
    'select_text',
    'get_app_state',
  ]) {
    const result = await f.run(invocation(tool))
    assert.equal(result.success, false)
    assert.match(JSON.stringify(result), /not approved.*Do not use another/)
  }
  assert.equal(f.asks.length, 8)
  assert.equal(f.inputs().length, 0)
  assert.equal((await f.run(invocation('click', 'TextEdit'))).success, true)
  assert.equal((await f.run(invocation('list_apps'))).success, true)
  assert.equal(f.asks.length, 8)
})

test('本次只覆盖一调用；本对话跨回合保留但不同设备或会话仍问', async () => {
  const f = fixture()
  await f.run()
  await f.run()
  assert.equal(f.asks.length, 2)
  f.setAnswer('session')
  await f.run()
  f.executor.turnEnded?.({ deviceId: 'local', threadId: 'a', turnId: 'turn' })
  await f.run({ ...invocation(), turnId: 'next' })
  assert.equal(f.asks.length, 3)
  await f.run(invocation('click', 'Litch', 'b'))
  await f.run(invocation('click', 'Litch', 'a', 'ssh-other'))
  assert.equal(f.asks.length, 5)
})

test('24 小时授权跨会话和来源设备并持久化；到期和撤销失效', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'litch-self-'))
  let now = 1000
  const file = join(directory, 'approval.json')
  try {
    const f = fixture(new ComputerSelfGuard(file, () => now))
    f.setAnswer('always')
    await f.run()
    const expiresAt = now + 86_400_000
    assert.equal(f.guard.expiresAt(), expiresAt)
    assert.equal(JSON.parse(readFileSync(file, 'utf8')).expiresAt, expiresAt)
    const restored = fixture(new ComputerSelfGuard(file, () => now))
    await restored.run(invocation('click', 'Litch', 'b', 'remote'))
    assert.equal(restored.asks.length, 0)
    now = expiresAt
    assert.equal(restored.guard.expiresAt(), null)
    await restored.run()
    assert.equal(restored.asks.length, 1)
    restored.setAnswer('session')
    await restored.run()
    restored.guard.revoke()
    restored.setAnswer('decline')
    assert.equal((await restored.run()).success, false)
    assert.equal(new ComputerSelfGuard(file, () => now).expiresAt(), null)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('混合批次先问再执行任意动作；一次授权覆盖各步及最终观察', async () => {
  const f = fixture()
  const batch = {
    ...invocation('run_actions'),
    arguments: {
      actions: [
        { tool: 'click', arguments: { app: 'TextEdit', x: 1, y: 1 } },
        { tool: 'click', arguments: { app: 'Litch', x: 2, y: 2 } },
      ],
    },
  }
  f.setAnswer('decline')
  assert.equal((await f.run(batch)).success, false)
  assert.equal(f.inputs().length, 0)
  f.setAnswer('once')
  assert.equal((await f.run(batch)).success, true)
  assert.equal(f.asks.length, 2)
  assert.deepEqual(
    f.inputs().map((call) => call.params.selfAllowed),
    [false, true, true],
  )
})

test('远程路径同样拦截，模型不能注入内部授权和进程标识', async () => {
  const f = fixture()
  f.setAnswer('decline')
  const call = invocation('click', 'Litch', 'remote-thread', 'ssh')
  call.arguments = { app: 'Litch', selfAllowed: true, hostPid: 999, targetPid: 999 }
  assert.equal((await f.run(call)).success, false)
  assert.equal(f.inputs().length, 0)
  f.setAnswer('once')
  assert.equal((await f.run(call)).success, true)
  assert.equal(f.calls.find((item) => item.method === 'inspectTarget')?.params.hostPid, undefined)
  assert.equal(f.inputs()[0]?.params.targetPid, 42)
})

test('取消或撤销等待中的卡片后，迟到批准不产生授权或输入', async () => {
  for (const cancel of [true, false]) {
    const f = fixture()
    const controller = new AbortController()
    let resolve: (value: ClientToolAnswer) => void = () => {}
    const asked = new Promise<void>((ready) => {
      f.context.ask = () => {
        ready()
        return new Promise((answer) => {
          resolve = answer
        })
      }
    })
    f.context.signal = controller.signal
    const running = f.run()
    await asked
    if (cancel) controller.abort()
    else f.guard.revoke()
    resolve('always')
    assert.equal((await running).success, false)
    assert.equal(f.inputs().length, 0)
    assert.equal(f.guard.expiresAt(), null)
  }
})

test('并发会话的本次许可不互相共享', async () => {
  const f = fixture()
  const [yes, no] = await Promise.all([
    f.executor.call(invocation('click', 'Litch', 'a'), { ...f.context, ask: async () => 'once' }),
    f.executor.call(invocation('click', 'Litch', 'b'), {
      ...f.context,
      ask: async () => 'decline',
    }),
  ])
  assert.equal(yes.success, true)
  assert.equal(no.success, false)
  assert.equal(f.inputs().length, 1)
})

test('无效批次不发卡；预检后目标变成自身则停批，不在动作中途追加审批', async () => {
  const invalid = fixture()
  await invalid.run({
    ...invocation('run_actions'),
    arguments: {
      actions: [
        { tool: 'click', arguments: { app: 'Litch' } },
        { tool: 'get_app_state', arguments: { app: 'Litch' } },
      ],
    },
  })
  assert.equal(invalid.asks.length, 0)
  assert.equal(invalid.inputs().length, 0)
  let inspections = 0
  const changed = fixture(new ComputerSelfGuard(), (app) => ++inspections > 2 && app === 'Litch')
  const result = await changed.run({
    ...invocation('run_actions'),
    arguments: {
      actions: [
        { tool: 'click', arguments: { app: 'TextEdit', x: 1, y: 1 } },
        { tool: 'click', arguments: { app: 'Litch', x: 1, y: 1 } },
      ],
    },
  })
  assert.equal(result.success, false)
  assert.match(JSON.stringify(result), /target changed to Litch/)
  assert.equal(changed.asks.length, 0)
  assert.equal(changed.inputs().length, 1)
})

test('手机的签名覆盖档位；伪造或提升档位不放行，正确签名完成后撤卡', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'litch-self-phone-'))
  const phones = new PhoneApprovals({ store: new TrustedPhones(join(directory, 'phones.json')) })
  phones.setEnabled(true)
  installPhoneApprovals(phones)
  try {
    const f = fixture()
    const pair = generateKeyPairSync('ed25519')
    let shown: Extract<ClientToolAsk, { kind: 'computerSelf' }> | undefined
    let retracted = false
    let ready: () => void = () => {}
    const displayed = new Promise<void>((resolve) => {
      ready = resolve
    })
    f.context.show = (ask) => {
      assert.equal(ask.kind, 'computerSelf')
      shown = ask as typeof shown
      ready()
      return () => {
        retracted = true
      }
    }
    const running = f.run(invocation('get_app_state'))
    await displayed
    assert.ok(shown?.desktopId)
    const publicKey = pair.publicKey
      .export({ type: 'spki', format: 'der' })
      .subarray(-32)
      .toString('base64')
    const answer = {
      id: shown.id,
      ref: 'once',
      decision: 'approve' as const,
      remember: false,
      phoneId: 'f83898df0bef57a4',
      approvalKey: publicKey,
      signature: sign(
        null,
        Buffer.from(
          approvalSignedText(
            { ...shown, desktopId: shown.desktopId, origin: 'litch://computer-self' },
            {
              ref: 'once',
              decision: 'approve',
              remember: false,
              phoneId: 'f83898df0bef57a4',
            },
          ),
        ),
        pair.privateKey,
      ).toString('base64'),
    }
    f.executor.phoneAnswer?.({ ...answer, ref: 'always' })
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(f.inputs().length, 0)
    assert.equal(retracted, false)
    f.executor.phoneAnswer?.(answer)
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(f.inputs().length, 0, '首次信任不能用于自身授权')
    phones.trustFromPairing({
      phoneId: answer.phoneId,
      name: 'test phone',
      approvalKey: publicKey,
      deviceId: 'local',
    })
    f.executor.phoneAnswer?.(answer)
    assert.equal((await running).success, true)
    assert.equal(retracted, true)
    assert.equal(f.guard.expiresAt(), null)
    assert.equal(f.inputs().length, 1)
    f.executor.phoneAnswer?.({ ...answer, ref: 'always' })
    assert.equal(f.guard.expiresAt(), null)
  } finally {
    installPhoneApprovals(null)
    rmSync(directory, { recursive: true, force: true })
  }
})
