// Litch 替用户发的话（核心认出来放在 UserMessageItem.system：定时任务触发、子会话启动时的简报、提案卡上点的“在这里做”）：
// 不画成用户的气泡，画成一张系统卡片，样子同子会话回报那一条（tree/EventBar.tsx 的 .sev）：
// 第一行是来源和类型，下面一两行简略内容（任务的标题和原文开头），点“展开全文”看发给模型的原文，可以收起。
// 展开记在对话区的展开状态里（同用户消息的展开全部），滚走再回来不变。不出分叉、编辑：那不是用户说的话。
import type { SessionSummary, SystemMessageView, UserMessageItem } from '@litch/core'
import { keys } from '@litch/core'
import { useRef } from 'react'
import { useT } from '../app/appearance.ts'
import { Icon } from '../app/icons.tsx'
import { useKey } from '../app/services.tsx'
import { useActions } from './actions.tsx'
import type { ItemRef } from './messages.tsx'
import { usePin } from './scroll.ts'
import { useToggle } from './state.ts'

const ICON = { scheduledTask: 'clock', briefing: 'tree', here: 'suggest' } as const

/** 派出它的会话：还在侧栏里的可以点开，不在的只写标题（没有标题写会话号） */
function Parent({ deviceId, parent }: { deviceId: string; parent: { id: string; title: string } }) {
  const t = useT()
  const { open } = useActions()
  const listed = useKey<SessionSummary>(keys.summary(deviceId, parent.id))
  const name = parent.title || (listed ? t.text(listed.title) : parent.id)
  if (!listed || !open) return <span className="sysm-from">{t('sysmsg.from', { name })}</span>
  return (
    <button
      type="button"
      className="sysm-from sev-title"
      title={t('sysmsg.openParentHint')}
      onClick={() => open({ deviceId, sessionId: parent.id })}
    >
      {t('sysmsg.from', { name })}
    </button>
  )
}

function Head({ deviceId, system }: { deviceId: string; system: SystemMessageView }) {
  const t = useT()
  return (
    <div className="sev-head sysm-head">
      <Icon name={ICON[system.kind]} small />
      {system.kind === 'scheduledTask' ? (
        <>
          <span className="sysm-kind ell">{t('sysmsg.scheduledTask', { name: system.task })}</span>
          {system.manual ? <span className="sysm-tag">{t('sysmsg.manual')}</span> : null}
        </>
      ) : system.kind === 'briefing' ? (
        <>
          <span className="sysm-kind">{t(`sysmsg.briefing.${system.mode}`)}</span>
          <span aria-hidden="true">·</span>
          <Parent deviceId={deviceId} parent={system.parent} />
        </>
      ) : (
        <span className="sysm-kind">{t('sysmsg.here')}</span>
      )}
    </div>
  )
}

export function SystemCard({
  item,
  system,
  ...ref
}: ItemRef & { item: UserMessageItem; system: SystemMessageView }) {
  const t = useT()
  const pin = usePin()
  const card = useRef<HTMLDivElement | null>(null)
  const [open, setOpen] = useToggle(`${ref.deviceId}:${ref.sessionId}`, `u:${ref.itemId}`, false)
  const title = system.kind === 'scheduledTask' ? '' : system.title
  return (
    <div className="sev sysm" data-anchor={`u:${ref.itemId}`} data-sys={system.kind} ref={card}>
      <Head deviceId={ref.deviceId} system={system} />
      {open ? (
        <div className="sysm-full">{item.text}</div>
      ) : (
        <div className="sysm-sum">
          {title ? <span className="sysm-title">{title}</span> : null}
          {title ? ' ' : null}
          {system.prompt}
        </div>
      )}
      <button
        type="button"
        className="mini sysm-toggle"
        aria-expanded={open}
        onClick={() => {
          pin(card.current)
          setOpen(!open)
        }}
      >
        {t(open ? 'sysmsg.collapse' : 'sysmsg.expand')}
      </button>
    </div>
  )
}
