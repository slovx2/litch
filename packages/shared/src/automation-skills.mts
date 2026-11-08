// 只有设备服务安装共享技能；失败只影响指引入口，不阻止动作。
import { createHash } from 'node:crypto'
import {
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { type AutomationSkill, automationSkill } from '../../protocol/src/automation-skills.mjs'

const MARKER = '.litch-automation.json'
const OWNER = 'litch-automation-skills'
const hash = (text: string) => createHash('sha256').update(text).digest('hex')
const present = (path: string) => {
  try {
    lstatSync(path)
    return true
  } catch {
    return false
  }
}
const object = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)
function safeParents(path: string): boolean {
  for (let cursor = resolve(path); ; ) {
    if (present(cursor) && (!lstatSync(cursor).isDirectory() || lstatSync(cursor).isSymbolicLink()))
      return false
    const parent = dirname(cursor)
    if (parent === cursor) return true
    cursor = parent
  }
}

/** 摘要只用于判断是否需要重写，不用于决定更新归属。 */
export function ownedAutomationSkill(dir: string): boolean {
  try {
    if (!safeParents(dir) || lstatSync(join(dir, MARKER)).isSymbolicLink()) return false
    const marker: unknown = JSON.parse(readFileSync(join(dir, MARKER), 'utf8'))
    if (!object(marker) || marker.owner !== OWNER || !object(marker.files)) return false
    const files = marker.files,
      found: string[] = []
    const visit = (relative: string) => {
      for (const entry of readdirSync(join(dir, relative), { withFileTypes: true })) {
        if (entry.isSymbolicLink()) throw new Error('技能目录包含链接')
        const path = relative ? `${relative}/${entry.name}` : entry.name
        if (entry.isDirectory()) visit(path)
        else if (path !== MARKER && entry.isFile()) found.push(path)
        else if (path !== MARKER) throw new Error('技能目录包含非普通文件')
      }
    }
    visit('')
    return (
      found.length === Object.keys(files).length &&
      found.every((p) => hash(readFileSync(join(dir, p), 'utf8')) === files[p])
    )
  } catch {
    return false
  }
}

export function automationSkillPath(root: string, skill: AutomationSkill): string | null {
  const target = join(root, skill.name)
  if (!ownedAutomationSkill(target)) return null
  try {
    return Object.entries(skill.files).every(
      ([p, text]) => readFileSync(join(target, p), 'utf8') === text,
    )
      ? join(target, 'SKILL.md')
      : null
  } catch {
    return null
  }
}

/** 跨进程互斥；只回收已确认原进程不存在的锁。繁忙或未知锁直接回退。 */
function locked<T>(root: string, skill: AutomationSkill, run: () => T): T | null {
  const lock = join(root, `.${skill.name}.litch-lock`)
  try {
    if (!safeParents(root)) return null
    mkdirSync(root, { recursive: true })
    if (present(lock)) {
      if (!safeParents(lock)) return null
      const pid = Number(readFileSync(join(lock, 'pid'), 'utf8'))
      if (!Number.isSafeInteger(pid) || pid <= 0) return null
      try {
        process.kill(pid, 0)
        return null
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') return null
      }
      rmSync(lock, { recursive: true })
    }
    mkdirSync(lock)
    writeFileSync(join(lock, 'pid'), String(process.pid))
  } catch {
    return null
  }
  try {
    return run()
  } catch {
    return null
  } finally {
    try {
      rmSync(lock, { recursive: true, force: true })
    } catch {
      /* 下次操作恢复 */
    }
  }
}

/** 中断后恢复旧目录；目标存在说明替换已完成，清掉本次更新的备份。 */
function recover(root: string, skill: AutomationSkill): boolean {
  const target = join(root, skill.name),
    backup = join(root, `.${skill.name}.litch-old`)
  const staging = join(root, `.${skill.name}.litch-new`)
  if (present(backup)) {
    if (!present(target)) renameSync(backup, target)
    else rmSync(backup, { recursive: true })
  }
  if (present(staging)) {
    rmSync(staging, { recursive: true })
  }
  return true
}

export function installAutomationSkill(root: string, skill: AutomationSkill): string | null {
  return locked(root, skill, () => {
    if (!recover(root, skill)) return null
    const target = join(root, skill.name)
    const existing = automationSkillPath(root, skill)
    if (existing) return existing
    const staging = join(root, `.${skill.name}.litch-new`),
      backup = join(root, `.${skill.name}.litch-old`)
    mkdirSync(staging)
    try {
      for (const [p, text] of Object.entries(skill.files)) {
        mkdirSync(dirname(join(staging, p)), { recursive: true })
        writeFileSync(join(staging, p), text)
      }
      writeFileSync(
        join(staging, MARKER),
        JSON.stringify({
          owner: OWNER,
          files: Object.fromEntries(
            Object.entries(skill.files).map(([p, text]) => [p, hash(text)]),
          ),
        }),
      )
      if (present(target)) {
        renameSync(target, backup)
      }
      renameSync(staging, target)
      if (present(backup)) rmSync(backup, { recursive: true })
      return join(target, 'SKILL.md')
    } catch {
      if (!present(target) && present(backup)) renameSync(backup, target)
      return null
    } finally {
      // 固定两个技能各自的暂存目录；从不扫描或清理其他技能名。
      if (present(staging)) rmSync(staging, { recursive: true })
    }
  })
}

export const sharedAutomationRoots = (home = homedir()) => [
  join(realpathSync(home), '.agents', 'skills'),
  join(realpathSync(home), '.claude', 'skills'),
]
export function installSharedAutomationSkills(home = homedir()): string[] {
  const paths: string[] = []
  let roots: string[]
  try {
    roots = sharedAutomationRoots(home)
  } catch {
    return paths
  }
  for (const root of roots)
    for (const ns of ['litch_browser', 'litch_computer']) {
      const path = installAutomationSkill(root, automationSkill(ns)!)
      if (path) paths.push(path)
    }
  return paths
}
export function removeAutomationSkills(root: string): string[] {
  const removed: string[] = []
  for (const ns of ['litch_browser', 'litch_computer']) {
    const skill = automationSkill(ns)!
    locked(root, skill, () => {
      if (!recover(root, skill)) return
      const target = join(root, skill.name)
      if (present(target)) {
        rmSync(target, { recursive: true, force: true })
        removed.push(target)
      }
    })
  }
  return removed
}
