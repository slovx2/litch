// 把产品手册（仓库里的 skills/litch-manual）装进本机各 harness 读技能的目录，主进程每次启动时装一遍，
// 应用升级后手册跟着换。只装本机，远程设备不装。
//
// 放法：
// - 实体放在 ~/.agents/skills/litch-manual（不少 harness 直接读这里），里面放一个记号文件 .litch-managed，
//   内容是版本号。scripts/litch、scripts/litch.cmd 每次重写，里面是应用自带适配器的绝对路径。
// - 不读 ~/.agents/skills 的 harness，在它自己的技能目录里建一个指向实体的链接（Windows 上复制一份，也带记号）。
//   那个 harness 的配置目录（比如 ~/.claude）不存在就跳过：用户没装、没用过它，不替它建目录。
// - 目标位置已经有同名的东西但不是我们放的（目录里没有记号，或者是指到别处的链接），当成用户自己的，不碰。
// - 关掉开关时只删带记号的（和指向我们实体的链接）。
//
// 各 harness 读哪个目录，核对的出处写在 placements 上面。这个模块不碰 Electron，单元测试直接拿它跑。
import { randomBytes } from 'node:crypto'
import {
  chmodSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import type { ManualStatus, ManualTarget } from './manual-ipc.mjs'
import { readPreferences, writePreference } from './preferences.mjs'

export const MANUAL_NAME = 'litch-manual'
/** 记号文件：有它的才是 Litch 放的，内容是版本号 */
export const MANUAL_MARKER = '.litch-managed'
/** 设置里的开关存在外壳偏好（preferences.json）里的这一项，默认开 */
export const MANUAL_PREFERENCE = 'manualSkill'
/** 命令壳里留给适配器路径的占位 */
const ADAPTER_PLACEHOLDER = '{{ADAPTER}}'

/** 装在哪、给谁：都从这几样算出来，测试给一份临时的 */
export interface ManualPlace {
  /** 用户主目录 */
  home: string
  /** 判断各 harness 配置目录用的环境（CLAUDE_CONFIG_DIR 之类）：取用户登录 shell 里的，问不到用自己的 */
  env: Readonly<Record<string, string | undefined>>
  platform: NodeJS.Platform
}

export interface ManualInstall extends ManualPlace {
  /** 手册的源目录（里面有 SKILL.md）：装好的应用里在适配器旁边，开发时是仓库里的 skills/litch-manual */
  source: string
  /** 应用自带适配器的命令行（绝对路径），写进 scripts/litch */
  adapterBin: string
  /** 记号里写的版本，就是应用的版本 */
  version: string
}

/** 一处技能目录 */
interface Placement {
  /** 这一处给哪几个 harness（同一个目录几家都读的，只放一份） */
  harnesses: string[]
  /** 技能目录本身（手册放在它下面的 litch-manual 里） */
  skillsDir: string
  /** 这个目录要在才装：harness 自己的配置目录。null 是没有就建 */
  requires: string | null
}

/** 给人看的路径：主目录换成 ~ */
const tilde = (path: string, home: string): string =>
  path === home
    ? '~'
    : path.startsWith(`${home}/`) || path.startsWith(`${home}\\`)
      ? `~${path.slice(home.length)}`
      : path

/** 环境变量里给的目录：空的不算，相对路径按主目录算 */
function envDir(place: ManualPlace, name: string): string | null {
  const value = place.env[name]?.trim()
  if (!value) return null
  return isAbsolute(value) ? value : resolve(place.home, value)
}

/** 实体的位置：~/.agents/skills/litch-manual */
export function manualEntity(place: ManualPlace): string {
  return join(place.home, '.agents', 'skills', MANUAL_NAME)
}

/**
 * 各 harness 读的用户级技能目录（2026-10-19 对着源码核对；都是只看“技能目录/名字/SKILL.md”这一层，
 * 整个技能目录做成链接的都认）。第一项是实体所在的 ~/.agents/skills，后面的放链接（Windows 上是副本）：
 * - Codex：$CODEX_HOME/skills（已弃用）和 ~/.agents/skills 都读，目录链接跟随
 *   （openai/codex rust-v0.162.0-alpha.20 codex-rs/ext/skills/src/host_roots.rs、loader/host.rs）。
 * - Pi：~/.pi/agent/skills（PI_CODING_AGENT_DIR）和 ~/.agents/skills 都读（pi-coding-agent 0.99.1 dist/core/package-manager.js）。
 * - DSH：~/.dsh/skills 和 $DSH_AGENTS_HOME/skills（默认 ~/.agents/skills）（deepseek-harness skill-filesystem）。
 * - OpenCode：~/.claude/skills 和 ~/.agents/skills 都读（1.18.33 的程序里的字符串；同名的后到者覆盖并记一条告警，
 *   两处是同一份，没有害处）。
 * - Gemini CLI：~/.gemini/skills 和 ~/.agents/skills；设了 GEMINI_CLI_HOME 时两处都换到它下面（0.38.0 的包）。
 * - Claude Code：只读 $CLAUDE_CONFIG_DIR/skills（默认 ~/.claude/skills），不读 ~/.agents（2.1.299 的包）。
 * - Qwen Code：文档只写了 ~/.qwen/skills（本机没装，源码没核）。
 * 只看用户登录环境里的这几个变量；用户在设备设置里给某个 harness 单独设的环境变量（harness.<id>.env）看不到。
 */
export function placements(place: ManualPlace): Placement[] {
  const agents = join(place.home, '.agents', 'skills')
  const claude = envDir(place, 'CLAUDE_CONFIG_DIR') ?? join(place.home, '.claude')
  const dshAgents = envDir(place, 'DSH_AGENTS_HOME')
  const geminiHome = envDir(place, 'GEMINI_CLI_HOME')
  const main: Placement = {
    harnesses: ['codex', 'pi', 'opencode'],
    skillsDir: agents,
    requires: null,
  }
  const rest: Placement[] = [
    { harnesses: ['claude-code'], skillsDir: join(claude, 'skills'), requires: claude },
  ]
  if (dshAgents) {
    rest.push({ harnesses: ['dsh'], skillsDir: join(dshAgents, 'skills'), requires: dshAgents })
  } else main.harnesses.push('dsh')
  if (geminiHome) {
    const gemini = join(geminiHome, '.gemini')
    rest.push({ harnesses: ['gemini'], skillsDir: join(gemini, 'skills'), requires: gemini })
  } else main.harnesses.push('gemini')
  const qwen = join(place.home, '.qwen')
  rest.push({ harnesses: ['qwen'], skillsDir: join(qwen, 'skills'), requires: qwen })
  // 环境变量指回了 ~/.agents 的（DSH_AGENTS_HOME=~/.agents 之类）并进实体那一处，同一个目录只放一份
  const merged: Placement[] = [main]
  for (const placement of rest) {
    const same = merged.find((p) => resolve(p.skillsDir) === resolve(placement.skillsDir))
    if (same) same.harnesses.push(...placement.harnesses)
    else merged.push(placement)
  }
  return merged
}

// ---------- 认东西 ----------

type Found =
  /** 没有 */
  | { kind: 'none' }
  /** 我们放的目录（带记号） */
  | { kind: 'ours-dir' }
  /** 我们建的链接：指向实体，或者指向一个带记号的目录 */
  | { kind: 'ours-link' }
  /** 不是我们的 */
  | { kind: 'foreign'; what: string }

function hasMarker(dir: string): boolean {
  try {
    return statSync(join(dir, MANUAL_MARKER)).isFile()
  } catch {
    return false
  }
}

/** 链接指向哪（绝对路径） */
function linkTarget(path: string): string {
  const target = readlinkSync(path)
  return isAbsolute(target) ? target : resolve(dirname(path), target)
}

function inspect(path: string, entity: string): Found {
  let stat: ReturnType<typeof lstatSync>
  try {
    stat = lstatSync(path)
  } catch {
    return { kind: 'none' }
  }
  if (stat.isSymbolicLink()) {
    const target = linkTarget(path)
    if (resolve(target) === resolve(entity) || hasMarker(target)) return { kind: 'ours-link' }
    return { kind: 'foreign', what: `a link to ${target}` }
  }
  if (stat.isDirectory()) {
    return hasMarker(path)
      ? { kind: 'ours-dir' }
      : { kind: 'foreign', what: 'a folder without the Litch marker' }
  }
  return { kind: 'foreign', what: 'a file' }
}

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error))

