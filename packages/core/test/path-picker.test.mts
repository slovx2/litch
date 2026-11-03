import assert from 'node:assert/strict'
import test from 'node:test'
import type { PathPickerListing } from '../../protocol/src/path-picker.mjs'
import type { CoreChannel } from '../src/channel/client.mjs'
import type { ChannelError } from '../src/channel/protocol.mjs'
import { RpcError } from '../src/connection/rpc.mjs'
import { createPathPicker } from '../src/device/path-picker.mjs'
import {
  pathPickerChild,
  pathPickerDirectory,
  pathPickerStart,
  readPathPicker,
} from '../src/path-picker.mjs'
import { fakeDevice, harness } from './fake-device.mjs'
import { settle } from './helpers.mjs'
import { setup } from './world.mjs'

const listing: PathPickerListing = {
  path: '/remote/home',
  parent: '/remote',
  total: 3,
  truncated: false,
  entries: [
    { name: 'project', kind: 'dir', targetKind: 'dir', executable: null },
    { name: 'tool', kind: 'link', targetKind: 'file', executable: true },
    { name: 'notes', kind: 'file', targetKind: 'file', executable: false },
  ],
}
test('路径选择使用独立设备接口，home 原样交给设备；不调用文件内容接口', async () => {
  const calls: unknown[] = []
  const browser = createPathPicker({
    online: () => true,
    supported: () => true,
    request: async (params) => {
      calls.push(params)
      return listing
    },
    fail: (error) => error as ChannelError,
  })
  const channel = {
    command: async (method: string, params: { deviceId: string; path: string | null }) => {
      assert.equal(method, 'paths.list')
      assert.equal(params.deviceId, 'remote')
      return browser.list(params.path)
    },
  } as Pick<CoreChannel, 'command'>
  assert.deepEqual(
    (await readPathPicker(channel, 'remote', 'directory', '~/project')).entries.map(
      (entry) => entry.name,
    ),
    ['project'],
  )
  assert.deepEqual(calls, [{ path: '~/project' }])
  assert.equal((await readPathPicker(channel, 'remote', 'file', null)).entries.length, 3)
  const link = listing.entries[1]
  assert.ok(link)
  assert.equal(pathPickerDirectory(link), false)
  assert.equal(pathPickerStart('C:\\bin\\tool.exe', 'file'), 'C:/bin')
  assert.equal(pathPickerStart('~/project', 'directory'), '~/project')
  assert.equal(pathPickerChild('/', 'etc'), '/etc')
  assert.equal(pathPickerChild('C:\\tools', 'agent.exe'), 'C:/tools/agent.exe')
})
test('旧设备不发未知请求，明确保留手填；宣告后仍返回方法不存在时也正确提示', async () => {
  let supported = false
  let calls = 0
  const browser = createPathPicker({
    online: () => true,
    supported: () => supported,
    request: async () => {
      calls++
      throw new RpcError(-32601, 'Unknown method')
    },
    fail: (error) => error as ChannelError,
  })
  const rejected = (error: ChannelError) => {
    assert.equal(error.code, 'unsupported')
    assert.match(error.said?.['zh-CN'] ?? '', /版本较旧.*手动填写.*升级/)
    return true
  }
  await assert.rejects(browser.list(null), rejected)
  assert.equal(calls, 0)
  supported = true
  await assert.rejects(browser.list(null), rejected)
  assert.equal(calls, 1)
})

test('真实核心命令经设备连接请求新扩展，旧设备仍可手填且不发送请求', async () => {
  for (const supported of [true, false]) {
    const fake = fakeDevice([harness('pi')])
    if (supported) fake.device.extensions.push('devicePaths')
    const w = setup([], { ...fake.handlers, 'litch/paths/list': () => listing })
    w.core.start()
    await settle()
    await settle()
    if (supported) {
      assert.deepEqual(await w.command('paths.list', { deviceId: 'local', path: '~/bin' }), listing)
      assert.deepEqual(w.sent('litch/paths/list'), [{ path: '~/bin' }])
    } else {
      await assert.rejects(w.command('paths.list', { deviceId: 'local', path: null }), {
        code: 'unsupported',
      })
      assert.equal(w.sent('litch/paths/list').length, 0)
    }
  }
})
