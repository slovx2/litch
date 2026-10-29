// 两端按分钟刷新相对时间；计时只在待答卡挂着时运行。
import { useEffect, useState } from 'react'

export function useQuestionAge(at: number | null): number | null {
  const [now, setNow] = useState(Date.now)
  useEffect(() => {
    if (at === null) return
    const timer = setInterval(() => setNow(Date.now()), 60_000)
    return () => clearInterval(timer)
  }, [at])
  return at === null ? null : Math.max(0, Math.floor((now - at) / 60_000))
}
