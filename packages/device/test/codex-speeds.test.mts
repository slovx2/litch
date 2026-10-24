// 原生 codex 的速度由设备进程按会话记住（protocol 包的 codex-speeds.mts）：codex 不保存速度，会话从磁盘重新装载过
// （codex 重启、没人订阅空闲久了被卸载）之后恢复只带会话号，选过的快速就没了。这里看：带了的记下来，恢复、分叉没带时补回，
// 设备进程自己的连接一样；记在 sessions.sqlite 里，设备进程重启后还在；删会话跟着删；适配器的 harness 不动。
import assert from 'node:assert/strict'
import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'
import { prepareSpeed, type SpeedStore } from '../../protocol/src/codex-speeds.mjs'
import { initializeStoreFormat } from '../../shared/src/store-format.mjs'
import {
  openSessionDatabase,
  SESSION_MIGRATIONS,
  SESSION_SCHEMA_VERSION,
  SessionStore,
} from '../src/session-store.mjs'
import { codexRig, sentTo } from './codex-kit.mjs'
import { RpcFailure } from './fake-upstream.mjs'
import { tempDir } from './helpers.mjs'

const text = (said: string) => [{ type: 'text', text: said, text_elements: [] }]

async function litch(env: ReturnType<typeof codexRig>) {
  const client = env.connect()
  await client.initialize(['harness'])
  return client
}

const last = (env: ReturnType<typeof codexRig>, method: string) => sentTo(env.codex, method).at(-1)

/** 内存里的一份，测纯函数用 */
function memory(): SpeedStore & { kept: Map<string, string> } {
  const kept = new Map<string, string>()
  return {
    kept,
    speed: (id) => kept.get(id) ?? null,
    setSpeed(id, speed) {
      if (speed === null) kept.delete(id)
      else kept.set(id, speed)
    },
  }
}

test('CODEX-SPEED-001：回合带了速度就记下；之后别的连接恢复只带会话号，转给 codex 时补上；明着带了照它的、也照它记；null 是不再记', async () => {
  const env = codexRig()
  try {
    const client = await litch(env)
    const id = (await client.call('thread/start', { harness: 'codex', cwd: '/work/a' })).thread.id
    assert.equal(env.device.sessionTree.store.speed(id), null, '没选过不记')
    // 没选过：恢复照原样转，不带速度
    await client.call('thread/resume', { threadId: id })
    assert.equal('serviceTier' in last(env, 'thread/resume'), false)

    await client.call('turn/start', { threadId: id, input: text('快点'), serviceTier: 'priority' })
    assert.equal(env.device.sessionTree.store.speed(id), 'priority')
    // 只管这一回合的不记
    await client.call('turn/start', {
      threadId: id,
      input: text('就这回'),
      serviceTierForTurn: 'flex',
    })
    assert.equal(env.device.sessionTree.store.speed(id), 'priority')

    // 桌面端重启、切走再切回来：新的连接恢复时只带会话号
    const again = await litch(env)
    await again.call('thread/resume', { threadId: id })
    assert.equal(last(env, 'thread/resume').serviceTier, 'priority')

    // 明着选了标准：照它的发，记成标准
    await again.call('thread/resume', { threadId: id, serviceTier: 'default' })
    assert.equal(last(env, 'thread/resume').serviceTier, 'default')
    assert.equal(env.device.sessionTree.store.speed(id), 'default')
    // 改会话设置带的也记
    await again.call('thread/settings/update', { threadId: id, serviceTier: 'priority' })
    assert.equal(env.device.sessionTree.store.speed(id), 'priority')
    // null 是回到配置里的默认：不再记，恢复不补
    await again.call('turn/start', { threadId: id, input: text('照默认'), serviceTier: null })
    assert.equal(env.device.sessionTree.store.speed(id), null)
    await again.call('thread/resume', { threadId: id })
    assert.equal('serviceTier' in last(env, 'thread/resume'), false)
  } finally {
    await env.close()
  }
})

