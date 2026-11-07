import {
  type DeviceView,
  keys,
  originalRanges,
  type TitleHit,
  type TitleSearchResult,
  type WorkspaceView,
} from '@litch/core'
import { useCallback, useEffect, useRef, useState } from 'react'
import type { Selection } from '../app/App.tsx'
import { useT } from '../app/appearance.ts'
import { nameOf } from '../app/device.ts'
import { ago } from '../app/format.ts'
import { Close, Icon } from '../app/icons.tsx'
import { currentPlatform } from '../app/platform.ts'
import { useKey, useKeys, useServices } from '../app/services.tsx'
import { onSearch } from './actions.ts'
import { focusSearchSession } from './focus.ts'
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
  const previousFocus = useRef<HTMLElement | null>(null)
  const show = useCallback(() => {
    const input = document.querySelector<HTMLInputElement>('.search-dialog input')
    if (input) {
      input.focus()
      input.select()
      return
    }
    previousFocus.current = document.activeElement as HTMLElement
    setOpen(true)
  }, [])
  const close = useCallback((restoreFocus = true) => {
    setOpen(false)
    if (!restoreFocus) return
    requestAnimationFrame(() => {
      const element = previousFocus.current
      ;(element?.isConnected
        ? element
        : document.querySelector<HTMLElement>('.search-sidebar')
      )?.focus({ preventScroll: true })
    })
  }, [])
  useEffect(() => onSearch(show), [show])
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (
        !event.defaultPrevented &&
        !event.isComposing &&
        (currentPlatform() === 'mac'
          ? event.metaKey && !event.ctrlKey
          : event.ctrlKey && !event.metaKey) &&
        event.shiftKey &&
        !event.altKey &&
        event.code === 'KeyF'
      ) {
        event.preventDefault()
        show()
      }
    }
    document.addEventListener('keydown', key)
    return () => document.removeEventListener('keydown', key)
  }, [show])
  return open ? <TitleDialog onClose={close} onOpen={onOpen} /> : null
}

