// 远程设备要操作这台电脑时问用户的卡片。两处用同一个组件：
// - 会话的对话里（ClientAskRequest，ask.kind 是 machine）：MachineSessionCard，答复走 session.respond；
// - 顶栏弹层里的全局待处理（找不到会话的调用）：MachinePendingCard，答复走 machine.answer，带倒计时。
// 卡片上写清：哪台设备（远程的醒目）、哪个 harness、哪个会话（找不到写明）、要做什么——命令完整可见（长了折起，
// 能展开）、读写列的路径、复制的两头；命令里提到禁止位置时整张标红并列出是哪几处。
// 选项照给的来（允许这一次、本会话都允许、拒绝），没有“始终允许”；拒绝能附一句理由给模型。
import type {
  ApprovalOption,
  ClientAskRequest,
  DeviceView,
  MachineAskView,
  MachinePendingView,
  SessionSummary,
} from '@litch/core'
import { keys } from '@litch/core'
import { Fragment, useEffect, useId, useRef, useState } from 'react'
import { requestDevice } from '../app/actions.ts'
import { useT } from '../app/appearance.ts'
import { useElapsed } from '../app/clock.ts'
import { nameOf } from '../app/device.ts'
import { reasonOf } from '../app/errors.ts'
import { useKey, useServices } from '../app/services.tsx'
import { busyWriting, typing } from '../composer/focus.ts'
import { type CardProps, type Choice, Foot, ownsKey, useRespond } from '../composer/respond.tsx'
import type { MessageKey } from '../i18n/index.ts'
import { countdown, foldOf } from './logic.ts'

const TITLE: Record<MachineAskView['action'], MessageKey> = {
  exec: 'machine.ask.exec',
  read: 'machine.ask.read',
  write: 'machine.ask.write',
  list: 'machine.ask.list',
  copy: 'machine.ask.copy',
  process: 'machine.ask.process',
}

interface MachineCardProps {
  deviceId: string
  ask: MachineAskView
  options: ApprovalOption[]
  /** 调用来自哪台设备。远程的整张卡片左边一道醒目的边，头一行写明 */
  from: { name: string; host: string; remote: boolean }
  /** 哪个 harness（给人看的名字）。不知道是 null */
  harness: string | null
  /** 哪个会话：here 是对话里的卡片（就是眼前这个）；title 是知道名字的；null 是不知道是哪个会话 */
  session: 'here' | { title: string } | null
  /** 什么时候作废（全局待处理才有） */
  expiresAt: number | null
  /** acceptSession 写成什么：会话里是“本会话都允许”，全局待处理里是“这台设备找不到会话的都允许” */
  sessionText: MessageKey
  busy: boolean
  error: string | null
  waiting: number
  /** 一出现就拿焦点（对话里的卡片）。弹层里的不抢 */
  grab: boolean
  onChoose(choice: Choice): void
}

