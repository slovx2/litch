import {
  type DeviceView,
  keys,
  originalRanges,
  type TitleHit,
  type TitleSearchResult,
} from '@litch/core'
import { useEffect, useRef, useState } from 'react'
import type { Selection } from '../app/App.tsx'
import { useT } from '../app/appearance.ts'
import { nameOf } from '../app/device.ts'
import { useKey, useKeys, useServices } from '../app/services.tsx'
import { onSearch } from './actions.ts'
import '../styles/search.css'

const EMPTY_IDS: string[] = []
function Highlighted({ text, query }: { text: string; query: string }) {
  const spans = originalRanges(text, query)
  let end = 0
  const content = spans.flatMap((span) => {
    const before = text.slice(end, span.start)
    end = span.end
    return [before, <mark key={span.start}>{text.slice(span.start, span.end)}</mark>]
  })
  return (
    <>
      {content}
      {text.slice(end)}
    </>
  )
}

export function TitleSearch({ onOpen }: { onOpen(selection: Selection, archived: boolean): void }) {
  const [open, setOpen] = useState(false)
  useEffect(() => onSearch(() => setOpen(true)), [])
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (
        !event.defaultPrevented &&
        !event.isComposing &&
        (event.metaKey || event.ctrlKey) &&
        event.shiftKey &&
        !event.altKey &&
        event.code === 'KeyF'
      ) {
        event.preventDefault()
        setOpen(true)
      }
    }
    document.addEventListener('keydown', key)
    return () => document.removeEventListener('keydown', key)
  }, [])
  return open ? <TitleDialog onClose={() => setOpen(false)} onOpen={onOpen} /> : null
}

