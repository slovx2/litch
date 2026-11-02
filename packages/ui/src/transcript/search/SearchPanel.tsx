import { type SearchHit, searchQuery } from '@litch/core'
import { type RefObject, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useT } from '../../app/appearance.ts'
import { Close, Icon } from '../../app/icons.tsx'
import { useServices } from '../../app/services.tsx'
import { revealSearchParents, searchDOM } from './reveal.ts'
import { useSearch } from './useSearch.ts'
import { viewportAnchor } from './viewport.ts'

interface Props {
  deviceId: string
  sessionId: string
  skip?: readonly string[] | undefined
  root: RefObject<HTMLDivElement | null>
  onTarget(hit: SearchHit | null): void
  reveal(element: Element, range?: Range): void
  updateRange(range: Range): void
  onClose(): void
}
const keyOf = (hit: SearchHit | undefined) => (hit ? `${hit.itemId}:${hit.ordinal}` : '')

export function SearchPanel({
  deviceId,
  sessionId,
  skip,
  root,
  onTarget,
  reveal,
  updateRange,
  onClose,
}: Props) {
  const t = useT()
  const { store } = useServices().replica
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState('')
  const [anchor, setAnchor] = useState(() => viewportAnchor(root.current))
  const [missing, setMissing] = useState(false)
  const input = useRef<HTMLInputElement>(null)
  const float = useRef<HTMLDivElement>(null)
  // 内容最上面留出的空跟着查找条的实际高度走（窄的对话区里它会折成两行），最早的几行才不会被盖住
  useLayoutEffect(() => {
    const bar = float.current
    if (!bar) return
    const measure = () =>
      root.current?.style.setProperty('--find-room', `${bar.offsetTop + bar.offsetHeight + 8}px`)
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(bar)
    return () => observer.disconnect()
  }, [root])
  const repaintCurrent = useRef<(() => void) | null>(null)
  const lastPosition = useRef('')
  const { result, busy, failed, searchable } = useSearch(deviceId, sessionId, query, skip, anchor)
  const chosen = result.hits.findIndex((h) => keyOf(h) === selected)
  const at = chosen < 0 ? (result.nearest ?? 0) : chosen
  const hit = result.hits[at] ?? null
  const current = useRef(hit)
  current.current = hit
  const hitKey = hit ? JSON.stringify([result.query, hit.itemId, hit.ordinal]) : ''
  // 首次最近项一旦选定，流式追加不改变当前项。
  useEffect(() => {
    if (hit && chosen < 0 && result.query === searchQuery(query)) setSelected(keyOf(hit))
  }, [hit, chosen, query, result.query])
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
  // biome-ignore lint/correctness/useExhaustiveDependencies: 仅命中标识变化时定位，流式结果对象变化不能重新定位。
  useEffect(() => {
    onTarget(current.current)
  }, [hitKey, onTarget])
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
  // biome-ignore lint/correctness/useExhaustiveDependencies: hitKey 是定位边界，最新命中由 ref 读取。
  useEffect(() => {
    const hit = current.current
    const highlights = CSS.highlights
    highlights.delete('litch-find')
    highlights.delete('litch-find-current')
    if (!hit || !query || searchQuery(query) !== result.query) return
    const positionKey = JSON.stringify([result.query, hit.itemId, hit.ordinal])
    let frame = 0,
      stopped = false,
      tries = 0,
      positioned = lastPosition.current === positionKey,
      stable = 0
    const opened = new Set<HTMLDetailsElement>()
    setMissing(false)
    const paint = () => {
      frame = 0
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
      const ranges = searchDOM(roots, result.query, Infinity)
      const active = ranges[hit.ordinal]
      if (active) {
        const publish = () => {
          updateRange(active)
          const all: Range[] = []
          const scope = root.current?.closest('.main') ?? root.current
          const groups = new Map<string, Element[]>()
          for (const el of scope?.querySelectorAll('[data-search-item]') ?? []) {
            if (
              el.parentElement?.closest('[data-search-item]') ||
              !el.checkVisibility({ contentVisibilityAuto: true })
            )
              continue
            const id = el.getAttribute('data-search-item')!
            // 只标可搜索投影里的条目，不能把工具输出的相同词也涂亮。
            if (!searchable.current.has(id)) continue
            const group = groups.get(id) ?? []
            group.push(el)
            groups.set(id, group)
          }
          for (const group of groups.values()) all.push(...searchDOM(group, result.query))
          highlights.set('litch-find', new Highlight(...all))
          highlights.set('litch-find-current', new Highlight(active))
        }
        if (!positioned) {
          const element = active.startContainer.parentElement
          if (element) reveal(element, active)
          // content-visibility 会在滚到目标后改变高度，等布局稳定才宣布定位成功。
          frame = requestAnimationFrame(() => {
            if (stopped) return
            frame = 0
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
    const repaint = () => {
      if (!frame) frame = requestAnimationFrame(paint)
    }
    repaintCurrent.current = repaint
    const observer = new MutationObserver(() => {
      // React 替换文本节点会让旧 Range 收缩；同一微任务重画，不能留一帧空高亮。
      if (positioned) paint()
      else repaint()
    })
    const scroller = root.current?.parentElement
    scroller?.addEventListener('scroll', repaint, { passive: true })
    if (root.current)
      observer.observe(root.current, { subtree: true, childList: true, characterData: true })
    return () => {
      stopped = true
      repaintCurrent.current = null
      observer.disconnect()
      scroller?.removeEventListener('scroll', repaint)
      cancelAnimationFrame(frame)
      highlights.delete('litch-find')
      highlights.delete('litch-find-current')
      for (const details of opened) details.open = false
    }
  }, [hitKey, query, result.query, root, reveal, searchable, updateRange])
  // biome-ignore lint/correctness/useExhaustiveDependencies: 结果变化只重画范围，不重新定位。
  useEffect(() => {
    repaintCurrent.current?.()
  }, [result])
  return (
    <section
      className="search-bar"
      aria-label={t('search.inConversation')}
      data-search-bar=""
      data-search-session={JSON.stringify([deviceId, sessionId])}
    >
      {/* 浮在对话区右上角的一条，不占一整行、不把内容往下推 */}
      <div className="search-float" ref={float}>
        <input
          ref={input}
          type="text"
          value={query}
          maxLength={256}
          aria-label={t('search.query')}
          placeholder={t('search.inConversation')}
          onChange={(e) => {
            setAnchor(viewportAnchor(root.current, e.target.value))
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
        <span
          className="search-count"
          role="status"
          aria-live="polite"
          aria-label={
            result.count && !busy
              ? t('search.countSpoken', { current: at + 1, total: result.hits.length })
              : undefined
          }
        >
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
          disabled={!hit}
          onClick={() => move(-1)}
          aria-label={t('search.previous')}
          title={t('search.previous')}
        >
          <Icon name="up" />
        </button>
        <button
          type="button"
          disabled={!hit}
          onClick={() => move(1)}
          aria-label={t('search.next')}
          title={t('search.next')}
        >
          <Icon name="down" />
        </button>
        <button
          type="button"
          onClick={onClose}
          aria-label={t('search.close')}
          title={`${t('search.close')} (Esc)`}
        >
          <Close />
        </button>
        {missing || result.count > result.hits.length ? (
          <span className="search-note">
            {missing
              ? t('search.changed')
              : result.count > result.hits.length
                ? t('search.capped', { count: result.hits.length })
                : null}
          </span>
        ) : null}
      </div>
    </section>
  )
}
