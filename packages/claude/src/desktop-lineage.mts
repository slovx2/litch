// Claude 桌面端派出的会话挂在哪个父会话下面（扩展 nativeLineage 的 parentThreadId）。
//
// 原生记录里没有父会话的字段，父子关系只记在 Claude 桌面端自己的数据目录里：
//   <桌面端数据目录>/claude-code-sessions/<账号>/<组织>/local_<号>.json
// 每个文件是桌面端的一个会话：cliSessionId 是它眼下用的 Claude Code 会话号（priorCliSessionIds 是换下来的旧号），
// spawnedFrom.sessionId 是派出它的那个桌面端会话（local_ 号），lineageDetached 为真是用户在桌面端让它脱离过。
//
// 这些都是桌面端自己的格式，没有公开、随时会变，只是锦上添花：只读不写；目录不在、文件读不到、
// 字段不对的一律当作没有父会话，不报错。每个文件按大小和修改时间记着，没变的不重读；
// 读用异步的，一个文件一个文件来：头一遍要读两百来个文件、几百毫秒，不能堵住入口的事件循环。

import { readdirSync } from 'node:fs'
import { readdir, readFile, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'

/** 桌面端会话文件里用到的那几项 */
export interface DesktopSession {
  /** 桌面端的会话号（local_…） */
  localId: string
  /** 眼下用的 Claude Code 会话号 */
  cliSessionId: string
  /** 换下来的旧会话号，先换下来的在前 */
  priorCliSessionIds: string[]
  /** 派出它的桌面端会话号。不是派出来的、脱离过的是 null */
  parentLocalId: string | null
}

/** 这个文件大一点就不读了：桌面端的会话文件一般几 KB 到几百 KB */
const MAX_FILE_BYTES = 8 * 1024 * 1024
const SESSIONS_DIR = 'claude-code-sessions'

/**
 * 桌面端的数据目录可能在哪（Electron 的 userData）。CHA_CLAUDE_DESKTOP_DATA 给了就只看它（测试、夹具用），
 * 给的是 0 就不看。macOS 是 ~/Library/Application Support/Claude；Windows 是 %APPDATA%\Claude，
 * 第三方推理模式用 Claude-3p（Windows 上在 %LOCALAPPDATA% 下），商店版的在 Packages 的虚拟目录里
 */
export function desktopDataRoots(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string[] {
  const given = env.CHA_CLAUDE_DESKTOP_DATA
  if (given === '0') return []
  if (given) return [given]
  const home = homedir()
  if (platform === 'darwin') {
    const base = join(home, 'Library', 'Application Support')
    return [join(base, 'Claude'), join(base, 'Claude-3p')]
  }
  if (platform === 'win32') {
    const roots: string[] = []
    if (env.APPDATA) roots.push(join(env.APPDATA, 'Claude'), join(env.APPDATA, 'Claude-3p'))
    if (env.LOCALAPPDATA) {
      roots.push(join(env.LOCALAPPDATA, 'Claude-3p'))
      for (const name of list(join(env.LOCALAPPDATA, 'Packages')))
        if (/^Claude_/i.test(name))
          roots.push(join(env.LOCALAPPDATA, 'Packages', name, 'LocalCache', 'Roaming', 'Claude'))
    }
    return roots
  }
  return [join(env.XDG_CONFIG_HOME || join(home, '.config'), 'Claude')]
}

function list(dir: string): string[] {
  try {
    return readdirSync(dir)
  } catch {
    return []
  }
}

async function listAsync(dir: string): Promise<string[]> {
  try {
    return await readdir(dir)
  } catch {
    return []
  }
}

const text = (value: unknown): string | null =>
  typeof value === 'string' && value.trim() ? value.trim() : null

/** 一个桌面端会话文件。读不到、不是 JSON、没有会话号的是 null */
export async function readDesktopSession(path: string): Promise<DesktopSession | null> {
  let raw: unknown
  try {
    raw = JSON.parse(await readFile(path, 'utf8'))
  } catch {
    return null
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const fields = raw as Record<string, unknown>
  const cliSessionId = text(fields.cliSessionId)
  if (!cliSessionId) return null
  const localId = text(fields.sessionId) ?? basename(path, '.json')
  const prior = Array.isArray(fields.priorCliSessionIds)
    ? fields.priorCliSessionIds.flatMap((id) => text(id) ?? [])
    : []
  const from = fields.spawnedFrom
  const parent =
    from && typeof from === 'object' && !Array.isArray(from)
      ? text((from as Record<string, unknown>).sessionId)
      : null
  return {
    localId,
    cliSessionId,
    priorCliSessionIds: prior,
    parentLocalId: parent && fields.lineageDetached !== true && parent !== localId ? parent : null,
  }
}

/**
 * 桌面端会话的索引：每次 refresh 把各个数据目录下的会话文件看一遍（只 stat，大小和修改时间没变的不重读），
 * 再算出“Claude Code 会话号 → 父会话可能用的会话号”。跟着原生会话列表的扫描走，不单独定时
 */
export class DesktopLineage {
  private readonly roots: () => readonly string[]
  /** 文件 → 上次读到的（记号是大小和修改时间） */
  private readonly files = new Map<string, { stamp: string; session: DesktopSession | null }>()

  constructor(roots: () => readonly string[] = () => desktopDataRoots()) {
    this.roots = roots
  }

  /** 把会话文件重新看一遍，回“子会话的 Claude Code 会话号 → 父会话用过的会话号（眼下的在前）” */
  async refresh(): Promise<Map<string, string[]>> {
    const seen = new Set<string>()
    for (const root of this.roots()) {
      const top = join(root, SESSIONS_DIR)
      for (const account of await listAsync(top))
        for (const org of await listAsync(join(top, account)))
          for (const name of await listAsync(join(top, account, org))) {
            if (!name.startsWith('local_') || !name.endsWith('.json')) continue
            const path = join(top, account, org, name)
            seen.add(path)
            await this.load(path)
          }
    }
    for (const path of [...this.files.keys()]) if (!seen.has(path)) this.files.delete(path)
    return this.parents()
  }

  private async load(path: string): Promise<void> {
    let stamp: string
    try {
      const info = await stat(path)
      if (!info.isFile()) return
      stamp = `${info.size}:${info.mtimeMs}`
      if (this.files.get(path)?.stamp === stamp) return
      if (info.size > MAX_FILE_BYTES) {
        this.files.set(path, { stamp, session: null })
        return
      }
    } catch {
      return
    }
    this.files.set(path, { stamp, session: await readDesktopSession(path) })
  }

  private parents(): Map<string, string[]> {
    const byLocal = new Map<string, DesktopSession>()
    for (const { session } of this.files.values())
      if (session) byLocal.set(session.localId, session)
    const result = new Map<string, string[]>()
    for (const child of byLocal.values()) {
      const parent = child.parentLocalId ? byLocal.get(child.parentLocalId) : undefined
      if (!parent) continue
      const candidates = [parent.cliSessionId, ...[...parent.priorCliSessionIds].reverse()]
      // 子会话换过会话号的，旧号导进来也是一个会话，一样挂上
      for (const id of [child.cliSessionId, ...child.priorCliSessionIds]) {
        const own = candidates.filter((candidate) => candidate !== id)
        if (own.length > 0 && !result.has(id)) result.set(id, own)
      }
    }
    return result
  }
}
