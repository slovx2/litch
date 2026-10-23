// 本机的原生会话此刻被谁占着（扩展 nativeOwner，规矩在 protocol/extensions/native-owner.json）。
//
// Claude Code 的交互进程（Claude 桌面端起的、终端里的）在 <配置目录>/sessions/<进程号>.json 登记自己：
// pid、procStart（进程启动时间，防进程号被复用）、sessionId、status（busy / idle）、entrypoint，退出时删掉。
// Claude 桌面端自己判断“写入方还活着”用的也是这份登记。procStart 是 CLI 用 `LC_ALL=C TZ=UTC ps -o lstart= -p <pid>`
// 取的那一行字（Windows 上记的是 procStartFt，这里不核对、只看进程活着）。
// 登记里找不到时兜底看原生记录本身：最近 10 秒内被别人改过（不是入口自己的 CLI 写的）也算占着。
// 只读，不写登记，不碰别的进程。

import { execFileSync } from 'node:child_process'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { NativeOwner } from '../../protocol/src/native-owner.mjs'

/** 原生记录在这么久之内被别人改过，算对方还在写 */
export const NATIVE_GROWTH_MS = 10_000
/** 两次读登记至少隔这么久：会话对象出门、请求进门都要问，不能每次都读一遍目录 */
const REGISTRY_GAP_MS = 1000

export interface RegistryEntry {
  pid: number
  sessionId: string
  procStart: string | null
  status: string | null
  entrypoint: string | null
  /** 收件箱的套接字（别的会话 SendMessage 发往 uds:<它>）。收件箱关着时没有 */
  socket: string | null
  /** 登记名（ListAgents 里列的、SendMessage 按名字发往的） */
  name: string | null
  /** 宿主里的会话号（宿主设的 CLAUDE_CODE_HOST_SESSION_ID，Claude 桌面端是 local_…） */
  hostSessionId: string | null
}

const text = (value: unknown): string | null =>
  typeof value === 'string' && value.trim() ? value.trim() : null

export function readRegistry(dir: string): RegistryEntry[] {
  let names: string[]
  try {
    names = readdirSync(dir)
  } catch {
    return []
  }
  const entries: RegistryEntry[] = []
  for (const name of names) {
    if (!/^\d+\.json$/.test(name)) continue
    try {
      const raw = JSON.parse(readFileSync(join(dir, name), 'utf8')) as Record<string, unknown>
      const pid = raw.pid
      if (typeof pid !== 'number' || !Number.isSafeInteger(pid) || pid <= 1) continue
      if (typeof raw.sessionId !== 'string' || !raw.sessionId) continue
      entries.push({
        pid,
        sessionId: raw.sessionId,
        procStart: typeof raw.procStart === 'string' ? raw.procStart : null,
        status: typeof raw.status === 'string' ? raw.status : null,
        entrypoint: typeof raw.entrypoint === 'string' ? raw.entrypoint : null,
        socket: text(raw.messagingSocketPath),
        name: text(raw.name),
        hostSessionId: text(raw.hostSessionId),
      })
    } catch {
      // 写到一半、格式不对的跳过：下一次再读
    }
  }
  return entries
}

export function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    // 进程在、只是没权限发信号
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/** 照 CLI 的取法拿进程的启动时间。取不到（ps 不在、超时）是 null */
function processStart(pid: number): string | null {
  try {
    const out = execFileSync('ps', ['-o', 'lstart=', '-p', String(pid)], {
      encoding: 'utf8',
      timeout: 1000,
      stdio: ['ignore', 'pipe', 'ignore'],
      env: { ...process.env, LC_ALL: 'C', TZ: 'UTC' },
    })
    return out.trim() || null
  } catch {
    return null
  }
}

export interface NativeOwnersOptions {
  /** 登记所在的目录：<配置目录>/sessions */
  registryDir: () => string
  /** 入口自己起的、还活着的 CLI 的进程号：这些不算别人 */
  ownPids: () => ReadonlySet<number>
}

export class NativeOwners {
  private readonly options: NativeOwnersOptions
  private cached: { at: number; owners: Map<string, NativeOwner> } | null = null
  /** 核对过启动时间的登记：进程号 → 当时的 procStart 与结论。进程活着时启动时间不会变，只核对一次 */
  private readonly verified = new Map<number, { procStart: string | null; same: boolean }>()

  constructor(options: NativeOwnersOptions) {
    this.options = options
  }

  /** 登记里占着的原生会话：原生会话号 → 占用方。force 时不用上一次的结果 */
  registered(force = false): Map<string, NativeOwner> {
    const now = Date.now()
    if (!force && this.cached && now - this.cached.at < REGISTRY_GAP_MS) return this.cached.owners
    const own = this.options.ownPids()
    const owners = new Map<string, NativeOwner>()
    const seen = new Set<number>()
    for (const entry of readRegistry(this.options.registryDir())) {
      if (own.has(entry.pid) || !alive(entry.pid)) continue
      seen.add(entry.pid)
      if (!this.sameProcess(entry)) continue
      const running = entry.status === 'busy'
      const before = owners.get(entry.sessionId)
      // 同一个会话被两个进程开着（少见）：有一个在跑就算在跑
      owners.set(entry.sessionId, {
        entrypoint: before?.entrypoint ?? entry.entrypoint ?? 'unknown',
        running: running || before?.running === true,
      })
    }
    for (const pid of [...this.verified.keys()]) if (!seen.has(pid)) this.verified.delete(pid)
    this.cached = { at: now, owners }
    return owners
  }

  /** 登记里的进程号现在还是登记的那个进程（没被复用）。登记没写启动时间、取不到现在的，按是算 */
  private sameProcess(entry: RegistryEntry): boolean {
    if (entry.procStart === null) return true
    const known = this.verified.get(entry.pid)
    if (known && known.procStart === entry.procStart) return known.same
    const now = processStart(entry.pid)
    const same = now === null || now === entry.procStart
    this.verified.set(entry.pid, { procStart: entry.procStart, same })
    return same
  }
}

/**
 * 原生记录是不是刚被别人改过：最近 NATIVE_GROWTH_MS 之内改过，而且入口自己此刻没开着这个会话的 CLI、
 * 入口自己的 CLI 最后一次退出早于这次改动（那之前的改动是入口自己写的）
 */
export function recentlyWritten(
  path: string | null,
  ownAlive: boolean,
  ownExitedAt: number,
  now = Date.now(),
): boolean {
  if (!path || ownAlive) return false
  let modified: number
  try {
    modified = statSync(path).mtimeMs
  } catch {
    return false
  }
  return now - modified < NATIVE_GROWTH_MS && modified > ownExitedAt
}

const OWNER_NAMES: Record<string, string> = {
  'claude-desktop': 'Claude 桌面端',
  cli: '终端里的 Claude Code',
}

/** 拒绝写的时候给的话：谁占着、怎么让它放手 */
export function nativeOwnerMessage(owner: NativeOwner): string {
  const who = OWNER_NAMES[owner.entrypoint] ?? '另一个进程'
  return `此会话正由另一个进程接管，这边只读（${who}${owner.running ? '正在运行它' : '开着它'}）。对方放手后自动恢复可写：在 Claude 桌面端归档这个会话或退出 Claude 桌面端，终端里退出 claude。`
}
