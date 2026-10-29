// 两端按分钟刷新相对时间；计时只在待答卡挂着时运行。
// 待答问题会跨回合留几小时甚至几天，所以按刚刚、分钟、小时、天分档，给出文案键和数。
import { useEffect, useState } from 'react'

export type QuestionAge = {
  key: 'ask.ageUnknown' | 'ask.ageNow' | 'ask.age' | 'ask.ageHours' | 'ask.ageDays'
  count: number
}

export function questionAge(at: number | null, now: number): QuestionAge {
  if (at === null) return { key: 'ask.ageUnknown', count: 0 }
  const minutes = Math.max(0, Math.floor((now - at) / 60_000))
  if (minutes < 1) return { key: 'ask.ageNow', count: 0 }
  if (minutes < 60) return { key: 'ask.age', count: minutes }
  if (minutes < 24 * 60) return { key: 'ask.ageHours', count: Math.floor(minutes / 60) }
  return { key: 'ask.ageDays', count: Math.floor(minutes / (24 * 60)) }
}

export function useQuestionAge(at: number | null): QuestionAge {
  const [now, setNow] = useState(Date.now)
  useEffect(() => {
    if (at === null) return
    const timer = setInterval(() => setNow(Date.now()), 60_000)
    return () => clearInterval(timer)
  }, [at])
  return questionAge(at, now)
}
