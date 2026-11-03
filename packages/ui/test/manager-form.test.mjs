import assert from 'node:assert/strict'
import test from 'node:test'
import { tsImport } from 'tsx/esm/api'

const { managerFieldStep, managerStepError, managerTabTarget } = await tsImport(
  '../src/manager/form-steps.ts',
  import.meta.url,
)

const invalid = { cwd: '', harnessReady: false, maxRunningLines: 0 }

test('经理新建：基本信息可全空，不提前校验运行环境和任务分配', () => {
  assert.equal(managerStepError('basic', invalid), null)
})

test('经理运行环境：目录与可用 harness 缺一不可，不校验下一步的并行数', () => {
  for (const input of [invalid, { ...invalid, harnessReady: true }])
    assert.equal(managerStepError('runtime', input), 'manager.cwdRequired')
  assert.equal(managerStepError('runtime', { ...invalid, cwd: '/repo' }), 'manager.harnessRequired')
  assert.equal(
    managerStepError('runtime', { ...invalid, cwd: '  ', harnessReady: true }),
    'manager.cwdRequired',
  )
  assert.equal(managerStepError('runtime', { ...invalid, cwd: '/repo', harnessReady: true }), null)
})

test('目录支持目标设备 home，拒绝相对目录；错误字段能返回前一步', () => {
  for (const cwd of ['~', '~/project', '/repo', 'C:\\repo', '\\\\server\\share'])
    assert.equal(managerStepError('runtime', { ...invalid, cwd, harnessReady: true }), null)
  for (const cwd of ['project', './project', '~other/project'])
    assert.equal(
      managerStepError('runtime', { ...invalid, cwd, harnessReady: true }),
      'manager.cwdAbsolute',
    )
  for (const field of ['cwd', 'harness', 'model', 'effort', 'permission'])
    assert.equal(managerFieldStep(field), 'runtime')
  for (const field of ['name', 'rules', 'scope', 'firstTask', 'template'])
    assert.equal(managerFieldStep(field), 'basic')
  for (const field of ['dispatch.harness', 'dispatch.maxRunningLines', 'contact.unanswered'])
    assert.equal(managerFieldStep(field), 'dispatch')
  assert.equal(managerFieldStep('unknown'), null)
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
