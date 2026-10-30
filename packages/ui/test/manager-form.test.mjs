import assert from 'node:assert/strict'
import test from 'node:test'
import { managerStepError, managerTabTarget } from '../src/manager/form-steps.ts'

const invalid = { cwd: '', harnessReady: false, maxRunningLines: 0 }

test('经理新建：基本信息可全空，不提前校验运行环境和任务分配', () => {
  assert.equal(managerStepError('basic', invalid), null)
})

test('经理运行环境：目录与可用 harness 缺一不可，不校验下一步的并行数', () => {
  for (const input of [invalid, { ...invalid, cwd: '/repo' }, { ...invalid, harnessReady: true }])
    assert.equal(managerStepError('runtime', input), 'manager.environmentRequired')
  assert.equal(
    managerStepError('runtime', { ...invalid, cwd: '  ', harnessReady: true }),
    'manager.environmentRequired',
  )
  assert.equal(managerStepError('runtime', { ...invalid, cwd: '/repo', harnessReady: true }), null)
})

test('经理任务分配：只收正安全整数，保存编辑时不校验只读的运行环境', () => {
  for (const maxRunningLines of [
    0,
    -1,
    1.5,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.MAX_SAFE_INTEGER + 1,
  ])
    assert.equal(
      managerStepError('dispatch', { ...invalid, maxRunningLines }),
      'manager.updateRequired',
    )
  for (const maxRunningLines of [1, 4, Number.MAX_SAFE_INTEGER])
    assert.equal(managerStepError('dispatch', { ...invalid, maxRunningLines }), null)
})

test('经理编辑页签：方向键循环，Home 与 End 定位首尾，其余键保留原用途', () => {
  assert.equal(managerTabTarget('basic', 'ArrowLeft'), 'dispatch')
  assert.equal(managerTabTarget('dispatch', 'ArrowRight'), 'basic')
  assert.equal(managerTabTarget('basic', 'ArrowRight'), 'runtime')
  assert.equal(managerTabTarget('runtime', 'Home'), 'basic')
  assert.equal(managerTabTarget('runtime', 'End'), 'dispatch')
  assert.equal(managerTabTarget('runtime', 'Tab'), null)
  assert.equal(managerTabTarget('runtime', 'Enter'), null)
})