test('CODEX-SPEED-002：建会话带的速度按应答里的会话号记；分叉没带时照源会话补、新会话也记一份；设备进程自己的连接一样', async () => {
  const env = codexRig()
  try {
    const client = await litch(env)
    const source = (
      await client.call('thread/start', {
        harness: 'codex',
        cwd: '/work/a',
        serviceTier: 'priority',
      })
    ).thread.id
    const store = env.device.sessionTree.store
    assert.equal(store.speed(source), 'priority')

    const fork = (await client.call('thread/fork', { threadId: source })).thread.id
    assert.equal(last(env, 'thread/fork').serviceTier, 'priority')
    assert.equal(store.speed(fork), 'priority')
    // 分叉时明着带了：照它的，新会话记它的，源会话不动
    const plain = (await client.call('thread/fork', { threadId: source, serviceTier: 'default' }))
      .thread.id
    assert.equal(last(env, 'thread/fork').serviceTier, 'default')
    assert.equal(store.speed(plain), 'default')
    assert.equal(store.speed(source), 'priority')

    // 设备进程自己的连接（会话树盯着子会话、定时任务走的那条）恢复、分叉也补
    const link = await env.device.openEngineLink('codex')
    try {
      await link.request('thread/resume', { threadId: fork })
      assert.equal(last(env, 'thread/resume').serviceTier, 'priority')
      const again = await link.request('thread/fork', { threadId: fork })
      assert.equal(store.speed(again.thread.id as string), 'priority')
      await link.request('turn/start', {
        threadId: again.thread.id,
        input: text('换标准'),
        serviceTier: 'default',
      })
      assert.equal(store.speed(again.thread.id as string), 'default')
    } finally {
      link.close()
    }

    // 删会话：记下的速度跟着删
    await client.call('thread/delete', { threadId: fork })
    assert.equal(store.speed(fork), null)
  } finally {
    await env.close()
  }
})

test('CODEX-SPEED-003：适配器的 harness 不记不补；codex 回错的不记', async () => {
  const env = codexRig()
  try {
    const client = await litch(env)
    await client.call('turn/start', { threadId: 'p1', input: text('派'), serviceTier: 'priority' })
    assert.equal(env.device.sessionTree.store.speed('p1'), null)
    await client.call('thread/resume', { threadId: 'p1' })
    const resumed = sentTo(env.pi, 'thread/resume').at(-1)
    assert.equal('serviceTier' in resumed, false)

    const id = (await client.call('thread/start', { harness: 'codex', cwd: '/work/a' })).thread.id
    env.codex.handlers['thread/settings/update'] = () => {
      throw new RpcFailure(-32602, 'bad tier')
    }
    await assert.rejects(client.call('thread/settings/update', { threadId: id, serviceTier: 'x' }))
    assert.equal(env.device.sessionTree.store.speed(id), null)
  } finally {
    await env.close()
  }
})

test('CODEX-SPEED-004：记在 sessions.sqlite 里，设备进程重启后还在；上一版的库升上来多出这张表', () => {
  const dir = tempDir()
  try {
    const old = new DatabaseSync(join(dir, 'sessions.sqlite'))
    initializeStoreFormat(old)
    for (const step of SESSION_MIGRATIONS.slice(0, -1)) old.exec(step)
    old.exec(`PRAGMA user_version=${SESSION_MIGRATIONS.length - 1}`)
    old.close()
    const first = openSessionDatabase(dir)
    assert.equal(first.prepare('PRAGMA user_version').get()?.user_version, SESSION_SCHEMA_VERSION)
    new SessionStore(first).setSpeed('t1', 'priority')
    new SessionStore(first).setSpeed('t2', 'default')
    new SessionStore(first).setSpeed('t2', null)
    first.close()
    const second = openSessionDatabase(dir)
    assert.equal(new SessionStore(second).speed('t1'), 'priority')
    assert.equal(new SessionStore(second).speed('t2'), null)
    second.close()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('CODEX-SPEED-005：不认识的方法、带了却不是字符串也不是 null 的、没有会话号的，都不动', () => {
  const store = memory()
  store.setSpeed('t1', 'priority')
  assert.equal(prepareSpeed('thread/read', { threadId: 't1' }, store), null)
  assert.equal(prepareSpeed('turn/start', { threadId: 't1', serviceTier: 3 }, store), null)
  assert.equal(prepareSpeed('thread/resume', { serviceTier: 'flex' }, store), null)
  assert.equal(prepareSpeed('thread/start', { cwd: '/w' }, store), null)
  assert.equal(prepareSpeed('thread/fork', { threadId: 't2' }, store), null)
  // 补的时候不改调用方给的那份
  const given = { threadId: 't1' }
  const prepared = prepareSpeed('thread/resume', given, store)
  assert.deepEqual(prepared?.params, { threadId: 't1', serviceTier: 'priority' })
  assert.deepEqual(given, { threadId: 't1' })
  // 应答里没有会话对象的不记
  prepareSpeed('thread/start', { serviceTier: 'flex' }, store)?.remember({})
  assert.deepEqual([...store.kept], [['t1', 'priority']])
})
