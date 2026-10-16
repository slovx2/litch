// 结束了的命令那一行右边写什么：耗时、状态，状态标不标红。
// 跑法：npm run test --prefix packages/ui（Node 直接读 .ts，不用先构建）。
import assert from 'node:assert/strict'
import { test } from 'node:test'

const { commandLook, commandState } = await import('../src/transcript/command-state.ts')

/** 假的翻译：文案键加参数，看得出选了哪一句 */
const t = (key, args) => (args ? `${key}${JSON.stringify(args)}` : key)

const command = (fields) => ({
  id: 'c1',
  kind: 'command',
  command: 'ls',
  cwd: '/w',
  output: '',
  elided: null,
  exitCode: null,
  durationMs: null,
  startedAt: null,
  status: 'completed',
  ...fields,
})

test('跑完的命令：通过的不标红；退出码不是 0 的、失败的标红；有耗时就写', () => {
  const passed = command({ exitCode: 0, durationMs: 1200 })
  assert.equal(commandState(passed, t), 'command.passed')
  assert.deepEqual(commandLook(passed), { durationMs: 1200, failed: false })
  const exited = command({ status: 'failed', exitCode: 3, durationMs: 40 })
  assert.equal(commandState(exited, t), 'command.exitCode{"code":3}')
  assert.deepEqual(commandLook(exited), { durationMs: 40, failed: true })
  const failed = command({ status: 'failed' })
  assert.equal(commandState(failed, t), 'status.failed')
  assert.deepEqual(commandLook(failed), { durationMs: null, failed: true })
})

test('拒绝了的命令没跑过：写“已拒绝”，不标红，不写耗时，退出码不看', () => {
  // 上游现在的样子（app-server 答复审批时收尾）：输出、退出码、时长都是空的
  const declined = command({ status: 'declined' })
  assert.equal(commandState(declined, t), 'status.declined')
  assert.deepEqual(commandLook(declined), { durationMs: null, failed: false })
  // 上游重读旧版 codex 记下的会话时给的样子：退出码 -1、时长 0、输出是那句拒绝的话
  //（rust-v0.162.0-alpha.20 的 thread_history.rs，reconstructs_declined_exec_and_patch_items）
  const legacy = command({
    status: 'declined',
    exitCode: -1,
    durationMs: 0,
    output: 'exec command rejected by user',
  })
  assert.equal(commandState(legacy, t), 'status.declined')
  assert.deepEqual(commandLook(legacy), { durationMs: null, failed: false })
})
