import assert from 'node:assert/strict'
import test from 'node:test'
import {
  layeredSkillRules,
  type SkillRule,
  setSkillRule,
  skillEnabled,
  skillRules,
} from '../src/skill-config.mjs'

const a = { name: 'demo', key: '/s/a/SKILL.md' }
const b = { name: 'demo', key: '/s/b/SKILL.md' }

test('SKILL-CONFIG-001：照 codex 按顺序套规则，后面的为准，几层里同一个选择器取后出现的', () => {
  // 名字关、再按路径开其中一个（codex 的 resolve_disabled_paths）
  const rules: SkillRule[] = [
    { name: 'demo', enabled: false },
    { path: a.key, enabled: true },
  ]
  assert.equal(skillEnabled(rules, a, true), true)
  assert.equal(skillEnabled(rules, b, true), false)
  // 没有规则管的照默认（Claude Code 自己设置里的开关）
  assert.equal(skillEnabled([], a, false), false)
  // 后一层的同一个选择器把前一层那条挪到后面
  assert.deepEqual(
    layeredSkillRules([
      [
        { path: a.key, enabled: false },
        { name: 'demo', enabled: true },
      ],
      [{ path: a.key, enabled: true }],
    ]),
    [
      { name: 'demo', enabled: true },
      { path: a.key, enabled: true },
    ],
  )
  for (const bad of [
    'x',
    [{ enabled: false }],
    [{ path: 'relative', enabled: false }],
    [{ path: a.key, name: 'demo', enabled: false }],
    [{ name: ' ', enabled: false }],
    [{ name: 'demo', enabled: 'no' }],
    [{ name: 'demo', enabled: false, extra: 1 }],
  ])
    assert.throws(() => skillRules(bad), /skills\.config/, JSON.stringify(bad))
})

test('SKILL-CONFIG-002：skills/config/write 的改法照 codex：关就改或追加，开就删掉那条', () => {
  const never = () => false
  let rules = setSkillRule(undefined, { path: a.key }, false, never)
  assert.deepEqual(rules, [{ path: a.key, enabled: false }])
  rules = setSkillRule(rules, { name: 'demo' }, false, never)
  rules = setSkillRule(rules, { path: a.key }, false, never)
  assert.deepEqual(rules, [
    { path: a.key, enabled: false },
    { name: 'demo', enabled: false },
  ])
  rules = setSkillRule(rules, { name: 'demo' }, true, never)
  assert.deepEqual(rules, [{ path: a.key, enabled: false }], '开就删掉那条，按路径的关照旧')
  // 只靠 Claude Code 自己的设置关着的，留一条“开”盖过它
  assert.deepEqual(
    setSkillRule([], { name: 'demo' }, true, () => true),
    [{ name: 'demo', enabled: true }],
  )
})
