// 真实设备路由上的注入、隔离与持久指令，原生上游用协议夹具。
import assert from 'node:assert/strict'
import { join } from 'node:path'
import test from 'node:test'
import { NativeBackgroundStore } from '../src/native-background-store.mjs'
import { openSessionDatabase } from '../src/session-store.mjs'
import { listenUnix } from '../src/sockets.mjs'
import { codexRig, sentTo } from './codex-kit.mjs'
import { codexThread, FakeCodex } from './fake-codex.mjs'
import { installConfig } from './fake-codex-config.mjs'
import { settle, TestClient } from './helpers.mjs'

for (const remote of [false, true])
  test(`NATIVE-WAKE-ROUTE-004 ${remote ? '远程套接字转发' : '直连'}后台插话来源只给声明连接，实时与重载一致`, async () => {
    const fake = new FakeCodex()
    fake.cliVersion = '0.166.0'
    const item = {
      id: 'native-item',
      type: 'userMessage',
      clientId: 'bg-client',
      content: [
        {
          type: 'text',
          text: '<litch-background-completed>{}</litch-background-completed>',
          text_elements: [],
        },
      ],
    }
    const stored = codexThread(99, 400, {
      status: { type: 'idle' },
      turns: [
        { id: 'original', status: 'completed', items: [item] },
        { id: 'wake', status: 'completed', items: [] },
      ],
    })
    fake.threads.push(stored)
    fake.handlers['thread/read'] = () => ({ thread: stored })
    fake.handlers['thread/resume'] = (params) =>
      params.excludeTurns
        ? {
            thread: { ...stored, turns: [] },
            initialTurnsPage: { data: stored.turns, nextCursor: null },
          }
        : { thread: stored }
    fake.handlers['thread/items/list'] = () => ({ data: [item], nextCursor: null })
    const env = codexRig({ fake })
    const socket = join(env.stateDir, 'relay.sock')
    const server = remote ? await listenUnix(socket, (wire) => env.device.attach(wire)) : null
    const db = openSessionDatabase(env.stateDir)
    new NativeBackgroundStore(db).rememberInput(stored.id, 'bg-client', 'batch')
    new NativeBackgroundStore(db).rememberTurn(stored.id, 'wake', 'idle-batch')
    try {
      const peers = await Promise.all(
        [
          ['harness', 'nativeBackgroundWake', 'backgroundTasks', 'toolImages'],
          ['harness', 'backgroundTasks'],
          ['harness'],
        ].map(async (extensions) => {
          const client = remote ? await TestClient.overSocket(socket) : env.connect()
          await client.initialize(extensions)
          await client.call('thread/resume', { threadId: stored.id })
          return client
        }),
      )
      fake.notify('item/started', { threadId: stored.id, turnId: 'original', item })
      fake.notify('item/completed', { threadId: stored.id, turnId: 'original', item })
      await settle()
      for (const [index, client] of peers.entries()) {
        const marker = index === 0 ? 'backgroundTask' : undefined
        const live = client.notifications.findLast(
          (frame: any) => frame.method === 'item/completed',
        ) as any
        assert.equal(live?.params.item.litchOrigin, marker)
        assert.equal(
          (client.notifications.findLast((frame) => frame.method === 'item/started')?.params as any)
            ?.item.litchOrigin,
          marker,
        )
        const resumed = await client.call('thread/resume', { threadId: stored.id })
        assert.equal(resumed.thread.turns[0].items[0].litchOrigin, marker)
        const paged = await client.call('thread/resume', {
          threadId: stored.id,
          excludeTurns: true,
          initialTurnsPage: { limit: 10, sortDirection: 'desc', itemsView: 'full' },
        })
        assert.equal(paged.initialTurnsPage.data[0].items[0].litchOrigin, marker)
        assert.equal(
          paged.initialTurnsPage.data[0].litchOrigin,
          undefined,
          '插话不改变普通回合来源',
        )
        assert.equal(
          paged.initialTurnsPage.data[1].litchOrigin,
          index < 2 ? 'backgroundTask' : undefined,
        )
        const history = await client.call('thread/read', {
          threadId: stored.id,
          includeTurns: true,
        })
        assert.equal(history.thread.turns[0].items[0].litchOrigin, marker)
        const turns = await client.call('thread/turns/list', { threadId: stored.id })
        assert.equal(
          turns.data.find((turn: any) => turn.id === 'original').items[0].litchOrigin,
          marker,
        )
        const items = await client.call('thread/items/list', { threadId: stored.id })
        assert.equal(items.data[0].litchOrigin, marker)
        client.close()
      }
    } finally {
      db.close()
      await server?.close()
      await env.close()
    }
  })

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
    assert.ok(!legacy.raw.some((raw) => raw.includes('litchWake') || raw.includes('nativeWake')))
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

