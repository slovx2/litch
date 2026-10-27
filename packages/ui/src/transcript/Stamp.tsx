// 消息上的时刻（app/format.ts 的 stamp）：常显短写法，悬停看完整的年月日时分。
// 跟着全界面的钟走（“今天”过了零点要变成星期几），每半分钟重画的只有这几个字

import { useT } from '../app/appearance.ts'
import { useNow } from '../app/clock.ts'
import { stamp, stampFull } from '../app/format.ts'

export function Stamp({ at, className }: { at: number; className?: string }) {
  const t = useT()
  const now = useNow()
  return (
    <time className={className} dateTime={new Date(at).toISOString()} title={stampFull(at, t.lang)}>
      {stamp(at, now, t.lang)}
    </time>
  )
}
