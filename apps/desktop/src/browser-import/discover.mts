// 发现本机有哪些来源、各有哪些资料。只看文件在不在、读 Chromium 系的 Local State 和 Firefox 的 profiles.ini 拿资料名，
// 不打开 Cookie 库和密码库，也不碰钥匙串。导入前按浏览器和资料标识重新找一遍（findProfile），不认界面传来的路径。
import { readFileSync, statSync } from 'node:fs'
import { isAbsolute, join, normalize, sep } from 'node:path'
import {
  BROWSERS,
  type BrowserDef,
  browserDef,
  chromiumRoots,
  firefoxRoots,
  type ImportEnv,
} from './browsers.mjs'
import type { BrowserFamily, BrowserId, ImportKind } from './types.mjs'

/** 主进程自己用的一份资料：带路径，不交给界面 */
export interface FoundProfile {
  id: string
  name: string
  account?: string
  isDefault: boolean
  /** 资料目录的绝对路径 */
  dir: string
  has: Record<ImportKind, boolean>
}

export interface FoundSource {
  browser: BrowserId
  name: string
  family: BrowserFamily
  /** Chromium 系是 User Data 那层，Firefox 是 profiles.ini 所在的目录 */
  root: string
  profiles: FoundProfile[]
}

const isDir = (path: string): boolean => {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

const isFile = (path: string): boolean => {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

const text = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined

/** 各类数据在资料目录里的文件（任一个在就算有） */
const FILES: Record<BrowserFamily, Record<ImportKind, string[][]>> = {
  chromium: {
    // 新版本的 Cookie 库在 Network 下，老版本在资料目录里
    cookies: [['Network', 'Cookies'], ['Cookies']],
    // 登录了账号的还有一份账号下的密码
    passwords: [['Login Data'], ['Login Data For Account']],
  },
  firefox: {
    cookies: [['cookies.sqlite']],
    passwords: [['logins.json']],
  },
}

function hasKinds(family: BrowserFamily, dir: string): Record<ImportKind, boolean> {
  const files = FILES[family]
  const has = (kind: ImportKind) => files[kind].some((parts) => isFile(join(dir, ...parts)))
  return { cookies: has('cookies'), passwords: has('passwords') }
}

/** 资料目录名要像 Chromium 起的名字：不许带路径分隔符或 `..`，免得拼出资料根目录外面的路径 */
const safeDirName = (name: string): boolean =>
  name !== '' && name !== '.' && name !== '..' && !/[\\/]/.test(name)

/** 读 Local State 的 profile 一节；读不了、不是 JSON 都当作没有 */
function readLocalState(root: string): {
  cache: Record<string, Record<string, unknown>>
  lastUsed?: string
} {
  try {
    const state = JSON.parse(readFileSync(join(root, 'Local State'), 'utf8')) as {
      profile?: { info_cache?: unknown; last_used?: unknown }
    }
    const cache = state.profile?.info_cache
    const out: { cache: Record<string, Record<string, unknown>>; lastUsed?: string } = {
      cache:
        cache && typeof cache === 'object' && !Array.isArray(cache)
          ? (cache as Record<string, Record<string, unknown>>)
          : {},
    }
    const lastUsed = text(state.profile?.last_used)
    if (lastUsed) out.lastUsed = lastUsed
    return out
  } catch {
    return { cache: {} }
  }
}

export function chromiumProfiles(root: string): FoundProfile[] {
  const { cache, lastUsed } = readLocalState(root)
  const dirs = Object.keys(cache).filter((dir) => safeDirName(dir) && isDir(join(root, dir)))
  // Local State 里什么都没有时，按 Chromium 的命名习惯找一遍
  if (dirs.length === 0 && isDir(join(root, 'Default'))) dirs.push('Default')
  const defaultDir =
    lastUsed && dirs.includes(lastUsed) ? lastUsed : dirs.includes('Default') ? 'Default' : dirs[0]
  return sortProfiles(
    dirs.map((id): FoundProfile => {
      const info = cache[id] ?? {}
      const dir = join(root, id)
      const profile: FoundProfile = {
        id,
        name: text(info.name) ?? id,
        isDefault: id === defaultDir,
        dir,
        has: hasKinds('chromium', dir),
      }
      const account = text(info.user_name)
      if (account) profile.account = account
      return profile
    }),
  )
}

/** profiles.ini 按节拆成键值表 */
export function parseIni(source: string): Map<string, Record<string, string>> {
  const sections = new Map<string, Record<string, string>>()
  let current: Record<string, string> | null = null
  for (const raw of source.split(/\r?\n/)) {
    const line = raw.trim()
    if (line === '' || line.startsWith(';') || line.startsWith('#')) continue
    const head = /^\[(.+)\]$/.exec(line)
    if (head) {
      current = {}
      sections.set(head[1] as string, current)
      continue
    }
    const eq = line.indexOf('=')
    if (current && eq > 0) current[line.slice(0, eq).trim()] = line.slice(eq + 1).trim()
  }
  return sections
}

/** Firefox 资料的路径：相对的要落在根目录里面，绝对的原样用 */
export function firefoxProfilePath(root: string, entry: string, relative: boolean): string | null {
  if (!relative) return isAbsolute(entry) ? normalize(entry) : null
  const path = normalize(join(root, entry))
  return path.startsWith(normalize(root) + sep) ? path : null
}

export function firefoxProfiles(root: string): FoundProfile[] {
  let ini: Map<string, Record<string, string>>
  try {
    ini = parseIni(readFileSync(join(root, 'profiles.ini'), 'utf8'))
  } catch {
    return []
  }
  // 新版本的 Firefox 每个安装各记一个默认资料（[Install…] 节的 Default），比 [Profile…] 的 Default=1 准
  const installDefaults = new Set<string>()
  for (const [name, values] of ini) {
    if (name.startsWith('Install') && values.Default) installDefaults.add(values.Default)
  }
  const profiles: (FoundProfile & { marked: boolean })[] = []
  const seen = new Set<string>()
  for (const [name, values] of ini) {
    if (!name.startsWith('Profile') || !values.Path || seen.has(values.Path)) continue
    const dir = firefoxProfilePath(root, values.Path, values.IsRelative !== '0')
    if (!dir || !isDir(dir)) continue
    seen.add(values.Path)
    profiles.push({
      id: values.Path,
      name: text(values.Name) ?? values.Path,
      isDefault: false,
      marked: values.Default === '1',
      dir,
      has: hasKinds('firefox', dir),
    })
  }
  // 只留一个默认：装了几份 Firefox 时各安装的默认里，优先 [Profile…] 也标了 Default=1 的，再按 profiles.ini 里的先后
  const candidates =
    installDefaults.size > 0
      ? profiles.filter((profile) => installDefaults.has(profile.id))
      : profiles.filter((profile) => profile.marked)
  const chosen = candidates.find((profile) => profile.marked) ?? candidates[0]
  if (chosen) chosen.isDefault = true
  return sortProfiles(profiles.map(({ marked: _marked, ...profile }) => profile))
}

/** 默认的排最前，其余按名字 */
const sortProfiles = (profiles: FoundProfile[]): FoundProfile[] =>
  profiles.sort((a, b) => Number(b.isDefault) - Number(a.isDefault) || a.name.localeCompare(b.name))

function discoverOne(def: BrowserDef, env: ImportEnv): FoundSource | null {
  const base = { browser: def.browser, name: def.name, family: def.family }
  if (def.browser === 'firefox') {
    const root = firefoxRoots(env).find((dir) => isFile(join(dir, 'profiles.ini')))
    if (!root) return null
    return { ...base, root, profiles: firefoxProfiles(root) }
  }
  const root = chromiumRoots(def.browser, env).find(isDir)
  if (!root) return null
  return { ...base, root, profiles: chromiumProfiles(root) }
}

/** 本机有资料的来源，按 BROWSERS 的顺序；没装、没用过（资料根目录不在）、一份资料都没有的不列 */
export function discoverSources(env: ImportEnv): FoundSource[] {
  const sources: FoundSource[] = []
  for (const def of BROWSERS) {
    const source = discoverOne(def, env)
    if (source && source.profiles.length > 0) sources.push(source)
  }
  return sources
}

/** 按浏览器和资料标识重新找一遍（导入时用，不认界面传回来的路径） */
export function findProfile(
  env: ImportEnv,
  browser: BrowserId,
  profileId: string,
): { source: FoundSource; profile: FoundProfile } | null {
  const def = browserDef(browser)
  if (!def) return null
  const source = discoverOne(def, env)
  const profile = source?.profiles.find((item) => item.id === profileId)
  return source && profile ? { source, profile } : null
}
