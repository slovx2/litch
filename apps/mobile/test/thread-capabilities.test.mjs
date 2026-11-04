import assert from 'node:assert/strict'
import test from 'node:test'
import { archivedMenu, sessionMenu } from '../src/screens/sessions/menus.ts'

test('手机会话菜单按后端能力判断删除，不继承同一 harness 的其他后端', () => {
  const device = {
    connection: 'online',
    harnesses: [
      { id: 'agy', state: 'ready', abilities: { remove: true, rename: true, archive: true } },
    ],
  }
  const base = { harness: 'agy', lineage: null, worktree: null }
  const acp = { ...base, abilities: { remove: false, rename: true, archive: true } }
  const t = (key) => key
  for (const menu of [sessionMenu(acp, device, [], t), archivedMenu(acp, device, t)])
    assert.equal(
      menu.some((entry) => entry.act === 'delete'),
      false,
    )
  assert.equal(
    archivedMenu(base, device, t).some((entry) => entry.act === 'delete'),
    true,
  )
})
