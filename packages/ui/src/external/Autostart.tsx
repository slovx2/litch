// 无人值守页的“开机自启”一行：开关、服务管理器与是否要登录、需要修复时的原因。
// 启用遇到手动起的实例要接管（会重启服务），关闭会停掉自启管着的实例：都先确认。
// 设备回 accepted 只是排队，实际结果等重连后读 lastOperation 与状态。
import type { DeviceAutostartStatus, DeviceView } from '@litch/core'
import { useEffect, useState } from 'react'
import { useT } from '../app/appearance.ts'
import { Confirm } from '../app/Confirm.tsx'
import { useServices } from '../app/services.tsx'
import { useRun } from './data.ts'
import { operationId } from './model.ts'
import { Switch } from './parts.tsx'

type Ask = { action: 'enable'; takeover: boolean } | { action: 'disable'; stop: boolean }

export function AutostartRow({
  device,
  status,
  writable,
}: {
  device: DeviceView
  status: DeviceAutostartStatus | null
  writable: boolean
}) {
  const t = useT()
  const { channel } = useServices()
  const act = useRun()
  const [ask, setAsk] = useState<Ask | null>(null)
  const [linger, setLinger] = useState(false)
  const [queued, setQueued] = useState(false)
  const online = device.connection === 'online'
  useEffect(() => {
    if (!writable || !online) setAsk(null)
  }, [writable, online])
  if (!status) return null
  const unsupported = status.state === 'unsupported' || status.serviceManager === 'unsupported'
  const on = status.state === 'enabled' || status.state === 'degraded'
  const pending = queued || status.lastOperation?.state === 'pending'

  const send = async (next: Ask) => {
    if (!writable || !online) return
    setAsk(null)
    const base = {
      deviceId: device.id,
      operationId: operationId(),
      expectedRevision: status.revision,
    }
    const result = await act.run(() =>
      next.action === 'enable'
        ? channel.command('external.autostart.enable', {
            ...base,
            ...(next.takeover ? { takeover: true } : {}),
            ...(linger ? { allowLinger: true } : {}),
          })
        : channel.command('external.autostart.disable', {
            ...base,
            ...(next.stop ? { confirmStop: true } : {}),
          }),
    )
    if (result && result.state === 'accepted') setQueued(true)
  }

  const toggle = () => {
    const managed = status.instance?.mode === 'managed'
    if (on) setAsk({ action: 'disable', stop: managed })
    else if (status.instance?.mode === 'manual') setAsk({ action: 'enable', takeover: true })
    else void send({ action: 'enable', takeover: false })
  }

  const where = t(`ext.autostart.manager.${status.serviceManager}`)
  const detail = unsupported
    ? t('ext.autostart.unsupported')
    : [
        where,
        status.state === 'degraded' ? t('ext.autostart.degraded') : null,
        status.requiresLogin ? t('ext.autostart.login') : t('ext.autostart.boot'),
        pending ? t('ext.autostart.pending') : null,
        status.lastOperation?.state === 'failed' ? t('ext.autostart.failed') : null,
      ]
        .filter(Boolean)
        .join(' · ')
  return (
    <div className="ext-block" data-ext-autostart={status.state}>
      <div className="ext-row">
        <span className="ext-row-name">{t('ext.autostart')}</span>
        <span className="ext-row-meta ell">{detail}</span>
        <span className="grow" />
        {status.serviceManager === 'systemd' && !on && status.linger !== 'unavailable' ? (
          <label className="ext-check" title={t('ext.autostart.lingerNote')}>
            <input
              type="checkbox"
              checked={linger || status.linger === 'enabled'}
              disabled={status.linger === 'enabled' || !online || !writable}
              onChange={(event) => setLinger(event.target.checked)}
            />
            {t('ext.autostart.linger')}
          </label>
        ) : null}
        <Switch
          act="autostart"
          checked={on}
          label={t('ext.autostart')}
          disabled={unsupported || !online || !writable || act.busy || pending}
          onChange={toggle}
        />
      </div>
      {status.repair ? (
        <div className="devp-note err" data-ext-repair={status.repair.code}>
          {status.repair.text[t.lang]}
        </div>
      ) : null}
      {act.error ? (
        <div className="devp-note err" role="alert">
          {act.error}
        </div>
      ) : null}
      {writable && online && ask ? (
        <Confirm
          title={t(ask.action === 'enable' ? 'ext.autostart.takeover' : 'ext.autostart.stop')}
          note={t(
            ask.action === 'enable' ? 'ext.autostart.takeoverNote' : 'ext.autostart.stopNote',
          )}
          yes={t(ask.action === 'enable' ? 'ext.autostart.takeoverYes' : 'ext.autostart.stopYes')}
          no={t('ext.cancel')}
          tone={ask.action === 'enable' ? 'primary' : 'danger'}
          onYes={() => void send(ask)}
          onClose={() => setAsk(null)}
        />
      ) : null}
    </div>
  )
}
