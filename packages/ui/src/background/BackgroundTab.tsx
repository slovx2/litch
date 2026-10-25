// 侧面板的“后台任务”页：眼前这个会话回合结束后还在跑的命令（以及这次运行里结束过的）、引擎自己派出的子代理，
// 合成一张列表，都叫后台任务（照 Claude 桌面端：不按种类分组，类型看行首的图标）。会话树里派出的子会话不列
// （用户要求，2026-10-25），它们挂在侧栏的父会话下面，在自己的页面里停。
// 运行中在上、已结束在下，每行是类型、名称（一行截断，悬停全文）、用时、状态，能停的给“停止”。
// 跑完会不会自动接着做写在运行中那一组的组头右边（派生出来的不知道，就不写）。没有在跑的时候也能打开。
// 点一行：子代理在列表下面打开子代理页，命令看它的输出。
import {
  type AgentThreadView,
  agentRunState,
  type BackgroundEntryView,
  type BackgroundTaskKind,
  backgroundStoppable,
  type CommandItem,
  type DeviceView,
  type HarnessAbilities,
  keys,
  type SessionSummary,
  type TurnView,
} from '@litch/core'
import { type MouseEvent, memo, useMemo, useState } from 'react'
import { useT } from '../app/appearance.ts'
import { useElapsed } from '../app/clock.ts'
import { whyNot } from '../app/errors.ts'
import { duration } from '../app/format.ts'
import { Icon, type IconName } from '../app/icons.tsx'
import { useKey, useKeys, useServices } from '../app/services.tsx'
import { showToast } from '../app/toasts.tsx'
import type { SideTabProps } from '../side/tabs.ts'
import { OutputWell } from '../transcript/activity.tsx'
import { AgentDetail, useReported } from '../tree/AgentDetail.tsx'
import { useAgentList } from '../tree/useAgentList.ts'
import { elapsedOf, useBackgroundEntries } from './state.ts'
import { pickBackground, usePickedBackground } from './tab.ts'

const ICON: Record<BackgroundTaskKind, IconName> = {
  shell: 'term',
  agent: 'agents',
  monitor: 'eye',
  workflow: 'tree',
  remote: 'globe',
  other: 'tool',
}

export function BackgroundTab({ place }: SideTabProps) {
  const t = useT()
  const { deviceId, sessionId } = place
  const reported = useReported(deviceId, sessionId ?? '')
  const view = useBackgroundEntries(deviceId, sessionId, reported)
  const picked = usePickedBackground(deviceId, sessionId)
  const abilities = useAbilities(deviceId, sessionId)
  if (!sessionId) return <div className="side-none dim">{t('background.pick')}</div>
  const entries = view?.entries ?? []
  const chosen = entries.find((entry) => entry.key === picked) ?? null
  // 列表里还没有、但点名要看的子代理（卡片点得比列表推来得早）：照样开它的子代理页
  const agentId = chosen?.source === 'agent' ? chosen.id : agentOf(picked)
  if (entries.length === 0 && agentId === null)
    return (
      <div className="side-none dim" data-background-empty>
        {t('background.noneEver')}
      </div>
    )
  const running = entries.filter((entry) => entry.status === 'running')
  const ended = entries.filter((entry) => entry.status !== 'running')
  const wakes = view?.wakesOnFinish ?? null
  const rows = (list: BackgroundEntryView[]) =>
    list.map((entry) => (
      <EntryRow
        key={entry.key}
        deviceId={deviceId}
        sessionId={sessionId}
        entry={entry}
        selected={entry.key === picked}
        stoppable={backgroundStoppable(entry, abilities)}
      />
    ))
  return (
    <div
      className="bg-panel"
      data-session={sessionId}
      data-detail={chosen || agentId ? (agentId ? 'agent' : chosen?.source) : undefined}
    >
      <div className="bg-list" role="listbox" aria-label={t('side.tab.background')}>
        {running.length > 0 ? (
          <>
            <div className="bg-group" data-group="running">
              <span>{t('background.running')}</span>
              <b>{running.length}</b>
              {wakes === null || !running.some((entry) => entry.source === 'task') ? null : (
                <span className="bg-wakes dim">
                  {t(wakes ? 'background.wakes' : 'background.noWake')}
                </span>
              )}
            </div>
            {rows(running)}
          </>
        ) : (
          <div className="bg-empty">{t('background.none')}</div>
        )}
        {ended.length > 0 ? (
          <>
            <div className="bg-group" data-group="ended">
              <span>{t('background.ended')}</span>
              <b>{ended.length}</b>
            </div>
            {rows(ended)}
          </>
        ) : null}
      </div>
      {agentId ? (
        <AgentPage deviceId={deviceId} parentId={sessionId} agentId={agentId} />
      ) : chosen?.source === 'task' && chosen.task ? (
        <TaskPage deviceId={deviceId} sessionId={sessionId} entry={chosen} />
      ) : null}
    </div>
  )
}

/** 选中的键是子代理的（agent:线程）时取出线程 */
const agentOf = (key: string | null): string | null =>
  key?.startsWith('agent:') ? key.slice('agent:'.length) : null

