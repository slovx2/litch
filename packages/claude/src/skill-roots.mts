import { lstatSync, mkdirSync, readlinkSync, type Stats, symlinkSync, unlinkSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { readConfigFile, writeConfigFile } from './config-store.mjs'
import { ProtocolError } from './protocol-contract.mjs'
import { nativeSkillHome, scanSkillRoot } from './skill-catalog.mjs'
import { adapterHome } from './util.mjs'

interface SkillLink {
  path: string
  target: string
}

// 只把 Skill 目录映射给原生加载器；不使用 --add-dir，不增加文件或命令权限。
export class SkillRoots {
  private readonly directory = join(nativeSkillHome(), 'skills')
  private readonly ledger = join(adapterHome(), 'skill-links.json')
  private links: SkillLink[] = []

  constructor() {
    const stored = readConfigFile(this.ledger).values.links
    if (stored != null && !Array.isArray(stored)) throw new Error('技能链接账本无效')
    for (const link of (stored ?? []) as SkillLink[]) this.removeOwned(link)
    if (stored != null) writeConfigFile(this.ledger, { links: [] }, null)
  }

  sync(roots: string[]): void {
    const desired = new Map<string, SkillLink>()
    for (const root of roots) {
      const found = scanSkillRoot(root, 'user')
      if (found.errors.length) throw new Error(found.errors[0]!.message)
      for (const skill of found.skills) {
        const target = dirname(skill.path)
        // 原生 CLI 用目录名补全没有 name 的 Skill，链接必须保留该名称。
        const path = join(this.directory, basename(target))
        if (desired.has(path) && desired.get(path)!.target !== target)
          throw new ProtocolError(-32602, '额外技能目录名称冲突：' + basename(target))
        desired.set(path, { path, target })
      }
    }
    const next = [...desired.values()]
    if (JSON.stringify(next) === JSON.stringify(this.links)) return
    mkdirSync(this.directory, { recursive: true })
    for (const link of this.links) this.verifyOwned(link)
    const added = next.filter((link) => !this.links.some((old) => old.path === link.path))
    const removed = this.links.filter((link) => !desired.has(link.path))
    for (const link of next) {
      const prior = this.links.find((old) => old.path === link.path)
      if (prior && prior.target !== link.target)
        throw new ProtocolError(-32602, '请先移除旧额外目录再替换同名技能：' + basename(link.path))
    }
    for (const link of added) {
      try {
        lstatSync(link.path)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
        throw error
      }
      throw new ProtocolError(-32602, '额外技能与已有原生目录冲突：' + basename(link.path))
    }
    // 先写入拥有记录；崩溃后的清理允许记录中有未创建或已删除的链接。
    // 没有提交后的第二次落盘，避免响应失败而实际目录已经切换。
    writeConfigFile(this.ledger, { links: [...this.links, ...added] }, null)
    const created: SkillLink[] = []
    const deleted: SkillLink[] = []
    try {
      for (const link of added) {
        symlinkSync(link.target, link.path, 'dir')
        created.push(link)
      }
      for (const link of removed) {
        this.removeOwned(link)
        deleted.push(link)
      }
    } catch (error) {
      for (const link of deleted) symlinkSync(link.target, link.path, 'dir')
      for (const link of created) this.removeOwned(link)
      throw error
    }
    this.links = next
  }

  paths(): Set<string> {
    return new Set(this.links.map((link) => link.path))
  }
  close(): void {
    this.sync([])
  }

  private verifyOwned(link: SkillLink): boolean {
    if (
      !link ||
      typeof link.path !== 'string' ||
      typeof link.target !== 'string' ||
      dirname(resolve(link.path)) !== resolve(this.directory) ||
      basename(link.path) !== basename(link.target)
    )
      throw new Error('技能链接账本路径无效')
    let metadata: Stats
    try {
      metadata = lstatSync(link.path)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
      throw error
    }
    if (!metadata.isSymbolicLink() || readlinkSync(link.path) !== link.target)
      throw new Error('技能链接被外部修改，拒绝删除：' + link.path)
    return true
  }

  private removeOwned(link: SkillLink): void {
    if (this.verifyOwned(link)) unlinkSync(link.path)
  }
}
