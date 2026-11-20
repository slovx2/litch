import type { DeviceView, ExternalSourceStatus } from '@litch/core'
import { useId, useState } from 'react'
import { useT } from '../app/appearance.ts'
import { Fold } from '../app/Fold.tsx'
import { Icon } from '../app/icons.tsx'
import { showToast } from '../app/toasts.tsx'
import { useManagers } from '../manager/data.ts'
import { ExternalManagerAssignment } from '../manager/ExternalManagerAssignment.tsx'
import { ExternalLink, ExternalStatus } from './ExternalControls.tsx'
import { ExternalIdentities } from './ExternalIdentities.tsx'
import { ExternalSourceWizard } from './ExternalSourceWizard.tsx'
import { ExternalUnattended } from './ExternalUnattended.tsx'
import { useExternalTopic } from './external-view.ts'

export function ExternalDeviceSections({ device }: { device: DeviceView }) {
  const t = useT()
  const id = useId()
  const { managers } = useManagers()
  const active = managers.filter(
    (manager) => manager.deviceId === device.id && manager.status === 'active',
  )
  const [open, setOpen] = useState(false)
  const [editing, setEdit] = useState<ExternalSourceStatus | null>()
  const [pickedManager, setManager] = useState('')
  const view = useExternalTopic({ kind: 'externalDevice', deviceId: device.id }, open)
  const sources = view?.sources.value ?? []
  const configuration = view?.configuration?.value ?? null
  const online = device.connection === 'online'
  const manager = active.find((one) => one.id === pickedManager)

  if (device.mode === 'single') return null
  return (
    <section className="mng-sec" data-sec="external-unattended" data-open={open}>
      <div className="mng-sec-head">
        <h2>
          <Fold open={open} controls={id} onToggle={() => setOpen(!open)}>
            {t('external.unattended')}
          </Fold>
        </h2>
        {view?.autostart.value ? (
          <span className="pill mute">{t(`external.autostart.${view.autostart.value.state}`)}</span>
        ) : null}
      </div>
      {open ? (
        <div className="mng-sec-body external-stack" id={id}>
          {view?.owner.value ? (
            <div className="external-row">
              <span>{t('external.configuredOwner')}</span>
              <ExternalLink url={view.owner.value.profileUrl}>
                @{view.owner.value.loginCache}
              </ExternalLink>
              <span className="dim">· {view.owner.value.userId}</span>
            </div>
          ) : null}
          <ExternalStatus view={view?.sources} />
          {view?.sources.available ? (
            <>
              <ExternalStatus view={view.configuration} />
              <ExternalIdentities
                deviceId={device.id}
                online={online}
                revision={configuration?.revision}
              />
              <section className="external-panel external-stack" data-sec="external-sources">
                <div className="external-row">
                  <h3 className="grow">② {t('external.repositories')}</h3>
                  <button
                    type="button"
                    className="mini external-button"
                    disabled={!online || !configuration?.identities.length}
                    title={
                      !online
                        ? t('external.offline')
                        : !configuration?.identities.length
                          ? t('external.identityFirst')
                          : undefined
                    }
                    onClick={() => setEdit(null)}
                  >
                    <Icon name="plus" small />
                    {t('external.addRepo')}
                  </button>
                </div>
                {view.sources.value?.length === 0 && online ? (
                  <p className="external-note">{t('external.noSources')}</p>
                ) : null}
                <ul className="external-list">
                  {sources.map((entry) => (
                    <li className="external-row" key={entry.source.sourceId}>
                      <div className="grow">
                        <b>
                          {entry.source.repos
                            .map((repo) => `${repo.owner}/${repo.name}`)
                            .join(', ')}
                        </b>
                      </div>
                      <span className={`pill ${entry.source.enabled ? 'ok' : 'mute'}`}>
                        {t(
                          entry.source.enabled
                            ? 'external.runtime.enabled'
                            : 'external.runtime.paused',
                        )}
                      </span>
                      <button
                        type="button"
                        className="ibtn"
                        disabled={!online}
                        title={t(online ? 'external.editRepo' : 'external.offline')}
                        aria-label={t('external.editRepo')}
                        onClick={() => setEdit(entry)}
                      >
                        <Icon name="edit" small />
                      </button>
                    </li>
                  ))}
                </ul>
              </section>
              <section className="external-panel external-stack" data-external-assignments>
                <h3>③ {t('external.assignments')}</h3>
                {active.length ? (
                  <label className="external-field">
                    {t('external.routeManager')}
                    <select
                      className="req-input"
                      value={pickedManager}
                      onChange={(event) => setManager(event.target.value)}
                    >
                      <option value="">{t('external.routeManagerEmpty')}</option>
                      {active.map((one) => (
                        <option key={one.id} value={one.id}>
                          {one.name || one.id}
                        </option>
                      ))}
                    </select>
                  </label>
                ) : (
                  <p className="external-note">{t('external.previewNoTarget')}</p>
                )}
                {manager ? <ExternalManagerAssignment manager={manager} key={manager.id} /> : null}
              </section>
            </>
          ) : null}
          <ExternalUnattended device={device} view={view} />
        </div>
      ) : null}
      {editing !== undefined ? (
        <ExternalSourceWizard
          deviceId={device.id}
          existing={editing}
          online={online}
          sources={sources}
          managers={active}
          configuration={configuration}
          close={() => setEdit(undefined)}
          saved={() => {
            setEdit(undefined)
            showToast({
              id: 'external-source-saved',
              lifeMs: 3000,
              text: (translate) => translate('external.sourceSaved'),
            })
          }}
        />
      ) : null}
    </section>
  )
}