function MachineCard(props: MachineCardProps) {
  const { ask, options, from, harness, session, busy, error, waiting, onChoose } = props
  const t = useT()
  const card = useRef<HTMLElement>(null)
  const primary = options.find((option) => option.role === 'accept') ?? options[0]
  const refuse = options.find((option) => option.role === 'decline')
  /** 正在写拒绝的理由时输入框里的字。null：没在写 */
  const [note, setNote] = useState<string | null>(null)
  const noting = note !== null && refuse !== undefined
  const flagged = ask.flagged.length > 0
  const title = t(ask.enable ? 'machine.enable.prompt' : TITLE[ask.action])

  // 对话里的卡片一出现就拿焦点（和 useCardFocus 一样，人正写着东西的不打断）；弹层里的不抢
  const { grab } = props
  useEffect(() => {
    if (!grab || busyWriting(document.activeElement)) return
    card.current?.focus({ preventScroll: true })
  }, [grab])

  const declineWithNote = () => {
    const said = (note ?? '').trim()
    if (refuse && said) onChoose({ optionId: refuse.id, note: said })
  }
  const dropNote = () => {
    setNote(null)
    card.current?.focus({ preventScroll: true })
  }

  // 回车允许这一次，Esc 拒绝；正在写理由时按键归输入框
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!ownsKey(event, card.current)) return
      if (typing(event.target)) return
      if (event.key === 'Enter' && event.target instanceof HTMLButtonElement) return
      const option =
        event.key === 'Enter' && !ask.enable ? primary : event.key === 'Escape' ? refuse : undefined
      if (!option) return
      event.preventDefault()
      onChoose({ optionId: option.id })
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  })

  return (
    <section
      className="req mach-card"
      ref={card}
      tabIndex={-1}
      aria-label={title}
      data-client-ask="machine"
      data-action={ask.action}
      data-remote={from.remote}
      data-flagged={flagged || undefined}
    >
      <div className="req-head">
        <i className={flagged ? 'st err' : 'st wait'} />
        <span className="grow">{title}</span>
        {props.expiresAt !== null ? <Expires at={props.expiresAt} /> : null}
      </div>
      <div className="req-body">
        {ask.enable ? <p>{t('machine.enable.body')}</p> : null}
        <div className={from.remote ? 'mach-from remote' : 'mach-from'} data-from>
          {from.remote ? t('machine.ask.fromRemote') : t('machine.ask.fromLocal')}{' '}
          <b>{from.name}</b>
          <span className="mono"> · {from.host}</span>
        </div>
        <div className="req-meta">
          <span>
            {t('devices.harness')} <b>{harness ?? t('machine.ask.harnessUnknown')}</b>
          </span>
          <span data-session={session === null ? 'unknown' : 'known'}>
            {t('machine.ask.session')}{' '}
            <b className={session === null ? 'mach-unknown' : undefined}>
              {session === 'here'
                ? t('machine.ask.thisSession')
                : session
                  ? session.title
                  : t('machine.session.unknown')}
            </b>
          </span>
        </div>
        <What ask={ask} />
        {flagged ? (
          <div className="mach-flagged" role="alert">
            <span>{t('machine.ask.flagged')}</span>
            <span className="mach-flagged-list">
              {ask.flagged.map((place) => (
                <code key={place}>{place}</code>
              ))}
            </span>
          </div>
        ) : null}
      </div>
      {noting ? (
        <div className="req-note">
          <input
            className="req-input grow"
            // biome-ignore lint/a11y/noAutofocus: 点了“拒绝并说明”就是要接着打字
            autoFocus
            value={note ?? ''}
            placeholder={t('request.note.placeholder')}
            aria-label={t('request.note.label')}
            disabled={busy}
            onChange={(event) => setNote(event.target.value)}
            onKeyDown={(event) => {
              if (event.nativeEvent.isComposing || event.keyCode === 229) return
              if (event.key === 'Enter') {
                event.preventDefault()
                declineWithNote()
              } else if (event.key === 'Escape') {
                // 只收起理由，不让外面（弹层、卡片）把 Esc 当成别的
                event.preventDefault()
                event.stopPropagation()
                dropNote()
              }
            }}
          />
          <button
            type="button"
            className="btn danger"
            disabled={busy || !(note ?? '').trim()}
            onClick={declineWithNote}
          >
            {t('request.note.send')}
            <span className="kbd">↵</span>
          </button>
          <button type="button" className="btn ghost" disabled={busy} onClick={dropNote}>
            {t('request.note.cancel')}
          </button>
        </div>
      ) : null}
      <div className="req-actions">
        {options.map((option) => (
          <Fragment key={option.id}>
            {/* 拒绝前面多一个入口：点开写一句为什么，模型看得到 */}
            {option === refuse && ask.enable ? (
              <button
                type="button"
                className="btn"
                disabled={busy}
                onClick={() => requestDevice(props.deviceId, 'tools')}
              >
                {t('machine.enable.settings')}
              </button>
            ) : null}
            {option === refuse && !noting && !ask.enable ? (
              <button
                type="button"
                className="btn ghost note-open"
                disabled={busy}
                onClick={() => setNote('')}
              >
                {t('request.note.open')}
              </button>
            ) : null}
            <button
              type="button"
              className={
                option === primary
                  ? 'btn primary'
                  : option.role === 'decline' || option.role === 'cancel'
                    ? 'btn ghost'
                    : 'btn'
              }
              disabled={busy}
              data-option={option.id}
              onClick={() => onChoose({ optionId: option.id })}
            >
              {t(
                ask.enable
                  ? option === primary
                    ? 'machine.enable.allow'
                    : 'machine.enable.decline'
                  : optionText(option, props.sessionText),
              )}
              {option === primary && !ask.enable ? <span className="kbd">↵</span> : null}
              {option === refuse ? <span className="kbd">Esc</span> : null}
            </button>
          </Fragment>
        ))}
      </div>
      <Foot waiting={waiting} error={error} />
    </section>
  )
}

function optionText(option: ApprovalOption, sessionText: MessageKey): MessageKey {
  switch (option.role) {
    case 'accept':
      return 'machine.option.once'
    case 'acceptSession':
      return sessionText
    case 'acceptAlways':
      return 'clientAsk.option.always'
    default:
      return 'machine.option.decline'
  }
}

