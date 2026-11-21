// 设备的无人值守页（盖住设备详情的一页）：开机自启 → ① GitHub 身份 → ② 仓库 → ③ 经理分配。
// 数据全部来自这台设备的 externalDevice 快照（本机、远程同一条路）；身份的凭据明细与仓库授权按配置版本重读。
import type { DeviceView } from '@litch/core'
import { useEffect } from 'react'
import { useT } from '../app/appearance.ts'
import { Back, Close } from '../app/icons.tsx'
import { Assignments, type RepoChoice } from './Assignments.tsx'
import { AutostartRow } from './Autostart.tsx'
import { useDeviceManagers, useExternalDevice, useIdentityDetails } from './data.ts'
import { Identities } from './Identities.tsx'
import { allowed, repoLabel } from './model.ts'
import { Repos } from './Repos.tsx'

export function UnattendedPage({
  device,
  onBack,
  onClose,
}: {
  device: DeviceView
  onBack(): void
  onClose(): void
}) {
  const t = useT()
  const view = useExternalDevice(device.id)
  const online = device.connection === 'online'
  const writable = online && allowed(view?.access, 'configure')
  const configuration = view?.configuration?.value ?? null
  const sources = view?.sources.value ?? null
  const details = useIdentityDetails(device.id, configuration?.revision ?? null, writable)
  const managers = useDeviceManagers(device.id)
  const heads = configuration?.identities ?? []
  const repos: RepoChoice[] = (sources ?? []).flatMap((status) =>
    status.source.repos.map((repo) => ({ repoId: repo.repoId, label: repoLabel(repo) })),
  )
  const snapshotError = view?.sources.error ?? view?.configuration?.error ?? null

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return
      if (document.querySelector('dialog[open]')) return
      event.preventDefault()
      onBack()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onBack])

  return (
    <div className="arch-page devp mng-page ext-page" data-ext-page={device.id}>
      <header className="arch-head">
        <button
          type="button"
          className="ibtn"
          data-act="ext-back"
          title={t('manage.back')}
          aria-label={t('manage.back')}
          onClick={onBack}
        >
          <Back />
        </button>
        <div className="grow">
          <h1 className="mng-title">
            <span className="ell">{t('ext.title')}</span>
            <span className="hc-where dim ell">{t.text(device.name)}</span>
          </h1>
        </div>
        <button
          type="button"
          className="ibtn"
          title={t('devices.close')}
          aria-label={t('devices.close')}
          onClick={onClose}
        >
          <Close />
        </button>
      </header>
      <div className="arch-body">
        <div className="mng-wrap ext-wrap">
          {!online ? (
            <div className="devp-note" data-ext-offline>
              {t(view?.sources.fetchedAt ? 'ext.offlineCached' : 'ext.offline')}
            </div>
          ) : null}
          {snapshotError ? (
            <div className="devp-note err" role="alert">
              {snapshotError.text ? t.text(snapshotError.text) : snapshotError.message}
            </div>
          ) : null}
          <AutostartRow
            device={device}
            status={view?.autostart.value ?? null}
            writable={online && allowed(view?.access, 'configureAutostart')}
          />
          <Identities
            device={device}
            identities={details.identities}
            error={details.error}
            writable={writable}
            readOnly={online && view?.access?.configure === false}
          />
          <Repos
            device={device}
            sources={sources}
            access={view?.access}
            identities={heads}
            repositories={details.repositories}
            managers={managers}
            error={details.error}
          />
          <Assignments
            device={device}
            writable={writable}
            managers={managers}
            assignments={configuration?.assignments ?? null}
            identities={heads}
            repos={repos}
            repositories={details.repositories}
          />
        </div>
      </div>
    </div>
  )
}
