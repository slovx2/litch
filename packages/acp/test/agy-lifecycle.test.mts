import assert from 'node:assert/strict'
import { chmod, cp, mkdir, readdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'
import { AcpServer } from '../src/server.mjs'
import { client, dispose, FAKE_AGENT, isolate, text, turn } from './client.mjs'

// 官方 agy 的握手只声明 list/load/resume/close，不声明删除和归档。
const caps = {
  loadSession: true,
  sessionCapabilities: { list: {}, resume: {}, close: {} },
}

test('agy 复用并清理模型探测，账号变化、CLI 变化和缓存到期后重查', async (t) => {
  t.mock.timers.enable({ apis: ['Date'] })
  const isolated = await isolate({ CHA_ACP_AGENT: 'agy', FAKE_ACP_CAPS: JSON.stringify(caps) })
  isolated.env.CHA_AGY_CLI = isolated.env.CHA_ACP_CLI
  isolated.env.CHA_AGY_ARGS = isolated.env.CHA_ACP_ARGS
  const server = new AcpServer(isolated.home, isolated.env)
  const s = { ...isolated, server, desktop: client(server) }
  try {
    const cliDir = join(s.root, '.gemini', 'antigravity-cli')
    await mkdir(join(cliDir, 'cache'), { recursive: true })
    const auth = join(cliDir, 'cache', 'acp-auth-state.json')
    const token = join(cliDir, 'antigravity-oauth-token')
    await writeFile(token, 'fixture-existing-token')
    await writeFile(auth, '{"methodId":"oauth-personal","token":"fixture-must-not-copy"}')
    const untouched = (await readdir(join(s.root, '.gemini'))).sort()
    await s.desktop.call('initialize', { clientInfo: { name: 'test', version: '0' } })
    const { thread } = await s.desktop.call('thread/start', { cwd: s.cwd })
    const originalAgent = server.runtime.current()
    const list = async () => (await s.desktop.call('model/list')).data.map((row: any) => row.id)
    assert.deepEqual(await list(), ['fake-small', 'fake-large'])
    const newCount = async () =>
      (await s.received()).filter((message) => message.method === 'session/new').length
    const before = await newCount()
    for (let i = 0; i < 4; i++) assert.deepEqual(await list(), ['fake-small', 'fake-large'])
    assert.equal(await newCount(), before, '同一账号和 CLI 下反复打开只探测一次')
    isolated.env.FAKE_ACP_MODELS = JSON.stringify([
      { value: 'fake-large', name: '已有模型' },
      { value: 'fake-neon', name: '新模型' },
    ])
    isolated.env.FAKE_ACP_DEFAULT_MODEL = 'fake-neon'
    const newAccount = '{"methodId":"oauth-business","token":"another-fixture-must-not-copy"}'
    await writeFile(auth, newAccount)
    const [models, secondList, config, modes] = await Promise.all([
      list(),
      list(),
      s.desktop.call('config/read'),
      s.desktop.call('collaborationMode/list'),
    ])
    assert.deepEqual(
      [models, secondList],
      [
        ['fake-large', 'fake-neon'],
        ['fake-large', 'fake-neon'],
      ],
    )
    assert.equal(config.config.model, 'fake-neon')
    assert.deepEqual(
      modes.data.map((row: any) => row.mode),
      ['default', 'plan'],
    )
    assert.equal(await newCount(), before + 1, '并发查询只起一次临时会话')
    assert.ok(s.env.FAKE_ACP_LOG && s.env.FAKE_ACP_STATE)
    const fakeLog = await readFile(s.env.FAKE_ACP_LOG, 'utf8')
    const records = fakeLog
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
      .filter((line) => line.probeRecord)
    assert.equal(records.length, 2, '夹具确实向探测目录写入了本次空会话')
    assert.deepEqual(
      records.map((record) => record.auth),
      [{ methodId: 'oauth-personal' }, { methodId: 'oauth-business' }],
    )
    assert.ok(records.every((record) => record.sameToken))
    for (const { probeDir } of records) await assert.rejects(readdir(probeDir), { code: 'ENOENT' })
    assert.deepEqual((await readdir(join(s.root, '.gemini'))).sort(), untouched)
    assert.equal(await readFile(auth, 'utf8'), newAccount)
    assert.equal(await readFile(token, 'utf8'), 'fixture-existing-token')
    assert.deepEqual(Object.keys(JSON.parse(await readFile(s.env.FAKE_ACP_STATE, 'utf8'))), [
      thread.id,
    ])
    assert.equal(server.runtime.current(), originalAgent)
    assert.ok(server.thread(thread.id))
    assert.equal(
      server.latestCatalog()?.configOptions?.find((option) => option.id === 'model')?.currentValue,
      'fake-small',
    )
    assert.equal((await s.received()).filter((m) => m.method === 'session/close').length, 2)
    assert.ok(!(await s.received()).some((m) => m.method === 'session/prompt'))

    // 换掉 CLI 入口，缓存应立即失效，而不等 TTL。
    const upgraded = join(s.root, 'fake-upgraded.mjs')
    await cp(FAKE_AGENT, upgraded)
    await chmod(upgraded, 0o700)
    isolated.env.CHA_AGY_CLI = upgraded
    isolated.env.CHA_AGY_ARGS = ''
    assert.deepEqual(await list(), ['fake-large', 'fake-neon'])
    assert.equal(await newCount(), before + 2)

    // 同一种 OAuth 登录方式换账号也会更新令牌文件，使缓存失效。
    const newToken = join(cliDir, 'replacement')
    await writeFile(newToken, 'fixture-replacement-token')
    await rename(newToken, token)
    assert.deepEqual(await list(), ['fake-large', 'fake-neon'])
    assert.equal(await newCount(), before + 3)
    assert.equal(await readFile(token, 'utf8'), 'fixture-replacement-token')

    // 包装器未采用独立数据目录，不能创建任何会话。
    t.mock.timers.tick(60_000)
    isolated.env.FAKE_ACP_IGNORE_PROBE_DIR = '1'
    await assert.rejects(list(), /未在独立目录打开摘要库/)
    assert.equal(await newCount(), before + 3)
    delete isolated.env.FAKE_ACP_IGNORE_PROBE_DIR
    isolated.env.FAKE_ACP_NEW_ERROR = '1'
    await assert.rejects(list(), /catalog offline/)
    delete isolated.env.FAKE_ACP_NEW_ERROR
    assert.deepEqual(await list(), ['fake-large', 'fake-neon'])
    assert.deepEqual((await readdir(join(s.root, '.gemini'))).sort(), untouched)
  } finally {
    await dispose(s)
  }
})

test('agy 无原生删除/归档：删除拒绝，本地归档跨重启保留且可恢复', async () => {
  const isolated = await isolate({ CHA_ACP_AGENT: 'agy', FAKE_ACP_CAPS: JSON.stringify(caps) })
  isolated.env.CHA_AGY_CLI = isolated.env.CHA_ACP_CLI
  isolated.env.CHA_AGY_ARGS = isolated.env.CHA_ACP_ARGS
  const server = new AcpServer(isolated.home, isolated.env)
  const s = { ...isolated, server, desktop: client(server) }
  try {
    await s.desktop.call('initialize', { clientInfo: { name: 'test', version: '0' } })
    const info = await s.desktop.call('runtime/info')
    assert.equal(info.features.archive, true)
    assert.equal(info.features.delete, false)
    const { thread } = await s.desktop.call('thread/start', { cwd: s.cwd })
    const id = thread.id
    await turn(s, id, text('hello'))
    await assert.rejects(s.desktop.call('thread/delete', { threadId: id }), { code: -32601 })
    await s.desktop.call('thread/archive', { threadId: id })
    const ids = async (archived: boolean) =>
      (await s.desktop.call('thread/list', { archived })).data.map((row: any) => row.id)
    assert.ok(!(await ids(false)).includes(id))
    assert.ok((await ids(true)).includes(id))
    await s.server.close()
    s.server = new AcpServer(s.home, s.env)
    s.desktop = client(s.server)
    await s.desktop.call('initialize', { clientInfo: { name: 'test', version: '0' } })
    assert.ok(!(await ids(false)).includes(id))
    assert.ok((await ids(true)).includes(id))
    await s.desktop.call('thread/unarchive', { threadId: id })
    assert.ok((await ids(false)).includes(id))
    assert.ok(!(await ids(true)).includes(id))
    const messages = await s.received()
    assert.ok(
      !messages.some((message) =>
        ['session/delete', 'session/archive', 'session/unarchive'].includes(message.method),
      ),
      '不向 agent 发送它未声明的生命周期方法',
    )
  } finally {
    await dispose(s)
  }
})
