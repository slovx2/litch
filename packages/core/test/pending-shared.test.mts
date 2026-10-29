import assert from 'node:assert/strict'
import test from 'node:test'
import type { Turn } from '../../protocol/src/index.mjs'
import { questionsOfHistory } from '../../protocol/src/pending-history.mjs'
import { pendingFixtures } from '../../protocol/test/pending-fixtures.mjs'
import { questionsOfView } from '../src/projection/pending-asks.mjs'
import { projectTurn } from '../src/projection/session.mjs'

for (const fixture of pendingFixtures)
  test(`PENDING-SHARED-CORE：${fixture.name}`, () => {
    const projected = fixture.turns.map((turn) => projectTurn(turn as Turn))
    const view = {
      turns: projected.map((p) => p.turn),
      items: Object.fromEntries(projected.flatMap((p) => p.items.map((i) => [i.id, i]))),
      queued: fixture.queued ?? [],
    }
    const actual = questionsOfView(view)
    assert.deepEqual(
      actual.map((q) => q.title),
      fixture.titles,
    )
    if (fixture.reports !== undefined)
      assert.ok(actual.every((q) => q.reportsAfter === fixture.reports))
    assert.deepEqual(actual, questionsOfHistory({ turns: fixture.turns }, [], fixture.queued))
    const ignoredQuestions = actual.flatMap((q) => q.sourceIds)
    assert.ok(questionsOfView({ ...view, ignoredQuestions }).every((q) => q.ignored))
  })

test('PENDING-SHARED-CORE：本地临时回合的来源键和答复标识重连后不变', () => {
  const source = pendingFixtures[0]?.turns[0] as Turn
  const local = projectTurn(source, 'local:1')
  const restored = projectTurn(source)
  const derive = (p: ReturnType<typeof projectTurn>) =>
    questionsOfView({
      turns: [p.turn],
      items: Object.fromEntries(p.items.map((i) => [i.id, i])),
      queued: [],
    })
  const before = derive(local)
  const after = derive(restored)
  assert.deepEqual(
    before.map((q) => [q.sourceIds, q.replyIds]),
    after.map((q) => [q.sourceIds, q.replyIds]),
  )
})
