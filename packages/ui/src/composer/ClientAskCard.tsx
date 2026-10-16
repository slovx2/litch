// 客户端工具（内置浏览器、Computer Use）要用户点头的卡片。不是对面的请求：是这台桌面端在替某个会话执行工具时
// 自己要问的（打开一个没去过的网站、操作一个应用）。样子和审批卡片一样、排在同一处；文字按结构在这里拼，
// 核心只给“问的是什么”。卡片上写明调用来自哪台设备：远程设备上的模型在用这台电脑时要显眼。
import type { ApprovalOption, ClientAskRequest } from '@litch/core'
import { useEffect, useRef } from 'react'
import { useT } from '../app/appearance.ts'
import type { MessageKey } from '../i18n/index.ts'
import { useCardFocus } from './focus.ts'
import { type CardProps, Foot, ownsKey, useRespond } from './respond.tsx'

const OPTION_TEXT: Record<ApprovalOption['role'], MessageKey> = {
  accept: 'clientAsk.option.once',
  acceptSession: 'clientAsk.option.session',
  acceptAlways: 'clientAsk.option.always',
  decline: 'clientAsk.option.decline',
  cancel: 'clientAsk.option.decline',
}

export function ClientAskCard(props: CardProps<ClientAskRequest>) {
  const { request, waiting } = props
  const t = useT()
  const { busy, error, respond } = useRespond(props)
  const card = useRef<HTMLElement>(null)
  /** 回车选的那一项：头一个不是拒绝的 */
  const primary = request.options.find((option) => option.role !== 'decline')
  const refuse = request.options.find((option) => option.role === 'decline')
  const { ask, device } = request
  const remote = device.kind === 'ssh'
  const title = t(ask.kind === 'site' ? 'clientAsk.site' : 'clientAsk.app')

  useCardFocus(card)

  // 回车选头一项，Esc 拒绝
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!ownsKey(event, card.current)) return
      if (event.key === 'Enter' && event.target instanceof HTMLButtonElement) return
      const option = event.key === 'Enter' ? primary : event.key === 'Escape' ? refuse : undefined
      if (!option) return
      event.preventDefault()
      respond({ optionId: option.id })
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  })

  return (
    <section
      className="req"
      ref={card}
      tabIndex={-1}
      aria-label={title}
      data-client-ask={ask.kind}
      data-remote={remote}
    >
      <div className="req-head">
        <i className="st wait" />
        <span>{title}</span>
      </div>
      <div className="req-body">
        {remote ? (
          <div className="req-why err" data-remote-note>
            {t('clientAsk.remote')}
          </div>
        ) : null}
        <div className="req-meta">
          <span>
            {t('clientAsk.from')} <b>{t.text(device.name)}</b>
            {remote ? <> · {device.host}</> : null}
          </span>
          <span>
            {t('clientAsk.tool')} <b>{`${request.tool.namespace} · ${request.tool.name}`}</b>
          </span>
        </div>
        {ask.kind === 'site' ? (
          <>
            <div className="req-meta">
              <span>
                {t('clientAsk.origin')} <b>{ask.origin}</b>
              </span>
            </div>
            {ask.url && ask.url !== ask.origin ? (
              <div className="well">
                <pre>{ask.url}</pre>
              </div>
            ) : null}
          </>
        ) : (
          <>
            <div className="req-meta">
              <span>
                {t('clientAsk.appName')} <b>{ask.app.name}</b>
              </span>
              <span className="mono">{ask.app.bundleId}</span>
            </div>
            {ask.risk === 'elevated' ? (
              <div className="req-why err" data-elevated>
                {t('clientAsk.elevated')}
              </div>
            ) : null}
            {!ask.allowAlways ? <div className="req-why">{t('clientAsk.noAlways')}</div> : null}
          </>
        )}
      </div>
      <div className="req-actions">
        {request.options.map((option) => (
          <button
            key={option.id}
            type="button"
            className={
              option === primary ? 'btn primary' : option.role === 'decline' ? 'btn ghost' : 'btn'
            }
            disabled={busy}
            data-option={option.id}
            onClick={() => respond({ optionId: option.id })}
          >
            {t(OPTION_TEXT[option.role])}
            {option === primary ? <span className="kbd">↵</span> : null}
            {option === refuse ? <span className="kbd">Esc</span> : null}
          </button>
        ))}
      </div>
      <Foot waiting={waiting} error={error} />
    </section>
  )
}
