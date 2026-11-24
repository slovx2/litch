// “下一步在谁”的判定规则逐条覆盖（纯函数，规则顺序见 src/manager-issue-waiting.mts）。
import assert from 'node:assert/strict'
import test from 'node:test'
import { MANAGER_ISSUE_STALE_SECONDS } from '../../protocol/src/manager-issues.mjs'
import { type IssueWaitingFacts, issueWaiting } from '../src/manager-issue-waiting.mjs'

const NOW = 2_000_000_000
const HOUR = 3600
/** 默认：开放、跟进开、一小时前用户新建，之后没有别的动作 */
const facts = (patch: Partial<IssueWaitingFacts> = {}): IssueWaitingFacts => ({
  status: 'open',
  followUp: 'on',
  lastUserTalk: { seq: 1, at: NOW - HOUR },
  lastManager: null,
  lastAny: NOW - HOUR,
  marked: null,
  lines: [],
  managerTurnStartedAt: null,
  now: NOW,
  ...patch,
})
const managerReplied = {
  lastUserTalk: { seq: 1, at: NOW - 2 * HOUR },
  lastManager: { seq: 2, at: NOW - HOUR },
  lastAny: NOW - HOUR,
}
const pick = (value: ReturnType<typeof issueWaiting>) =>
  value && { on: value.on, why: value.why, stale: value.stale ?? false }

test('规则 1a：关联工作线在跑 → 进行中，压过跟进暂停和经理最后回复', () => {
  const running = [{ running: true, lastActive: NOW - 60 }]
  assert.deepEqual(pick(issueWaiting(facts({ ...managerReplied, lines: running }))), {
    on: 'agent',
    why: 'line',
    stale: false,
  })
  assert.equal(issueWaiting(facts({ followUp: 'off', lines: running }))?.why, 'line')
  // 线不在跑不算接手
  assert.equal(
    issueWaiting(facts({ ...managerReplied, lines: [{ running: false, lastActive: NOW - 60 }] }))
      ?.on,
    'user',
  )
})

test('规则 1b：经理回合在跑且本回合动过这条 → 进行中；本回合没动过按后面的规则', () => {
  const turn = NOW - 10 * 60
  assert.deepEqual(
    pick(
      issueWaiting(
        facts({
          ...managerReplied,
          lastManager: { seq: 2, at: NOW - 60 },
          managerTurnStartedAt: turn,
        }),
      ),
    ),
    { on: 'agent', why: 'turn', stale: false },
  )
  // 回合在跑，但经理最后一次动这条是在回合开始之前
  assert.equal(
    issueWaiting(facts({ ...managerReplied, managerTurnStartedAt: turn }))?.why,
    'manager',
  )
})

test('规则 2：用户最后发言、跟进开着 → 进行中（经理会被叫醒）', () => {
  assert.deepEqual(pick(issueWaiting(facts())), { on: 'agent', why: 'user', stale: false })
  // 经理回复后用户又评论
  assert.equal(
    issueWaiting(
      facts({
        lastUserTalk: { seq: 3, at: NOW - 60 },
        lastManager: { seq: 2, at: NOW - HOUR },
        lastAny: NOW - 60,
      }),
    )?.why,
    'user',
  )
})

test('规则 3：最后是经理的回复或更新 → 待处理；经理新建、没有用户动作也是', () => {
  assert.deepEqual(pick(issueWaiting(facts(managerReplied))), {
    on: 'user',
    why: 'manager',
    stale: false,
  })
  assert.equal(
    issueWaiting(facts({ lastUserTalk: null, lastManager: { seq: 1, at: NOW - HOUR } }))?.why,
    'manager',
  )
})

test('规则 4：跟进已暂停 → 待处理，即使用户最后发言', () => {
  assert.deepEqual(pick(issueWaiting(facts({ followUp: 'off' }))), {
    on: 'user',
    why: 'paused',
    stale: false,
  })
})

test('规则 5：经理显式标记覆盖最后发言和受阻；不覆盖线在跑、跟进暂停', () => {
  assert.deepEqual(
    pick(issueWaiting(facts({ ...managerReplied, marked: { on: 'agent', at: NOW - 60 } }))),
    { on: 'agent', why: 'marked', stale: false },
  )
  assert.deepEqual(pick(issueWaiting(facts({ marked: { on: 'user', at: NOW - 60 } }))), {
    on: 'user',
    why: 'marked',
    stale: false,
  })
  assert.equal(
    issueWaiting(facts({ status: 'blocked', marked: { on: 'user', at: NOW - 60 } }))?.on,
    'user',
    '受阻但其实在等用户',
  )
  assert.equal(
    issueWaiting(
      facts({ marked: { on: 'user', at: NOW - 60 }, lines: [{ running: true, lastActive: NOW }] }),
    )?.why,
    'line',
  )
  assert.equal(
    issueWaiting(facts({ followUp: 'off', marked: { on: 'agent', at: NOW - 60 } }))?.why,
    'paused',
  )
})

test('受阻 → 进行中，等多久都不算卡住', () => {
  const old = NOW - 10 * 24 * HOUR
  assert.deepEqual(
    pick(
      issueWaiting(
        facts({
          status: 'blocked',
          lastUserTalk: null,
          lastManager: { seq: 2, at: old },
          lastAny: old,
        }),
      ),
    ),
    { on: 'agent', why: 'blocked', stale: false },
  )
})

test('可能卡住：进行中超过 24 小时没有动静 → 待处理并标 stale；关联线最近有动静不算', () => {
  const old = NOW - MANAGER_ISSUE_STALE_SECONDS - 60
  const quiet = { lastUserTalk: { seq: 1, at: old }, lastAny: old }
  assert.deepEqual(pick(issueWaiting(facts(quiet))), { on: 'user', why: 'user', stale: true })
  assert.deepEqual(
    pick(
      issueWaiting(facts({ ...managerReplied, lastAny: old, marked: { on: 'agent', at: old } })),
    ),
    { on: 'user', why: 'marked', stale: true },
  )
  // 刚好在阈值内
  const fresh = NOW - MANAGER_ISSUE_STALE_SECONDS + 60
  assert.equal(
    issueWaiting(facts({ lastUserTalk: { seq: 1, at: fresh }, lastAny: fresh }))?.stale,
    undefined,
  )
  // 关联线一小时前刚回报过：有动静
  assert.equal(
    issueWaiting(facts({ ...quiet, lines: [{ running: false, lastActive: NOW - HOUR }] }))?.stale,
    undefined,
  )
  assert.equal(issueWaiting(facts(quiet))?.since, old, 'since 是最近一次动静')
})

test('已结束的 X-n 没有“下一步”', () => {
  assert.equal(issueWaiting(facts({ status: 'resolved' })), null)
  assert.equal(
    issueWaiting(facts({ status: 'closed', lines: [{ running: true, lastActive: NOW }] })),
    null,
  )
})
