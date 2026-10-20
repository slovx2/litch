// 自定义权限档位：codex 配置里的 `permissions.<名字>` 加 `default_permissions`，语义照 codex
// （rust-v0.163.0，与 rust-v0.155.1 一致）：
// - 档位解析：`extends` 一路往上合并，父在前、子覆盖（codex-rs/config/src/permissions_toml.rs 的
//   resolve_profile、merge_permission_profiles）。能继承的内置档位只有 `:read-only`、`:workspace`
//   （codex-rs/core/src/config/permissions.rs 的 extensible_builtin_parent_profile）。
// - 条目编译：`filesystem` 的键是绝对路径、`~/...` 或特殊路径（`:root`、`:workspace_roots`、`:tmpdir`、
//   `:slash_tmp`、`:minimal`），值是 read / write / deny（none 是 deny 的别名），或者“子路径 → 访问”的表
//   （compile_filesystem_permission）。
// - 判定：命中的条目里最深的为准，同样深时 deny > write > read，一条都不命中就是 deny
//   （codex-rs/protocol/src/permissions.rs 的 resolve_access）。
// 规则只有这一份：命令的操作系统沙箱（command-sandbox.mts）和文件类工具的检查（runtime-permissions.mts）
// 都从 compileFileSystemRules 的结果来。
import { lstatSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { isConfigObject } from './config-store.mjs'
import { ProtocolError } from './protocol-contract.mjs'
import type { RuntimeSandboxPolicy } from './sandbox-policy.mjs'

export type FileAccess = 'read' | 'write' | 'deny'
type FilesystemValue = FileAccess | Record<string, FileAccess>

// 合并好 extends 之后的档位，存进会话设置（创建时的快照，之后全局配置变了也不扩大已有会话的授权）
export interface ResolvedPermissionProfile {
  filesystem: Record<string, FilesystemValue>
  workspaceRoots: string[]
  networkEnabled: boolean | null
}

export interface PermissionProfileSnapshot {
  id: string
  profile: ResolvedPermissionProfile
  // thread/start、turn/start 的 runtimeWorkspaceRoots；没给是 null，按 [cwd] 算
  runtimeWorkspaceRoots: string[] | null
}

export interface FileSystemRule {
  path: string
  access: FileAccess
}

// 落到具体路径上的规则：路径都是绝对、规范化过的（存在的部分取真实路径），同一路径只留一条
export interface FileSystemRules {
  entries: FileSystemRule[]
  networkAccess: boolean
  workspaceRoots: string[]
}

const BUILTIN_PARENTS: Record<string, Record<string, FilesystemValue>> = {
  ':read-only': { ':root': 'read' },
  // FileSystemSandboxPolicy::workspace_write(&[], false, false) 转回 TOML 的样子；
  // .git、.agents、.codex、.aws 那几条只读保护是“路径不存在就跳过”的，转换时被丢掉，这里也没有
  ':workspace': {
    ':root': 'read',
    ':workspace_roots': { '.': 'write' },
    ':slash_tmp': 'write',
    ':tmpdir': 'write',
  },
}

const ACCESS_RANK: Record<FileAccess, number> = { read: 0, write: 1, deny: 2 }

function invalid(message: string): never {
  throw new ProtocolError(-32602, message)
}

function accessValue(value: unknown, where: string): FileAccess {
  if (value === 'read' || value === 'write' || value === 'deny') return value
  if (value === 'none') return 'deny'
  return invalid(`${where} 的访问只能是 read、write 或 deny`)
}

// 校验 `permissions` 表：只看名字和形状，条目的细节在解析档位时查
export function permissionProfileTable(value: unknown): Record<string, Record<string, unknown>> {
  if (value == null) return {}
  if (!isConfigObject(value)) invalid('permissions 必须是表')
  for (const [name, profile] of Object.entries(value)) {
    if (name.startsWith(':')) invalid(`权限档位 ${name} 用了内置档位保留的“:”前缀`)
    if (!isConfigObject(profile)) invalid(`permissions.${name} 必须是表`)
  }
  return value as Record<string, Record<string, unknown>>
}

export function isCustomPermissionProfile(permissions: unknown, id: unknown): id is string {
  return (
    typeof id === 'string' &&
    !id.startsWith(':') &&
    isConfigObject(permissions) &&
    Object.hasOwn(permissions, id)
  )
}

function normalizeFilesystem(value: unknown, where: string): Record<string, FilesystemValue> {
  if (value == null) return {}
  if (!isConfigObject(value)) invalid(`${where} 必须是表`)
  const result: Record<string, FilesystemValue> = {}
  for (const [path, entry] of Object.entries(value)) {
    // 只在别的平台展开 glob 时用的深度上限，这里不展开 glob（见 parseEntries），不需要
    if (path === 'glob_scan_max_depth') continue
    if (isConfigObject(entry)) {
      const scoped: Record<string, FileAccess> = {}
      for (const [subpath, access] of Object.entries(entry))
        scoped[subpath] = accessValue(access, `${where}."${path}"."${subpath}"`)
      result[path] = scoped
    } else result[path] = accessValue(entry, `${where}."${path}"`)
  }
  return result
}

// 子覆盖父：两边都是表就逐键合并（merge_toml_values），否则子整个替换
function mergeFilesystem(
  parent: Record<string, FilesystemValue>,
  child: Record<string, FilesystemValue>,
): Record<string, FilesystemValue> {
  const merged: Record<string, FilesystemValue> = { ...parent }
  for (const [path, value] of Object.entries(child)) {
    const existing = merged[path]
    merged[path] =
      typeof existing === 'object' && typeof value === 'object' ? { ...existing, ...value } : value
  }
  return merged
}

export function resolvePermissionProfile(
  permissions: unknown,
  id: string,
): ResolvedPermissionProfile {
  const table = permissionProfileTable(permissions)
  const chain: Array<Record<string, unknown>> = []
  const seen: string[] = []
  let name = id
  let referencedBy: string | null = null
  for (;;) {
    if (seen.includes(name))
      invalid(`权限档位继承成环：${[...seen.slice(seen.indexOf(name)), name].join(' -> ')}`)
    seen.push(name)
    const builtin = referencedBy === null ? undefined : BUILTIN_PARENTS[name]
    if (builtin) {
      chain.push({ filesystem: builtin })
      break
    }
    const profile = table[name]
    if (!profile) {
      if (referencedBy === null) invalid(`未知权限配置：${name}`)
      if (name.startsWith(':')) invalid(`权限档位 ${referencedBy} 不能继承内置档位 ${name}`)
      invalid(`权限档位 ${referencedBy} 继承的 ${name} 没有定义`)
    }
    chain.push(profile)
    if (profile.extends == null) break
    if (typeof profile.extends !== 'string') invalid(`permissions.${name}.extends 必须是字符串`)
    referencedBy = name
    name = profile.extends
  }
  let filesystem: Record<string, FilesystemValue> = {}
  let workspaceRoots: Record<string, unknown> = {}
  let networkEnabled: boolean | null = null
  for (const profile of chain.reverse()) {
    filesystem = mergeFilesystem(filesystem, normalizeFilesystem(profile.filesystem, 'filesystem'))
    if (profile.workspace_roots != null) {
      if (!isConfigObject(profile.workspace_roots)) invalid('workspace_roots 必须是表')
      workspaceRoots = { ...workspaceRoots, ...profile.workspace_roots }
    }
    if (profile.network != null) {
      if (!isConfigObject(profile.network)) invalid('network 必须是表')
      const enabled = profile.network.enabled
      if (enabled != null && typeof enabled !== 'boolean') invalid('network.enabled 必须是布尔值')
      if (typeof enabled === 'boolean') networkEnabled = enabled
    }
  }
  const resolved: ResolvedPermissionProfile = {
    filesystem,
    workspaceRoots: Object.entries(workspaceRoots)
      .filter(([, enabled]) => enabled === true)
      .map(([path]) => path),
    networkEnabled,
  }
  // 条目写错了在选档位时就报，不等到回合里
  parseEntries(resolved)
  return resolved
}

// 档位对应的旧式沙箱模式：有可写条目算工作区写，否则只读（与路径无关，选档位时就能定）
export function profileSandboxMode(profile: ResolvedPermissionProfile): string {
  const values = Object.values(profile.filesystem).flatMap((value) =>
    typeof value === 'string' ? [value] : Object.values(value),
  )
  return values.includes('write') ? 'workspace-write' : 'read-only'
}

type EntryBase =
  | { kind: 'path'; path: string }
  | { kind: 'root' | 'workspace_roots' | 'tmpdir' | 'slash_tmp' | 'ignored' }

interface SymbolicEntry {
  base: EntryBase
  subpath: string | null
  access: FileAccess
}

const GLOB_CHARS = /[*?[\]]/

function homePath(path: string): string | null {
  if (path === '~') return homedir()
  return path.startsWith('~/') ? join(homedir(), path.slice(2)) : null
}

function parseBase(key: string): EntryBase {
  switch (key) {
    case ':root':
      return { kind: 'root' }
    case ':workspace_roots':
    case ':project_roots':
      return { kind: 'workspace_roots' }
    case ':tmpdir':
      return { kind: 'tmpdir' }
    case ':slash_tmp':
      return { kind: 'slash_tmp' }
  }
  // `:minimal` 只在没有 `:root` 可读时才有用，这种档位整体不支持（见 compileFileSystemRules）；
  // 不认识的特殊路径与 codex 一样忽略，给新版本写的配置不至于让旧版本起不来
  if (key.startsWith(':')) return { kind: 'ignored' }
  const home = homePath(key)
  if (home) return { kind: 'path', path: home }
  if (!isAbsolute(key)) invalid(`filesystem 路径 ${key} 必须是绝对路径、~/... 或以“:”开头`)
  return { kind: 'path', path: resolve(key) }
}

// read、write 只接受精确路径或结尾的 `/**`（整棵子树）；deny 的 glob codex 支持，这里还不支持，直接报错
function stripGlob(path: string, access: FileAccess, where: string): string {
  if (!GLOB_CHARS.test(path)) return path
  if (access === 'deny') invalid(`${where} 是 glob 条目，Claude 入口还不支持 glob 的 deny`)
  const stripped = path.endsWith('/**') ? path.slice(0, -3) : path
  if (GLOB_CHARS.test(stripped))
    invalid(`${where} 的 glob 只能用于 deny；${access} 请写精确路径或结尾的 /**`)
  return stripped
}

function relativeSubpath(subpath: string, where: string): string {
  const segments = subpath.split('/')
  if (!subpath || ['', '.', '..'].includes(segments[0] as string) || segments.includes('..'))
    invalid(`${where} 的子路径必须是不含 . 和 .. 的相对路径`)
  return subpath
}

function parseEntries(profile: ResolvedPermissionProfile): SymbolicEntry[] {
  const entries: SymbolicEntry[] = []
  for (const [key, value] of Object.entries(profile.filesystem)) {
    if (typeof value === 'string') {
      const base = parseBase(stripGlob(key, value, `filesystem."${key}"`))
      entries.push({ base, subpath: null, access: value })
      continue
    }
    const base = parseBase(key)
    for (const [raw, access] of Object.entries(value)) {
      const where = `filesystem."${key}"."${raw}"`
      // `:workspace_roots` 下面写 `~/...` 的，按那个绝对路径算（与 codex 相同）
      const home = base.kind === 'workspace_roots' ? homePath(raw) : null
      if (home) {
        entries.push({
          base: { kind: 'path', path: stripGlob(home, access, where) },
          subpath: null,
          access,
        })
        continue
      }
      const subpath = stripGlob(raw, access, where)
      if (subpath === '.' || subpath === '') {
        entries.push({ base, subpath: null, access })
        continue
      }
      relativeSubpath(subpath, where)
      if (base.kind !== 'path' && base.kind !== 'workspace_roots' && base.kind !== 'ignored')
        invalid(`filesystem 路径 ${key} 不能带子路径`)
      entries.push({ base, subpath, access })
    }
  }
  return entries
}

// 存在的部分取真实路径，不存在的尾巴照原样接上。要用 native 版：JS 版不纠正大小写，macOS 默认的
// 卷不分大小写，`ws/secret` 与规则里的 `ws/Secret` 是同一个目录，字面却对不上
export function normalizedPath(path: string): string {
  try {
    return realpathSync.native(path)
  } catch {
    const parent = dirname(path)
    if (parent === path) return path
    return resolve(normalizedPath(parent), relative(parent, path))
  }
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

function entryPaths(entry: SymbolicEntry, workspaceRoots: readonly string[]): string[] {
  const join2 = (base: string) => (entry.subpath ? join(base, entry.subpath) : base)
  switch (entry.base.kind) {
    case 'root':
      return ['/']
    case 'workspace_roots':
      return workspaceRoots.map(join2)
    case 'tmpdir': {
      const tmpdir = process.env.TMPDIR
      return tmpdir && isAbsolute(tmpdir) ? [tmpdir] : []
    }
    case 'slash_tmp':
      return isDirectory('/tmp') ? ['/tmp'] : []
    case 'path':
      return [join2(entry.base.path)]
    case 'ignored':
      return []
  }
}

export function compileFileSystemRules(
  snapshot: PermissionProfileSnapshot,
  cwd: string,
): FileSystemRules {
  const workspaceRoots = [
    ...new Set(
      [
        ...(snapshot.runtimeWorkspaceRoots ?? [cwd]),
        ...snapshot.profile.workspaceRoots.map((root) => homePath(root) ?? root),
      ].map((root) => {
        if (!isAbsolute(root)) invalid(`工作区根目录 ${root} 必须是绝对路径`)
        return resolve(root)
      }),
    ),
  ]
  const byPath = new Map<string, FileAccess>()
  for (const entry of parseEntries(snapshot.profile))
    for (const path of entryPaths(entry, workspaceRoots)) {
      const normalized = normalizedPath(path)
      const existing = byPath.get(normalized)
      // 同一路径多条时取最严的一条（resolve_access 同深度按 deny > write > read）
      if (!existing || ACCESS_RANK[entry.access] > ACCESS_RANK[existing])
        byPath.set(normalized, entry.access)
    }
  const rules: FileSystemRules = {
    entries: protectMetadata(byPath),
    networkAccess: snapshot.profile.networkEnabled === true,
    workspaceRoots,
  }
  // 只读一部分目录（不继承 `:root` 可读、靠 `:minimal`）的档位要把系统目录一条条放开，暂不支持
  if (pathAccess(rules, '/') === 'deny')
    invalid(`权限档位 ${snapshot.id} 没有让 :root 可读，Claude 入口暂不支持这种档位`)
  return rules
}

// 可写目录下这几个顶层目录默认只读（codex 的 PROTECTED_METADATA_PATH_NAMES、metadata_write_denial）：
// .git 的钩子、.codex 和 .agents 的配置、.aws 的凭据助手都会被沙箱外的程序拿去执行。档位里给这个路径
// 写了条目（哪种访问都算）就照档位；它下面更深的 write 条目照旧可写。不存在的也保护，免得被建出来。
// .git 是指向别处的文件（worktree、子模块）时，指向的 gitdir 一并只读
const PROTECTED_METADATA_NAMES = ['.git', '.agents', '.codex', '.aws']

function protectMetadata(byPath: ReadonlyMap<string, FileAccess>): FileSystemRule[] {
  const entries = [...byPath].map(([path, access]) => ({ path, access }))
  const before: FileSystemRules = { entries, networkAccess: false, workspaceRoots: [] }
  const added = new Map<string, FileAccess>()
  for (const { path: root, access } of entries) {
    if (access !== 'write' || root === '/') continue
    for (const name of PROTECTED_METADATA_NAMES) {
      const logical = join(root, name)
      const targets = new Set([logical, normalizedPath(logical)])
      if (name === '.git') {
        const gitdir = pointedGitdir(logical)
        if (gitdir) targets.add(gitdir)
      }
      for (const path of targets)
        if (!byPath.has(path) && pathAccess(before, path) === 'write') added.set(path, 'read')
    }
  }
  return [...entries, ...[...added].map(([path, access]) => ({ path, access }))]
}

// `.git` 文件里的 `gitdir: <路径>`（相对路径相对于 .git 所在目录）
function pointedGitdir(dotGit: string): string | null {
  try {
    if (!lstatSync(dotGit).isFile()) return null
    const match = /^gitdir:\s*(.+?)\s*$/m.exec(readFileSync(dotGit, 'utf8'))
    return match?.[1] ? normalizedPath(resolve(dirname(dotGit), match[1])) : null
  } catch {
    return null
  }
}

function within(root: string, path: string): boolean {
  return root === '/' || path === root || path.startsWith(root + sep)
}

// 不存在的那段路径取不到真实大小写：macOS、Windows 默认不分大小写，deny 条目按不分大小写比，
// 宁可多拦（分大小写的卷上只会多拦大小写不同的同名路径）；放行的条目仍按字面比
const foldDeny = process.platform === 'darwin' || process.platform === 'win32'

function matches(entry: FileSystemRule, path: string): boolean {
  if (within(entry.path, path)) return true
  return foldDeny && entry.access === 'deny' && within(entry.path.toLowerCase(), path.toLowerCase())
}

// path 要已经规范化（normalizedPath）；最深的命中条目为准，一条都不命中是 deny
export function pathAccess(rules: FileSystemRules, path: string): FileAccess {
  let best: FileSystemRule | null = null
  for (const entry of rules.entries)
    if (
      matches(entry, path) &&
      (!best ||
        entry.path.length > best.path.length ||
        (entry.path.length === best.path.length && entry.access === 'deny'))
    )
      best = entry
  return best?.access ?? 'deny'
}

export function hasDeniedPaths(rules: FileSystemRules): boolean {
  return rules.entries.some((entry) => entry.access === 'deny')
}

// 计划模式、只读的命令：可写的一律降成只读，禁读的照旧
export function readOnlyRules(rules: FileSystemRules): FileSystemRules {
  return {
    ...rules,
    entries: rules.entries.map((entry) =>
      entry.access === 'write' ? { ...entry, access: 'read' } : entry,
    ),
  }
}

// 用户在审批里临时放开的目录（permission-grants.mts）当作可写条目加进来，仍按最深的为准
export function withWritableRoots(
  rules: FileSystemRules,
  roots: readonly string[],
): FileSystemRules {
  if (roots.length === 0) return rules
  const entries = new Map(rules.entries.map((entry) => [entry.path, entry.access]))
  for (const root of roots) {
    const path = normalizedPath(root)
    if (entries.get(path) !== 'deny') entries.set(path, 'write')
  }
  return { ...rules, entries: protectMetadata(entries) }
}

// 协议里给客户端看的旧式沙箱策略（thread/start 的 sandbox、thread/settings/updated 的 sandboxPolicy）
export function legacySandboxPolicy(rules: FileSystemRules): RuntimeSandboxPolicy {
  const writableRoots = rules.entries
    .filter((entry) => entry.access === 'write')
    .map((entry) => entry.path)
  if (writableRoots.length === 0) return { type: 'readOnly', networkAccess: rules.networkAccess }
  return {
    type: 'workspaceWrite',
    writableRoots,
    networkAccess: rules.networkAccess,
    // 临时目录可写的话已经作为条目列在 writableRoots 里
    excludeTmpdirEnvVar: true,
    excludeSlashTmp: true,
  }
}

export function customPermissionProfileList(
  permissions: unknown,
): Array<{ id: string; description: string | null; allowed: boolean }> {
  return Object.entries(permissionProfileTable(permissions)).map(([id, profile]) => ({
    id,
    description: typeof profile.description === 'string' ? profile.description : null,
    allowed: true,
  }))
}

// 配置里的 default_permissions（内置档位名或 permissions 里定义的名字，validateConfigValues 已查过）
export function defaultPermissionsId(config: Record<string, unknown>): string | null {
  const id = config.default_permissions
  return typeof id === 'string' && id.length > 0 ? id : null
}

function requestedProfileId(params: Record<string, unknown>): string | null {
  if (typeof params.permissions === 'string') return params.permissions.trim() || null
  const active = params.activePermissionProfile
  return isConfigObject(active) && typeof active.id === 'string' ? active.id.trim() || null : null
}

// 会话设置里记下选中的自定义档位（选的那一刻合并好的快照），并把 sandboxPolicy 换成它的旧式投影。
// 请求选了内置档位或给了旧式 sandbox、sandboxPolicy 就丢掉快照；只改审批策略的不动它。
// threadProfileId：会话记录上的档位名（thread/start 用 default_permissions 时只在那里）
export function applyPermissionProfile(
  settings: { permissionProfile?: PermissionProfileSnapshot; sandboxPolicy?: RuntimeSandboxPolicy },
  params: Record<string, unknown>,
  threadProfileId: string | null | undefined,
  cwd: string,
  permissions: unknown,
): void {
  const requested = requestedProfileId(params)
  const roots = Array.isArray(params.runtimeWorkspaceRoots)
    ? (params.runtimeWorkspaceRoots as string[])
    : null
  const previousRoots = settings.permissionProfile?.runtimeWorkspaceRoots ?? null
  const select = (id: string): PermissionProfileSnapshot => ({
    id,
    profile: resolvePermissionProfile(permissions, id),
    runtimeWorkspaceRoots: roots ?? previousRoots,
  })
  if (requested !== null) {
    if (isCustomPermissionProfile(permissions, requested))
      settings.permissionProfile = select(requested)
    else delete settings.permissionProfile
  } else if (params.sandbox != null || params.sandboxPolicy != null)
    delete settings.permissionProfile
  else if (settings.permissionProfile) {
    if (roots) settings.permissionProfile.runtimeWorkspaceRoots = roots
  } else if (isCustomPermissionProfile(permissions, threadProfileId))
    settings.permissionProfile = select(threadProfileId)
  if (settings.permissionProfile)
    settings.sandboxPolicy = legacySandboxPolicy(
      compileFileSystemRules(settings.permissionProfile, cwd),
    )
}

// 配置里的 `permissions` 表与 `default_permissions`：名字、形状、指向的档位能不能解析
export function validatePermissionsConfig(values: Record<string, unknown>): void {
  permissionProfileTable(values.permissions)
  const id = values.default_permissions
  if (id == null) return
  if (typeof id !== 'string' || !id) invalid('default_permissions 必须是档位名')
  if (![':read-only', ':workspace', ':danger-full-access'].includes(id))
    resolvePermissionProfile(values.permissions, id)
}