// ---------- 写 ----------

/** 命令壳：占位换成适配器的路径。sh 的那一份在 Windows 上用正斜杠（Git Bash 认 C:/…，反斜杠在双引号里会被吃掉） */
function writeScripts(dir: string, adapterBin: string, platform: NodeJS.Platform): void {
  const scripts = join(dir, 'scripts')
  const shell = join(scripts, 'litch')
  const forShell = platform === 'win32' ? adapterBin.replaceAll('\\', '/') : adapterBin
  // 路径里的双引号、反引号、$、反斜杠在 sh 的双引号里有意思，转义掉
  const quoted = forShell.replace(/["`$\\]/g, '\\$&')
  writeFileSync(shell, readFileSync(shell, 'utf8').replaceAll(ADAPTER_PLACEHOLDER, quoted))
  chmodSync(shell, 0o755)
  const cmd = join(scripts, 'litch.cmd')
  const forCmd = platform === 'win32' ? adapterBin.replaceAll('/', '\\') : adapterBin
  writeFileSync(cmd, readFileSync(cmd, 'utf8').replaceAll(ADAPTER_PLACEHOLDER, forCmd))
}

/** 临时目录放在 ~/.agents 下面（和技能目录同一个文件系统，换名字是一步），不放进任何 harness 扫的目录里 */
function stagingDir(place: ManualPlace): string {
  return join(
    place.home,
    '.agents',
    `.litch-manual-${process.pid}-${randomBytes(4).toString('hex')}`,
  )
}

/** 上次装到一半留下的临时目录 */
function sweepStaging(place: ManualPlace): void {
  const root = join(place.home, '.agents')
  let names: string[]
  try {
    names = readdirSync(root)
  } catch {
    return
  }
  for (const name of names) {
    if (name.startsWith('.litch-manual-'))
      rmSync(join(root, name), { recursive: true, force: true })
  }
}

/** 先在旁边摆好，再换上去：harness 不会读到半份 */
function replaceWith(path: string, staged: string, place: ManualPlace): void {
  if (existsSync(path) || isLink(path)) {
    const old = stagingDir(place)
    renameSync(path, old)
    renameSync(staged, path)
    rmSync(old, { recursive: true, force: true })
  } else {
    renameSync(staged, path)
  }
}

function isLink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink()
  } catch {
    return false
  }
}

