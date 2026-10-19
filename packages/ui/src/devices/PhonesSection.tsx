// 设备详情里的“手机”一节：这台设备上绑定了哪些手机（名字、绑定日期、撤销），和“在手机上使用…”的入口。
// 设备服务支持扫码绑定（DeviceView.pairing）才有；连着但服务太旧的说一句先升级；只有 codex 的设备不出这一节。
// 平时收着，标题后面写几部；开着这一节（或者对话框）时才订阅，核心那时才去设备上取。
import { type DeviceView, keys, type PairingTopicView, type PairPhone } from '@litch/core'
import { useEffect, useId, useState } from 'react'
import { useT } from '../app/appearance.ts'
import { reasonOf } from '../app/errors.ts'
import { Fold } from '../app/Fold.tsx'
import { useKey, useServices } from '../app/services.tsx'
import { showToast } from '../app/toasts.tsx'
import { PairDialog } from './PairDialog.tsx'

/** 从这一版起设备服务支持扫码绑定手机 */
const PAIRING_SINCE = [0, 12, 0]

/** version 不低于 since（只比主、次、修订号）。认不出是 false */
function atLeast(version: string | undefined, since: number[]): boolean {
  const parts = /^(\d+)\.(\d+)\.(\d+)/
    .exec(version ?? '')
    ?.slice(1)
    .map(Number)
  if (!parts) return false
  for (let i = 0; i < 3; i++) if (parts[i] !== since[i]) return (parts[i] ?? 0) > (since[i] ?? 0)
  return true
}

export function PhonesSection({ device }: { device: DeviceView }) {
  const { replica } = useServices()
  const t = useT()
  const id = useId()
  const [open, setOpen] = useState(false)
  const [pairing, setPairing] = useState(false)
  const online = device.connection === 'online'
  const supported = device.pairing
  // 订阅这台设备的配对情况：标题后面的数目、下面的列表都要它
  useEffect(
    () => (supported ? replica.openPairing(device.id) : undefined),
    [replica, device.id, supported],
  )
  const topic = useKey<PairingTopicView>(keys.pairing(device.id))

  if (!supported) {
    // 连着、对面是设备服务，只是版本太旧：说一句。只有 codex 的、没连上过的不说
    if (!online || device.mode !== 'full') return null
    // 0.12.0 起的设备服务都会扫码绑定，只有 Windows 的管理员账号不行（OpenSSH 只认 administrators_authorized_keys）
    const windowsAdmin = device.os === 'windows' && atLeast(device.service?.version, PAIRING_SINCE)
    return (
      <section
        className="mng-sec"
        data-sec="phones"
        data-phones={windowsAdmin ? 'windows-admin' : 'upgrade'}
      >
        <div className="mng-sec-head">
          <h2>{t('phones.title')}</h2>
        </div>
        <div className="devp-note">
          {t(windowsAdmin ? 'phones.windowsAdmin' : 'phones.upgrade')}
        </div>
      </section>
    )
  }
  const phones = topic?.phones ?? null
  return (
    <section className="mng-sec" data-sec="phones" data-open={open}>
      <div className="mng-sec-head">
        <h2>
          <Fold open={open} onToggle={() => setOpen(!open)} controls={id}>
            {t('phones.title')}
          </Fold>
        </h2>
        <span className="mng-sum" data-phones-count={phones?.length ?? ''}>
          {phones === null
            ? ''
            : phones.length === 0
              ? t('phones.none')
              : t('phones.count', { count: phones.length })}
        </span>
        <span className="grow" />
        <button
          type="button"
          className="btn ghost"
          data-act="pair"
          disabled={!online}
          onClick={() => setPairing(true)}
        >
          {t('pairing.use')}
        </button>
      </div>
      {open ? (
        <div id={id} className="mng-sec-body">
          {!online ? (
            <div className="devp-note">{t('phones.offline')}</div>
          ) : phones === null ? (
            <div className="devp-note">{t('phones.loading')}</div>
          ) : phones.length === 0 ? (
            <div className="devp-note">{t('phones.empty')}</div>
          ) : (
            <ul className="phone-list">
              {phones.map((phone) => (
                <PhoneRow key={phone.phoneId} deviceId={device.id} phone={phone} />
              ))}
            </ul>
          )}
        </div>
      ) : null}
      {pairing ? <PairDialog device={device} onClose={() => setPairing(false)} /> : null}
    </section>
  )
}

/** 一部手机：名字、绑定日期、撤销（先问一句） */
function PhoneRow({ deviceId, phone }: { deviceId: string; phone: PairPhone }) {
  const { channel } = useServices()
  const t = useT()
  const [asking, setAsking] = useState(false)
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)
  const revoke = () => {
    setBusy(true)
    setFailure(null)
    channel.command('pairing.revoke', { deviceId, phoneId: phone.phoneId }).then(
      () =>
        showToast({
          id: `phone-revoked:${phone.phoneId}`,
          text: (tt) => tt('phones.revoked', { name: phone.name }),
          lifeMs: 5000,
        }),
      (error: unknown) => {
        setBusy(false)
        setAsking(false)
        setFailure(t('phones.failed', { reason: reasonOf(error, t) }))
      },
    )
  }
  return (
    <li className="phone-row" data-phone={phone.phoneId}>
      <div className="phone-main">
        <span className="phone-name ell">{phone.name}</span>
        <span className="phone-date dim">
          {phone.addedAt === null
            ? t('phones.addedUnknown')
            : t('phones.added', {
                date: new Date(phone.addedAt).toLocaleDateString(t.lang, { dateStyle: 'medium' }),
              })}
        </span>
        <span className="grow" />
        {asking ? null : (
          <button
            type="button"
            className="btn ghost"
            data-act="revoke"
            onClick={() => setAsking(true)}
          >
            {t('phones.revoke')}
          </button>
        )}
      </div>
      {asking ? (
        <div className="phone-ask">
          <span className="devp-ask">{t('phones.revoke.ask', { name: phone.name })}</span>
          <span className="grow" />
          <button type="button" className="btn ghost" onClick={() => setAsking(false)}>
            {t('permission.confirm.no')}
          </button>
          <button
            type="button"
            className="btn danger"
            data-act="revoke-yes"
            disabled={busy}
            onClick={revoke}
          >
            {t('phones.revoke')}
          </button>
        </div>
      ) : null}
      {failure ? (
        <div className="devp-note err" role="alert">
          {failure}
        </div>
      ) : null}
    </li>
  )
}
