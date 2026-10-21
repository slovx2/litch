// 输入框上方的一行：回合停了、后台还有任务在跑时出现，只说有几个在跑。整条一起慢慢呼吸（底色、边框、圆点），
// 悬停停住，减少动效时不动（background.css）。点一下在右侧打开“后台任务”页，再点收起。
// 最新回合还在进行时不出：那时前台在干活，后台的事等它说完再提。全部跑完就没了。
import { keys, type TurnView } from '@litch/core'
import { useT } from '../app/appearance.ts'
import { useKey } from '../app/services.tsx'
import { useSide } from '../side/side.ts'
import { useSessionBackground } from './state.ts'
import { BACKGROUND_TAB, toggleBackgroundTab } from './tab.ts'

export function BackgroundBar({ deviceId, sessionId }: { deviceId: string; sessionId: string }) {
  const t = useT()
  const background = useSessionBackground(deviceId, sessionId)
  const turnIds = useKey<string[]>(keys.turnIds(deviceId, sessionId))
  const last = useKey<TurnView>(keys.turn(deviceId, sessionId, turnIds?.at(-1) ?? ''))
  const side = useSide()
  const count = background?.running ?? 0
  if (count === 0 || last?.status === 'running') return null
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
