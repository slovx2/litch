// Skill 开关：照 codex 的 `skills.config`（rust-v0.163.0：codex-rs/config/src/skills_config.rs 的
// SkillConfigRules、codex-rs/core/src/config/edit.rs 的 set_skill_config）。一条规则按 SKILL.md 的路径或按名字
// 选中 Skill，给开或关；按顺序套，后面的盖前面的。规则存在 config.json 的 `skills.config` 里，`-c` 那一层
// 接在后面（codex 的 User、SessionFlags 两层），同一个选择器后出现的那条取代前面的。
// skills/config/write 和 config/batchWrite 写的是同一处。
import { existsSync } from 'node:fs'
import { isAbsolute, resolve } from 'node:path'
import { isConfigObject } from './config-store.mjs'
import { ProtocolError } from './protocol-contract.mjs'
import { canonicalSkillKey } from './skill-catalog.mjs'

export type SkillSelector = { path: string } | { name: string }
export type SkillRule = SkillSelector & { enabled: boolean }

function invalid(message: string): never {
  throw new ProtocolError(-32602, `skills.config ${message}`)
}

// 路径按真实路径比（codex 同样先 canonicalize，取不到就用原样）
export function skillPathKey(path: string): string {
  return existsSync(path) ? canonicalSkillKey(path) : resolve(path)
}

function sameSelector(a: SkillSelector, b: SkillSelector): boolean {
  if ('path' in a && 'path' in b) return skillPathKey(a.path) === skillPathKey(b.path)
  if ('name' in a && 'name' in b) return a.name.trim() === b.name.trim()
  return false
}

// 配置里的数组 → 规则。写法不对报 -32602（codex 的 batchWrite 同样按模式校验，未知字段也拒绝）
export function skillRules(value: unknown): SkillRule[] {
  if (value == null) return []
  if (!Array.isArray(value)) invalid('必须是数组')
  return value.map((entry, index) => {
    if (!isConfigObject(entry)) invalid(`第 ${index + 1} 条必须是表`)
    for (const key of Object.keys(entry))
      if (!['path', 'name', 'enabled'].includes(key)) invalid(`第 ${index + 1} 条不认识 ${key}`)
    if (typeof entry.enabled !== 'boolean') invalid(`第 ${index + 1} 条的 enabled 必须是布尔值`)
    const hasPath = entry.path != null
    if (hasPath === (entry.name != null)) invalid(`第 ${index + 1} 条要有且只有 path 或 name 之一`)
    if (hasPath) {
      if (typeof entry.path !== 'string' || !isAbsolute(entry.path))
        invalid(`第 ${index + 1} 条的 path 必须是绝对路径`)
      return { path: entry.path, enabled: entry.enabled }
    }
    if (typeof entry.name !== 'string' || !entry.name.trim())
      invalid(`第 ${index + 1} 条的 name 不能为空`)
    return { name: entry.name, enabled: entry.enabled }
  })
}

// 几层规则接成一串：后面一层里出现的选择器先把前面同一个选择器的那条拿掉（codex 的 skill_config_rules_from_stack）
export function layeredSkillRules(layers: readonly unknown[]): SkillRule[] {
  const rules: SkillRule[] = []
  for (const layer of layers)
    for (const rule of skillRules(layer)) {
      const at = rules.findIndex((existing) => sameSelector(existing, rule))
      if (at >= 0) rules.splice(at, 1)
      rules.push(rule)
    }
  return rules
}

// 每个 Skill 开没开：base 是规则之外的默认（Claude Code 自己 settings.json 里的 skillOverrides），
// 规则按顺序套上去，后面的为准（codex 的 resolve_disabled_paths）
function matches(rule: SkillRule, skill: { name: string; key: string }): boolean {
  return 'path' in rule ? skillPathKey(rule.path) === skill.key : rule.name.trim() === skill.name
}

// 有没有规则管着这个 Skill
export function skillRuled(
  rules: readonly SkillRule[],
  skill: { name: string; key: string },
): boolean {
  return rules.some((rule) => matches(rule, skill))
}

export function skillEnabled(
  rules: readonly SkillRule[],
  skill: { name: string; key: string },
  base: boolean,
): boolean {
  let enabled = base
  for (const rule of rules) if (matches(rule, skill)) enabled = rule.enabled
  return enabled
}

// skills/config/write 对规则数组的改法（codex 的 set_skill_config）：关就改掉同一个选择器的那条、没有就追加；
// 开就删掉那条。只有删掉之后还因为 Claude Code 自己的设置关着时，才留一条“开”的规则把它打开
export function setSkillRule(
  current: unknown,
  selector: SkillSelector,
  enabled: boolean,
  stillDisabled: (rules: SkillRule[]) => boolean,
): SkillRule[] {
  const rules = skillRules(current)
  const at = rules.findIndex((rule) => sameSelector(rule, selector))
  if (!enabled) {
    if (at >= 0) rules[at] = { ...selector, enabled: false }
    else rules.push({ ...selector, enabled: false })
    return rules
  }
  if (at >= 0) rules.splice(at, 1)
  if (stillDisabled(rules)) rules.push({ ...selector, enabled: true })
  return rules
}
