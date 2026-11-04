import { execFileSync, spawnSync } from 'node:child_process'
import { accessSync, constants, readFileSync, realpathSync, statSync } from 'node:fs'
import { delimiter, dirname, extname, isAbsolute, join, resolve } from 'node:path'

export interface HostCliCandidate {
  path: string
  version: string
  selected: boolean
}

const versions = new Map<string, { key: string; output: string; environment: string }>()
const prefixes = new Map<string, { at: number; path: string }>()
const VERSION = /\d+\.\d+\.\d+(?:-[0-9A-Za-z][0-9A-Za-z.-]*)?/

export function cliCommand(path: string, args: string[]): string[] {
  return /\.[cm]?js$/.test(path) ? [process.execPath, path, ...args] : [path, ...args]
}

/** 只缓存同一路径、大小与修改时间的结果；链接改向和原地更新都会重新探测。 */
export function hostCliVersionOutput(path: string, env: NodeJS.ProcessEnv = process.env): string {
  try {
    const real = realpathSync(path)
    const file = statSync(real)
    const key = `${file.size}:${file.mtimeMs}:${file.ctimeMs}`
    const cached = versions.get(real)
    const environment = JSON.stringify(Object.entries(env).sort(([a], [b]) => a.localeCompare(b)))
    if (cached?.key === key && (cached.output || cached.environment === environment))
      return cached.output
    let output = ''
    try {
      const [command, ...args] = cliCommand(real, ['--version'])
      const result = spawnSync(command!, args, {
        env,
        encoding: 'utf8',
        timeout: 2000,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      if (!result.error && result.status === 0) {
        const stdout = result.stdout.trim()
        output = VERSION.test(stdout) ? stdout : result.stderr.trim() || stdout
      }
    } catch {}
    versions.set(real, { key, output, environment })
    return output
  } catch {
    return ''
  }
}

export function compareCliVersions(a: string, b: string): number {
  if (!a || !b) return a ? 1 : b ? -1 : 0
  const [acore, apre] = a.split(/-(.*)/s)
  const [bcore, bpre] = b.split(/-(.*)/s)
  const left = acore!.split('.').map(Number)
  const right = bcore!.split('.').map(Number)
  for (let i = 0; i < 3; i++) {
    const diff = left[i]! - right[i]!
    if (diff) return diff
  }
  if (!apre || !bpre) return apre ? -1 : bpre ? 1 : 0
  const ax = apre.split('.')
  const bx = bpre.split('.')
  for (let i = 0; i < Math.max(ax.length, bx.length); i++) {
    const x = ax[i],
      y = bx[i]
    if (x === y) continue
    if (x === undefined || y === undefined) return x === undefined ? -1 : 1
    const xn = /^\d+$/.test(x),
      yn = /^\d+$/.test(y)
    if (xn && yn) return Number(x) - Number(y)
    if (xn !== yn) return xn ? -1 : 1
    return x < y ? -1 : 1
  }
  return 0
}

function npmEntry(root: string, npmPackage: string): string[] {
  try {
    const directory = join(dirname(root), 'node_modules', npmPackage)
    const manifest = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8'))
    const name = root
      .split(/[/\\]/)
      .at(-1)!
      .replace(/\.cmd$/i, '')
    const entry = typeof manifest.bin === 'string' ? manifest.bin : manifest.bin?.[name]
    return typeof entry === 'string' ? [join(directory, entry)] : []
  } catch {
    return []
  }
}

// Windows npm 的 .cmd 不交给 shell；解析同一安装内的官方入口。
function executable(root: string, npmPackage: string, entry: string): string | undefined {
  const candidates =
    process.platform === 'win32'
      ? [
          root.endsWith('.exe') || root.endsWith('.js') ? root : `${root}.exe`,
          ...npmEntry(root, npmPackage),
          ...(entry
            ? [
                join(dirname(root), 'node_modules', npmPackage, entry),
                join(dirname(root), '..', npmPackage, entry),
              ]
            : []),
          root,
        ]
      : [root]
  for (const candidate of candidates) {
    try {
      accessSync(candidate, constants.X_OK)
      const path = realpathSync(candidate)
      if (!statSync(path).isFile()) continue
      if (process.platform === 'win32' && !['.exe', '.js', '.cjs', '.mjs'].includes(extname(path)))
        continue
      return path
    } catch {}
  }
}

function globalBin(env: NodeJS.ProcessEnv): string {
  const search = env.PATH ?? env.Path ?? ''
  const key = JSON.stringify([
    search,
    env.HOME,
    env.USERPROFILE,
    env.npm_config_prefix,
    env.NPM_CONFIG_PREFIX,
  ])
  const cached = prefixes.get(key)
  if (cached && Date.now() - cached.at < 30_000) return cached.path
  let path = ''
  try {
    // npm 的 JS 入口在 Windows 上也无需 shell。
    const npm = search
      .split(delimiter)
      .filter(Boolean)
      .map((dir) => executable(join(dir, 'npm'), 'npm', 'bin/npm-cli.js'))
      .find(Boolean)
    if (npm) {
      const [command, ...args] = cliCommand(npm, ['prefix', '-g'])
      const output = execFileSync(command!, args, {
        env,
        cwd: env.HOME || env.USERPROFILE,
        encoding: 'utf8',
        timeout: 2000,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
        .trim()
        .split('\n')
        .at(-1)!
        .trim()
      if (isAbsolute(output)) path = process.platform === 'win32' ? output : join(output, 'bin')
    }
  } catch {}
  prefixes.set(key, { at: Date.now(), path })
  return path
}

/** 独立启动引擎时使用同样的择优规则；受管启动收到 Go 给的绝对路径，直接使用。 */
export function hostCliCandidates(
  command: string,
  npmPackage: string,
  entry: string,
  env: NodeJS.ProcessEnv = process.env,
  accept: (path: string) => boolean = () => true,
): HostCliCandidate[] {
  const search = env.PATH ?? env.Path ?? ''
  const roots = search
    .split(delimiter)
    .filter(Boolean)
    .map((dir) => join(dir, command))
  const home = env.HOME || env.USERPROFILE
  const fallback =
    command === 'claude' ? '.local' : command === 'opencode' ? '.opencode' : undefined
  if (home && fallback) roots.push(join(home, fallback, 'bin', command))
  const bin = globalBin(env)
  if (bin) roots.push(join(bin, command))
  const paths = new Set<string>()
  const candidates: HostCliCandidate[] = []
  const variants =
    process.platform === 'win32'
      ? roots.flatMap((root) => [`${root}.exe`, `${root}.cmd`, root])
      : roots
  for (const root of variants) {
    const path = executable(root, npmPackage, entry)
    if (!path || paths.has(path) || !accept(path)) continue
    paths.add(path)
    candidates.push({
      path,
      version: VERSION.exec(hostCliVersionOutput(path, env))?.[0] ?? '',
      selected: false,
    })
  }
  let best: HostCliCandidate | undefined
  for (const candidate of candidates) {
    if (!best || compareCliVersions(candidate.version, best.version) > 0) best = candidate
  }
  if (best) best.selected = true
  return candidates
}

export function resolveHostCli(
  command: string,
  npmPackage: string,
  entry: string,
  env: NodeJS.ProcessEnv = process.env,
  explicit = isAbsolute(command) || /[/\\]/.test(command),
): string {
  if (!explicit) {
    const selected = hostCliCandidates(command, npmPackage, entry, env).find(
      (candidate) => candidate.selected,
    )
    if (selected) return selected.path
  } else {
    const roots =
      isAbsolute(command) || /[/\\]/.test(command)
        ? [resolve(command)]
        : (env.PATH ?? env.Path ?? '')
            .split(delimiter)
            .filter(Boolean)
            .map((dir) => join(dir, command))
    for (const root of roots) {
      const path = executable(root, npmPackage, entry)
      if (path) return path
    }
  }
  throw new Error(`宿主 CLI 不可执行或未找到: ${command}`)
}

export function hostCliDiagnostic(
  path: string,
  command: string,
  npmPackage: string,
  entry: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const candidates = hostCliCandidates(command, npmPackage, entry, env)
  // 启动时 Go 还可能找到 PATH 外的显式入口；按当前文件重新读版本，避免沿用升级前的诊断。
  try {
    const reported: unknown = JSON.parse(env.LITCH_HOST_CLI_CANDIDATES ?? '[]')
    if (Array.isArray(reported)) {
      for (const item of reported) {
        if (typeof item?.path !== 'string') continue
        const real = realpathSync(item.path)
        if (!candidates.some((candidate) => candidate.path === real)) {
          candidates.push({
            path: real,
            version: VERSION.exec(hostCliVersionOutput(real, env))?.[0] ?? '',
            selected: false,
          })
        }
      }
    }
  } catch {}
  const actual = VERSION.exec(hostCliVersionOutput(path, env))?.[0] ?? ''
  const newer = candidates.filter(
    (candidate) => candidate.version && compareCliVersions(candidate.version, actual) > 0,
  )
  return `；实际路径 ${path}${newer.length ? `；其他位置有更新版本：${newer.map((candidate) => `${candidate.version} · ${candidate.path}`).join('，')}；请修改命令行路径设置` : ''}`
}
