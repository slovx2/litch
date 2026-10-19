// “在手机上使用…”的出码对话框（12 号设计第八节）：一打开就出码（核心一步做完设备上的配对、主机钥匙核对、自检），
// 左边是二维码、倒计时和“复制配对文本”，右边是给手机用的地址四项（预填记住的或原配置，可改，改了二维码当场换，
// 旁边写着原配置、可一键恢复，改过的按设备记住）和状态一行：等扫码 → 手机“名字”请求绑定（确认码、允许、拒绝）→ 已绑定。
// 码到期自动作废、重新出一张；关掉对话框时没用完的码作废掉。出不了码时按原因说人话，自检这类把 ssh 的原话摆出来。
import {
  type ChannelError,
  type DeviceView,
  encodePairPayload,
  keys,
  type PairingAddress,
  type PairingTopicView,
  type PairingView,
  type PairState,
} from '@litch/core'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useT } from '../app/appearance.ts'
import { reasonOf } from '../app/errors.ts'
import { Close } from '../app/icons.tsx'
import { useKey, useServices } from '../app/services.tsx'
import { showToast } from '../app/toasts.tsx'
import type { MessageKey } from '../i18n/index.ts'
import {
  ADDRESS_FIELDS,
  type AddressDraft,
  type AddressField,
  addressLine,
  checkDraft,
  codeText,
  countdown,
  draftOf,
  failureOf,
  finalState,
  refreshes,
  sameAddress,
  showsSaid,
  sshOffHint,
} from './pairing.ts'
import { QrCode } from './QrCode.tsx'

/** 改地址之后隔多久记下来：边打边记没有意义 */
const REMEMBER_MS = 600

interface PairDialogProps {
  device: DeviceView
  onClose(): void
}

const FIELD_LABEL: Record<AddressField, MessageKey> = {
  name: 'pairing.field.name',
  host: 'pairing.field.host',
  port: 'pairing.field.port',
  user: 'pairing.field.user',
}

/** 二维码里的那段文字 */
const payloadText = (pairing: PairingView, address: PairingAddress): string =>
  encodePairPayload({
    v: 1,
    n: address.name,
    h: address.host,
    p: address.port,
    u: address.user,
    k: { t: pairing.hostKey.type, f: pairing.hostKey.fingerprint },
    s: pairing.seed,
    i: pairing.pairId,
    e: pairing.expiresAt,
  })

/** 一秒走一下的钟：倒计时要它 */
function useSecond(): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [])
  return now
}

