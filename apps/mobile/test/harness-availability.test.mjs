import assert from 'node:assert/strict'
import { test } from 'node:test'
import { translator } from '../../../packages/ui/src/i18n/index.ts'
import { downHarness, harnessNotice } from '../src/detail/composer/availability.ts'

const down = {
  id: 'codex',
  name: 'Codex',
  state: 'unavailable',
  down: 'notInstalled',
  reason: { key: 'harness.notInstalled' },
}
const device = { connection: 'online', harnesses: [down] }

test('未安装时稳定显示原因及安装指引，目录重画不改变提示', () => {
  const t = translator('zh-CN')
  const notice = harnessNotice(down, t)
  assert.match(notice, /Codex 当前不可用/)
  assert.match(notice, /未安装|没有安装/)
  assert.match(notice, /安装/)
  for (let i = 0; i < 5; i++)
    assert.equal(harnessNotice(downHarness({ ...device }, 'codex'), t), notice)
  assert.match(harnessNotice(down, translator('en')), /install/i)
})

test('网络重连不沿用缓存的 harness 故障；确认恢复后不显示', () => {
  for (const connection of ['connecting', 'reconnecting', 'offline', 'error'])
    assert.equal(downHarness({ ...device, connection }, 'codex'), null)
  assert.equal(downHarness({ ...device, harnesses: [{ ...down, state: 'ready' }] }, 'codex'), null)
  assert.equal(downHarness(device, 'missing'), null)
})

test('真运行时反复断开按最新状态显示；停用时明确引导重新启用', () => {
  const t = translator('zh-CN')
  for (const state of ['unavailable', 'ready', 'unavailable', 'ready']) {
    const found = downHarness({ ...device, harnesses: [{ ...down, state }] }, 'codex')
    assert.equal(found === null, state === 'ready')
  }
  assert.match(
    harnessNotice({ ...down, state: 'disabled', down: 'disabled', reason: null }, t),
    /重新启用/,
  )
  assert.match(harnessNotice({ ...down, down: 'disconnected', reason: null }, t), /自动重连/)
})
