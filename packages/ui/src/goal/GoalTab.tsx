// 侧面板的“目标”页：眼前这个会话的持续目标。上面是状态和多久以前更新的，中间是目标的话（能直接改，
// 保存才生效，Cmd/Ctrl+S 也是保存；改了还没保存可以还原），下面是用时、用掉的词元、预算，
// 一句话说明现在这个状态意味着什么，最后是暂停或继续、清除。没有目标时说怎么设。
import { type DeviceView, keys, type SessionGoalView, type SessionMeta } from '@litch/core'
import { useEffect, useState } from 'react'
import { useT } from '../app/appearance.ts'
import { useElapsed, useNow } from '../app/clock.ts'
import { ago } from '../app/format.ts'
import { Icon } from '../app/icons.tsx'
import { currentPlatform } from '../app/platform.ts'
import { useKey } from '../app/services.tsx'
import type { SideTabProps } from '../side/tabs.ts'
import { compactTokens, goalElapsedMs, goalTime, toggleTarget } from './logic.ts'
import { useGoalActions, useSessionGoal } from './state.ts'

export function GoalTab({ place }: SideTabProps) {
  const t = useT()
  const { deviceId, sessionId } = place
  const meta = useKey<SessionMeta>(sessionId ? keys.session(deviceId, sessionId) : '')
  const device = useKey<DeviceView>(keys.device(deviceId))
  const goal = useSessionGoal(deviceId, sessionId)
  if (!sessionId) return <div className="side-none dim">{t('goal.tab.pick')}</div>
  if (meta && !meta.can.goals) {
    const harness = device?.harnesses.find((entry) => entry.id === meta.harness)
    return (
      <div className="side-none dim" data-goal-unsupported>
        {t('goal.tab.unsupported', { harness: harness?.name ?? meta.harness })}
      </div>
    )
  }
  if (!goal)
    return (
      <div className="side-none dim" data-goal-empty>
        {t('goal.tab.none')}
      </div>
    )
  return (
    <GoalPanel
      key={`${deviceId}:${sessionId}`}
      deviceId={deviceId}
      sessionId={sessionId}
      goal={goal}
      live={meta?.live === true}
    />
  )
}

interface GoalPanelProps {
  deviceId: string
  sessionId: string
  goal: SessionGoalView
  /** 会话能发消息。只读的会话只能看 */
  live: boolean
}

function GoalPanel({ deviceId, sessionId, goal, live }: GoalPanelProps) {
  const t = useT()
  const isMac = currentPlatform() === 'mac'
  const now = useNow()
  useElapsed(goal.status === 'active' ? goal.updatedAt : null)
  const actions = useGoalActions(deviceId, sessionId)
  /** 正在改的目标。null 是没改过，照对面的显示 */
  const [draft, setDraft] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  // 对面的目标换了（别处改的、刚保存成的）：和正在改的一样就不用再留着草稿
  useEffect(() => {
    setDraft((current) => (current !== null && current.trim() === goal.objective ? null : current))
  }, [goal.objective])
  const text = draft ?? goal.objective
  const dirty = draft !== null && draft.trim() !== goal.objective && draft.trim().length > 0
  const save = async () => {
    if (!dirty || saving || draft === null) return
    setSaving(true)
    const done = await actions.write(draft.trim())
    setSaving(false)
    if (done) setDraft(null)
  }
  const next = toggleTarget(goal.status)
  const facts: [string, string][] = [
    [t('goal.tab.time'), goalTime(goalElapsedMs(goal, Date.now()), t)],
    [t('goal.tab.tokens'), compactTokens(goal.tokensUsed)],
    [
      t('goal.tab.budget'),
      goal.tokenBudget === null ? t('goal.tab.noBudget') : compactTokens(goal.tokenBudget),
    ],
  ]
  return (
    <div className="goal-panel" data-goal-status={goal.status} data-session={sessionId}>
      <div className="goal-head">
        <span className="goal-mark" aria-hidden="true">
          <Icon name="target" small />
        </span>
        <b>{t(`goal.status.${goal.status}`)}</b>
        <span className="dim">{t('goal.tab.updated', { ago: ago(goal.updatedAt, now, t) })}</span>
      </div>
      <label className="goal-label" htmlFor="goal-objective">
        {t('goal.tab.objective')}
      </label>
      <textarea
        id="goal-objective"
        className="goal-editor"
        value={text}
        rows={6}
        readOnly={!live}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => {
          // Cmd/Ctrl+S 保存；回车照常换行，目标可以写成好几行
          if ((isMac ? event.metaKey : event.ctrlKey) && event.key.toLowerCase() === 's') {
            event.preventDefault()
            void save()
          }
        }}
      />
      {live ? (
        <div className="goal-edit-row">
          <span className="dim">
            {dirty ? t('goal.tab.saveHint', { key: isMac ? '⌘S' : 'Ctrl+S' }) : null}
          </span>
          {draft !== null ? (
            <button type="button" className="btn ghost" onClick={() => setDraft(null)}>
              {t('goal.tab.revert')}
            </button>
          ) : null}
          <button
            type="button"
            className="btn"
            data-act="save"
            disabled={!dirty || saving}
            onClick={() => void save()}
          >
            {t('goal.tab.save')}
          </button>
        </div>
      ) : null}
      <dl className="goal-facts">
        {facts.map(([label, value]) => (
          <div key={label}>
            <dt className="dim">{label}</dt>
            <dd className="mono">{value}</dd>
          </div>
        ))}
      </dl>
      <p className="goal-note dim">{t(`goal.tab.note.${goal.status}`)}</p>
      {live ? (
        <div className="goal-acts">
          {next ? (
            <button
              type="button"
              className="btn"
              data-act={next === 'paused' ? 'pause' : 'resume'}
              onClick={() => void actions.status(next)}
            >
              <Icon name={next === 'paused' ? 'pause' : 'play'} small />
              {t(next === 'paused' ? 'goal.pause' : 'goal.resume')}
            </button>
          ) : null}
          <button
            type="button"
            className="btn ghost"
            data-act="clear"
            onClick={() => void actions.clear()}
          >
            <Icon name="trash" small />
            {t('goal.clear')}
          </button>
        </div>
      ) : null}
    </div>
  )
}
