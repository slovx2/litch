import {
  type AskAnswers,
  type ItemView,
  keys,
  type PendingQuestion,
  type SearchResult,
  type SearchSource,
  type SessionProposalView,
  searchableItems,
  searchCardItem,
  searchProposalItem,
  searchTransferItem,
  type TurnView,
  wrapQuestionId,
} from '@litch/core'
import { useEffect, useRef, useState } from 'react'
import { useT } from '../../app/appearance.ts'
import { useServices } from '../../app/services.tsx'

const EMPTY: SearchResult = { hits: [], count: 0, query: '', revision: 0 }
const NO_ANSWERS: AskAnswers = {}
const NO_PENDING: PendingQuestion[] = []
const NO_PROPOSALS: SessionProposalView[] = []

/** 投影订阅不依赖挂载。解析/查询在 Worker，流式数据按时间窗合并，不等它停止才搜索。 */
export function useSearch(
  deviceId: string,
  sessionId: string,
  query: string,
  skip?: readonly string[],
) {
  const { store } = useServices().replica
  const t = useT()
  const [result, setResult] = useState(EMPTY)
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)
  const input = useRef(query)
  const request = useRef<(() => void) | null>(null)
  useEffect(() => {
    const worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' })
    const bindings = new Map<string, () => void>(),
      previous = new Map<string, ItemView>()
    const indexed = new Set<string>()
    const omitted = new Set(skip)
    const turnCache = new Map<
      string,
      { status: string; items: ItemView[]; shown: ReadonlySet<string> }
    >()
    let timer = 0,
      revision = 0,
      stopped = false,
      building = false,
      again = false
    let previousProposals = NO_PROPOSALS
    let previousAnswers = NO_ANSWERS,
      previousPending = NO_PENDING
    const post = async () => {
      const mine = revision,
        all: SearchSource[] = []
      const turnIds = store.get<string[]>(keys.turnIds(deviceId, sessionId)) ?? []
      const wanted = new Set([
        keys.turnIds(deviceId, sessionId),
        keys.answers(deviceId, sessionId),
        keys.pendingQuestions(deviceId, sessionId),
        keys.proposals(deviceId, sessionId),
      ])
      const answers = store.get<AskAnswers>(keys.answers(deviceId, sessionId)) ?? NO_ANSWERS
      const pending =
        store.get<PendingQuestion[]>(keys.pendingQuestions(deviceId, sessionId)) ?? NO_PENDING
      const proposals =
        store.get<SessionProposalView[]>(keys.proposals(deviceId, sessionId)) ?? NO_PROPOSALS
      const changed =
        previousAnswers !== answers ||
        previousPending !== pending ||
        previousProposals !== proposals
      const waiting = new Set(pending.flatMap((q) => q.replyIds)),
        known = new Set<string>()
      for (const turnId of turnIds) {
        if (omitted.has(turnId)) continue
        const turnKey = keys.turn(deviceId, sessionId, turnId)
        wanted.add(turnKey)
        const turn = store.get<TurnView>(turnKey)
        const rawItems: ItemView[] = []
        for (const id of turn?.itemIds ?? []) {
          const key = keys.item(deviceId, sessionId, id)
          wanted.add(key)
          const item = store.get<ItemView>(key)
          if (!item) continue
          rawItems.push(item)
          if (item.kind === 'agentMessage') for (const q of item.questions ?? []) known.add(q.id)
          if (item.kind === 'toolCall' && item.wrapUp?.ask)
            known.add(wrapQuestionId(item.id, item.questionSource))
        }
        if (turn) {
          let cached = turnCache.get(turnId)
          if (
            !cached ||
            cached.status !== turn.status ||
            cached.items.length !== rawItems.length ||
            rawItems.some((item, i) => item !== cached?.items[i])
          ) {
            cached = {
              status: turn.status,
              items: rawItems,
              shown: searchableItems(turn, rawItems),
            }
            turnCache.set(turnId, cached)
          }
          for (const item of rawItems) if (cached.shown.has(item.id)) all.push({ turnId, item })
          if (turn.status === 'failed' && turn.error)
            all.push({
              turnId,
              item: {
                id: `search-error:${turnId}`,
                kind: 'notice',
                label: turn.error,
                detail: null,
              },
            })
        }
      }
      const currentTurns = new Set(turnIds)
      for (const id of turnCache.keys()) if (!currentTurns.has(id)) turnCache.delete(id)
      for (const q of pending)
        all.push({
          turnId: q.turnId,
          item: {
            id: `pending:${q.id}`,
            kind: 'notice',
            label: q.title,
            detail: q.options.map((o) => o.label).join('\n'),
          },
        })
      for (const [key, off] of bindings)
        if (!wanted.has(key)) {
          off()
          bindings.delete(key)
        }
      for (const key of wanted)
        if (!bindings.has(key)) bindings.set(key, store.subscribe(key, schedule))
      const alive = new Set(all.map((s) => s.item.id)),
        removed = [...previous.keys()].filter((id) => !alive.has(id))
      for (const id of removed) {
        previous.delete(id)
        indexed.delete(id)
      }
      const sources: { source: SearchSource; original: ItemView }[] = []
      for (const { turnId, item } of all) {
        const fresh = previous.get(item.id) !== item || !indexed.has(item.id)
        const contextual =
          changed &&
          (item.kind === 'toolCall' || (item.kind === 'agentMessage' && !!item.questions?.length))
        if (!fresh && !contextual && item.kind !== 'userMessage') continue
        const excluded =
          ['command', 'fileChange', 'webSearch'].includes(item.kind) ||
          (item.kind === 'toolCall' && !item.asked && !item.wrapUp && !item.spawned)
        const card = excluded
          ? null
          : searchCardItem(searchProposalItem(item, proposals, Date.now()), answers, waiting, known)
        if (!card) {
          if (indexed.has(item.id)) removed.push(item.id)
          indexed.delete(item.id)
          previous.set(item.id, item)
          continue
        }
        if (!fresh && !contextual) continue
        const safe = searchTransferItem(
          card.kind === 'notice' ? { ...card, label: t.text(card.label) } : card,
        )
        sources.push({ source: { turnId, item: safe }, original: item })
      }
      worker.postMessage({ type: 'update', sources: [], removed })
      let batch: SearchSource[] = [],
        originals: ItemView[] = [],
        size = 0
      const send = () => {
        worker.postMessage({ type: 'update', sources: batch, removed: [] })
        for (const item of originals) {
          previous.set(item.id, item)
          indexed.add(item.id)
        }
        batch = []
        originals = []
        size = 0
      }
      for (const { source, original } of sources) {
        if (stopped || mine !== revision) return
        batch.push(source)
        originals.push(original)
        size += 'text' in source.item ? source.item.text.length : 1024
        if (batch.length >= 128 || size >= 128 * 1024) {
          send()
          await new Promise<void>((resolve) => window.setTimeout(resolve, 0))
        }
      }
      if (stopped || mine !== revision) return
      send()
      previousProposals = proposals
      previousAnswers = answers
      previousPending = pending
      worker.postMessage({
        type: 'query',
        query: input.current,
        revision: mine,
        order: all.map((s) => s.item.id),
      })
    }
    function schedule() {
      if (stopped) return
      if (building) {
        again = true
        return
      }
      if (timer) return
      setBusy(true)
      timer = window.setTimeout(() => {
        timer = 0
        building = true
        again = false
        revision++
        void post().finally(() => {
          building = false
          if (again) schedule()
        })
      }, 120)
    }
    worker.onmessage = (event: MessageEvent<SearchResult>) => {
      if (stopped || event.data.revision !== revision) return
      setResult(event.data)
      setBusy(false)
    }
    worker.onerror = () => {
      if (!stopped) {
        setFailed(true)
        setBusy(false)
      }
    }
    request.current = () => {
      revision++
      window.clearTimeout(timer)
      timer = 0
      schedule()
    }
    setFailed(false)
    setResult(EMPTY)
    schedule()
    return () => {
      stopped = true
      request.current = null
      window.clearTimeout(timer)
      worker.terminate()
      for (const off of bindings.values()) off()
    }
  }, [store, deviceId, sessionId, skip, t])
  useEffect(() => {
    input.current = query
    request.current?.()
  }, [query])
  return { result, busy, failed }
}