function TitleDialog({
  onOpen,
  onClose,
}: {
  onOpen(selection: Selection, archived: boolean): void
  onClose(restoreFocus?: boolean): void
}) {
  const { channel } = useServices()
  const t = useT()
  const ids = useKey<string[]>(keys.devices) ?? EMPTY_IDS
  const devices = useKeys<DeviceView>(ids.map(keys.device))
  const workspaces = useKeys<WorkspaceView[]>(ids.map(keys.workspaces))
  const dialog = useRef<HTMLDialogElement>(null)
  const input = useRef<HTMLInputElement>(null)
  const [query, setQuery] = useState('')
  const [chosen, setChosen] = useState('')
  const [results, setResults] = useState<Record<string, TitleSearchResult>>({})
  const [failed, setFailed] = useState<Set<string>>(new Set())
  const [refreshing, setRefreshing] = useState(false)
  const [active, setActive] = useState(0)
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
    const online = onlineIds.split('\n').filter(Boolean)
    let left = online.length
    setRefreshing(left > 0)
    for (const deviceId of online) {
      void Promise.all([
        channel.command('device.loadArchived', { deviceId }),
        ...(attempt ? [channel.command('device.refresh', { deviceId })] : []),
      ])
        .then(
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
        .finally(() => {
          if (!cancelled && --left === 0) setRefreshing(false)
        })
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
      setActive(0)
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
  const selected = Math.min(active, Math.max(0, rows.length - 1))
  const choose = (index: number) => {
    const row = rows[index]
    if (!row) return
    onClose(false)
    onOpen({ deviceId: row.deviceId, sessionId: row.session.id }, row.archived)
    if (!row.archived) focusSearchSession(row.deviceId, row.session.id)
  }
  useEffect(() => {
    dialog.current
      ?.querySelector(`[data-result-index="${selected}"]`)
      ?.scrollIntoView({ block: 'nearest' })
  }, [selected])
  return (
    <dialog
      ref={dialog}
      className="modal search-dialog"
      aria-labelledby="title-search-heading"
      onCancel={() => onClose()}
      onClose={() => onClose()}
    >
      <header className="modal-head">
        <h2 id="title-search-heading">{t('search.titles')}</h2>
        {/* 不常用：一个图标，悬停写明做什么 */}
        <button
          type="button"
          className="ibtn search-refresh"
          disabled={refreshing}
          aria-label={t(refreshing ? 'search.refreshing' : 'search.refresh')}
          title={t(refreshing ? 'search.refreshing' : 'search.refresh')}
          onClick={() => setAttempt((n) => n + 1)}
        >
          <Icon name="reload" />
        </button>
        <button
          type="button"
          className="ibtn"
          onClick={() => onClose()}
          aria-label={t('search.close')}
          title={`${t('search.close')} (Esc)`}
        >
          <Close />
        </button>
      </header>
      <div className="modal-body">
        <div className="search-controls">
          <input
            type="text"
            ref={input}
            maxLength={256}
            value={query}
            aria-label={t('search.query')}
            placeholder={t('search.titlePlaceholder')}
            title={t('search.titleScope')}
            role="combobox"
            aria-expanded={true}
            aria-controls="title-search-results"
            aria-autocomplete="list"
            aria-activedescendant={rows.length ? `title-search-result-${selected}` : undefined}
            onKeyDown={(e) => {
              if (e.nativeEvent.isComposing) return
              if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                e.preventDefault()
                setActive(
                  (selected + (e.key === 'ArrowDown' ? 1 : -1) + rows.length) % (rows.length || 1),
                )
              } else if (e.key === 'Enter') {
                e.preventDefault()
                choose(selected)
              }
            }}
            onChange={(e) => setQuery(e.target.value)}
          />
          <select
            value={chosen}
            onChange={(e) => {
              setChosen(e.target.value)
              setActive(0)
            }}
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
        <div
          className="search-results"
          id="title-search-results"
          role="listbox"
          aria-label={t('search.titles')}
        >
          {rows.map(({ session, deviceId, archived }, index) => {
            const device = devices.find((d) => d?.id === deviceId)
            const title = t.text(session.title)
            const project =
              workspaces[ids.indexOf(deviceId)]?.find((w) => w.id === session.workspaceId)?.name ??
              t('workspace.none')
            return (
              <button
                key={`${deviceId}:${session.id}`}
                id={`title-search-result-${index}`}
                role="option"
                aria-selected={index === selected}
                data-result-index={index}
                type="button"
                tabIndex={-1}
                onClick={() => choose(index)}
              >
                <span className="search-result-title">
                  <strong title={title}>
                    <Highlighted text={title} query={query} />
                  </strong>
                  <span className="dim">{ago(session.updatedAt, Date.now(), t)}</span>
                  {archived ? <span className="pill">{t('search.archived')}</span> : null}
                </span>
                <span className="dim search-result-meta" title={session.cwd}>
                  {device ? t.text(device.name) : deviceId} · {project} ·{' '}
                  {nameOf(device, session.harness, t)}
                </span>
              </button>
            )
          })}
        </div>
        {!loading && rows.length === 0 ? <p>{t('search.empty')}</p> : null}
        {Object.values(results).some((result) => result.hasMore) ? (
          <p>{t('search.titleLimit')}</p>
        ) : null}
        {/* 离线、没读全、读取失败：写在结果后面，不在输入框下面单占一行 */}
        <div className="search-coverage" role="status">
          {devices.map((device) => {
            if (!device || (chosen && device.id !== chosen)) return null
            const message =
              device.connection !== 'online'
                ? t('search.offline')
                : failed.has(device.id)
                  ? t('search.refreshFailed')
                  : results[device.id] && !results[device.id]?.complete
                    ? t('search.incomplete')
                    : ''
            return message ? (
              <span key={device.id}>
                {t.text(device.name)} · {message}
              </span>
            ) : null
          })}
        </div>
      </div>
    </dialog>
  )
}
