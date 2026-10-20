import { statSync } from 'node:fs'
import { join } from 'node:path'
import { ProtocolError } from './protocol-contract.mjs'
import { claudeSettingSources } from './runtime-config.mjs'
import {
  absoluteSkillPath,
  canonicalSkillKey,
  nativeSkillHome,
  nativeSkillOverrides,
  projectSkillDirectories,
  type SkillCatalog,
  scanSkillRoot,
  skillFingerprint,
} from './skill-catalog.mjs'
import {
  type SkillRule,
  type SkillSelector,
  setSkillRule,
  skillEnabled,
  skillPathKey,
  skillRuled,
} from './skill-config.mjs'
import { SkillRoots } from './skill-roots.mjs'
import type { RpcPeer } from './types.mjs'

interface SkillObserver {
  peer: RpcPeer
  cwds: string[]
  fingerprint: string
}

// Skill 开关的规则在配置里（skill-config.mts），由服务按 config.json 加 `-c` 给出
export class SkillsRpc {
  private readonly roots = new SkillRoots()
  private extraRoots: string[] = []
  private readonly rules: () => SkillRule[]
  private observers = new Map<string, SkillObserver>()
  private readonly timer: NodeJS.Timeout

  constructor(rules: () => SkillRule[]) {
    this.rules = rules
    this.timer = setInterval(() => this.poll(), 250)
    this.timer.unref()
  }

  list(peer: RpcPeer, params: Record<string, unknown>, cwd: string): { data: SkillCatalog[] } {
    if (params.forceReload != null && typeof params.forceReload !== 'boolean')
      throw new ProtocolError(-32602, 'forceReload 必须是布尔值')
    if (
      params.cwds != null &&
      (!Array.isArray(params.cwds) ||
        params.cwds.some((value) => typeof value !== 'string' || !value))
    )
      throw new ProtocolError(-32602, 'cwds 必须是非空路径字符串数组')
    const cwds = (Array.isArray(params.cwds) && params.cwds.length ? params.cwds : [cwd]).map(
      (value) => absoluteSkillPath(value, 'cwd'),
    )
    const data = cwds.map((root) => this.catalog(root))
    this.observers.set(peer.id, { peer, cwds, fingerprint: this.fingerprint(data) })
    return { data }
  }

  // skills/config/write：改的是配置里的 `skills.config`（与 config/batchWrite 同一处），save 落盘并重读配置
  write(
    params: Record<string, unknown>,
    cwd: string,
    current: unknown,
    save: (rules: SkillRule[]) => void,
  ): { effectiveEnabled: boolean } {
    if (typeof params.enabled !== 'boolean') throw new ProtocolError(-32602, 'enabled 必须是布尔值')
    const hasPath = params.path != null
    if (hasPath === (params.name != null))
      throw new ProtocolError(-32602, '必须且只能提供 path 或 name')
    let selector: SkillSelector
    if (hasPath) selector = { path: absoluteSkillPath(params.path, 'path') }
    else if (typeof params.name === 'string' && params.name.trim())
      selector = { name: params.name.trim() }
    else throw new ProtocolError(-32602, 'name 必须是有效技能名称')
    const matching = this.catalog(cwd).skills.filter((skill) =>
      'path' in selector
        ? canonicalSkillKey(skill.path) === skillPathKey(selector.path)
        : skill.name === selector.name,
    )
    const native = this.nativeOverrides(cwd)
    // 删掉“开”的那条之后，只靠 Claude Code 自己的设置关着的（没有规则管它）还得留一条“开”
    const stillDisabled = (rules: SkillRule[]) =>
      matching.some((skill) => {
        const key = canonicalSkillKey(skill.path)
        return native[skill.name] === 'off' && !skillRuled(rules, { name: skill.name, key })
      })
    save(setSkillRule(current, selector, params.enabled, stillDisabled))
    this.syncLinks()
    this.invalidate()
    return { effectiveEnabled: params.enabled }
  }

  setRoots(params: Record<string, unknown>): Record<string, never> {
    if (!Array.isArray(params.extraRoots)) throw new ProtocolError(-32602, 'extraRoots 必须是数组')
    const roots = [
      ...new Set(
        params.extraRoots.map((value) => canonicalSkillKey(absoluteSkillPath(value, 'extraRoots'))),
      ),
    ]
    for (const root of roots)
      if (!statSync(root).isDirectory()) throw new ProtocolError(-32602, '额外技能根必须是目录')
    this.roots.sync(roots, this.hiddenSkills(roots))
    if (JSON.stringify(roots) === JSON.stringify(this.extraRoots)) return {}
    this.extraRoots = roots
    this.invalidate()
    return {}
  }

