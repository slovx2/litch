import { keys, type ModelRankingSnapshot, moveRankedModel } from '@litch/core'
import { useEffect, useState } from 'react'
import { useT } from '../../app/appearance.ts'
import { whyNot } from '../../app/errors.ts'
import { useLeaveGuard } from '../../app/leave-guard.tsx'
import { useKey, useServices } from '../../app/services.tsx'

/** 草稿只在保存时成为设备策略；预填型号与打开页面都不构成用户改级。 */
export function ModelRanking({ deviceId }: { deviceId: string }) {
  const { channel } = useServices()
  const t = useT()
  const latest = useKey<ModelRankingSnapshot>(keys.modelRanking(deviceId))
  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState<ModelRankingSnapshot | null>(null)
  const [dirty, setDirty] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<unknown>(null)
  const [reset, setReset] = useState(false)
  useEffect(() => {
    if (latest && !dirty) setDraft(latest)
  }, [latest, dirty])
  const leave = useLeaveGuard(dirty)
  const request = async (action: 'read' | 'write' | 'reset') => {
    setBusy(true)
    setError(null)
    try {
      const result =
        action === 'read'
          ? await channel.command('device.modelRanking.read', { deviceId })
          : action === 'reset'
            ? await channel.command('device.modelRanking.reset', {
                deviceId,
                expectedRevision: draft?.revision ?? 0,
              })
            : draft &&
              (await channel.command('device.modelRanking.write', {
                deviceId,
                expectedRevision: draft.revision,
                tiers: draft.tiers,
                unranked: draft.unranked,
                models: draft.models,
                manual: draft.manual ?? [],
              }))
      if (result) {
        setDraft(result)
        setDirty(false)
        setReset(false)
      }
      return Boolean(result)
    } catch (failure) {
      setError(failure)
      return false
    } finally {
      setBusy(false)
    }
  }
  leave.current = () => request('write')
  const move = (key: string, target: number | null, separate = false) => {
    if (!draft || busy) return
    setDraft({ ...draft, ...moveRankedModel(draft, key, target, separate) })
    setDirty(true)
  }
  const group = (members: string[], level: number | null) => (
    <fieldset
      key={level ?? 'unranked'}
      disabled={busy}
      onDragOver={(event) => event.preventDefault()}
      onDrop={(event) => {
        event.preventDefault()
        const key = event.dataTransfer.getData('application/litch-model')
        if (draft?.models.some((model) => model.key === key)) move(key, level)
      }}
    >
      <legend>
        {level === null ? t('ranking.unranked') : t('ranking.level', { level: level + 1 })}
      </legend>
      {members.map((key) => {
        const model = draft?.models.find((row) => row.key === key)
        if (!model) return null
        return (
          <div className="mng-row" key={key}>
            <button
              type="button"
              draggable={!busy}
              aria-label={`${t('ranking.move')} ${model.name}`}
              onClick={(event) =>
                event.currentTarget.parentElement?.querySelector('select')?.focus()
              }
              onDragStart={(event) => event.dataTransfer.setData('application/litch-model', key)}
            >
              ↕
            </button>
            <span className="mng-row-text">
              {model.name} · {model.harness}
              {model.available ? '' : ` · ${t('ranking.unavailable')}`}
            </span>
            <select
              aria-label={`${t('ranking.move')} ${model.name}`}
              value={level ?? 'unranked'}
              onChange={(event) => {
                const value = event.target.value
                move(
                  key,
                  value === 'unranked'
                    ? null
                    : value === 'new'
                      ? (draft?.tiers.length ?? 0)
                      : Number(value),
                  value === 'new',
                )
              }}
            >
              {draft?.tiers.map((tier, index) => (
                <option key={tier.join()} value={index}>
                  {t('ranking.level', { level: index + 1 })}
                </option>
              ))}
              <option value="new">{t('ranking.new')}</option>
              <option value="unranked">{t('ranking.unranked')}</option>
            </select>
          </div>
        )
      })}
    </fieldset>
  )
  return (
    <section className="mng-sec" data-model-ranking>
      <div className="mng-sec-head">
        <h2>{t('ranking.title')}</h2>
        <button
          type="button"
          disabled={busy}
          onClick={() => {
            setOpen(!open)
            if (!open && !dirty) void request('read')
          }}
        >
          {t(open ? 'ranking.close' : 'ranking.open')}
        </button>
      </div>
      {open && (
        <>
          <p className="mng-sec-note">{t('ranking.note')}</p>
          {error != null && <p role="alert">{whyNot(error, t)}</p>}
          {busy && <p role="status">{t('ranking.loading')}</p>}
          {draft && (
            <>
              <p>
                {t(draft.mode === 'custom' ? 'ranking.custom' : 'ranking.builtin')}
                {dirty ? ` · ${t('ranking.unsaved')}` : ''}
              </p>
              {Object.keys(draft.errors).length > 0 && (
                <p role="status">
                  {t('ranking.partial')}: {Object.keys(draft.errors).join(', ')}
                </p>
              )}
              {draft.tiers
                .map((members, level) => ({ members, level }))
                .reverse()
                .map(({ members, level }) => group(members, level))}
              {group(draft.unranked, null)}
              {draft.unranked.length > 0 && (
                <p className="mng-sec-note">{t('ranking.unknownNote')}</p>
              )}
              <button type="button" disabled={busy} onClick={() => void request('write')}>
                {t('ranking.save')}
              </button>
              <button type="button" disabled={busy} onClick={() => setReset(true)}>
                {t('ranking.reset')}
              </button>
              {reset && (
                <div>
                  <p>{t('ranking.resetNote')}</p>
                  <button type="button" disabled={busy} onClick={() => void request('reset')}>
                    {t('ranking.reset')}
                  </button>
                  <button type="button" onClick={() => setReset(false)}>
                    {t('ranking.cancel')}
                  </button>
                </div>
              )}
            </>
          )}
          <button type="button" disabled={busy} onClick={() => void request('read')}>
            {t('ranking.refresh')}
          </button>
        </>
      )}
    </section>
  )
}
