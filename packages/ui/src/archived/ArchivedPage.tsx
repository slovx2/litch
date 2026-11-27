import { type DeviceView, keys, type SessionSummary, type WorkspaceView } from '@litch/core'
import {
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import type { Selection } from '../app/App.tsx'
import { useT } from '../app/appearance.ts'
import { wireStyle } from '../app/device.ts'
import { reasonOf } from '../app/errors.ts'
import { Archive, Close, Icon } from '../app/icons.tsx'
import { useKey, useKeys, useServices } from '../app/services.tsx'
import { ShelfList } from './ShelfList.tsx'
import {
  matchShelf,
  pickShelfDevice,
  rememberedShelfDevice,
  rememberShelfDevice,
  type ShelfRow,
} from './shelf.ts'

const EMPTY_IDS: string[] = []

interface ArchivedPageProps {
  /** 当前对话所在的设备：没选过设备时先看它的 */
  current: string | null
  onClose(): void
  /** 只读地打开其中一个看 */
  onOpen(selection: Selection): void
}

/**
 * 已归档对话：归档了的对话不在侧栏里，都在这一页。一次看一台设备的，顶上切设备、搜标题和项目；
 * 可以打开看、恢复或删掉
 */
export function ArchivedPage({ current, onClose, onOpen }: ArchivedPageProps) {
  const { channel } = useServices()
  const t = useT()
  const ids = useKey<string[]>(keys.devices) ?? EMPTY_IDS
  const devices = useKeys<DeviceView>(ids.map(keys.device))
  const lists = useKeys<SessionSummary[] | null>(ids.map(keys.archived))
  const spaces = useKeys<WorkspaceView[]>(ids.map(keys.workspaces))
  /** 没取到时的错误，按设备。怎么说到显示的时候再定：换了语言跟着换 */
  const [failures, setFailures] = useState<Record<string, unknown>>({})
  const [picked, setPicked] = useState<string | null>(rememberedShelfDevice)
  const [query, setQuery] = useState('')
  const input = useRef<HTMLInputElement>(null)
  const chosen = pickShelfDevice(ids, picked, current)
  const chosenAt = chosen === null ? -1 : ids.indexOf(chosen)
  const device = devices[chosenAt]

  // 页面打开、设备连上时向每台设备要一遍：切换器上要写每台的数量。之后的增减由核心跟着改
  const onlineIds = devices
    .filter((entry) => entry?.connection === 'online')
    .map((entry) => entry?.id)
    .join('\n')
  useEffect(() => {
    let cancelled = false
    for (const deviceId of onlineIds.split('\n').filter(Boolean)) {
      channel.command('device.loadArchived', { deviceId }).then(
        () => {
          if (cancelled) return
          setFailures((was) => {
            if (!(deviceId in was)) return was
            const { [deviceId]: _, ...rest } = was
            return rest
          })
        },
        (error: unknown) => {
          if (!cancelled) setFailures((was) => ({ ...was, [deviceId]: error }))
        },
      )
    }
    return () => {
      cancelled = true
    }
  }, [channel, onlineIds])

  /** 每台设备给人看的行；还没取到的是 null */
  const shelves = useMemo(
    () =>
      lists.map((list, n): ShelfRow[] | null =>
        list
          ? list.map((session) => ({
              session,
              title: t.text(session.title),
              project: spaces[n]?.find((entry) => entry.id === session.workspaceId)?.name ?? null,
            }))
          : null,
      ),
    [lists, spaces, t],
  )
  const matched = useMemo(
    () => shelves.map((rows) => (rows ? matchShelf(rows, query) : null)),
    [shelves, query],
  )

  // 进来先落在搜索框上
  useEffect(() => input.current?.focus({ preventScroll: true }), [])

  // Esc 回到对话。搜索框里有字时先清掉（在搜索框自己那里处理）
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return
      event.preventDefault()
      onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  const choose = (deviceId: string) => {
    setPicked(deviceId)
    rememberShelfDevice(deviceId)
  }
  const onTabKey = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const step = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0
    if (!step || chosenAt < 0) return
    event.preventDefault()
    const next = ids[(chosenAt + step + ids.length) % ids.length]
    if (!next) return
    choose(next)
    event.currentTarget.querySelector<HTMLElement>(`[data-device="${next}"]`)?.focus()
  }

  const rows = matched[chosenAt] ?? null
  const all = shelves[chosenAt] ?? null
  const failure = chosen !== null && chosen in failures ? failures[chosen] : undefined
  const online = device?.connection === 'online'
  const searching = query.trim() !== ''

  let body: ReactNode = null
  if (!device) body = null
  else if (failure !== undefined)
    body = (
      <div className="arch-note err">{t('archived.failed', { reason: reasonOf(failure, t) })}</div>
    )
  else if (all === null)
    body = <div className="arch-note">{t(online ? 'archived.loading' : 'archived.offline')}</div>
  else if (all.length === 0)
    body = (
      <div className="arch-empty">
        <Archive />
        <b>{t('archived.empty')}</b>
        <span>{t('archived.empty.hint')}</span>
      </div>
    )
  else if (rows && rows.length === 0) {
    // 这台上没搜到：别的设备上搜到了的，列出来点一下就过去
    const elsewhere = ids.flatMap((id, n) => {
      const found = matched[n]?.length ?? 0
      const other = devices[n]
      return id !== chosen && found > 0 && other ? [{ id, device: other, found }] : []
    })
    body = (
      <div className="arch-empty">
        <Icon name="search" />
        <b>{t('archived.noMatch', { query: query.trim() })}</b>
        {elsewhere.length > 0 ? (
          <span className="arch-elsewhere">
            {t('archived.elsewhere')}
            {elsewhere.map((entry) => (
              <button
                key={entry.id}
                type="button"
                className="btn ghost"
                style={wireStyle(entry.device.wire)}
                onClick={() => choose(entry.id)}
              >
                <i className="wire-sq" />
                {t.text(entry.device.name)}
                <span className="arch-count">{entry.found}</span>
              </button>
            ))}
          </span>
        ) : null}
        <button type="button" className="btn" onClick={() => setQuery('')}>
          {t('archived.search.clear')}
        </button>
      </div>
    )
  } else if (rows)
    body = (
      <ShelfList
        key={`${device.id}\n${query}`}
        device={device}
        rows={rows}
        query={query}
        onOpen={(selection) => {
          rememberShelfDevice(selection.deviceId)
          onOpen(selection)
        }}
      />
    )

  return (
    <div className="arch-page arch-shelf">
      <header className="arch-head">
        <h1>{t('archived.title')}</h1>
        <search className="arch-search">
          <Icon name="search" small />
          <input
            ref={input}
            type="text"
            maxLength={256}
            value={query}
            placeholder={t('archived.search')}
            aria-label={t('archived.search.label')}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key !== 'Escape' || event.nativeEvent.isComposing || !query) return
              event.preventDefault()
              setQuery('')
            }}
          />
          {query ? (
            <button
              type="button"
              className="ibtn"
              title={t('archived.search.clear')}
              aria-label={t('archived.search.clear')}
              onClick={() => {
                setQuery('')
                input.current?.focus()
              }}
            >
              <Close />
            </button>
          ) : null}
        </search>
        <button
          type="button"
          className="ibtn"
          title={t('archived.close')}
          aria-label={t('archived.close')}
          onClick={onClose}
        >
          <Close />
        </button>
      </header>
      {ids.length > 1 ? (
        <div
          className="arch-devs"
          role="tablist"
          aria-label={t('archived.devices')}
          onKeyDown={onTabKey}
        >
          {ids.map((id, n) => {
            const entry = devices[n]
            if (!entry) return null
            const found = matched[n]
            const loading = found == null && entry.connection === 'online' && !(id in failures)
            return (
              <button
                key={id}
                type="button"
                role="tab"
                data-device={id}
                aria-selected={id === chosen}
                tabIndex={id === chosen ? 0 : -1}
                className="arch-dev-tab"
                style={wireStyle(entry.wire)}
                title={entry.host}
                onClick={() => choose(id)}
              >
                <i className={entry.connection === 'online' ? 'wire-sq' : 'wire-sq off'} />
                <span className="ell">{t.text(entry.name)}</span>
                <span
                  className={searching ? 'arch-count hit' : 'arch-count'}
                  title={found == null ? t('archived.count.unknown') : undefined}
                >
                  {found == null ? (loading ? '…' : '–') : found.length}
                </span>
              </button>
            )
          })}
        </div>
      ) : null}
      <div className="arch-body" role={ids.length > 1 ? 'tabpanel' : undefined}>
        <div className="arch-col" style={wireStyle(device?.wire)}>
          {body}
        </div>
      </div>
    </div>
  )
}