  // 给 CLI 的开关（它只认名字）：额外目录里被关掉的 Skill 直接不链给它；剩下 CLI 看得到的同名 Skill 里
  // 只要有一个关着就整个名字关（宁可少给），都开着且有规则管过就明确开（盖过 Claude Code 自己设置里的关）
  runtimeOverrides(cwd: string): Record<string, 'on' | 'off'> {
    this.syncLinks()
    const rules = this.rules()
    const overrides: Record<string, 'on' | 'off'> = Object.create(null)
    const hidden = this.hiddenSkills(this.extraRoots)
    for (const skill of this.catalog(cwd).skills) {
      const key = canonicalSkillKey(skill.path)
      if (hidden.has(key)) continue
      const ruled = skillRuled(rules, { name: skill.name, key })
      if (!skill.enabled) overrides[skill.name] = 'off'
      else if (ruled && overrides[skill.name] !== 'off') overrides[skill.name] = 'on'
    }
    return overrides
  }

  closePeer(id: string): void {
    this.observers.delete(id)
  }
  preferredCwd(id: string): string | undefined {
    return this.observers.get(id)?.cwds[0]
  }
  close(): void {
    clearInterval(this.timer)
    this.observers.clear()
    this.roots.close()
  }

  private catalog(cwd: string): SkillCatalog {
    // 用户级、项目级的技能目录只在 CHA_CLAUDE_SETTING_SOURCES 选了那一层时才有，和 CLI 读的一致
    const layers = claudeSettingSources()
    const sources = [
      ...(layers.includes('user')
        ? [scanSkillRoot(join(nativeSkillHome(), 'skills'), 'user', this.roots.paths())]
        : []),
      ...(layers.includes('project') ? projectSkillDirectories(cwd) : []).map((directory) =>
        scanSkillRoot(join(directory, '.claude', 'skills'), 'repo'),
      ),
      ...this.extraRoots.map((root) => scanSkillRoot(root, 'user')),
    ]
    const catalog: SkillCatalog = {
      cwd,
      skills: [],
      errors: sources.flatMap((source) => source.errors),
    }
    let native: Record<string, string> = {}
    try {
      native = nativeSkillOverrides(cwd)
    } catch (error) {
      catalog.errors.push({ path: cwd, message: String(error) })
    }
    let rules: SkillRule[] = []
    try {
      rules = this.rules()
    } catch (error) {
      catalog.errors.push({ path: cwd, message: String(error) })
    }
    const seen = new Set<string>()
    for (const source of sources)
      for (const skill of source.skills) {
        let key: string
        try {
          key = canonicalSkillKey(skill.path)
        } catch (error) {
          catalog.errors.push({ path: skill.path, message: String(error) })
          continue
        }
        if (seen.has(key)) continue
        seen.add(key)
        skill.enabled = skillEnabled(rules, { name: skill.name, key }, native[skill.name] !== 'off')
        catalog.skills.push(skill)
      }
    return catalog
  }

  // 额外目录里被规则关掉的 Skill（只看规则；Claude Code 自己设置里的开关由 CLI 自己按名字处理）
  private hiddenSkills(roots: readonly string[]): Set<string> {
    const rules = this.rules()
    const hidden = new Set<string>()
    if (rules.length === 0) return hidden
    for (const root of roots)
      for (const skill of scanSkillRoot(root, 'user').skills) {
        const key = canonicalSkillKey(skill.path)
        if (!skillEnabled(rules, { name: skill.name, key }, true)) hidden.add(key)
      }
    return hidden
  }

  private syncLinks(): void {
    this.roots.sync(this.extraRoots, this.hiddenSkills(this.extraRoots))
  }

  private nativeOverrides(cwd: string): Record<string, string> {
    try {
      return nativeSkillOverrides(cwd)
    } catch {
      return {}
    }
  }

  private fingerprint(catalogs: SkillCatalog[]): string {
    return catalogs.map(skillFingerprint).join(':')
  }

  private invalidate(): void {
    for (const observer of this.observers.values()) {
      observer.fingerprint = this.fingerprint(observer.cwds.map((cwd) => this.catalog(cwd)))
      try {
        observer.peer.send({ jsonrpc: '2.0', method: 'skills/changed', params: {} })
      } catch {
        this.observers.delete(observer.peer.id)
      }
    }
  }

  private poll(): void {
    for (const observer of this.observers.values()) {
      try {
        const fingerprint = this.fingerprint(observer.cwds.map((cwd) => this.catalog(cwd)))
        if (fingerprint === observer.fingerprint) continue
        observer.fingerprint = fingerprint
        observer.peer.send({ jsonrpc: '2.0', method: 'skills/changed', params: {} })
      } catch {
        /* 下次扫描继续；读取错误会作为 skills/list.errors 明确返回。 */
      }
    }
  }
}
