// 技能清单：协议里的形状 → 界面用的形状。纯函数。
// 清单是对面发来的，不能只靠类型：没有名字或位置的、明说停用了的不要，重复的只留一份。
import type { SkillsListResponse } from '../../../protocol/src/index.mjs'
import type { SkillOption, SkillProblem } from '../model.mjs'

/** 取回来的一份：能用的技能，和对面扫到了却没列出来的那些 */
export interface SkillCatalog {
  skills: SkillOption[]
  problems: SkillProblem[]
}

const SCOPES: readonly string[] = ['user', 'repo', 'system', 'admin']

const text = (value: unknown): string => (typeof value === 'string' ? value.trim() : '')

/** 说明只留第一段：清单里一行放不下一整篇 */
const firstLine = (value: string): string => value.split(/\r?\n/, 1)[0]?.trim() ?? ''

export function projectSkills(response: SkillsListResponse): SkillCatalog {
  const seen = new Set<string>()
  const skills: SkillOption[] = []
  const told = new Set<string>()
  const problems: SkillProblem[] = []
  for (const entry of Array.isArray(response?.data) ? response.data : []) {
    for (const skill of Array.isArray(entry?.skills) ? entry.skills : []) {
      const name = text(skill?.name)
      const path = text(skill?.path)
      // 停用的不列：选了也用不上。对面没说启没启用的按启用算
      if (!name || !path || skill.enabled === false || seen.has(path)) continue
      seen.add(path)
      const shown = skill.interface
      skills.push({
        name,
        title: text(shown?.displayName) || name,
        note: firstLine(
          text(shown?.shortDescription) || text(skill.shortDescription) || text(skill.description),
        ),
        path,
        scope: SCOPES.includes(skill.scope) ? skill.scope : null,
      })
    }
    // 没列出来的：对面的原话照搬，只留第一段；没说原因的不算，同一句只留一份
    for (const error of Array.isArray(entry?.errors) ? entry.errors : []) {
      const message = firstLine(text(error?.message))
      const path = text(error?.path)
      const key = `${path}\n${message}`
      if (!message || told.has(key)) continue
      told.add(key)
      problems.push({ path, message })
    }
  }
  return { skills, problems }
}
