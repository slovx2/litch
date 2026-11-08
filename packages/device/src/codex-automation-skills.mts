import { fileURLToPath } from 'node:url'
import { AUTOMATION_GUIDE_NAMESPACE } from '../../protocol/src/automation-skills.mjs'
import { resolveAutomationTools } from '../../shared/src/automation-tools.mjs'
import type { InstructionContext } from './codex-instructions.mjs'
import { isObject } from './wire.mjs'

/** 共享目录由设备服务准备；原生列表是是否发现/启用的最终依据，不改 CODEX_HOME。 */
export async function codexAutomationSkills(
  params: Record<string, unknown>,
  context: InstructionContext,
): Promise<Record<string, unknown>> {
  const raw = params.dynamicTools
  if (!Array.isArray(raw) || !raw.some((s) => isObject(s) && s.name === AUTOMATION_GUIDE_NAMESPACE))
    return params
  const paths = new Set<string>()
  try {
    const result = await context.ask('skills/list', {
      ...(params.cwd ? { cwds: [params.cwd] } : {}),
      forceReload: true,
    })
    const data = isObject(result) && Array.isArray(result.data) ? result.data : []
    for (const row of data)
      if (isObject(row) && Array.isArray(row.skills))
        for (const skill of row.skills) {
          if (isObject(skill) && skill.enabled !== false && typeof skill.path === 'string')
            paths.add(skill.path.startsWith('file:') ? fileURLToPath(skill.path) : skill.path)
        }
  } catch (error) {
    context.log(
      `自动化技能发现失败，使用 guide：${error instanceof Error ? error.message : String(error)}`,
    )
  }
  return { ...params, dynamicTools: resolveAutomationTools(raw, 'codex', { visiblePaths: paths }) }
}
