// 收起的工作区、设备那一行行尾的汇总，和信息卡里对应的那一行。
// 各自订阅这台设备的汇总（keys.tallies）：里面的会话有动静时只有这一小块重画，整个侧栏不跟着动。
import { type GroupTallies, keys } from '@litch/core'
import { useT } from '../app/appearance.ts'
import { useKey } from '../app/services.tsx'
import { useSidebarHarnesses, useSidebarShowActive } from './state.ts'
import { isQuiet, tallyOf, tallyParts, waitLabel } from './tally.ts'

interface TallyProps {
  deviceId: string
  /** 哪一组（和数据副本里分组的键一样），给几组就是它们合起来。null：整台设备合起来 */
  group: string | readonly string[] | null
}

/**
 * 行尾的汇总：在等人的用和会话行上一样的小标，在跑的、只剩后台任务在跑的、没看过的各一个和会话行上一样的小记号。
 * 行上不写数目：一眼只要知道“里面有事”，几个在信息卡里。
 * 侧栏正只看某几个 harness 的时候，汇总跟着只算展开后看得见的那些
 */
export function TallyMarks({ deviceId, group }: TallyProps) {
  const harnesses = useSidebarHarnesses()
  // 永远显示活动对话时，别的 harness 在跑的、没看过的展开了也看得见：都算
  const only = useSidebarShowActive() ? [] : harnesses
  const tally = tallyOf(useKey<GroupTallies>(keys.tallies(deviceId)), group, only)
  const t = useT()
  if (isQuiet(tally)) return null
  const waiting = waitLabel(tally)
  const said = tallyParts(tally)
    .map((part) => t(part.key, { count: part.count }))
    .join(t('sidebar.tally.join'))
  return (
    <span
      className="tally"
      role="img"
      aria-label={said}
      data-approval={tally.approval}
      data-answer={tally.answer}
      data-running={tally.running}
      data-background={tally.background}
      data-unread={tally.unread}
    >
      {tally.running > 0 ? <i className="st run" /> : null}
      {tally.background > 0 ? <i className="st bg" /> : null}
      {tally.unread > 0 ? <i className="st unread" /> : null}
      {waiting ? <span className="pill wait">{t(waiting)}</span> : null}
    </span>
  )
}

/** 信息卡里的一行：现在里面各有几个。什么事都没有就不出这一行。说的是这一组全部的会话，不跟着筛选变 */
export function TallyFact({ deviceId, group }: TallyProps) {
  const tally = tallyOf(useKey<GroupTallies>(keys.tallies(deviceId)), group)
  const t = useT()
  if (isQuiet(tally)) return null
  return (
    <div data-tally>
      <dt>{t('info.now')}</dt>
      <dd>
        {tallyParts(tally).map((part) => (
          <span key={part.key}>{t(part.key, { count: part.count })}</span>
        ))}
      </dd>
    </div>
  )
}
