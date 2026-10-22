// 输入框上方的一行：会话有持续目标时一直在（停下了也在；达成了核心马上清掉，改在回答下面写用时，见 GoalReached.tsx）。
// 左边是靶的记号、状态、目标的话（一行截断）和用量；点这一块在右侧打开“目标”页，再点收起。
// 右边是暂停或继续（做完了、预算用完的没有）和清除。换掉还没做完的目标前问的那个对话框也挂在这里。
import { useT } from '../app/appearance.ts'
import { Confirm } from '../app/Confirm.tsx'
import { useElapsed } from '../app/clock.ts'
import { Icon } from '../app/icons.tsx'
import { useSide } from '../side/side.ts'
import { compactTokens, goalElapsedMs, goalTime, toggleTarget, usageKind } from './logic.ts'
import { useGoalActions, useReplaceAsk, useSessionGoal } from './state.ts'
import { GOAL_TAB, toggleGoalTab } from './tab.ts'

interface GoalBarProps {
  deviceId: string
  sessionId: string
}

export function GoalBar({ deviceId, sessionId }: GoalBarProps) {
  const t = useT()
  const goal = useSessionGoal(deviceId, sessionId)
  const actions = useGoalActions(deviceId, sessionId)
  const side = useSide()
  // 在做的时候用时一秒一秒地走：从上次更新起的那一截对面还没记进去
  useElapsed(goal?.status === 'active' ? goal.updatedAt : null)
  if (!goal) return <GoalReplace />
  const open = side.open && side.tab === GOAL_TAB
  const next = toggleTarget(goal.status)
  const usage =
    usageKind(goal) === 'tokens'
      ? t('goal.tokens', {
          used: compactTokens(goal.tokensUsed),
          budget: compactTokens(goal.tokenBudget ?? 0),
        })
      : t('goal.spent', { time: goalTime(goalElapsedMs(goal, Date.now()), t) })
  return (
    <>
      <div className="goalbar" data-goal-status={goal.status}>
        <button
          type="button"
          className="goal-main"
          aria-expanded={open}
          title={t(open ? 'goal.close' : 'goal.open')}
          onClick={toggleGoalTab}
        >
          <span className="goal-mark" aria-hidden="true">
            <Icon name="target" small />
          </span>
          <span className="goal-state">{t(`goal.status.${goal.status}`)}</span>
          <span className="goal-text ell">{goal.objective}</span>
          <span className="goal-use mono dim">{usage}</span>
        </button>
        {next ? (
          <button
            type="button"
            className="goal-act"
            data-act={next === 'paused' ? 'pause' : 'resume'}
            title={t(next === 'paused' ? 'goal.pause' : 'goal.resume')}
            aria-label={t(next === 'paused' ? 'goal.pause' : 'goal.resume')}
            onClick={() => void actions.status(next)}
          >
            <Icon name={next === 'paused' ? 'pause' : 'play'} small />
          </button>
        ) : null}
        <button
          type="button"
          className="goal-act"
          data-act="clear"
          title={t('goal.clear')}
          aria-label={t('goal.clear')}
          onClick={() => void actions.clear()}
        >
          <Icon name="trash" small />
        </button>
      </div>
      <GoalReplace />
    </>
  )
}

/** 换掉还没做完的目标之前问一句。没在问的时候什么都不画 */
function GoalReplace() {
  const t = useT()
  const ask = useReplaceAsk()
  if (!ask) return null
  return (
    <Confirm
      title={t('goal.replace.title')}
      note={t('goal.replace.note', { objective: ask.objective })}
      yes={t('goal.replace.yes')}
      no={t('goal.replace.no')}
      onYes={() => ask.answer(true)}
      onClose={() => ask.answer(false)}
    />
  )
}
