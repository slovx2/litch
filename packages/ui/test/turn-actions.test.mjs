// 用户消息上出不出“分叉”“回退”（transcript/turn-actions.ts）：回合开头那条照声明；
// 插进来的话只在声明了会切在回合中间时出，别的会话发来的、对面还没收下的不出，绝不退、不带整个回合。
// 跑法：npm run test --prefix packages/ui（Node 直接读 .ts，不用先构建）。
import assert from 'node:assert/strict'
import { test } from 'node:test'

const { messageActions } = await import('../src/transcript/turn-actions.ts')

const meta = (can) => ({
  can: { declared: true, fork: true, rollback: true, cutInTurn: false, ...can },
})
const user = (fields = {}) => ({
  id: 'x',
  kind: 'userMessage',
  text: '话',
  attachments: [],
  ...fields,
})
const shown = (actions) => [actions.fork, actions.rollback]

test('回合开头那条：照声明出，声明了不会的不出，没声明的留着', () => {
  assert.deepEqual(shown(messageActions(meta({}), false, user())), [true, true])
  assert.deepEqual(shown(messageActions(meta({ fork: false, rollback: false }), false, user())), [
    false,
    false,
  ])
  assert.deepEqual(
    shown(messageActions(meta({ declared: false, fork: false, rollback: false }), false, user())),
    [true, true],
  )
  assert.deepEqual(shown(messageActions(undefined, false, user())), [true, true])
})

test('插进来的话：没声明会切在回合中间的一律不出（没声明能力的、能力没到的也不出）', () => {
  assert.deepEqual(shown(messageActions(meta({}), true, user())), [false, false])
  assert.deepEqual(
    shown(messageActions(meta({ declared: false, cutInTurn: false }), true, user())),
    [false, false],
  )
  assert.deepEqual(shown(messageActions(undefined, true, user())), [false, false])
})

test('插进来的话：声明了会切的出；别的会话发来的、对面还没收下的不出', () => {
  const able = meta({ cutInTurn: true })
  assert.deepEqual(messageActions(able, true, user()), { fork: true, rollback: true, cut: true })
  assert.deepEqual(
    shown(messageActions(able, true, user({ peer: { name: 'A', session: null } }))),
    [false, false],
  )
  assert.deepEqual(shown(messageActions(able, true, user({ unconfirmed: true }))), [false, false])
  // 会切但声明了不会回退的：只出分叉
  assert.deepEqual(
    shown(messageActions(meta({ cutInTurn: true, rollback: false }), true, user())),
    [true, false],
  )
  // 开头那条在会切的 harness 上分叉也切（带到下一条插进来的话之前）
  assert.equal(messageActions(able, false, user()).cut, true)
})