/** 把一份带记号的手册摆到 path：from 是源（实体用仓库或应用里的那份，副本用装好的实体） */
function placeCopy(from: string, path: string, options: ManualInstall, fresh: boolean): void {
  const staged = stagingDir(options)
  try {
    cpSync(from, staged, {
      recursive: true,
      // 系统自己生成的杂物不带；副本不带实体的记号，下面重写
      filter: (src) => !src.endsWith('.DS_Store') && !src.endsWith(MANUAL_MARKER),
    })
    if (fresh) writeScripts(staged, options.adapterBin, options.platform)
    writeFileSync(join(staged, MANUAL_MARKER), `${options.version}\n`)
    replaceWith(path, staged, options)
  } catch (error) {
    rmSync(staged, { recursive: true, force: true })
    throw error
  }
}

/** 建指向实体的链接。已经是指向实体的链接就不动 */
function placeLink(entity: string, path: string, place: ManualPlace): void {
  if (isLink(path) && resolve(linkTarget(path)) === resolve(entity)) return
  if (existsSync(path) || isLink(path)) {
    const old = stagingDir(place)
    renameSync(path, old)
    symlinkSync(entity, path, 'dir')
    rmSync(old, { recursive: true, force: true })
  } else {
    symlinkSync(entity, path, 'dir')
  }
}

// ---------- 对外 ----------

/** 每个 harness 一条结果，同一处给几家的各记一条 */
function targetsOf(
  placement: Placement,
  path: string,
  state: ManualTarget['state'],
  reason?: string,
): ManualTarget[] {
  return placement.harnesses.map((harness) => ({
    harness,
    path,
    state,
    ...(reason === undefined ? {} : { reason }),
  }))
}

/**
 * 装一遍（开关开着时每次启动、打开开关时）。实体装不成（目录写不进去、被用户自己的同名目录占着），
 * 别的位置都跳过：链接和副本都以实体为准
 */
