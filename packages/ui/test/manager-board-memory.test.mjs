import assert from 'node:assert/strict'
import test from 'node:test'
import { boardPageMemory, managerBoardMemory } from '../../core/src/manager-board-memory.mts'

test('看板阅读状态按设备、经理、页签、筛选、排序隔离，离开组件后仍保留', () => {
  const manager = managerBoardMemory('device-a', 'manager-a')
  const reading = boardPageMemory(manager, 'decisions', 'decision/open/newest')
  reading.selected = 'D-2'
  reading.y = 320
  manager.filters.decision = 'open'
  for (const other of [
    boardPageMemory(manager, 'requests', 'request/open/newest'),
    boardPageMemory(manager, 'decisions', 'decision/all/newest'),
    boardPageMemory(manager, 'decisions', 'decision/open/oldest'),
    boardPageMemory(
      managerBoardMemory('device-a', 'manager-b'),
      'decisions',
      'decision/open/newest',
    ),
    boardPageMemory(
      managerBoardMemory('device-b', 'manager-a'),
      'decisions',
      'decision/open/newest',
    ),
  ])
    assert.deepEqual(other, { selected: null, y: 0 })
  const returned = managerBoardMemory('device-a', 'manager-a')
  assert.deepEqual(boardPageMemory(returned, 'decisions', 'decision/open/newest'), {
    selected: 'D-2',
    y: 320,
  })
  assert.equal(returned.filters.decision, 'open')
})
