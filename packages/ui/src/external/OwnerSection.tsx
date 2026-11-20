// 设置 → GitHub 账号：登记“我”（owner）的 GitHub 账号，并同步到各台设备。
// 三种登记方式：个人主页、数字 ID、本机 gh 登录；先查到账号给人确认，再保存并同步到在线设备。
// 离线、不支持的设备只显示状态，回到在线后再点同步。
import {
  type DeviceView,
  type ExternalOwnerIdentity,
  type ExternalOwnerInput,
  type ExternalOwnerSyncRow,
  type GlobalExternalOwner,
  keys,
} from '@litch/core'
import { useCallback, useEffect, useState } from 'react'
import { useT } from '../app/appearance.ts'
import { Icon } from '../app/icons.tsx'
import { useKey, useServices } from '../app/services.tsx'
import { useRun } from './data.ts'
import { operationId } from './model.ts'
import { Avatar, Dot, type DotTone } from './parts.tsx'

const SYNC_TONE: Record<ExternalOwnerSyncRow['state'], DotTone> = {
  synced: 'ok',
  different: 'wait',
  offline: 'off',
  unsupported: 'off',
  failed: 'err',
}

function DeviceName({ deviceId }: { deviceId: string }) {
  const t = useT()
  const device = useKey<DeviceView>(keys.device(deviceId))
  return <>{device ? t.text(device.name) : deviceId}</>
}

function Account({ owner }: { owner: ExternalOwnerIdentity }) {
  const t = useT()
  return (
    <span className="ext-account">
      <Avatar userId={owner.userId} login={owner.loginCache} />
      <b className="ell">{owner.loginCache}</b>
      <span className="dim mono">#{owner.userId}</span>
      <span className="pill mute">{t(`ext.owner.method.${owner.method}`)}</span>
    </span>
  )
}

export function OwnerSection() {
  const t = useT()
  const { channel } = useServices()
  const [global, setGlobal] = useState<GlobalExternalOwner | null | undefined>(undefined)
  const [rows, setRows] = useState<ExternalOwnerSyncRow[]>([])
  const [editing, setEditing] = useState(false)
  const [method, setMethod] = useState<ExternalOwnerInput['method']>('profileUrl')
  const [value, setValue] = useState('')
  const [found, setFound] = useState<ExternalOwnerIdentity | null>(null)
  const load = useRun()
  const act = useRun()

  const refresh = useCallback(async () => {
    const current = await load.run(() => channel.command('external.owner.global.get', {}))
    if (current === undefined) return
    setGlobal(current)
    if (current)
      setRows(
        (await load.run(() =>
          channel.command('external.owner.global.plan', { owner: current.owner }),
        )) ?? [],
      )
    else setRows([])
  }, [channel, load.run])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const save = async (owner: ExternalOwnerIdentity) => {
    const plan = await act.run(() => channel.command('external.owner.global.plan', { owner }))
    if (!plan) return
    const done = await act.run(() =>
      channel.command('external.owner.global.set', {
        owner,
        expectedRevision: global?.revision ?? 0,
        operationId: operationId(),
        devices: plan.flatMap((row) =>
          row.state === 'different' && row.expectedRevision !== null
            ? [{ deviceId: row.deviceId, expectedRevision: row.expectedRevision }]
            : [],
        ),
      }),
    )
    if (!done) return
    setGlobal(done.global)
    setRows(done.devices)
    setEditing(false)
    setFound(null)
    setValue('')
  }

  const resolve = async () => {
    const input: ExternalOwnerInput =
      method === 'localGh' ? { method } : { method, value: value.trim() }
    const owner = await act.run(() => channel.command('external.owner.resolve', input))
    if (owner) setFound(owner)
  }

  const unsynced = rows.some((row) => row.state === 'different' || row.state === 'failed')
  return (
    <section className="set-block ext-owner" data-ext-owner={global ? 'set' : 'none'}>
      <h3>{t('ext.owner.title')}</h3>
      <div className="set-rows">
        <div className="set-row">
          {global === undefined ? (
            <span className="set-note">{load.error || t('ext.loading')}</span>
          ) : global ? (
            <Account owner={global.owner} />
          ) : (
            <span className="set-note">{t('ext.owner.none')}</span>
          )}
          <span className="grow" />
          {global && unsynced ? (
            <button
              type="button"
              className="ibtn"
              data-act="owner-sync"
              title={t('ext.owner.sync')}
              aria-label={t('ext.owner.sync')}
              disabled={act.busy}
              onClick={() => void save(global.owner)}
            >
              <Icon name="reload" small />
            </button>
          ) : null}
          <button
            type="button"
            className="ibtn"
            data-act="owner-edit"
            title={t(global ? 'ext.owner.change' : 'ext.owner.add')}
            aria-label={t(global ? 'ext.owner.change' : 'ext.owner.add')}
            aria-expanded={editing}
            onClick={() => {
              setEditing(!editing)
              setFound(null)
              act.setError('')
            }}
          >
            <Icon name={global ? 'edit' : 'plus'} small />
          </button>
        </div>
        {rows.length ? (
          <div className="set-row ext-sync" data-ext-sync>
            {rows.map((row) => (
              <span key={row.deviceId} className="ext-sync-item" data-sync={row.state}>
                <Dot tone={SYNC_TONE[row.state]} label={t(`ext.owner.sync.${row.state}`)} />
                <DeviceName deviceId={row.deviceId} />
              </span>
            ))}
          </div>
        ) : null}
        {editing ? (
          <div className="set-row ext-owner-form" data-ext-owner-form>
            <div className="seg">
              {(['profileUrl', 'userId', 'localGh'] as const).map((one) => (
                <button
                  type="button"
                  key={one}
                  aria-pressed={method === one}
                  onClick={() => {
                    setMethod(one)
                    setFound(null)
                  }}
                >
                  {t(`ext.owner.method.${one}`)}
                </button>
              ))}
            </div>
            {method === 'localGh' ? null : (
              <input
                className="req-input ext-owner-input"
                value={value}
                spellCheck={false}
                placeholder={t(method === 'profileUrl' ? 'ext.owner.urlHint' : 'ext.owner.idHint')}
                aria-label={t(`ext.owner.method.${method}`)}
                onChange={(event) => {
                  setValue(event.target.value)
                  setFound(null)
                }}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && !event.nativeEvent.isComposing) void resolve()
                }}
              />
            )}
            <button
              type="button"
              className="btn"
              data-act="owner-resolve"
              disabled={act.busy || (method !== 'localGh' && !value.trim())}
              onClick={() => void resolve()}
            >
              {t('ext.owner.resolve')}
            </button>
          </div>
        ) : null}
        {editing && found ? (
          <div className="set-row" data-ext-owner-found>
            <Account owner={found} />
            <span className="grow" />
            <button
              type="button"
              className="btn primary"
              data-act="owner-save"
              disabled={act.busy}
              onClick={() => void save(found)}
            >
              {t('ext.owner.save')}
            </button>
          </div>
        ) : null}
        {act.error ? (
          <div className="set-row">
            <span className="set-note err" role="alert">
              {act.error}
            </span>
          </div>
        ) : null}
      </div>
    </section>
  )
}