export function installManual(options: ManualInstall): ManualStatus {
  const entity = manualEntity(options)
  const [main, ...rest] = placements(options)
  const status: ManualStatus = {
    enabled: true,
    name: MANUAL_NAME,
    dir: null,
    version: options.version,
    targets: [],
  }
  if (!main) return status
  if (!existsSync(join(options.source, 'SKILL.md'))) {
    status.error = `The manual is missing from this Litch build (${options.source})`
    status.targets = placements(options).flatMap((p) =>
      targetsOf(p, join(p.skillsDir, MANUAL_NAME), 'skipped', 'manual source missing'),
    )
    return status
  }
  sweepStaging(options)
  const found = inspect(entity, entity)
  if (found.kind === 'foreign') {
    status.error = `${tilde(entity, options.home)} is ${found.what}; Litch leaves it alone`
    status.targets = [
      ...targetsOf(main, entity, 'foreign', found.what),
      ...rest.flatMap((p) =>
        targetsOf(p, join(p.skillsDir, MANUAL_NAME), 'skipped', 'the main copy is not installed'),
      ),
    ]
    return status
  }
  try {
    mkdirSync(main.skillsDir, { recursive: true })
    // 链接也当实体用不了：实体必须是真的目录
    placeCopy(options.source, entity, options, true)
  } catch (error) {
    status.error = `Could not write ${tilde(entity, options.home)}: ${message(error)}`
    status.targets = [
      ...targetsOf(main, entity, 'failed', message(error)),
      ...rest.flatMap((p) =>
        targetsOf(p, join(p.skillsDir, MANUAL_NAME), 'skipped', 'the main copy is not installed'),
      ),
    ]
    return status
  }
  status.dir = entity
  status.targets.push(...targetsOf(main, entity, 'installed'))
  for (const placement of rest) {
    const path = join(placement.skillsDir, MANUAL_NAME)
    if (placement.requires && !existsSync(placement.requires)) {
      status.targets.push(
        ...targetsOf(
          placement,
          path,
          'skipped',
          `${tilde(placement.requires, options.home)} does not exist`,
        ),
      )
      continue
    }
    const here = inspect(path, entity)
    if (here.kind === 'foreign') {
      status.targets.push(...targetsOf(placement, path, 'foreign', here.what))
      continue
    }
    try {
      mkdirSync(placement.skillsDir, { recursive: true })
      if (options.platform === 'win32') {
        // Windows 上建目录链接要开发者模式或管理员，一律复制
        placeCopy(entity, path, options, false)
        status.targets.push(...targetsOf(placement, path, 'installed'))
      } else {
        placeLink(entity, path, options)
        status.targets.push(...targetsOf(placement, path, 'linked'))
      }
    } catch (error) {
      status.targets.push(...targetsOf(placement, path, 'failed', message(error)))
    }
  }
  return status
}

/** 删掉带记号的那几份（关掉开关时）。先删链接和副本，最后删实体 */
export function removeManual(options: ManualPlace & { version: string }): ManualStatus {
  const entity = manualEntity(options)
  const all = placements(options)
  const status: ManualStatus = {
    enabled: false,
    name: MANUAL_NAME,
    dir: null,
    version: options.version,
    targets: [],
  }
  const results = new Map<Placement, ManualTarget[]>()
  for (const placement of [...all.slice(1), ...all.slice(0, 1)]) {
    const path = join(placement.skillsDir, MANUAL_NAME)
    const here = inspect(path, entity)
    if (here.kind === 'none') {
      results.set(placement, targetsOf(placement, path, 'skipped', 'not installed'))
      continue
    }
    if (here.kind === 'foreign') {
      results.set(placement, targetsOf(placement, path, 'foreign', here.what))
      continue
    }
    try {
      if (here.kind === 'ours-link') unlinkSync(path)
      else rmSync(path, { recursive: true, force: true })
      results.set(placement, targetsOf(placement, path, 'removed'))
    } catch (error) {
      results.set(placement, targetsOf(placement, path, 'failed', message(error)))
    }
  }
  // 按 placements 的顺序报
  for (const placement of all) status.targets.push(...(results.get(placement) ?? []))
  const failed = status.targets.find((target) => target.state === 'failed')
  if (failed)
    status.error = `Could not remove ${tilde(failed.path, options.home)}: ${failed.reason}`
  return status
}

