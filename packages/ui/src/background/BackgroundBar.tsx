// 输入框上方的一行：后台还有任务在跑时出现，只说有几个在跑。整条一起慢慢呼吸（底色、边框、圆点），
// 悬停停住，减少动效时不动（background.css）。点一下在右侧打开“后台任务”页，再点收起。
// 人接着说话、新回合在跑时照样在：对话末尾的“正在工作”说的是前台，后台的任务并没有停。全部跑完就没了。
// 数的是合起来的那一张（state.ts 的 useBackgroundEntries）：在跑的子代理、子会话也算，都叫后台任务。
import {
  type BackgroundEntriesView,
  backgroundHint,
  keys,
  type SessionMeta,
  type SessionSummary,
} from '@litch/core'
import { useEffect, useRef } from 'react'
import { useT } from '../app/appearance.ts'
import { useKey, useServices } from '../app/services.tsx'
import { useSide } from '../side/side.ts'
import { useBackgroundEntries } from './state.ts'
import { BACKGROUND_TAB, toggleBackgroundTab } from './tab.ts'

export function BackgroundBar({ deviceId, sessionId }: { deviceId: string; sessionId: string }) {
  const t = useT()
  const entries = useBackgroundEntries(deviceId, sessionId)
  const side = useSide()
  const count = backgroundHint(entries)
  useHideNote(deviceId, sessionId, entries)
  if (count === 0) return null
  const open = side.open && side.tab === BACKGROUND_TAB
  const said = t(open ? 'background.barClose' : 'background.barOpen')
  return (
    <button
      type="button"
      className="bgbar"
      data-background={count}
      aria-expanded={open}
      title={said}
      onClick={toggleBackgroundTab}
    >
      <i className="pulse" aria-hidden="true" />
      <span className="lead">{t('background.bar', { count })}</span>
      <span className="go" aria-hidden="true">
        ›
      </span>
    </button>
  )
}

const runningOf = (entries: BackgroundEntriesView | null, source: string): number =>
  entries?.entries.filter((entry) => entry.source === source && entry.status === 'running')
    .length ?? 0

/**
 * 诊断：这一行由显示变成隐藏时往核心的日志（core.jsonl）记一行 ui.backgroundBar.hidden：
 * 隐藏前三种来源各有几个在跑，这一刻读的是哪份（报集合的读摘要 keys.summary 的 background，
 * 不报的读派生）、摘要上的集合和会话状态。和核心的 background.drop、入口的 background.* 对着看
 */
function useHideNote(deviceId: string, sessionId: string, entries: BackgroundEntriesView | null) {
  const { channel } = useServices()
  const summary = useKey<SessionSummary>(keys.summary(deviceId, sessionId))
  const meta = useKey<SessionMeta>(keys.session(deviceId, sessionId))
  const last = useRef<{ sessionId: string; entries: BackgroundEntriesView | null } | null>(null)
  const running = entries?.running ?? 0
  useEffect(() => {
    const before = last.current
    last.current = { sessionId, entries }
    // 换了会话不算；只记从有到没有那一下
    if (!before || before.sessionId !== sessionId || (before.entries?.running ?? 0) === 0) return
    if (running > 0) return
    const reports = meta ? meta.can.backgroundTasks : null
    channel
      .command('diag.note', {
        event: 'backgroundBar.hidden',
        fields: {
          deviceId,
          sessionId,
          beforeTasks: runningOf(before.entries, 'task'),
          beforeAgents: runningOf(before.entries, 'agent'),
          beforeChildren: runningOf(before.entries, 'child'),
          read: reports === false ? 'derived' : 'summary.background',
          reports,
          summaryRunning: summary?.background ? summary.background.running : null,
          summaryTotal: summary?.background ? summary.background.tasks.length : null,
          sessionStatus: summary?.status ?? null,
        },
      })
      .catch(() => {})
  }, [channel, deviceId, sessionId, entries, running, summary, meta])
}
