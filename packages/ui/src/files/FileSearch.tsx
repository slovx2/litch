// 找文件。问的是设备上的模糊搜索（整棵树里找），不是在已经展开的那些行里过滤。
// 打字的时候等一小会儿再问（防抖在这里）；接着打字，上一次没回来的就取消掉（取消在核心）。
import type { ChannelErrorShape, FileMatch } from '@litch/core'
import { type MouseEvent, type ReactNode, useEffect, useState } from 'react'
import { useT } from '../app/appearance.ts'
import { whyNot } from '../app/errors.ts'
import { Icon } from '../app/icons.tsx'
import { useServices } from '../app/services.tsx'

/** 停下打字这么久才去问 */
const DEBOUNCE_MS = 160

export interface Search {
  /** idle：没在找（搜索框是空的） */
  status: 'idle' | 'searching' | 'ready' | 'failed'
  /** matches 是给哪句话找的。还在找新的那一句时，这里是上一句的结果 */
  query: string
  matches: readonly FileMatch[]
  error: ChannelErrorShape | null
}

const IDLE: Search = { status: 'idle', query: '', matches: [], error: null }

export function useFileSearch(deviceId: string, root: string, raw: string): Search {
  const { channel } = useServices()
  const [search, setSearch] = useState<Search>(IDLE)
  const query = raw.trim()

  useEffect(() => {
    if (!query) {
      setSearch(IDLE)
      return
    }
    // 上一句的结果先留着：新的到了再换，中间不闪成空的
    setSearch((before) => ({ ...before, status: 'searching', error: null }))
    const abort = new AbortController()
    const timer = window.setTimeout(() => {
      channel.command('files.search', { deviceId, root, query }, { signal: abort.signal }).then(
        (found) => {
          if (abort.signal.aborted) return
          setSearch({ status: 'ready', query: found.query, matches: found.matches, error: null })
        },
        (error: ChannelErrorShape) => {
          if (abort.signal.aborted || error.code === 'cancelled') return
          setSearch({ status: 'failed', query, matches: [], error })
        },
      )
    }, DEBOUNCE_MS)
    return () => {
      window.clearTimeout(timer)
      abort.abort()
    }
  }, [channel, deviceId, root, query])

  return search
}

/** 一段字里对上了的那些标出来。chars 是整条路径按字切开的，画的是其中 from 到 to 这一段 */
function marked(chars: string[], from: number, to: number, hits: ReadonlySet<number>): ReactNode[] {
  const out: ReactNode[] = []
  let at = from
  while (at < to) {
    const hit = hits.has(at)
    let end = at + 1
    while (end < to && hits.has(end) === hit) end++
    const text = chars.slice(at, end).join('')
    out.push(hit ? <mark key={at}>{text}</mark> : text)
    at = end
  }
  return out
}

/** 结果在页面上的标识：给搜索框的 aria-activedescendant 指 */
export const resultId = (index: number): string => `ft-hit-${index}`

export function SearchResults({
  search,
  active,
  onPick,
  onOpen,
  onMenu,
}: {
  search: Search
  /** 键盘走到了第几条 */
  active: number
  /** 点了一条：文件是预览，目录是在树里露出来 */
  onPick(match: FileMatch): void
  /** 双击：固定打开 */
  onOpen(match: FileMatch): void
  onMenu(match: FileMatch, event: MouseEvent): void
}) {
  const t = useT()
  if (search.status === 'failed') {
    return (
      <div className="ft-hold" data-hold={search.error?.code ?? 'failed'} role="status">
        <b>
          {t(
            search.error?.code === 'unsupported'
              ? 'files.search.unsupported'
              : 'files.search.failed',
          )}
        </b>
        <span>{search.error ? whyNot(search.error, t) : ''}</span>
      </div>
    )
  }
  if (search.matches.length === 0) {
    return (
      <div className="ft-hold" data-hold={search.status} role="status">
        <span>{t(search.status === 'ready' ? 'files.search.none' : 'files.search.searching')}</span>
      </div>
    )
  }
  return (
    <div
      className="ft-hits"
      id="ft-hits"
      role="listbox"
      aria-label={t('files.search.results')}
      aria-busy={search.status === 'searching'}
      data-query={search.query}
    >
      {search.matches.map((match, index) => {
        const chars = Array.from(match.relative)
        const name = chars.lastIndexOf('/') + 1
        const hits = new Set(match.indices ?? [])
        return (
          // biome-ignore lint/a11y/useKeyWithClickEvents: 键盘操作在搜索框里接（上下键、回车），结果自己不拿焦点
          <div
            key={match.path}
            id={resultId(index)}
            className="ft-hit"
            role="option"
            tabIndex={-1}
            aria-selected={index === active}
            data-path={match.path}
            data-kind={match.kind}
            title={match.relative}
            onClick={() => onPick(match)}
            onDoubleClick={() => onOpen(match)}
            onContextMenu={(event) => onMenu(match, event)}
          >
            <Icon name={match.kind === 'dir' ? 'folder' : 'file'} small />
            <span className="ft-hit-name">{marked(chars, name, chars.length, hits)}</span>
            <span className="ft-hit-dir ell">{marked(chars, 0, Math.max(name - 1, 0), hits)}</span>
          </div>
        )
      })}
    </div>
  )
}
