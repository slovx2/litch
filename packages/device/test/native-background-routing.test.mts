// 真实设备路由上的注入、隔离与持久指令，原生上游用协议夹具。
import assert from 'node:assert/strict'
import test from 'node:test'
import { codexRig, sentTo } from './codex-kit.mjs'
import { codexThread, FakeCodex } from './fake-codex.mjs'
import { installConfig } from './fake-codex-config.mjs'
import { settle } from './helpers.mjs'

test('NATIVE-WAKE-ROUTE-001 仅新声明连接的新建原生会话注入，恢复补规则，配置关闭不动原生配置', async () => {
  const fake = new FakeCodex()
  fake.cliVersion = '0.163.0'
  const env = codexRig({ fake })
  installConfig(fake)
  try {
    const client = env.connect()
    await client.initialize(['harness', 'backgroundTasks', 'nativeBackgroundWake', 'harnessConfig'])
    const plain = env.connect()
    await plain.initialize(['harness', 'backgroundTasks'])
    const { thread } = await client.call('thread/start', { harness: 'codex', cwd: '/work' })
    const created = sentTo(fake, 'thread/start').at(-1)
    assert.ok(created.dynamicTools.some((t: any) => t.name === 'litch_background'))
    assert.match(created.developerInstructions, /explicit delegation is the exception/)
    assert.equal(
      created.dynamicTools.find((t: any) => t.name === 'litch_background').instructions,
      undefined,
    )
    await client.call('thread/resume', { threadId: thread.id })
    assert.match(
      sentTo(fake, 'thread/resume').at(-1).developerInstructions,
      /explicit delegation is the exception/,
    )
    await plain.call('thread/start', { harness: 'codex', cwd: '/work' })
    assert.ok(
      !sentTo(fake, 'thread/start')
        .at(-1)
        .dynamicTools?.some((t: any) => t.name === 'litch_background'),
    )
    const config = await client.call('litch/harness/config/read', { harness: 'codex' })
    assert.equal(config.settings.find((s: any) => s.key === 'litch.backgroundWake')?.default, true)
    await client.call('litch/harness/config/write', {
      harness: 'codex',
      expectedVersion: config.version,
      edits: [{ key: 'litch.backgroundWake', value: false }],
    })
    assert.equal(env.device.nativeBackground.enabled('codex'), false)
    assert.ok(!JSON.stringify(sentTo(fake, 'config/batchWrite')).includes('litch.backgroundWake'))
    await client.call('thread/start', { harness: 'codex', cwd: '/work' })
    assert.ok(
      !sentTo(fake, 'thread/start')
        .at(-1)
        .dynamicTools?.some((t: any) => t.name === 'litch_background'),
    )
  } finally {
    await env.close()
  }
})

test('NATIVE-WAKE-ROUTE-002 多连接重复工具只登记一次；新字段仅给新声明连接', async () => {
  const fake = new FakeCodex()
  fake.cliVersion = '0.163.0'
  const stored = codexThread(99, 400, { status: { type: 'idle' } })
  fake.threads.push(stored)
  fake.handlers['thread/start'] = () => ({ thread: stored })
  const env = codexRig({ fake })
  try {
    const client = env.connect()
    await client.initialize(['harness', 'backgroundTasks', 'nativeBackgroundWake'])
    const legacy = env.connect()
    await legacy.initialize(['harness', 'backgroundTasks'])
    const plain = env.connect()
    await plain.initialize(['harness'])
    const { thread } = await client.call('thread/start', { harness: 'codex', cwd: '/work' })
    fake.handlers['thread/backgroundTerminals/list'] = () => ({
      data: [{ itemId: 'cmd', processId: '123' }],
    })
    fake.notify('item/started', {
      threadId: thread.id,
      turnId: 'first',
      item: {
        type: 'commandExecution',
        id: 'cmd',
        command: 'test',
        processId: '123',
        status: 'inProgress',
      },
    })
    await settle()
    for (const link of fake.live)
      link.send({
        id: 888,
        method: 'item/tool/call',
        params: {
          threadId: thread.id,
          turnId: 'first',
          callId: 'watch-once',
          namespace: 'litch_background',
          tool: 'watch',
          arguments: { session_id: '123', purpose: 'read test result' },
        },
      })
    await client.waitFor(
      (frame: any) =>
        frame.method === 'litch/thread/background/changed' &&
        frame.params.tasks.some((t: any) => t.litchWake === 'watching'),
    )
    const now = await client.call('thread/read', { threadId: thread.id, includeTurns: true })
    assert.equal(now.thread.litchBackground.tasks.filter((t: any) => t.litchWake).length, 1)
    const old = await legacy.call('thread/read', { threadId: thread.id, includeTurns: true })
    assert.ok(!JSON.stringify(old).includes('litchWake'))
    assert.ok(!legacy.raw.some((raw) => raw.includes('litchWake')))
    assert.ok(!plain.raw.some((raw) => raw.includes('litchBackground')))
    assert.equal(client.requests.filter((f) => f.method === 'item/tool/call').length, 0)
  } finally {
    await env.close()
  }
})

test('NATIVE-WAKE-ROUTE-003 不满足协议下限的原生 Codex 不注入', async () => {
  const env = codexRig()
  try {
    const client = env.connect()
    await client.initialize(['harness', 'nativeBackgroundWake'])
    await client.call('thread/start', { harness: 'codex', cwd: '/work' })
    assert.ok(
      !sentTo(env.codex, 'thread/start')
        .at(-1)
        .dynamicTools?.some((t: any) => t.name === 'litch_background'),
    )
  } finally {
    await env.close()
  }
})
