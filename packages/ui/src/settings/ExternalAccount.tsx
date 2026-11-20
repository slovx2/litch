import type {
  ExternalOwnerIdentity,
  ExternalOwnerInput,
  ExternalOwnerSyncRow,
  GlobalExternalOwner,
} from '@litch/core'
import { useEffect, useState } from 'react'
import { useT } from '../app/appearance.ts'
import { whyNot } from '../app/errors.ts'
import { Check, Icon } from '../app/icons.tsx'
import { useServices } from '../app/services.tsx'
import { useDevices } from '../composer/useNewPlace.ts'
import { ExternalLink } from '../devices/ExternalControls.tsx'
import { externalOperationId } from '../devices/external-view.ts'

const methods = ['profileUrl', 'userId', 'localGh'] as const

export function ExternalAccount() {
  const { channel } = useServices()
  const t = useT()
  const devices = useDevices()
  const [global, setGlobal] = useState<GlobalExternalOwner | null>(null)
  const [method, setMethod] = useState<ExternalOwnerInput['method']>('profileUrl')
  const [raw, setRaw] = useState('')
  const [candidate, setCandidate] = useState<ExternalOwnerIdentity | null>(null)
  const [rows, setRows] = useState<ExternalOwnerSyncRow[]>([])
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [loaded, setLoaded] = useState(false)
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<unknown>()

  useEffect(() => {
    let active = true
    void channel
      .command('external.owner.global.get', {})
      .then(async (result) => {
        const plan = result
          ? await channel.command('external.owner.global.plan', { owner: result.owner })
          : []
        if (!active) return
        setGlobal(result)
        setRows(plan)
        setLoaded(true)
      })
      .catch((error: unknown) => {
        if (active) setFailure(error)
      })
    return () => {
      active = false
    }
  }, [channel])

  const run = async (work: () => Promise<void>) => {
    setBusy(true)
    setFailure(undefined)
    try {
      await work()
    } catch (error) {
      setFailure(error)
    } finally {
      setBusy(false)
    }
  }
  const prepare = async (owner: ExternalOwnerIdentity) => {
    const plan = await channel.command('external.owner.global.plan', { owner })
    setCandidate(owner)
    setRows(plan)
    setSelected(new Set(plan.filter((row) => row.state === 'different').map((row) => row.deviceId)))
  }
  const reset = () => {
    setCandidate(null)
    setSelected(new Set())
  }
  const read = () =>
    run(async () => {
      const owner = await channel.command(
        'external.owner.resolve',
        method === 'localGh' ? { method } : { method, value: raw.trim() },
      )
      await prepare(owner)
    })
  const save = () =>
    run(async () => {
      if (!candidate) return
      const result = await channel.command('external.owner.global.set', {
        owner: candidate,
        expectedRevision: global?.revision ?? 0,
        operationId: externalOperationId(),
        devices: rows.flatMap((row) =>
          selected.has(row.deviceId) && row.expectedRevision !== null
            ? [{ deviceId: row.deviceId, expectedRevision: row.expectedRevision }]
            : [],
        ),
      })
      setGlobal(result.global)
      setRows(result.devices)
      reset()
    })
  const label = (id: string) => {
    const view = devices.find((device) => device.id === id)
    return view ? t.text(view.name) : id
  }
  const summary = candidate ?? global?.owner

  return (
    <section className="external-stack set-block" data-external-owner>
      <div className="set-rows">
        <div className="set-row">
          <span>{t('external.currentOwner')}</span>
          <span className="grow">
            {summary ? (
              <>
                <ExternalLink url={summary.profileUrl}>@{summary.loginCache}</ExternalLink>{' '}
                <span className="dim">· {summary.userId}</span>
              </>
            ) : (
              t(loaded ? 'external.noOwner' : 'external.loading')
            )}
          </span>
          {global && !candidate ? (
            <button
              type="button"
              className="mini external-button"
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  const fresh = await channel.command('external.owner.global.get', {})
                  setGlobal(fresh)
                  if (fresh) await prepare(fresh.owner)
                })
              }
            >
              <Icon name="reload" small />
              {t('external.reviewSync')}
            </button>
          ) : null}
        </div>
      </div>
      <form
        className="external-stack"
        onSubmit={(event) => {
          event.preventDefault()
          void read()
        }}
      >
        <div className="seg external-segments">
          {methods.map((item) => (
            <button
              key={item}
              type="button"
              aria-pressed={item === method}
              disabled={busy}
              onClick={() => {
                setMethod(item)
                setRaw('')
                reset()
                setRows([])
              }}
            >
              {t(`external.${item}`)}
            </button>
          ))}
        </div>
        <div className="external-row">
          {method !== 'localGh' ? (
            <input
              className="grow"
              aria-label={t(`external.${method}`)}
              placeholder={method === 'profileUrl' ? 'https://github.com/octocat' : '583231'}
              inputMode={method === 'userId' ? 'numeric' : 'url'}
              value={raw}
              required
              onChange={(event) => {
                setRaw(event.target.value)
                reset()
                setRows([])
              }}
            />
          ) : null}
          <button type="submit" className="btn" disabled={busy || !loaded}>
            {t('external.resolve')}
          </button>
        </div>
      </form>
      {rows.length ? (
        <section className="external-stack">
          <h3>{t('external.syncDevices')}</h3>
          <ul className="set-rows external-list">
            {rows.map((row) => (
              <li key={row.deviceId} className="set-row">
                {candidate && row.state === 'different' ? (
                  <input
                    type="checkbox"
                    aria-label={t('external.selectDevice', { device: label(row.deviceId) })}
                    checked={selected.has(row.deviceId)}
                    disabled={busy}
                    onChange={(event) => {
                      const next = new Set(selected)
                      if (event.target.checked) next.add(row.deviceId)
                      else next.delete(row.deviceId)
                      setSelected(next)
                    }}
                  />
                ) : null}
                <span className="grow">
                  {label(row.deviceId)}{' '}
                  {row.owner ? <span className="dim">· @{row.owner.loginCache}</span> : null}
                </span>
                <span className={`pill ${row.state === 'synced' ? 'ok' : 'mute'}`}>
                  {t(`external.${row.state}`)}
                </span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      {candidate ? (
        <div className="external-actions">
          <button type="button" className="btn ghost" disabled={busy} onClick={reset}>
            {t('external.cancel')}
          </button>
          <button
            type="button"
            className="btn external-button"
            disabled={busy}
            onClick={() => void save()}
          >
            <Check />
            {t('external.sync')}
          </button>
        </div>
      ) : null}
      {failure ? (
        <p className="err" role="alert">
          {whyNot(failure, t)}
        </p>
      ) : null}
    </section>
  )
}
