import { lstatSync, mkdirSync, readlinkSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { EXTENSION } from '../../protocol/src/device.mjs'
import {
  HARNESS_CONFIG_METHOD,
  HARNESS_CONFIG_NOTIFICATION,
  type HarnessAuthStep,
  type HarnessConfigChangedNotification,
} from '../../protocol/src/harness-config.mjs'
import { ProtocolError } from '../../shared/src/protocol-contract.mjs'
import type { RpcPeer } from '../../shared/src/types.mjs'
import { OpencodeError } from './api.mjs'
import { configRead, configWrite } from './harness-settings-config.mjs'
import { mcpLogin, mcpRead, mcpRemove, mcpUpsert } from './harness-settings-mcp.mjs'
import {
  authCancel,
  authContinue,
  authLogout,
  authStart,
  providersRead,
  providersRemove,
  providersUpsert,
} from './harness-settings-providers.mjs'
import {
  type Attempt,
  conflict,
  HARNESS_ID,
  HarnessError,
  invalid,
  notFound,
  opencodeMessage,
  text,
} from './harness-settings-shared.mjs'
import {
  CONFIG_SCHEMA_URL,
  editJsonc,
  hasComments,
  type OpencodePaths,
  opencodePaths,
  parseJsonc,
  readGlobalConfig,
  readText,
  sha,
  writeText,
} from './native-config.mjs'
import type { OpencodeServer } from './server.mjs'

// harness 详情设置（扩展 harnessConfig）在 OpenCode 上的实现。权威是 OpenCode 自己的文件：
// 全局配置 opencode.json(c)、凭据 auth.json、用户级指令 AGENTS.md；登录、MCP 的授权、模型和 provider 的清单问 serve。
//
// 配置怎么写、怎么让 serve 重读（OpenCode 1.18.33 实测）：
// - serve 把全局配置缓存在内存里、不设过期，只有它自己的 PATCH /global/config 改出变化时才作废缓存，并收拾全部目录实例
//  （跑着的回合会被停掉）。PATCH 只能合并、删不掉键，.json 文件还会整个重新排版（注释丢掉）。
// - 所以这里自己按路径改原文（注释、认不出的键都留着，删键也行），再借 PATCH 让它重读：先把 `$schema` 的值临时改掉
//   写进去，再 PATCH 回原值。OpenCode 改的就是那一个值，改完的原文正好是我们要的那份，缓存也作废了。
//   OpenCode 顺带校验整份配置，不合格的整个退回去，原文件恢复原样。
// - 收拾目录实例会停掉跑着的回合：适配器这边有回合在跑时先只写文件，等都闲下来再让它重读（idle）。
//   这一阵新会话的默认模型用文件里新写的（pendingModel）。
// - .json 文件里有注释时没法借 PATCH（它会把注释抹掉），只写文件，回 restartRequired 让用户重启这个 harness。

export class HarnessSettings {
  readonly server: OpencodeServer
  readonly paths: OpencodePaths
  /** 有回合在跑、先搁着的重读：config 是配置文件改了，dispose 是凭据改了（只要收拾目录实例） */
  private pending: 'config' | 'dispose' | null = null
  /** 进行中的登录（provider 的和 MCP 的） */
  readonly attempts = new Map<string, Attempt>()
  /** MCP 登录时 OpenCode 开不了浏览器（mcp.browser.open.failed）：按服务名交出链接 */
  readonly mcpBrowser = new Map<string, (url: string) => void>()

  constructor(server: OpencodeServer, env: NodeJS.ProcessEnv = process.env) {
    this.server = server
    this.paths = opencodePaths(env)
    this.migrate()
  }

  async dispatch(peer: RpcPeer, method: string, p: any): Promise<any> {
    const M = HARNESS_CONFIG_METHOD
    switch (method) {
      case M.configRead:
        return configRead(this)
      case M.configWrite:
        return configWrite(this, p)
      case M.configAction:
        if (p.actionId !== 'reload')
          throw notFound(`没有动作 ${p.actionId}`, `No action ${p.actionId}`)
        await this.reloadNow()
        return {}
      case M.providersRead:
        return providersRead(this)
      case M.providersUpsert:
        return providersUpsert(this, p)
      case M.providersRemove:
        return providersRemove(this, p)
      case M.providersActivate:
        throw new HarnessError(
          'readOnly',
          text(
            'OpenCode 按所选的模型决定用哪个 provider，没有“当前 provider”可切换',
            'OpenCode picks the provider from the selected model; there is no active provider to switch',
          ),
        )
      case M.authStart:
        return authStart(this, peer, p)
      case M.authContinue:
        return authContinue(this, p)
      case M.authCancel:
        return authCancel(this, p)
      case M.authLogout:
        return authLogout(this, p)
      case M.mcpRead:
        return mcpRead(this)
      case M.mcpUpsert:
        return mcpUpsert(this, p)
      case M.mcpRemove:
        return mcpRemove(this, p)
      case M.mcpLogin:
        return mcpLogin(this, p)
      case M.instructionsRead:
        return this.instructionsRead()
      case M.instructionsWrite:
        return this.instructionsWrite(p)
      default:
        throw new ProtocolError(-32601, `OpenCode 入口不支持 ${method}`)
    }
  }

  // ---------- 通知 ----------

  private declared(): RpcPeer[] {
    return [...this.server.peers.values()].filter((peer) =>
      this.server.declared.get(peer.id)?.has(EXTENSION.harnessConfig),
    )
  }

  changed(part: HarnessConfigChangedNotification['part']): void {
    const params: HarnessConfigChangedNotification = { harness: HARNESS_ID, part }
    for (const peer of this.declared())
      peer.send({ method: HARNESS_CONFIG_NOTIFICATION.changed, params })
  }

  authUpdated(
    attemptId: string,
    step: HarnessAuthStep,
    target: { providerId?: string; mcpServer?: string },
  ): void {
    const params = { harness: HARNESS_ID, attemptId, ...target, step }
    for (const peer of this.declared())
      peer.send({ method: HARNESS_CONFIG_NOTIFICATION.authUpdated, params })
  }

  // ---------- 让 serve 重读 ----------

  /** 适配器这边有没有回合在跑（收拾目录实例会停掉它们） */
  private busy(): boolean {
    for (const live of this.server.live.values()) if (live.projection.active) return true
    return false
  }

  /**
   * 把改好的全局配置原文落盘，并让 serve 重读。返回要不要重启这个 harness 才生效。
   * rollback：OpenCode 校验不过时恢复成什么（null 是原来没有这个文件）。
   */
  async commitConfig(target: string, next: string, rollback: string | null): Promise<boolean> {
    const finalText = withSchema(next)
    this.server.catalog.invalidate()
    const api = this.server.runtime.current()
    // serve 还没起来：下次起来自然读到新的
    if (!api) {
      writeText(target, finalText)
      return false
    }
    if (this.busy()) {
      writeText(target, finalText)
      this.pending = 'config'
      return false
    }
    return this.reloadWith(target, finalText, rollback)
  }

  private async reloadWith(
    target: string,
    finalText: string,
    rollback: string | null | undefined,
  ): Promise<boolean> {
    const api = await this.server.api()
    if (target.endsWith('.json') && hasComments(finalText)) {
      writeText(target, finalText)
      return true
    }
    // 上一次半路断掉、留下了临时值的，去掉尾巴
    const schema = String(parseJsonc(finalText, target).$schema).replace(/#litch-reload$/, '')
    writeText(target, editJsonc(finalText, ['$schema'], `${schema}#litch-reload`))
    try {
      await api.request('PATCH', '/global/config', { body: { $schema: schema }, timeoutMs: 30000 })
    } catch (error) {
      if (rollback === undefined) writeText(target, finalText)
      else if (rollback === null) rmSync(target, { force: true })
      else writeText(target, rollback)
      if (error instanceof OpencodeError && error.status >= 400 && error.status < 500)
        throw new HarnessError(
          'invalidValue',
          text(
            `OpenCode 不接受这份配置：${opencodeMessage(error)}`,
            `OpenCode rejected the configuration: ${opencodeMessage(error)}`,
          ),
        )
      throw error
    }
    this.server.catalog.invalidate()
    return false
  }

  /** 凭据改了：收拾目录实例，provider 的清单重新算 */
  async dispose(): Promise<void> {
    this.server.catalog.invalidate()
    const api = this.server.runtime.current()
    if (!api) return
    if (this.busy()) {
      this.pending ??= 'dispose'
      return
    }
    await api.request('POST', '/global/dispose', { timeoutMs: 30000 })
  }

  /** 手动重读（配置文件在别处被改过）：不管有没有回合在跑 */
  private async reloadNow(): Promise<void> {
    this.pending = null
    const snapshot = readGlobalConfig(this.paths)
    if (!snapshot.text.trim()) {
      await this.server.api().then((api) => api.request('POST', '/global/dispose'))
      this.server.catalog.invalidate()
      return
    }
    await this.reloadWith(snapshot.target, withSchema(snapshot.text), undefined)
    this.changed('config')
  }

  /** 会话闲下来了：先前搁着的重读现在做 */
  idle(): void {
    if (!this.pending || this.busy() || !this.server.runtime.current()) return
    const kind = this.pending
    this.pending = null
    const work =
      kind === 'dispose'
        ? this.dispose()
        : (async () => {
            const snapshot = readGlobalConfig(this.paths)
            if (snapshot.text.trim())
              await this.reloadWith(snapshot.target, withSchema(snapshot.text), undefined)
          })()
    work.catch((error) =>
      console.error(`[opencode] 让 OpenCode 重读配置失败: ${opencodeMessage(error)}`),
    )
  }

  /** serve 的事件里和这里有关的 */
  event(payload: any): void {
    if (payload?.type !== 'mcp.browser.open.failed') return
    const { mcpName, url } = payload.properties ?? {}
    if (typeof mcpName === 'string' && typeof url === 'string') this.mcpBrowser.get(mcpName)?.(url)
  }

  // ---------- 默认模型 ----------

  /** 全局配置改了、serve 还没重读（等回合停）的那一阵：文件里新写的默认模型；别的时候是 null，以 serve 的为准 */
  pendingModel(): string | null {
    return this.pending === 'config' ? this.nativeModel() : null
  }

  /** 有没有改了全局配置、serve 还没重读的 */
  reloadPending(): boolean {
    return this.pending === 'config'
  }

  /** 全局配置文件里写的默认模型（provider/model）；没写或读不了是 null */
  nativeModel(): string | null {
    try {
      const model = readGlobalConfig(this.paths).merged.model
      return typeof model === 'string' && model ? model : null
    } catch {
      return null
    }
  }

  /**
   * 默认模型从前存在适配器的元数据里（config/defaults 的 model），现在以 OpenCode 自己的配置为准：
   * 原生配置里没写的，把旧值写进去；写过了就以原生的为准。旧值随即从元数据里去掉，只迁一次。
   */
  private migrate(): void {
    const saved = this.server.store.getMeta('config', 'defaults')
    if (!saved || !('model' in saved)) return
    try {
      const snapshot = readGlobalConfig(this.paths)
      if (typeof saved.model === 'string' && saved.model && snapshot.merged.model === undefined)
        writeText(snapshot.target, withSchema(editJsonc(snapshot.text, ['model'], saved.model)))
      delete saved.model
      this.server.store.setMeta('config', 'defaults', saved)
    } catch (error) {
      console.error(`[opencode] 默认模型没能迁进 OpenCode 的配置: ${opencodeMessage(error)}`)
    }
  }

  /** 改默认模型（config/batchWrite 的 model）：null 是删掉，回到 OpenCode 自己挑 */
  async writeModel(model: string | null): Promise<void> {
    const snapshot = readGlobalConfig(this.paths)
    const next = editJsonc(snapshot.text, ['model'], model ?? undefined)
    if (next === snapshot.text) return
    await this.commitConfig(snapshot.target, next, snapshot.files.length ? snapshot.text : null)
    this.changed('config')
  }

  // ---------- 指令文件 ----------

  private instructionsPath(): string {
    return join(this.paths.instructionsDir, 'AGENTS.md')
  }

  instructionsRead() {
    const path = this.instructionsPath()
    const content = readText(path)
    let linkTarget: string | null = null
    try {
      // 照软链里写的、按它所在的目录解析，不再往下解析一层：和统一模式给的 sourcePath 对得上
      if (lstatSync(path).isSymbolicLink()) linkTarget = resolve(dirname(path), readlinkSync(path))
    } catch {}
    // AGENTS.md 不在时 OpenCode 退回读 ~/.claude/CLAUDE.md（没被环境变量关掉的话）：如实报出实际生效的那份
    const claude = join(this.paths.home, '.claude', 'CLAUDE.md')
    const fallback =
      content === null && this.paths.claudeFallback && readText(claude) !== null ? claude : null
    return {
      path,
      fileName: 'AGENTS.md',
      exists: content !== null,
      content: content ?? '',
      hash: content === null ? '' : sha(content),
      linkTarget,
      overriddenBy: fallback,
    }
  }

  instructionsWrite(p: any) {
    if (typeof p.content !== 'string') throw invalid('content', '缺少正文', 'content is required')
    const current = this.instructionsRead()
    if (p.expectedHash !== current.hash) throw conflict()
    const path = current.path
    // 直接写（不先写临时文件再改名）：统一模式下这里是软链，要写进它指向的那份，不能把软链换掉
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, p.content)
    this.changed('instructions')
    return { hash: sha(p.content) }
  }
}

/** 配置原文里没有 `$schema` 的补上一条（放最前面，和 OpenCode 自己新建配置时一样），借它让 serve 重读 */
export function withSchema(text: string): string {
  const value = parseJsonc(text || '{}', 'opencode.json')
  if (typeof value?.$schema === 'string' && value.$schema) return text || '{}'
  return editJsonc(text || '{}', ['$schema'], CONFIG_SCHEMA_URL, true)
}
