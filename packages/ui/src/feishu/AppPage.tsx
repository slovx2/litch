// 飞书应用详情（盖住设备详情的一页）：概况（连接、启用、经理）→ 能力自检 → 群 → 私聊绑定 → 发件 → App Secret → 移除。
// 数据来自这台设备的 feishuDevice 快照；写操作带 expectedRevision，冲突时重读这一个应用并提示重试。
// 这条连接不是设备管理员（admin 为 false）时写操作都不可点，页首写明原因。
import type { DeviceView } from '@litch/core'
import { useCallback, useEffect, useState } from 'react'
import { useT } from '../app/appearance.ts'
import { Confirm } from '../app/Confirm.tsx'
import { Back, Close } from '../app/icons.tsx'
import { useServices } from '../app/services.tsx'
import { useDeviceManagers } from '../external/data.ts'
import { Field, Switch } from '../external/parts.tsx'
import { AppBindings } from './AppBindings.tsx'
import { AppCapability } from './AppCapability.tsx'
import { AppChats } from './AppChats.tsx'
import { AppOutbox } from './AppOutbox.tsx'
import { AppSecret } from './AppSecret.tsx'
import { useFeishuDevice, useFeishuRun } from './data.ts'
import { BotAvatar, StateDot } from './FeishuSection.tsx'
import {
  connectionReason,
  type FeishuApp,
  managerOptions,
  shownState,
  writeBlock,
} from './model.ts'

export function AppPage({
  device,
  appId,
  onBack,
  onClose,
}: {
  device: DeviceView
  appId: string
  onBack(): void
  onClose(): void
}) {
  const t = useT()
  const { channel } = useServices()
  const view = useFeishuDevice(device.id)
  const managers = useDeviceManagers(device.id)
  const online = device.connection === 'online'
  const apps = view?.apps.value ?? null
  const listed = apps?.find((one) => one.appId === appId) ?? null
  /** 命令结果或冲突后重读到的这一个应用：比快照新才用 */
  const [fresh, setFresh] = useState<FeishuApp | null>(null)
  const app = listed && fresh && fresh.revision > listed.revision ? fresh : listed
  const [removing, setRemoving] = useState(false)
  const refetch = useCallback(() => {
    channel.command('feishu.app.get', { deviceId: device.id, appId }).then(
      (result) => setFresh(result.app),
      () => {},
    )
  }, [channel, device.id, appId])
  const act = useFeishuRun(refetch)

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

  const update = async (patch: { managerId?: string | null; enabled?: boolean }) => {
    if (!app) return
    const result = await act.run(() =>
      channel.command('feishu.app.update', {
        deviceId: device.id,
        appId,
        expectedRevision: app.revision,
        ...patch,
      }),
    )
    if (result) setFresh(result.app)
  }
  const remove = async () => {
    if (!app) return
    setRemoving(false)
    const result = await act.run(() =>
      channel.command('feishu.app.remove', {
        deviceId: device.id,
        appId,
        expectedRevision: app.revision,
      }),
    )
    if (result) onBack()
  }

  const options = apps ? managerOptions(apps, managers, appId) : []
  const reason = app ? connectionReason(app) : null
  const block = writeBlock(online, view?.admin)
  const writable = block === null && !act.busy
  const denied = block === 'readOnly' ? t('feishu.readOnly') : undefined
  const snapshotError = view?.apps.error ?? null
  return (
    <div className="arch-page devp mng-page ext-page" data-feishu-page={appId}>
      <header className="arch-head">
        <button
          type="button"
          className="ibtn"
          data-act="feishu-back"
          title={t('manage.back')}
          aria-label={t('manage.back')}
          onClick={onBack}
        >
          <Back />
        </button>
        <div className="grow">
          <h1 className="mng-title">
            <span className="ell">{app?.name || appId}</span>
            <span className="hc-where dim ell">
              {t('feishu.title')} · {t.text(device.name)}
            </span>
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
            <div className="devp-note" data-feishu-offline>
              {t(view?.apps.fetchedAt ? 'feishu.offlineCached' : 'feishu.offline')}
            </div>
          ) : null}
          {block === 'readOnly' ? (
            <div className="devp-note" data-feishu-read-only>
              {t('feishu.readOnly')}
            </div>
          ) : null}
          {snapshotError ? (
            <div className="devp-note err" role="alert">
              {snapshotError.text ? t.text(snapshotError.text) : snapshotError.message}
            </div>
          ) : null}
          {act.error ? (
            <div className="devp-note err" role="alert" data-feishu-error>
              {act.error}
            </div>
          ) : null}
          {!app ? (
            <div className="ext-empty">
              {apps === null ? t('feishu.loading') : t('feishu.error.app_not_found')}
            </div>
          ) : (
            <>
              <section className="ext-block" data-feishu-overview>
                <div className="ext-block-head">
                  <BotAvatar app={app} />
                  <h3>{t('feishu.app.overview')}</h3>
                  <span className="grow" />
                  <span className="ext-row-meta mono">{app.appId}</span>
                </div>
                <Field label={t('feishu.app.state')}>
                  <StateDot app={app} />
                  <span>
                    {t(`feishu.state.${shownState(app)}`)}
                    {reason ? ` · ${t(`feishu.conn.${reason}`)}` : ''}
                  </span>
                </Field>
                <Field label={t('feishu.app.enabled')}>
                  <Switch
                    checked={app.enabled}
                    label={t('feishu.app.enabled')}
                    act="feishu-enabled"
                    disabled={!writable}
                    title={denied}
                    onChange={(enabled) => void update({ enabled })}
                  />
                  <span className="ext-row-meta">{t('feishu.app.disableNote')}</span>
                </Field>
                <Field label={t('feishu.app.manager')}>
                  <select
                    className="ext-select"
                    aria-label={t('feishu.app.manager')}
                    data-feishu-manager
                    value={app.managerId ?? ''}
                    title={denied}
                    disabled={!writable}
                    onChange={(event) => void update({ managerId: event.target.value || null })}
                  >
                    <option value="">{t('feishu.unassigned')}</option>
                    {options.map((one) => (
                      <option key={one.id} value={one.id} disabled={one.takenBy !== null}>
                        {one.takenBy
                          ? t('feishu.app.managerTaken', { name: one.name, app: one.takenBy })
                          : one.name}
                      </option>
                    ))}
                  </select>
                  {options.length === 0 ? (
                    <span className="ext-row-meta">{t('feishu.app.noManagers')}</span>
                  ) : null}
                </Field>
              </section>
              <AppCapability deviceId={device.id} app={app} block={block} onApp={setFresh} />
              <AppChats deviceId={device.id} appId={app.appId} block={block} />
              <AppBindings deviceId={device.id} app={app} block={block} />
              <AppOutbox deviceId={device.id} appId={app.appId} block={block} />
              <AppSecret deviceId={device.id} app={app} block={block} onApp={setFresh} />
              <section className="ext-block" data-feishu-remove>
                <div className="ext-actions">
                  <button
                    type="button"
                    className="btn danger"
                    data-act="feishu-remove"
                    title={denied}
                    disabled={!writable}
                    onClick={() => setRemoving(true)}
                  >
                    {t('feishu.remove')}
                  </button>
                </div>
              </section>
            </>
          )}
        </div>
      </div>
      {removing && app ? (
        <Confirm
          title={t('feishu.remove.title', { name: app.name || app.appId })}
          note={t('feishu.remove.note')}
          yes={t('feishu.remove')}
          no={t('feishu.cancel')}
          onYes={() => void remove()}
          onClose={() => setRemoving(false)}
        />
      ) : null}
    </div>
  )
}
