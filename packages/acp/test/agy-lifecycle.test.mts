import assert from 'node:assert/strict'
import test from 'node:test'
import { AcpServer } from '../src/server.mjs'
import { client, dispose, isolate, text, turn } from './client.mjs'

// 官方 agy 的握手只声明 list/load/resume/close，不声明删除和归档。
const caps = {
  loadSession: true,
  sessionCapabilities: { list: {}, resume: {}, close: {} },
}

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
