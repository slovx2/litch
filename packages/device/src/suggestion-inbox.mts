import { EXTENSION } from '../../protocol/src/device.mjs'
import {
  SUGGESTIONS_CHANGED,
  type SuggestionEntry,
  type SuggestionsSnapshot,
} from '../../protocol/src/suggestion-inbox.mjs'
import type { SessionTree } from './session-tree.mjs'

/** 按变化重算投影并只推差量。串行读取避免晚到的旧投影覆盖刚处理的卡。 */
export class SuggestionInbox {
  private rows = new Map<string, SuggestionEntry>()
  private queue: Promise<void> = Promise.resolve()
  private dirty = false
  private loading = false
  private readonly tree: SessionTree
  private stopped = false
  constructor(tree: SessionTree) {
    this.tree = tree
  }
  close(): void {
    this.stopped = true
    this.dirty = false
  }

  changed(): void {
    if (this.stopped) return
    this.dirty = true
    if (this.loading) return
    this.loading = true
    this.queue = this.queue
      .catch(() => {})
      .then(async () => {
        try {
          while (this.dirty) {
            this.dirty = false
            await this.refresh()
          }
        } catch (error) {
          this.tree.host.log(`读取建议列表失败：${String(error)}`)
          throw error
        } finally {
          this.loading = false
        }
      })
    // 通知失败不产生未处理拒绝；下一次快照或变更仍可重新读取。
    void this.queue.catch(() => {})
  }

  async list(): Promise<SuggestionsSnapshot> {
    this.queue = this.queue.catch(() => {})
    this.tree.expireSuggestions()
    this.changed()
    await this.queue
    return { suggestions: [...this.rows.values()] }
  }

  private async refresh(): Promise<void> {
    const proposals = this.tree.store.allSuggestions()
    const sources = new Map<string, SuggestionEntry['source']>()
    // 同一个来源只读一次；暂不可用时保留上次元数据，不能把短暂离线当成删除。
    for (const proposal of proposals) {
      if (sources.has(proposal.threadId)) continue
      const previous = this.rows.get(proposal.id)?.source
      const found = await this.tree.read(proposal.threadId, false).catch(() => null)
      if (this.stopped) return
      const thread = found?.thread
      const projectId = this.tree.host.workspaces.projectOf(proposal.threadId)
      const project = projectId ? this.tree.host.workspaces.projects.read(projectId) : null
      const preview =
        typeof thread?.preview === 'string'
          ? thread.preview
              .split('\n')
              .map((part) => part.trim())
              .find(Boolean)
              ?.slice(0, 100)
          : undefined
      sources.set(proposal.threadId, {
        threadId: proposal.threadId,
        title:
          typeof thread?.name === 'string' && thread.name
            ? thread.name
            : (previous?.title ??
              this.tree.store.parentOf(proposal.threadId)?.title ??
              preview ??
              proposal.threadId),
        harness:
          found?.harness ??
          previous?.harness ??
          this.tree.host.index.lookup(proposal.threadId) ??
          '',
        cwd: typeof thread?.cwd === 'string' ? thread.cwd : (previous?.cwd ?? proposal.cwd ?? ''),
        archived: this.tree.host.index.archived(proposal.threadId),
        project: project ? { id: project.id, name: project.name } : null,
      })
    }
    if (this.stopped || this.dirty) return
    const next = new Map<string, SuggestionEntry>()
    // 读取期间可能已被处理，必须以数据库现在的状态为准。
    for (const proposal of this.tree.store.allSuggestions()) {
      const source = sources.get(proposal.threadId)
      if (!source) {
        this.dirty = true
        return
      }
      const mark = this.tree.managers?.lines.mark(proposal.threadId)
      next.set(proposal.id, {
        proposal,
        source,
        managerId: mark?.role === 'line' ? mark.managerId : null,
      })
    }
    const upserts = [...next.values()].filter(
      (row) => JSON.stringify(row) !== JSON.stringify(this.rows.get(row.proposal.id)),
    )
    const removed = [...this.rows.keys()].filter((id) => !next.has(id))
    this.rows = next
    if (upserts.length || removed.length)
      this.tree.host.announce(SUGGESTIONS_CHANGED, { upserts, removed }, EXTENSION.suggestionInbox)
  }
}