for (const version of ['0.157.1', '0.163.0', '0.166.0']) {
  test(`NATIVE-WAKE-HINT 版本 ${version}：设置可写、工具状态、空会话与扩展隔离`, async () => {
    const fake = new FakeCodex()
    fake.cliVersion = version
    const old = codexThread(88, 400, { status: { type: 'idle' } })
    fake.threads.push(old)
    const env = codexRig({ fake })
    installConfig(fake)
    try {
      const client = env.connect()
      await client.initialize([
        'harness',
        'harnessConfig',
        'backgroundTasks',
        'nativeBackgroundWake',
      ])
      const plain = env.connect()
      await plain.initialize(['harness', 'backgroundTasks'])
      const config = await client.call('litch/harness/config/read', { harness: 'codex' })
      const spec = config.settings.find((s: any) => s.key === 'litch.backgroundWake')
      assert.equal(spec.default, true)
      assert.ok(!spec.readOnly)
      assert.match(spec.description['zh-CN'], /0.163.0/)
      assert.match(spec.description.en, /0.163.0/)
      if (version === '0.157.1') {
        assert.match(spec.description['zh-CN'], /当前 Codex 0.157.1 不支持.*设备详情升级/)
        assert.match(spec.description.en, /0.157.1 does not support/)
      }
      const { thread } = await client.call('thread/start', { harness: 'codex', cwd: '/work' })
      assert.deepEqual(thread.litchBackground.nativeWake, {
        enabled: true,
        installed: version !== '0.157.1',
        supported: version !== '0.157.1',
        version,
      })
      const resumed = await client.call('thread/resume', { threadId: old.id })
      assert.equal(resumed.thread.litchBackground.nativeWake.installed, false)
      const read = await plain.call('thread/read', { threadId: old.id, includeTurns: false })
      assert.equal(read.thread.litchBackground?.nativeWake, undefined)
      const listed = await client.call('thread/list', {})
      assert.equal(
        listed.data.find((t: any) => t.id === old.id).litchBackground.nativeWake.installed,
        false,
      )
      await client.call('litch/harness/config/write', {
        harness: 'codex',
        expectedVersion: config.version,
        edits: [{ key: 'litch.backgroundWake', value: false }],
      })
      await settle()
      assert.equal(env.device.nativeBackground.enabled('codex'), false)
      const changed = client.notifications
        .filter(
          (n: any) =>
            n.method === 'litch/thread/background/changed' && n.params.threadId === old.id,
        )
        .at(-1)
      assert.equal((changed?.params as any)?.nativeWake.enabled, false)
      const latest = await client.call('litch/harness/config/read', { harness: 'codex' })
      await client.call('litch/harness/config/write', {
        harness: 'codex',
        expectedVersion: latest.version,
        edits: [{ key: 'litch.backgroundWake', value: true }],
      })
      assert.equal(env.device.nativeBackground.enabled('codex'), true)
      if (version === '0.157.1') {
        fake.cliVersion = '0.163.0'
        for (const connection of fake.live) connection.drop()
        const updated = await client.waitFor(
          (frame: any) =>
            frame.method === 'litch/thread/background/changed' &&
            frame.params.threadId === old.id &&
            frame.params.nativeWake?.version === '0.163.0',
        )
        assert.equal((updated.params as any).nativeWake.supported, true)
        assert.equal((updated.params as any).nativeWake.installed, false, '升级不会给旧会话补工具')
      }
    } finally {
      await env.close()
    }
  })
}
