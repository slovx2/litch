import assert from 'node:assert/strict'
import test from 'node:test'
import { questionsOfHistory } from '../../protocol/src/pending-history.mjs'
import { pendingFixtures } from '../../protocol/test/pending-fixtures.mjs'

for (const fixture of pendingFixtures)
  test(`PENDING-SHARED-DEVICE：${fixture.name}`, () => {
    const actual = questionsOfHistory({ turns: fixture.turns }, [], fixture.queued)
    assert.deepEqual(
      actual.map((q) => q.title),
      fixture.titles,
    )
    if (fixture.reports !== undefined)
      assert.ok(actual.every((q) => q.reportsAfter === fixture.reports))
    const ignored = questionsOfHistory(
      { turns: fixture.turns },
      actual.flatMap((q) => q.sourceIds),
      fixture.queued,
    )
    assert.ok(ignored.every((q) => q.ignored))
  })
