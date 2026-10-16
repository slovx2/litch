import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { parseDocument } from 'yaml'
import { ProtocolError } from './protocol-contract.mjs'

export interface NativeSkill {
  name: string
  description: string
  path: string
  scope: 'user' | 'repo'
  enabled: boolean
}

export interface SkillCatalog {
  cwd: string
  skills: NativeSkill[]
  errors: Array<{ path: string; message: string }>
}

export const nativeSkillHome = (): string =>
  resolve(process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'))

export function absoluteSkillPath(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value || !isAbsolute(value))
    throw new ProtocolError(-32602, label + ' 必须是非空绝对路径')
  return resolve(value)
}

export function skillManifest(path: string, scope: NativeSkill['scope']): NativeSkill {
  if (basename(path) !== 'SKILL.md' || !statSync(path).isFile())
    throw new ProtocolError(-32602, '技能路径必须指向 SKILL.md 文件')
  const text = readFileSync(path, 'utf8')
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text)
  if (!match) throw new Error('SKILL.md 缺少有效 YAML frontmatter')
  const document = parseDocument(match[1]!, { uniqueKeys: true })
  if (document.errors.length) throw new Error(document.errors[0]!.message)
  const metadata: unknown = document.toJS()
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata))
    throw new Error('Skill frontmatter 必须是对象')
  const data = metadata as Record<string, unknown>
  const name = data.name ?? basename(dirname(path))
  if (typeof name !== 'string' || !name.trim() || /[\r\n]/.test(name))
    throw new Error('技能名称无效')
  if (data.description != null && typeof data.description !== 'string')
    throw new Error('技能描述必须是字符串')
  return {
    name,
    description: (data.description as string | undefined) ?? '',
    path,
    scope,
    enabled: true,
  }
}

export function scanSkillRoot(
  root: string,
  scope: NativeSkill['scope'],
  excluded = new Set<string>(),
): Omit<SkillCatalog, 'cwd'> {
  const skills: NativeSkill[] = []
  const errors: SkillCatalog['errors'] = []
  if (!existsSync(root)) return { skills, errors }
  try {
    for (const name of readdirSync(root).sort()) {
      if (excluded.has(join(root, name))) continue
      const path = join(root, name, 'SKILL.md')
      if (!existsSync(path)) continue
      try {
        skills.push(skillManifest(path, scope))
      } catch (error) {
        errors.push({ path, message: String(error) })
      }
    }
  } catch (error) {
    errors.push({ path: root, message: String(error) })
  }
  return { skills, errors }
}

export function nativeSkillOverrides(cwd: string): Record<string, string> {
  const result: Record<string, string> = Object.create(null)
  for (const path of [
    join(nativeSkillHome(), 'settings.json'),
    ...projectSkillDirectories(cwd)
      .reverse()
      .flatMap((directory) => [
        join(directory, '.claude', 'settings.json'),
        join(directory, '.claude', 'settings.local.json'),
      ]),
  ]) {
    if (!existsSync(path)) continue
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'))
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
      throw new Error('原生 settings.json 必须是对象：' + path)
    const overrides = (parsed as Record<string, unknown>).skillOverrides
    if (overrides == null) continue
    if (typeof overrides !== 'object' || Array.isArray(overrides))
      throw new Error('原生 skillOverrides 必须是对象：' + path)
    for (const [key, value] of Object.entries(overrides)) {
      if (!['on', 'off', 'name-only', 'user-invocable-only'].includes(String(value)))
        throw new Error('原生 skillOverrides 值无效：' + path)
      result[key] = value as string
    }
  }
  return result
}

export function projectSkillDirectories(cwd: string): string[] {
  const directories: string[] = []
  let directory = resolve(cwd)
  while (true) {
    directories.push(directory)
    const parent = dirname(directory)
    if (parent === directory) return directories
    directory = parent
  }
}

export function canonicalSkillKey(path: string): string {
  return realpathSync(path)
}

export function skillFingerprint(catalog: SkillCatalog): string {
  const contents = catalog.skills.map((skill) => {
    try {
      return [skill.path, readFileSync(skill.path, 'utf8')]
    } catch (error) {
      return [skill.path, String(error)]
    }
  })
  return createHash('sha256').update(JSON.stringify({ catalog, contents })).digest('hex')
}