export function PairDialog({ device, onClose }: PairDialogProps) {
  const { channel, replica } = useServices()
  const t = useT()
  const deviceId = device.id
  const dialog = useRef<HTMLDialogElement>(null)
  /** 现在这张码。null：还没出来（正在出、没出成） */
  const [pairing, setPairing] = useState<PairingView | null>(null)
  const [starting, setStarting] = useState(false)
  const [failure, setFailure] = useState<ChannelError | null>(null)
  const [draft, setDraft] = useState<AddressDraft | null>(null)
  const [deciding, setDeciding] = useState(false)
  const [decideError, setDecideError] = useState<string | null>(null)
  /** 最近一次记下（或者一开始预填）的地址：一样的就不再记 */
  const remembered = useRef<PairingAddress | null>(null)
  /** 关掉的时候要作废的那一张，和它现在走到哪了 */
  const live = useRef<{ pairId: string; state: PairState } | null>(null)
  const closed = useRef(false)
  /** 每出一次码换一个代号：回来的结果不是最近这一次的（换码换得快、对话框重开过）就作废它 */
  const generation = useRef(0)
  const now = useSecond()

  // 开着的时候订阅这台设备的配对情况：状态一行跟着它走
  useEffect(() => replica.openPairing(deviceId), [replica, deviceId])
  const topic = useKey<PairingTopicView>(keys.pairing(deviceId))
  const status = pairing ? topic?.pairs.find((pair) => pair.pairId === pairing.pairId) : undefined
  const state: PairState = status?.state ?? 'waiting'
  if (pairing) live.current = { pairId: pairing.pairId, state }

  /** 作废一张码。设备上早没有了、没连着都不要紧：钥匙行到期没用，设备也会清 */
  const discard = useCallback(
    (pairId: string) => {
      channel.command('pairing.cancel', { deviceId, pairId }).catch(() => {})
    },
    [channel, deviceId],
  )

  /** 出一张码。换码时先把旧的作废；表单里正在改的地址不动 */
  const start = useCallback(() => {
    const old = live.current
    if (old && !finalState(old.state)) discard(old.pairId)
    live.current = null
    const mine = ++generation.current
    setStarting(true)
    setFailure(null)
    setDecideError(null)
    channel.command('pairing.start', { deviceId }).then(
      ({ pairing: next }) => {
        if (closed.current || mine !== generation.current) {
          discard(next.pairId)
          return
        }
        setPairing(next)
        setStarting(false)
        setDraft((was) => was ?? draftOf(next.address))
        if (remembered.current === null) remembered.current = next.address
      },
      (error: unknown) => {
        if (closed.current || mine !== generation.current) return
        setPairing(null)
        setStarting(false)
        setFailure(error as ChannelError)
      },
    )
  }, [channel, deviceId, discard])

  // 打开就出码；关掉时把没用完的那张作废
  useEffect(() => {
    closed.current = false
    start()
    return () => {
      closed.current = true
      generation.current++
      const old = live.current
      if (old && !finalState(old.state)) discard(old.pairId)
    }
  }, [start, discard])

  // 用模态方式打开：焦点留在里面，Esc 由浏览器处理
  useEffect(() => {
    const element = dialog.current
    if (element && !element.open) element.showModal()
  }, [])

  // now 只是让它每秒重画一次；剩多久按此刻的时间算，刚出码时不会多出一秒
  const remaining = pairing ? pairing.expiresAt - Math.max(now, Date.now()) : 0
  // 到点了、或者设备说过期了：换一张。完成、拒绝、被别处作废的不换，等人点
  const due =
    pairing !== null && !starting && refreshes(state) && (remaining <= 0 || state === 'expired')
  useEffect(() => {
    if (due) start()
  }, [due, start])

  const checked = draft ? checkDraft(draft) : null
  const address = checked && 'address' in checked ? checked.address : null
  const text = useMemo(
    () => (pairing && address ? payloadText(pairing, address) : null),
    [pairing, address],
  )

  // 改过的地址按设备记下来（停手一会儿再记）；改回原配置就忘掉
  useEffect(() => {
    if (!pairing || !address) return
    const last = remembered.current
    if (last && sameAddress(last, address)) return
    const timer = setTimeout(() => {
      remembered.current = address
      const forget = sameAddress(address, pairing.original)
      channel
        .command('pairing.rememberAddress', { deviceId, address: forget ? null : address })
        .catch(() => {})
    }, REMEMBER_MS)
    return () => clearTimeout(timer)
  }, [pairing, address, channel, deviceId])

  const decide = (allow: boolean) => {
    if (!pairing) return
    setDeciding(true)
    setDecideError(null)
    channel.command('pairing.decide', { deviceId, pairId: pairing.pairId, allow }).then(
      () => setDeciding(false),
      (error: unknown) => {
        setDeciding(false)
        setDecideError(t('pairing.failed', { reason: reasonOf(error, t) }))
      },
    )
  }

  const copy = () => {
    if (!text) return
    navigator.clipboard.writeText(text).then(
      () => showToast({ id: 'pairing-copy', text: (tt) => tt('pairing.copied'), lifeMs: 4000 }),
      (error: unknown) =>
        showToast({
          id: 'pairing-copy',
          tone: 'err',
          text: (tt) => tt('pairing.copyFailed', { reason: String(error) }),
          lifeMs: 6000,
        }),
    )
  }

  const title = t('pairing.title', { name: t.text(device.name) })
  const original = pairing?.original ?? null
  const changed = original !== null && address !== null && !sameAddress(address, original)
  const problem = checked && 'field' in checked ? checked : null
  const phone = status?.phone ?? null

  return (
    <dialog
      ref={dialog}
      className="modal pair-dialog"
      aria-label={title}
      data-pair-device={deviceId}
      onClose={onClose}
      onKeyDown={(event) => {
        // Esc 只关这个对话框，别让外面的 Esc 处理（设备详情回到列表）也跟着动
        if (event.key === 'Escape') event.stopPropagation()
      }}
    >
      <form
        onSubmit={(event) => {
          event.preventDefault()
        }}
      >
        <div className="modal-head">
          <span className="grow ell">{title}</span>
          <button
            type="button"
            className="ibtn"
            title={t('pairing.close')}
            aria-label={t('pairing.close')}
            onClick={onClose}
          >
            <Close />
          </button>
        </div>
        <div className="modal-body">
          <div className="modal-note">{t('pairing.intro')}</div>
          {failure ? (
            <Failure device={device} failure={failure} onRetry={start} />
          ) : (
            <div className="pair-main">
              <div className="pair-code" data-pair-ready={text ? 'true' : 'false'}>
                {text && pairing && !finalState(state) ? (
                  <QrCode text={text} label={t('pairing.qr')} />
                ) : (
                  <div className="qr qr-empty" aria-hidden="true" />
                )}
                <div className="pair-timer mono" data-pair-timer>
                  {starting
                    ? t(pairing ? 'pairing.refreshing' : 'pairing.starting')
                    : pairing && state === 'waiting'
                      ? t('pairing.expires', { time: countdown(remaining) })
                      : null}
                </div>
                <button
                  type="button"
                  className="btn ghost"
                  data-act="copy-pair"
                  disabled={!text || finalState(state)}
                  onClick={copy}
                >
                  {t('pairing.copy')}
                </button>
              </div>
              <div className="pair-side">
                <fieldset className="pair-address" disabled={!draft || finalState(state)}>
                  <legend className="form-label">{t('pairing.address')}</legend>
                  {ADDRESS_FIELDS.map((field) => (
                    <label key={field} className="pair-field" data-field={field}>
                      <span className="pair-field-label">{t(FIELD_LABEL[field])}</span>
                      <input
                        className="req-input"
                        value={draft?.[field] ?? ''}
                        autoComplete="off"
                        spellCheck={false}
                        inputMode={field === 'port' ? 'numeric' : undefined}
                        aria-invalid={problem?.field === field ? 'true' : undefined}
                        onChange={(event) => {
                          const value = event.target.value
                          setDraft((was) => (was ? { ...was, [field]: value } : was))
                        }}
                      />
                    </label>
                  ))}
                  {problem ? (
                    <div className="modal-note err" data-pair-problem={problem.field}>
                      {t(problem.problem)}
                    </div>
                  ) : null}
                  <div className="modal-note">{t('pairing.address.note')}</div>
                  {original ? (
                    <div className="pair-original" data-pair-changed={changed ? 'true' : 'false'}>
                      <span className="ell mono">
                        {t('pairing.original', { address: addressLine(original) })}
                      </span>
                      {changed || problem ? (
                        <button
                          type="button"
                          className="mini"
                          data-act="restore-address"
                          onClick={() => setDraft(draftOf(original))}
                        >
                          {t('pairing.restore')}
                        </button>
                      ) : null}
                    </div>
                  ) : null}
                </fieldset>
                {pairing ? (
                  <div className="pair-state" data-pair-state={state} role="status">
                    {state === 'requested' && phone ? (
                      <>
                        <div className="pair-line">
                          {t('pairing.state.requested', { name: phone.name })}
                        </div>
                        <div className="pair-confirm">
                          <span className="dim">{t('pairing.code')}</span>
                          <span className="pair-digits mono" data-pair-code={phone.code}>
                            {codeText(phone.code)}
                          </span>
                        </div>
                        <div className="modal-note">{t('pairing.code.note')}</div>
                        <div className="pair-acts">
                          <button
                            type="button"
                            className="btn"
                            data-act="pair-reject"
                            disabled={deciding}
                            onClick={() => decide(false)}
                          >
                            {t('pairing.reject')}
                          </button>
                          <button
                            type="button"
                            className="btn primary"
                            data-act="pair-allow"
                            disabled={deciding}
                            onClick={() => decide(true)}
                          >
                            {t('pairing.allow')}
                          </button>
                        </div>
                      </>
                    ) : state === 'done' ? (
                      <div className="pair-line ok">
                        {t('pairing.state.done', { name: phone?.name ?? '' })}
                      </div>
                    ) : state === 'waiting' ? (
                      <div className="pair-line">{t('pairing.state.waiting')}</div>
                    ) : (
                      <div className="pair-line">{t(`pairing.state.${state}`)}</div>
                    )}
                    {decideError ? (
                      <div className="modal-note err" role="alert">
                        {decideError}
                      </div>
                    ) : null}
                  </div>
                ) : null}
              </div>
            </div>
          )}
          <div className="modal-note pair-warn">{t('pairing.shared')}</div>
        </div>
        <div className="modal-foot">
          <span className="grow" />
          {state === 'rejected' || state === 'cancelled' ? (
            <button type="button" className="btn" data-act="pair-again" onClick={start}>
              {t('pairing.again')}
            </button>
          ) : null}
          <button
            type="button"
            className={state === 'done' ? 'btn primary' : 'btn'}
            data-act="pair-close"
            onClick={onClose}
          >
            {t(state === 'done' ? 'pairing.done' : 'pairing.close')}
          </button>
        </div>
      </form>
    </dialog>
  )
}

