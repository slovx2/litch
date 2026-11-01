import { type SearchHit, searchQuery } from '@litch/core'
import { type RefObject, useCallback, useEffect, useRef, useState } from 'react'
import { useT } from '../../app/appearance.ts'
import { useServices } from '../../app/services.tsx'
import { revealSearchParents, searchDOM } from './reveal.ts'
import { useSearch } from './useSearch.ts'

interface Props {
  deviceId: string
  sessionId: string
  skip?: readonly string[] | undefined
  root: RefObject<HTMLDivElement | null>
  onTarget(hit: SearchHit | null): void
  reveal(element: Element): void
  onClose(): void
}
const keyOf = (hit: SearchHit | undefined) => (hit ? `${hit.itemId}:${hit.ordinal}` : '')

export function SearchPanel({ deviceId, sessionId, skip, root, onTarget, reveal, onClose }: Props) {
  const t = useT()
  const { store } = useServices().replica
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState('')
  const [missing, setMissing] = useState(false)
  const input = useRef<HTMLInputElement>(null)
  const lastPosition = useRef('')
  const { result, busy, failed } = useSearch(deviceId, sessionId, query, skip)
  const at = Math.max(
    0,
    result.hits.findIndex((h) => keyOf(h) === selected),
  )
  const hit = result.hits[at] ?? null
  const move = useCallback(
    (direction: number) => {
      const count = result.hits.length
      if (count) setSelected(keyOf(result.hits[(at + direction + count) % count]))
    },
    [result.hits, at],
  )
  useEffect(() => {
    input.current?.focus()
  }, [])
  const targetId = hit?.itemId ?? null,
    targetTurn = hit?.turnId ?? ''
  useEffect(() => {
    onTarget(hit)
  }, [hit, onTarget])
  useEffect(() => {
    revealSearchParents(
      store,
      deviceId,
      sessionId,
      targetId ? { itemId: targetId, turnId: targetTurn } : null,
    )
    return () => {
      revealSearchParents(store, deviceId, sessionId, null)
    }
  }, [store, deviceId, sessionId, targetId, targetTurn])
  useEffect(() => () => onTarget(null), [onTarget])
  useEffect(() => {
    const highlights = CSS.highlights
    highlights.delete('litch-find')
    highlights.delete('litch-find-current')
    if (!hit || !query || searchQuery(query) !== result.query) return
    const positionKey = JSON.stringify([result.query, hit.itemId, hit.ordinal, hit.start])
    let frame = 0,
      stopped = false,
      tries = 0,
      positioned = lastPosition.current === positionKey,
      stable = 0
    const opened = new Set<HTMLDetailsElement>()
    setMissing(false)
    const paint = () => {
      if (stopped) return
      const roots = [
        ...((hit.itemId.startsWith('pending:')
          ? root.current?.closest('.main')
          : root.current
        )?.querySelectorAll(`[data-search-item="${CSS.escape(hit.itemId)}"]`) ?? []),
      ].filter(
        (el) =>
          el.parentElement?.closest(`[data-search-item="${CSS.escape(hit.itemId)}"]`) === null,
      )
      for (const element of roots)
        for (const details of element.querySelectorAll('details')) {
          if (!details.open) {
            opened.add(details)
            details.open = true
          }
        }
      const ranges = searchDOM(roots, result.query)
      const active = ranges[hit.ordinal]
      if (active) {
        const publish = () => {
          highlights.set('litch-find', new Highlight(...ranges))
          highlights.set('litch-find-current', new Highlight(active))
        }
        if (!positioned) {
          const element = active.startContainer.parentElement
          if (element) reveal(element)
          // content-visibility 会在滚到目标后改变高度，等布局稳定才宣布定位成功。
          frame = requestAnimationFrame(() => {
            const rect = active.getBoundingClientRect()
            const viewport = (
              hit.itemId.startsWith('pending:')
                ? root.current?.closest('.main')
                : root.current?.parentElement
            )?.getBoundingClientRect()
            if (viewport && rect.bottom > viewport.top && rect.top < viewport.bottom) {
              if (++stable < 3) {
                frame = requestAnimationFrame(paint)
                return
              }
              positioned = true
              lastPosition.current = positionKey
              publish()
            } else if (++tries < 180) paint()
            else setMissing(true)
          })
        } else publish()
      } else if (!positioned && ++tries < 180) frame = requestAnimationFrame(paint)
      else if (!positioned) setMissing(true)
    }
    frame = requestAnimationFrame(paint)
    const observer = new MutationObserver(() => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(paint)
    })
    if (root.current)
      observer.observe(root.current, { subtree: true, childList: true, characterData: true })
    return () => {
      stopped = true
      observer.disconnect()
      cancelAnimationFrame(frame)
      highlights.delete('litch-find')
      highlights.delete('litch-find-current')
      for (const details of opened) details.open = false
    }
  }, [hit, query, result.query, root, reveal])
  return (
    <section
      className="search-bar"
      aria-label={t('search.inConversation')}
      data-search-bar=""
      data-search-session={JSON.stringify([deviceId, sessionId])}
    >
      <input
        ref={input}
        type="search"
        value={query}
        maxLength={256}
        aria-label={t('search.query')}
        placeholder={t('search.inConversation')}
        onChange={(e) => {
          setQuery(e.target.value)
          setSelected('')
        }}
        onKeyDown={(e) => {
          if (e.nativeEvent.isComposing) return
          if (e.key === 'Escape') {
            e.stopPropagation()
            onClose()
          }
          if (e.key === 'Enter') {
            e.preventDefault()
            move(e.shiftKey ? -1 : 1)
          }
        }}
      />
      <span className="search-count" role="status" aria-live="polite">
        {failed
          ? t('search.failed')
          : busy
            ? t('search.busy')
            : query
              ? result.count
                ? t('search.count', { current: at + 1, total: result.hits.length })
                : t('search.empty')
              : ''}
      </span>
      <button
        type="button"
        disabled={!hit || busy}
        onClick={() => move(-1)}
        aria-label={t('search.previous')}
      >
        ↑
      </button>
      <button
        type="button"
        disabled={!hit || busy}
        onClick={() => move(1)}
        aria-label={t('search.next')}
      >
        ↓
      </button>
      <button type="button" onClick={onClose} aria-label={t('search.close')}>
        ×
      </button>
      <span className="search-note">
        {missing
          ? t('search.changed')
          : result.count > result.hits.length
            ? t('search.capped', { count: result.hits.length })
            : t('search.available')}
      </span>
    </section>
  )
}
