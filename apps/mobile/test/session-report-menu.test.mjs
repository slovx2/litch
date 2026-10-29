import assert from 'node:assert/strict'
import test from 'node:test'
import { sessionMenu } from '../src/screens/sessions/menus.ts'

const t = (key) => key
const device = {
  connection: 'online',
  reportControl: true,
  sessionTree: true,
  harnesses: [{ id: 'codex', state: 'ready', abilities: {} }],
}
const child = {
  id: 'c',
  harness: 'codex',
  status: 'waiting',
  lineage: { parentId: 'p', reportParent: true },
}

test('手机长按菜单按回报开关显示停止/恢复；不改变等待状态或父子关系', () => {
  assert.equal(
    sessionMenu(child, device, [], t).find((e) => e.act === 'report')?.label,
    'tree.report.stop',
  )
  assert.equal(
    sessionMenu(
      { ...child, lineage: { ...child.lineage, reportParent: false } },
      device,
      [],
      t,
    ).find((e) => e.act === 'report')?.label,
    'tree.report.resume',
  )
  assert.equal(child.status, 'waiting')
  assert.equal(child.lineage.parentId, 'p')
})

test('离线保留禁用菜单及原因；未声明能力或普通会话不出现', () => {
  const entry = sessionMenu(child, { ...device, connection: 'offline' }, [], t).find(
    (e) => e.act === 'report',
  )
  assert.equal(entry?.disabled, 'tree.report.offline')
  assert.equal(
    sessionMenu(child, { ...device, reportControl: false }, [], t).some((e) => e.act === 'report'),
    false,
  )
  assert.equal(
    sessionMenu({ ...child, lineage: null }, device, [], t).some((e) => e.act === 'report'),
    false,
  )
})