function TitleDialog({
  onOpen,
  onClose,
}: {
  onOpen(selection: Selection, archived: boolean): void
  onClose(): void
}) {
  const { channel } = useServices()
  const t = useT()
  const ids = useKey<string[]>(keys.devices) ?? EMPTY_IDS
  const devices = useKeys<DeviceView>(ids.map(keys.device))
  const dialog = useRef<HTMLDialogElement>(null)
  const input = useRef<HTMLInputElement>(null)
  const [query, setQuery] = useState('')
  const [chosen, setChosen] = useState('')
  const [results, setResults] = useState<Record<string, TitleSearchResult>>({})
  const [failed, setFailed] = useState<Set<string>>(new Set())
  const [loading, setLoading] = useState(false)
  const [revision, setRevision] = useState(0)
  const [attempt, setAttempt] = useState(0)
  const lastQuery = useRef<string | null>(null)
  // 仅查询核心已保留的目录，不读网络/历史；对话改名和设备目录补齐后结果能自行更新。
  useEffect(() => {
    const timer = window.setInterval(() => setRevision((n) => n + 1), 2000)
    return () => window.clearInterval(timer)
  }, [])
  const onlineIds = devices
    .filter((d) => d?.connection === 'online')
    .map((d) => d?.id)
    .join('\n')
  useEffect(() => {
    dialog.current?.showModal()
    input.current?.focus()
  }, [])
  // 搜索页打开才读归档目录；请求失败保留已有快照，状态不能假装完整。
  useEffect(() => {
    let cancelled = false
    for (const deviceId of onlineIds.split('\n').filter(Boolean)) {
      void Promise.all([
        channel.command('device.loadArchived', { deviceId }),
        ...(attempt ? [channel.command('device.refresh', { deviceId })] : []),
      ]).then(
        () => {
          if (!cancelled) {
            setFailed((was) => {
              const next = new Set(was)
              next.delete(deviceId)
              return next
            })
            setRevision((n) => n + 1)
          }
        },
        () => {
          if (!cancelled) setFailed((was) => new Set([...was, deviceId]))
        },
      )
    }
    return () => {
      cancelled = true
    }
  }, [channel, onlineIds, attempt])
  // biome-ignore lint/correctness/useExhaustiveDependencies: 归档目录刷新成功后必须重查，revision 是刷新序号。
  useEffect(() => {
    let cancelled = false
    if (lastQuery.current !== query) {
      setLoading(true)
      setResults({})
      lastQuery.current = query
    }
    const timer = window.setTimeout(() => {
      let left = ids.length
      if (!left) setLoading(false)
      for (const deviceId of ids) {
        void channel
          .command('search.titles', {
            deviceId,
            query,
            limit: 100,
            untitled: t('session.untitled'),
          })
          .then(
            (result) => {
              if (!cancelled) setResults((was) => ({ ...was, [deviceId]: result }))
            },
            () => {
              if (!cancelled) setFailed((was) => new Set([...was, deviceId]))
            },
          )
          .finally(() => {
            if (!cancelled && --left === 0) setLoading(false)
          })
      }
    }, 150)
    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [channel, ids, query, revision, t])
  const rows: (TitleHit & { deviceId: string })[] = Object.entries(results)
    .flatMap(([deviceId, result]) =>
      chosen && deviceId !== chosen ? [] : result.hits.map((hit) => ({ ...hit, deviceId })),
    )
    .sort(
      (a, b) =>
        b.session.updatedAt - a.session.updatedAt ||
        a.deviceId.localeCompare(b.deviceId) ||
        a.session.id.localeCompare(b.session.id),
    )
  return (
    <dialog
      ref={dialog}
      className="search-dialog"
      aria-labelledby="title-search-heading"
      onCancel={onClose}
      onClose={onClose}
    >
      <header>
        <h2 id="title-search-heading">{t('search.titles')}</h2>
        <button type="button" onClick={() => setAttempt((n) => n + 1)}>
          {t('search.refresh')}
        </button>
        <button type="button" onClick={onClose} aria-label={t('search.close')}>
          ×
        </button>
      </header>
      <div className="search-controls">
        <input
          type="search"
          ref={input}
          maxLength={256}
          value={query}
          aria-label={t('search.query')}
          placeholder={t('search.titlePlaceholder')}
          onChange={(e) => setQuery(e.target.value)}
        />
        <select
          value={chosen}
          onChange={(e) => setChosen(e.target.value)}
          aria-label={t('search.device')}
        >
          <option value="">{t('search.allDevices')}</option>
          {devices.map((d) =>
            d ? (
              <option key={d.id} value={d.id}>
                {t.text(d.name)}
              </option>
            ) : null,
          )}
        </select>
      </div>
      <p className="dim">{t('search.titleScope')}</p>
      <div className="search-coverage" role="status">
        {devices.map((device) =>
          device && (!chosen || device.id === chosen) ? (
            <div key={device.id}>
              {t.text(device.name)} ·{' '}
              {device.connection !== 'online'
                ? t('search.offline')
                : failed.has(device.id)
                  ? t('search.incomplete')
                  : !results[device.id]
                    ? t('search.busy')
                    : !results[device.id]?.complete
                      ? t('search.incomplete')
                      : t('search.ready')}
            </div>
          ) : null,
        )}
      </div>
      <ul className="search-results">
        {rows.map(({ session, deviceId, archived }) => {
          const device = devices.find((d) => d?.id === deviceId)
          const title = t.text(session.title)
          return (
            <li key={`${deviceId}:${session.id}`}>
              <button
                type="button"
                onClick={() => {
                  onOpen({ deviceId, sessionId: session.id }, archived)
                  onClose()
                }}
              >
                <strong>
                  <Highlighted text={title} query={query} />
                </strong>
                <span className="dim">
                  {device ? t.text(device.name) : deviceId} · {nameOf(device, session.harness)} ·{' '}
                  {session.cwd}
                </span>
                <span className="dim">
                  {new Date(session.updatedAt).toLocaleString()}{' '}
                  {archived ? `· ${t('search.archived')}` : ''}
                </span>
              </button>
            </li>
          )
        })}
      </ul>
      {query && !loading && rows.length === 0 ? <p>{t('search.empty')}</p> : null}
      {Object.values(results).some((result) => result.hasMore) ? (
        <p>{t('search.titleLimit')}</p>
      ) : null}
    </dialog>
  )
}
