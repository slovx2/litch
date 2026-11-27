import type { DeviceView } from '@litch/core'
import { useEffect, useRef, useState } from 'react'
import type { Selection } from '../app/App.tsx'
import { useT } from '../app/appearance.ts'
import { useNow } from '../app/clock.ts'
import { badgeOf, chipTitle, downHarness } from '../app/device.ts'
import { reasonOf } from '../app/errors.ts'
import { ago, monthLabel, stampFull } from '../app/format.ts'
import { Icon } from '../app/icons.tsx'
import { useServices } from '../app/services.tsx'
import { Highlighted } from '../search/Highlighted.tsx'
import { RowMenu } from '../sidebar/RowMenu.tsx'
import { groupShelf, SHELF_PAGE, type ShelfBucket, type ShelfRow } from './shelf.ts'

interface ShelfListProps {
  device: DeviceView
  /** 已经筛过、按时间倒序的行 */
  rows: ShelfRow[]
  query: string
  onOpen(selection: Selection): void
}

/** 一台设备的已归档对话：按日期分组，先画一页，滚到底再接着画。换设备、换查询由外面换 key，从头画起 */
export function ShelfList({ device, rows, query, onOpen }: ShelfListProps) {
  const { channel } = useServices()
  const t = useT()
  const now = useNow()
  const [shown, setShown] = useState(SHELF_PAGE)
  /** 正在恢复或删除的那一行 */
  const [busy, setBusy] = useState<string | null>(null)
  const [rowFailure, setRowFailure] = useState<{ id: string; text: string } | null>(null)
  const tail = useRef<HTMLDivElement>(null)
  const online = device.connection === 'online'
  const deviceId = device.id
  const more = rows.length > shown

  // 末尾那一条露出来就再画一页。每画完一页重新观察：一页没占满一屏时，刚接上就会再报一次
  // biome-ignore lint/correctness/useExhaustiveDependencies: shown 变了要重新观察
  useEffect(() => {
    const element = tail.current
    if (!more || !element) return
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) setShown((n) => n + SHELF_PAGE)
      },
      { rootMargin: '240px' },
    )
    observer.observe(element)
    return () => observer.disconnect()
  }, [more, shown])

  const act = (sessionId: string, command: 'session.unarchive' | 'session.delete') => {
    setBusy(sessionId)
    setRowFailure(null)
    channel
      .command(command, { deviceId, sessionId })
      .catch((error: unknown) => {
        const key =
          command === 'session.delete' ? 'archived.deleteFailed' : 'archived.restoreFailed'
        setRowFailure({ id: sessionId, text: t(key, { reason: reasonOf(error, t) }) })
      })
      .finally(() => setBusy(null))
  }

  const groupName = (bucket: ShelfBucket) =>
    bucket.kind === 'calendar'
      ? monthLabel(bucket.year, bucket.month, t.lang)
      : t(`archived.group.${bucket.kind}`)

  const offlineNote = online ? undefined : t('archived.offline')
  return (
    <>
      {groupShelf(rows.slice(0, shown), now).map((group) => (
        <section key={group.key} className="arch-group" aria-label={groupName(group.bucket)}>
          <h2 className="arch-group-head">{groupName(group.bucket)}</h2>
          <ul className="arch-list">
            {group.rows.map(({ session, title, project }) => {
              const id = session.id
              const pending = busy === id
              const disabled = offlineNote ?? (pending ? true : undefined)
              return (
                <li key={id} className="arch-item" data-session={id}>
                  <div className="arch-line">
                    {/* 点标题就是只读地打开看。设备没连着的时候取不到内容，只是一行字 */}
                    {online ? (
                      <button
                        type="button"
                        className="arch-title arch-open ell"
                        title={`${title}\n${t('archived.open')}`}
                        onClick={() => onOpen({ deviceId, sessionId: id })}
                      >
                        <Highlighted text={title} query={query} />
                      </button>
                    ) : (
                      <span className="arch-title ell" title={title}>
                        <Highlighted text={title} query={query} />
                      </span>
                    )}
                    <span className="arch-where ell" title={session.cwd}>
                      {project === null ? (
                        t('workspace.none')
                      ) : (
                        <Highlighted text={project} query={query} />
                      )}
                    </span>
                    <span
                      className={downHarness(device, session.harness) ? 'chip off' : 'chip'}
                      title={chipTitle(device, session.harness, t)}
                    >
                      {badgeOf(device, session.harness)}
                    </span>
                    <span
                      className="arch-time"
                      title={t('archived.updated', { time: stampFull(session.updatedAt, t.lang) })}
                    >
                      {ago(session.updatedAt, now, t)}
                    </span>
                    {/* 操作悬停或聚焦才出，盖在时间上 */}
                    <span className="arch-acts">
                      <button
                        type="button"
                        className="ibtn arch-restore"
                        title={offlineNote ?? t('archived.restore')}
                        aria-label={t('archived.restore')}
                        disabled={!online || pending}
                        onClick={() => act(id, 'session.unarchive')}
                      >
                        <Icon name="undo" />
                      </button>
                      <RowMenu
                        label={t('session.menu')}
                        className="row-more arch-more"
                        actions={[
                          {
                            id: 'open',
                            title: t('archived.open'),
                            ...(offlineNote ? { disabled: offlineNote } : {}),
                          },
                          {
                            id: 'restore',
                            title: t('archived.restore'),
                            ...(disabled ? { disabled } : {}),
                          },
                          {
                            id: 'delete',
                            title: t('session.delete'),
                            ...(disabled ? { disabled } : {}),
                            confirm: {
                              title: t('session.delete.title'),
                              note: t('session.delete.note'),
                              yes: t('session.delete'),
                              no: t('permission.confirm.no'),
                            },
                          },
                        ]}
                        onAction={(action) => {
                          if (action === 'open') onOpen({ deviceId, sessionId: id })
                          else act(id, action === 'delete' ? 'session.delete' : 'session.unarchive')
                        }}
                      />
                    </span>
                  </div>
                  {rowFailure?.id === id ? (
                    <div className="arch-note err">{rowFailure.text}</div>
                  ) : null}
                </li>
              )
            })}
          </ul>
        </section>
      ))}
      {more ? <div ref={tail} className="arch-tail" aria-hidden="true" /> : null}
    </>
  )
}
