// 侧面板的“侧聊”页：眼前会话的侧聊（aside/state.ts）。没有侧聊时一句说明和“开始侧聊”；
// 有的话上面一行（新侧聊、关闭），下面是侧聊的对话和它自己的输入区。从主会话带来的回合不画，
// 对话最前面一行说带着主会话的上下文。对面已经把它扔了（重开应用、设备重连）的，说不在了，给“新侧聊”。
import { keys, type SessionMeta } from '@litch/core'
import { useEffect, useRef, useState } from 'react'
import { useT } from '../app/appearance.ts'
import { Confirm } from '../app/Confirm.tsx'
import { whyNot } from '../app/errors.ts'
import { Close, Icon } from '../app/icons.tsx'
import { useKey, useServices } from '../app/services.tsx'
import type { SideTabProps } from '../side/tabs.ts'
import { Transcript } from '../transcript/Transcript.tsx'
import {
  type AsideState,
  asideSpoke,
  closeAside,
  renewAside,
  startAside,
  useAside,
} from './state.ts'

export function AsideTab({ place, shown }: SideTabProps) {
  const t = useT()
  const services = useServices()
  const { deviceId, sessionId: parentId } = place
  const meta = useKey<SessionMeta>(parentId ? keys.session(deviceId, parentId) : '')
  const parentTurns = useKey<string[]>(parentId ? keys.turnIds(deviceId, parentId) : '')
  const aside = useAside(deviceId, parentId)
  if (!parentId || parentTurns?.length === 0)
    return <div className="side-none dim">{t('aside.unstarted')}</div>
  if (aside?.sessionId && aside.inherited)
    return (
      <AsideChat
        key={aside.sessionId}
        deviceId={deviceId}
        parentId={parentId}
        aside={aside}
        sessionId={aside.sessionId}
        inherited={aside.inherited}
        shown={shown}
      />
    )
  if (aside && !aside.failure) return <div className="side-none dim">{t('aside.forking')}</div>
  if (meta && !meta.can.sideChat && !aside)
    return <div className="side-none dim">{t('aside.unsupported')}</div>
  return (
    <div className="aside-start">
      <Icon name="aside" />
      <p>{t('aside.intro')}</p>
      {aside?.failure ? (
        <p className="aside-fail" role="alert">
          {t('aside.failed', { reason: whyNot(aside.failure, t) })}
        </p>
      ) : null}
      <button
        type="button"
        className="btn"
        data-side-focus
        disabled={!meta}
        onClick={() =>
          aside
            ? renewAside(services, deviceId, parentId)
            : startAside(services, deviceId, parentId)
        }
      >
        {t(aside ? 'aside.retry' : 'aside.start')}
      </button>
    </div>
  )
}

interface ChatProps {
  deviceId: string
  parentId: string
  aside: AsideState
  sessionId: string
  inherited: readonly string[]
  shown: boolean
}

function AsideChat({ deviceId, parentId, aside, sessionId, inherited, shown }: ChatProps) {
  const t = useT()
  const services = useServices()
  const root = useRef<HTMLDivElement>(null)
  // 载入失败：多半是对面已经把它扔了（找不到会话），别的原因照实说
  const failure = useKey<{ code?: string }>(keys.sessionError(deviceId, sessionId))
  const ready = useKey<SessionMeta>(keys.session(deviceId, sessionId)) !== undefined
  const [asking, setAsking] = useState<'close' | 'renew' | null>(null)

  // 侧聊刚开好、面板显示着：焦点落到它的输入框（选字带过来的引用已经在里面了）
  useEffect(() => {
    if (!shown || !ready) return
    const area = root.current?.querySelector<HTMLTextAreaElement>('.dock textarea')
    if (area && document.activeElement !== area) {
      area.focus({ preventScroll: true })
      area.setSelectionRange(area.value.length, area.value.length)
    }
  }, [shown, ready])

  // 说过话的先问一句再关（关了找不回来）；没说过话的直接关
  const act = (what: 'close' | 'renew') => {
    if (!failure && asideSpoke(services, deviceId, aside)) {
      setAsking(what)
      return
    }
    run(what)
  }
  const run = (what: 'close' | 'renew') => {
    setAsking(null)
    if (what === 'close') closeAside(services, deviceId, parentId)
    else renewAside(services, deviceId, parentId)
  }

  return (
    <div className="aside-view" ref={root} data-aside={sessionId}>
      <div className="aside-bar">
        <span className="aside-label">
          <Icon name="aside" small />
          {t('side.tab.aside')}
        </span>
        <button
          type="button"
          className="mini"
          data-act="renew"
          title={t('aside.renew.hint')}
          onClick={() => act('renew')}
        >
          {t('aside.renew')}
        </button>
        <button
          type="button"
          className="ibtn"
          data-act="close"
          title={t('aside.close')}
          aria-label={t('aside.close')}
          onClick={() => act('close')}
        >
          <Close />
        </button>
      </div>
      {failure ? (
        <div className="aside-start">
          <p>{failure.code === 'notFound' ? t('aside.gone') : whyNot(failure, t)}</p>
          <button type="button" className="btn" onClick={() => run('renew')}>
            {t('aside.renew')}
          </button>
        </div>
      ) : (
        // 这一块里按的 Esc 归侧聊自己的输入区（两下打断的是侧聊的回合，composer/escape.ts）
        <div className="aside-transcript" data-esc-scope>
          <Transcript
            deviceId={deviceId}
            sessionId={sessionId}
            aside={{
              parentId,
              skip: inherited,
              lead: <AsideLead deviceId={deviceId} sessionId={sessionId} inherited={inherited} />,
            }}
          />
        </div>
      )}
      {asking ? (
        <Confirm
          title={t(asking === 'close' ? 'aside.close.title' : 'aside.renew.title')}
          note={t('aside.close.note')}
          yes={t(asking === 'close' ? 'aside.close.yes' : 'aside.renew')}
          no={t('aside.close.no')}
          onYes={() => run(asking)}
          onClose={() => setAsking(null)}
        />
      ) : null}
    </div>
  )
}

/** 对话最前面那一行：带着主会话的上下文；侧聊里还没说过话时再加一句在下面提问 */
function AsideLead({
  deviceId,
  sessionId,
  inherited,
}: {
  deviceId: string
  sessionId: string
  inherited: readonly string[]
}) {
  const t = useT()
  const turnIds = useKey<string[]>(keys.turnIds(deviceId, sessionId)) ?? []
  const spoke = turnIds.some((id) => !inherited.includes(id))
  return (
    <div className="aside-lead">
      <div className="aside-context">{t('aside.context')}</div>
      {spoke ? null : <div className="dim">{t('aside.empty')}</div>}
    </div>
  )
}
