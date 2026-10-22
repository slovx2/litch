// 回合最后一条回答下面的一行“目标已达成 · 用时 N”（照官方桌面端）：目标一达成核心就清掉它，
// 输入框上方那一行没了，改在达成它的那个回合下面留这一句。只认核心记下的那一次（keys.goalReached），
// 回合还在跑的时候不写（达成是回合中间报的）。用时是目标在做的状态下一共花的时间
import { type GoalReachedView, goalReachedIn, keys, type TurnView } from '@litch/core'
import { useT } from '../app/appearance.ts'
import { Icon } from '../app/icons.tsx'
import { useKey } from '../app/services.tsx'
import { goalTime } from './logic.ts'

interface GoalReachedProps {
  deviceId: string
  sessionId: string
  turn: TurnView
}

export function GoalReached({ deviceId, sessionId, turn }: GoalReachedProps) {
  const t = useT()
  const reached = useKey<GoalReachedView | null>(keys.goalReached(deviceId, sessionId))
  const ms = goalReachedIn(reached, turn)
  if (ms === null || !reached) return null
  return (
    <div className="goal-reached" title={reached.objective}>
      <Icon name="target" small />
      <span>{t('goal.reached', { time: goalTime(ms, t) })}</span>
    </div>
  )
}
