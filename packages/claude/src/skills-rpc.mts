import { statSync } from 'node:fs'
import { join } from 'node:path'
import { readConfigFile, writeConfigFile } from './config-store.mjs'
import { ProtocolError } from './protocol-contract.mjs'
import {
  absoluteSkillPath,
  canonicalSkillKey,
  nativeSkillHome,
  nativeSkillOverrides,
  projectSkillDirectories,
  type SkillCatalog,
  scanSkillRoot,
  skillFingerprint,
  skillManifest,
} from './skill-catalog.mjs'
import { SkillRoots } from './skill-roots.mjs'
import type { RpcPeer } from './types.mjs'
import { adapterHome } from './util.mjs'

interface SkillState {
  byPath: Record<string, boolean>
  byName: Record<string, boolean>
}
interface SkillObserver {
  peer: RpcPeer
  cwds: string[]
  fingerprint: string
}

export class SkillsRpc {
  private readonly path = join(adapterHome(), 'skills.json')
  private readonly roots = new SkillRoots()
  private extraRoots: string[] = []
  private state: SkillState
  private observers = new Map<string, SkillObserver>()
  private readonly timer: NodeJS.Timeout

  constructor() {
    const stored = readConfigFile(this.path).values
    this.state = { byPath: this.flags(stored.byPath), byName: this.flags(stored.byName) }
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

  write(params: Record<string, unknown>, cwd: string): { effectiveEnabled: boolean } {
    if (typeof params.enabled !== 'boolean') throw new ProtocolError(-32602, 'enabled 必须是布尔值')
    const hasPath = params.path != null
    const hasName = params.name != null
    if (hasPath === hasName) throw new ProtocolError(-32602, '必须且只能提供 path 或 name')
    const next = structuredClone(this.state)
    let effectiveEnabled: boolean
    if (hasPath) {
      const path = absoluteSkillPath(params.path, 'path')
      const skill = skillManifest(path, 'user')
      const key = canonicalSkillKey(path)
      next.byPath[key] = params.enabled
      effectiveEnabled = params.enabled
      // 同名来源可在不同 cwd 生效，但一次原生会话不能给同名 Skill 相反权限。
      this.assertNamePolicy(this.catalog(cwd, next))
      if (!skill.name) throw new ProtocolError(-32602, '技能缺少名称')
    } else {
      if (
        typeof params.name !== 'string' ||
        !params.name.trim() ||
        ['__proto__', 'constructor', 'prototype'].includes(params.name)
      )
        throw new ProtocolError(-32602, 'name 必须是有效技能名称')
      next.byName[params.name] = params.enabled
      // 名称选择器是显式的统一设置，清除该名称已知路径的旧覆盖。
      for (const path of Object.keys(next.byPath)) {
        try {
          if (skillManifest(path, 'user').name === params.name) delete next.byPath[path]
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        }
      }
      const matches = this.catalog(cwd, next).skills.filter((skill) => skill.name === params.name)
      effectiveEnabled = matches.length ? matches.every((skill) => skill.enabled) : params.enabled
    }
    if (JSON.stringify(next) === JSON.stringify(this.state)) return { effectiveEnabled }
    writeConfigFile(this.path, { ...next }, null)
    this.state = next
    this.invalidate()
    return { effectiveEnabled }
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
    this.roots.sync(roots)
    if (JSON.stringify(roots) === JSON.stringify(this.extraRoots)) return {}
    this.extraRoots = roots
    this.invalidate()
    return {}
  }

  runtimeOverrides(cwd: string): Record<string, 'on' | 'off'> {
    this.roots.sync(this.extraRoots)
    const overrides: Record<string, 'on' | 'off'> = Object.create(null)
    for (const [name, enabled] of Object.entries(this.state.byName))
      overrides[name] = enabled ? 'on' : 'off'
    if (!Object.keys(this.state.byPath).length) return overrides
    const catalog = this.catalog(cwd)
    this.assertNamePolicy(catalog)
    for (const skill of catalog.skills) {
      const key = canonicalSkillKey(skill.path)
      if (Object.hasOwn(this.state.byPath, key))
        overrides[skill.name] = skill.enabled ? 'on' : 'off'
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

  private catalog(cwd: string, state = this.state): SkillCatalog {
    const sources = [
      scanSkillRoot(join(nativeSkillHome(), 'skills'), 'user', this.roots.paths()),
      ...projectSkillDirectories(cwd).map((directory) =>
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
        skill.enabled =
          state.byPath[key] ?? state.byName[skill.name] ?? native[skill.name] !== 'off'
        catalog.skills.push(skill)
      }
    return catalog
  }

  private assertNamePolicy(catalog: SkillCatalog): void {
    const states = new Map<string, boolean>()
    for (const skill of catalog.skills) {
      if (states.has(skill.name) && states.get(skill.name) !== skill.enabled)
        throw new ProtocolError(
          -32602,
          '同名 Skill 存在冲突开关，请使用 name 统一配置：' + skill.name,
        )
      states.set(skill.name, skill.enabled)
    }
  }

  private flags(value: unknown): Record<string, boolean> {
    if (value == null) return Object.create(null)
    if (
      typeof value !== 'object' ||
      Array.isArray(value) ||
      Object.entries(value).some(
        ([key, enabled]) =>
          typeof enabled !== 'boolean' || ['__proto__', 'constructor', 'prototype'].includes(key),
      )
    )
      throw new Error('技能状态文件格式无效')
    return Object.assign(Object.create(null), value) as Record<string, boolean>
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
