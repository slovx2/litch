import assert from 'node:assert/strict'
import test from 'node:test'
import type {
  DeviceSettingsReadResponse,
  DeviceSettingsWriteParams,
  DeviceSettingsWriteResponse,
} from '../../protocol/src/device-settings.mjs'
import { migrateToolSettings, toolSettingEdits } from '../src/device/tool-settings.mjs'
import { fakeToolSettings } from './fake-tool-settings.mjs'

function migration() {
  const fake = fakeToolSettings(['pi', 'claude-code'])
  const read = () => fake.handlers['litch/device/settings/read']!({}) as DeviceSettingsReadResponse
  const write = async (params: DeviceSettingsWriteParams) =>
    fake.handlers['litch/device/settings/write']!(params) as DeviceSettingsWriteResponse
  let cleared = 0
  return { ...fake, read, write, clear: () => cleared++, cleared: () => cleared }
}

test('迁移：保留已开启 CU 和 harness 覆盖，确认写入后删除本地旧列', async () => {
  const m = migration()
  const next = await migrateToolSettings(
    m.read(),
    {
      browser: false,
      computer: true,
      machine: true,
      harnesses: { pi: { browser: true, computer: false } },
    },
    m.write,
    m.clear,
  )
  assert.equal(next.snapshot.values['tools.computer'], true)
  assert.equal(next.snapshot.values['harness.pi.computer'], false)
  assert.equal(next.snapshot.values['harness.claude-code.computer'], true)
  assert.equal(m.cleared(), 1)
  assert.equal(m.settings.writes[0]?.edits.length, 5)
  assert.equal(next.snapshot.values['tools.machine'], true)
})

test('迁移：设备已写过的整列优先；不同桌面不会覆盖现值，无旧值时不写默认', async () => {
  const m = migration()
  await m.write({ expectedVersion: 3, edits: [{ key: 'harness.pi.computer', value: false }] })
  await migrateToolSettings(m.read(), { computer: true, browser: false }, m.write, m.clear)
  assert.equal(m.settings.snapshot.values['tools.computer'], false)
  assert.equal(m.settings.snapshot.values['tools.browser'], false)
  assert.deepEqual(m.settings.writes.at(-1)?.edits, [{ key: 'tools.browser', value: false }])
  const count = m.settings.writes.length
  await migrateToolSettings(m.read(), undefined, m.write, m.clear)
  assert.equal(m.settings.writes.length, count)
})

test('迁移：并发版本冲突不覆盖、不清本地；重读之后设备值优先', async () => {
  const m = migration()
  const stale = structuredClone(m.read())
  await m.write({
    expectedVersion: stale.snapshot.version,
    edits: [{ key: 'tools.computer', value: false }],
  })
  await assert.rejects(migrateToolSettings(stale, { computer: true }, m.write, m.clear))
  assert.equal(m.cleared(), 0)
  await migrateToolSettings(m.read(), { computer: true }, m.write, m.clear)
  assert.equal(m.cleared(), 1)
  assert.equal(m.settings.snapshot.values['tools.computer'], false)
})

test('设备一级改一列只清该列 harness 覆盖，保留另一列', async () => {
  const m = migration()
  await m.write({
    expectedVersion: 3,
    edits: [
      { key: 'harness.pi.browser', value: false },
      { key: 'harness.pi.computer', value: true },
    ],
  })
  assert.deepEqual(toolSettingEdits(m.read(), { browser: true }), [
    { key: 'tools.browser', value: true },
    { key: 'harness.pi.browser', value: null },
  ])
})
