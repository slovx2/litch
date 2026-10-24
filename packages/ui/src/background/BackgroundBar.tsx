// 输入框上方的一行：后台还有任务在跑时出现，只说有几个在跑。整条一起慢慢呼吸（底色、边框、圆点），
// 悬停停住，减少动效时不动（background.css）。点一下在右侧打开“后台任务”页，再点收起。
// 人接着说话、新回合在跑时照样在：对话末尾的“正在工作”说的是前台，后台的任务并没有停。全部跑完就没了。
// 数的是合起来的那一张（state.ts 的 useBackgroundEntries）：在跑的子代理、子会话也算，都叫后台任务。
import { backgroundHint } from '@litch/core'
import { useT } from '../app/appearance.ts'
import { useSide } from '../side/side.ts'
import { useBackgroundEntries } from './state.ts'
import { BACKGROUND_TAB, toggleBackgroundTab } from './tab.ts'

export function BackgroundBar({ deviceId, sessionId }: { deviceId: string; sessionId: string }) {
  const t = useT()
  const entries = useBackgroundEntries(deviceId, sessionId)
  const side = useSide()
  const count = backgroundHint(entries)
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
