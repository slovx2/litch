// 不是用户发起的回合开头那一行，放在用户气泡的位置：“↻ 后台任务结束，自动继续”，后面是叫醒它的那个任务
// （这一回合开始前最后结束的那个，找不到就不写）；定时任务触发的写“定时任务触发”。
import { type TurnView, wokenBy } from '@litch/core'
import { useT } from '../app/appearance.ts'
import { Icon } from '../app/icons.tsx'
import { useSessionBackground } from './state.ts'

interface TurnOriginProps {
  deviceId: string
  sessionId: string
  turn: TurnView & { origin: NonNullable<TurnView['origin']> }
}

export function TurnOrigin({ deviceId, sessionId, turn }: TurnOriginProps) {
  const t = useT()
  const background = useSessionBackground(deviceId, sessionId)
  const by = turn.origin === 'backgroundTask' ? wokenBy(background, turn) : null
  return (
    <div className="turn-origin" data-origin={turn.origin}>
      <Icon name="loop" small />
      <span>{t(`background.origin.${turn.origin}`)}</span>
      {by ? (
        <span className="mono dim ell" title={by.title}>
          {by.title}
        </span>
      ) : null}
    </div>
  )
}