/** 只看不动：现在各处是什么样（开关关着、或者还没装完的时候给设置页看） */
export function inspectManual(
  options: ManualPlace & { version: string; enabled: boolean },
): ManualStatus {
  const entity = manualEntity(options)
  const status: ManualStatus = {
    enabled: options.enabled,
    name: MANUAL_NAME,
    dir: inspect(entity, entity).kind === 'ours-dir' ? entity : null,
    version: options.version,
    targets: [],
  }
  for (const placement of placements(options)) {
    const path = join(placement.skillsDir, MANUAL_NAME)
    const here = inspect(path, entity)
    if (here.kind === 'none') {
      const reason =
        placement.requires && !existsSync(placement.requires)
          ? `${tilde(placement.requires, options.home)} does not exist`
          : 'not installed'
      status.targets.push(...targetsOf(placement, path, 'skipped', reason))
    } else if (here.kind === 'foreign') {
      status.targets.push(...targetsOf(placement, path, 'foreign', here.what))
    } else {
      status.targets.push(
        ...targetsOf(placement, path, here.kind === 'ours-link' ? 'linked' : 'installed'),
      )
    }
  }
  return status
}

// ---------- 主进程里用的那一份 ----------

export interface ManualSkillOptions {
  /** 外壳偏好所在的用户数据目录（开关存在 preferences.json 的 manualSkill 里） */
  dataDir: string
  version: string
  /**
   * 手册的源目录和应用自带适配器的命令行。任何一个是 null 就不装：没有内置适配器的运行（开发时没指
   * LITCH_ADAPTER_ROOT）、自检和截图（它们不许碰用户的主目录）。reason 是给设置页看的原因
   */
  source: string | null
  adapterBin: string | null
  reason?: string
  platform: NodeJS.Platform
  home: string
  /** 用户登录 shell 里的环境（login-env.mts），问不到是 null，用自己的 */
  environment: () => Promise<Readonly<Record<string, string | undefined>> | null>
  log: (line: string) => void
}

export interface ManualSkill {
  /** 启动时调一次：开着就装，关着只看一眼 */
  start(): void
  status(): Promise<ManualStatus>
  setEnabled(on: boolean): Promise<ManualStatus>
}

export function createManualSkill(options: ManualSkillOptions): ManualSkill {
  const enabled = () => readPreferences(options.dataDir)[MANUAL_PREFERENCE] !== false
  let place: Promise<ManualPlace> | null = null
  const placeOf = () => {
    place ??= options
      .environment()
      .catch(() => null)
      .then((env) => ({ home: options.home, env: env ?? process.env, platform: options.platform }))
    return place
  }
  /** 装、删一件接一件地做，状态取最后一件的结果 */
  let current: Promise<ManualStatus> | null = null
  const run = (on: boolean): Promise<ManualStatus> => {
    const previous = current ?? Promise.resolve(null)
    current = previous.then(async () => {
      const where = await placeOf()
      if (!options.source || !options.adapterBin) {
        return {
          ...inspectManual({ ...where, version: options.version, enabled: on }),
          error: options.reason ?? 'Litch has no bundled adapter in this run',
        }
      }
      try {
        const status = on
          ? installManual({
              ...where,
              source: options.source,
              adapterBin: options.adapterBin,
              version: options.version,
            })
          : removeManual({ ...where, version: options.version })
        if (status.error) options.log(status.error)
        return status
      } catch (error) {
        options.log(`manual ${on ? 'install' : 'removal'} failed: ${message(error)}`)
        return {
          ...inspectManual({ ...where, version: options.version, enabled: on }),
          error: message(error),
        }
      }
    })
    return current
  }
  return {
    start() {
      if (enabled()) void run(true)
      else {
        // 关着：不删也不装，只记下现状给设置页
        current = placeOf().then((where) =>
          inspectManual({ ...where, version: options.version, enabled: false }),
        )
      }
    },
    status() {
      if (!current) this.start()
      return current as Promise<ManualStatus>
    },
    setEnabled(on) {
      writePreference(options.dataDir, MANUAL_PREFERENCE, on)
      return run(on)
    },
  }
}
