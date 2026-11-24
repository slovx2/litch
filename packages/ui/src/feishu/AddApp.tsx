// 添加飞书应用（对话框）。两种方式：创建向导（默认：填机器人名 → 在系统浏览器打开飞书创建页 → 设备自动检测完成）、
// 手动填写已有应用的 App ID 与 App Secret。App Secret 提交即从界面状态里清掉，不回显。
// 关掉对话框时仍在等待的创建一并取消。
import { useEffect, useRef, useState } from 'react'
import { useT } from '../app/appearance.ts'
import { Close } from '../app/icons.tsx'
import { useServices } from '../app/services.tsx'
import { clockText, operationId } from '../external/model.ts'
import { openSystemLink } from '../side/browser/links.ts'
import { ExternalLink } from '../transcript/ExternalLink.tsx'
import { useFeishuRegistration, useFeishuRun } from './data.ts'
import {
  botNameProblem,
  FEISHU_BOT_NAME_MAX,
  type FeishuRegistration,
  registrationEnd,
  secondsLeft,
  validAppId,
} from './model.ts'

type Way = 'wizard' | 'manual'

function useSecondsLeft(expiresAt: number | null): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (expiresAt === null) return
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [expiresAt])
  return expiresAt === null ? 0 : secondsLeft(expiresAt, now)
}

function Waiting({ registration }: { registration: FeishuRegistration }) {
  const t = useT()
  const left = useSecondsLeft(registration.expiresAt)
  return (
    <div className="ext-code" data-feishu-registration="waiting">
      <div>{t('feishu.add.waiting')}</div>
      <div className="ext-code-line">
        {registration.url ? (
          <ExternalLink href={registration.url} openInSystem className="ext-text-link">
            {t('feishu.add.reopen')}
          </ExternalLink>
        ) : null}
        <span className="dim">{t('feishu.add.left', { time: clockText(left) })}</span>
      </div>
    </div>
  )
}

