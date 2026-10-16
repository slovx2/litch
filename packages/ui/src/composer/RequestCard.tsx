import type { ApprovalOption, ApprovalRequest } from '@litch/core'
import { Fragment, useEffect, useRef, useState } from 'react'
import { useT } from '../app/appearance.ts'
import type { MessageKey } from '../i18n/index.ts'
import { ClientAskCard } from './ClientAskCard.tsx'
import { FormCard } from './FormCard.tsx'
import { typing, useCardFocus } from './focus.ts'
import { QuestionCard } from './QuestionCard.tsx'
import { type CardProps, Foot, ownsKey, useRespond } from './respond.tsx'

const OPTION_TEXT: Record<ApprovalOption['role'], MessageKey> = {
  accept: 'request.option.accept',
  acceptSession: 'request.option.acceptSession',
  acceptAlways: 'request.option.acceptAlways',
  decline: 'request.option.decline',
  cancel: 'request.option.cancel',
}

const SUBJECT_TEXT: Record<ApprovalRequest['subject'], MessageKey> = {
  command: 'request.command',
  fileChange: 'request.fileChange',
  permissions: 'request.permissions',
  tool: 'request.tool',
}

function Approval(props: CardProps<ApprovalRequest>) {
  const { request, waiting } = props
  const t = useT()
  const { busy, error, respond } = useRespond(props)
  const card = useRef<HTMLElement>(null)
  const primary = request.options.find((option) => option.role === 'accept')
  const refuse = request.options.find((option) => option.role === 'decline')
  /** 正在写拒绝的说明时输入框里的字。null：没在写 */
  const [note, setNote] = useState<string | null>(null)
  const noting = note !== null && refuse?.note === true

  useCardFocus(card)

  const declineWithNote = () => {
    const said = (note ?? '').trim()
    if (refuse && said) respond({ optionId: refuse.id, note: said })
  }
  /** 不写了：收起输入框，焦点回到卡片上，这时再按 Esc 才是拒绝 */
  const dropNote = () => {
    setNote(null)
    card.current?.focus({ preventScroll: true })
  }

  // 回车批准，Esc 拒绝
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!ownsKey(event, card.current)) return
      // 正在写说明：按键归那个输入框，回车不能变成批准
      if (typing(event.target)) return
      // 焦点在某个按钮上时，回车按的是那个按钮
      if (event.key === 'Enter' && event.target instanceof HTMLButtonElement) return
      const option = event.key === 'Enter' ? primary : event.key === 'Escape' ? refuse : undefined
      if (!option) return
      event.preventDefault()
      respond({ optionId: option.id })
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  })

  const { permissions, tool } = request
  return (
    <section className="req" ref={card} tabIndex={-1} aria-label={t(SUBJECT_TEXT[request.subject])}>
      <div className="req-head">
        <i className="st wait" />
        <span>{t(SUBJECT_TEXT[request.subject])}</span>
      </div>
      <div className="req-body">
        {tool ? (
          <div className="req-meta">
            <span>
              {t('request.tool.server')} <b>{tool.server}</b>
            </span>
            {tool.title ? (
              <span>
                {t('request.tool.name')} <b>{tool.title}</b>
              </span>
            ) : null}
          </div>
        ) : null}
        {tool?.note ? <div className="req-why">{tool.note}</div> : null}
        {tool?.params ? (
          <div className="well">
            <pre>{tool.params}</pre>
          </div>
        ) : null}
        {request.command ? (
          <div className="well">
            <pre>{request.command}</pre>
          </div>
        ) : null}
        {permissions ? (
          <div className="req-meta">
            {permissions.network ? <span>{t('request.network')}</span> : null}
            {permissions.read.length > 0 ? (
              <span>
                {t('request.read')} <b>{permissions.read.join('  ')}</b>
              </span>
            ) : null}
            {permissions.write.length > 0 ? (
              <span>
                {t('request.write')} <b>{permissions.write.join('  ')}</b>
              </span>
            ) : null}
          </div>
        ) : null}
        {request.cwd ? (
          <div className="req-meta">
            <span>
              {t('request.cwd')} <b>{request.cwd}</b>
            </span>
          </div>
        ) : null}
        {request.reason ? <div className="req-why">{request.reason}</div> : null}
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
              // 输入法还在选词：这个回车是确认候选，Esc 是放弃候选
              if (event.nativeEvent.isComposing || event.keyCode === 229) return
              if (event.key === 'Enter') {
                event.preventDefault()
                declineWithNote()
              } else if (event.key === 'Escape') {
                event.preventDefault()
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
        {request.options.map((option) => (
          <Fragment key={option.id}>
            {/* 能带说明的“拒绝”前面多一个入口：点开写一句为什么 */}
            {option === refuse && option.note && !noting ? (
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
                option.role === 'accept'
                  ? 'btn primary'
                  : option.role === 'decline' || option.role === 'cancel'
                    ? 'btn ghost'
                    : 'btn'
              }
              disabled={busy}
              data-option={option.id}
              title={option.rule ? `${t('request.rule')}\n${option.rule}` : undefined}
              onClick={() => respond({ optionId: option.id })}
            >
              {t(OPTION_TEXT[option.role])}
              {/* “以后都允许”记下来的那一条（命令的前缀、能访问的主机）：点之前看得到，几条并排时也分得开 */}
              {option.rule ? <code className="req-rule ell">{option.rule}</code> : null}
              {option === primary ? <span className="kbd">↵</span> : null}
              {option === refuse ? <span className="kbd">Esc</span> : null}
            </button>
          </Fragment>
        ))}
      </div>
      <Foot waiting={waiting} error={error} />
    </section>
  )
}

/**
 * 一个等着回答的请求。它排在输入框上面，输入框照常在、照常能写（见 Dock.tsx）。
 * 外面这一层是卡片占的地方：地方不够时它被压矮，卡片在它里面自己滚（见 dock.css），输入框不会被挤出去
 */
export function RequestCard(props: CardProps) {
  const { request } = props
  return (
    <div className="req-frame">
      {request.kind === 'approval' ? (
        <Approval {...props} request={request} />
      ) : request.kind === 'clientAsk' ? (
        <ClientAskCard {...props} request={request} />
      ) : request.kind === 'form' ? (
        <FormCard {...props} request={request} />
      ) : (
        <QuestionCard {...props} request={request} />
      )}
    </div>
  )
}
