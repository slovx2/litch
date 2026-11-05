import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createCore } from '../src/index.mjs'
import { fakeOpener } from './fake-server.mjs'
import { fakeClock } from './helpers.mjs'

for (const kind of ['local', 'ssh'] as const) {
  test(`本机路径按核心设备配置判断：${kind}，不以设备 ID 或同名路径推断`, async () => {
    const core = createCore({
      clock: fakeClock().clock,
      version: 'test',
      devices: [
        {
          id: 'local',
          kind,
          name: '同名设备',
          host: '',
          target: null,
          wire: 'green',
          open: fakeOpener({}).open,
        },
      ],
    })
    const source = { deviceId: 'local', root: '/work', path: '/work/file.txt' }
    const command = (value: typeof source) =>
      core.command('files.localSource', value, new AbortController().signal)
    try {
      assert.deepEqual(await command(source), kind === 'local' ? source : null)
      await assert.rejects(command({ ...source, deviceId: 'unknown' }))
      if (kind === 'local') {
        for (const path of [
          '/elsewhere/file',
          '/work/../outside',
          'https://example.org',
          '/work/a\0b',
          '//server/share',
        ])
          await assert.rejects(command({ ...source, path }), path)
        await assert.rejects(command({ ...source, root: 'relative' }))
        assert.deepEqual(await command({ ...source, path: '/work/dir/../file.txt' }), source)
      }
    } finally {
      core.stop()
    }
  })
}
