import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join, relative } from 'node:path'
import type { OpencodeServer } from './server.mjs'

// skills/list：OpenCode 的技能（GET /skill）和斜杠命令（GET /command，自定义的、MCP 服务给的提示词）。
// 两样在 OpenCode 里都能用“/名字”点名（技能也出现在命令清单里），协议里统一成技能，客户端点名之后发来的
// skill 输入经 OpenCode 的 /command 执行（turns.mts）。清单只问 OpenCode，不在适配器里另扫目录。
// 协议要每项技能有一个绝对路径：技能用 OpenCode 给的位置；命令找它的定义文件，找不到的（配置里写的、
// MCP 的、OpenCode 自带的）用 OpenCode 可执行文件的路径，表示“由 OpenCode 本身提供”。

type Scope = 'user' | 'repo' | 'system'

const inside = (path: string, root: string) => {
  const rel = relative(root, path)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

function configHome(): string {
  return join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'opencode')
}

function scopeOf(path: string, cwd: string): Scope {
  if (inside(path, cwd)) return 'repo'
  if (inside(path, configHome()) || inside(path, homedir())) return 'user'
  return 'system'
}

// 命令的定义文件：项目的 .opencode/command(s)，用户的 ~/.config/opencode/command(s)
function commandFile(name: string, cwd: string): string | null {
  for (const root of [join(cwd, '.opencode'), configHome()])
    for (const folder of ['command', 'commands']) {
      const path = join(root, folder, `${name}.md`)
      if (existsSync(path)) return path
    }
  return null
}

export async function listSkills(s: OpencodeServer, params: any): Promise<any> {
  const cwds: string[] =
    Array.isArray(params.cwds) && params.cwds.length ? params.cwds : [process.cwd()]
  const api = await s.api()
  const program = s.runtime.host?.cli ?? '/'
  const data = []
  for (const cwd of cwds) {
    const options = { directory: cwd, timeoutMs: 15000 }
    const errors: Array<{ path: string; message: string }> = []
    const [skills, commands] = await Promise.all([
      api.request<any[]>('GET', '/skill', options).catch((error) => {
        errors.push({ path: cwd, message: `OpenCode 的技能清单没取到：${error.message}` })
        return []
      }),
      api.request<any[]>('GET', '/command', options).catch((error) => {
        errors.push({ path: cwd, message: `OpenCode 的命令清单没取到：${error.message}` })
        return []
      }),
    ])
    const entries: any[] = []
    const seen = new Set<string>()
    for (const skill of Array.isArray(skills) ? skills : []) {
      const name = String(skill?.name ?? '')
      if (!name || seen.has(name)) continue
      seen.add(name)
      const located = typeof skill.location === 'string' && isAbsolute(skill.location)
      const path = located ? skill.location : program
      entries.push({
        name,
        description: String(skill.description ?? ''),
        path,
        scope: located ? scopeOf(path, cwd) : 'system',
        enabled: true,
      })
    }
    for (const command of Array.isArray(commands) ? commands : []) {
      const name = String(command?.name ?? '')
      if (!name || seen.has(name) || command.source === 'skill') continue
      seen.add(name)
      const file = command.source === 'mcp' ? null : commandFile(name, cwd)
      entries.push({
        name,
        description: String(command.description ?? ''),
        path: file ?? program,
        scope: file ? scopeOf(file, cwd) : 'system',
        enabled: true,
      })
    }
    data.push({ cwd, skills: entries, errors })
  }
  return { data }
}