/** 出不了码：按原因说人话；没开 SSH 服务的说怎么开；自检这类把 ssh 的原话摆出来；能重试 */
function Failure({
  device,
  failure,
  onRetry,
}: {
  device: DeviceView
  failure: ChannelError
  onRetry(): void
}) {
  const t = useT()
  const kind = failureOf(failure)
  const said = failure.message.trim()
  return (
    <div className="cfail pair-fail" data-pair-failure={kind ?? 'other'} role="alert">
      <div className="cfail-text">
        <b>{t('pairing.fail.title')}</b>
      </div>
      <div className="cfail-text">
        {kind ? t(`pairing.fail.${kind}`) : t('pairing.failed', { reason: reasonOf(failure, t) })}
      </div>
      {kind === 'sshOff' ? <div className="cfail-text">{t(sshOffHint(device.os))}</div> : null}
      {kind && showsSaid(kind) && said ? (
        <div className="svc-said">
          <span className="devp-note">{t('pairing.fail.said')}</span>
          <pre className="cfail-detail mono">{said}</pre>
        </div>
      ) : null}
      {kind === 'unsupported' ? null : (
        <div className="cfail-acts">
          <button type="button" className="mini retry" data-act="pair-retry" onClick={onRetry}>
            {t('pairing.retry')}
          </button>
        </div>
      )}
    </div>
  )
}
