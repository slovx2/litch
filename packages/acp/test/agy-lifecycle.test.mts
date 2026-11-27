import assert from 'node:assert/strict'
import test from 'node:test'
import { AcpServer } from '../src/server.mjs'
import { client, dispose, isolate, text, turn } from './client.mjs'

// 官方 agy 的握手只声明 list/load/resume/close，不声明删除和归档。
const caps = {
  loadSession: true,
  sessionCapabilities: { list: {}, resume: {}, close: {} },
}

test('agy 新建页读取当前 CLI 的模型；旧会话目录和探测失败都不污染结果', async () => {
  const isolated = await isolate({ CHA_ACP_AGENT: 'agy', FAKE_ACP_CAPS: JSON.stringify(caps) })
  isolated.env.CHA_AGY_CLI = isolated.env.CHA_ACP_CLI
  isolated.env.CHA_AGY_ARGS = isolated.env.CHA_ACP_ARGS
  const server = new AcpServer(isolated.home, isolated.env)
  const s = { ...isolated, server, desktop: client(server) }
  try {
    await s.desktop.call('initialize', { clientInfo: { name: 'test', version: '0' } })
    const { thread } = await s.desktop.call('thread/start', { cwd: s.cwd })
    const originalAgent = server.runtime.current()
    const list = async () => (await s.desktop.call('model/list')).data.map((row: any) => row.id)
    assert.deepEqual(await list(), ['fake-small', 'fake-large'])
    const newCount = async () =>
      (await s.received()).filter((message) => message.method === 'session/new').length
    const before = await newCount()
    isolated.env.FAKE_ACP_MODELS = JSON.stringify([
      { value: 'fake-large', name: '已有模型' },
      { value: 'fake-neon', name: '新模型' },
    ])
    isolated.env.FAKE_ACP_DEFAULT_MODEL = 'fake-neon'
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
    assert.equal(server.runtime.current(), originalAgent)
    assert.ok(server.thread(thread.id))
    assert.equal(
      server.latestCatalog()?.configOptions?.find((option) => option.id === 'model')?.currentValue,
      'fake-small',
    )
    assert.equal((await s.received()).filter((m) => m.method === 'session/close').length, 2)
    assert.ok(!(await s.received()).some((m) => m.method === 'session/prompt'))

    isolated.env.FAKE_ACP_NEW_ERROR = '1'
    await assert.rejects(list(), /catalog offline/)
    delete isolated.env.FAKE_ACP_NEW_ERROR
    assert.deepEqual(await list(), ['fake-large', 'fake-neon'])
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