/** 这个会话的 harness 报的能力：停不停得掉命令（stopBackground）、子代理（stopAgent） */
function useAbilities(deviceId: string, sessionId: string | null): HarnessAbilities | null {
  const device = useKey<DeviceView>(keys.device(deviceId))
  const summary = useKey<SessionSummary>(sessionId ? keys.summary(deviceId, sessionId) : '')
  return device?.harnesses.find((entry) => entry.id === summary?.harness)?.abilities ?? null
}

const EntryRow = memo(function EntryRow({
  deviceId,
  sessionId,
  entry,
  selected,
  stoppable,
}: {
  deviceId: string
  sessionId: string
  entry: BackgroundEntryView
  selected: boolean
  stoppable: boolean
}) {
  const t = useT()
  const { channel } = useServices()
  const [stopping, setStopping] = useState(false)
  // 在跑的一秒一秒地走；结束了的是定数
  const ticking = useElapsed(entry.status === 'running' ? entry.startedAt : null)
  const elapsed = entry.status === 'running' ? ticking : elapsedOf(entry, Date.now())
  const label = t(`background.kind.${entry.kind}`)
  const open = () => pickBackground(deviceId, sessionId, selected ? null : entry.key)
  const stop = (event: MouseEvent) => {
    event.stopPropagation()
    setStopping(true)
    const done =
      entry.source === 'task'
        ? channel.command('session.stopBackground', {
            deviceId,
            sessionId,
            taskId: entry.id,
            itemId: entry.task?.itemId ?? null,
          })
        : channel.command('session.interrupt', { deviceId, sessionId: entry.id })
    done
      .catch((error: unknown) =>
        showToast({
          id: 'background-stop-failed',
          tone: 'err',
          lifeMs: 8000,
          text: (say) => whyNot(error, say),
        }),
      )
      .finally(() => setStopping(false))
  }
  return (
    <div
      className="bg-row"
      role="option"
      tabIndex={0}
      aria-selected={selected}
      data-entry={entry.key}
      data-source={entry.source}
      data-status={entry.status}
      title={entry.title}
      onClick={open}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault()
          open()
        }
      }}
    >
      <span className="bg-kind" role="img" aria-label={label}>
        <Icon name={ICON[entry.kind]} small />
      </span>
      <span className="t ell">{entry.title || label}</span>
      <span className="meta">
        {elapsed === null ? null : <span>{duration(elapsed, t)}</span>}
        <span className={`bg-st ${entry.status}`}>
          {t(stopping ? 'background.stopping' : `background.status.${entry.status}`)}
        </span>
        {stoppable ? (
          <button
            type="button"
            className="bg-stop"
            title={t('background.stop.title')}
            aria-label={t('background.stop.title')}
            disabled={stopping}
            onClick={stop}
          >
            {t('background.stop')}
          </button>
        ) : null}
      </span>
    </div>
  )
})

/** 选中的子代理：列表下面是它的子代理页 */
function AgentPage({
  deviceId,
  parentId,
  agentId,
}: {
  deviceId: string
  parentId: string
  agentId: string
}) {
  const reported = useReported(deviceId, parentId)
  const list = useAgentList(deviceId, parentId) ?? []
  const agent: AgentThreadView | undefined = list.find((entry) => entry.id === agentId)
  const state = agent ? agentRunState(agent, reported.get(agentId), null) : null
  return (
    <AgentDetail
      key={agentId}
      deviceId={deviceId}
      parentId={parentId}
      agentId={agentId}
      agent={agent}
      state={state}
    />
  )
}

/** 选中的后台命令：它的输出（就是发起它的那个命令条目的输出），别的种类只有名称和状态 */
function TaskPage({
  deviceId,
  sessionId,
  entry,
}: {
  deviceId: string
  sessionId: string
  entry: BackgroundEntryView
}) {
  const t = useT()
  const item = useTaskItem(deviceId, sessionId, entry.task?.itemId ?? null)
  const shown = item !== null && (item.output !== '' || item.elided !== null)
  return (
    <div className="bg-task" data-task={entry.id} data-status={entry.status}>
      <div className="bg-task-head">
        <Icon name={ICON[entry.kind]} small />
        <code className="ell" title={entry.title}>
          {entry.title}
        </code>
        <span className={`bg-st ${entry.status}`}>{t(`background.status.${entry.status}`)}</span>
      </div>
      {shown ? (
        <div className="bg-task-out">
          <OutputWell item={item} />
        </div>
      ) : (
        <div className="bg-task-none dim">
          {t(item ? 'background.output.none' : 'background.output.unknown')}
        </div>
      )}
    </div>
  )
}

/** 发起后台命令的那个条目（显示条目的标识是“回合:协议条目标识”）。找不到、不是命令是 null */
function useTaskItem(
  deviceId: string,
  sessionId: string,
  itemId: string | null,
): CommandItem | null {
  const turnIds = useKey<string[]>(itemId ? keys.turnIds(deviceId, sessionId) : '')
  const turns = useKeys<TurnView>(
    useMemo(
      () => (turnIds ?? []).map((id) => keys.turn(deviceId, sessionId, id)),
      [deviceId, sessionId, turnIds],
    ),
  )
  const viewId = itemId
    ? (turns.flatMap((turn) => turn?.itemIds ?? []).find((id) => id.endsWith(`:${itemId}`)) ?? null)
    : null
  const item = useKey<CommandItem>(viewId ? keys.item(deviceId, sessionId, viewId) : '')
  return item?.kind === 'command' ? item : null
}
