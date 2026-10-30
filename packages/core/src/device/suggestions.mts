import {
  SUGGESTIONS_CHANGED,
  type SuggestionEntry,
  type SuggestionsChanged,
  type SuggestionsSnapshot,
} from '../../../protocol/src/suggestion-inbox.mjs'
import type { HostSink } from '../channel/server.mjs'
import type { SuggestionsView, SuggestionView } from '../model-suggestions.mjs'
import { projectProposal } from '../projection/tree.mjs'

interface SuggestionsHost {
  deviceId: string
  online(): boolean
  supported(): boolean
  request(): Promise<SuggestionsSnapshot>
  log(line: string): void
}
export type Suggestions = ReturnType<typeof createSuggestions>

/** 常驻订阅；断线保留，重连重取；快照在途时收集增量，随后重放。 */
export function createSuggestions(host: SuggestionsHost) {
  const sinks = new Set<HostSink>()
  const rows = new Map<string, SuggestionView>()
  let available: boolean | null = null
  let epoch = 0
  let loading: SuggestionsChanged[] | null = null
  const view = (): SuggestionsView => ({
    deviceId: host.deviceId,
    available,
    suggestions: [...rows.values()],
  })
  const put = (row: SuggestionEntry) => {
    const proposal = projectProposal(row.proposal, Date.now())
    if (proposal)
      rows.set(row.proposal.id, {
        deviceId: host.deviceId,
        proposal,
        source: row.source,
        managerId: row.managerId,
      })
  }
  const apply = (change: SuggestionsChanged) => {
    for (const row of change.upserts) put(row)
    for (const id of change.removed) rows.delete(id)
  }
  const publish = () => {
    for (const sink of sinks) sink.delta([{ op: 'suggestions.set', view: view() }])
  }
  const resync = async () => {
    const mine = ++epoch
    if (!host.online()) return
    available = host.supported()
    if (!available) {
      rows.clear()
      publish()
      return
    }
    loading = []
    try {
      const snapshot = await host.request()
      if (mine !== epoch) return
      rows.clear()
      for (const row of snapshot.suggestions) put(row)
      for (const change of loading ?? []) apply(change)
      loading = null
      publish()
    } catch (error) {
      if (mine !== epoch) return
      for (const change of loading ?? []) apply(change)
      loading = null
      publish()
      host.log(`读取建议列表失败：${String(error)}`)
    }
  }
  return {
    open(sink: HostSink) {
      sinks.add(sink)
      sink.snapshot(view())
      return () => {
        sinks.delete(sink)
      }
    },
    resync() {
      void resync()
    },
    offline() {
      ++epoch
      loading = null
    },
    notification(method: string, params: unknown): boolean {
      if (method !== SUGGESTIONS_CHANGED) return false
      const change = params as SuggestionsChanged
      if (loading) loading.push(change)
      else {
        apply(change)
        publish()
      }
      return true
    },
  }
}
