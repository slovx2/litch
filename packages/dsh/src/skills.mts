import { createHash } from 'node:crypto'
import { existsSync, readdirSync, realpathSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { ProtocolError } from '../../shared/src/protocol-contract.mjs'
import type { RpcPeer } from '../../shared/src/types.mjs'
import { RemoteError, type WebRemote } from './remote.mjs'
import { type DshRuntime, dshHome } from './runtime.mjs'

// dsh 入口的技能清单（skills/list 与 skills/changed）。
//
// 有哪些技能只问 dsh 自己（Web Remote 的 skills/list）：它给的正是用户能用“/名字”点名的那些，
// 从哪几处找、同名谁赢、元数据不合格的不要、作者标了不给用户用的不列，都是它裁决过的结果，这里不另扫一遍。
// dsh 的这个接口按会话问（用会话的工作目录定项目），协议按工作目录问，所以每个工作目录配一个只用来问技能的
// dsh 会话：会话号由目录定，头一次问时建，从不发消息，不进线程列表。dsh 没有不落盘的会话，也没有删除会话的
// 接口，这个会话建了就一直在。

type Scope = 'user' | 'repo' | 'system'
interface Skill {
  name: string
  description: string
  path: string
  scope: Scope
  enabled: boolean
  pluginId: null
}
interface Catalog {
  cwd: string
  skills: Skill[]
  errors: Array<{ path: string; message: string }>
}
// 看一眼的结果：dsh 给的清单里用得上的那几项，或者工作目录不在了。巡查拿它比有没有变。
type Seen = { skills: Array<{ name: string; description: string; path?: string }> } | { gone: true }
interface Observer {
  peer: RpcPeer
  cwds: string[]
  fingerprint: string
}

// dsh 自己盯着技能目录，改动在它那边几百毫秒内生效，但不往远程客户端推事件：这里隔一会儿问一遍。
// 问一遍是每个目录一次本机请求，十个目录每秒问一遍时 dsh 进程常驻约 2% 的 CPU，所以不问得更勤。
const POLL_MS = 2000
const SESSION_PREFIX = 'session-skills-'

/** 是不是只用来问技能的那种会话：线程列表凭它滤掉 */
export const isSkillsSession = (sessionId: string): boolean => sessionId.startsWith(SESSION_PREFIX)

const sessionFor = (cwd: string): string =>
  SESSION_PREFIX + createHash('sha256').update(cwd).digest('hex').slice(0, 32)

function real(path: string): string | null {
  try {
    return realpathSync(path)
  } catch {
    return null
  }
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

// 来源范围按文件落在哪个目录里归，dsh 的清单不带这一项。它默认找技能的几处里，项目的两处算仓库的，
// 用户的两处算用户的；归不进这四处的（dsh 自带的、插件带的、它的设置里另加的目录）算系统的。
// dsh 给的路径是解开符号链接之后的，所以拿各目录下每一项的真实位置去对，不按路径的开头比。
function scopesAt(cwd: string, home: string): Map<string, Scope> {
  // 项目根照 dsh 的规矩：往上第一个带 .git 的目录，一直没有就是工作目录自己
  let project = cwd
  for (let directory = cwd; ; directory = dirname(directory)) {
    if (existsSync(join(directory, '.git'))) {
      project = directory
      break
    }
    if (dirname(directory) === directory) break
  }
  const agents = resolve(process.env.DSH_AGENTS_HOME ?? join(homedir(), '.agents'))
  const roots: Array<[string, Scope]> = [
    [join(project, '.dsh/skills'), 'repo'],
    [join(project, '.agents/skills'), 'repo'],
    [join(dshHome(home), 'skills'), 'user'],
    [join(agents, 'skills'), 'user'],
  ]
  const scopes = new Map<string, Scope>()
  for (const [root, scope] of roots) {
    let names: string[]
    try {
      names = readdirSync(root)
    } catch {
      continue
    }
    // 一项技能是 <名字>/SKILL.md 或平铺的 <名字>.md；同一个文件两处都够得着时先到的算数，和 dsh 的先后一致
    for (const name of names)
      for (const file of [join(root, name, 'SKILL.md'), join(root, name)]) {
        const path = real(file)
        if (path && !scopes.has(path)) scopes.set(path, scope)
      }
  }
  return scopes
}

export class DshSkills {
  private readonly home: string
  private readonly runtime: DshRuntime
  // 问过技能的连接和它问的那几个目录：清单变了只通知它们。
  private readonly observers = new Map<string, Observer>()
  private readonly creating = new Map<string, Promise<unknown>>()
  private readonly timer: NodeJS.Timeout
  private polling = false

  constructor(home: string, runtime: DshRuntime) {
    this.home = home
    this.runtime = runtime
    this.timer = setInterval(() => void this.poll(), POLL_MS)
    this.timer.unref()
  }

  // 这一层不留缓存，每次都当场问 dsh，所以 forceReload 带不带是一样的；dsh 那边的缓存由它自己的文件监视作废。
  async list(peer: RpcPeer, params: any): Promise<{ data: Catalog[] }> {
    if (params.forceReload != null && typeof params.forceReload !== 'boolean')
      throw new ProtocolError(-32602, 'forceReload 必须是布尔值')
    if (
      params.cwds != null &&
      (!Array.isArray(params.cwds) ||
        params.cwds.some((value: unknown) => typeof value !== 'string' || !isAbsolute(value)))
    )
      throw new ProtocolError(-32602, 'cwds 必须是绝对路径的数组')
    const cwds: string[] = params.cwds?.length ? params.cwds : [process.cwd()]
    const remote = await this.runtime.remote()
    const data: Catalog[] = []
    const seen: unknown[] = []
    for (const cwd of cwds) {
      // 一个目录问不成不连累别的：原因记在它自己的 errors 里
      const result = await this.look(remote, cwd).catch((error: unknown) => ({
        error: error instanceof Error ? error.message : String(error),
      }))
      seen.push(result)
      data.push(
        'error' in result
          ? { cwd, skills: [], errors: [{ path: cwd, message: result.error }] }
          : this.catalog(cwd, result),
      )
    }
    this.observers.set(peer.id, { peer, cwds, fingerprint: JSON.stringify(seen) })
    return { data }
  }

  closePeer(id: string): void {
    this.observers.delete(id)
  }

  close(): void {
    clearInterval(this.timer)
    this.observers.clear()
  }

  // 目录不在了不去问：dsh 建会话时会把不存在的目录建出来。
  private async look(remote: WebRemote, cwd: string): Promise<Seen> {
    const root = resolve(cwd)
    if (!isDirectory(root)) return { gone: true }
    const sessionId = sessionFor(root)
    const ask = () =>
      remote.rpc('skills/list', { request: { sessionId } }, (value) => Array.isArray(value?.skills))
    const listed = await ask().catch(async (error) => {
      if (!(error instanceof RemoteError) || error.code !== 'session/not-found') throw error
      await this.create(remote, root, sessionId)
      return ask()
    })
    return {
      skills: (listed.skills as any[]).map(({ name, description, path }) => ({
        name,
        description,
        path,
      })),
    }
  }

  // 同一个号再建一次 dsh 会原样答回来；这里再把同时来的并成一次。
  private create(remote: WebRemote, cwd: string, sessionId: string): Promise<unknown> {
    const pending =
      this.creating.get(sessionId) ??
      remote
        .rpc(
          'session/create',
          { request: { cwd, sessionId } },
          (value) => value?.sessionId === sessionId,
        )
        .finally(() => this.creating.delete(sessionId))
    this.creating.set(sessionId, pending)
    return pending
  }

  private catalog(cwd: string, seen: Seen): Catalog {
    if ('gone' in seen)
      return { cwd, skills: [], errors: [{ path: cwd, message: '工作目录不存在或不是目录' }] }
    const scopes = scopesAt(resolve(cwd), this.home)
    const catalog: Catalog = { cwd, skills: [], errors: [] }
    for (const { name, description, path } of seen.skills) {
      // 不是文件的技能（插件在内存里注册的）dsh 不给位置；协议里位置是必填的，编不出来，如实说列不进
      if (!path)
        catalog.errors.push({ path: cwd, message: `技能 ${name} 没有文件位置，列不进清单` })
      // dsh 的技能没有逐项的开关：列得出来的都能用
      else
        catalog.skills.push({
          name,
          description,
          path,
          scope: scopes.get(real(path) ?? path) ?? 'system',
          enabled: true,
          pluginId: null,
        })
    }
    return catalog
  }

  // 只用现成的 dsh 连接，不为巡查把 dsh 拉起来；这一轮问不成就等下一轮，上一轮没问完也等下一轮。
  private async poll(): Promise<void> {
    const remote = this.runtime.current()
    if (this.polling || !remote || !this.observers.size) return
    this.polling = true
    for (const observer of [...this.observers.values()]) {
      try {
        const seen: Seen[] = []
        for (const cwd of observer.cwds) seen.push(await this.look(remote, cwd))
        const fingerprint = JSON.stringify(seen)
        // 问的这会儿它又来要过一遍清单（或者断开了）：以那一次为准
        if (
          fingerprint === observer.fingerprint ||
          this.observers.get(observer.peer.id) !== observer
        )
          continue
        observer.fingerprint = fingerprint
        observer.peer.send({ method: 'skills/changed', params: {} })
      } catch {
        /* 这一轮没问成；真有问题，它下一次 skills/list 时原因会在 errors 里 */
      }
    }
    this.polling = false
  }
}
