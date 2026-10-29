// Litch 替用户发的话（核心认出来放在 UserMessageItem.system：定时任务触发、子会话启动时的简报、提案卡上点的“在这里做”）：
// 不画成用户的气泡，画成一张系统卡片，样子同子会话回报那一条（tree/EventBar.tsx 的 .sev）：
// 默认一行（CompactRow）：来源和简略内容（任务的标题和原文开头），点开看发给模型的原文，可以收起。
// 展开记在对话区的展开状态里（同用户消息的展开全部），滚走再回来不变。不出分叉、编辑：那不是用户说的话。
import type { SessionSummary, SystemMessageView, UserMessageItem } from '@litch/core'
import { keys } from '@litch/core'
import { useRef } from 'react'
import { useT } from '../app/appearance.ts'
import { Icon } from '../app/icons.tsx'
import { useKey } from '../app/services.tsx'
import { useActions } from './actions.tsx'
import { CompactRow } from './CompactRow.tsx'
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

/** 展开后来源那一行之外还要交代的：手动运行的标记，启动指令来自哪个会话（能点回去）。没有就不画 */
function Detail({ deviceId, system }: { deviceId: string; system: SystemMessageView }) {
  const t = useT()
  if (system.kind === 'scheduledTask')
    return system.manual ? (
      <div className="sev-head sysm-head">
        <span className="sysm-tag">{t('sysmsg.manual')}</span>
      </div>
    ) : null
  if (system.kind !== 'briefing') return null
  return (
    <div className="sev-head sysm-head">
      <Parent deviceId={deviceId} parent={system.parent} />
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
  const label =
    system.kind === 'scheduledTask'
      ? t('sysmsg.scheduledTask', { name: system.task })
      : system.kind === 'briefing'
        ? t(`sysmsg.briefing.${system.mode}`)
        : t('sysmsg.here')
  return (
    <div className="sev sysm" data-anchor={`u:${ref.itemId}`} data-sys={system.kind} ref={card}>
      <CompactRow
        icon={<Icon name={ICON[system.kind]} small />}
        source={label}
        title={title}
        summary={system.prompt}
        open={open}
        onToggle={() => {
          pin(card.current)
          setOpen(!open)
        }}
      />
      {open ? (
        <>
          <Detail deviceId={ref.deviceId} system={system} />
          <div className="sysm-full">{item.text}</div>
        </>
      ) : null}
    </div>
  )
}