export function AddApp({
  deviceId,
  onClose,
  onAdded,
}: {
  deviceId: string
  onClose(): void
  /** 加好了：进这个应用的详情 */
  onAdded(appId: string): void
}) {
  const t = useT()
  const { channel } = useServices()
  const dialog = useRef<HTMLDialogElement>(null)
  const [way, setWay] = useState<Way>('wizard')
  const [name, setName] = useState('')
  const [appId, setAppId] = useState('')
  const [secret, setSecret] = useState('')
  const [registrationId, setRegistrationId] = useState<string | null>(null)
  const [first, setFirst] = useState<FeishuRegistration | null>(null)
  const act = useFeishuRun()
  const snapshot = useFeishuRegistration(deviceId, registrationId)
  const registration = snapshot?.value ?? first
  const waiting = registration?.state === 'waiting'
  const nameProblem = botNameProblem(name)
  const appIdBad = appId.trim() !== '' && !validAppId(appId.trim())

  useEffect(() => {
    const element = dialog.current
    if (element && !element.open) element.showModal()
  }, [])

  const cancel = () => {
    if (!registration || !waiting) return Promise.resolve()
    return channel
      .command('feishu.app.register.cancel', {
        deviceId,
        registrationId: registration.registrationId,
      })
      .then(
        () => {},
        () => {},
      )
  }
  const close = () => {
    void cancel()
    onClose()
  }

  const begin = async () => {
    const result = await act.run(() =>
      channel.command('feishu.app.register.begin', {
        deviceId,
        operationId: operationId(),
        name: name.trim(),
      }),
    )
    if (!result) return
    setFirst(result.registration)
    setRegistrationId(result.registration.registrationId)
    if (result.registration.url) openSystemLink(result.registration.url)
  }

  const configure = async () => {
    // 秘密只在这一次调用里，先从界面状态里清掉
    const appSecret = secret
    setSecret('')
    const result = await act.run(() =>
      channel.command('feishu.app.configure', {
        deviceId,
        operationId: operationId(),
        appId: appId.trim(),
        appSecret,
      }),
    )
    if (result) onAdded(result.app.appId)
  }

  const restart = () => {
    setRegistrationId(null)
    setFirst(null)
  }

  let body = null
  if (!registration) {
    body = (
      <>
        <div className="seg">
          {(['wizard', 'manual'] as const).map((one) => (
            <button
              type="button"
              key={one}
              data-way={one}
              aria-pressed={way === one}
              onClick={() => setWay(one)}
            >
              {t(`feishu.add.way.${one}`)}
            </button>
          ))}
        </div>
        {way === 'wizard' ? (
          <label className="fs-form-row">
            <span>{t('feishu.add.name')}</span>
            <input
              className="req-input"
              value={name}
              autoComplete="off"
              spellCheck={false}
              data-feishu-name
              onChange={(event) => setName(event.target.value)}
            />
            {nameProblem === 'long' ? (
              <span className="fs-hint err">
                {t('feishu.add.nameLong', { max: FEISHU_BOT_NAME_MAX })}
              </span>
            ) : null}
          </label>
        ) : (
          <>
            <label className="fs-form-row">
              <span>{t('feishu.appId')}</span>
              <input
                className="req-input mono"
                value={appId}
                autoComplete="off"
                spellCheck={false}
                data-feishu-app-id
                onChange={(event) => setAppId(event.target.value)}
              />
              {appIdBad ? <span className="fs-hint err">{t('feishu.add.appIdBad')}</span> : null}
            </label>
            <label className="fs-form-row">
              <span>{t('feishu.secret.title')}</span>
              <input
                className="req-input mono"
                type="password"
                value={secret}
                autoComplete="off"
                spellCheck={false}
                data-feishu-secret
                onChange={(event) => setSecret(event.target.value)}
              />
              <span className="fs-hint">{t('feishu.add.secretNote')}</span>
            </label>
          </>
        )}
        <p className="fs-hint">{t('feishu.exclusive')}</p>
      </>
    )
  } else if (waiting) {
    body = <Waiting registration={registration} />
  } else {
    const end = registrationEnd(registration)
    body = (
      <div
        className={registration.state === 'succeeded' ? 'devp-note' : 'devp-note err'}
        role={registration.state === 'succeeded' ? 'status' : 'alert'}
        data-feishu-registration={registration.state}
      >
        {t(`feishu.add.end.${end}`)}
      </div>
    )
  }

  const succeeded = registration?.state === 'succeeded' ? registration.appId : undefined
  return (
    <dialog
      ref={dialog}
      className="modal ext-dialog"
      aria-label={t('feishu.add')}
      onClose={close}
      onKeyDown={(event) => {
        if (event.key === 'Escape') event.stopPropagation()
      }}
    >
      <form onSubmit={(event) => event.preventDefault()}>
        <div className="modal-head">
          <span className="grow ell">{t('feishu.add')}</span>
          <button
            type="button"
            className="ibtn"
            title={t('feishu.close')}
            aria-label={t('feishu.close')}
            onClick={close}
          >
            <Close />
          </button>
        </div>
        <div className="modal-body">
          {body}
          {act.error ? (
            <div className="modal-note err" role="alert">
              {act.error}
            </div>
          ) : null}
        </div>
        <div className="modal-foot">
          <span className="grow" />
          {!registration ? (
            way === 'wizard' ? (
              <button
                type="button"
                className="btn primary"
                data-act="feishu-begin"
                disabled={act.busy || nameProblem !== null}
                onClick={() => void begin()}
              >
                {t('feishu.add.start')}
              </button>
            ) : (
              <button
                type="button"
                className="btn primary"
                data-act="feishu-configure"
                disabled={act.busy || !validAppId(appId.trim()) || !secret}
                onClick={() => void configure()}
              >
                {t('feishu.add.save')}
              </button>
            )
          ) : waiting ? (
            <button
              type="button"
              className="btn ghost"
              data-act="feishu-cancel"
              onClick={() => void cancel()}
            >
              {t('feishu.cancel')}
            </button>
          ) : succeeded ? (
            <button
              type="button"
              className="btn primary"
              data-act="feishu-view"
              onClick={() => onAdded(succeeded)}
            >
              {t('feishu.add.view')}
            </button>
          ) : (
            <button type="button" className="btn" data-act="feishu-retry" onClick={restart}>
              {t('feishu.add.retry')}
            </button>
          )}
        </div>
      </form>
    </dialog>
  )
}
