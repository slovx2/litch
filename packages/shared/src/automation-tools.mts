import { realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import {
  AUTOMATION_GUIDE,
  AUTOMATION_GUIDE_NAMESPACE,
  automationSkill,
  automationSkillMatches,
  automationSkillSpec,
} from '../../protocol/src/automation-skills.mjs'
import type { ClientToolNamespaceSpec } from '../../protocol/src/client-tools.mjs'
import { automationSkillPath } from './automation-skills.mjs'

const object = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null
const canonical = (path: string) => {
  try {
    return realpathSync(path)
  } catch {
    return resolve(path)
  }
}
export const isAutomationSpec = (v: unknown): v is ClientToolNamespaceSpec =>
  object(v) &&
  v.type === 'namespace' &&
  typeof v.description === 'string' &&
  Array.isArray(v.tools) &&
  v.tools.every((t) => object(t) && typeof t.description === 'string') &&
  automationSkillMatches(v as unknown as ClientToolNamespaceSpec)

/** 只有设备服务承诺执行 guide 后，入口才可缩短。独立适配器保持原合同。 */
export function withAutomationGuide(raw: unknown[]): unknown[] {
  const tools = raw.filter((s) => !object(s) || s.name !== AUTOMATION_GUIDE_NAMESPACE)
  if (!tools.some(isAutomationSpec)) return tools
  const presentation = tools.findIndex((s) => object(s) && s.name === 'litch_presentation')
  tools.splice(presentation < 0 ? tools.length : presentation, 0, AUTOMATION_GUIDE)
  return tools
}

/** 原生搜索目录的保守判断；未知版本/入口不假设存在技能发现。 */
export function automationNativeRoot(
  engine: string,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  let home = env.HOME || env.USERPROFILE || homedir()
  try {
    home = realpathSync(home)
  } catch {
    return null
  }
  const agents = join(home, '.agents', 'skills')
  switch (engine) {
    case 'claude':
      if (
        env.CLAUDE_CONFIG_DIR &&
        canonical(env.CLAUDE_CONFIG_DIR) !== canonical(join(home, '.claude'))
      )
        return null
      return join(home, '.claude', 'skills')
    case 'pi':
      return agents
    case 'gemini':
      return env.GEMINI_CLI_HOME && canonical(env.GEMINI_CLI_HOME) !== home ? null : agents
    case 'qwen':
      return agents
    case 'dsh':
      return env.DSH_AGENTS_HOME &&
        canonical(env.DSH_AGENTS_HOME) !== canonical(join(home, '.agents'))
        ? null
        : agents
    case 'opencode':
      return env.OPENCODE_DISABLE_EXTERNAL_SKILLS &&
        !['0', 'false'].includes(env.OPENCODE_DISABLE_EXTERNAL_SKILLS)
        ? null
        : agents
    // ACP 没有统一原生发现契约；具体 agent 必须验证后再启用，guide 不依赖文件系统。
    default:
      return null
  }
}

/** 只读检查安装结果；安装失败、环境覆盖或未发现的入口走相同 guide。 */
export function resolveAutomationTools(
  raw: unknown[],
  engine: string,
  options: { env?: NodeJS.ProcessEnv; visiblePaths?: ReadonlySet<string> } = {},
): unknown[] {
  if (!raw.some(isAutomationSpec)) return raw
  if (
    !raw.some(
      (s) =>
        object(s) &&
        s.name === AUTOMATION_GUIDE_NAMESPACE &&
        JSON.stringify(s) === JSON.stringify(AUTOMATION_GUIDE),
    )
  )
    return raw
  const root = automationNativeRoot(engine, options.env)
  const tools = raw
    .filter((s) => !object(s) || s.name !== AUTOMATION_GUIDE_NAMESPACE)
    .map((spec) => {
      if (!isAutomationSpec(spec)) return spec
      const skill = automationSkill(spec.name)!
      let path = root ? automationSkillPath(root, skill) : null
      if (options.visiblePaths) {
        path =
          [...options.visiblePaths].find(
            (p) => p.endsWith(`/${skill.name}/SKILL.md`) || p.endsWith(`\\${skill.name}\\SKILL.md`),
          ) ?? null
        // 可发现不等于属于本产品；再核对原文及归属。
        if (path) path = automationSkillPath(resolve(path, '..', '..'), skill)
      }
      return automationSkillSpec(spec, path)
    })
  // 原生目录还可能被项目优先级或用户设置屏蔽；保留同一只读兜底，不强迫多一次调用。
  return [...tools, AUTOMATION_GUIDE]
}