/** 要做的事：命令和目录、路径、复制的两头 */
function What({ ask }: { ask: MachineAskView }) {
  const t = useT()
  const [open, setOpen] = useState(false)
  const wellId = useId()
  if (ask.action === 'copy' && ask.copy) {
    const { from, to } = ask.copy
    return (
      <dl className="mach-copy">
        <dt>{t('machine.ask.from')}</dt>
        <dd>
          <b>{from.machine}</b> <span className="mono">{from.path}</span>
        </dd>
        <dt>{t('machine.ask.to')}</dt>
        <dd>
          <b>{to.machine}</b> <span className="mono">{to.path}</span>
        </dd>
      </dl>
    )
  }
  if (ask.command !== null) {
    const { folded, lines } = foldOf(ask.command)
    const shut = folded && !open
    return (
      <>
        <div className={shut ? 'well mach-cmd shut' : 'well mach-cmd'} id={wellId}>
          <pre>{ask.command}</pre>
        </div>
        <div className="req-meta">
          {ask.cwd ? (
            <span>
              {t('machine.ask.cwd')} <b>{ask.cwd}</b>
            </span>
          ) : null}
          {folded ? (
            <button
              type="button"
              className="linkish mach-more"
              aria-expanded={open}
              aria-controls={wellId}
              onClick={() => setOpen(!open)}
            >
              {open ? t('machine.ask.less') : t('machine.ask.more', { lines })}
            </button>
          ) : null}
        </div>
      </>
    )
  }
  return (
    <div className="mach-target">
      <span className="mach-target-name">{t('machine.ask.path')}</span>
      <span className="mono">{ask.path ?? ''}</span>
    </div>
  )
}

/** 离作废还有多久，每秒走一格；最后一分钟换成醒目的颜色 */
function Expires({ at }: { at: number }) {
  const t = useT()
  // 用“已经过了多久”的钟来每秒重画一次，算的是离作废还有多久
  useElapsed(0)
  const now = Date.now()
  const urgent = at - now < 60_000
  return (
    <span className={urgent ? 'mach-expires urgent' : 'mach-expires'} data-expires>
      {t('machine.ask.expires', { time: countdown(at, now) })}
    </span>
  )
}

/** 对话里的那一张：答复走 session.respond */
export function MachineSessionCard(props: CardProps<ClientAskRequest> & { ask: MachineAskView }) {
  const { request, deviceId, sessionId, ask, waiting } = props
  const { busy, error, respond } = useRespond(props)
  const device = useKey<DeviceView>(keys.device(deviceId))
  const summary = useKey<SessionSummary>(keys.summary(deviceId, sessionId))
  const t = useT()
  return (
    <MachineCard
      deviceId={deviceId}
      ask={ask}
      options={request.options}
      from={{
        name: t.text(request.device.name),
        host: request.device.host,
        remote: request.device.kind === 'ssh',
      }}
      harness={summary ? nameOf(device, summary.harness) : null}
      session={ask.enable ? { title: summary ? t.text(summary.title) : sessionId } : 'here'}
      expiresAt={null}
      sessionText="machine.option.session"
      busy={busy}
      error={error}
      waiting={waiting}
      grab={!ask.enable}
      onChoose={respond}
    />
  )
}

/** 顶栏弹层里全局待处理的一张：答复走 machine.answer，带倒计时 */
export function MachinePendingCard({ pending }: { pending: MachinePendingView }) {
  const { channel } = useServices()
  const t = useT()
  const device = useKey<DeviceView>(keys.device(pending.deviceId))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const sending = useRef(false)
  const answer = (choice: Choice) => {
    if (sending.current || !choice.optionId) return
    sending.current = true
    setBusy(true)
    setError(null)
    channel
      .command('machine.answer', {
        pendingId: pending.id,
        optionId: choice.optionId,
        ...(choice.note ? { note: choice.note } : {}),
      })
      .catch((failure: unknown) => {
        // 成功的话卡片会随着待处理一起消失
        sending.current = false
        setBusy(false)
        setError(t('request.failed', { reason: reasonOf(failure, t) }))
      })
  }
  return (
    <MachineCard
      deviceId={pending.deviceId}
      ask={pending.ask}
      options={pending.options}
      from={{ name: t.text(pending.deviceName), host: pending.host, remote: true }}
      harness={pending.harness ? nameOf(device, pending.harness) : null}
      session={pending.ask.enable?.sessionId ? { title: pending.ask.enable.sessionId } : null}
      expiresAt={pending.expiresAt}
      sessionText="machine.option.cli"
      busy={busy}
      error={error}
      waiting={0}
      grab={false}
      onChoose={answer}
    />
  )
}
