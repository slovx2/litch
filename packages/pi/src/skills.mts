import { dirname, isAbsolute } from 'node:path'
import { ProtocolError } from '../../shared/src/protocol-contract.mjs'
import { DefaultResourceLoader, getAgentDir, loadSkills, SettingsManager } from './sdk.mjs'

export async function skillsAt(
  cwd: string,
): Promise<{ settings: SettingsManager; skills: any[]; errors: any[] }> {
  const agentDir = getAgentDir(),
    settings = SettingsManager.create(cwd, agentDir)
  const loader = new DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager: settings,
    noExtensions: true,
  })
  await loader.reload()
  const loaded = loader.getSkills()
  const skills = loaded.skills.map((skill) => ({
    name: skill.name,
    description: skill.description,
    path: skill.filePath,
    scope: skill.filePath.startsWith(agentDir) ? 'user' : 'repo',
    enabled: true,
    pluginId: null,
  }))
  for (const excluded of settings.getSkillPaths().filter((path) => path.startsWith('-'))) {
    const disabled = loadSkills({
      cwd,
      agentDir,
      skillPaths: [excluded.slice(1)],
      includeDefaults: false,
    })
    for (const skill of disabled.skills)
      if (!skills.some((s) => s.path === skill.filePath))
        skills.push({
          name: skill.name,
          description: skill.description,
          path: skill.filePath,
          scope: skill.filePath.startsWith(agentDir) ? 'user' : 'repo',
          enabled: false,
          pluginId: null,
        })
  }
  return {
    settings,
    skills,
    errors: loaded.diagnostics
      .filter((d) => d.type === 'error')
      .map((d) => ({ path: d.path ?? cwd, message: d.message })),
  }
}
export async function writeSkill(cwd: string, params: any): Promise<{ effectiveEnabled: boolean }> {
  if (typeof params.enabled !== 'boolean') throw new ProtocolError(-32602, 'enabled 必须为布尔值')
  const { settings, skills } = await skillsAt(cwd)
  const candidates = skills.filter((skill) =>
    params.path ? skill.path === params.path : skill.name === params.name,
  )
  if (candidates.length !== 1) throw new ProtocolError(-32602, '技能选择不存在或不唯一')
  const skill = candidates[0]
  if (!isAbsolute(skill.path)) throw new ProtocolError(-32602, '技能路径必须为绝对路径')
  const path = skill.path.endsWith('/SKILL.md') ? dirname(skill.path) : skill.path
  const paths = settings.getSkillPaths().filter((p) => p !== `-${path}` && p !== `+${path}`)
  paths.push(`${params.enabled ? '+' : '-'}${path}`)
  settings.setSkillPaths(paths)
  await settings.flush()
  const updated = await skillsAt(cwd)
  return { effectiveEnabled: updated.skills.find((s) => s.path === skill.path)?.enabled === true }
}
