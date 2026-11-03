import assert from 'node:assert/strict'
import test from 'node:test'
import { matchOptions } from '../src/composer/picker-search.ts'
import { catalogCandidates } from '../src/composer/session-catalog.ts'
import { sessionHits } from '../src/composer/session-hits.ts'
import { sessionTargetOptions } from '../src/tasks/session-options.ts'

const labels = { conversation: '普通对话', child: '子会话', manager: '经理', line: '工作线' }
const catalog = Object.keys(labels).map((kind, index) => ({
  id: kind,
  kind,
  title: `候选 ${index}`,
  harness: 'pi',
  workspaceId: null,
  cwd: '/work',
  updatedAt: index,
}))
const candidates = () => catalogCandidates(catalog, [], String, (kind) => labels[kind], new Set())

test('@ 候选包含四种身份，按类型和标题搜索，最近排序与当前/已引用过滤不变', () => {
  const options = { query: '', current: null, workspaceId: null, bound: new Set() }
  assert.deepEqual(
    sessionHits(candidates(), options).map((entry) => entry.id),
    ['line', 'manager', 'child', 'conversation'],
  )
  for (const kind of ['manager', 'line']) {
    const hit = sessionHits(candidates(), { ...options, query: labels[kind] })
    assert.equal(hit[0].id, kind)
    assert.equal(hit[0].typeLabel, labels[kind])
    assert.equal(sessionHits(candidates(), { ...options, query: hit[0].title })[0].id, kind)
  }
  assert.deepEqual(
    sessionHits(candidates(), { ...options, current: 'manager', bound: new Set(['line']) }).map(
      (entry) => entry.id,
    ),
    ['child', 'conversation'],
  )
  assert.equal(
    catalogCandidates(catalog, [], String, (kind) => labels[kind], new Set(['child'])).length,
    3,
  )
})

test('桌面和手机目标选项保留目录全部身份、原顺序和可选 ID，类型参与搜索', () => {
  for (const phone of [false, true]) {
    const options = sessionTargetOptions(
      catalog,
      String,
      (kind) => labels[kind],
      () => 'Pi',
      phone,
    )
    assert.deepEqual(
      options.map((entry) => entry.id),
      catalog.map((entry) => entry.id),
    )
    for (const kind of ['manager', 'line']) {
      assert.equal(matchOptions(options, labels[kind])[0].id, kind)
      assert.match(options.find((entry) => entry.id === kind).note, /Pi/)
    }
    assert.equal(options[0].note.includes('/work'), phone)
  }
})
